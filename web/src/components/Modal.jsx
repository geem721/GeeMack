import "./Modal.css";

// Shared modal shell — used by Translate's "Full Screen" result view and its TTS
// audio-support warning. Later tabs (Camera OCR, Documents) have equivalent modals in
// the legacy app and can reuse this instead of duplicating the overlay/box markup.
export default function Modal({ title, meta, onClose, children }) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            {meta && <div className="modal-meta">{meta}</div>}
          </div>
          <button className="modal-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
