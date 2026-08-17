// Shared /api/translate client — used by Translate (Phase 1) and Camera OCR (Phase 2),
// and will be needed again by Documents (Phase 3). Pulled out here instead of
// duplicating the same fetch in every tab.
export async function callTranslate(text, srcLang, tgtLang) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, srcLang, tgtLang }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}
