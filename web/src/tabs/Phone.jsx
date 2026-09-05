import { useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toast.jsx";
import Modal from "../components/Modal.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { useContacts } from "../hooks/useContacts.js";
import { LANGUAGES, languageLabel } from "../languages.js";
import "./Phone.css";

// Phone tab — real PSTN phone calls with live speech translation, built on top of the
// Twilio Media Streams pipeline already in server.js: TalkBridge places two outbound
// legs (the app user's own phone as leg A, the other party's phone as leg B) and bridges
// them, transcribing each leg with Deepgram, translating with Claude, and speaking the
// translation into the other leg via speakToLeg's provider router (Deepgram Aura /
// ElevenLabs / Google Cloud TTS depending on the target language).
//
// Unlike Video Call, captioning here is NOT client-driven — the server already knows
// both legs and does the translation itself, so it just broadcasts the translated text
// over /ws/call-captions?room=... whenever leg B's speech is translated for leg A (i.e.
// only on the side the app user is actually listening on, per the "listening side only"
// caption decision). The client just subscribes and shows the latest line — it doesn't
// run its own translate pipeline the way VideoCall.jsx does for group calls.
//
// Contacts: saved to Firebase under contacts/{uid}, same database Group Chat/Video Call
// already use — see hooks/useContacts.js. Tapping a contact fills in their number and
// language; "Save as contact" stores whatever's currently entered.
//
// Recording (this session): opt-in per call, default OFF. When enabled, /api/call/bridge
// threads record=1 into each leg's stream-twiml URL; server.js plays an audible consent
// notice to both parties before connecting the stream (two-party consent laws), captures
// both legs' raw audio to disk, and mixes them into one stereo WAV (leg A left channel,
// leg B right channel) via ffmpeg once both legs disconnect. Files land in
// ~/GeeMack/recordings/ on Apollo1 — not Firebase Storage, to avoid a second storage
// vendor. This tab just shows a download link for the most recently recorded call.
const MY_PHONE_KEY = "tb_my_phone";

function normalizePhone(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let digits = trimmed.replace(/[^\d+]/g, "");
  if (!digits.startsWith("+")) {
    // Bare 10-digit input is assumed US/Canada; anything longer is assumed to already
    // include a country code and just needs the leading +. Not a full phone-parsing
    // library — good enough for the numbers this app actually dials (see V1 scope:
    // US/Canada, UK/Germany/France, Japan/South Korea).
    digits = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  }
  return digits;
}

export default function Phone() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const { contacts, addContact, deleteContact } = useContacts(user?.uid);

  const [myPhone, setMyPhone] = useState(() => localStorage.getItem(MY_PHONE_KEY) || "");
  const [theirPhone, setTheirPhone] = useState("");
  const [myLang, setMyLang] = useState("en");
  const [theirLang, setTheirLang] = useState("es");
  const [captionsOn, setCaptionsOn] = useState(true);
  const [recordOn, setRecordOn] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const [callActive, setCallActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [newContactName, setNewContactName] = useState("");
  const [lastRecordingRoom, setLastRecordingRoom] = useState(null);
  const [recordingReady, setRecordingReady] = useState(false);

  const callRef = useRef({ room: null, callASid: null, callBSid: null, recorded: false });
  const captionWsRef = useRef(null);

  function connectCaptions(room) {
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws/call-captions?room=${room}`);
    captionWsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "caption" && data.text) setCaptionText(data.text);
      } catch (err) {
        console.error("[phone] bad caption payload:", err);
      }
    };
    ws.onerror = (e) => console.error("[phone] captions WS error:", e);
  }

  function disconnectCaptions() {
    if (captionWsRef.current) {
      captionWsRef.current.close();
      captionWsRef.current = null;
    }
  }

  async function endCallInternal() {
    const { callASid, callBSid, room, recorded } = callRef.current;
    if (!callASid && !callBSid) return;
    try {
      await fetch("/api/call/hangup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callASid, callBSid }),
      });
    } catch (err) {
      console.error("[phone] hangup request failed:", err);
    }
    disconnectCaptions();
    callRef.current = { room: null, callASid: null, callBSid: null, recorded: false };
    setCallActive(false);
    setCaptionText("");
    // The server mixes both legs into one file once they've both disconnected — that
    // happens right as this hangup completes, so the file is normally ready within a
    // second or two. The download link just points at /api/call/recording/{room};
    // clicking it before the mix finishes shows the server's "still processing" message
    // rather than failing silently.
    if (recorded && room) {
      setLastRecordingRoom(room);
    }
  }

  // End the call on unmount (tab switch) — mirrors VideoCall.jsx's cleanup. A real phone
  // call racks up per-minute Twilio + TTS costs, so it shouldn't keep running just
  // because the user navigated to another tab.
  useEffect(() => {
    return () => {
      endCallInternal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once a recorded call ends, quietly poll the download endpoint (HEAD, no body) until
  // ffmpeg has actually finished mixing the two legs — rather than showing a download
  // link that might 404 for the second or two the mix takes. Gives up after ~20s and
  // shows the link anyway (better than never showing it for an unusually long call).
  useEffect(() => {
    if (!lastRecordingRoom) {
      setRecordingReady(false);
      return;
    }
    setRecordingReady(false);
    let cancelled = false;
    let attempts = 0;
    let timer = null;
    const check = async () => {
      attempts += 1;
      try {
        const res = await fetch(`/api/call/recording/${lastRecordingRoom}`, { method: "HEAD" });
        if (res.ok) {
          if (!cancelled) setRecordingReady(true);
          return;
        }
      } catch (err) {
        // network hiccup — just retry on the next tick
      }
      if (!cancelled && attempts < 20) {
        timer = setTimeout(check, 1000);
      } else if (!cancelled) {
        setRecordingReady(true); // give up waiting, show the link anyway
      }
    };
    timer = setTimeout(check, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lastRecordingRoom]);

  async function startCall() {
    const a = normalizePhone(myPhone);
    const b = normalizePhone(theirPhone);
    if (!a || !b) {
      showToast("Enter both phone numbers first", 2500);
      return;
    }
    localStorage.setItem(MY_PHONE_KEY, myPhone.trim());
    setLastRecordingRoom(null);
    setConnecting(true);
    try {
      const res = await fetch("/api/call/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyA: a, partyB: b, langA: myLang, langB: theirLang, record: recordOn }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Could not start the call");
      callRef.current = { room: data.room, callASid: data.callASid, callBSid: data.callBSid, recorded: recordOn };
      setCallActive(true);
      showToast(recordOn ? "Calling both numbers… a recording notice will play for both parties." : "Calling both numbers…");
      if (captionsOn) connectCaptions(data.room);
    } catch (err) {
      console.error("[phone] bridge error:", err);
      showToast("Could not start call: " + err.message, 3500);
    }
    setConnecting(false);
  }

  async function hangup() {
    setEnding(true);
    await endCallInternal();
    setEnding(false);
    showToast("Call ended");
  }

  function toggleCaptions() {
    const next = !captionsOn;
    setCaptionsOn(next);
    if (!callActive) return;
    if (next) {
      connectCaptions(callRef.current.room);
    } else {
      disconnectCaptions();
      setCaptionText("");
    }
  }

  function selectContact(c) {
    setTheirPhone(c.phone);
    if (c.lang) setTheirLang(c.lang);
    showToast(`Selected ${c.name}`, 1500);
  }

  async function saveContact() {
    const phone = normalizePhone(theirPhone);
    const name = newContactName.trim();
    if (!phone || !name) return;
    try {
      await addContact({ name, phone, lang: theirLang });
      showToast("Contact saved");
      setSavingContact(false);
      setNewContactName("");
    } catch (err) {
      console.error("[phone] save contact failed:", err);
      showToast("Could not save contact: " + err.message, 3000);
    }
  }

  return (
    <div className="ph-tab">
      {!callActive ? (
        <>
          {contacts.length > 0 && (
            <div className="ph-contacts">
              <div className="settings-title">Contacts</div>
              <div className="ph-contact-list">
                {contacts.map((c) => (
                  <div key={c.id} className="ph-contact-chip" onClick={() => selectContact(c)}>
                    <span className="ph-contact-name">{c.name}</span>
                    {c.lang && <span className="ph-contact-lang">{languageLabel(c.lang)}</span>}
                    <button
                      className="ph-contact-del"
                      title="Delete contact"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteContact(c.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {lastRecordingRoom && (
            recordingReady ? (
              <a
                className="ph-recording-link"
                href={`/api/call/recording/${lastRecordingRoom}`}
                target="_blank"
                rel="noreferrer"
              >
                🎙️ Download last call's recording
              </a>
            ) : (
              <div className="ph-recording-link ph-recording-pending">
                <span className="spinner" /> Processing recording…
              </div>
            )
          )}
          <div className="quick-settings">
            <div className="settings-title">Your phone</div>
            <input
              className="ph-input"
              type="tel"
              placeholder="Your phone number"
              value={myPhone}
              onChange={(e) => setMyPhone(e.target.value)}
              disabled={connecting}
            />
            <div className="lang-bar">
              <select className="lang-sel" value={myLang} onChange={(e) => setMyLang(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.label}
                  </option>
                ))}
              </select>
              <span className="gc-lang-caption">you speak</span>
            </div>
          </div>
          <div className="quick-settings">
            <div className="settings-title">Call this number</div>
            <input
              className="ph-input"
              type="tel"
              placeholder="Their phone number"
              value={theirPhone}
              onChange={(e) => setTheirPhone(e.target.value)}
              disabled={connecting}
            />
            <div className="lang-bar">
              <select
                className="lang-sel"
                value={theirLang}
                onChange={(e) => setTheirLang(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.label}
                  </option>
                ))}
              </select>
              <span className="gc-lang-caption">they speak</span>
            </div>
            <button
              className="btn btn-secondary ph-save-contact-btn"
              onClick={() => setSavingContact(true)}
              disabled={!theirPhone.trim()}
            >
              💾 Save as contact
            </button>
          </div>
          <label className="settings-checkbox">
            <input type="checkbox" checked={captionsOn} onChange={toggleCaptions} />
            Show live captions during the call
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={recordOn}
              onChange={(e) => setRecordOn(e.target.checked)}
              disabled={connecting}
            />
            🎙️ Record this call (both parties will hear a notice)
          </label>
          <button className="btn btn-primary ph-call-btn" onClick={startCall} disabled={connecting}>
            {connecting ? <span className="spinner" /> : "📞 Start Call"}
          </button>
        </>
      ) : (
        <div className="ph-active">
          <div className="ph-active-title">📞 Call in progress</div>
          <div className="ph-active-sub">
            {myPhone} ↔ {theirPhone}
          </div>
          {callRef.current.recorded && <div className="ph-recording-badge">🎙️ Recording</div>}
          <label className="settings-checkbox ph-caption-toggle">
            <input type="checkbox" checked={captionsOn} onChange={toggleCaptions} />
            Live captions
          </label>
          {captionsOn && (
            <div className="ph-caption-box">
              {captionText || (
                <span className="placeholder">
                  Captions will appear here as the other person speaks…
                </span>
              )}
            </div>
          )}
          <button className="btn-danger ph-hangup-btn" onClick={hangup} disabled={ending}>
            {ending ? <span className="spinner" /> : "🔴 End Call"}
          </button>
        </div>
      )}
      {savingContact && (
        <Modal
          title="Save contact"
          meta={`${theirPhone} — ${languageLabel(theirLang)}`}
          onClose={() => setSavingContact(false)}
        >
          <input
            className="ph-input"
            type="text"
            placeholder="Contact name"
            value={newContactName}
            onChange={(e) => setNewContactName(e.target.value)}
            autoFocus
          />
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            disabled={!newContactName.trim()}
            onClick={saveContact}
          >
            Save
          </button>
        </Modal>
      )}
    </div>
  );
}
