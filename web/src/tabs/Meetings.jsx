import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, createLocalVideoTrack, createLocalAudioTrack, createLocalScreenTracks } from "livekit-client";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "👏", "🎉", "😮"];
import { ref, onValue, off, set, serverTimestamp } from "firebase/database";
import { auth, db } from "../firebase.js";
import { callTranslate } from "../api/translate.js";
import { useToast } from "../components/Toast.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { LANGUAGES } from "../languages.js";
import "./VideoCall.css";
import "./Meetings.css";
import Whiteboard from "../components/Whiteboard.jsx";

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
  // stage: "landing" | "creating" | "scheduled" | "preview" | "in-call" | "history"
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
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [pollPanelOpen, setPollPanelOpen] = useState(false);
  const [wbOpen, setWbOpen] = useState(false);
  const [wbUnseen, setWbUnseen] = useState(false); // someone drew while my board was closed
  const wbOpenRef = useRef(false);
  const wbLastKeyRef = useRef(undefined);
  const [polls, setPolls] = useState([]); // [{ id, question, options[], status, createdAt, createdBy, lang }]
  const [pollVotes, setPollVotes] = useState({}); // pollId -> { uid: optionIndex } (anonymous in the UI: counts only)
  const [pollTranslations, setPollTranslations] = useState({}); // `${pollId}|${lang}` -> { question, options[] }
  const [pollDraft, setPollDraft] = useState({ question: "", options: ["", ""] });
  const pollTranslationReqRef = useRef(new Set());
  const [scheduleInput, setScheduleInput] = useState("");
  const [scheduledInfo, setScheduledInfo] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState([]); // remote participant identities, for host controls
  const [recordingBanner, setRecordingBanner] = useState(null);
  const [isRecordingMine, setIsRecordingMine] = useState(false);
  const [pastMeetings, setPastMeetings] = useState([]);
  const [pastMeetingsLoading, setPastMeetingsLoading] = useState(false);
  const [expandedMeetingId, setExpandedMeetingId] = useState(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [lastRecordingMeeting, setLastRecordingMeeting] = useState(null);
  const [endBusy, setEndBusy] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [mutedMap, setMutedMap] = useState({}); // identity -> host-muted boolean, host panel only

  const gridRef = useRef(null);
  const livekitRoomRef = useRef(null);
  const screenTrackRef = useRef(null);
  const videoHeartbeatRef = useRef(null);
  const captionWsRef = useRef(null);
  const captionRecorderRef = useRef(null);
  const captionOffRef = useRef(null);
  const [captionLines, setCaptionLines] = useState([]); // Sept 23: visible caption strip
  const capHideTimerRef = useRef(null); // Sept 24: auto-hide CC bar after 6s of silence
  const [capStatus, setCapStatus] = useState({ listening: false, rx: 0 }); // Sept 24: on-screen CC status (phones have no devtools)
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

  // Polls: live listener on chats/{meetingId}/polls + pollVotes while in the call.
  // Votes are keyed by uid, so each person gets exactly one vote (changeable while
  // the poll is open). Tallies are computed client-side; nothing runs on the server.
  useEffect(() => {
    if (stage !== "in-call" || !meetingId) return undefined;
    const pollsRef = ref(db, `chats/${meetingId}/polls`);
    const votesRef = ref(db, `chats/${meetingId}/pollVotes`);
    const unsubPolls = onValue(
      pollsRef,
      (snap) => {
        const val = snap.val() || {};
        setPolls(Object.entries(val).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
      },
      (err) => console.error("[poll] listener error:", err),
    );
    const unsubVotes = onValue(
      votesRef,
      (snap) => setPollVotes(snap.val() || {}),
      (err) => console.error("[poll] votes listener error:", err),
    );
    return () => { unsubPolls(); unsubVotes(); setPolls([]); setPollVotes({}); };
  }, [stage, meetingId]);

  // Translate each poll into this viewer's caption language: one callTranslate per
  // poll per language (question + options joined by newlines), cached. If the line
  // count comes back different, fall back to the original text rather than misalign.
  useEffect(() => {
    polls.forEach((p) => {
      if (p.lang && p.lang === showLang) return;
      const key = `${p.id}|${showLang}`;
      if (pollTranslationReqRef.current.has(key)) return;
      pollTranslationReqRef.current.add(key);
      const opts = p.options || [];
      callTranslate([p.question, ...opts].join("\n"), "auto", showLang)
        .then((res) => {
          const lines = String(res.translation || "").split("\n").map((s) => s.trim()).filter(Boolean);
          if (lines.length !== 1 + opts.length) return;
          setPollTranslations((prev) => ({ ...prev, [key]: { question: lines[0], options: lines.slice(1) } }));
        })
        .catch((err) => console.error("[poll] translate failed:", err));
    });
  }, [polls, showLang]);
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
  function attachTrack(track, identity, isLocal, isScreen = false) {
    const grid = gridRef.current;
    if (!grid) return;
    let wrapper = grid.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "vc-tile" + (isScreen ? " vc-tile-screen" : "");
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
  function showCaption(identity, text, lineId) {
    const who = identity === user.email ? "You" : String(identity).split("@")[0];
    const id = lineId || Date.now() + Math.random();
    setCaptionLines((prev) =>
      prev.some((l) => l.id === id)
        ? prev.map((l) => (l.id === id ? { ...l, text } : l))
        : [...prev.slice(-1), { id, who, text }]
    );
    clearTimeout(capHideTimerRef.current);
    capHideTimerRef.current = setTimeout(() => setCaptionLines([]), 6000);
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
  function showReaction(identity, emoji) {
    const grid = gridRef.current;
    if (!grid) return;
    const wrapper = grid.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
    if (!wrapper) return;
    const el = document.createElement("div");
    el.className = "vc-tile-reaction";
    el.textContent = emoji;
    wrapper.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }
  // Pop the poll panel open for everyone when a new poll launches, so nobody misses it.
  const seenPollIdsRef = useRef(new Set());
  useEffect(() => {
    let fresh = false;
    polls.forEach((p) => {
      if (seenPollIdsRef.current.has(p.id)) return;
      seenPollIdsRef.current.add(p.id);
      if (p.status === "open") fresh = true;
    });
    if (fresh) setPollPanelOpen(true);
  }, [polls]);
  // Whiteboard activity dot: watch only the newest item (limitToLast(1)), so this
  // stays cheap even with a busy board, and flag it while the board is closed.
  useEffect(() => { wbOpenRef.current = wbOpen; if (wbOpen) setWbUnseen(false); }, [wbOpen]);
  useEffect(() => {
    if (stage !== "in-call" || !meetingId) return undefined;
    let unsub = () => {};
    let cancelled = false;
    wbLastKeyRef.current = undefined;
    import("firebase/database").then(({ query, limitToLast }) => {
      if (cancelled) return;
      unsub = onValue(query(ref(db, `chats/${meetingId}/whiteboard/items`), limitToLast(1)), (snap) => {
        let key = null;
        snap.forEach((c) => { key = c.key; });
        if (wbLastKeyRef.current === undefined) { wbLastKeyRef.current = key; return; }
        if (key && key !== wbLastKeyRef.current && !wbOpenRef.current) setWbUnseen(true);
        wbLastKeyRef.current = key;
      });
    });
    return () => { cancelled = true; unsub(); setWbOpen(false); setWbUnseen(false); };
  }, [stage, meetingId]);
  function pollText(p) {
    return pollTranslations[`${p.id}|${showLang}`] || { question: p.question, options: p.options || [] };
  }
  function pollTally(p) {
    const counts = (p.options || []).map(() => 0);
    Object.values(pollVotes[p.id] || {}).forEach((i) => { if (counts[i] !== undefined) counts[i] += 1; });
    return counts;
  }
  async function createPoll() {
    const question = pollDraft.question.trim();
    const options = pollDraft.options.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      showToast("A poll needs a question and at least 2 options.");
      return;
    }
    try {
      const { push } = await import("firebase/database");
      await push(ref(db, `chats/${meetingIdRef.current}/polls`), {
        question, options, status: "open", createdAt: serverTimestamp(), createdBy: user.email, lang: speakLangRef.current,
      });
      setPollDraft({ question: "", options: ["", ""] });
    } catch (err) {
      console.error("[poll] create failed:", err);
      showToast("Couldn't create the poll. Please try again.");
    }
  }
  function votePoll(pollId, optionIndex) {
    set(ref(db, `chats/${meetingIdRef.current}/pollVotes/${pollId}/${user.uid}`), optionIndex)
      .catch((err) => console.error("[poll] vote failed:", err));
  }
  function closePoll(pollId) {
    set(ref(db, `chats/${meetingIdRef.current}/polls/${pollId}/status`), "closed")
      .catch((err) => console.error("[poll] close failed:", err));
  }
  function sendReaction(emoji) {
    showReaction("You (local)", emoji);
    if (livekitRoomRef.current) {
      const payload = new TextEncoder().encode(JSON.stringify({ type: "reaction", emoji }));
      livekitRoomRef.current.localParticipant.publishData(payload, { reliable: true }).catch((err) =>
        console.error("[reaction] publishData failed:", err),
      );
    }
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
    // Sept 23 fix: was limitToLast(1) + onValue, which only ever saw the single newest
    // caption, so anything replaced before the listener fired was lost (host saw zero of a
    // joiner's 78 captions in test ftk-gkuc-tcj). Now: find the newest existing key, then
    // onChildAdded + startAfter(key) fires exactly once per NEW caption. No clock dependence.
    setCaptionLines([]);
    setCapStatus({ listening: false, rx: 0 });
    import("firebase/database").then(async ({ query, limitToLast, orderByKey, startAfter, onChildAdded, get }) => {
      const captionsRef = ref(db, `chats/${meetingId}/captions`);
      let capQuery = query(captionsRef, orderByKey());
      try {
        const snap = await get(query(captionsRef, limitToLast(1)));
        snap.forEach((c) => { capQuery = query(captionsRef, orderByKey(), startAfter(c.key)); });
      } catch (err) {
        console.error("[caption] history lookup failed:", err);
      }
      const unsub = onChildAdded(capQuery, (child) => {
        const msg = child.val();
        if (!msg) return;
        if (msg.from === user.email) { showCaption(msg.from, msg.text, child.key); return; } // own speech, untranslated (Zoom-style)
        console.log("[caption] rx", msg.from, msg.text);
        setCapStatus((s) => ({ ...s, rx: s.rx + 1 }));
        // Sept 24: show the original right away, then swap in the translation (8s cap), so a
        // slow or hung translate call can never leave the caption strip empty.
        const lineId = child.key;
        showCaption(msg.from, msg.text, lineId);
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("translate timeout")), 8000));
        Promise.race([callTranslate(msg.text, "auto", showLangRef.current, { purpose: "caption" }), timeout])
          .then((res) => showCaption(msg.from, (res && res.translation) || msg.text, lineId))
          .catch((err) => console.error("[caption] translate failed, keeping original:", err));
      }, (err) => console.error("[caption] listener error (permissions?):", err));
      captionOffRef.current = unsub;
      setCapStatus((s) => ({ ...s, listening: true }));
      console.log("[caption] listening on", meetingId);
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
    const scheduledForMs = scheduleInput ? new Date(scheduleInput).getTime() : null;
    if (scheduledForMs && scheduledForMs <= Date.now()) {
      showToast("Pick a time in the future to schedule a meeting", 3000);
      setStage("landing");
      return;
    }
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch("/api/meetings/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ title: titleInput.trim() || undefined, hostName: user.email, scheduledFor: scheduledForMs || undefined }),
      });
      const data = await res.json();
      if (data.error || !data.meetingId) throw new Error(data.error || "Could not create meeting");
      setMeetingId(data.meetingId);
      setIsHost(true);
      if (scheduledForMs) {
        setScheduledInfo({ scheduledFor: scheduledForMs });
        setStage("scheduled");
        return;
      }
      await joinCall(data.meetingId, true);
      setInviteOpen(true); // host lands straight in the call with the invite box open, ready to share
    } catch (e) {
      showToast("Could not create meeting: " + e.message, 3000);
      setStage("landing");
    }
  }
  async function startScheduledMeetingNow() {
    setStage("creating");
    try {
      await joinCall(meetingId, true);
      setInviteOpen(true);
    } catch (e) {
      showToast("Could not start meeting: " + e.message, 3000);
      setStage("scheduled");
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
      livekitRoom.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        const isScreen = pub.source === Track.Source.ScreenShare;
        attachTrack(track, isScreen ? `${participant.identity} (screen share)` : participant.identity, false, isScreen);
      });
      livekitRoom.on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
        const isScreen = pub.source === Track.Source.ScreenShare;
        removeTile(isScreen ? `${participant.identity} (screen share)` : participant.identity);
      });
      livekitRoom.on(RoomEvent.TrackMuted, (pub, participant) => {
        if (pub.source === Track.Source.Microphone) {
          setMutedMap((prev) => ({ ...prev, [participant.identity]: true }));
        }
      });
      livekitRoom.on(RoomEvent.TrackUnmuted, (pub, participant) => {
        if (pub.source === Track.Source.Microphone) {
          setMutedMap((prev) => ({ ...prev, [participant.identity]: false }));
        }
      });
      livekitRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        setParticipants((prev) => [...prev.filter((p) => p !== participant.identity), participant.identity]);
      });
      livekitRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeTile(participant.identity);
        removeTile(`${participant.identity} (screen share)`);
        setParticipants((prev) => prev.filter((p) => p !== participant.identity));
        setMutedMap((prev) => {
          const next = { ...prev };
          delete next[participant.identity];
          return next;
        });
      });
      livekitRoom.on(RoomEvent.DataReceived, (payload, participant) => {
        if (!participant) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg && msg.type === "reaction" && msg.emoji) {
            showReaction(participant.identity, msg.emoji);
          }
        } catch (err) {
          console.error("[reaction] bad data payload:", err);
        }
      });
      livekitRoom.on(RoomEvent.Disconnected, () => {
        if (!selfInitiatedDisconnectRef.current) {
          showToast("This meeting has ended", 4000);
        }
        selfInitiatedDisconnectRef.current = false;
        if (screenTrackRef.current) {
          screenTrackRef.current = null;
          setIsScreenSharing(false);
        }
        resetToLanding();
      });
      await livekitRoom.connect(url, token);
      setParticipants([...livekitRoom.remoteParticipants.keys()]);
      // Sept 24: camera/mic failures are non-fatal. A blocked camera used to throw here and the
      // catch disconnected the whole call ("Could not join"). Now each device is tried on its own,
      // whatever works gets published, and a toast says what's missing.
      let videoTrack = null;
      let audioTrack = null;
      try { videoTrack = await createLocalVideoTrack({ facingMode: "user" }); } catch (err) { console.warn("[join] camera unavailable:", err); }
      try { audioTrack = await createLocalAudioTrack(); } catch (err) { console.warn("[join] mic unavailable:", err); }
      if (audioTrack) recordingRef.current.localAudioTrack = audioTrack;
      if (videoTrack) await livekitRoom.localParticipant.publishTrack(videoTrack);
      if (audioTrack) await livekitRoom.localParticipant.publishTrack(audioTrack);
      if (videoTrack) attachTrack(videoTrack, "You (local)", true);
      if (!videoTrack || !audioTrack) {
        const missing = !videoTrack && !audioTrack ? "camera and mic" : !videoTrack ? "camera" : "mic";
        showToast(`Joined without ${missing} — check your browser's site permissions`, 6000);
      }
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
    if (screenTrackRef.current) await stopScreenShare();
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

  // ---- Screen share (Sept 14) ----
  async function startScreenShare() {
    if (isScreenSharing || !livekitRoomRef.current) return;
    try {
      const tracks = await createLocalScreenTracks({ audio: false });
      const screenTrack = tracks.find((t) => t.kind === "video");
      if (!screenTrack) throw new Error("No screen track captured");
      screenTrackRef.current = screenTrack;
      await livekitRoomRef.current.localParticipant.publishTrack(screenTrack, {
        source: Track.Source.ScreenShare,
      });
      attachTrack(screenTrack, "Your screen", true, true);
      setIsScreenSharing(true);
      const raw = screenTrack.mediaStreamTrack;
      if (raw) raw.addEventListener("ended", stopScreenShare, { once: true });
    } catch (e) {
      if (e?.name !== "NotAllowedError") {
        showToast("Could not start screen share: " + e.message, 3000);
      }
    }
  }
  async function stopScreenShare() {
    if (!screenTrackRef.current) return;
    const track = screenTrackRef.current;
    screenTrackRef.current = null;
    try {
      if (livekitRoomRef.current) {
        await livekitRoomRef.current.localParticipant.unpublishTrack(track, true);
      }
    } catch (e) {
      console.error("[screen share] unpublish failed:", e);
    } finally {
      try { track.stop(); } catch { /* already stopped */ }
    }
    removeTile("Your screen");
    setIsScreenSharing(false);
  }

  function resetToLanding() {
    setStage("landing");
    setMeetingId("");
    setPreviewInfo(null);
    setJoinCodeInput("");
    setTitleInput("");
    setIsHost(false);
    setParticipants([]);
    setMutedMap({});
    setScheduleInput("");
    setScheduledInfo(null);
  }
  async function openPastMeetings() {
    setStage("history");
    setExpandedMeetingId(null);
    setPastMeetingsLoading(true);
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch("/api/meetings", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load past meetings");
      setPastMeetings(data.meetings || []);
    } catch (e) {
      showToast("Could not load past meetings: " + e.message, 3000);
    }
    setPastMeetingsLoading(false);
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
  async function toggleMuteParticipant(identity) {
    const nextMuted = !mutedMap[identity];
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`/api/meetings/${meetingId}/mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ participantIdentity: identity, muted: nextMuted }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update mute state");
      setMutedMap((prev) => ({ ...prev, [identity]: data.muted }));
    } catch (e) {
      showToast("Could not mute/unmute: " + e.message, 3000);
    }
  }
  function inviteLink() {
    return `${window.location.origin}${window.location.pathname}?tab=meetings&meeting=${meetingId}`;
  }
  function copyInviteLink() {
    navigator.clipboard.writeText(inviteLink()).then(() => showToast("Invite link copied! Send it to anyone.", 3000));
  }

  // ---- Render ----
  // Sept 14 fix: this used to render via three separate conditional `return`
  // blocks keyed on `stage`. That meant the in-call block's .vc-grid div did
  // not exist in the DOM yet when joinCall() attached the local video/audio
  // track to gridRef (that attach runs before setStage("in-call") commits),
  // so the attach silently no-op'd and nobody ever saw their own camera
  // preview. Fix: always mount all three stage wrappers and toggle which one
  // is visible with CSS display:none — the same pattern VideoCall.jsx uses
  // for this exact reason.
  return (
    <>
      <div className="mt-landing" style={(stage === "landing" || stage === "creating") ? undefined : { display: "none" }}>
        <div className="mt-toprow">
          <span className="mt-title">🤝 Meetings</span>
          <div className="gc-account">
            <button className="gc-icon-btn" onClick={openPastMeetings}>📝 Past Meetings</button>
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
            <input
              type="datetime-local"
              className="mt-input"
              value={scheduleInput}
              onChange={(e) => setScheduleInput(e.target.value)}
              disabled={stage === "creating"}
              title="Optional: schedule this meeting for later instead of starting now"
            />
            <button className="btn btn-primary" onClick={createMeeting} disabled={stage === "creating"}>
              {stage === "creating" ? <span className="spinner" /> : scheduleInput ? "🗓️ Schedule Meeting" : "📹 New Meeting"}
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

      <div className="mt-landing" style={stage === "scheduled" ? undefined : { display: "none" }}>
        <div className="mt-landing-card">
          <div className="mt-landing-card-title">Meeting scheduled</div>
          <div className="mt-preview-sub">
            {scheduledInfo && `Starts ${new Date(scheduledInfo.scheduledFor).toLocaleString()}`}
          </div>
          <div className="gc-invite-row">
            <input readOnly className="gc-invite-input" value={inviteLink()} />
            <button className="btn btn-primary" style={{ flex: "none" }} onClick={copyInviteLink}>Copy</button>
          </div>
          <button className="btn btn-primary" onClick={startScheduledMeetingNow}>Start Meeting Now</button>
          <button className="btn btn-secondary" onClick={resetToLanding}>Back to Meetings</button>
        </div>
      </div>

      <div className="mt-landing" style={stage === "history" ? undefined : { display: "none" }}>
        <div className="mt-landing-card mt-history-card">
          <div className="mt-landing-card-title">Past Meetings</div>
          {pastMeetingsLoading && <span className="spinner" />}
          {!pastMeetingsLoading && pastMeetings.length === 0 && (
            <div className="mt-preview-sub">No ended meetings with notes yet.</div>
          )}
          {!pastMeetingsLoading && pastMeetings.map((m) => (
            <div className="mt-history-item" key={m.id}>
              <button
                type="button"
                className="mt-history-item-head"
                onClick={() => setExpandedMeetingId(expandedMeetingId === m.id ? null : m.id)}
              >
                <span>{m.title || "TalkBridge Meeting"}</span>
                <span className="mt-history-item-date">
                  {m.endedAt ? new Date(m.endedAt).toLocaleString() : ""}
                </span>
              </button>
              {expandedMeetingId === m.id && (
                <div className="mt-history-notes">
                  {!m.notes && <div className="mt-preview-sub">No notes generated for this meeting (no captions or polls were logged).</div>}
                  {m.notes && (
                    <>
                      <p>{m.notes.summary}</p>
                      {m.notes.key_points?.length > 0 && (
                        <>
                          <div className="mt-history-notes-label">Key points</div>
                          <ul>{m.notes.key_points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                        </>
                      )}
                      {m.notes.decisions?.length > 0 && (
                        <>
                          <div className="mt-history-notes-label">Decisions</div>
                          <ul>{m.notes.decisions.map((p, i) => <li key={i}>{p}</li>)}</ul>
                        </>
                      )}
                      {m.notes.action_items?.length > 0 && (
                        <>
                          <div className="mt-history-notes-label">Action items</div>
                          <ul>{m.notes.action_items.map((p, i) => <li key={i}>{p}</li>)}</ul>
                        </>
                      )}
                      {m.notes.polls?.length > 0 && (
                        <>
                          <div className="mt-history-notes-label">Polls</div>
                          {m.notes.polls.map((poll, i) => (
                            <div className="mt-poll" key={i} style={{ marginBottom: 10 }}>
                              <div className="mt-poll-question">
                                {poll.question}{" "}
                                <span className="mt-poll-opt-count">({poll.total} vote{poll.total === 1 ? "" : "s"})</span>
                              </div>
                              {(poll.options || []).map((o, j) => {
                                const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
                                return (
                                  <div className="mt-poll-opt" key={j} style={{ cursor: "default" }}>
                                    <span className="mt-poll-bar" style={{ width: `${pct}%` }} />
                                    <span className="mt-poll-opt-label">{o.text}</span>
                                    <span className="mt-poll-opt-count">{o.votes} · {pct}%</span>
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <button className="btn btn-secondary" onClick={resetToLanding}>Back to Meetings</button>
        </div>
      </div>

      <div className="mt-landing" style={stage === "preview" ? undefined : { display: "none" }}>
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
              {previewInfo.scheduledFor && !previewInfo.isHost && Date.now() < previewInfo.scheduledFor ? (
                <>
                  <div className="mt-preview-sub">
                    This meeting hasn't started yet — it's scheduled for {new Date(previewInfo.scheduledFor).toLocaleString()}.
                  </div>
                  <button className="btn btn-primary" onClick={() => previewMeeting(meetingId)} disabled={previewBusy}>
                    {previewBusy ? <span className="spinner" /> : "🔄 Check Again"}
                  </button>
                  <button className="btn btn-secondary" onClick={resetToLanding}>Leave</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" onClick={confirmJoin} disabled={connecting}>
                    {connecting ? <span className="spinner" /> : "Join Meeting"}
                  </button>
                  <button className="btn btn-secondary" onClick={resetToLanding} disabled={connecting}>Cancel</button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="vc-tab" style={stage === "in-call" ? undefined : { display: "none" }}>
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
          <button
            className={"gc-pill" + (isScreenSharing ? " gc-pill-accent" : "")}
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
          >
            {isScreenSharing ? "🛑 Stop Sharing" : "🖥️ Share Screen"}
          </button>
          <div className="vc-reaction-wrap">
            <button
              className={"gc-pill" + (reactionPickerOpen ? " gc-pill-accent" : "")}
              onClick={() => setReactionPickerOpen((v) => !v)}
            >
              😀 React
            </button>
            {reactionPickerOpen && (
              <div className="vc-reaction-picker">
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    className="vc-reaction-picker-btn"
                    onClick={() => { sendReaction(emoji); setReactionPickerOpen(false); }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={"gc-pill" + (wbOpen ? " gc-pill-accent" : "")}
            onClick={() => setWbOpen((v) => !v)}
          >
            🖍️ Whiteboard{wbUnseen ? " •" : ""}
          </button>
          <button
            className={"gc-pill" + (pollPanelOpen ? " gc-pill-accent" : "")}
            onClick={() => setPollPanelOpen((v) => !v)}
          >
            📊 Poll{polls.some((p) => p.status === "open") ? " •" : ""}
          </button>
          {isHost && (
            <button className="gc-pill mt-pill-danger" onClick={endMeetingForEveryone} disabled={endBusy}>
              {endBusy ? "…" : "⛔ End Meeting for Everyone"}
            </button>
          )}
        </div>
        {recordingBanner && (
          <div className="vc-recording-banner">🔴 This meeting is being recorded by {recordingBanner.startedBy}</div>
        )}
        {pollPanelOpen && (
          <div className="mt-poll-panel">
            <div className="mt-poll-panel-head">
              <span className="mt-host-panel-title">📊 Polls</span>
              <button className="btn btn-secondary mt-poll-small" onClick={() => setPollPanelOpen(false)}>Hide</button>
            </div>
            {isHost && (
              <div className="mt-poll-create">
                <input
                  className="gc-invite-input"
                  placeholder="Ask a question…"
                  maxLength={200}
                  value={pollDraft.question}
                  onChange={(e) => setPollDraft((d) => ({ ...d, question: e.target.value }))}
                />
                {pollDraft.options.map((opt, i) => (
                  <div className="mt-poll-option-row" key={i}>
                    <input
                      className="gc-invite-input"
                      placeholder={`Option ${i + 1}`}
                      maxLength={100}
                      value={opt}
                      onChange={(e) => setPollDraft((d) => ({ ...d, options: d.options.map((o, j) => (j === i ? e.target.value : o)) }))}
                    />
                    {pollDraft.options.length > 2 && (
                      <button
                        className="btn btn-secondary mt-poll-small"
                        onClick={() => setPollDraft((d) => ({ ...d, options: d.options.filter((_, j) => j !== i) }))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <div className="mt-poll-create-actions">
                  {pollDraft.options.length < 6 && (
                    <button className="btn btn-secondary mt-poll-small" onClick={() => setPollDraft((d) => ({ ...d, options: [...d.options, ""] }))}>
                      + Add option
                    </button>
                  )}
                  <button className="btn btn-primary mt-poll-small" onClick={createPoll}>Launch poll</button>
                </div>
              </div>
            )}
            {polls.length === 0 && (
              <div className="mt-preview-sub">{isHost ? "No polls yet. Create one above." : "No polls yet. The host can start one."}</div>
            )}
            {[...polls].reverse().map((p) => {
              const t = pollText(p);
              const counts = pollTally(p);
              const total = counts.reduce((a, b) => a + b, 0);
              const myVote = pollVotes[p.id]?.[user.uid];
              const open = p.status === "open";
              return (
                <div className="mt-poll" key={p.id}>
                  <div className="mt-poll-question">
                    {t.question}
                    {!open && <span className="mt-poll-closed-tag">Closed</span>}
                  </div>
                  {(p.options || []).map((orig, i) => {
                    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
                    return (
                      <button
                        type="button"
                        key={i}
                        className={"mt-poll-opt" + (myVote === i ? " mt-poll-opt-mine" : "")}
                        disabled={!open}
                        onClick={() => votePoll(p.id, i)}
                      >
                        <span className="mt-poll-bar" style={{ width: `${pct}%` }} />
                        <span className="mt-poll-opt-label">{myVote === i ? "✓ " : ""}{t.options[i] ?? orig}</span>
                        <span className="mt-poll-opt-count">{counts[i]} · {pct}%</span>
                      </button>
                    );
                  })}
                  <div className="mt-poll-footer">
                    <span>{total} vote{total === 1 ? "" : "s"}{open ? " · tap to vote or change your vote" : ""}</span>
                    {isHost && open && (
                      <button className="btn btn-secondary mt-poll-small" onClick={() => closePoll(p.id)}>Close poll</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {wbOpen && <Whiteboard meetingId={meetingId} user={user} isHost={isHost} showLang={showLang} speakLang={speakLang} />}
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
        {callActive && (
          <div className="mt-caption-status" style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0" }}>
            CC {capStatus.listening ? "listening" : "starting…"} · {capStatus.rx} received
          </div>
        )}
        {captionLines.length > 0 && (
          <div className="mt-caption-strip" style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 1000, maxWidth: 820, margin: "0 auto", padding: "6px 12px", background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: 8, fontSize: "clamp(13px, 3.6vw, 16px)", lineHeight: 1.3, textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "none" }}>
            {captionLines.map((c) => (
              <div key={c.id}><strong>{c.who}:</strong> {c.text}</div>
            ))}
          </div>
        )}
        <div className="mt-inroom">
          <div className="vc-grid" ref={gridRef} style={{ display: "flex" }} />
          {isHost && participants.length > 0 && (
            <div className="mt-host-panel">
              <div className="mt-host-panel-title">Participants ({participants.length})</div>
              {participants.map((identity) => (
                <div className="mt-host-participant" key={identity}>
                  <span>{mutedMap[identity] ? "🔇 " : ""}{identity}</span>
                  <button className="btn btn-secondary mt-host-remove" onClick={() => toggleMuteParticipant(identity)}>
                    {mutedMap[identity] ? "Unmute" : "Mute"}
                  </button>
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
    </>
  );
}
