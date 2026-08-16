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

**Update, same session — docs deployed, all 3 open questions answered, Phase 0 started:**

- Deployed `POSTMORTEM.md`/`MIGRATION_PLAN.md`/`PROJECT_LOG.md`/`CLAUDE.md` to Apollo1
  (commit `1cbef19`, both `~/GeeMack` and `~/GEEMACK` in sync). Deploy method: `git am`
  from a gzip+base64 patch split into ~1800-byte chunks appended to a file, decoded once
  at the end — a single 22KB base64 line stalled the SSH terminal mid-paste (bash sat on a
  `>` continuation prompt), and the compressed/chunked approach fixed it cleanly. Worth
  trying this chunked-gzip method first for any future large payload, ahead of a single
  giant line.
- All 3 open questions from `MIGRATION_PLAN.md` answered and written into that file:
  1. **Include Hebrew, Romanian, Hungarian** — shared language list is 29 total.
  2. **Same repo, `web/` subdirectory** — not a separate repo.
  3. **Phase 0 confirmed**, with one scope addition: **Video Call is its own top-level nav
     tab**, not nested inside Group Chat (today's app buries it inside the Group Chat
     panel; user explicitly asked for it promoted to a sibling tab).
- **Phase 0 built and committed** (sandbox-local; not yet pushed/deployed to Apollo1 — see
  "Next session should" below):
  - `web/` — new Vite + React scaffold, builds clean (`npm run build`), lints clean
    (`npm run lint`).
  - `web/src/languages.js` — the shared 29-language module (single source of truth,
    replacing the four drifted lists).
  - Nav shell with 7 tabs: Translate, Camera OCR, Documents, Group Chat, Video Call,
    History, Settings — each a placeholder pointing at its migration phase, except
    History/Settings which aren't assigned a phase yet in `MIGRATION_PLAN.md` (flagged in
    their placeholder text rather than guessing a phase number).

**Next session should:**
1. Deploy the Phase 0 commit to Apollo1 (same chunked-gzip `git am` pattern that worked
   for the docs commit) and verify `web/` builds there too (`cd web && npm install && npm
   run build`).
2. Get the app reachable somewhere on Apollo1 per Phase 0's acceptance criterion (a
   subpath or staging port) — not yet decided *how* (reverse-proxy subpath vs. a second
   port in nginx); this needs a decision, not just execution.
3. Start Phase 1 (Translate tab) once Phase 0 is verified live.
4. Do NOT re-ask whether to do the React migration, whether to include the 3 extra
   languages, repo location, or Video Call's own tab — all four are decided. Only
   Phase-0-deployment-mechanics and Phase 1+ sequencing are still open.
