import { lazy, Suspense, useState, useEffect } from "react";
import "./App.css";
import "./shared.css";
import { ToastProvider } from "./components/Toast.jsx";
import AuthGate from "./components/AuthGate.jsx";
import { SettingsProvider } from "./hooks/useSettings.jsx";
import Translate from "./tabs/Translate.jsx";
import CameraOCR from "./tabs/CameraOCR.jsx";
import Documents from "./tabs/Documents.jsx";
import History from "./tabs/History.jsx";
import Settings from "./tabs/Settings.jsx";
import Phone from "./tabs/Phone.jsx";
import { ROOMS } from "./rooms.js";

// Group Chat and Video Call are lazy-loaded — both pull in Firebase, and Video Call
// additionally pulls in livekit-client, together large enough to push the main bundle
// past 500kB and trip Vite's chunk-size warning once Phase 5 added livekit-client on top
// of Phase 4's Firebase. Without splitting, everyone landing on Translate (the most-used
// tab, and the one with zero auth/calling dependencies) would download both SDKs before
// ever touching either feature. Same reasoning Documents.jsx already applies to
// pdfjs-dist/mammoth/xlsx/jszip via dynamic import() — heavy, feature-specific
// dependencies shouldn't tax every visitor.
const GroupChat = lazy(() => import("./tabs/GroupChat.jsx"));
const VideoCall = lazy(() => import("./tabs/VideoCall.jsx"));
const Meetings = lazy(() => import("./tabs/Meetings.jsx"));

// Nav shell — Phase 0 of MIGRATION_PLAN.md. Video Call is its own top-level tab
// (not nested inside Group Chat) per the 2026-08-16 decision.
const TABS = [
  { key: "translate", label: "Translate", icon: "🌐", Component: Translate },
  { key: "camera", label: "Camera OCR", icon: "📷", Component: CameraOCR },
  { key: "documents", label: "Documents", icon: "📄", Component: Documents },
  { key: "groupchat", label: "Group Chat", icon: "💬", Component: GroupChat },
  { key: "videocall", label: "Video Call", icon: "📹", Component: VideoCall },
  { key: "meetings", label: "Meetings", icon: "🤝", Component: Meetings },
  { key: "phone", label: "Phone", icon: "📞", Component: Phone },
  { key: "history", label: "History", icon: "🕐", Component: History },
  { key: "settings", label: "Settings", icon: "⚙️", Component: Settings },
];

// Invite links (Group Chat's and, as of Phase 5, Video Call's copyInviteLink) carry a
// ?room= query param, optionally with &tab=videocall, so a shared link drops the
// recipient straight into the right room on the right tab. Read once on load, before
// React state exists, since window.location won't change during the session. Defaulting
// an untagged ?room= link to Group Chat preserves every invite link generated before
// Phase 5 existed. Auto-selecting the tab on arrival (rather than just highlighting the
// room, like legacy did) is a small, deliberate UX improvement, not a parity
// requirement.
function initialRouteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  // Meeting links (?tab=meetings&meeting=<id>) are a separate case from the room-based
  // ones below — meeting IDs are dynamic (server-generated), not from the fixed ROOMS
  // list, so they can't be validated against it the way room= is.
  const meeting = params.get("meeting");
  if (meeting && params.get("tab") === "meetings") {
    return { tab: "meetings", room: null, meeting };
  }
  const room = params.get("room");
  if (!room || !ROOMS.includes(room)) return { tab: null, room: null, meeting: null };
  const tab = params.get("tab") === "videocall" ? "videocall" : "groupchat";
  return { tab, room, meeting: null };
}

function getInitialTheme() {
  try {
    const saved = localStorage.getItem("talkbridge-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch (e) {}
  return "light";
}

export default function App() {
  const [{ tab: initialTab, room: initialRoom, meeting: initialMeetingId }] = useState(initialRouteFromUrl);
  const [activeTab, setActiveTab] = useState(initialTab ?? "translate");
  const [theme, setTheme] = useState(getInitialTheme);
  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const ActiveComponent = active.Component;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("talkbridge-theme", theme);
    } catch (e) {}
  }, [theme]);

  return (
    <ToastProvider>
      <SettingsProvider>
      <AuthGate featureName="TalkBridge">
        {(user, signOutUser) => (
          <div className="app-shell">
            <header className="app-header">
              <span className="app-title">TalkBridge</span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  type="button"
                  className="theme-toggle"
                  aria-label="Switch to light mode"
                  aria-pressed={theme === "light"}
                  onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                >
                  <span className="theme-toggle-track"><span className="theme-toggle-thumb" /></span>
                  <span>{theme === "dark" ? "Dark" : "Light"}</span>
                </button>
                <span style={{ fontSize: 14, opacity: 0.8 }}>{user.email}</span>
                <button className="btn btn-secondary" onClick={signOutUser}>
                  Sign Out
                </button>
              </div>
            </header>

            <nav className="tab-nav">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  className={"nav-btn" + (tab.key === activeTab ? " active" : "")}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span className="icon">{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </nav>

            <main className="tab-content">
              <Suspense fallback={<div className="tab-loading">Loading…</div>}>
                {active.key === "groupchat" || active.key === "videocall" ? (
                  <ActiveComponent initialRoom={initialRoom} />
                ) : active.key === "meetings" ? (
                  <ActiveComponent initialMeetingId={initialMeetingId} />
                ) : (
                  <ActiveComponent />
                )}
              </Suspense>
            </main>
          </div>
        )}
      </AuthGate>
      </SettingsProvider>
    </ToastProvider>
  );
}
