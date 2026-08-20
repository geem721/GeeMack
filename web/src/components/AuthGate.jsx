import { useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import { useToast } from "./Toast.jsx";
import "./AuthGate.css";

// App-wide sign-in wall, wrapping the entire app in App.jsx (restored 2026-08-20 — the
// 2026-08-18 narrowing to only Group Chat/Video Call was reconsidered: the owner needs
// to see/manage/verify every account, which requires everyone to have one). Group Chat
// and Video Call no longer render their own AuthGate; they read `user`/`signOutUser`
// straight from useAuth() since identity is now guaranteed before any tab is reachable.
//
// Render-props children: <AuthGate featureName="Group Chat">{(user, signOutUser) => ...}
// </AuthGate>. Only invoked once signed in AND email-verified, so the wrapped feature
// never has to re-check auth state itself.

const ERROR_MESSAGES = {
  "auth/user-not-found": "Invalid email or password.",
  "auth/wrong-password": "Invalid email or password.",
  "auth/invalid-credential": "Invalid email or password.",
  "auth/too-many-requests": "Too many attempts. Try again shortly.",
  "auth/email-already-in-use": "Email already in use.",
  "auth/weak-password": "Password must be at least 6 characters.",
  "auth/invalid-email": "Enter a valid email address.",
};

function authErrorMessage(e, fallback) {
  return ERROR_MESSAGES[e?.code] || fallback;
}

export default function AuthGate({ featureName, children }) {
  const { user, loading, signIn, signUp, signOutUser, resendVerification, reloadUser } =
    useAuth();
  const { showToast } = useToast();
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) {
    return <div className="auth-gate-loading">Checking sign-in status…</div>;
  }

  if (user && user.emailVerified) {
    return children(user, signOutUser);
  }

  if (user && !user.emailVerified) {
    return (
      <div className="auth-gate">
        <div className="auth-gate-box">
          <div className="auth-gate-icon">📧</div>
          <div className="auth-gate-title">Verify Your Email</div>
          <div className="auth-gate-sub">
            We sent a verification link to {user.email}. Check your inbox, click it, then
            continue.
          </div>
          {error && <div className="auth-gate-error">{error}</div>}
          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              await reloadUser();
              setBusy(false);
            }}
          >
            {busy ? <span className="spinner" /> : "I've Verified — Continue"}
          </button>
          <button
            className="btn btn-secondary"
            style={{ width: "100%", marginTop: 8 }}
            disabled={busy}
            onClick={async () => {
              try {
                await resendVerification();
                showToast("Verification email sent!");
              } catch {
                setError("Could not send email.");
              }
            }}
          >
            Resend Email
          </button>
          <button className="auth-gate-link" onClick={() => signOutUser()}>
            Wrong account? Sign out
          </button>
        </div>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }
    if (mode === "signup") {
      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
        await resendVerification();
      }
    } catch (err) {
      setError(authErrorMessage(err, mode === "login" ? "Sign in failed." : "Sign up failed."));
    }
    setBusy(false);
  }

  return (
    <div className="auth-gate">
      <div className="auth-gate-box">
        <div className="auth-gate-icon">🔒</div>
        <div className="auth-gate-title">{mode === "login" ? "Sign In" : "Create Account"}</div>
        <div className="auth-gate-sub">
          Sign in to use {featureName}.
        </div>
        {error && <div className="auth-gate-error">{error}</div>}
        <form onSubmit={handleSubmit} className="auth-gate-form">
          <input
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder={mode === "signup" ? "Min. 6 characters" : "••••••••"}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "signup" && (
            <input
              type="password"
              placeholder="Repeat password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>
        <button
          className="auth-gate-link"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
          }}
        >
          {mode === "login"
            ? "Don't have an account? Sign up free"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
