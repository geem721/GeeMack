# Postmortem: Loss of the React Version of TalkBridge

## What the repo actually shows (verified from git history)

TalkBridge started as a React app (Vite + `src/App.jsx` + `src/main.jsx`), not the
single-file `public/index.html` it is today. Timeline, all commit hashes/dates pulled
directly from `git log`:

| Date | Commit | What happened |
|---|---|---|
| 2026-05-05 | `a199909` | "TalkBridge app complete" — React app (Vite) working |
| 2026-05-06 to 05-10 | several | Bug fixes to the React app (translation, API routing, model name) |
| 2026-05-10 | `fd5a5fe` | **Added 14 languages** to the React app's language list: Dutch, Swedish, Polish, Turkish, Greek, Vietnamese, Thai, Indonesian, Czech, Ukrainian, Hebrew, Urdu, Romanian, Hungarian |
| 2026-05-10 | `5822ef1` | **Added a "⏺ Record" tab** to the React app — records mic audio via `MediaRecorder`, lets you play back and download each recording as a `.webm` file |
| 2026-05-12 | `d57ac83` | "Add TalkBridge app" — a **brand-new, from-scratch `public/index.html`** (1577 lines) is added. This is a different codebase, not a build output of the React app. `src/App.jsx` still exists in the repo at this point but nothing serves or builds it anymore. |
| 2026-05-13 | `166319b` | "Fix Model name" — despite the commit title, this commit **deletes `src/App.jsx` (417 lines) and `src/main.jsx`** entirely, along with `vercel.json`'s React build config. The single-file `public/index.html` is now the only version of the app. |

Everything built since May 13 — Group Chat with Firebase (June 2), the invite/presence
system (June 24), the LiveKit video call with Deepgram captions (June 27, Aug 9), and all
three bug fixes from this session (Aug 16) — was built on top of `public/index.html`, not
the React app. None of that work exists in React form.

## What was lost

- **14 languages** that only ever existed in the React version: Dutch, Swedish, Polish,
  Turkish, Greek, Vietnamese, Thai, Indonesian, Czech, Ukrainian, Hebrew, Urdu, Romanian,
  Hungarian. Some of these (Dutch, Swedish, Polish, Turkish, Vietnamese, Thai) did later
  get re-added by hand to some (not all) of the dropdowns in `public/index.html` — Hebrew,
  Romanian, and Hungarian never came back anywhere in the app.
- **The Record tab** — standalone mic recording with playback/download. No equivalent
  exists in `public/index.html` today.
- As a side effect of the rewrite happening by hand rather than from one shared source,
  every panel in `public/index.html` (Translate, Camera OCR, Documents, Group Chat) ended
  up with its own independently hand-typed language list, and they drifted out of sync
  with each other over the following months.

## What I can't verify

Git records *what* changed and *when* — it doesn't record *why*, or which tool or person
made the call to rewrite from scratch instead of continuing the React app. Every commit
in this repo, from the original React app through today, is authored under your GitHub
identity (`geem721`), which is what you'd see whether the commit was typed by hand, pasted
from an AI tool's output, or made by an agent operating on your behalf — the repository
itself doesn't distinguish between those. I don't have visibility into whatever
conversation happened around May 12–13, so I'm not going to guess at attribution I can't
back up from what's actually in front of me. What I can say with certainty is exactly what
changed, in what order, and what it cost — which is the table above.

## Where things stand now

`public/index.html` + `server.js` is a working, self-hosted app (on Apollo1) with: text
translation, camera OCR, document translation, group chat with live translation, and video
calls with real-time translated captions. It works, but it's a single 1300+ line HTML file
with all markup/CSS/JS inline, no component structure, no shared state management, and
(as of today) at least four independently-drifted copies of the language list.

See `MIGRATION_PLAN.md` for the plan to move this to a proper React app without losing any
of the functionality built since May 13, and see `PROJECT_LOG.md` for the running,
session-by-session record of progress on that plan.
