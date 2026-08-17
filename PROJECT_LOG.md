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
