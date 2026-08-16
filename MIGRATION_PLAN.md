# Migration Plan: `public/index.html` → React

## Goal

Rebuild TalkBridge as a proper React app (Vite), preserving every feature that exists
today in `public/index.html`, fixing the language-list drift for good with one shared
source of truth, and restoring what was lost per `POSTMORTEM.md` (full language list,
plus a recording feature — scoped this time to recording the video call itself, not a
standalone mic-only recorder, per the 2026-08-16 decision).

## Principles

- **Incremental, not big-bang.** Each phase ships something real and testable on its own.
  We do not attempt to rewrite everything in one pass.
- **Backend stays put, initially.** `server.js` (Express: `/api/translate`,
  `/api/livekit-token`, `/ws/transcribe`) keeps serving the same endpoints. The React
  frontend talks to the same API. Backend-only changes (if any become necessary) are
  their own phase, not bundled into frontend work.
- **One shared language list.** Defined once, imported everywhere a language dropdown
  exists. This is a Phase 0 deliverable specifically because every other phase depends on
  it, and it's the direct fix for the bug that started this whole conversation.
- **Old app keeps running until cutover.** `public/index.html` stays live and serving
  users on Apollo1 until Phase 6 (full cutover) is explicitly done and verified. Nobody
  loses the working app while the rebuild is in progress.
- **Every session updates `PROJECT_LOG.md`** with what was completed and what's next,
  before ending. See `CLAUDE.md` for the standing instruction.

## Phases

### Phase 0 — Scaffold + shared language list
- New Vite + React project (separate directory, e.g. `web/`, so it can be developed and
  built independently of the current `public/index.html`).
- Base layout: nav/tabs matching the current app's structure (Translate, Camera OCR,
  Documents, Group Chat, History, Settings).
- One shared `languages.js` (or similar) module: the full list, super-setting everything
  currently scattered across `srcLang`/`tgtLang`/`camSrcLang`/`camTgtLang`/`docSrcLang`/
  `docTgtLang`/`gcSrcLang`/`gcTgtLang`, plus the languages lost from the old React app
  (Hebrew, Romanian, Hungarian) — pending your confirmation on including those too.
- **Acceptance:** app scaffold builds and deploys somewhere reachable (a subpath or
  staging port on Apollo1), shows the nav shell, no features yet.

### Phase 1 — Translate tab
- Text translation, mic input, text-to-speech playback, translation history.
- Simplest, most self-contained feature — proves the architecture (API calls, state,
  styling) before tackling anything with external services (camera, Firebase, LiveKit).
- **Acceptance:** feature-parity with today's Translate tab, using the shared language
  list from Phase 0.

### Phase 2 — Camera OCR
- Live camera feed, capture + OCR + translate.
- **Acceptance:** feature-parity with today's Camera OCR tab.

### Phase 3 — Documents
- Drag/drop or file-picker upload, multi-format parsing, chunked translation.
- **Acceptance:** feature-parity with today's Documents tab.

### Phase 4 — Group Chat
- Firebase-backed realtime chat, rooms, presence, invites, per-message live translation.
- **Acceptance:** feature-parity with today's Group Chat tab (text chat portion only —
  video call is Phase 5).

### Phase 5 — Video Call
- LiveKit video/audio, Deepgram live captions, per-listener translated captions (today's
  `gcSrcLang`/`gcTgtLang`-driven behavior, including the mid-call reconnect fix from this
  session), full-width call control.
- **New:** call recording (record the video call itself, not just mic audio — this is the
  restored/reimagined Record feature).
- **Acceptance:** feature-parity with today's Video Call, plus working call recording.

### Phase 6 — Cutover
- Point Apollo1's served app at the React build instead of `public/index.html`.
- Retire `public/index.html` (kept in git history, not deleted from the record — this
  plan exists specifically because deleting the old thing without a paper trail is what
  caused the problem we're fixing).
- Final verification pass across every feature before calling it done.

## Open questions to confirm before Phase 0 starts

1. Include Hebrew, Romanian, and Hungarian in the shared language list (they existed in
   the old React app but never made it into any version of `public/index.html`), or stick
   to the current 26-language Translate-tab list plus nothing more?
2. Where should the new React app live during development — a subdirectory of this same
   repo, or a separate repo? (Same repo is simpler for one person managing one deploy
   target; separate repo is cleaner if you want the old app frozen and untouched.)
3. Confirm Phase 0 scope above before I start writing code against it.
