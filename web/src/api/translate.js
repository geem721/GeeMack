// Shared /api/translate client — used by Translate, Camera OCR, Documents, Group Chat,
// and Video Call. Pulled out here instead of duplicating the same fetch in every tab.
//
// Requires a signed-in user: the server verifies a Firebase ID token to identify who's
// calling (needed for the monthly fair-use translation cap), so this attaches the
// current user's token as a Bearer header on every call.
import { auth } from "../firebase.js";

export async function callTranslate(text, srcLang, tgtLang) {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in to translate.");
  const token = await user.getIdToken();
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text, srcLang, tgtLang }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}
