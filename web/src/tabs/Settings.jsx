import { useAuth } from "../hooks/useAuth.js";
import { useSettings } from "../hooks/useSettings.jsx";
import "./Settings.css";
// Centralizes the behavior toggles Phase 1 (Translate) and Phase 2 (Camera OCR) shipped
// as local, unpersisted state — see useSettings.jsx for why this reads/writes a shared,
// persisted store instead. Account section reuses the same useAuth() every other tab
// already depends on (identity is guaranteed by the app-wide AuthGate by the time any
// tab renders). Legacy's Auto Language Detection and Text-to-Speech toggles are
// deliberately NOT ported — confirmed via grep that neither ever gated any real behavior
// in public/index.html (no code referenced those two toggle ids anywhere else), and
// Phase 1 already made the same call by never building them. Not a regression; matching
// what was actually real, not what looked real.
export default function Settings() {
  const { user, signOutUser } = useAuth();
  const { settings, updateSetting } = useSettings();
  return (
    <div className="settings-tab">
      <div className="quick-settings">
        <div className="settings-title">Account</div>
        <div className="account-row">
          <div className="account-avatar">👤</div>
          <div>
            <div className="account-name">TalkBridge User</div>
            <div className="account-email">{user?.email || "—"}</div>
          </div>
        </div>
        <button className="btn btn-danger" style={{ width: "100%" }} onClick={signOutUser}>
          Sign Out
        </button>
      </div>
      <div className="quick-settings">
        <div className="settings-title">Translation</div>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.autoTranslate}
            onChange={(e) => updateSetting("autoTranslate", e.target.checked)}
          />
          Auto-translate as you type (1.5s pause)
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.saveHistory}
            onChange={(e) => updateSetting("saveHistory", e.target.checked)}
          />
          Save to history
        </label>
      </div>
      <div className="quick-settings">
        <div className="settings-title">Camera OCR</div>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.useBackCamera}
            onChange={(e) => updateSetting("useBackCamera", e.target.checked)}
          />
          Use back camera
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.autoCapture}
            onChange={(e) => updateSetting("autoCapture", e.target.checked)}
          />
          Auto-capture mode (every 4 seconds)
        </label>
      </div>
      <div className="quick-settings">
        <div className="settings-title">Voice</div>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.extendedListen}
            onChange={(e) => updateSetting("extendedListen", e.target.checked)}
          />
          Extended listening mode (3s pause before mic stops)
        </label>
      </div>
      <div className="settings-footer">
        TalkBridge — React build
        <br />
        Powered by Claude AI
      </div>
    </div>
  );
}
