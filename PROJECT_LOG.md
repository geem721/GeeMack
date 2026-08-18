# Project Log

Running, append-only record of what happened each session. **Newest entries at the top.**
Read this (and `MIGRATION_PLAN.md`) before starting any work in this repo — see
`CLAUDE.md`.

---

## 2026-08-18 (session, continued) — Phase 4 confirmed working live; Phase 4 is done

Deployed the Phase 4 patch (commit `397d9fa`) to Apollo1 — `git am`, `git push`,
`~/GEEMACK` synced, `npm install && npm run build`, `dist/` copied to
`/var/www/talkbridge-react/`. No `pm2 restart` needed (no `server.js` changes).

User tested live with two real accounts (`geem721@outlook.com` and `geem721@gmail.com`),
both signed up and email-verified through the new `AuthGate`. Results, confirmed by
screenshots:

- **Sign-in gate works**: only Group Chat required an account; Translate/Camera/
  Documents were untouched, per the confirmed auth-scope decision.
- **Messaging works**: both accounts sent and received messages in `#general` in
  real time.
- **Presence works**: online count updated correctly as the second account joined (1 → 2
  online).
- **Live per-message translation confirmed working**: with one account's "I write in"
  set to Spanish, `"Hola. Como Esta"` rendered on the English-reading side as `🌐 Hello.
  How are you?`, and `"Donde es su Casa. Tu vive in este ciudad?"` as `🌐 Where is your
  house? Do you live in this city?` — the translation line only appears when sender and
  reader are on different languages, exactly as designed.
- **Invite links work**: opening a `?room=general` link (copied via the Invite button)
  in a new tab dropped the second account straight into the right room with the Group
  Chat tab already active.

No bugs found. **Phase 4 is genuinely done** — every acceptance criterion in
`MIGRATION_PLAN.md` (feature parity with legacy Group Chat, minus the deliberate
whole-app-gating narrowing) is verified live, not just in the sandbox.

**Next: Phase 5 (Video Call)** — LiveKit video/audio as its own top-level tab (already
promoted out of Group Chat per the 2026-08-16 decision), Deepgram live captions relayed
through `/ws/transcribe`, per-listener translated caption overlays, and call recording
(the restored/reimagined Record feature). Reuses `AuthGate` for sign-in (see prior entry
this session — Video Call needs `currentUser` just as much as Group Chat does) and the
same room concept Group Chat already established. Not started yet.

---

## 2026-08-18 (session, continued) — Phase 4: Group Chat tab built, auth-scope decision made

**Context:** Picked back up after confirming the tool-use fix (previous entry) resolved
the JSON-leakage bug in `/api/translate`. User confirmed those results looked good and
asked to move on to the next phase.

**Decision made before building anything — auth scope, resolved with the user, not
assumed:** the legacy `public/index.html` gates the *entire* app behind a Firebase
login/signup/email-verification screen; nothing (not even Translate) is usable signed
out. Phases 1-3 of the React rebuild shipped with **no** auth at all and were confirmed
working that way. Group Chat is the first feature that actually needs an identity
(message authorship, presence, room membership). Rather than silently pick a direction,
asked the user directly. Also flagged directly that this in no way resembles the May
2026 incident in `POSTMORTEM.md` (silent revert from React back to hand-typed HTML) —
user hadn't even been worried about that until it came up, wanted it named explicitly
given the project's history.

Walked through how video call (Phase 5, not yet built) actually works today — LiveKit
for video/audio, a `/ws/transcribe` WebSocket relaying mic audio to Deepgram, transcripts
written to Firebase (`chats/{room}/captions`), each participant translating and
overlaying them — specifically because it also depends on `currentUser` (LiveKit
identity, caption authorship) and shares the same room concept as Group Chat. That's
relevant context for the auth decision since it isn't Group-Chat-specific.

**Decided: gate only Group Chat (and, when built, Video Call) behind sign-in. Translate,
Camera OCR, and Documents stay exactly as shipped — no login required.** This is a
deliberate, confirmed narrowing from legacy behavior, not an oversight.

**Built this session:**
- `web/src/firebase.js` — single Firebase app instance (Auth + Realtime Database),
  config copied verbatim from `public/index.html`'s inline script. Not a secret — it's
  already public in the live page's source; access control is Firebase Auth + DB
  security rules, not obscurity. Same Firebase project as the legacy app, so users/rooms/
  messages are shared across both during the migration.
- `web/src/hooks/useAuth.js` — reactive wrapper over Firebase Auth (`onAuthStateChanged`,
  sign in/up/out, resend/reload verification). Deliberately maps the raw Firebase `User`
  to a plain `{uid, email, emailVerified}` object on every change — the raw `User`
  mutates in place on `.reload()`, which doesn't trigger a React re-render since the
  object reference never changes; re-mapping to a fresh plain object each time sidesteps
  that.
- `web/src/components/AuthGate.jsx` + `.css` — reusable sign-in wall, render-props style
  (`<AuthGate featureName="...">{(user, signOutUser) => ...}</AuthGate>`), built once so
  Video Call (Phase 5) can reuse it instead of duplicating login/signup/verify forms.
  Same three states as the legacy auth screen (login, signup, verify-email-pending) minus
  the whole-app gating.
- `web/src/tabs/GroupChat.jsx` + `.css` — feature-parity port of the legacy Group Chat
  panel: 5 fixed rooms (general/support/travel/business/casual, unchanged from legacy),
  presence (`onDisconnect`-backed online/offline), invite links (`?room=X` query param,
  read by `App.jsx` on load — auto-selects the Group Chat tab on arrival, a small
  deliberate UX improvement over legacy, which only highlighted the room button), live
  per-message translation via the shared `callTranslate`, join events. Uses the full
  29-language shared list (`languages.js`) for the language pickers instead of legacy's
  narrower 16-language Group Chat dropdown — consistent with the Phase 0 "one shared
  list" decision, not a scope change.
  - Real difference from the legacy implementation, worth being explicit about since it's
    not a literal port: legacy did manual incremental DOM diffing
    (`gcRenderedIds`/`renderMessage`) because it wasn't using a framework. React's
    reconciler already handles that safely via `key`, so the rewrite just stores the full
    sorted message list in state on every Firebase snapshot and lets React diff it — same
    user-facing behavior, simpler code, no `gcRenderedIds`-equivalent needed.
  - "Clear view" is simplified to clearing the local translation cache + a toast, instead
    of legacy's full unsubscribe/resubscribe dance — the React version doesn't have the
    stale-DOM problem that dance was working around, so the extra machinery would be
    solving a problem that doesn't exist here.
- `App.jsx` — reads `?room=` on load (`initialRoomFromUrl()`), passes it to `GroupChat`,
  auto-switches to the Group Chat tab if present. Subtitle bumped to "Phase 4: Group Chat
  tab."
- `web/package.json` — added `firebase@^10.12.2` (same major version as the CDN modules
  version pinned in `public/index.html`, `10.12.0`, for API-compatibility safety).

**Verified in this sandbox (no live Firebase project reachable here — same limitation as
every backend-dependent fix this project has hit):**
- `npm install && npm run build` succeeds clean.
- `oxlint` clean (same pre-existing `Toast.jsx` fast-refresh warning as every prior
  phase, not new).
- Headless Playwright smoke test against the production build (`vite preview`):
  clicking the Group Chat tab renders the sign-in gate (not the chat itself, confirming
  Translate/Camera/Documents are unaffected and Group Chat is genuinely walled off);
  toggling to the signup form works; submitting a signup attempt fails gracefully with a
  visible error banner rather than crashing (expected — this sandbox has no route to
  Firebase's servers, `ERR_TUNNEL_CONNECTION_FAILED`, same class of restriction that's
  blocked live-testing every API-dependent fix all project); visiting
  `?room=support` auto-activates the Group Chat nav tab. No console/page errors outside
  the expected network failures.
- **Not yet verified live** — needs a real test on Apollo1: sign up, verify email, send a
  message, confirm it's translated for a second account in a different target language,
  confirm presence count updates, confirm an invite link actually drops a second
  browser/device into the right room.

**No `server.js` changes this session** — Group Chat is 100% client-side (Firebase +
the existing `/api/translate` endpoint), so deploy is `npm install && npm run build` +
copying `dist/` to `/var/www/talkbridge-react/`. No `pm2 restart` needed this time.

**Noted for later, not acted on:** user mentioned that an upcoming "phone piece" may
integrate something like Twilio, and asked to keep cost/fit in mind. Not in
`MIGRATION_PLAN.md` today (the plan runs through Phase 6 with Group Chat/Video Call as
Firebase+LiveKit only, no PSTN calling). Needs real research (Twilio pricing, how it'd
sit alongside LiveKit/Firebase, whether it's a new phase or extends Phase 5) before
proposing anything — flagging here now purely so it isn't lost, not committing to an
approach.

**Next: deploy this patch, have the user create a real account and test Group Chat live
across two sessions/devices (send/receive, translation, presence, invite link). Once
confirmed, Phase 4 is done and Phase 5 (Video Call) can start.**

---

## 2026-08-16 (session: bug-fix marathon + React migration decision)

**Context:** Started as a bug-fix session for TalkBridge's video-call translation
("always translates to Spanish"). Ended with a decision to migrate the whole app to
React, after discovering the app was silently reverted from React to a single-file HTML
app back in May.

**Completed this session (all committed to `master`):** — **CORRECTION, written later the
same session:** these were NOT actually live on Apollo1 when originally logged below as
"verified live." See the critical update near the bottom of this entry — the deploy
pipeline itself was silently broken, and none of this reached users until that was found
and fixed, hours after these commits were pushed.
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

**Update, same session — Phase 0 deployed, and a critical deploy-pipeline bug found and
fixed (this is the important part of today):**

- Phase 0 deployed to Apollo1: commit `d87b402` locally became `4638226` after `git am`
  (content identical, hash differs — normal for `git am`, not a discrepancy). Both
  `~/GeeMack` and `~/GEEMACK` in sync. `npm install && npm run build` verified working on
  Apollo1 itself, byte-identical output hashes to the sandbox build
  (`index-Cz3x6fge.css`, `index-_3nFuIo2.js`).
- Deploy method for this payload: same gzip+base64 idea as before, but even 1800-byte
  chunks intermittently stalled the SSH terminal mid-paste this time (inconsistent — same
  chunk size had worked cleanly for the smaller docs payload earlier in this session).
  Root cause looks environmental (terminal/SSH client reflow), not a fixed byte threshold,
  so chunk-size tuning is not a reliable fix by itself. **Better method, used successfully
  here:** since this commit's files are all plain text (JS/JSON/CSS/HTML/MD, no binary),
  skip base64 entirely — deliver the raw `git format-patch` output as an actual file via
  `SendUserFile`, have the user `scp` it to Apollo1, then `git am` it directly. No
  copy-paste of any large payload at all. **Use this file-transfer method first for any
  future all-text patch**, and fall back to chunked-gzip-base64 only for payloads that
  must go through a terminal paste for some reason.
- Decided reachability approach for Phase 0 (and beyond): nginx subpath
  (`talk-bridge.org/react-preview/`), not a separate port. Reason: this reuses the
  existing HTTPS cert, and HTTPS is a hard requirement starting Phase 1 — browsers refuse
  `getUserMedia` (mic/camera) over plain HTTP. A separate unencrypted port would work for
  the empty Phase 0 shell and then break as soon as Phase 1 needs the mic. Vite's `base`
  set to `/react-preview/` accordingly (commit `bbc70ff`, **not yet deployed to Apollo1**).
  The matching nginx `location /react-preview/` block is not yet written or deployed —
  need the actual current nginx config first (see next steps).

- **CRITICAL FINDING — the real reason today's earlier fixes weren't reaching users:**
  While investigating where to add the nginx location block, discovered nginx does NOT
  serve `~/GeeMack/public/index.html` directly — it serves a **separate**, independently
  deployed copy at `/var/www/talkbridge/index.html`. A cron job
  (`*/5 * * * * /home/geem721/deploy.sh`) was supposed to keep that copy in sync, but its
  `sudo cp` and `sudo chown` calls were **silently failing on every single run** —
  `deploy.log` was full of `sudo: A terminal is required to authenticate` — because cron
  runs non-interactively and `/var/www/talkbridge` was owned by `www-data`, requiring
  `sudo` for a plain user to write to it. Only the script's non-sudo step
  (`pm2 restart talkbridge`) was succeeding, every 5 minutes, unconditionally, whether or
  not anything had actually changed (restart counter was at 3190+ and climbing) — this was
  likely also causing random WebSocket/call drops, unrelated to anything fixed in code
  today.
  - **Consequence:** `/var/www/talkbridge/index.html` was last genuinely updated **Aug 9**
    — before today's session. None of today's four "verified live" fixes (`76b304a`
    through `997d50f`) had actually reached users despite being committed, pushed, and
    even manually `git pull`-ed into both Apollo1 clones. The original bug report
    ("translation only in Spanish") was very likely never really fixed by `76b304a` in any
    way a user could observe — earlier same-session test failures that got attributed to
    "stale browser tab caching" were probably this instead.
  - **Fix applied:** changed `/var/www/talkbridge` ownership to `geem721:geem721` (nginx
    only needs read access to serve static files, not ownership — `sudo chown -R
    geem721:geem721 /var/www/talkbridge`, a one-time interactive command the user ran
    themselves). Rewrote `/home/geem721/deploy.sh` to drop both `sudo` calls (no longer
    needed) and drop the `cp -r api ...` line (that directory doesn't exist in git anymore
    post `f4eec86`; nginx's `/api/` route proxies to Node, was never served as a static
    file). Backup of the original script saved as `/home/geem721/deploy.sh.bak`. Ran the
    fixed script manually once — confirmed via `diff` (no output, i.e. identical) and
    `grep -c "stopOutgoingCaptionStream" /var/www/talkbridge/index.html` returning `3`
    (previously `0`) that the real fix is finally live.
  - **Not yet independently re-tested by the user** after this fix — the "still Spanish"
    result reported earlier today may resolve now that the actual deploy pipeline works,
    but this needs a real cross-device test to confirm, not just file-diff verification.

**Update, same session — Phase 0 reachability done, session ended here deliberately:**

- Got the real nginx config (`sudo nginx -T`), found it's `listen 80` only with no visible
  TLS block, confirmed via `WebFetch` that `https://talk-bridge.org` nonetheless loads
  real content — so HTTPS terminates somewhere upstream of this nginx (likely Cloudflare
  or similar), not in this config file. Doesn't change the plan: any `location` added to
  this same `server {}` block inherits whatever HTTPS handling already applies to the
  domain.
- Added `location /react-preview/ { alias /var/www/talkbridge-react/; try_files $uri
  $uri/ /react-preview/index.html; }` to `/etc/nginx/sites-enabled/talkbridge` (manual
  edit via `nano`, deliberately not scripted since it's a one-time change to a file
  outside git). Used `alias` not `root` — with `root` the path would double up
  (`/var/www/talkbridge-react/react-preview/...`), a common nginx mistake avoided here.
- `/var/www` required `sudo mkdir` (root-owned parent), then `sudo chown
  geem721:geem721 /var/www/talkbridge-react` so subsequent deploys don't need sudo —
  same pattern as the `/var/www/talkbridge` ownership fix earlier this session.
- Built and copied `web/dist/*` into `/var/www/talkbridge-react/`, `sudo systemctl reload
  nginx`. **Verified: `curl` returns `200` for `https://talk-bridge.org/react-preview/`.**
  Phase 0 is live, reachable, and complete — nav shell with all 7 tabs (Translate, Camera
  OCR, Documents, Group Chat, Video Call, History, Settings), shared 29-language module,
  Video Call as its own top-level tab.
- **Note for later:** this deploy (`web/dist` → `/var/www/talkbridge-react/`) was done
  manually, once. `deploy.sh` does NOT yet rebuild/redeploy `web/` automatically on future
  `git push`es — every session that touches `web/` needs to manually rebuild and copy
  until that's automated. Deliberately not automated today to avoid adding an unconditional
  `npm run build` to a cron job that fires every 5 minutes forever — worth designing
  properly (e.g. only rebuild if `git pull` actually changed something) rather than bolting
  on quickly.
- **Session ended here at the user's request**, specifically so they can test the actual
  video-call translation fix in real-world conditions (across two devices) before the next
  session starts. **This is the single most important thing to check first next time** —
  everything else this session was either fully verified (Phase 0 live, deploy pipeline
  fixed) or is normal next-phase planning, but whether the original user-reported bug is
  actually gone has NOT been confirmed by the user yet, only inferred from file diffs.

**Next session should — in this exact order:**
1. **Ask first, before anything else: did the video call translation work correctly
   across devices?** This is the one open question left over from today. If yes, that
   whole thread is closed and Phase 1 can start clean. If no, treat it as a fresh
   investigation — don't assume `76b304a`/`997d50f` are sufficient just because they're
   finally deployed; the deploy-pipeline fix only means the code is now reachable, not
   that the code is necessarily correct.
2. If the bug is confirmed fixed (or the user doesn't want to dwell on it further), start
   Phase 1 (Translate tab: text translation, mic input, TTS playback, translation
   history) per `MIGRATION_PLAN.md`, using the shared `web/src/languages.js` module.
   Remember `web/dist` still needs a manual rebuild+copy to `/var/www/talkbridge-react/`
   after any `web/` change — see note above.
3. Do NOT re-ask whether to do the React migration, whether to include the 3 extra
   languages, repo location, or Video Call's own tab, or whether Phase 0 is reachable —
   all five are done and verified. Do NOT re-investigate the May 2026 React→HTML
   regression — fully documented in `POSTMORTEM.md`. Do NOT re-diagnose the deploy
   pipeline (`/var/www/talkbridge` ownership, `deploy.sh` sudo calls) — already fixed and
   verified working today.

---

## 2026-08-17 — Translation bug CONFIRMED FIXED; starting Phase 1

- User tested real-world video call translation across devices. Result, verbatim:
  "testing went well. translation is happening as it should. I think that it's working
  as it should." This closes the loop opened in the previous session: the original
  user-reported bug ("translation only ever comes out in Spanish") is confirmed fixed.
- **Root cause confirmation**: this was never a translation-logic bug. It was the broken
  deploy pipeline (cron running `deploy.sh` non-interactively, `sudo cp`/`sudo chown`
  silently failing every 5 minutes for who knows how long) meaning fixes committed to git
  were never actually reaching `/var/www/talkbridge/index.html`. Once ownership was
  changed to `geem721:geem721` and `deploy.sh` stopped needing sudo, the real fix
  (`stopOutgoingCaptionStream` etc., commits `76b304a`–`997d50f`) finally went live and
  the bug is gone.
- No further action needed on this thread. Do NOT re-investigate the "translates to
  Spanish" bug in future sessions — it is closed, confirmed by real user testing, not
  just file-diff inference.
- **Starting Phase 1 now** per `MIGRATION_PLAN.md`: Translate tab (text translation, mic
  input, TTS playback, translation history), built on top of the Phase 0 scaffold, using
  the shared `web/src/languages.js` module for the language list.

**Update, same session — Phase 1 built (Translate tab), commit `e204ee1`:**

- Built the full Translate tab in React: language selects (source w/ auto-detect +
  target, both using the shared 29-language `web/src/languages.js` list), swap, mic
  input (Web Speech API, continuous mode with silence-based auto-stop — 1.5s normal /
  3s extended), TTS playback via `speechSynthesis` (with the legacy TTS_LIMITED warning
  modal preserved as-is, not extended to he/ro/hu since that'd be a guess not a tested
  fact), copy result, full-screen result modal, and translation history.
- History is saved to `localStorage['tb_history']` — **same key the legacy
  `public/index.html` app uses**. Since the React preview is same-origin
  (`talk-bridge.org`), this shares history with the classic app rather than starting a
  disconnected list. No migration needed.
- New shared infra (in `web/src/components/`), meant to be reused by every later tab
  rather than rebuilt each phase: `Toast.jsx` (`ToastProvider`/`useToast`, replaces the
  legacy global `showToast()`) and `Modal.jsx` (generic modal shell, used here for the
  full-screen result view and the TTS-support warning).
- **Scope decision, worth knowing so it's not re-litigated:** the three behavior toggles
  (auto-translate, save-history, extended-listen mode) live as local component state in
  `Translate.jsx`, not in a Settings tab. Settings isn't its own migration phase yet
  (checked `MIGRATION_PLAN.md` — only Translate/Camera/Documents/GroupChat/VideoCall/
  Cutover are phases), and building it out prematurely would be scope creep. This is
  actually still full behavioral parity: verified in `public/index.html` that the legacy
  app never persisted these toggles either (plain `onclick` class-toggles, no
  `localStorage` read/write) — they silently reset to the same defaults (all three ON)
  on every page load there too. If/when a Settings tab phase happens, these three should
  move there.
- **Also worth knowing:** `server.js`'s backend `LANG_NAMES` map (used to build the
  Claude prompt) only has the original 26 languages, not he/ro/hu. Not a blocker — it
  falls back to `LANG_NAMES[tgtLang] || tgtLang`, so Hebrew/Romanian/Hungarian requests
  still send the raw ISO code (`he`/`ro`/`hu`) to Claude, which understands them fine —
  but the prompt would read slightly cleaner with full names added. Minor, non-blocking,
  not done this session; flagging as a possible small follow-up.
- **Verified in this sandbox:** `npm run build` succeeds, `oxlint` clean (one expected
  `react/only-export-components` fast-refresh warning in `Toast.jsx` — harmless, that
  file intentionally exports both the provider component and the `useToast` hook).
  Headless-browser smoke test (Playwright against `vite preview`) confirmed: no
  console/page errors, both language dropdowns render all 29 languages (59 total
  `<option>`s across both selects), the 3 behavior checkboxes render, and clicking swap
  while source is Auto-Detect correctly shows the "Can't swap Auto-Detect" toast.
- **NOT yet verified:** an actual live `/api/translate` call — this sandbox has no
  `ANTHROPIC_API_KEY`/backend running, so the translate round-trip itself has only been
  code-reviewed against `server.js`, not exercised. **This must be tested for real once
  deployed to Apollo1** — type text, hit Translate, confirm a real translation comes
  back, before calling Phase 1 done.
- **Not yet deployed to Apollo1.** Still needs: patch handed to user → `git am` on
  Apollo1 in both `~/GEEMACK` and `~/GeeMack` (keep them in sync per `CLAUDE.md`) →
  `cd web && npm install && npm run build` → `cp -r dist/* /var/www/talkbridge-react/`
  (still a manual step, per the note in the previous entry — `deploy.sh` doesn't
  automate the React app's build/copy yet) → reload if needed → verify live at
  `https://talk-bridge.org/react-preview/`.

**Next session (or rest of this one) should — in this exact order:**
1. Get this Phase 1 commit deployed to Apollo1 and confirm `https://talk-bridge.org/react-preview/`
   shows the working Translate tab (not just the Phase 0 placeholder).
2. **Do a real translate test**: type text, hit Translate, confirm an actual translated
   result comes back from `/api/translate` (not just that the UI renders — the network
   call itself hasn't been exercised outside a code review). Also spot-check mic input
   and TTS listen in a real browser (Web Speech API can't be meaningfully tested
   headless).
3. If Phase 1 checks out, move to Phase 2 (Camera OCR tab) per `MIGRATION_PLAN.md`.
4. Do NOT re-ask about the video-call translation bug — confirmed fixed by the user
   today, see entry above. Do NOT re-litigate the Settings-toggle scope decision above
   (toggles live in Translate.jsx for now, by design) or the `server.js` LANG_NAMES gap
   (known, non-blocking, optional future fix).

**Update, same session — Phase 1 confirmed working live + cron restart-storm fixed:**

- User tested the live Translate tab in a real browser at `https://talk-bridge.org/react-preview/`
  (screenshot evidence): typed English text, hit Translate, got a correctly detected
  "English" source and a real Chinese translation back from `/api/translate`. **Phase 1
  is confirmed working end-to-end**, not just code-reviewed.
- Console showed two `Failed to load resource: 502` errors on `api/translate` before the
  successful one. Root cause: `deploy.sh` was calling `pm2 restart talkbridge`
  **unconditionally on every cron run** (every 5 minutes, `↺` restart counter was at 3466
  when checked), which briefly drops the backend and can 502 any in-flight request. This
  is exactly the risk flagged as a "future improvement" in an earlier entry, now actually
  observed causing a real (if transient) user-facing error.
- **Fixed**: rewrote `/home/geem721/deploy.sh` to capture `git rev-parse HEAD` before and
  after `git pull`, and only `cp`/`pm2 restart` when the hash actually changed — otherwise
  it just logs "No changes" and leaves the running process alone. Old version backed up as
  `~/deploy.sh.bak2` (the original pre-ownership-fix version is separately at
  `~/deploy.sh.bak`). Verified by running it manually right after the swap: printed
  "Already up to date." → "No changes: <timestamp>" with **no** `pm2` restart triggered —
  confirmed correct behavior. Cron (`*/5 * * * *`) will pick up the new script on its next
  run automatically, no crontab change needed since it just calls the same path.
- This does **not** yet cover `web/` — the React app's build/copy to
  `/var/www/talkbridge-react/` is still a fully manual step every phase (unchanged from
  the Phase 0 note). Only the legacy `public/index.html` deploy path got the
  restart-storm fix. Worth automating `web/` the same way in a future session, but out of
  scope for right now.

**Phase 1 is done. Ready to start Phase 2 (Camera OCR) next**, per `MIGRATION_PLAN.md` —
live camera feed, capture + OCR + translate, feature-parity with today's Camera OCR tab.
Do NOT re-verify Phase 1 further or re-investigate the 502s — both are closed, confirmed
fixed, see above.

**Update, same session — Phase 2 built (Camera OCR tab), commit follows below:**

- Built the Camera OCR tab in React: `getUserMedia` live camera preview (back/front
  camera toggle), capture-to-canvas, Tesseract.js OCR, then `/api/translate` on the
  extracted text — full pipeline matching the legacy `public/index.html` Camera OCR panel.
- **Tesseract.js loaded via the same pinned CDN script tag** (`4.1.1`, in `web/index.html`,
  referenced as `window.Tesseract`) rather than an npm import — its worker/wasm asset
  pipeline doesn't bundle cleanly with Vite, and this exact CDN setup is already proven
  working in production for the legacy app. Not worth re-litigating unless it actually
  causes a problem.
- **Carried over two legacy quirks deliberately, not bugs**: (1) the camera OCR language
  dropdowns are a smaller, fixed subset (10-11 languages) distinct from the full
  29-language Translate list — this matches what the legacy panel actually offered, not
  an oversight. (2) Tesseract always OCRs against a fixed hardcoded language string
  (`eng+spa+fra+deu+chi_sim+jpn+kor+ara+rus`) regardless of the source-language dropdown
  — the dropdown only feeds the `/api/translate` call. Verified this by reading the
  legacy JS closely, not guessing.
- Same local-state scope decision as Phase 1's Translate tab: "Use back camera" and
  "Auto-capture mode" toggles live in `CameraOCR.jsx` itself, not a Settings tab (still
  doesn't exist / isn't its own phase).
- **Refactored shared UI primitives out of `Translate.css`** into a new
  `web/src/shared.css` (buttons, spinner, lang-bar/lang-sel, settings blocks, etc.),
  imported once globally in `App.jsx`. Doing this now, before Camera OCR could silently
  depend on classes "owned" by Translate.css — avoids the two tabs becoming invisibly
  coupled through load order. Also pulled the `/api/translate` fetch out of `Translate.jsx`
  into `web/src/api/translate.js`, since Camera OCR needs the same call and Documents
  (Phase 3) will too.
- **Verified in this sandbox**: `npm run build` succeeds, `oxlint` clean (same expected
  `Toast.jsx` fast-refresh warning as Phase 1). Headless-browser smoke test confirmed: no
  app errors (one expected `ERR_TUNNEL_CONNECTION_FAILED` on the Tesseract CDN fetch —
  this sandbox blocks that domain the same way it blocked `talk-bridge.org` directly
  earlier; not a real issue), Translate tab still renders correctly with the refactored
  shared CSS (confirmed computed button color unchanged), Camera OCR tab renders its
  language dropdowns (11 src / 10 tgt options), Start Camera button, and both behavior
  checkboxes.
- **NOT yet verified**: actual camera capture + OCR + translate round-trip in a real
  browser — this sandbox has no camera device and blocks the Tesseract CDN, so like
  Phase 1's `/api/translate` call, this needs a real test on Apollo1/a real device before
  calling Phase 2 done. **This is the next thing to check.**
- **Not yet deployed to Apollo1.**

**Next session (or rest of this one) should — in this exact order:**
1. Deploy this commit to Apollo1 (patch → `git am` in both clones → `git push` →
   `cd web && npm install && npm run build` → `cp -r dist/* /var/www/talkbridge-react/`
   — same steps as Phase 1, `web/` deploy is still manual).
2. **Real test**: open the Camera tab in an actual browser on a device with a camera,
   grant camera permission, capture some text (a sign, a page, anything with text on it),
   confirm OCR extracts it and translation comes back correctly. This is the one thing
   that could not be verified in the sandbox.
3. If Phase 2 checks out, move to Phase 3 (Documents tab) per `MIGRATION_PLAN.md`.
4. Do NOT re-litigate the shared.css refactor, the fixed-Tesseract-language-string
   quirk, or the CDN-vs-npm choice for Tesseract.js — all deliberate, documented above.

**Update, same session — Phase 2 confirmed working live:**

- User tested the live Camera OCR tab for real (camera capture + OCR + translate),
  including translating to Russian and other languages. Result, verbatim: "Everything in
  the Camera translation works. I tried translating to different languages including
  Russian ands they work." **Phase 2 is confirmed working end-to-end**, not just
  code-reviewed/smoke-tested.
- No issues reported this time (unlike Phase 1's transient 502s, which were already fixed
  before this test).
- **Phase 2 is done. Ready to start Phase 3 (Documents) next**, per `MIGRATION_PLAN.md` —
  drag/drop or file-picker upload, multi-format parsing, chunked translation,
  feature-parity with today's Documents tab.
- Do NOT re-verify Phase 2 further — confirmed fixed, see above.

**Update, same session — Phase 3 built (Documents tab), real parsing added:**

- **Important finding before building, confirmed by reading the legacy JS (not
  assumed)**: the legacy Documents tab (`public/index.html`) advertises PDF/DOCX/XLSX/
  PPTX/EPUB/ODT/etc. support via its UI (format-tag pills, file-picker `accept` list),
  but its actual code only ever calls `FileReader.readAsText(file, 'UTF-8')` on every
  non-image file. That's fine for genuinely plain-text formats (TXT/MD/CSV/HTML/RTF) but
  produces garbled binary noise for real binary formats (PDF/DOCX/XLSX/PPTX/EPUB/ODT),
  which then gets silently "translated" into nonsense. There is no PDF/Office parsing
  library anywhere in the legacy app.
- **Surfaced this to the user before building** rather than silently porting the bug or
  silently fixing it. User's answer, verbatim: **"we have to fix it. IF it's included it
  has to work."** So Phase 3 adds real parsing, not just a parity port.
- **New `web/src/utils/documentParsers.js`** dispatches by file extension to a real
  extractor per format:
  - **PDF** → `pdfjs-dist` (per-page `getTextContent()`, joined). Note:
    `pdfjs-dist@^6` (the version `npm install` grabbed by default) crashed in this
    sandbox's Chromium 141 with `s.getOrInsertComputed is not a function` — a real
    incompatibility, not a red herring (verified via a from-scratch Playwright repro
    with console/pageerror capture). **Pinned down to `pdfjs-dist@4.10.38`**, which
    works correctly; confirmed via headless test with a real PDF (converted from a
    `.docx` via `libreoffice --headless`). Worth knowing if a future `npm install`
    bumps this again and PDF parsing breaks.
  - **DOCX** → `mammoth.extractRawText()`.
  - **XLSX/XLS** → SheetJS (`xlsx` package), each sheet converted via
    `sheet_to_csv` and joined with a `# SheetName` header per sheet.
  - **PPTX** → no good lightweight browser PPTX-text library exists, so this unzips the
    file with `jszip` and pulls text runs (`<a:t>`) directly out of
    `ppt/slides/slideN.xml`, in slide order.
  - **EPUB** → also handled via `jszip`: reads `META-INF/container.xml` → the OPF
    manifest/spine → each chapter XHTML in reading order → extracts visible text.
  - **ODT/ODS/ODP** (OpenDocument) → `jszip` + `content.xml` text extraction (walks all
    text nodes; doesn't preserve table/slide structure, but that's fine for translation
    purposes).
  - **HTML/XHTML/ODF XML** text extraction inserts line breaks at block-level tags
    (`p`, `div`, `h1-h6`, ODF's `text:p`/`text:h`/`list-item`, etc. — matched by
    `localName` so XML namespace prefixes don't matter) so e.g. a heading and the
    paragraph after it don't get glued into one run ("TitleThe quick brown fox…").
    Verified this was actually a problem and fixed it, not just assumed.
  - **RTF** → a small brace-depth-aware mini-parser (not full RTF spec, but correct
    where a first-pass pure-regex version wasn't): a regex-only attempt let font/color
    table names (`Arial;` etc.) leak into the output because those live in nested
    `{\fonttbl{...}}` groups that regex can't reliably balance. Rewrote as a proper
    walk that tracks brace depth and skips known non-content destination groups
    (`fonttbl`, `colortbl`, `stylesheet`, `info`, `generator`, `pict`, `object`, plus
    any `\*`-marked generic destination). Verified against both a hand-built
    pretty-printed test RTF and a realistic single-line one.
  - **TXT/MD/CSV** → unchanged, plain `readAsText` (these already worked correctly).
  - **Images** → unchanged, Tesseract OCR (same as before, same as Camera OCR).
  - **Legacy binary `.doc`/`.ppt`** (pre-2007 OLE compound file formats) → deliberately
    **not** parsed — there's no practical client-side parser for those without a WASM
    LibreOffice-scale dependency, which is out of proportion for this migration. Rather
    than silently feeding garbage through `readAsText` like the legacy app effectively
    did, these now fail with a clear error: *"Legacy .doc format isn't supported —
    please save/export as .docx and try again"* (same for .ppt/.pptx). This is a
    deliberate scope line, not an oversight — flagging in case it needs revisiting.
  - Unknown/unanticipated extensions fall back to plain-text reading, same as the
    legacy app's implicit behavior.
- Every parser library (`pdfjs-dist`, `mammoth`, `xlsx`, `jszip`) is **dynamically
  imported** — only loaded when a file of that type is actually opened — so the main
  app bundle isn't bloated for tabs/files that never touch them. Confirmed via build
  output: main bundle is ~223KB, the heavy parser chunks (up to ~424KB for `xlsx`,
  ~1.3MB for the pdf.js worker) are separate lazy chunks.
- Same per-tab local-state scope decision as Phases 1-2: no new Settings-tab
  dependency introduced.
- Refactored shared TTS logic (`TTS_LIMITED`, `SPEECH_LANG_MAP`, `speakWithCheck`) out
  of `Translate.jsx` into `web/src/utils/speech.js`, since Documents needs the same
  "speak with limited-language warning" behavior for its translation result.
- Documents tab reuses the same generic `Modal.jsx`/`Toast.jsx` infra from Phases 1-2,
  and adds one new action the other tabs don't have: **Save to Device** (downloads the
  translated text as a `.txt` file via a `Blob` + anchor download), matching the legacy
  app's `saveModalToDevice()`.
- **Verified thoroughly in this sandbox** (this phase had a real, previously-hidden bug
  to catch, so verification went further than Phases 1-2's smoke tests): generated real
  test files for all 11 advertised formats (TXT, MD, CSV, HTML, RTF, DOCX, XLSX, PPTX,
  ODT, PDF, EPUB — via `python-docx`/`openpyxl`/`python-pptx`/`odfpy` and
  `libreoffice --headless` for the PDF), uploaded each through a headless-browser
  Playwright test against the real built app, and confirmed every single one extracts
  clean, correct, readable text — not garbage. Also verified `.doc`/`.ppt` now show the
  clear unsupported-format error instead of silently producing garbage.
- `npm run build` succeeds, `oxlint` clean (same expected `Toast.jsx` fast-refresh
  warning as Phases 1-2).
- **NOT yet verified**: the actual `/api/translate` round-trip on extracted document
  text, and the chunked-translation flow for documents longer than 3000 characters —
  this sandbox has no backend. Needs a real test on Apollo1.
- **Not yet deployed to Apollo1.**

**Next session (or rest of this one) should — in this exact order:**
1. Deploy this commit to Apollo1 (patch → `git am` in both clones, **being careful to
   `cd ~/GeeMack` first** — this has been the recurring mistake this session — → `git
   push` → `cd ~/GEEMACK && git pull` → `cd ~/GeeMack/web && npm install && npm run
   build` → `cp -r dist/* /var/www/talkbridge-react/`).
2. **Real test**: upload a real PDF, DOCX, and XLSX (the three most common formats) on
   Apollo1 and confirm the extracted text and the translated result both look right —
   this sandbox verified extraction thoroughly but never exercised the real
   `/api/translate` call on document text.
3. If Phase 3 checks out, move to Phase 4 (Group Chat) per `MIGRATION_PLAN.md`.
4. Do NOT re-litigate the parsing-library choices, the pdfjs-dist version pin (`4.10.38`
   — the default `^6` crashes in at least this environment), the RTF mini-parser, or the
   .doc/.ppt scope line — all deliberate, documented above, and actually verified against
   real files, not assumed to work.

**Update, same session — Phase 3 live-tested, two more real bugs found and fixed:**

User tested Phase 3 for real with an actual PDF (a VA benefits factsheet) and hit two
separate issues, both fixed this session:

1. **nginx served `.mjs` files with the wrong MIME type.** PDF parsing failed in the
   browser with `Error: Setting up fake worker failed: "Failed to fetch dynamically
   imported module: .../assets/pdf.worker.min-yatZIOMy.mjs"`. Diagnosed via `curl -I` on
   the worker URL before touching anything: file existed (200, correct byte count), but
   `content-type: application/octet-stream` instead of JS — `/etc/nginx/mime.types` on
   Apollo1 predates the `.mjs` extension (a well-known, common nginx gotcha, not specific
   to this app). **Fixed** by adding `mjs` to the existing `application/javascript js;`
   line in `/etc/nginx/mime.types` (backed up first as `mime.types.bak`), `nginx -t`,
   reload. Verified via `curl -I` again: `content-type` now `application/javascript`.
   This is a global nginx config change (not per-site, not in git), so it also covers any
   other `.mjs` module the app needs in future.
2. **`server.js`'s `/api/translate` had `max_tokens: 1000` hardcoded** — fine for short
   Translate-tab text, but too tight for Documents' ~3000-character chunks once
   translated into a more verbose language plus JSON-wrapper overhead. Symptom, seen
   live: the translated-result box showed raw, truncated JSON
   (`{"detected":"en",...,"translation":"...Jede Ent`, cut off mid-word) instead of clean
   translated text — the model's response got cut off by the token limit, breaking the
   JSON `server.js` expects back, so its own `catch` fallback dumped the raw broken text
   as if it were the translation. **Fixed**: bumped `max_tokens` to `4096` in `server.js`
   (commit follows). This benefits every tab that calls `/api/translate` with a longer
   text, not just Documents.
- Sent the user a bundle of real test files (CSV/PPTX/XLSX/EPUB/MD/RTF/ODT, all sharing
  the same short sample text) to test the remaining formats against the live site,
  since this sandbox can generate files but can't upload through Apollo1's real browser
  session — that has to happen on the user's end.
- **Both fixes verified working live** (PDF extraction + translation round-tripped
  correctly on the real factsheet once both were applied — real German output, no more
  raw JSON, no more truncation).
- `server.js` fix needs deploying same as always (patch → `git am` in `~/GeeMack`, being
  careful to `cd` there first, → `git push` → `cd ~/GEEMACK && git pull` → **also needs
  `pm2 restart talkbridge`** since this changes the running Node process, not just static
  files — the new `deploy.sh` handles this automatically now since it restarts on any
  new commit, but if applying this patch manually before cron's next run, restart `pm2`
  by hand or just wait up to 5 minutes for cron to pick it up).

**Next: wait for the user to test the remaining formats (CSV/PPTX/XLSX/EPUB/MD/RTF/ODT)
against the live site with the test bundle sent this session, then decide whether Phase 3
is fully done or needs another fix round, before moving to Phase 4 (Group Chat).**

---

## 2026-08-17/18 — Session end: Phases 1-3 built, deployed, and live-tested. Calling Phase 3 complete pending final format results tomorrow.

**This was a long, productive session. Full arc, in order:**

1. **Resolved the one open item from the previous session**: the original user-reported
   "translation only ever comes out in Spanish" bug. User confirmed via real cross-device
   video-call testing that it's fixed. Root cause (from the prior session) was never
   translation logic — it was a broken deploy pipeline (cron running `deploy.sh`
   non-interactively with `sudo` calls that silently failed every 5 minutes). This thread
   is closed. **Do not re-investigate it.**

2. **Phase 1 — Translate tab.** Built full React implementation: language selects (source
   w/ auto-detect + target, shared 29-language list), swap, mic input (Web Speech API),
   TTS playback, copy/full-screen result, translation history (shared `localStorage`
   key with the legacy app). New shared infra: `Toast.jsx`, `Modal.jsx`. Deployed,
   confirmed working live with a real translation. Along the way, found and fixed a real
   backend issue: `deploy.sh` was calling `pm2 restart talkbridge` **unconditionally on
   every 5-minute cron run**, causing transient 502s — rewrote it to only restart when
   `git pull` actually brings in a new commit. Verified fixed.

3. **Phase 2 — Camera OCR tab.** Live camera preview (back/front toggle), capture,
   Tesseract.js OCR (loaded via pinned CDN script, not npm — its worker/wasm pipeline
   doesn't bundle cleanly with Vite), translate. Refactored shared UI primitives out of
   `Translate.css` into a new `shared.css` so tabs don't silently depend on each other's
   stylesheets. Deployed, **confirmed working live** by the user testing multiple target
   languages including Russian.

4. **Phase 3 — Documents tab.** Before building, discovered the legacy Documents tab's
   UI advertised PDF/DOCX/XLSX/PPTX/EPUB/ODT support, but the actual code just read every
   non-image file as raw UTF-8 text — garbage for real binary formats. Surfaced this to
   the user rather than silently porting the bug; their answer was explicit: **"we have
   to fix it. IF it's included it has to work."** Built real parsers for every advertised
   format (pdf.js for PDF, mammoth for DOCX, SheetJS for XLSX, JSZip-based extraction for
   PPTX/EPUB/ODT/ODS/ODP, a proper brace-depth-aware mini-parser for RTF), with legacy
   `.doc`/`.ppt` (pre-2007 binary Office formats) deliberately failing with a clear
   "not supported" message instead of silently producing garbage — no practical
   client-side parser exists for those. Verified thoroughly in-sandbox against real
   generated test files for all 11 formats before ever deploying.
   - **Deployed, then live-tested by the user with a real PDF, which surfaced two more
     real bugs** (impossible to catch in the sandbox — no camera/backend there):
     - nginx was serving `.mjs` files as `application/octet-stream` instead of
       JavaScript (`/etc/nginx/mime.types` predates that extension — a common, generic
       nginx gotcha), which broke pdf.js's worker module. Fixed by adding `mjs` to the
       existing `application/javascript` line in `/etc/nginx/mime.types`. This is a
       global nginx config change, not in git.
     - `server.js`'s `/api/translate` had `max_tokens: 1000` hardcoded, too tight for
       ~3000-character document chunks — the model's response was getting cut off
       mid-JSON, and the server's own fallback path was dumping the raw truncated JSON
       into the UI as if it were the translation. Fixed by bumping to `4096`. This is a
       real git-tracked fix (`server.js`), deployed and confirmed live.
   - **Both fixes verified working live**: the same PDF that previously failed to parse,
     then produced truncated JSON, now translates cleanly end-to-end (confirmed with a
     full Japanese translation of the multi-page document — clean output, no JSON
     leakage, no truncation, despite being long enough to need multiple chunks).
   - Sent the user a bundle of real test files (CSV/PPTX/XLSX/EPUB/MD/RTF/ODT) generated
     in-sandbox (`python-docx`/`openpyxl`/`python-pptx`/`odfpy`, manual EPUB zip
     construction) to test the remaining formats against the live site — **this testing
     is happening offline and results will be reported next session.**

**Where things stand right now:**
- Phases 1, 2, and 3 are all built, deployed to Apollo1, and live at
  `https://talk-bridge.org/react-preview/`.
- Phase 1 and 2: fully confirmed working live, no open issues.
- Phase 3: PDF confirmed working live end-to-end (extraction + translation, including a
  long multi-chunk document). CSV/PPTX/XLSX/EPUB/MD/RTF/ODT were sent as a test bundle but
  **not yet confirmed** — user is testing offline, will report back. **User's explicit
  instruction: treat this as a complete rollout unless tomorrow's testing proves
  otherwise** — don't block on re-confirming what's already been verified, but do listen
  for and act on whatever the user reports about the remaining formats.
- `web/dist` → `/var/www/talkbridge-react/` is still a **manual** rebuild+copy step after
  any `web/` change (not yet automated in `deploy.sh` — deliberately deferred, needs
  proper design so it doesn't add an unconditional `npm run build` to a job firing every
  5 minutes forever).

**Tomorrow's session should start here, in this order:**
1. **Ask the user for the results of their offline CSV/PPTX/XLSX/EPUB/MD/RTF/ODT testing
   first, before doing anything else.** If all good, Phase 3 is fully closed — say so and
   move on. If something's broken, treat it like the PDF issues were handled tonight:
   research the actual cause (check real files/logs, don't guess), fix, deploy, verify
   live, log.
2. Once Phase 3 is confirmed (or issues from it are resolved), move to **Phase 4 (Group
   Chat)** per `MIGRATION_PLAN.md`: Firebase-backed realtime chat, rooms, presence,
   invites, per-message live translation (text chat portion only — Video Call is its own
   tab, Phase 5).
3. Do NOT re-verify Phases 1-2 further, do NOT re-litigate the Documents-tab parsing
   library choices or the `.doc`/`.ppt` scope line, do NOT re-diagnose the nginx
   `mime.types` or `max_tokens` fixes — all done, deployed, and verified working live
   tonight.
4. Remember: `cd ~/GeeMack` **before** running `git am` — this tripped up two separate
   deploys this session (ran from `~` by mistake both times) before being caught and
   corrected. Always confirm with `pwd` before applying a patch if there's any doubt.

Great session — three full phases shipped, deployed, and real-world tested in one sitting,
plus three separate backend/infra bugs found and fixed along the way (cron restart storm,
nginx MIME type, API token truncation). Picking back up tomorrow with the Documents
format-testing results.

---

## 2026-08-18 — Real bug found via user's offline format testing: JSON leaking into translations, fixed with structured tool-use output

User tested the remaining Phase 3 formats (CSV/PPTX/XLSX/EPUB/MD/RTF/ODT) plus two image
files offline and reported back. Results:

- **Real bug, consistent across every non-PDF format tested, in both Chinese and
  German**: the translated-result box showed the full raw JSON blob
  (`{"detected":"en","detectedName":"English","translation":"..."}`) instead of clean
  translated text.
- **Root cause** (confirmed by reading `server.js`, not guessed): the `/api/translate`
  system prompt asked Claude to "Respond ONLY in this exact JSON format" as free text,
  and the handler did a naive `JSON.parse()` on that text with a fallback that dumps the
  raw text if parsing fails. In every failing case, the translation naturally included a
  quotation mark — e.g. Chinese `测试"文档"选项卡` and German `im Reiter „Dokumente"`,
  both from the model quoting the word "Documents" (a UI tab name) as a natural
  translation choice — and the model didn't reliably escape that internal `"` as `\"`
  inside the JSON string it hand-wrote. One unescaped quote breaks `JSON.parse`, which
  throws, and the existing fallback path dumps the whole almost-valid JSON blob into the
  UI as if it were the translation. This is a known general reliability problem with
  asking a model to hand-write valid JSON as text — it isn't specific to Documents, and
  **Translate (Phase 1) and Camera OCR (Phase 2) call this same endpoint and are equally
  exposed**; they just hadn't hit a translation containing a quote mark during testing.
- **Fixed properly, not patched around**: rewrote `/api/translate` to use Anthropic's
  tool-use feature with a forced `tool_choice` instead of asking the model to write JSON
  as text. Defined a `provide_translation` tool with an `input_schema` for
  `detected`/`detectedName`/`translation`; the API itself parses and validates the
  arguments and hands back a real object — there's no free-text JSON left for an
  unescaped quote (or stray prose before/after the JSON, which was likely a second
  failure mode — see below) to break. This eliminates the whole bug class rather than
  attempting to regex-repair or re-escape the model's free text, which would be fragile.
- **Also fixed in the same edit**: `LANG_NAMES` was missing `he`/`ro`/`hu` (flagged as a
  minor, non-blocking gap in an earlier session's log entry) — added now since the file
  was already open for this change.
- **The two image files (`rover0710.jpg`, `zentoro.png`) are a different, non-bug
  situation, worth being clear about**: Tesseract OCR extracted garbled/incoherent text
  from them (decorative symbols, fragments, mixed scripts), and Claude correctly and
  honestly reported that the input wasn't real translatable text rather than fabricating
  a fake translation — that's the *correct* behavior, not a defect. They only looked like
  "errors" because the same JSON-escaping bug above also corrupted how that honest
  response got displayed. Once the tool-use fix is live, these should render as a clean
  "unable to translate" message rather than raw JSON. If those two images were actually
  expected to contain clear text, worth a second look with a better-quality source image,
  but that's an OCR/image-quality question, not a code fix.
- `node --check server.js` passes. **Not yet deployed or verified live** — this sandbox
  has no `ANTHROPIC_API_KEY`, same limitation as the max_tokens fix yesterday. Needs a
  real test on Apollo1 across the formats that failed (MD/ODT/PPTX/RTF, Chinese and
  German at minimum) plus a spot-check on Translate and Camera OCR with text that
  includes a quotation mark, since this fix covers all three tabs.

**Next: deploy this patch (same drill — `cd ~/GeeMack` first, `git am`, `git push`,
`cd ~/GEEMACK && git pull`, `pm2 restart talkbridge` since this changes `server.js`), then
have the user re-test the formats that failed. Once confirmed, Phase 3 is genuinely done
and Phase 4 (Group Chat) can start.**
