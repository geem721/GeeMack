import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, createLocalVideoTrack, createLocalAudioTrack } from "livekit-client";
import { ref, onValue, off, set, serverTimestamp } from "firebase/database";
import { auth, db } from "../firebase.js";
import { callTranslate } from "../api/translate.js";
import { useToast } from "../components/Toast.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { LANGUAGES } from "../languages.js";
import "./VideoCall.css";
import "./Meetings.css";

// Meetings — TalkBridge's business video meeting feature (multi-party, host-created,
// account-gated). A sibling to Video Call, not a mode of it: Video Call is casual
// calling in a small fixed set of shared named rooms (rooms.js, shared with Group
// Chat); a Meeting is a private, host-created room with its own short shareable ID
// (server-generated, see the /api/meetings/* block in server.js), open only to whoever
// has the link and a signed-in TalkBridge account (no guest join, by design — Sept 14
// session: keeps usage caps and the login-gated product model consistent app-wide).
//
// Track/caption/recording machinery below is deliberately copy-adapted from
// VideoCall.jsx rather than pulled into a shared hook — see server.js's meetings
// section for the reasoning (short version: don't abstract before a second real use
// case has proven out what actually needs to be shared; revisit once Meetings' own
// UX — host controls, multi-party layout — has stabilized through real use).
//
// Captions and the recording heartbeat write to chats/{meetingId}/... in Firebase RTDB
// — reusing the exact path shape Group Chat/Video Call already have security-rules
// access to (chats/{roomId} readable+writable by any signed-in user), rather than
// adding a new meetings/{id}/... path that would need a console-managed rules change
// tonight. A meeting code works fine as a chats/ child key — Firebase doesn't care that
// it looks like "xtb-fmqr-jkd" instead of "general". Same reasoning for reusing the
// existing /api/videocall/recording/* endpoints as-is: they take an arbitrary `room`
// string validated only against /^[a-zA-Z0-9_-]+$/, which a meeting code already
// satisfies — no server changes needed there either.
export default function Meetings({ initialMeetingId }) {
  const { user, signOutUser } = useAuth();
  return <MeetingsPanel user={user} onSignOut={signOutUser} initialMeetingId={initialMeetingId} />;
}

function MeetingsPanel({ user, onSignOut, initialMeetingId }) {
  const { showToast } = useToast();
  // stage: "landing" | "creating" | "preview" | "in-call"
  const [stage, setStage] = useState(initialMeetingId ? "preview" : "landing");
  const [meetingId, setMeetingId] = useState(initialMeetingId || "");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [previewInfo, setPreviewInfo] = useState(null); // { title, hostName, isHost }
  const [previewError, setPreviewError] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [speakLang, setSpeakLang] = useState("en");
  const [showLang, setShowLang] = useState("en");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState([]); // remote participant identities, for host controls
  const [recordingBanner, setRecordingBanner] = useState(null);
  const [isRecordingMine, setIsRecordingMine] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [lastRecordingMeeting, setLastRecordingMeeting] = useState(null);
  const [endBusy, setEndBusy] = useState(false);

  const gridRef = useRef(null);
  const livekitRoomRef = useRef(null);
  const videoHeartbeatRef = useRef(null);
  const captionWsRef = useRef(null);
  const captionRecorderRef = useRef(null);
  const captionOffRef = useRef(null);
  const speakLangRef = useRef(speakLang);
  const showLangRef = useRef(showLang);
  const meetingIdRef = useRef(meetingId);
  const isRecordingMineRef = useRef(false);
  // Set right before we ourselves trigger a disconnect (Leave / End Meeting), so the
  // Disconnected handler can tell "I left on purpose" apart from "the host ended this
  // out from under me" / a real connection drop, and only show the latter as a surprise.
  const selfInitiatedDisconnectRef = useRef(false);
  const recordingRef = useRef({
    recordingId: null,
    audioCtx: null,
    rafId: null,
    heartbeatIntervalId: null,
    mediaRecorder: null,
    getUploadQueue: null,
    localAudioTrack: null,
  });

  useEffect(() => { speakLangRef.current = speakLang; }, [speakLang]);
  useEffect(() => { showLangRef.current = showLang; }, [showLang]);
  useEffect(() => { meetingIdRef.current = meetingId; }, [meetingId]);
  useEffect(() => { isRecordingMineRef.current = isRecordingMine; }, [isRecordingMine]);

  useEffect(() => {
    return () => { leaveCall(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arrived via a meeting link (?tab=meetings&meeting=...) — preview it before joining,
  // same as the manual "Join Meeting" flow below.
  useEffect(() => {
    if (initialMeetingId) previewMeeting(initialMeetingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMeetingId]);

  useEffect(() => {
    if (!callActive) { setRecordingBanner(null); return; }
    const recRef = ref(db, `chats/${meetingId}/recording`);
    const handler = (snapshot) => {
      const data = snapshot.val();
      if (!data || !data.active) { setRecordingBanner(null); return; }
      const stale = !data.lastHeartbeat || Date.now() - data.lastHeartbeat > 30000;
      setRecordingBanner(stale ? null : data);
    };
    onValue(recRef, handler);
    const staleCheck = setInterval(() => {
      setRecordingBanner((prev) =>
        prev && prev.lastHeartbeat && Date.now() - prev.lastHeartbeat > 30000 ? null : prev,
      );
    }, 5000);
    return () => { off(recRef, "value", handler); clearInterval(staleCheck); };
  }, [callActive, meetingId]);

  // ---- Track/tile/caption handling — copy-adapted from VideoCall.jsx verbatim ----
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
      el.playsInline = true;
      el.setAttribute("playsinline", "true");
      el.autoplay = true;
      wrapper.insertBefore(el, wrapper.firstChild);
    } else if (track.kind === "audio") {
      const el = track.attach();
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
    if (!grid) return;
    const wrapper = grid.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
    if (!wrapper) return;
    let capDiv = wrapper.querySelector(".vc-tile-caption");
    if (!capDiv) {
      capDiv = document.createElement("div");
      capDiv.className = "vc-tile-caption";
      wrapper.appendChild(capDiv);
    }
    capDiv.textContent = text;
    clearTimeout(capDiv._hideTimer);
    capDiv._hideTimer = setTimeout(() => { capDiv.textContent = ""; }, 6000);
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
            const captionsRef = ref(db, `chats/${meetingIdRef.current}/captions`);
            import("firebase/database").then(({ push, serverTimestamp: sts }) => {
              push(captionsRef, { from: user.email, text: data.text, ts: sts() }).catch((err) =>
                console.error("[caption] firebase push FAILED:", err),
              );
            });
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
  function listenToCaptions(meetingId) {
    import("firebase/database").then(({ query, limitToLast }) => {
      const captionsRef = ref(db, `chats/${meetingId}/captions`);
      const capQuery = query(captionsRef, limitToLast(1));
      const handler = (snapshot) => {
        snapshot.forEach((child) => {
          const msg = child.val();
          if (!msg || msg.from === user.email) return;
          callTranslate(msg.text, "auto", showLangRef.current)
            .then((res) => showCaption(msg.from, res.translation || msg.text))
            .catch(() => showCaption(msg.from, msg.text));
        });
      };
      onValue(capQuery, handler, (err) => console.error("[caption] listener error (permissions?):", err));
      captionOffRef.current = () => off(capQuery, "value", handler);
    });
  }
  function onSpeakLangChange(lang) {
    setSpeakLang(lang);
    speakLangRef.current = lang;
    if (callActive && captionWsRef.current) {
      stopOutgoingCaptionStream();
      startCaptionStream();
    }
  }

  // ---- Recording — copy-adapted from VideoCall.jsx, keyed by meetingId ----
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
        body: JSON.stringify({ room: meetingId }),
      });
      const { recordingId, error } = await res.json();
      if (error || !recordingId) throw new Error(error || "Could not start recording session");
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const mixDestination = audioCtx.createMediaStreamDestination();
      const connectedAudioEls = new WeakSet();
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
            if (video && video.readyState >= 2) canvasCtx.drawImage(video, x, y, tileW, tileH);
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
      mediaRecorder.start(5000);
      const recRef = ref(db, `chats/${meetingId}/recording`);
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
      showToast("🔴 Recording started — everyone in the meeting sees a notice");
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
        const stopped = new Promise((resolve) => { rec.mediaRecorder.onstop = resolve; });
        rec.mediaRecorder.stop();
        await stopped;
      }
      if (rec.getUploadQueue) await rec.getUploadQueue();
      if (rec.audioCtx) await rec.audioCtx.close().catch(() => {});
      if (rec.recordingId) {
        await fetch(`/api/videocall/recording/${rec.recordingId}/stop`, { method: "POST" });
      }
      await set(ref(db, `chats/${meetingId}/recording`), { active: false });
      setLastRecordingMeeting(meetingId);
      showToast("Recording saved");
    } catch (e) {
      console.error("[recording] stop failed:", e);
      showToast("Recording stop had an issue — check the download link once you leave the meeting", 4000);
    }
    recordingRef.current = {
      recordingId: null, audioCtx: null, rafId: null, heartbeatIntervalId: null,
      mediaRecorder: null, getUploadQueue: null, localAudioTrack: rec.localAudioTrack,
    };
    setIsRecordingMine(false);
    setRecordingBusy(false);
  }

  // ---- Meetings-specific: create / preview / join / host controls ----
  async function createMeeting() {
    setStage("creating");
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch("/api/meetings/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ title: titleInput.trim() || undefined, hostName: user.email }),
      });
      const data = await res.json();
      if (data.error || !data.meetingId) throw new Error(data.error || "Could not create meeting");
      setMeetingId(data.meetingId);
      setIsHost(true);
      await joinCall(data.meetingId, true);
      setInviteOpen(true); // host lands straight in the call with the invite box open, ready to share
    } catch (e) {
      showToast("Could not create meeting: " + e.message, 3000);
      setStage("landing");
    }
  }
  async function previewMeeting(id) {
    setPreviewError(null);
    setPreviewBusy(true);
    setMeetingId(id);
    setStage("preview");
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`/api/meetings/${id}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Meeting not found");
      setPreviewInfo(data);
    } catch (e) {
      setPreviewError(e.message);
    }
    setPreviewBusy(false);
  }
  function submitJoinCode() {
    const code = joinCodeInput.trim().toLowerCase();
    if (!code) return;
    previewMeeting(code);
  }
  async function confirmJoin() {
    await joinCall(meetingId, previewInfo?.isHost || false);
  }

  async function joinCall(id, hostFlag) {
    setConnecting(true);
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`/api/meetings/${id}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ participantName: user.email }),
      });
      const { token, url, isHost: serverIsHost, error } = await res.json();
      if (error || !token) throw new Error(error || "No token returned");
      setIsHost(!!serverIsHost || !!hostFlag);
      const livekitRoom = new Room({ adaptiveStream: true, dynacast: true });
      livekitRoomRef.current = livekitRoom;
      livekitRoom.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        attachTrack(track, participant.identity, false);
      });
      livekitRoom.on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
        removeTile(participant.identity);
      });
      livekitRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        setParticipants((prev) => [...prev.filter((p) => p !== participant.identity), participant.identity]);
      });
      livekitRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeTile(participant.identity);
        setParticipants((prev) => prev.filter((p) => p !== participant.identity));
      });
      livekitRoom.on(RoomEvent.Disconnected, () => {
        if (!selfInitiatedDisconnectRef.current) {
          showToast("This meeting has ended", 4000);
        }
        selfInitiatedDisconnectRef.current = false;
        resetToLanding();
      });
      await livekitRoom.connect(url, token);
      setParticipants([...livekitRoom.remoteParticipants.keys()]);
      const videoTrack = await createLocalVideoTrack({ facingMode: "user" });
      const audioTrack = await createLocalAudioTrack();
      recordingRef.current.localAudioTrack = audioTrack;
      await livekitRoom.localParticipant.publishTrack(videoTrack);
      await livekitRoom.localParticipant.publishTrack(audioTrack);
      attachTrack(videoTrack, "You (local)", true);
      setCallActive(true);
      setStage("in-call");
      showToast("Meeting joined!");
      startCaptionStream();
      listenToCaptions(id);
      videoHeartbeatRef.current = setInterval(async () => {
        try {
          const hbToken = await auth.currentUser.getIdToken();
          const hbRes = await fetch("/api/videocall/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${hbToken}` },
            body: JSON.stringify({ room: id }),
          });
          const hbData = await hbRes.json();
          if (!hbData.ok) {
            showToast(hbData.error || "Monthly video call limit reached", 4000);
            await leaveCall();
          }
        } catch (e) {
          // network hiccup — skip this tick
        }
      }, 30000);
    } catch (e) {
      console.error("Meeting join error:", e);
      showToast("Could not join meeting: " + e.message, 3000);
      if (livekitRoomRef.current) {
        await livekitRoomRef.current.disconnect().catch(() => {});
        livekitRoomRef.current = null;
      }
      setStage("landing");
    }
    setConnecting(false);
  }

  async function leaveCall() {
    if (videoHeartbeatRef.current) {
      clearInterval(videoHeartbeatRef.current);
      videoHeartbeatRef.current = null;
    }
    if (isRecordingMineRef.current) await stopRecording();
    selfInitiatedDisconnectRef.current = true;
    if (livekitRoomRef.current) {
      await livekitRoomRef.current.disconnect().catch(() => {});
      livekitRoomRef.current = null;
    }
    stopCaptionStream();
    recordingRef.current.localAudioTrack = null;
    if (gridRef.current) gridRef.current.innerHTML = "";
    setCallActive(false);
  }
  function resetToLanding() {
    setStage("landing");
    setMeetingId("");
    setPreviewInfo(null);
    setJoinCodeInput("");
    setTitleInput("");
    setIsHost(false);
    setParticipants([]);
  }
  async function endMeetingForEveryone() {
    if (!isHost || endBusy) return;
    setEndBusy(true);
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`/api/meetings/${meetingId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not end meeting");
      showToast("Meeting ended for everyone");
      await leaveCall();
      resetToLanding();
    } catch (e) {
      showToast("Could not end meeting: " + e.message, 3000);
    }
    setEndBusy(false);
  }
  async function kickParticipant(identity) {
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`/api/meetings/${meetingId}/kick`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ participantIdentity: identity }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove participant");
      showToast(`Removed ${identity} from the meeting`);
    } catch (e) {
      showToast("Could not remove participant: " + e.message, 3000);
    }
  }
  function inviteLink() {
    return `${window.location.origin}${window.location.pathname}?tab=meetings&meeting=${meetingId}`;
  }
  function copyInviteLink() {
    navigator.clipboard.writeText(inviteLink()).then(() => showToast("Invite link copied! Send it to anyone.", 3000));
  }

  // ---- Render ----
  if (stage === "landing" || stage === "creating") {
    return (
      <div className="mt-landing">
        <div className="mt-toprow">
          <span className="mt-title">🤝 Meetings</span>
          <div className="gc-account">
            <span className="gc-account-email" title={user.email}>{user.email}</span>
            <button className="gc-icon-btn" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
        <div className="mt-landing-body">
          <div className="mt-landing-card">
            <div className="mt-landing-card-title">Start a new meeting</div>
            <input
              className="mt-input"
              placeholder="Meeting title (optional)"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              disabled={stage === "creating"}
            />
            <button className="btn btn-primary" onClick={createMeeting} disabled={stage === "creating"}>
              {stage === "creating" ? <span className="spinner" /> : "📹 New Meeting"}
            </button>
          </div>
          <div className="mt-landing-card">
            <div className="mt-landing-card-title">Join a meeting</div>
            <input
              className="mt-input"
              placeholder="Meeting code (e.g. xtb-fmqr-jkd)"
              value={joinCodeInput}
              onChange={(e) => setJoinCodeInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitJoinCode()}
            />
            <button className="btn btn-secondary" onClick={submitJoinCode} disabled={!joinCodeInput.trim()}>
              Join
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "preview") {
    return (
      <div className="mt-landing">
        <div className="mt-preview-card">
          {previewBusy && <span className="spinner" />}
          {previewError && (
            <>
              <div className="mt-landing-card-title">Can't join this meeting</div>
              <div className="mt-preview-sub">{previewError}</div>
              <button className="btn btn-secondary" onClick={resetToLanding}>Back</button>
            </>
          )}
          {!previewBusy && !previewError && previewInfo && (
            <>
              <div className="mt-landing-card-title">{previewInfo.title}</div>
              <div className="mt-preview-sub">Hosted by {previewInfo.hostName}</div>
              <button className="btn btn-primary" onClick={confirmJoin} disabled={connecting}>
                {connecting ? <span className="spinner" /> : "Join Meeting"}
              </button>
              <button className="btn btn-secondary" onClick={resetToLanding} disabled={connecting}>Cancel</button>
            </>
          )}
        </div>
      </div>
    );
  }

  // stage === "in-call"
  return (
    <div className="vc-tab">
      <div className="vc-toprow">
        <span className="mt-title">🤝 {meetingId}</span>
        <div className="gc-account">
          <span className="gc-account-email" title={user.email}>{user.email}</span>
          <button className="gc-icon-btn" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
      <div className="gc-actionrow">
        <button
          className={"gc-pill" + (isRecordingMine ? " gc-pill-accent" : "")}
          onClick={isRecordingMine ? stopRecording : startRecording}
          disabled={recordingBusy || (!!recordingBanner && !isRecordingMine)}
        >
          {recordingBusy ? "…" : isRecordingMine ? "⏹ Stop Recording" : recordingBanner ? "🔴 Recording in progress" : "🔴 Record"}
        </button>
        <button className="gc-pill gc-pill-accent" onClick={() => setInviteOpen(true)}>✉️ Invite</button>
        {isHost && (
          <button className="gc-pill mt-pill-danger" onClick={endMeetingForEveryone} disabled={endBusy}>
            {endBusy ? "…" : "⛔ End Meeting for Everyone"}
          </button>
        )}
      </div>
      {recordingBanner && (
        <div className="vc-recording-banner">🔴 This meeting is being recorded by {recordingBanner.startedBy}</div>
      )}
      <div className="lang-bar gc-lang-bar">
        <select className="lang-sel" value={speakLang} onChange={(e) => onSpeakLangChange(e.target.value)}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
        </select>
        <span className="gc-lang-caption">I speak</span>
        <select className="lang-sel" value={showLang} onChange={(e) => setShowLang(e.target.value)}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
        </select>
        <span className="gc-lang-caption">captions in</span>
      </div>
      <button className="btn btn-danger vc-call-btn" onClick={async () => { await leaveCall(); resetToLanding(); }}>
        🔴 Leave Meeting
      </button>
      <div className="mt-inroom">
        <div className="vc-grid" ref={gridRef} style={{ display: "flex" }} />
        {isHost && participants.length > 0 && (
          <div className="mt-host-panel">
            <div className="mt-host-panel-title">Participants ({participants.length})</div>
            {participants.map((identity) => (
              <div className="mt-host-participant" key={identity}>
                <span>{identity}</span>
                <button className="btn btn-secondary mt-host-remove" onClick={() => kickParticipant(identity)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {lastRecordingMeeting === meetingId && (
        <button className="btn btn-secondary" onClick={() => { window.location.href = `/api/videocall/recording/${meetingId}`; }}>
          🎬 Download last recording
        </button>
      )}
      {inviteOpen && (
        <div className="gc-invite-backdrop" onClick={(e) => e.target === e.currentTarget && setInviteOpen(false)}>
          <div className="gc-invite-box">
            <div className="gc-invite-title">Invite to this meeting</div>
            <div className="gc-invite-sub">Share this link — anyone with a TalkBridge account can join</div>
            <div className="gc-invite-row">
              <input readOnly className="gc-invite-input" value={inviteLink()} />
              <button className="btn btn-primary" style={{ flex: "none" }} onClick={copyInviteLink}>Copy</button>
            </div>
            <button className="btn btn-secondary" style={{ width: "100%", marginTop: 14 }} onClick={() => setInviteOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
