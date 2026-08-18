import { useState } from "react";
import "./App.css";
import "./shared.css";
import { ToastProvider } from "./components/Toast.jsx";
import Translate from "./tabs/Translate.jsx";
import CameraOCR from "./tabs/CameraOCR.jsx";
import Documents from "./tabs/Documents.jsx";
import GroupChat from "./tabs/GroupChat.jsx";
import VideoCall from "./tabs/VideoCall.jsx";
import History from "./tabs/History.jsx";
import Settings from "./tabs/Settings.jsx";

// Nav shell — Phase 0 of MIGRATION_PLAN.md. Video Call is its own top-level tab
// (not nested inside Group Chat) per the 2026-08-16 decision.
const TABS = [
  { key: "translate", label: "Translate", icon: "🌐", Component: Translate },
  { key: "camera", label: "Camera OCR", icon: "📷", Component: CameraOCR },
  { key: "documents", label: "Documents", icon: "📄", Component: Documents },
  { key: "groupchat", label: "Group Chat", icon: "💬", Component: GroupChat },
  { key: "videocall", label: "Video Call", icon: "📹", Component: VideoCall },
  { key: "history", label: "History", icon: "🕐", Component: History },
  { key: "settings", label: "Settings", icon: "⚙️", Component: Settings },
];

// Group Chat invite links (see GroupChat.jsx's copyInviteLink) carry a ?room= query
// param so a link shared into any chat/email drops the recipient straight into the right
// room. Read it once on load, before React state exists, since window.location won't
// change during the session. Also auto-selects the Group Chat tab on arrival — a small,
// deliberate UX improvement over the legacy app (which highlighted the room but didn't
// switch panels), not a parity requirement.
function initialRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  return room && ["general", "support", "travel", "business", "casual"].includes(room)
    ? room
    : null;
}

export default function App() {
  const [initialRoom] = useState(initialRoomFromUrl);
  const [activeTab, setActiveTab] = useState(initialRoom ? "groupchat" : "translate");
  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const ActiveComponent = active.Component;

  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-title">TalkBridge</span>
          <span className="app-subtitle">React rebuild — Phase 4: Group Chat tab</span>
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
          {active.key === "groupchat" ? (
            <ActiveComponent initialRoom={initialRoom} />
          ) : (
            <ActiveComponent />
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
