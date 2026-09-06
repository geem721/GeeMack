import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, createLocalVideoTrack, createLocalAudioTrack } from "livekit-client";
import { ref, push, onValue, off, query, limitToLast, serverTimestamp, set } from "firebase/database";
import { db } from "../firebase.js";
import { callTranslate } from "../api/translate.js";
import { useToast } from "../components/Toast.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { LANGUAGES } from "../languages.js";
import { ROOMS } from "../rooms.js";
import "./VideoCall.css";
// Phase 5 of MIGRATION_PLAN.md. Its own top-level tab (not nested inside Group Chat) per
// the 2026-08-16 decision — public/index.html buried the "Start Video Call" button
// inside the Group Chat panel, and reused whichever room Group Chat happened to be
// showing. Now that Video Call is a sibling tab, it needs its own room concept; reusing
// the same fixed ROOMS list (rooms.js) as Group Chat keeps a consistent mental model
// ("join a room to chat or call in it") and means the Firebase paths
// (`chats/{room}/captions`) still line up if the two features are ever cross-linked.
//
// Call recording (added Sept 6 session, last of the three call types after Phone and
// Group Chat): a canvas compositor draws every visible video tile onto a canvas each
// frame, and a WebAudio graph mixes every participant's audio (including the local mic,
// which is published but never attached to a visible/audible element) into one track.
// MediaRecorder encodes the combined stream and the browser uploads it in ~5s chunks as
// the call happens, not one big blob at the end — a crashed tab or dropped connection
// then only loses the last few seconds instead of the whole recording. LiveKit's own
// self-hosted Egress service was seriously considered and rejected for this: per
// LiveKit's docs it requires Redis wired into the same livekit-server already running
// live production calls, needs a dedicated 4+ CPU/4GB container with Chrome running
// `--cap-add=SYS_ADMIN`, and — the disqualifying part — only supports S3/Azure/GCS
// output, never a local file, which rules out keeping recordings on Apollo1's disk the
// way Phone's and Group Chat's already are. Any participant can start a recording;
// everyone in the room (including the recorder) sees an on-screen "this call is being
// recorded" banner for as long as it's active, mirroring the legal reasoning behind
// Phone's audible consent notice. The banner is driven by a heartbeat written to
// Firebase every 10s rather than a plain on/off flag — if the recording participant's
// tab crashes mid-call, nothing would ever flip it back to "off," and everyone else
// would see a stuck "recording" banner forever; a stale (>30s old) heartbeat is treated
// as "recording stopped" instead.
//
// Video/audio track handling below stays imperative (direct DOM manipulation via
// gridRef, mirroring public/index.html's attachTrack/showCaption) rather than modeling
// each tile as declarative React state — LiveKit hands back raw MediaStreamTrack-like
// objects with their own attach()/detach() lifecycle that doesn't map cleanly onto
// props/state, and CameraOCR.jsx already established the same imperative-video-element
// pattern for the same reason (a real <video> tag's srcObject isn't something React
// should own).
export default function VideoCall({ initialRoom }) {
  const { user, signOutUser } = useAuth();
  return <VideoCallPanel user={user} onSignOut={signOutUser} initialRoom={initialRoom} />;
}
function VideoCallPanel({ user, onSignOut, initialRoom }) {
  const { showToast } = useToast();
  const [room, setRoom] = useState(
    initialRoom && ROOMS.includes(initialRoom) ? initialRoom : "general",
  );
  const [callActive, setCallActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [speakLang, setSpeakLang] = useState("en");
  const [showLang, setShowLang] = useState("en");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [recordingBanner, setRecordingBanner] = useState(null); // Firebase's view: { active, startedBy, lastHeartbeat } or null
  const [isRecordingMine, setIsRecordingMine] = useState(false); // true if THIS client owns the active recording
  const [recordingBusy, setRecordingBusy] = useState(false); // start/stop request in flight
  const [lastRecordingRoom, setLastRecordingRoom] = useState(null); // room a recording I made just finished for
  const gridRef = useRef(null);
  const livekitRoomRef = useRef(null);
  const captionWsRef = useRef(null);
  const captionRecorderRef = useRef(null);
  const captionOffRef = useRef(null);
  const speakLangRef = useRef(speakLang);
  const showLangRef = useRef(showLang);
  const roomRef = useRef(room);
  // isRecordingMine mirrored into a ref for the same reason speakLangRef/roomRef exist:
  // leaveCall() is captured once (in the mount-time cleanup effect below) and would
  // otherwise always see isRecordingMine's value from that first render, not whatever
  // it actually is by the time the tab closes or the user hits "End Video Call."
  const isRecordingMineRef = useRef(false);
  const recordingRef = useRef({
    recordingId: null,
    audioCtx: null,
    rafId: null,
    heartbeatIntervalId: null,
    mediaRecorder: null,
    getUploadQueue: null,
    localAudioTrack: null,
  });
  useEffect(() => {
    speakLangRef.current = speakLang;
  }, [speakLang]);
  useEffect(() => {
    showLangRef.current = showLang;
  }, [showLang]);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  useEffect(() => {
    isRecordingMineRef.current = isRecordingMine;
  }, [isRecordingMine]);
  // Leave the call on unmount (tab switch) or if the room changes mid-call, so nobody's
  // camera/mic keeps streaming after they've navigated away.
  useEffect(() => {
    return () => {
      leaveCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Recording banner: subscribed for as long as the call is active, watching for any
  // participant's recording heartbeat (see the file-level comment for why a heartbeat
  // rather than a plain flag). Re-checks staleness on a timer too, not just when
  // Firebase pushes a new value — a crashed recorder's tab simply stops writing, it
  // never gets the chance to set active:false, so without a timer this would just show
  // "recording" forever once the real recording had actually died.
  useEffect(() => {
    if (!callActive) {
      setRecordingBanner(null);
      return;
    }
    const recRef = ref(db, `chats/${room}/recording`);
    const handler = (snapshot) => {
      const data = snapshot.val();
      if (!data || !data.active) {
        setRecordingBanner(null);
        return;
      }
      const stale = !data.lastHeartbeat || Date.now() - data.lastHeartbeat > 30000;
      setRecordingBanner(stale ? null : data);
    };
    onValue(recRef, handler);
    const staleCheck = setInterval(() => {
      setRecordingBanner((prev) =>
        prev && prev.lastHeartbeat && Date.now() - prev.lastHeartbeat > 30000 ? null : prev,
      );
    }, 5000);
    return () => {
      off(recRef, "value", handler);
      clearInterval(staleCheck);
    };
  }, [callActive, room]);
  function attachTrack(track, identity, isLocal) {
    const grid = gridRef.current;
    if (!grid) return;
    let wrapper = grid.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "vc-tile";
      wrapper.dataset.identity = identity;
      const label = document.createElement("div");
      label.className = "vc-tile-label";
      label.textContent = identity;
      wrapper.appendChild(label);
      grid.appendChild(wrapper);
    }
    if (track.kind === "video") {
      const el = track.attach();
      el.className = "vc-tile-video";
      el.muted = isLocal;
      // playsInline is required on iOS Safari for a video element to play inline at
      // all — without it, the browser either refuses to autoplay or forces fullscreen
      // instead. Desktop browsers don't enforce this, which is exactly why this gap
      // (carried over from public/index.html's attachTrack, which had the same
      // omission) went unnoticed until testing from an actual phone. autoplay is set
      // explicitly too rather than relying on livekit-client's default, since a muted
      // local preview needs it to start without a tap.
      el.playsInline = true;
      el.setAttribute("playsinline", "true");
      el.autoplay = true;
      wrapper.insertBefore(el, wrapper.firstChild);
      // No explicit el.play() call here (unlike the audio branch below) — livekit-
      // client's track.attach() already starts playback internally once autoplay/
      // playsInline are set. Calling .play() again immediately after inserting the
      // element into the DOM raced against that internal call and threw a harmless but
      // noisy "AbortError: play() request was interrupted by a new load request" on
      // every tile (confirmed live: video played correctly despite the error). Removed
      // rather than swallowed, since the call was doing nothing useful.
    } else if (track.kind === "audio") {
      const el = track.attach();
      // vc-tile-audio is a hook for the recording compositor's WebAudio mixer
      // (startRecording below) to find every remote participant's audio element —
      // it's otherwise unused for styling (the element stays display:none either way).
      el.className = "vc-tile-audio";
      el.autoplay = true;
      el.style.display = "none";
      if (isLocal) el.muted = true;
      wrapper.appendChild(el);
      el.play().catch((err) => console.error("[audio] play() failed for", identity, err));
    }
  }
  function removeTile(identity) {
    const grid = gridRef.current;
    if (!grid) return;
    const wrapper = grid.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
    if (wrapper) wrapper.remove();
  }
  function showCaption(identity, text) {
    const grid = gridRef.current;
    if (!grid) {
      console.warn("[caption] showCaption called but .vc-grid isn't mounted");
      return;
    }
    const wrapper = grid.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
    if (!wrapper) {
      // Diagnostic for the "captions not showing up" bug: if this fires, the caption
      // pipeline worked end-to-end (server -> Firebase -> listener -> translate) but the
      // identity string didn't match any current video tile's data-identity. Logging the
      // full set of tile identities alongside the one we were looking for turns a silent
      // no-op into a comparable pair of strings (catches case/whitespace/email mismatches
      // instead of guessing).
      const known = [...grid.querySelectorAll("[data-identity]")].map((el) => el.dataset.identity);
      console.warn("[caption] no video tile for identity", JSON.stringify(identity), "— known tiles:", known);
      return;
    }
    let capDiv = wrapper.querySelector(".vc-tile-caption");
    if (!capDiv) {
      capDiv = document.createElement("div");
      capDiv.className = "vc-tile-caption";
      wrapper.appendChild(capDiv);
    }
    capDiv.textContent = text;
    clearTimeout(capDiv._hideTimer);
    capDiv._hideTimer = setTimeout(() => {
      capDiv.textContent = "";
    }, 6000);
    console.log("[caption] displayed on tile", identity, ":", text);
  }
  function startCaptionStream() {
    const lang = speakLangRef.current;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${wsProtocol}//${location.host}/ws/transcribe?lang=${lang}`);
        captionWsRef.current = ws;
        ws.onopen = () => {
          const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
          captionRecorderRef.current = recorder;
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
              e.data.arrayBuffer().then((buf) => ws.send(buf));
            }
          };
          recorder.start(250);
        };
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "transcript" && data.text) {
            const captionsRef = ref(db, `chats/${roomRef.current}/captions`);
            // push() returned a promise that was never awaited or checked — a silent
            // Firebase failure here (e.g. a security-rules permission issue on the
            // `captions` path specifically, as opposed to `messages`/`presence` which
            // Group Chat already writes to successfully) would look identical to
            // "captions just aren't showing up" from the receiving end, with nothing in
            // the console to tell them apart. Logging both outcomes explicitly.
            push(captionsRef, { from: user.email, text: data.text, ts: serverTimestamp() })
              .then(() => console.log("[caption] pushed to firebase:", data.text))
              .catch((err) => console.error("[caption] firebase push FAILED:", err));
          }
        };
        ws.onerror = (e) => console.error("Caption WS error:", e);
      })
      .catch((err) => console.error("Mic access error for captions:", err));
  }
  function stopOutgoingCaptionStream() {
    if (captionRecorderRef.current && captionRecorderRef.current.state !== "inactive") {
      captionRecorderRef.current.stop();
    }
    captionRecorderRef.current = null;
    if (captionWsRef.current) {
      captionWsRef.current.close();
      captionWsRef.current = null;
    }
  }
  function stopCaptionStream() {
    stopOutgoingCaptionStream();
    if (captionOffRef.current) {
      captionOffRef.current();
      captionOffRef.current = null;
    }
  }
  function listenToCaptions(roomName) {
    const captionsRef = ref(db, `chats/${roomName}/captions`);
    const capQuery = query(captionsRef, limitToLast(1));
    const handler = (snapshot) => {
      console.log("[caption] listener fired for room", roomName, "exists:", snapshot.exists());
      snapshot.forEach((child) => {
        const msg = child.val();
        if (!msg || msg.from === user.email) {
          console.log("[caption] skipping (own message or empty):", msg);
          return;
        }
        console.log("[caption] incoming from", msg.from, ":", msg.text);
        callTranslate(msg.text, "auto", showLangRef.current)
          .then((res) => showCaption(msg.from, res.translation || msg.text))
          .catch((err) => {
            console.error("[caption] translate failed, showing raw text:", err);
            showCaption(msg.from, msg.text);
          });
      });
    };
    // onValue's third argument is an error callback — without it, a Firebase permission
    // error on this specific path (captions) would throw once into the void and never
    // surface anywhere, indistinguishable from "nothing happened."
    onValue(capQuery, handler, (err) => console.error("[caption] listener error (permissions?):", err));
    captionOffRef.current = () => off(capQuery, "value", handler);
  }
  // Spoken-language WS is opened once per call with ?lang=... — a mid-call change needs
  // a reconnect for Deepgram to pick up the new language. Only restart the OUTGOING
  // mic/WS stream — a full stop/start would also tear down the incoming captions
  // listener via stopCaptionStream(), and nothing here re-subscribes it (mirrors the
  // same fix documented for this exact bug in public/index.html, commits 76b304a-997d50f
  // per POSTMORTEM.md/PROJECT_LOG.md — carried forward rather than re-introduced).
  function onSpeakLangChange(lang) {
    setSpeakLang(lang);
    speakLangRef.current = lang;
    if (callActive && captionWsRef.current) {
      stopOutgoingCaptionStream();
      startCaptionStream();
    }
  }
  // ── Call recording ────────────────────────────────────────────────────────────────
  // Taps a remote participant's already-attached, already-playing <audio> element into
  // the WebAudio mix graph. createMediaElementSource() takes over that element's output
  // — without also connecting it to audioCtx.destination it would go silent for
  // everyone the moment a recording starts, which would be a much worse bug than not
  // recording at all. connected is a WeakSet so a re-scan of the grid (new participants
  // can join mid-recording) never taps the same element twice.
  function connectAudioElement(el, audioCtx, destination, connected) {
    if (connected.has(el)) return;
    connected.add(el);
    try {
      const src = audioCtx.createMediaElementSource(el);
      src.connect(destination);
      src.connect(audioCtx.destination);
    } catch (err) {
      console.error("[recording] failed to tap audio element for mixing:", err);
    }
  }
  async function startRecording() {
    if (recordingBusy || isRecordingMineRef.current || recordingBanner) return;
    setRecordingBusy(true);
    try {
      const res = await fetch("/api/videocall/recording/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room }),
      });
      const { recordingId, error } = await res.json();
      if (error || !recordingId) throw new Error(error || "Could not start recording session");
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const mixDestination = audioCtx.createMediaStreamDestination();
      const connectedAudioEls = new WeakSet();
      // Local mic: published to LiveKit but never attached to a visible/audible element
      // (we don't play our own voice back to ourselves) — tapped straight from the
      // track livekitRoomRef stashed here back in joinCall().
      const localTrack = recordingRef.current.localAudioTrack;
      if (localTrack?.mediaStreamTrack) {
        const localStream = new MediaStream([localTrack.mediaStreamTrack]);
        audioCtx.createMediaStreamSource(localStream).connect(mixDestination);
      }
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const canvasCtx = canvas.getContext("2d");
      function drawFrame() {
        const grid = gridRef.current;
        canvasCtx.fillStyle = "#111";
        canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
        if (grid) {
          grid
            .querySelectorAll(".vc-tile-audio")
            .forEach((el) => connectAudioElement(el, audioCtx, mixDestination, connectedAudioEls));
          const tiles = [...grid.querySelectorAll(".vc-tile")];
          const cols = Math.ceil(Math.sqrt(tiles.length || 1));
          const rows = Math.ceil((tiles.length || 1) / cols);
          const tileW = canvas.width / cols;
          const tileH = canvas.height / rows;
          tiles.forEach((tile, i) => {
            const video = tile.querySelector(".vc-tile-video");
            const x = (i % cols) * tileW;
            const y = Math.floor(i / cols) * tileH;
            if (video && video.readyState >= 2) {
              canvasCtx.drawImage(video, x, y, tileW, tileH);
            }
            canvasCtx.fillStyle = "rgba(0,0,0,0.55)";
            canvasCtx.fillRect(x, y + tileH - 22, tileW, 22);
            canvasCtx.fillStyle = "#fff";
            canvasCtx.font = "14px sans-serif";
            canvasCtx.fillText(tile.dataset.identity || "", x + 6, y + tileH - 6);
          });
        }
        recordingRef.current.rafId = requestAnimationFrame(drawFrame);
      }
      drawFrame();
      const canvasStream = canvas.captureStream(15);
      const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...mixDestination.stream.getAudioTracks(),
      ]);
      const mediaRecorder = new MediaRecorder(combined, { mimeType: "video/webm;codecs=vp8,opus" });
      // Chunks must land on disk in the exact order MediaRecorder produced them —
      // they're slices of one continuous webm stream, not independently valid files —
      // so uploads are chained through a single promise rather than fired in parallel,
      // which would let a slower request finish after a later, faster one and corrupt
      // the file.
      let uploadQueue = Promise.resolve();
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        uploadQueue = uploadQueue.then(() =>
          fetch(`/api/videocall/recording/${recordingId}/chunk`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: e.data,
          }).catch((err) => console.error("[recording] chunk upload failed:", err)),
        );
      };
      mediaRecorder.start(5000); // emit + upload a chunk every 5s
      const recRef = ref(db, `chats/${room}/recording`);
      const heartbeat = () =>
        set(recRef, { active: true, startedBy: user.email, lastHeartbeat: serverTimestamp() });
      heartbeat();
      const heartbeatIntervalId = setInterval(heartbeat, 10000);
      recordingRef.current = {
        ...recordingRef.current,
        recordingId,
        audioCtx,
        rafId: recordingRef.current.rafId,
        heartbeatIntervalId,
        mediaRecorder,
        getUploadQueue: () => uploadQueue,
      };
      setIsRecordingMine(true);
      showToast("🔴 Recording started — everyone in the call sees a notice");
    } catch (e) {
      console.error("[recording] start failed:", e);
      showToast("Could not start recording: " + e.message, 3000);
    }
    setRecordingBusy(false);
  }
  async function stopRecording() {
    if (!isRecordingMineRef.current) return;
    setRecordingBusy(true);
    const rec = recordingRef.current;
    try {
      if (rec.rafId) cancelAnimationFrame(rec.rafId);
      if (rec.heartbeatIntervalId) clearInterval(rec.heartbeatIntervalId);
      if (rec.mediaRecorder && rec.mediaRecorder.state !== "inactive") {
        const stopped = new Promise((resolve) => {
          rec.mediaRecorder.onstop = resolve;
        });
        rec.mediaRecorder.stop();
        await stopped;
      }
      if (rec.getUploadQueue) await rec.getUploadQueue();
      if (rec.audioCtx) await rec.audioCtx.close().catch(() => {});
      if (rec.recordingId) {
        await fetch(`/api/videocall/recording/${rec.recordingId}/stop`, { method: "POST" });
      }
      await set(ref(db, `chats/${room}/recording`), { active: false });
      setLastRecordingRoom(room);
      showToast("Recording saved");
    } catch (e) {
      console.error("[recording] stop failed:", e);
      showToast("Recording stop had an issue — check the download link once you leave the call", 4000);
    }
    recordingRef.current = {
      recordingId: null,
      audioCtx: null,
      rafId: null,
      heartbeatIntervalId: null,
      mediaRecorder: null,
      getUploadQueue: null,
      localAudioTrack: rec.localAudioTrack, // still mid-call, keep it around
    };
    setIsRecordingMine(false);
    setRecordingBusy(false);
  }
  async function joinCall() {
    setConnecting(true);
    try {
      const res = await fetch("/api/livekit-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: room, participantName: user.email }),
      });
      const { token, url, error } = await res.json();
      if (error || !token) throw new Error(error || "No token returned");
      const livekitRoom = new Room({ adaptiveStream: true, dynacast: true });
      livekitRoomRef.current = livekitRoom;
      livekitRoom.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        attachTrack(track, participant.identity, false);
      });
      livekitRoom.on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
        removeTile(participant.identity);
      });
      livekitRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeTile(participant.identity);
      });
      await livekitRoom.connect(url, token);
      const videoTrack = await createLocalVideoTrack({ facingMode: "user" });
      const audioTrack = await createLocalAudioTrack();
      recordingRef.current.localAudioTrack = audioTrack;
      await livekitRoom.localParticipant.publishTrack(videoTrack);
      await livekitRoom.localParticipant.publishTrack(audioTrack);
      attachTrack(videoTrack, "You (local)", true);
      setCallActive(true);
      showToast("Video call started!");
      startCaptionStream();
      listenToCaptions(room);
    } catch (e) {
      console.error("Video error:", e);
      showToast("Could not start video: " + e.message, 3000);
      if (livekitRoomRef.current) {
        await livekitRoomRef.current.disconnect().catch(() => {});
        livekitRoomRef.current = null;
      }
    }
    setConnecting(false);
  }
  async function leaveCall() {
    if (isRecordingMineRef.current) {
      await stopRecording();
    }
    if (livekitRoomRef.current) {
      await livekitRoomRef.current.disconnect().catch(() => {});
      livekitRoomRef.current = null;
    }
    stopCaptionStream();
    recordingRef.current.localAudioTrack = null;
    if (gridRef.current) gridRef.current.innerHTML = "";
    setCallActive(false);
  }
  async function toggleCall() {
    if (callActive) {
      await leaveCall();
      showToast("Left video call");
    } else {
      await joinCall();
    }
  }
  function switchRoom(r) {
    if (callActive) {
      showToast("Leave the current call before switching rooms", 3000);
      return;
    }
    setRoom(r);
    setInviteOpen(false);
  }
  function copyInviteLink() {
    const link = `${window.location.origin}${window.location.pathname}?tab=videocall&room=${room}`;
    navigator.clipboard
      .writeText(link)
      .then(() => showToast("Invite link copied! Send it to anyone.", 3000));
  }
  return (
    <div className="vc-tab">
      <div className="vc-toprow">
        <div className="vc-room-picker">
          {ROOMS.map((r) => (
            <button
              key={r}
              className={"gc-room-btn" + (r === room ? " active" : "")}
              onClick={() => switchRoom(r)}
            >
              #{r}
            </button>
          ))}
        </div>
        <div className="gc-account">
          <span className="gc-account-email" title={user.email}>
            {user.email}
          </span>
          <button className="gc-icon-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
      <div className="gc-actionrow">
        {callActive && (
          <button
            className={"gc-pill" + (isRecordingMine ? " gc-pill-accent" : "")}
            onClick={isRecordingMine ? stopRecording : startRecording}
            disabled={recordingBusy || (!!recordingBanner && !isRecordingMine)}
          >
            {recordingBusy
              ? "…"
              : isRecordingMine
                ? "⏹ Stop Recording"
                : recordingBanner
                  ? "🔴 Recording in progress"
                  : "🔴 Record"}
          </button>
        )}
        <button className="gc-pill gc-pill-accent" onClick={() => setInviteOpen(true)}>
          ✉️ Invite
        </button>
      </div>
      {callActive && recordingBanner && (
        <div className="vc-recording-banner">🔴 This call is being recorded by {recordingBanner.startedBy}</div>
      )}
      <div className="lang-bar gc-lang-bar">
        <select
          className="lang-sel"
          value={speakLang}
          onChange={(e) => onSpeakLangChange(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>
        <span className="gc-lang-caption">I speak</span>
        <select className="lang-sel" value={showLang} onChange={(e) => setShowLang(e.target.value)}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>
        <span className="gc-lang-caption">captions in</span>
      </div>
      <button
        className={"btn " + (callActive ? "btn-danger" : "btn-secondary") + " vc-call-btn"}
        onClick={toggleCall}
        disabled={connecting}
      >
        {connecting ? (
          <span className="spinner" />
        ) : callActive ? (
          "🔴 End Video Call"
        ) : (
          `📹 Start Video Call in #${room}`
        )}
      </button>
      {/* Always mounted (visibility toggled via CSS, not conditional rendering) so
          gridRef.current is already populated by the time joinCall() attaches the local
          track. It used to be `{callActive && <div ... />}`, which meant the grid div
          didn't exist in the DOM until AFTER setCallActive(true) triggered a re-render —
          but attachTrack() for the local video/audio tracks runs *before* that
          setCallActive() call, so gridRef.current was still null and attachTrack's
          early-return guard silently no-opped. Local video never rendered, on any
          browser or device — this wasn't a mobile-specific bug (playsInline, fixed
          separately, was a real but secondary gap). */}
      <div className="vc-grid" ref={gridRef} style={{ display: callActive ? "flex" : "none" }} />
      {!callActive && (
        <div className="vc-empty">Join a call to see video tiles and live translated captions here.</div>
      )}
      {!callActive && lastRecordingRoom === room && (
        <button
          className="btn btn-secondary"
          onClick={() => {
            window.location.href = `/api/videocall/recording/${room}`;
          }}
        >
          🎬 Download last recording
        </button>
      )}
      {inviteOpen && (
        <div
          className="gc-invite-backdrop"
          onClick={(e) => e.target === e.currentTarget && setInviteOpen(false)}
        >
          <div className="gc-invite-box">
            <div className="gc-invite-title">Invite to #{room} video call</div>
            <div className="gc-invite-sub">Share this link — anyone with it can join the call</div>
            <div className="gc-invite-row">
              <input
                readOnly
                className="gc-invite-input"
                value={`${window.location.origin}${window.location.pathname}?tab=videocall&room=${room}`}
              />
              <button className="btn btn-primary" style={{ flex: "none" }} onClick={copyInviteLink}>
                Copy
              </button>
            </div>
            <button
              className="btn btn-secondary"
              style={{ width: "100%", marginTop: 14 }}
              onClick={() => setInviteOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
