// Per-user Contacts list for the Phone tab. Stored in the same Firebase Realtime
// Database Group Chat/Video Call already use, under contacts/{uid}/{contactId} — scoped
// to each user's own uid so contacts are private by default (security rule added
// separately). Kept as its own hook (mirrors useTranslationHistory.js's shape) rather
// than inlined in Phone.jsx so it's reusable if another tab ever wants to read/write the
// same list (e.g. converting a past call in History into a saved contact).
import { useCallback, useEffect, useState } from "react";
import { ref, push, update, remove, onValue, off } from "firebase/database";
import { db } from "../firebase.js";

export function useContacts(uid) {
  const [contacts, setContacts] = useState([]);

  useEffect(() => {
    if (!uid) {
      setContacts([]);
      return;
    }
    const contactsRef = ref(db, `contacts/${uid}`);
    const handler = (snapshot) => {
      const val = snapshot.val() || {};
      const list = Object.entries(val).map(([id, c]) => ({ id, ...c }));
      list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setContacts(list);
    };
    // Explicit error callback — same reasoning as VideoCall.jsx's caption listener: a
    // permissions error on this specific path would otherwise throw once into the void
    // with nothing distinguishing it from "no contacts saved yet."
    onValue(contactsRef, handler, (err) => console.error("[contacts] listener error (permissions?):", err));
    return () => off(contactsRef, "value", handler);
  }, [uid]);

  const addContact = useCallback(
    (contact) => {
      if (!uid) return Promise.reject(new Error("Not signed in"));
      return push(ref(db, `contacts/${uid}`), contact);
    },
    [uid],
  );

  const updateContact = useCallback(
    (id, patch) => {
      if (!uid) return Promise.reject(new Error("Not signed in"));
      return update(ref(db, `contacts/${uid}/${id}`), patch);
    },
    [uid],
  );

  const deleteContact = useCallback(
    (id) => {
      if (!uid) return Promise.reject(new Error("Not signed in"));
      return remove(ref(db, `contacts/${uid}/${id}`));
    },
    [uid],
  );

  return { contacts, addContact, updateContact, deleteContact };
}
