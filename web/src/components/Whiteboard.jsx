// Shared meeting whiteboard. Items live at chats/{meetingId}/whiteboard/items/{pushId}:
//   stroke: { type: "stroke", color, size, points: [x0, y0, x1, y1, ...], by }
//   text:   { type: "text", x, y, text, color, size, lang, by }
// All coordinates/sizes are fractions of a fixed 16:9 board, so a phone and a laptop
// see the same drawing. Strokes sync on pen-up (one Firebase write per stroke).
// Text labels are translated into each viewer's caption language (one callTranslate
// per label per language, cached) -- the TalkBridge twist on a standard whiteboard.
import { useEffect, useRef, useState } from "react";
import { ref, onValue, push, remove } from "firebase/database";
import { db } from "../firebase.js";
import { callTranslate } from "../api/translate.js";
import "./Whiteboard.css";

const COLORS = ["#111827", "#ef4444", "#2563eb", "#16a34a", "#f59e0b", "#9333ea"];
const SIZES = [
  { label: "S", stroke: 0.003, text: 0.022 },
  { label: "M", stroke: 0.006, text: 0.032 },
  { label: "L", stroke: 0.012, text: 0.045 },
];
const BOARD_BG = "#ffffff";
const r4 = (n) => Math.round(n * 10000) / 10000;

export default function Whiteboard({ meetingId, user, isHost, showLang, speakLang }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const drawingRef = useRef(null);
  const itemsRef = useRef([]);
  const translationsRef = useRef({});
  const showLangRef = useRef(showLang);
  const translateReqRef = useRef(new Set());
  const [items, setItems] = useState([]);
  const [translations, setTranslations] = useState({});
  const [tool, setTool] = useState("pen"); // pen | eraser | text
  const [color, setColor] = useState(COLORS[0]);
  const [sizeIdx, setSizeIdx] = useState(1);
  const [textDraft, setTextDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const itemsPath = `chats/${meetingId}/whiteboard/items`;

  useEffect(() => {
    if (!meetingId) return undefined;
    const unsub = onValue(
      ref(db, `chats/${meetingId}/whiteboard/items`),
      (snap) => {
        const val = snap.val() || {};
        // Push IDs are time-ordered, so sorting by key gives drawing order.
        setItems(Object.entries(val).map(([id, it]) => ({ id, ...it })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
      },
      (err) => console.error("[whiteboard] listener error:", err),
    );
    return () => unsub();
  }, [meetingId]);

  useEffect(() => {
    items.forEach((it) => {
      if (it.type !== "text" || !it.text || (it.lang && it.lang === showLang)) return;
      const key = `${it.id}|${showLang}`;
      if (translateReqRef.current.has(key)) return;
      translateReqRef.current.add(key);
      callTranslate(it.text, "auto", showLang)
        .then((res) => { if (res.translation) setTranslations((prev) => ({ ...prev, [key]: res.translation })); })
        .catch((err) => console.error("[whiteboard] translate failed:", err));
    });
  }, [items, showLang]);

  function drawItem(ctx, it, w, h) {
    if (it.type === "stroke") {
      const pts = it.points || [];
      if (pts.length < 2) return;
      ctx.strokeStyle = it.color || "#111827";
      ctx.lineWidth = Math.max(1, (it.size || 0.006) * w);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0] * w, pts[1] * h);
      if (pts.length === 2) ctx.lineTo(pts[0] * w + 0.01, pts[1] * h); // a dot
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h);
      ctx.stroke();
    } else if (it.type === "text") {
      const label = translationsRef.current[`${it.id}|${showLangRef.current}`] || it.text;
      ctx.fillStyle = it.color || "#111827";
      ctx.font = `${Math.max(10, (it.size || 0.032) * w)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(label, it.x * w, it.y * h);
    }
  }
  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, w, h);
    itemsRef.current.forEach((it) => drawItem(ctx, it, w, h));
    if (drawingRef.current) drawItem(ctx, drawingRef.current, w, h);
  }

  useEffect(() => {
    itemsRef.current = items;
    translationsRef.current = translations;
    showLangRef.current = showLang;
    redraw();
  }, [items, translations, showLang]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = wrap.clientWidth;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(((cssW * 9) / 16) * dpr);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  function toFrac(e) {
    const r = canvasRef.current.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  }
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const [x, y] = toFrac(e);
    if (tool === "text") { placeText(x, y); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    const eraser = tool === "eraser";
    drawingRef.current = {
      type: "stroke",
      color: eraser ? BOARD_BG : color,
      size: SIZES[sizeIdx].stroke * (eraser ? 4 : 1),
      points: [r4(x), r4(y)],
    };
    redraw();
  }
  function onPointerMove(e) {
    const d = drawingRef.current;
    if (!d) return;
    const [x, y] = toFrac(e);
    const n = d.points.length;
    if (Math.hypot(x - d.points[n - 2], y - d.points[n - 1]) < 0.002) return; // thin out points
    d.points.push(r4(x), r4(y));
    redraw();
  }
  function onPointerUp() {
    const d = drawingRef.current;
    if (!d) return;
    drawingRef.current = null;
    push(ref(db, itemsPath), { ...d, by: user.uid }).catch((err) => console.error("[whiteboard] stroke save failed:", err));
  }
  function placeText(x, y) {
    const text = textDraft.trim();
    if (!text) return;
    push(ref(db, itemsPath), {
      type: "text", x: r4(x), y: r4(y), text: text.slice(0, 200), color, size: SIZES[sizeIdx].text, lang: speakLang, by: user.uid,
    }).catch((err) => console.error("[whiteboard] text save failed:", err));
    setTextDraft("");
  }
  function undo() {
    const mine = [...items].reverse().find((it) => it.by === user.uid);
    if (mine) remove(ref(db, `${itemsPath}/${mine.id}`)).catch((err) => console.error("[whiteboard] undo failed:", err));
  }
  function clearBoard() {
    if (!isHost) return;
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    remove(ref(db, itemsPath)).catch((err) => console.error("[whiteboard] clear failed:", err));
  }
  function downloadPng() {
    const a = document.createElement("a");
    a.href = canvasRef.current.toDataURL("image/png");
    a.download = `talkbridge-whiteboard-${meetingId}.png`;
    a.click();
  }

  const TOOL_LABELS = { pen: "✏️ Pen", eraser: "🧽 Eraser", text: "🔤 Text" };
  return (
    <div className="wb-panel">
      <div className="wb-toolbar">
        <div className="wb-group">
          {Object.keys(TOOL_LABELS).map((t) => (
            <button key={t} type="button" className={"wb-btn" + (tool === t ? " wb-btn-active" : "")} onClick={() => setTool(t)}>
              {TOOL_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="wb-group">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              className={"wb-swatch" + (color === c ? " wb-swatch-active" : "")}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="wb-group">
          {SIZES.map((s, i) => (
            <button key={s.label} type="button" className={"wb-btn" + (sizeIdx === i ? " wb-btn-active" : "")} onClick={() => setSizeIdx(i)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="wb-group">
          <button type="button" className="wb-btn" onClick={undo}>↶ Undo</button>
          <button type="button" className="wb-btn" onClick={downloadPng}>⬇ PNG</button>
          {isHost && (
            <button type="button" className="wb-btn wb-btn-danger" onClick={clearBoard}>
              {confirmClear ? "Tap again to clear" : "🗑 Clear"}
            </button>
          )}
        </div>
      </div>
      {tool === "text" && (
        <input
          className="gc-invite-input wb-text-input"
          placeholder="Type text, then click the board to place it"
          maxLength={200}
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
        />
      )}
      <div className="wb-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={"wb-canvas" + (tool === "text" ? " wb-canvas-text" : "")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      <div className="wb-hint">
        Everyone can draw{isHost ? " · only you (host) can clear the board" : ""} · text is translated into each viewer's caption language
      </div>
    </div>
  );
}
