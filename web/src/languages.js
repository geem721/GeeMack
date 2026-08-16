// Single source of truth for every language dropdown in the app.
//
// This file exists specifically to fix the drift documented in POSTMORTEM.md and
// MIGRATION_PLAN.md: the old public/index.html had four independently hand-typed
// language lists (Translate, Camera OCR, Documents, Group Chat) that fell out of sync
// with each other over several months. Every panel in the React app imports this same
// list instead of defining its own.
//
// 29 languages total: the 26 that were live in public/index.html's Translate tab as of
// 2026-08-16, plus Hebrew, Romanian, and Hungarian — three languages that existed in the
// original React app (added 2026-05-10, commit fd5a5fe) but were lost when that app was
// replaced and never made it into any version of public/index.html. Restoring them here
// was an explicit decision, confirmed 2026-08-16 (see MIGRATION_PLAN.md).
export const LANGUAGES = [
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "es", label: "Spanish", flag: "🇪🇸" },
  { code: "fr", label: "French", flag: "🇫🇷" },
  { code: "de", label: "German", flag: "🇩🇪" },
  { code: "it", label: "Italian", flag: "🇮🇹" },
  { code: "pt", label: "Portuguese", flag: "🇧🇷" },
  { code: "zh", label: "Chinese", flag: "🇨🇳" },
  { code: "ja", label: "Japanese", flag: "🇯🇵" },
  { code: "ko", label: "Korean", flag: "🇰🇷" },
  { code: "ar", label: "Arabic", flag: "🇸🇦" },
  { code: "ru", label: "Russian", flag: "🇷🇺" },
  { code: "hi", label: "Hindi", flag: "🇮🇳" },
  { code: "sw", label: "Swahili", flag: "🌍" },
  { code: "nl", label: "Dutch", flag: "🇳🇱" },
  { code: "pl", label: "Polish", flag: "🇵🇱" },
  { code: "tr", label: "Turkish", flag: "🇹🇷" },
  { code: "vi", label: "Vietnamese", flag: "🇻🇳" },
  { code: "th", label: "Thai", flag: "🇹🇭" },
  { code: "uk", label: "Ukrainian", flag: "🇺🇦" },
  { code: "id", label: "Indonesian", flag: "🇮🇩" },
  { code: "fa", label: "Persian", flag: "🇮🇷" },
  { code: "bn", label: "Bengali", flag: "🇧🇩" },
  { code: "el", label: "Greek", flag: "🇬🇷" },
  { code: "sv", label: "Swedish", flag: "🇸🇪" },
  { code: "cs", label: "Czech", flag: "🇨🇿" },
  { code: "ur", label: "Urdu", flag: "🇵🇰" },
  // Restored from the original React app (fd5a5fe, 2026-05-10) — never carried over into
  // public/index.html. See POSTMORTEM.md.
  { code: "he", label: "Hebrew", flag: "🇮🇱" },
  { code: "ro", label: "Romanian", flag: "🇷🇴" },
  { code: "hu", label: "Hungarian", flag: "🇭🇺" },
];

// Special "auto-detect" pseudo-option, valid only as a *source* language (used today by
// the Translate tab's srcLang dropdown). Not a real language code — callers that build a
// source-language dropdown should prepend this; target-language dropdowns should not.
export const AUTO_DETECT = { code: "auto", label: "Auto-Detect", flag: "🔍" };

export function findLanguage(code) {
  return LANGUAGES.find((l) => l.code === code);
}

export function languageLabel(code) {
  const lang = findLanguage(code);
  return lang ? `${lang.flag} ${lang.label}` : code;
}
