import { useTranslationHistory } from "../hooks/useTranslationHistory.js";
import "./History.css";
// Phase 1/2 already built the underlying `useTranslationHistory` hook and write real
// entries into it (Translate.jsx's doTranslate, gated by the Save to History setting).
// This tab was the missing piece — actually rendering that list. Same localStorage-backed
// history the legacy app used (see the hook for the shared-key rationale), same 120-char
// truncation on original/translated text, same mode icons (📷 camera / 📄 doc / 💬
// everything else) as public/index.html's renderHistory.
function truncate(text, max) {
  return (text || "").slice(0, max);
}
function modeIcon(mode) {
  if (mode === "camera") return "📷";
  if (mode === "doc") return "📄";
  return "💬";
}
export default function History() {
  const { history, clearHistory } = useTranslationHistory();
  function handleClearAll() {
    if (!window.confirm("Clear all history?")) return;
    clearHistory();
  }
  return (
    <div className="history-tab">
      <div className="history-header">
        <div className="settings-title" style={{ margin: 0 }}>
          Translation History
        </div>
        <button className="btn btn-danger" onClick={handleClearAll}>
          Clear All
        </button>
      </div>
      {history.length === 0 ? (
        <div className="history-empty">
          No translations yet.
          <br />
          Start translating to build your history.
        </div>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <div className="history-item" key={item.id}>
              <div className="history-langs">
                <span>{item.srcName || item.srcLang}</span>
                <span>→</span>
                <span>{item.tgtName || item.tgtLang}</span>
                <span style={{ marginLeft: "auto" }}>{modeIcon(item.mode)}</span>
              </div>
              <div className="history-original">{truncate(item.original, 120)}</div>
              <div className="history-translated">{truncate(item.translated, 120)}</div>
              <div className="history-time">{item.time}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
