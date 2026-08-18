import { lazy, Suspense, useState } from "react";
import "./App.css";
import "./shared.css";
import { ToastProvider } from "./components/Toast.jsx";
import Translate from "./tabs/Translate.jsx";
import CameraOCR from "./tabs/CameraOCR.jsx";
import Documents from "./tabs/Documents.jsx";
import History from "./tabs/History.jsx";
import Settings from "./tabs/Settings.jsx";
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
  const room = params.get("room");
  if (!room || !ROOMS.includes(room)) return { tab: null, room: null };
  const tab = params.get("tab") === "videocall" ? "videocall" : "groupchat";
  return { tab, room };
}

export default function App() {
  const [{ tab: initialTab, room: initialRoom }] = useState(initialRouteFromUrl);
  const [activeTab, setActiveTab] = useState(initialTab ?? "translate");
  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const ActiveComponent = active.Component;

  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-title">TalkBridge</span>
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
            ) : (
              <ActiveComponent />
            )}
          </Suspense>
        </main>
      </div>
    </ToastProvider>
  );
}
