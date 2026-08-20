import { useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toast.jsx";
import Modal from "../components/Modal.jsx";
import { callTranslate } from "../api/translate.js";
import { useSettings } from "../hooks/useSettings.jsx";
import "./CameraOCR.css";

// Same limited language subsets as the legacy Camera OCR panel (public/index.html) —
// intentionally smaller than the full 29-language Translate list, since these are the
// languages that panel was actually tuned/tested against. Not expanded here; that would
// be a scope change; not a parity port.
const CAM_SRC_LANGUAGES = [
  { code: "auto", label: "🔍 Auto-Detect" },
  { code: "en", label: "🇺🇸 English" },
  { code: "es", label: "🇪🇸 Spanish" },
  { code: "fr", label: "🇫🇷 French" },
  { code: "de", label: "🇩🇪 German" },
  { code: "zh", label: "🇨🇳 Chinese" },
  { code: "ja", label: "🇯🇵 Japanese" },
  { code: "ko", label: "🇰🇷 Korean" },
  { code: "ar", label: "🇸🇦 Arabic" },
  { code: "ru", label: "🇷🇺 Russian" },
  { code: "hi", label: "🇮🇳 Hindi" },
];

const CAM_TGT_LANGUAGES = [
  { code: "en", label: "🇺🇸 English" },
  { code: "es", label: "🇪🇸 Spanish" },
  { code: "fr", label: "🇫🇷 French" },
  { code: "de", label: "🇩🇪 German" },
  { code: "zh", label: "🇨🇳 Chinese" },
  { code: "ja", label: "🇯🇵 Japanese" },
  { code: "ko", label: "🇰🇷 Korean" },
  { code: "ar", label: "🇸🇦 Arabic" },
  { code: "ru", label: "🇷🇺 Russian" },
  { code: "pt", label: "🇧🇷 Portuguese" },
];

const LANG_LABELS = Object.fromEntries(
  [...CAM_SRC_LANGUAGES, ...CAM_TGT_LANGUAGES].map((l) => [l.code, l.label]),
);

// Same fixed OCR language set the legacy app always passes to Tesseract, regardless of
// the camSrcLang dropdown — that dropdown only feeds the /api/translate call, it never
// changed which OCR language packs Tesseract loaded. Carried over as-is.
const TESSERACT_LANGS = "eng+spa+fra+deu+chi_sim+jpn+kor+ara+rus";

const AUTO_CAPTURE_INTERVAL_MS = 4000;

export default function CameraOCR() {
  const { showToast } = useToast();

  const [srcLang, setSrcLang] = useState("auto");
  const [tgtLang, setTgtLang] = useState("en");
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [detectedLangName, setDetectedLangName] = useState("");
  const [ocrError, setOcrError] = useState(null);
  const [fullScreenOpen, setFullScreenOpen] = useState(false);

  // Shared, persisted behavior settings — see useSettings.jsx / Settings.jsx.
  const { settings } = useSettings();
  const { useBackCamera, autoCapture } = settings;

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const autoCaptureTimerRef = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: useBackCamera ? "environment" : "user" },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      showToast("Camera ready");
    } catch (e) {
      showToast("Camera error: " + e.message, 3000);
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    clearInterval(autoCaptureTimerRef.current);
    autoCaptureTimerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  async function captureAndOCR() {
    if (busyRef.current) return; // legacy app has no guard here, but auto-capture at 4s
    // intervals can otherwise stack overlapping OCR passes on a slow device — a small,
    // safe addition, not a behavior change under normal (manual capture) use.
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streamRef.current) return;

    if (!window.Tesseract) {
      showToast("OCR engine still loading — try again in a moment");
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);

    setBusy(true);
    setOcrError(null);
    setOcrText("");
    setTranslatedText("");
    setDetectedLangName("");

    try {
      const {
        data: { text },
      } = await window.Tesseract.recognize(canvas, TESSERACT_LANGS);
      const cleanedText = text.trim().replace(/\n{3,}/g, "\n\n");
      if (!cleanedText) {
        showToast("No text detected");
        setBusy(false);
        return;
      }
      setOcrText(cleanedText);
      const result = await callTranslate(cleanedText, srcLang, tgtLang);
      setTranslatedText(result.translation);
      setDetectedLangName(result.detectedName || "");
      showToast("OCR complete!");
    } catch (e) {
      setOcrError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Auto-capture is now a shared setting (Settings.jsx), not a local checkbox this tab
  // owns directly — this effect starts/stops the interval whenever the setting or
  // camera-on state changes, including turning it on from Settings while already on this
  // tab with the camera running, which the old checkbox-driven version couldn't do.
  useEffect(() => {
    clearInterval(autoCaptureTimerRef.current);
    autoCaptureTimerRef.current = null;
    if (autoCapture && streamRef.current) {
      autoCaptureTimerRef.current = setInterval(() => {
        if (streamRef.current) captureAndOCR();
      }, AUTO_CAPTURE_INTERVAL_MS);
    }
    return () => {
      clearInterval(autoCaptureTimerRef.current);
      autoCaptureTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCapture, cameraOn]);

  function copyTranslation() {
    if (!translatedText) {
      showToast("Nothing to copy");
      return;
    }
    navigator.clipboard.writeText(translatedText).then(() => showToast("Copied!"));
  }

  function openFullScreen() {
    if (!ocrText) {
      showToast("Nothing to display");
      return;
    }
    setFullScreenOpen(true);
  }

  return (
    <div className="camera-tab">
      <div className="camera-wrap">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {!cameraOn && (
          <div className="camera-overlay">
            <div className="camera-overlay-icon">📷</div>
            <div className="camera-overlay-title">Camera Live OCR</div>
            <div className="camera-overlay-sub">Point at text — signs, menus, documents</div>
          </div>
        )}
      </div>

      <div className="lang-bar cam-lang-bar">
        <select className="lang-sel" value={srcLang} onChange={(e) => setSrcLang(e.target.value)}>
          {CAM_SRC_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="cam-arrow">→</span>
        <select className="lang-sel" value={tgtLang} onChange={(e) => setTgtLang(e.target.value)}>
          {CAM_TGT_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="cam-controls">
        {!cameraOn ? (
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={startCamera}>
            📷 Start Camera
          </button>
        ) : (
          <>
            <button
              className="btn btn-secondary"
              style={{ flex: 1 }}
              onClick={captureAndOCR}
              disabled={busy}
            >
              {busy ? <span className="spinner" /> : "⚡ Capture & Translate"}
            </button>
            <button className="btn btn-danger" style={{ flex: "none" }} onClick={stopCamera}>
              ■ Stop
            </button>
          </>
        )}
      </div>

      <div className="ocr-result">
        <div className="ocr-result-header">
          <span>DETECTED TEXT</span>
          {detectedLangName && <span className="ocr-detected-lang">{detectedLangName}</span>}
        </div>
        <div className="ocr-result-body">
          {ocrError ? (
            <span className="result-error">Error: {ocrError}</span>
          ) : ocrText ? (
            ocrText
          ) : (
            <span className="placeholder">Captured text will appear here…</span>
          )}
        </div>
      </div>

      <div className="ocr-result">
        <div className="ocr-result-header">
          <span>TRANSLATION</span>
          <button className="ocr-copy-btn" onClick={copyTranslation}>
            ⎘ Copy
          </button>
        </div>
        <div className="ocr-result-body">
          {translatedText || <span className="placeholder">Translation will appear here…</span>}
        </div>
      </div>

      <div className="cam-fullscreen-row">
        <button className="btn btn-secondary" style={{ width: "100%" }} onClick={openFullScreen}>
          ⛶ View Full OCR Result
        </button>
      </div>

      {fullScreenOpen && ocrText && (
        <Modal
          title="Camera OCR Result"
          meta={`Auto-Detected → ${LANG_LABELS[tgtLang] || tgtLang}`}
          onClose={() => setFullScreenOpen(false)}
        >
          <div className="modal-source-block">
            <div className="modal-block-label">Detected Text</div>
            <div className="modal-block-text">{ocrText}</div>
          </div>
          <div className="modal-block-label">Translation</div>
          <div className="modal-block-text">
            {translatedText || "Translation will appear here…"}
          </div>
        </Modal>
      )}
    </div>
  );
}
