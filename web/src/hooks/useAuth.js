// Thin reactive wrapper around Firebase Auth. Exposes a plain-object user shape
// ({ uid, email, emailVerified }) instead of the raw Firebase User instance — the raw
// instance mutates in place on reload() (used for the email-verification check-again
// flow), which doesn't trigger a React re-render since the object reference never
// changes. Mapping to a plain object on every auth-state change and after every reload()
// sidesteps that gotcha entirely.
import { useCallback, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendEmailVerification,
} from "firebase/auth";
import { auth } from "../firebase.js";

function toPlainUser(u) {
  if (!u) return null;
  return { uid: u.uid, email: u.email, emailVerified: u.emailVerified };
}

export function useAuth() {
  const [user, setUser] = useState(() => toPlainUser(auth.currentUser));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(toPlainUser(u));
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(
    (email, password) => signInWithEmailAndPassword(auth, email, password),
    [],
  );

  const signUp = useCallback(
    (email, password) => createUserWithEmailAndPassword(auth, email, password),
    [],
  );

  const signOutUser = useCallback(() => signOut(auth), []);

  const resendVerification = useCallback(() => {
    if (!auth.currentUser) return Promise.reject(new Error("No user signed in"));
    return sendEmailVerification(auth.currentUser);
  }, []);

  // Re-checks emailVerified after the user clicks the link in their inbox. reload()
  // mutates auth.currentUser in place, so re-map to a fresh plain object to force the
  // state update through.
  const reloadUser = useCallback(async () => {
    if (!auth.currentUser) return;
    await auth.currentUser.reload();
    setUser(toPlainUser(auth.currentUser));
  }, []);

  return { user, loading, signIn, signUp, signOutUser, resendVerification, reloadUser };
}
