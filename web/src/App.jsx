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

export default function App() {
  const [activeTab, setActiveTab] = useState("translate");
  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const ActiveComponent = active.Component;

  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-title">TalkBridge</span>
          <span className="app-subtitle">React rebuild — Phase 3: Documents tab</span>
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
          <ActiveComponent />
        </main>
      </div>
    </ToastProvider>
  );
}
