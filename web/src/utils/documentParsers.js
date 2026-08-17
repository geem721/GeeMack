// Phase 3 fix: the legacy Documents tab (public/index.html) advertised support for
// PDF/DOCX/XLSX/PPTX/EPUB/ODT/etc. via its UI, but its actual code only ever called
// FileReader.readAsText() on every non-image file — which reads real binary formats as
// garbled raw bytes, not their actual text content. Confirmed by reading the legacy JS,
// not assumed. Per explicit user direction ("if it's included it has to work"), this
// module gives every advertised format a real parser instead of carrying the bug
// forward.
//
// Each parser library is dynamically imported (only loaded when that file type is
// actually opened) so the main app bundle isn't bloated for tabs/files that never touch
// pdf.js / mammoth / xlsx / jszip.

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsText(file, "UTF-8");
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// Block-level tag local names, across HTML/XHTML and ODF's XML vocabulary (text:p,
// text:h, text:list-item, table:table-row) — used to insert line breaks between blocks
// so e.g. a heading and the paragraph after it don't get glued into one word
// ("TitleThe quick brown fox…"). Matched by localName so XML namespace prefixes
// (the "text:" in ODF's <text:p>) don't matter.
const BLOCK_TAGS = new Set([
  "p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "h", "li", "list-item",
  "tr", "table-row", "blockquote", "section", "article", "header", "footer", "pre",
]);

function collectBlockText(node, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const child of node.childNodes) collectBlockText(child, out);
  if (BLOCK_TAGS.has(node.localName?.toLowerCase())) out.push("\n");
}

// Strips tags from HTML/XML-ish markup down to visible text, via the browser's own
// parser rather than regex (regex-stripping HTML is a well-known way to get it subtly
// wrong on real-world markup), preserving block-level line breaks so text doesn't run
// together.
function extractVisibleText(markup, mimeType = "text/html") {
  const doc = new DOMParser().parseFromString(markup, mimeType);
  const root = doc.body || doc.documentElement;
  const out = [];
  collectBlockText(root, out);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Small RTF-to-text mini-parser (brace-depth aware, not a full RTF spec
// implementation, but correct enough for real-world simple RTF exports — verified
// against a hand-built test file with a font table before shipping this). A pure
// regex pass (an earlier version of this function) let font/color/style table names
// leak into the output, since those live in nested {\fonttbl{...}} groups that regex
// can't reliably balance; this walks the string tracking brace depth instead.
const RTF_SKIP_GROUPS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "generator",
  "pict", "object", "footnote", "header", "footer",
]);

function stripRtf(rtfSource) {
  // Real paragraph/line breaks are always encoded as \par / \line control words, not
  // raw newline bytes — any literal \r\n in the source is just incidental formatting
  // whitespace around control words, so it's safe (and necessary) to drop up front.
  const rtf = rtfSource.replace(/[\r\n]+/g, "");
  const n = rtf.length;
  let i = 0;
  let out = "";
  let depth = 0;
  let skipDepth = null; // brace depth where a skip-group started, or null if not skipping

  while (i < n) {
    const ch = rtf[i];

    if (ch === "{") {
      depth++;
      if (skipDepth === null && rtf[i + 1] === "\\") {
        if (rtf[i + 2] === "*") {
          skipDepth = depth; // \* generic-destination marker — always skippable
        } else {
          let k = i + 2;
          let word = "";
          while (k < n && /[a-zA-Z]/.test(rtf[k])) {
            word += rtf[k];
            k++;
          }
          if (RTF_SKIP_GROUPS.has(word)) skipDepth = depth;
        }
      }
      i++;
      continue;
    }

    if (ch === "}") {
      if (skipDepth !== null && depth === skipDepth) skipDepth = null;
      depth--;
      i++;
      continue;
    }

    if (skipDepth !== null) {
      i++;
      continue;
    }

    if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === "'") {
        out += String.fromCharCode(parseInt(rtf.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      if (next === "\\" || next === "{" || next === "}") {
        out += next;
        i += 2;
        continue;
      }
      if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        let word = "";
        while (j < n && /[a-zA-Z]/.test(rtf[j])) {
          word += rtf[j];
          j++;
        }
        while (j < n && /[0-9-]/.test(rtf[j])) j++; // optional numeric parameter
        if (rtf[j] === " ") j++; // the one delimiter space after a control word is eaten
        if (word === "par" || word === "line") out += "\n";
        else if (word === "tab") out += "\t";
        i = j;
        continue;
      }
      // control symbol (\~, \_, \-, etc.) — no readable text value, just skip it
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

async function parsePdf(file) {
  const pdfjsLib = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const buffer = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n\n").trim();
}

async function parseDocx(file) {
  const mammoth = (await import("mammoth")).default;
  const buffer = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value.trim();
}

async function parseSpreadsheet(file) {
  const XLSX = await import("xlsx");
  const buffer = await readAsArrayBuffer(file);
  const workbook = XLSX.read(buffer, { type: "array" });
  return workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    return `# ${name}\n${csv.trim()}`;
  })
    .join("\n\n")
    .trim();
}

// PPTX is a zip of OOXML slide XML files (ppt/slides/slideN.xml). No dedicated
// lightweight browser PPTX-text library exists, but the format is simple enough to pull
// text runs (<a:t>) out of directly via JSZip + DOMParser.
async function parsePptx(file) {
  const JSZip = (await import("jszip")).default;
  const buffer = await readAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const numB = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return numA - numB;
    });

  if (!slideFiles.length) throw new Error("No slides found in this .pptx file");

  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const textNodes = Array.from(doc.getElementsByTagNameNS("*", "t"));
    const slideText = textNodes.map((n) => n.textContent).join(" ").trim();
    if (slideText) slides.push(slideText);
  }
  return slides.map((s, i) => `# Slide ${i + 1}\n${s}`).join("\n\n").trim();
}

// EPUB is a zip: META-INF/container.xml points at the OPF, whose <spine> lists the
// chapter XHTML files in reading order.
async function parseEpub(file) {
  const JSZip = (await import("jszip")).default;
  const buffer = await readAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(buffer);

  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Not a valid EPUB (missing container.xml)");
  const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
  const opfPath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("Not a valid EPUB (missing OPF rootfile)");

  const opfXml = await zip.file(opfPath)?.async("string");
  if (!opfXml) throw new Error("Not a valid EPUB (OPF file missing)");
  const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const manifest = {};
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  });

  const spineIds = Array.from(opfDoc.querySelectorAll("spine > itemref")).map((ref) =>
    ref.getAttribute("idref"),
  );

  const chapters = [];
  for (const id of spineIds) {
    const href = manifest[id];
    if (!href) continue;
    const path = opfDir + href;
    const xhtml = await zip.file(path)?.async("string");
    if (!xhtml) continue;
    const text = extractVisibleText(xhtml, "application/xhtml+xml");
    if (text) chapters.push(text);
  }
  return chapters.join("\n\n").trim();
}

// ODT/ODS/ODP (OpenDocument) are all zips with a content.xml holding the real text.
// Walking all text nodes doesn't preserve table/slide structure, but gets readable text
// out for translation purposes, which is what this tab needs.
async function parseOpenDocument(file) {
  const JSZip = (await import("jszip")).default;
  const buffer = await readAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file("content.xml")?.async("string");
  if (!contentXml) throw new Error("Not a valid OpenDocument file (missing content.xml)");
  return extractVisibleText(contentXml, "application/xml");
}

const EXTRACTORS = {
  pdf: parsePdf,
  docx: parseDocx,
  xlsx: parseSpreadsheet,
  xls: parseSpreadsheet,
  pptx: parsePptx,
  epub: parseEpub,
  odt: parseOpenDocument,
  ods: parseOpenDocument,
  odp: parseOpenDocument,
};

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"]);
const PLAIN_TEXT_EXTS = new Set(["txt", "md", "csv"]);

// Old binary (pre-2007) Office formats are proprietary OLE compound files — there's no
// practical client-side parser for them (would need something like a WASM LibreOffice
// build). Rather than silently feeding garbage through readAsText like the legacy app
// did, fail clearly and tell the user what to do instead.
const UNSUPPORTED_BINARY_EXTS = new Set(["doc", "ppt"]);

export async function extractDocumentText(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    if (!window.Tesseract) throw new Error("OCR engine still loading — try again in a moment");
    const {
      data: { text },
    } = await window.Tesseract.recognize(file, "eng+spa+fra+deu+chi_sim");
    return text.trim();
  }

  if (UNSUPPORTED_BINARY_EXTS.has(ext)) {
    throw new Error(
      `Legacy .${ext} format isn't supported — please save/export as .${ext === "doc" ? "docx" : "pptx"} and try again`,
    );
  }

  if (ext === "rtf") return stripRtf(await readAsText(file));
  if (ext === "html" || ext === "htm") return extractVisibleText(await readAsText(file));
  if (PLAIN_TEXT_EXTS.has(ext)) return (await readAsText(file)).trim();

  const extractor = EXTRACTORS[ext];
  if (extractor) return extractor(file);

  // Unknown extension: best-effort plain-text fallback, same as the legacy app's
  // catch-all — better than an outright refusal for a format we didn't anticipate.
  return (await readAsText(file)).trim();
}

export function getFileIcon(ext) {
  return (
    {
      pdf: "📕", doc: "📝", docx: "📝", xls: "📊", xlsx: "📊", ppt: "📊", pptx: "📊",
      txt: "📄", md: "📄", epub: "📚", rtf: "📄", csv: "📊", html: "🌐", htm: "🌐",
      odt: "📝", ods: "📊", odp: "📊",
      jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", bmp: "🖼️", webp: "🖼️", tiff: "🖼️",
    }[ext] || "📄"
  );
}

export function chunkText(text, size) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = i + size;
    if (end < text.length) {
      const brk = text.lastIndexOf("\n\n", end);
      if (brk > i + size / 2) end = brk;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}
