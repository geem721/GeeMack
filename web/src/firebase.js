// Firebase init — shared by Group Chat (Phase 4) and, later, Video Call (Phase 5), since
// both need Auth (who's signed in) and Realtime Database (rooms/messages/presence/
// captions). Single instance created here and imported everywhere else, instead of each
// tab calling initializeApp() itself.
//
// This config is copied verbatim from public/index.html's inline <script type="module">.
// It's not a secret — Firebase web config is meant to be public (it's already sitting in
// the live page's HTML source today); access control is enforced by Firebase Auth plus
// Realtime Database security rules on the project itself, not by hiding this object.
// Using the same project means the React app and the legacy app share the same users,
// rooms, and messages during the migration — sign up in one, you're signed up in both.
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDDkUS5iEoFD9oI9_KH7KzcBqADrVWStQ4",
  authDomain: "talkbridge-492fa.firebaseapp.com",
  projectId: "talkbridge-492fa",
  storageBucket: "talkbridge-492fa.firebasestorage.app",
  messagingSenderId: "856676672332",
  appId: "1:856676672332:web:d508705c05a7b2238325e9",
  measurementId: "G-1K6LCTZ4C0",
  databaseURL: "https://talkbridge-492fa-default-rtdb.firebaseio.com",
};

// getApps()/getApp() guard avoids a "duplicate app" crash if Vite HMR re-runs this module.
export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getDatabase(firebaseApp);
