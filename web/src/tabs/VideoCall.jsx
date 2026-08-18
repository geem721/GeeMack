import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, createLocalVideoTrack, createLocalAudioTrack } from "livekit-client";
import { ref, push, onValue, off, query, limitToLast, serverTimestamp } from "firebase/database";
import { db } from "../firebase.js";
import { callTranslate } from "../api/translate.js";
import { useToast } from "../components/Toast.jsx";
import AuthGate from "../components/AuthGate.jsx";
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
// Deliberately NOT included this session: call recording. MIGRATION_PLAN.md calls this
// out as **new** functionality ("record the video call itself, not just mic audio") —
// it never existed in any live version of this app, legacy or otherwise, so deferring it
// doesn't regress anything a real user currently has. Doing it properly needs a canvas
// compositor (draw every participant's video tile onto a canvas each frame) plus a
// WebAudio mix of every participant's audio track into one MediaRecorder-able stream —
// a genuinely separate, non-trivial piece of work. Flagged here explicitly, not silently
// dropped; see PROJECT_LOG.md for the same note.
//
// Video/audio track handling below stays imperative (direct DOM manipulation via
// gridRef, mirroring public/index.html's attachTrack/showCaption) rather than modeling
// each tile as declarative React state — LiveKit hands back raw MediaStreamTrack-like
// objects with their own attach()/detach() lifecycle that doesn't map cleanly onto
// props/state, and CameraOCR.jsx already established the same imperative-video-element
// pattern for the same reason (a real <video> tag's srcObject isn't something React
// should own).
export default function VideoCall({ initialRoom }) {
  return (
    <AuthGate featureName="Video Call">
      {(user, signOutUser) => (
        <VideoCallPanel user={user} onSignOut={signOutUser} initialRoom={initialRoom} />
      )}
    </AuthGate>
  );
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

  const gridRef = useRef(null);
  const livekitRoomRef = useRef(null);
  const captionWsRef = useRef(null);
  const captionRecorderRef = useRef(null);
  const captionOffRef = useRef(null);
  const speakLangRef = useRef(speakLang);
  const showLangRef = useRef(showLang);
  const roomRef = useRef(room);

  useEffect(() => {
    speakLangRef.current = speakLang;
  }, [speakLang]);
  useEffect(() => {
    showLangRef.current = showLang;
  }, [showLang]);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // Leave the call on unmount (tab switch) or if the room changes mid-call, so nobody's
  // camera/mic keeps streaming after they've navigated away.
  useEffect(() => {
    return () => {
      leaveCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      el.play().catch((err) => console.error("[video] play() failed for", identity, err));
    } else if (track.kind === "audio") {
      const el = track.attach();
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
    capDiv._hideTimer = setTimeout(() => {
      capDiv.textContent = "";
    }, 6000);
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
            push(captionsRef, { from: user.email, text: data.text, ts: serverTimestamp() });
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
      snapshot.forEach((child) => {
        const msg = child.val();
        if (!msg || msg.from === user.email) return;
        callTranslate(msg.text, "auto", showLangRef.current)
          .then((res) => showCaption(msg.from, res.translation || msg.text))
          .catch(() => showCaption(msg.from, msg.text));
      });
    };
    onValue(capQuery, handler);
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
    if (livekitRoomRef.current) {
      await livekitRoomRef.current.disconnect().catch(() => {});
      livekitRoomRef.current = null;
    }
    stopCaptionStream();
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
        <button className="gc-pill gc-pill-accent" onClick={() => setInviteOpen(true)}>
          ✉️ Invite
        </button>
      </div>

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

      {callActive && <div className="vc-grid" ref={gridRef} />}
      {!callActive && (
        <div className="vc-empty">Join a call to see video tiles and live translated captions here.</div>
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
