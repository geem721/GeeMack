import { useCallback, useEffect, useRef, useState } from "react";
import {
  ref,
  push,
  onValue,
  off,
  query,
  limitToLast,
  serverTimestamp,
  set,
  onDisconnect,
  get,
} from "firebase/database";
import { db } from "../firebase.js";
import { callTranslate } from "../api/translate.js";
import { useToast } from "../components/Toast.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { LANGUAGES } from "../languages.js";
import { ROOMS } from "../rooms.js";
import "./GroupChat.css";
// Phase 4 of MIGRATION_PLAN.md. Feature-parity target: public/index.html's Group Chat
// panel (Firebase Realtime Database rooms, presence, invite links, per-message live
// translation). Room list (rooms.js) is shared with Video Call (Phase 5), which also
// uses the room concept for its own invite links and Firebase captions path.
//
// Transcript export (added this session): unlike Phone's recording (opt-in, mixed audio
// captured server-side per call), Group Chat's "recording" is already sitting in Firebase
// as the message history — so this is just a client-side export button. Pulls the FULL
// room history with a one-time get() (not the limitToLast(50) the live feed uses), formats
// it as a plain-text log, and triggers a browser download. No server changes needed.
export default function GroupChat({ initialRoom }) {
  const { user, signOutUser } = useAuth();
  return <GroupChatPanel user={user} onSignOut={signOutUser} initialRoom={initialRoom} />;
}
function GroupChatPanel({ user, onSignOut, initialRoom }) {
  const { showToast } = useToast();
  const [room, setRoom] = useState(
    initialRoom && ROOMS.includes(initialRoom) ? initialRoom : "general",
  );
  const [messages, setMessages] = useState(null); // null = loading, [] = empty room
  const [translations, setTranslations] = useState({}); // { [msgId]: { [tgtLang]: text } }
  const [presence, setPresence] = useState([]); // [{ email, online }]
  const [srcLang, setSrcLang] = useState("en");
  const [tgtLang, setTgtLang] = useState("en");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const feedRef = useRef(null);
  const pendingTranslations = useRef(new Set());
  // ── Messages + presence + join event, re-subscribed on room change ────────────────
  useEffect(() => {
    setMessages(null);
    setTranslations({});
    pendingTranslations.current.clear();
    const msgsRef = ref(db, `chats/${room}/messages`);
    const msgsQuery = query(msgsRef, limitToLast(50));
    const handleMessages = (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        setMessages([]);
        return;
      }
      const list = Object.entries(data)
        .map(([id, msg]) => ({ id, ...msg }))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      setMessages(list);
    };
    onValue(msgsQuery, handleMessages);
    const presenceRef = ref(db, `chats/${room}/presence`);
    const handlePresence = (snapshot) => {
      const data = snapshot.val() || {};
      setPresence(Object.values(data).filter((u) => u.online));
    };
    onValue(presenceRef, handlePresence);
    const myPresenceRef = ref(db, `chats/${room}/presence/${user.uid}`);
    set(myPresenceRef, { email: user.email, online: true, lastSeen: serverTimestamp() });
    const disconnectHandle = onDisconnect(myPresenceRef);
    disconnectHandle.update({ online: false, lastSeen: serverTimestamp() });
    push(msgsRef, { type: "join", uid: user.uid, email: user.email, timestamp: serverTimestamp() }).catch(
      (e) => console.warn("Join event failed:", e),
    );
    return () => {
      off(msgsQuery, "value", handleMessages);
      off(presenceRef, "value", handlePresence);
      disconnectHandle.cancel().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, user.uid]);
  // Auto-scroll to newest message.
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages]);
  // ── Per-message translation, lazily fetched as messages/target language change ────
  useEffect(() => {
    if (!messages) return;
    for (const msg of messages) {
      if (msg.type === "join" || msg.uid === user.uid) continue;
      const srcOfMsg = msg.lang || "en";
      if (srcOfMsg === tgtLang) continue; // same language — nothing to translate
      if (translations[msg.id]?.[tgtLang]) continue; // already have it
      const pendingKey = `${msg.id}:${tgtLang}`;
      if (pendingTranslations.current.has(pendingKey)) continue;
      pendingTranslations.current.add(pendingKey);
      callTranslate(msg.text, srcOfMsg, tgtLang)
        .then((res) => {
          setTranslations((prev) => ({
            ...prev,
            [msg.id]: { ...prev[msg.id], [tgtLang]: res.translation },
          }));
        })
        .catch(() => {
          setTranslations((prev) => ({
            ...prev,
            [msg.id]: { ...prev[msg.id], [tgtLang]: null },
          }));
        })
        .finally(() => pendingTranslations.current.delete(pendingKey));
    }
  }, [messages, tgtLang, user.uid, translations]);
  const switchRoom = useCallback((r) => {
    setRoom(r);
    setInviteOpen(false);
    setPresenceOpen(false);
  }, []);
  async function sendMessage(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    try {
      const msgsRef = ref(db, `chats/${room}/messages`);
      await push(msgsRef, {
        text,
        uid: user.uid,
        email: user.email,
        lang: srcLang,
        timestamp: serverTimestamp(),
      });
    } catch (e2) {
      showToast("Send failed: " + e2.message, 3000);
      setInput(text);
    }
    setSending(false);
  }
  function copyInviteLink() {
    const link = `${window.location.origin}${window.location.pathname}?room=${room}`;
    navigator.clipboard
      .writeText(link)
      .then(() => showToast("Invite link copied! Send it to anyone.", 3000));
  }
  // Pulls the FULL message history for the room (not the capped 50 in the live feed),
  // formats it as a plain-text log, and triggers a browser download. One-time read — no
  // subscription, no server involvement, since the data's already in Firebase.
  async function downloadTranscript() {
    if (exporting) return;
    setExporting(true);
    try {
      const msgsRef = ref(db, `chats/${room}/messages`);
      const snapshot = await get(msgsRef);
      const data = snapshot.val();
      if (!data) {
        showToast("No messages to export yet", 2500);
        return;
      }
      const list = Object.values(data).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const lines = list.map((msg) => {
        const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : "";
        if (msg.type === "join") {
          return `[${ts}] -- ${msg.email || "Someone"} joined #${room} --`;
        }
        return `[${ts}] ${msg.email || "Anonymous"}: ${msg.text || ""}`;
      });
      const header = `Transcript for #${room}\nExported ${new Date().toLocaleString()}\n${"=".repeat(40)}\n\n`;
      const text = header + lines.join("\n") + "\n";
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${room}-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showToast(`Exported ${list.length} messages`, 2500);
    } catch (e) {
      showToast("Export failed: " + e.message, 3000);
    }
    setExporting(false);
  }
  return (
    <div className="gc-tab">
      <div className="gc-toprow">
        <div className="gc-room-picker">
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
        <div className="gc-presence-wrap">
          <button className="gc-pill gc-pill-online" onClick={() => setPresenceOpen((v) => !v)}>
            👥 {presence.length} online
          </button>
          {presenceOpen && (
            <div className="gc-presence-popover">
              <div className="gc-presence-popover-title">Online now</div>
              {presence.length === 0 && <div className="gc-presence-empty">Just you, for now.</div>}
              {presence.map((u, i) => (
                <div key={i} className="gc-presence-row">
                  <span className="gc-presence-dot" />
                  <span>{u.email || "Unknown"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="gc-pill" onClick={downloadTranscript} disabled={exporting}>
          {exporting ? "Exporting…" : "📄 Export transcript"}
        </button>
        <button className="gc-pill gc-pill-accent" onClick={() => setInviteOpen(true)}>
          ✉️ Invite
        </button>
      </div>
      <div className="lang-bar gc-lang-bar">
        <select className="lang-sel" value={srcLang} onChange={(e) => setSrcLang(e.target.value)}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>
        <span className="gc-lang-caption">I write in</span>
        <select className="lang-sel" value={tgtLang} onChange={(e) => setTgtLang(e.target.value)}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>
        <span className="gc-lang-caption">show me</span>
      </div>
      <div className="gc-feed" ref={feedRef}>
        {messages === null && <div className="gc-feed-status">Loading…</div>}
        {messages && messages.length === 0 && (
          <div className="gc-feed-status">No messages yet — say hello!</div>
        )}
        {messages &&
          messages.map((msg) =>
            msg.type === "join" ? (
              <div key={msg.id} className="gc-system-msg">
                🟢 {msg.email || "Someone"} joined #{room}
              </div>
            ) : (
              <ChatBubble
                key={msg.id}
                msg={msg}
                isOwn={msg.uid === user.uid}
                translated={translations[msg.id]?.[tgtLang]}
                sameLang={(msg.lang || "en") === tgtLang}
              />
            ),
          )}
      </div>
      <form className="gc-input-row" onSubmit={sendMessage}>
        <input
          className="gc-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Message #${room}…`}
        />
        <button className="btn btn-primary" type="submit" disabled={sending || !input.trim()}>
          {sending ? <span className="spinner" /> : "Send"}
        </button>
      </form>
      {inviteOpen && (
        <div className="gc-invite-backdrop" onClick={(e) => e.target === e.currentTarget && setInviteOpen(false)}>
          <div className="gc-invite-box">
            <div className="gc-invite-title">Invite to #{room}</div>
            <div className="gc-invite-sub">Share this link — anyone with it can join the room</div>
            <div className="gc-invite-row">
              <input
                readOnly
                className="gc-invite-input"
                value={`${window.location.origin}${window.location.pathname}?room=${room}`}
              />
              <button className="btn btn-primary" style={{ flex: "none" }} onClick={copyInviteLink}>
                Copy
              </button>
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
function ChatBubble({ msg, isOwn, translated, sameLang }) {
  const timeStr = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <div className={"gc-bubble-row" + (isOwn ? " own" : "")}>
      <div className={"gc-msg-wrap" + (isOwn ? " own" : "")}>
        <span className="gc-msg-name">{msg.email || "Anonymous"}</span>
        <span className="gc-msg-bubble">{msg.text}</span>
        {timeStr && <span className="gc-msg-time">{timeStr}</span>}
        {!isOwn && !sameLang && (
          <span className="gc-msg-translated">
            {translated === undefined ? "🌐 translating…" : translated === null ? "" : `🌐 ${translated}`}
          </span>
        )}
      </div>
    </div>
  );
}
