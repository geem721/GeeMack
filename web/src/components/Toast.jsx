import { createContext, useCallback, useContext, useRef, useState } from "react";
import "./Toast.css";

// Shared toast infrastructure — Phase 1 establishes this so every later tab (Camera OCR,
// Documents, Group Chat, Video Call) can reuse the same showToast(message, duration)
// pattern the legacy public/index.html app used globally, instead of each tab rolling
// its own notification UI.
const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null); // { message } | null
  const timerRef = useRef(null);

  const showToast = useCallback((message, duration = 2000) => {
    clearTimeout(timerRef.current);
    setToast({ message });
    timerRef.current = setTimeout(() => setToast(null), duration);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className={"toast" + (toast ? " show" : "")}>{toast?.message ?? ""}</div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
