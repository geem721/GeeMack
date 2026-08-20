import { createContext, useCallback, useContext, useEffect, useState } from "react";
// Shared, persisted app-behavior settings — the toggles the legacy app kept in its
// Settings panel (Translation/Camera OCR/Voice sections). Phases 1 and 2 shipped these
// as local, unpersisted state inside Translate.jsx/CameraOCR.jsx themselves (documented
// there as a deliberate stand-in since no Settings tab existed yet). Now that Settings
// is built, this is the single shared source both tabs read from, and Settings.jsx is
// the only place that writes to it.
//
// Deliberately persisted to localStorage — the legacy app's toggles reset to defaults on
// every reload (plain onclick class-toggles, no storage backing, confirmed in
// public/index.html). That's a real limitation there, not a design choice worth
// preserving; persisting here is strictly better with no downside, so this doesn't match
// legacy byte-for-byte on that one point.
const STORAGE_KEY = "tb_settings";
const DEFAULTS = {
  autoTranslate: true,
  saveHistory: true,
  extendedListen: true,
  useBackCamera: true,
  autoCapture: false,
};
function readSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}
const SettingsContext = createContext(null);
export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(readSettings);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);
  const updateSetting = useCallback((key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);
  return (
    <SettingsContext.Provider value={{ settings, updateSetting }}>
      {children}
    </SettingsContext.Provider>
  );
}
export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
