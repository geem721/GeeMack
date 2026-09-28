// Shared meeting whiteboard. Items live at chats/{meetingId}/whiteboard/items/{pushId}:
//   stroke: { type: "stroke", color, size, points: [x0, y0, x1, y1, ...], by }
//   text:   { type: "text", x, y, text, color, size, lang, by }
// All coordinates/sizes are fractions of a fixed 16:9 board, so a phone and a laptop
// see the same drawing. Strokes sync on pen-up (one Firebase write per stroke).
// Text labels are translated into each viewer's caption language (one callTranslate
// per label per language, cached) -- the TalkBridge twist on a standard whiteboard.
// Templates: users/{uid}/whiteboardTemplates/{id} = { name, createdAt, count } (listed live)
// and users/{uid}/whiteboardTemplateItems/{id} = [items] (fetched only on load). Anyone can
// save; only the host loads onto the shared board. Loaded items share a `batch` id so one
// Undo removes the whole template.
import { useEffect, useRef, useState } from "react";
import { ref, onValue, push, remove, update, get } from "firebase/database";
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
const NOTE_COLORS = ["#fef08a", "#fbcfe8", "#bfdbfe", "#bbf7d0"]; // yellow, pink, blue, green
const NOTE_W = 0.15; // fraction of board width
const NOTE_H = 0.18; // fraction of board height
const KANBAN = ["To Do", "In Progress", "Done"];
// Wrap text to a max pixel width. Breaks at spaces when it can, otherwise per
// character, so CJK/Thai (no spaces) still wrap inside a sticky note.
function wrapLines(ctx, text, maxW) {
  const lines = [];
  let line = "";
  for (const ch of String(text || "")) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      const sp = line.lastIndexOf(" ");
      if (sp > 0 && ch !== " ") { lines.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
      else { lines.push(line); line = ch === " " ? "" : ch; }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
const r4 = (n) => Math.round(n * 10000) / 10000;
// Built-in starter templates (host loads them from 📋 Templates). Labels are English and get
// translated per viewer like any other board text. Columns take optional y/h so SWOT can be 2x2.
const col = (title, x, w, y = 0, h = 1) => ({ type: "column", x: r4(x), w: r4(w), y: r4(y), h: r4(h), title, lang: "en" });
const starterNote = (text, x, y, color) => ({ type: "note", x: r4(x), y: r4(y), w: NOTE_W, h: NOTE_H, text, color, lang: "en" });
const STARTERS = [
  { key: "kanban", icon: "📋", name: "Kanban", items: KANBAN.map((t, i) => col(t, i / 3, 1 / 3)) },
  { key: "retro", icon: "🔁", name: "Retro", items: ["Went well", "To improve", "Action items"].map((t, i) => col(t, i / 3, 1 / 3)) },
  { key: "proscons", icon: "⚖️", name: "Pros / Cons", items: [col("Pros", 0, 0.5), col("Cons", 0.5, 0.5)] },
  { key: "swot", icon: "🧭", name: "SWOT", items: [col("Strengths", 0, 0.5, 0, 0.5), col("Weaknesses", 0.5, 0.5, 0, 0.5), col("Opportunities", 0, 0.5, 0.5, 0.5), col("Threats", 0.5, 0.5, 0.5, 0.5)] },
  { key: "brainstorm", icon: "💡", name: "Brainstorm", items: [
    starterNote("Main topic", (1 - NOTE_W) / 2, (1 - NOTE_H) / 2, NOTE_COLORS[0]),
    starterNote("Idea", 0.1, 0.1, NOTE_COLORS[2]), starterNote("Idea", 0.75, 0.1, NOTE_COLORS[2]),
    starterNote("Idea", 0.1, 0.72, NOTE_COLORS[2]), starterNote("Idea", 0.75, 0.72, NOTE_COLORS[2]),
  ] },
];
const MAX_TPL_ITEMS = 1500; // per saved template
const MAX_TPLS = 30; // per user

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
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);
  const [selectedId, setSelectedId] = useState(null); // note selected with the Move tool
  const selectedRef = useRef(null);
  const dragRef = useRef(null); // { id, dx, dy, x, y, w, h } while dragging a note
  const itemsPath = `chats/${meetingId}/whiteboard/items`;
  const tplRoot = `users/${user.uid}`;
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState([]); // [{ id, name, createdAt, count }]
  const [tplName, setTplName] = useState("");
  const [tplMsg, setTplMsg] = useState("");
  const [pendingLoad, setPendingLoad] = useState(null); // { name, items } awaiting Replace/Add
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

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

  // Personal templates: metadata only here (small); board items are fetched on load.
  useEffect(() => {
    if (!user?.uid) return undefined;
    const unsub = onValue(
      ref(db, `users/${user.uid}/whiteboardTemplates`),
      (snap) => {
        const val = snap.val() || {};
        setTemplates(Object.entries(val).map(([id, t]) => ({ id, ...t })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      },
      (err) => console.error("[whiteboard] templates listener error:", err),
    );
    return () => unsub();
  }, [user?.uid]);

  useEffect(() => {
    items.forEach((it) => {
      const srcText = it.type === "column" ? it.title : it.text;
      if (!["text", "note", "column"].includes(it.type) || !srcText || (it.lang && it.lang === showLang)) return;
      const key = `${it.id}|${showLang}`;
      if (translateReqRef.current.has(key)) return;
      translateReqRef.current.add(key);
      callTranslate(srcText, "auto", showLang)
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
    } else if (it.type === "column") {
      const label = translationsRef.current[`${it.id}|${showLangRef.current}`] || it.title;
      const x0 = it.x * w;
      const cw = (it.w || 1 / 3) * w;
      const y0 = (it.y || 0) * h; // optional y/h (SWOT); Kanban columns are full height
      const ch = (it.h || 1) * h;
      ctx.fillStyle = "#f1f5f9";
      ctx.fillRect(x0 + 0.004 * w, y0 + 0.012 * h, cw - 0.008 * w, ch - 0.024 * h);
      ctx.fillStyle = "#334155";
      ctx.font = `600 ${Math.max(11, 0.026 * w)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, x0 + cw / 2, y0 + 0.03 * h);
      ctx.textAlign = "left";
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = Math.max(1, 0.002 * w);
      ctx.beginPath();
      ctx.moveTo(x0 + 0.02 * w, y0 + 0.1 * h);
      ctx.lineTo(x0 + cw - 0.02 * w, y0 + 0.1 * h);
      ctx.stroke();
    } else if (it.type === "note") {
      const drag = dragRef.current;
      const pos = drag && drag.id === it.id ? drag : it;
      const nx = pos.x * w;
      const ny = pos.y * h;
      const nw = (it.w || NOTE_W) * w;
      const nh = (it.h || NOTE_H) * h;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 0.01 * w;
      ctx.shadowOffsetY = 0.003 * w;
      ctx.fillStyle = it.color || NOTE_COLORS[0];
      ctx.fillRect(nx, ny, nw, nh);
      ctx.restore();
      if (selectedRef.current === it.id) {
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = Math.max(2, 0.003 * w);
        ctx.strokeRect(nx, ny, nw, nh);
      }
      const label = translationsRef.current[`${it.id}|${showLangRef.current}`] || it.text;
      const fs = Math.max(10, 0.016 * w);
      const pad = 0.008 * w;
      const lh = fs * 1.25;
      ctx.fillStyle = "#1f2937";
      ctx.font = `${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      const lines = wrapLines(ctx, label, nw - pad * 2);
      const maxLines = Math.max(1, Math.floor((nh - pad * 2) / lh));
      if (lines.length > maxLines) {
        lines.length = maxLines;
        lines[maxLines - 1] = lines[maxLines - 1].replace(/.?$/, "…");
      }
      lines.forEach((ln, i) => ctx.fillText(ln, nx + pad, ny + pad + i * lh));
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
    // Layers: Kanban columns at the bottom, then ink/text, then sticky notes on top.
    const all = itemsRef.current;
    all.filter((it) => it.type === "column").forEach((it) => drawItem(ctx, it, w, h));
    all.filter((it) => it.type !== "column" && it.type !== "note").forEach((it) => drawItem(ctx, it, w, h));
    if (drawingRef.current) drawItem(ctx, drawingRef.current, w, h);
    all.filter((it) => it.type === "note").forEach((it) => drawItem(ctx, it, w, h));
  }

  useEffect(() => {
    itemsRef.current = items;
    translationsRef.current = translations;
    showLangRef.current = showLang;
    selectedRef.current = selectedId;
    redraw();
  }, [items, translations, showLang, selectedId]);

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
    if (tool === "note") { placeNote(x, y); return; }
    if (tool === "move") {
      // Topmost note under the pointer (later items draw on top).
      const hit = [...itemsRef.current].reverse().find(
        (it) => it.type === "note" && x >= it.x && x <= it.x + (it.w || NOTE_W) && y >= it.y && y <= it.y + (it.h || NOTE_H),
      );
      setSelectedId(hit ? hit.id : null);
      if (hit) {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { id: hit.id, dx: x - hit.x, dy: y - hit.y, x: hit.x, y: hit.y, w: hit.w || NOTE_W, h: hit.h || NOTE_H };
      }
      return;
    }
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
    const drag = dragRef.current;
    if (drag) {
      const [mx, my] = toFrac(e);
      drag.x = Math.min(1 - drag.w, Math.max(0, mx - drag.dx));
      drag.y = Math.min(1 - drag.h, Math.max(0, my - drag.dy));
      redraw();
      return;
    }
    const d = drawingRef.current;
    if (!d) return;
    const [x, y] = toFrac(e);
    const n = d.points.length;
    if (Math.hypot(x - d.points[n - 2], y - d.points[n - 1]) < 0.002) return; // thin out points
    d.points.push(r4(x), r4(y));
    redraw();
  }
  function onPointerUp() {
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      update(ref(db, `${itemsPath}/${drag.id}`), { x: r4(drag.x), y: r4(drag.y) })
        .catch((err) => console.error("[whiteboard] note move failed:", err));
      return;
    }
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
  function placeNote(x, y) {
    const text = textDraft.trim();
    if (!text) return;
    push(ref(db, itemsPath), {
      type: "note",
      x: r4(Math.min(1 - NOTE_W, Math.max(0, x - NOTE_W / 2))),
      y: r4(Math.min(1 - NOTE_H, Math.max(0, y - NOTE_H / 2))),
      w: NOTE_W, h: NOTE_H, text: text.slice(0, 140), color: noteColor, lang: speakLang, by: user.uid,
    }).catch((err) => console.error("[whiteboard] note save failed:", err));
    setTextDraft("");
  }
  function deleteSelected() {
    if (!selectedId) return;
    remove(ref(db, `${itemsPath}/${selectedId}`)).catch((err) => console.error("[whiteboard] note delete failed:", err));
    setSelectedId(null);
  }
  function undo() {
    const mine = [...items].reverse().find((it) => it.by === user.uid);
    if (!mine) return;
    if (mine.batch) {
      // A loaded template is one undo step: remove every item from that load.
      const upd = {};
      items.filter((it) => it.batch === mine.batch).forEach((it) => { upd[it.id] = null; });
      update(ref(db, itemsPath), upd).catch((err) => console.error("[whiteboard] undo failed:", err));
      return;
    }
    remove(ref(db, `${itemsPath}/${mine.id}`)).catch((err) => console.error("[whiteboard] undo failed:", err));
  }
  // ---- Templates ----
  async function saveTemplate() {
    const src = itemsRef.current;
    if (!src.length) { setTplMsg("The board is empty. Draw or add something first."); return; }
    if (src.length > MAX_TPL_ITEMS) { setTplMsg(`This board has ${src.length} items; templates are limited to ${MAX_TPL_ITEMS}.`); return; }
    if (templates.length >= MAX_TPLS) { setTplMsg(`You have ${MAX_TPLS} templates (the limit). Delete one to save another.`); return; }
    const name = tplName.trim().slice(0, 60) || `Board ${new Date().toLocaleDateString()}`;
    const clean = src.map(({ id, by, batch, ...rest }) => rest);
    const tid = push(ref(db, `${tplRoot}/whiteboardTemplates`)).key;
    try {
      await update(ref(db, tplRoot), {
        [`whiteboardTemplateItems/${tid}`]: clean,
        [`whiteboardTemplates/${tid}`]: { name, createdAt: Date.now(), count: clean.length },
      });
      setTplName("");
      setTplMsg(`Saved “${name}” to My templates.`);
    } catch (err) {
      console.error("[whiteboard] template save failed:", err);
      setTplMsg(`Couldn't save the template (${err.code || err.message}).`);
    }
  }
  async function loadTemplate(tplItems, mode, name) {
    if (!isHost) return;
    const batch = push(ref(db, itemsPath)).key; // local id only, nothing written
    const upd = {};
    if (mode === "replace") itemsRef.current.forEach((it) => { upd[it.id] = null; });
    tplItems.forEach((it) => { upd[push(ref(db, itemsPath)).key] = { ...it, by: user.uid, batch }; });
    try {
      await update(ref(db, itemsPath), upd); // one atomic write: clears (if replace) + adds
      setShowTemplates(false);
    } catch (err) {
      console.error("[whiteboard] template load failed:", err);
      setTplMsg(`Couldn't load “${name}” (${err.code || err.message}).`);
    }
  }
  async function pickTemplate(t) {
    if (!isHost) return;
    setTplMsg("");
    let tplItems = t.items;
    if (!tplItems) {
      try {
        const snap = await get(ref(db, `${tplRoot}/whiteboardTemplateItems/${t.id}`));
        tplItems = Object.values(snap.val() || {});
      } catch (err) {
        console.error("[whiteboard] template fetch failed:", err);
        setTplMsg("Couldn't load that template.");
        return;
      }
    }
    if (!tplItems.length) { setTplMsg("That template is empty."); return; }
    if (itemsRef.current.length === 0) { await loadTemplate(tplItems, "add", t.name); return; }
    setPendingLoad({ name: t.name, items: tplItems });
  }
  async function confirmLoad(mode) {
    const p = pendingLoad;
    setPendingLoad(null);
    if (p) await loadTemplate(p.items, mode, p.name);
  }
  function renameTemplate(tid) {
    const name = renameDraft.trim().slice(0, 60);
    setRenamingId(null);
    if (!name) return;
    update(ref(db, `${tplRoot}/whiteboardTemplates/${tid}`), { name }).catch((err) => console.error("[whiteboard] rename failed:", err));
  }
  function deleteTemplate(tid) {
    if (confirmDeleteId !== tid) {
      setConfirmDeleteId(tid);
      setTimeout(() => setConfirmDeleteId((cur) => (cur === tid ? null : cur)), 3000);
      return;
    }
    setConfirmDeleteId(null);
    update(ref(db, tplRoot), { [`whiteboardTemplates/${tid}`]: null, [`whiteboardTemplateItems/${tid}`]: null })
      .catch((err) => console.error("[whiteboard] template delete failed:", err));
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

  const TOOL_LABELS = { pen: "✏️ Pen", eraser: "🧽 Eraser", text: "🔤 Text", note: "🗒️ Note", move: "✋ Move" };
  return (
    <div className="wb-panel">
      <div className="wb-toolbar">
        <div className="wb-group">
          {Object.keys(TOOL_LABELS).map((t) => (
            <button key={t} type="button" className={"wb-btn" + (tool === t ? " wb-btn-active" : "")} onClick={() => { setTool(t); setSelectedId(null); }}>
              {TOOL_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="wb-group">
          {(tool === "note" ? NOTE_COLORS : COLORS).map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              className={"wb-swatch" + ((tool === "note" ? noteColor : color) === c ? " wb-swatch-active" : "")}
              style={{ background: c }}
              onClick={() => (tool === "note" ? setNoteColor(c) : setColor(c))}
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
          {tool === "move" && selectedId && (
            <button type="button" className="wb-btn wb-btn-danger" onClick={deleteSelected}>🗑 Delete note</button>
          )}
          <button type="button" className={"wb-btn" + (showTemplates ? " wb-btn-active" : "")} onClick={() => { setShowTemplates((v) => !v); setTplMsg(""); setPendingLoad(null); }}>
            📋 Templates
          </button>
          <button type="button" className="wb-btn" onClick={undo}>↶ Undo</button>
          <button type="button" className="wb-btn" onClick={downloadPng}>⬇ PNG</button>
          {isHost && (
            <button type="button" className="wb-btn wb-btn-danger" onClick={clearBoard}>
              {confirmClear ? "Tap again to clear" : "🗑 Clear"}
            </button>
          )}
        </div>
      </div>
      {showTemplates && (
        <div className="wb-tpl-panel">
          <div className="wb-tpl-row">
            <input className="gc-invite-input wb-tpl-name" placeholder="Name this board to save it as a template" maxLength={60} value={tplName} onChange={(e) => setTplName(e.target.value)} />
            <button type="button" className="wb-btn" onClick={saveTemplate} disabled={!items.length}>💾 Save board as template</button>
          </div>
          {tplMsg && <div className="wb-tpl-msg">{tplMsg}</div>}
          {pendingLoad && (
            <div className="wb-tpl-confirm">
              <span>Load “{pendingLoad.name}”? The board isn't empty:</span>
              <button type="button" className="wb-btn wb-btn-danger" onClick={() => confirmLoad("replace")}>Replace board</button>
              <button type="button" className="wb-btn" onClick={() => confirmLoad("add")}>Add on top</button>
              <button type="button" className="wb-btn" onClick={() => setPendingLoad(null)}>Cancel</button>
            </div>
          )}
          {isHost ? (
            <div className="wb-tpl-section">
              <div className="wb-tpl-heading">Starter templates</div>
              <div className="wb-tpl-starters">
                {STARTERS.map((s) => (
                  <button key={s.key} type="button" className="wb-btn" onClick={() => pickTemplate({ name: s.name, items: s.items })}>{s.icon} {s.name}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="wb-tpl-msg">Only the host can load a template onto the board. You can still save this board to your own templates.</div>
          )}
          <div className="wb-tpl-section">
            <div className="wb-tpl-heading">My templates</div>
            {templates.length === 0 && <div className="wb-tpl-msg">No saved templates yet.</div>}
            {templates.map((t) => (
              <div key={t.id} className="wb-tpl-item">
                {renamingId === t.id ? (
                  <>
                    <input className="gc-invite-input wb-tpl-name" maxLength={60} value={renameDraft} autoFocus
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") renameTemplate(t.id); if (e.key === "Escape") setRenamingId(null); }} />
                    <button type="button" className="wb-btn" onClick={() => renameTemplate(t.id)}>Save</button>
                    <button type="button" className="wb-btn" onClick={() => setRenamingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="wb-tpl-title">{t.name}</span>
                    <span className="wb-tpl-meta">{t.count || 0} items{t.createdAt ? ` · ${new Date(t.createdAt).toLocaleDateString()}` : ""}</span>
                    {isHost && <button type="button" className="wb-btn" onClick={() => pickTemplate({ id: t.id, name: t.name })}>Load</button>}
                    <button type="button" className="wb-btn" onClick={() => { setRenamingId(t.id); setRenameDraft(t.name || ""); }}>Rename</button>
                    <button type="button" className="wb-btn wb-btn-danger" onClick={() => deleteTemplate(t.id)}>{confirmDeleteId === t.id ? "Tap again" : "Delete"}</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {(tool === "text" || tool === "note") && (
        <input
          className="gc-invite-input wb-text-input"
          placeholder={tool === "note" ? "Type a sticky note, then click the board to place it" : "Type text, then click the board to place it"}
          maxLength={200}
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
        />
      )}
      <div className="wb-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={"wb-canvas" + (tool === "text" || tool === "note" ? " wb-canvas-text" : tool === "move" ? " wb-canvas-move" : "")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      <div className="wb-hint">
        Everyone can draw{isHost ? " · only you (host) can load templates or clear the board" : ""} · 📋 Templates saves this board for reuse · text is translated into each viewer's caption language
      </div>
    </div>
  );
}
