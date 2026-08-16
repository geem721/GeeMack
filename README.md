# TalkBridge — GEEMACK Platform

Universal AI-powered translation app with:
- Auto language detection
- Camera OCR (point at real-world text)
- Document translation (PDF, DOCX, XLSX, PPTX, images, and more)
- Voice input + text-to-speech
- Translation history
- Group chat with live-translated messages
- Video calls (LiveKit) with real-time translated captions (Deepgram STT + Claude translation)

## Project Structure

talkbridge/
  public/index.html   - The full app (frontend)
  server.js            - Express server: /api/translate, /api/livekit-token, /ws/transcribe
  package.json
  README.md

## Deployment

TalkBridge is self-hosted on Apollo1 as a persistent Node process (server.js), not deployed to
Vercel. The live-caption feature depends on a long-lived WebSocket connection
(/ws/transcribe) for streaming audio to Deepgram, which serverless platforms like Vercel don't
support well — this is why the app runs as a standalone Express + ws server instead of
serverless functions.

Pushes to master are picked up automatically on Apollo1. (If you're setting this up fresh:
document the exact mechanism here — e.g. a git webhook, a poll/cron git pull, or a
systemd/pm2 watcher — so the next person doesn't have to reverse-engineer it.)

Required environment variables (see .env, not committed):
- ANTHROPIC_API_KEY — used by /api/translate
- DEEPGRAM_API_KEY — used by /ws/transcribe
- LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL — used by /api/livekit-token

## Local Development

npm install
npm start

Then open http://localhost:3000. Unlike the old Vercel setup, /api/translate and the other
API routes work locally too, since they're just Express routes served by server.js — no
separate serverless dev environment needed.
