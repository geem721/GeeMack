# Instructions for any Claude session working in this repo

**Read these two files before doing anything else in this repo:**
1. `PROJECT_LOG.md` — read the most recent (top) entry first. It says exactly what was
   done last session and what to do next. Do not repeat completed work. Do not re-ask
   decisions that are already marked as made.
2. `MIGRATION_PLAN.md` — the current plan for migrating this app from a single-file
   `public/index.html` to a proper React app, in phases. This is an active, standing
   decision, not a suggestion up for debate.

Also read `POSTMORTEM.md` once, for background — it explains why this migration plan
exists and doesn't need to be re-derived or re-investigated.

## Standing rules for this project

- **Deployment target is Apollo1**, self-hosted, not Vercel. `server.js` is a persistent
  Express + `ws` process (needed for the live-caption WebSocket). There are two local
  clones on Apollo1 that must be kept in sync: `~/GEEMACK` and `~/GeeMack` — the live
  server actually runs from `~/GeeMack`, nginx proxies to it on port 3000. Check both when
  debugging "my fix isn't showing up."
- **Direct `git push` from a sandboxed session will fail** with a repo-authorization error
  from the git proxy. The working pattern that's been proven reliable: make the change
  locally, commit, then hand the user a single self-contained command to run on Apollo1
  (base64-encoded Python doing an exact string replace is more reliable than multi-line
  heredocs or `git am` patches, which have repeatedly gotten truncated or mangled by the
  user's terminal/SSH client).
- **Before ending a session that did real work in this repo, append a new entry to the top
  of `PROJECT_LOG.md`**: what was completed (with commit hashes), what was discovered,
  what's next. This is not optional — it's the only mechanism that lets the next session
  (which starts with zero memory of this one) pick up correctly instead of re-doing or
  contradicting prior work.
- **Research before proposing.** Before suggesting a fix or a plan, check what's actually
  in the code/git history rather than guessing from symptoms alone — several bugs in this
  project's history turned out to have a different root cause than the first plausible
  explanation.
