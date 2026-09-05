import { useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toast.jsx";
import { LANGUAGES } from "../languages.js";
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
// Contacts (save/select a number instead of retyping) and call recording are both
// explicitly deferred, planned follow-ups — not built here.
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
  const { showToast } = useToast();
  const [myPhone, setMyPhone] = useState(() => localStorage.getItem(MY_PHONE_KEY) || "");
  const [theirPhone, setTheirPhone] = useState("");
  const [myLang, setMyLang] = useState("en");
  const [theirLang, setTheirLang] = useState("es");
  const [captionsOn, setCaptionsOn] = useState(true);
  const [captionText, setCaptionText] = useState("");
  const [callActive, setCallActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [ending, setEnding] = useState(false);

  const callRef = useRef({ room: null, callASid: null, callBSid: null });
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
    const { callASid, callBSid } = callRef.current;
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
    callRef.current = { room: null, callASid: null, callBSid: null };
    setCallActive(false);
    setCaptionText("");
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

  async function startCall() {
    const a = normalizePhone(myPhone);
    const b = normalizePhone(theirPhone);
    if (!a || !b) {
      showToast("Enter both phone numbers first", 2500);
      return;
    }
    localStorage.setItem(MY_PHONE_KEY, myPhone.trim());
    setConnecting(true);
    try {
      const res = await fetch("/api/call/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyA: a, partyB: b, langA: myLang, langB: theirLang }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Could not start the call");
      callRef.current = { room: data.room, callASid: data.callASid, callBSid: data.callBSid };
      setCallActive(true);
      showToast("Calling both numbers…");
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

  return (
    <div className="ph-tab">
      {!callActive ? (
        <>
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
          </div>
          <label className="settings-checkbox">
            <input type="checkbox" checked={captionsOn} onChange={toggleCaptions} />
            Show live captions during the call
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
    </div>
  );
}
