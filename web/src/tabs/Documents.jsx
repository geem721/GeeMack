import { useRef, useState } from "react";
import { useToast } from "../components/Toast.jsx";
import Modal from "../components/Modal.jsx";
import { callTranslate } from "../api/translate.js";
import { speakWithCheck } from "../utils/speech.js";
import { chunkText, extractDocumentText, getFileIcon } from "../utils/documentParsers.js";
import "./Documents.css";

// Same fixed language subsets as the legacy Documents panel (public/index.html) —
// distinct from Translate's full 29-language list and from Camera OCR's own subset.
// Three different pre-existing per-tab lists; carried over faithfully rather than
// unified, since unifying them would be a product change, not a parity port.
const DOC_SRC_LANGUAGES = [
  { code: "auto", label: "🔍 Auto-Detect" },
  { code: "en", label: "🇺🇸 English" },
  { code: "es", label: "🇪🇸 Spanish" },
  { code: "fr", label: "🇫🇷 French" },
  { code: "de", label: "🇩🇪 German" },
  { code: "it", label: "🇮🇹 Italian" },
  { code: "pt", label: "🇧🇷 Portuguese" },
  { code: "zh", label: "🇨🇳 Chinese" },
  { code: "ja", label: "🇯🇵 Japanese" },
  { code: "ko", label: "🇰🇷 Korean" },
  { code: "ar", label: "🇸🇦 Arabic" },
  { code: "ru", label: "🇷🇺 Russian" },
];

const DOC_TGT_LANGUAGES = [
  { code: "en", label: "🇺🇸 English" },
  { code: "es", label: "🇪🇸 Spanish" },
  { code: "fr", label: "🇫🇷 French" },
  { code: "de", label: "🇩🇪 German" },
  { code: "it", label: "🇮🇹 Italian" },
  { code: "pt", label: "🇧🇷 Portuguese" },
  { code: "zh", label: "🇨🇳 Chinese" },
  { code: "ja", label: "🇯🇵 Japanese" },
  { code: "ko", label: "🇰🇷 Korean" },
  { code: "ar", label: "🇸🇦 Arabic" },
  { code: "ru", label: "🇷🇺 Russian" },
  { code: "hi", label: "🇮🇳 Hindi" },
];

const LANG_LABELS = Object.fromEntries(
  [...DOC_SRC_LANGUAGES, ...DOC_TGT_LANGUAGES].map((l) => [l.code, l.label]),
);

const CHUNK_SIZE = 3000;

export default function Documents() {
  const { showToast } = useToast();

  const [srcLang, setSrcLang] = useState("auto");
  const [tgtLang, setTgtLang] = useState("en");
  const [dragOver, setDragOver] = useState(false);

  const [file, setFile] = useState(null); // { name, size, ext }
  const [readError, setReadError] = useState(null);
  const [reading, setReading] = useState(false);
  const [docText, setDocText] = useState("");

  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [translatedText, setTranslatedText] = useState("");
  const [translateError, setTranslateError] = useState(null);
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [audioWarning, setAudioWarning] = useState(null);

  const fileInputRef = useRef(null);

  async function processFile(rawFile) {
    const ext = rawFile.name.split(".").pop().toLowerCase();
    setFile({ name: rawFile.name, size: rawFile.size, ext });
    setDocText("");
    setReadError(null);
    setTranslatedText("");
    setTranslateError(null);
    setProgress(0);
    setReading(true);
    try {
      const text = await extractDocumentText(rawFile);
      if (!text) {
        setReadError("No readable text found in this file");
      } else {
        setDocText(text);
        showToast("File loaded");
      }
    } catch (e) {
      setReadError(e.message);
    } finally {
      setReading(false);
    }
  }

  function handleFileInputChange(e) {
    if (e.target.files.length) processFile(e.target.files[0]);
    e.target.value = ""; // allow re-selecting the same file
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
  }

  async function translateDocument() {
    if (!docText) {
      showToast("No document loaded");
      return;
    }
    setTranslating(true);
    setTranslateError(null);
    setProgress(20);
    try {
      const chunks = chunkText(docText, CHUNK_SIZE);
      const translated = [];
      for (let i = 0; i < chunks.length; i++) {
        setProgress(20 + Math.round((i / chunks.length) * 70));
        const result = await callTranslate(chunks[i], srcLang, tgtLang);
        translated.push(result.translation);
      }
      setProgress(100);
      setTranslatedText(translated.join("\n\n"));
      showToast("Translation complete!");
      setTimeout(() => setProgress(0), 500);
    } catch (e) {
      setTranslateError(e.message);
      showToast("Error: " + e.message, 3000);
      setProgress(0);
    } finally {
      setTranslating(false);
    }
  }

  function copyTranslation() {
    if (!translatedText) {
      showToast("Nothing to copy");
      return;
    }
    navigator.clipboard.writeText(translatedText).then(() => showToast("Copied!"));
  }

  function handleSpeak() {
    const outcome = speakWithCheck(translatedText, tgtLang, {
      onWarn: (proceed) =>
        setAudioWarning({
          label: LANG_LABELS[tgtLang] || tgtLang,
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

  function saveToDevice() {
    if (!translatedText) {
      showToast("Nothing to save");
      return;
    }
    const blob = new Blob([translatedText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "talkbridge_" + Date.now() + ".txt";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Saved!");
  }

  return (
    <div className="documents-tab">
      <div
        className={"drop-zone" + (dragOver ? " drag-over" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="file-input-hidden"
          accept=".txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.epub,.rtf,.csv,.md,.html,.odt,.ods,.odp,.png,.jpg,.jpeg,.gif,.bmp,.webp,.tiff"
          onChange={handleFileInputChange}
        />
        <div className="drop-icon">📂</div>
        <div className="drop-title">Drop a File or Tap to Browse</div>
        <div className="drop-sub">
          Images · PDFs · Word · Excel · PowerPoint
          <br />
          ePub · RTF · CSV · Markdown · HTML · ODT
        </div>
      </div>

      <div className="supported-formats">
        {["PDF", "DOCX", "XLSX", "PPTX", "TXT", "RTF", "CSV", "EPUB", "MD", "HTML", "JPG/PNG", "ODT"].map(
          (tag) => (
            <span className="fmt-tag" key={tag}>
              {tag}
            </span>
          ),
        )}
      </div>

      <div className="lang-bar">
        <select className="lang-sel" value={srcLang} onChange={(e) => setSrcLang(e.target.value)}>
          {DOC_SRC_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="cam-arrow">→</span>
        <select className="lang-sel" value={tgtLang} onChange={(e) => setTgtLang(e.target.value)}>
          {DOC_TGT_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {(reading || translating) && (
        <div className="progress-bar-wrap">
          <div
            className="progress-bar"
            style={{ width: reading ? "40%" : `${progress}%` }}
          />
        </div>
      )}

      {file && (
        <div className="doc-preview">
          <div className="doc-preview-header">
            <div className="doc-icon">{getFileIcon(file.ext)}</div>
            <div>
              <div className="doc-name">{file.name}</div>
              <div className="doc-meta">
                {(file.size / 1024).toFixed(1)} KB · {file.ext.toUpperCase()}
              </div>
            </div>
          </div>
          <div className="doc-body">
            {reading ? (
              <>
                <span className="spinner" /> Reading…
              </>
            ) : readError ? (
              <span className="result-error">Error: {readError}</span>
            ) : (
              docText.slice(0, 800) + (docText.length > 800 ? "\n\n…(truncated)" : "")
            )}
          </div>
        </div>
      )}

      {docText && !reading && (
        <button
          className="btn btn-primary translate-doc-btn"
          onClick={translateDocument}
          disabled={translating}
        >
          {translating ? <span className="spinner" /> : "⚡ Translate Document"}
        </button>
      )}

      {translateError && (
        <div className="doc-preview doc-error-block">
          <div className="doc-body">
            <span className="result-error">Error: {translateError}</span>
          </div>
        </div>
      )}

      {translatedText && (
        <>
          <div className="doc-preview doc-result-block">
            <div className="doc-preview-header">
              <div className="doc-icon">✅</div>
              <div>
                <div className="doc-name">Translation Complete</div>
                <div className="doc-meta">{LANG_LABELS[tgtLang] || tgtLang}</div>
              </div>
            </div>
            <div className="doc-body">
              {translatedText.slice(0, 600) + (translatedText.length > 600 ? "\n…" : "")}
            </div>
          </div>
          <button className="btn btn-secondary" style={{ width: "100%" }} onClick={() => setFullScreenOpen(true)}>
            ⛶ View Full Translation
          </button>
        </>
      )}

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

      {fullScreenOpen && (
        <Modal
          title="Document Translation"
          meta={`${file?.name || "document"} → ${LANG_LABELS[tgtLang] || tgtLang}`}
          onClose={() => setFullScreenOpen(false)}
        >
          <div className="modal-block-text">{translatedText}</div>
          <div className="action-row flush" style={{ marginTop: 14 }}>
            <button className="btn btn-secondary" onClick={copyTranslation}>
              ⎘ Copy
            </button>
            <button className="btn btn-secondary" onClick={handleSpeak}>
              🔊 Speak
            </button>
            <button className="btn btn-secondary" onClick={saveToDevice}>
              💾 Save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
