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

// Maps the camSrcLang dropdown to the specific Tesseract language pack to load for OCR.
// Loading unrelated scripts together in one Tesseract pass (the old behavior: always
// loading all nine languages regardless of the dropdown) makes Tesseract misread plain
// Latin letters as Chinese/Japanese/Korean characters -- a real bug testers hit, not a
// hypothetical. A specific selection now loads ONLY that language's pack.
const TESSERACT_LANG_MAP = {
  en: "eng",
  es: "spa",
  fr: "fra",
  de: "deu",
  zh: "chi_sim",
  ja: "jpn",
  ko: "kor",
  ar: "ara",
  ru: "rus",
  hi: "hin",
};

// "Auto" can't ask Tesseract to detect a script ahead of time, so instead of one big
// mixed-script pass, it runs two smaller, script-grouped passes in parallel and keeps
// whichever one Tesseract itself is more confident in.
const TESSERACT_AUTO_GROUPS = ["eng+spa+fra+deu", "chi_sim+jpn+kor+ara+rus+hin"];

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
  const [singleCameraOnly, setSingleCameraOnly] = useState(false);

  // Shared, persisted behavior settings — see useSettings.jsx / Settings.jsx.
  const { settings } = useSettings();
  const { useBackCamera, autoCapture } = settings;

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const autoCaptureTimerRef = useRef(null);
  const busyRef = useRef(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort device check: most laptops have exactly one (front-facing) camera, so
  // "point your camera at a document" doesn't work there the way it does on a phone.
  // When we can only see one video input, steer people toward uploading a photo instead.
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((devices) => {
        const cameraCount = devices.filter((d) => d.kind === "videoinput").length;
        setSingleCameraOnly(cameraCount <= 1);
      })
      .catch(() => {});
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

  // Picks the right Tesseract call for the current source-language selection. See the
  // TESSERACT_LANG_MAP / TESSERACT_AUTO_GROUPS comment above for why this isn't just one
  // fixed multi-language pass anymore.
  //
  // NOTE: an attempt to also force sparse-text page segmentation here (via
  // Tesseract.createWorker + worker.setParameters) crashed in production with
  // "Cannot read properties of null (reading 'setVariable')" -- reverted until the
  // correct API usage for this Tesseract.js build is confirmed. See conversation notes.
  async function recognizeCanvas() {
    const mapped = TESSERACT_LANG_MAP[srcLang];
    if (mapped) {
      return window.Tesseract.recognize(canvasRef.current, mapped);
    }
    const results = await Promise.all(
      TESSERACT_AUTO_GROUPS.map((langs) => window.Tesseract.recognize(canvasRef.current, langs)),
    );
    return results.reduce((best, r) => (r.data.confidence > best.data.confidence ? r : best));
  }

  // Shared by both live-camera capture and photo upload: runs Tesseract + translate on
  // whatever's already drawn onto canvasRef, then updates the result state. Neither
  // caller needs to know how the canvas got populated.
  async function runOcrOnCanvas() {
    if (!window.Tesseract) {
      showToast("OCR engine still loading — try again in a moment");
      return;
    }

    setBusy(true);
    setOcrError(null);
    setOcrText("");
    setTranslatedText("");
    setDetectedLangName("");

    try {
      const {
        data: { text },
      } = await recognizeCanvas();
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

  async function captureAndOCR() {
    if (busyRef.current) return; // legacy app has no guard here, but auto-capture at 4s
    // intervals can otherwise stack overlapping OCR passes on a slow device — a small,
    // safe addition, not a behavior change under normal (manual capture) use.
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streamRef.current) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);

    await runOcrOnCanvas();
  }

  function triggerFileUpload() {
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file || busyRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      showToast("Couldn't read that image");
      return;
    }

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();

    await runOcrOnCanvas();
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleFileSelected}
        />
        {!cameraOn && (
          <div className="camera-overlay">
            <div className="camera-overlay-icon">📷</div>
            <div className="camera-overlay-title">Camera Live OCR</div>
            <div className="camera-overlay-sub">
              {singleCameraOnly
                ? "On a laptop? Upload a photo below instead of using the camera."
                : "Point at text — signs, menus, documents"}
            </div>
          </div>
        )}
      </div>

      {cameraOn && singleCameraOnly && (
        <div className="cam-hint">
          Hold your document or photo up to the screen, then tap "Capture &amp; Translate" below.
        </div>
      )}

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
          singleCameraOnly ? (
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={triggerFileUpload}
              disabled={busy}
            >
              📁 Upload a Photo
            </button>
          ) : (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={startCamera}>
              📷 Start Camera
            </button>
          )
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

      {!cameraOn && (
        <div className="cam-fullscreen-row">
          {singleCameraOnly ? (
            <button className="btn btn-secondary" style={{ width: "100%" }} onClick={startCamera}>
              📷 Use Camera Instead
            </button>
          ) : (
            <button
              className="btn btn-secondary"
              style={{ width: "100%" }}
              onClick={triggerFileUpload}
              disabled={busy}
            >
              📁 Upload a Photo Instead
            </button>
          )}
        </div>
      )}

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
