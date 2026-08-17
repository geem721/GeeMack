// Shared TTS mechanics — pulled out of Translate.jsx during Phase 3 since Documents
// needs the same speak-with-limited-language-warning behavior. Callers own the UI
// feedback (toast / warning modal); this module just does the SpeechSynthesis work.

// Browsers with tested-limited/no native TTS voices for these languages, carried over
// unchanged from the legacy app's TTS_LIMITED set (public/index.html). Not extended to
// he/ro/hu (new in the shared 29-language list) since that would be a guess rather than
// an observed fact — revisit if real usage shows silent audio for those.
export const TTS_LIMITED = new Set([
  "ar", "hi", "sw", "tr", "vi", "th", "uk", "id", "fa", "bn", "ur", "ko",
]);

// BCP-47 tags for SpeechRecognition.lang / SpeechSynthesisUtterance.lang. Extends the
// legacy app's CAPTION_LANG_MAP (26 languages) with he/ro/hu for the shared 29-language
// list from Phase 0.
export const SPEECH_LANG_MAP = {
  en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR",
  zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", ar: "ar-SA", ru: "ru-RU", hi: "hi-IN",
  sw: "sw", nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", vi: "vi-VN", th: "th-TH",
  uk: "uk-UA", id: "id-ID", fa: "fa-IR", bn: "bn-BD", el: "el-GR", sv: "sv-SE",
  cs: "cs-CZ", ur: "ur-PK", he: "he-IL", ro: "ro-RO", hu: "hu-HU",
};

export function speakNow(text, langCode) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = SPEECH_LANG_MAP[langCode] || langCode;
  speechSynthesis.speak(utterance);
}

/**
 * Speak `text` in `langCode`, routing through the TTS_LIMITED warning when relevant.
 * Returns "unsupported" | "empty" | "warned" | "spoke" so callers can toast accordingly.
 */
export function speakWithCheck(text, langCode, { onWarn } = {}) {
  if (!window.speechSynthesis) return "unsupported";
  if (!text) return "empty";
  if (TTS_LIMITED.has(langCode)) {
    onWarn?.(() => speakNow(text, langCode));
    return "warned";
  }
  speakNow(text, langCode);
  return "spoke";
}
