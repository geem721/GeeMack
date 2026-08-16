# Project Log

Running, append-only record of what happened each session. **Newest entries at the top.**
Read this (and `MIGRATION_PLAN.md`) before starting any work in this repo — see
`CLAUDE.md`.

---

## 2026-08-16 (session: bug-fix marathon + React migration decision)

**Context:** Started as a bug-fix session for TalkBridge's video-call translation
("always translates to Spanish"). Ended with a decision to migrate the whole app to
React, after discovering the app was silently reverted from React to a single-file HTML
app back in May.

**Completed this session (all committed to `master`, verified live on Apollo1):**
1. `76b304a` — Fixed video-call captions reading the wrong language dropdown (was reading
   the standalone Text Translation tab's `tgtLang`, which defaults to Spanish; now reads
   the Group Chat tab's own `gcSrcLang`/`gcTgtLang`).
2. `cf8d564` — Made the video call control a full-width labeled button instead of a small
   icon.
3. `f4eec86` — Removed leftover Vercel-only files (`vercel.json`, `api/translate.js`),
   updated `README.md` to describe actual Apollo1 self-hosted deployment.
4. `997d50f` — Fixed a regression from fix #1: changing "I write in" mid-call was silently
   killing the *incoming* captions listener (not just restarting the outgoing mic stream),
   so translation would work briefly then go permanently silent for the rest of the call.

**Discovered (not yet fixed):** Every language dropdown in `public/index.html`
(Translate/Camera OCR/Documents/Group Chat) has its own independently hand-typed,
drifted-apart language list. Group Chat's list is missing 10 languages the Translate tab
has (Swahili, Vietnamese, Thai, Indonesian, Persian, Bengali, Greek, Swedish, Czech, Urdu).

**Root cause found via git archaeology:** TalkBridge was originally a React app
(`src/App.jsx`). On 2026-05-10 it gained 14 languages and a "Record" tab (mic recording +
download). On 2026-05-12 a completely new `public/index.html` was added from scratch. On
2026-05-13 `src/App.jsx`/`src/main.jsx` were deleted. Everything built since (Group Chat,
LiveKit video, this session's fixes) exists only in the `public/index.html` codebase, not
in React. Full detail in `POSTMORTEM.md`.

**Decision made:** Do not just patch the language lists in `public/index.html`. Migrate
the whole app to React instead, in phases, without waiting for the current codebase to be
"fully stable" first. Plan is in `MIGRATION_PLAN.md`.

**Next session should:**
1. Get answers to the 3 open questions at the bottom of `MIGRATION_PLAN.md` if not already
   answered.
2. Start Phase 0 (scaffold + shared language list module) — do not re-litigate or redo the
   investigation above, it's done and documented.
3. Do NOT re-ask whether to do the React migration — that's decided. Only scope/sequencing
   within it is still open.
