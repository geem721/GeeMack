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
- New Vite + React project in `web/` (a subdirectory of this same repo), so it can be
  developed and built independently of the current `public/index.html` without touching
  it.
- Base layout: nav/tabs — **Translate, Camera OCR, Documents, Group Chat, Video Call,
  History, Settings.** Video Call is its own top-level tab, not nested inside Group Chat
  (today's app buries the video call button inside the Group Chat panel; per the
  2026-08-16 decision this gets promoted to a sibling tab so it's not tied to text chat).
- One shared `languages.js` module: 29 languages total — the current 26-language
  Translate-tab list, **plus Hebrew, Romanian, and Hungarian restored from the old React
  app** (confirmed 2026-08-16; these three never made it into any version of
  `public/index.html`). Superset of everything currently scattered across
  `srcLang`/`tgtLang`/`camSrcLang`/`camTgtLang`/`docSrcLang`/`docTgtLang`/`gcSrcLang`/
  `gcTgtLang`.
- **Acceptance:** app scaffold builds and deploys somewhere reachable (a subpath or
  staging port on Apollo1), shows the nav shell including the new Video Call tab, no
  features yet.

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
  video call is its own tab, Phase 5, per the 2026-08-16 decision).

### Phase 5 — Video Call
- Its own top-level nav tab (not nested inside Group Chat — see Phase 0). LiveKit
  video/audio, Deepgram live captions, per-listener translated captions (today's
  `gcSrcLang`/`gcTgtLang`-driven behavior, including the mid-call reconnect fix from this
  session), full-width call control.
- **New:** call recording (record the video call itself, not just mic audio — this is the
  restored/reimagined Record feature).
- **Acceptance:** feature-parity with today's Video Call as its own tab, plus working call
  recording.

### Phase 6 — Cutover
- Point Apollo1's served app at the React build instead of `public/index.html`.
- Retire `public/index.html` (kept in git history, not deleted from the record — this
  plan exists specifically because deleting the old thing without a paper trail is what
  caused the problem we're fixing).
- Final verification pass across every feature before calling it done.

## Decisions confirmed 2026-08-16 (all three open questions resolved)

1. **Language list:** include Hebrew, Romanian, and Hungarian — 29 languages total.
2. **Repo location:** same repo, `web/` subdirectory.
3. **Phase 0 scope:** confirmed as written above, with one addition — Video Call is
   promoted to its own top-level nav tab instead of living inside Group Chat.

Phase 0 is now in progress.
