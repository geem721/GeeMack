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

**Next session should:**
1. Confirm with the user whether the original "translates to Spanish" bug is actually
   gone now that the deploy pipeline is fixed. If not, the investigation needs to restart
   from an accurate baseline — don't assume `76b304a`/`997d50f` are sufficient just
   because they're finally deployed.
2. Get the current real nginx config for `talk-bridge.org` (`sudo nginx -T` or the
   sites-enabled file) and write the `location /react-preview/` block against it — not
   yet done. Deploy commit `bbc70ff` (Vite base path) alongside it.
3. Once Phase 0 is reachable and confirmed in a browser, start Phase 1 (Translate tab).
4. Do NOT re-ask whether to do the React migration, whether to include the 3 extra
   languages, repo location, or Video Call's own tab — all four are decided. Do NOT
   re-investigate the May 2026 React→HTML regression — that's fully documented in
   `POSTMORTEM.md`. DO treat "is the original bug actually fixed" as still open until the
   user confirms it themselves post-deploy-fix.
