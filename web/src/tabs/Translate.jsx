import { useEffect, useRef, useState } from "react";
import { AUTO_DETECT, LANGUAGES, languageLabel } from "../languages.js";
import { useToast } from "../components/Toast.jsx";
import Modal from "../components/Modal.jsx";
import { useTranslationHistory } from "../hooks/useTranslationHistory.js";
import { useSettings } from "../hooks/useSettings.jsx";
import { callTranslate } from "../api/translate.js";
import { SPEECH_LANG_MAP, speakWithCheck as speakWithTtsCheck } from "../utils/speech.js";
import "./Translate.css";

export default function Translate() {
  const { showToast } = useToast();
  const { addEntry } = useTranslationHistory();

  const [srcLang, setSrcLang] = useState("auto");
  const [tgtLang, setTgtLang] = useState("es");
  const [srcText, setSrcText] = useState("");
  const [result, setResult] = useState(null); // { translation, detected, detectedName }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [audioWarning, setAudioWarning] = useState(null); // { label, onProceed } | null

  // Shared, persisted behavior settings — see useSettings.jsx / Settings.jsx. These
  // three used to live here as local, unpersisted state (Settings tab didn't exist yet);
  // now Settings.jsx is the only place that writes them, this just reads.
  const { settings } = useSettings();
  const { autoTranslate, saveHistory, extendedListen } = settings;

  const lastTranslatedRef = useRef("");
  const debounceRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(
    () => () => {
      clearTimeout(debounceRef.current);
      recognitionRef.current?.stop();
    },
    [],
  );

  async function doTranslate(overrideText) {
    const text = (overrideText ?? srcText).trim();
    if (!text) {
      showToast("Please enter text");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await callTranslate(text, srcLang, tgtLang);
      lastTranslatedRef.current = text;
      setResult(data);
      if (saveHistory) {
        addEntry({
          srcLang: data.detected || srcLang,
          srcName: data.detectedName || languageLabel(srcLang),
          tgtLang,
          tgtName: languageLabel(tgtLang),
          original: text,
          translated: data.translation,
          mode: "text",
        });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function handleTextInput(value) {
    setSrcText(value);
    if (!autoTranslate) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = value.trim();
      if (trimmed && trimmed !== lastTranslatedRef.current) doTranslate(trimmed);
    }, 1500);
  }

  function swapLangs() {
    if (srcLang === "auto") {
      showToast("Can't swap Auto-Detect");
      return;
    }
    setSrcLang(tgtLang);
    setTgtLang(srcLang);
  }

  function clearAll() {
    setSrcText("");
    setResult(null);
    setError(null);
    lastTranslatedRef.current = "";
  }

  function copyResult() {
    if (!result?.translation) return;
    navigator.clipboard.writeText(result.translation).then(() => showToast("Copied!"));
  }

  function handleSpeak(text, langCode, langLabelText) {
    const outcome = speakWithTtsCheck(text, langCode, {
      onWarn: (proceed) =>
        setAudioWarning({
          label: langLabelText,
          onProceed: () => {
            proceed();
            showToast("Speaking…");
          },
        }),
    });
    if (outcome === "unsupported") showToast("TTS not supported");
    else if (outcome === "empty") showToast("Nothing to speak");
    else if (outcome === "spoke") showToast("Speaking…");
  }

  function speakResult() {
    if (!result?.translation) {
      showToast("Nothing to speak");
      return;
    }
    handleSpeak(result.translation, tgtLang, languageLabel(tgtLang));
  }

  function openFullScreen() {
    if (!result?.translation) {
      showToast("Nothing to display yet");
      return;
    }
    setFullScreenOpen(true);
  }

  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      showToast("Speech recognition not supported");
      return;
    }
    if (isRecording) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = SPEECH_LANG_MAP[srcLang] || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    let finalTranscript = "";
    let silenceTimer = null;
    const silenceMs = extendedListen ? 3000 : 1500;

    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      setSrcText((finalTranscript + interim).trim());
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => recognition.stop(), silenceMs);
    };
    recognition.onerror = (e) => {
      showToast("Mic error: " + e.error);
      setIsRecording(false);
    };
    recognition.onend = () => {
      setIsRecording(false);
      clearTimeout(silenceTimer);
      setSrcText((current) => {
        const trimmed = current.trim();
        if (trimmed) doTranslate(trimmed);
        return current;
      });
    };
    recognition.start();
    setIsRecording(true);
    showToast(extendedListen ? "Listening (extended)…" : "Listening…", 3000);
  }

  const detectedLabel =
    srcLang === "auto" && result?.detectedName ? `⚡ Detected: ${result.detectedName}` : "";

  return (
    <div className="translate-tab">
      <div className="lang-bar">
        <select
          className="lang-sel"
          value={srcLang}
          onChange={(e) => {
            setSrcLang(e.target.value);
            setResult(null);
          }}
        >
          <option value={AUTO_DETECT.code}>
            {AUTO_DETECT.flag} {AUTO_DETECT.label}
          </option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>
        <button className="swap-btn" onClick={swapLangs} title="Swap languages">
          ⇄
        </button>
        <select className="lang-sel" value={tgtLang} onChange={(e) => setTgtLang(e.target.value)}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>
      </div>

      {detectedLabel && <div className="detected-lang">{detectedLabel}</div>}

      <div className="textarea-wrap">
        <textarea
          className="tx-area"
          rows={5}
          placeholder="Type text to translate, or use the mic…"
          value={srcText}
          onChange={(e) => handleTextInput(e.target.value)}
        />
      </div>

      <div className="result-box">
        {error ? (
          <span className="result-error">Error: {error}</span>
        ) : result?.translation ? (
          <span>{result.translation}</span>
        ) : (
          <span className="placeholder">Translation will appear here…</span>
        )}
        <button className="copy-btn" onClick={copyResult} title="Copy">
          ⎘
        </button>
      </div>

      <div className="action-row">
        <button className="btn btn-secondary" onClick={clearAll}>
          ✕ Clear
        </button>
        <button
          className={"btn-mic" + (isRecording ? " recording" : "")}
          onClick={toggleMic}
          title="Voice input"
        >
          {isRecording ? "⏹" : "🎤"}
        </button>
        <button className="btn btn-primary" onClick={() => doTranslate()} disabled={busy}>
          {busy ? <span className="spinner" /> : "Translate"}
        </button>
      </div>

      <div className="divider" />

      <div className="quick-actions">
        <div className="settings-title">Quick Actions</div>
        <div className="action-row flush">
          <button className="btn btn-secondary" onClick={speakResult}>
            🔊 Listen
          </button>
          <button className="btn btn-secondary" onClick={openFullScreen}>
            ⛶ Full Screen
          </button>
        </div>
      </div>

      {audioWarning && (
        <Modal title="Limited TTS support" onClose={() => setAudioWarning(null)}>
          <p>
            Your browser has limited or no TTS support for {audioWarning.label}. Audio may
            be silent.
          </p>
          <div className="action-row flush" style={{ marginTop: 14 }}>
            <button className="btn btn-secondary" onClick={() => setAudioWarning(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                audioWarning.onProceed();
                setAudioWarning(null);
              }}
            >
              Speak Anyway
            </button>
          </div>
        </Modal>
      )}

      {fullScreenOpen && result?.translation && (
        <Modal
          title="Text Translation"
          meta={`${detectedLabel || languageLabel(srcLang)} → ${languageLabel(tgtLang)}`}
          onClose={() => setFullScreenOpen(false)}
        >
          <div className="modal-source-block">
            <div className="modal-block-label">Original</div>
            <div className="modal-block-text">{srcText}</div>
          </div>
          <div className="modal-block-label">Translation</div>
          <div className="modal-block-text">{result.translation}</div>
          <div className="action-row flush" style={{ marginTop: 14 }}>
            <button
              className="btn btn-secondary"
              onClick={() =>
                navigator.clipboard
                  .writeText(result.translation)
                  .then(() => showToast("Copied!"))
              }
            >
              ⎘ Copy
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => handleSpeak(result.translation, tgtLang, languageLabel(tgtLang))}
            >
              🔊 Speak
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
