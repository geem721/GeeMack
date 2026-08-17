import { useCallback, useEffect, useState } from "react";

// Same localStorage key the legacy public/index.html app uses. Since the React preview
// is served from the same origin (talk-bridge.org), this deliberately shares history
// with the classic app rather than starting a disconnected list — no migration needed.
const STORAGE_KEY = "tb_history";
const MAX_ENTRIES = 100;

function readHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useTranslationHistory() {
  const [history, setHistory] = useState(readHistory);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  const addEntry = useCallback((entry) => {
    setHistory((prev) =>
      [{ id: Date.now(), time: new Date().toLocaleString(), ...entry }, ...prev].slice(
        0,
        MAX_ENTRIES,
      ),
    );
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  return { history, addEntry, clearHistory };
}
