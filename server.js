import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import deepgramSdk from '@deepgram/sdk';
const { createClient, LiveTranscriptionEvents } = deepgramSdk;
import { AccessToken } from 'livekit-server-sdk';
import twilio from 'twilio';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Firebase ID token verification (no Admin SDK / service-account key needed) ---
// Verifies the JWT Firebase Auth issues against Google's public keys. Used to identify
// the calling user for /api/translate's monthly fair-use cap, without pulling in
// firebase-admin (which needs a service-account key -- the same kind of GCP key-creation
// operation blocked by this org's iam.disableServiceAccountKeyCreation policy).
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);
async function verifyFirebaseToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    return payload.sub; // Firebase uid
  } catch (err) {
    console.warn('[auth] Firebase ID token rejected:', err.message);
    return null;
  }
}

// --- Monthly translation fair-use cap (574 msgs/user/month) ---
// Usage counted in Firebase RTDB at usage/{uid}/{yyyy-mm}/count via RTDB's built-in
// atomic server-side increment (.sv increment) over plain REST + a database secret --
// same no-Admin-SDK reasoning as above.
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET;
const MONTHLY_TRANSLATE_CAP = 574;
function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
async function getMonthlyTranslateUsage(uid) {
  const url = `${FIREBASE_DB_URL}/usage/${uid}/${currentMonthKey()}/count.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url);
    const val = await res.json();
    if (!res.ok || (val && typeof val === 'object' && val.error)) {
      console.error('[translate-cap] usage read failed:', res.status, JSON.stringify(val));
      return 0; // fail open -- a read error shouldn't block a real user
    }
    return typeof val === 'number' ? val : 0;
  } catch (err) {
    console.error('[translate-cap] usage read failed:', err.message);
    return 0;
  }
}
async function incrementMonthlyTranslateUsage(uid) {
  const url = `${FIREBASE_DB_URL}/usage/${uid}/${currentMonthKey()}.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: { '.sv': { increment: 1 } } }),
    });
    const val = await res.json();
    if (!res.ok || (val && typeof val === 'object' && val.error)) {
      console.error('[translate-cap] increment failed:', res.status, JSON.stringify(val));
    }
  } catch (err) {
    console.error('[translate-cap] increment failed:', err.message);
  }
}

app.post('/api/translate', async (req, res) => {
  const { text, srcLang, tgtLang } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'Sign in required to translate.' });
  const usage = await getMonthlyTranslateUsage(uid);
  if (usage >= MONTHLY_TRANSLATE_CAP) {
    return res.status(429).json({ error: `Monthly translation limit reached (${MONTHLY_TRANSLATE_CAP}). Resets at the start of next month. (Option to purchase more credits coming soon.)` });
  }

  const LANG_NAMES = {
    auto:'Auto-Detected', en:'English', es:'Spanish', fr:'French', de:'German',
    it:'Italian', pt:'Portuguese', zh:'Chinese', ja:'Japanese', ko:'Korean',
    ar:'Arabic', ru:'Russian', hi:'Hindi', sw:'Swahili', nl:'Dutch',
    pl:'Polish', tr:'Turkish', vi:'Vietnamese', th:'Thai', uk:'Ukrainian',
    id:'Indonesian', fa:'Persian', bn:'Bengali', el:'Greek', sv:'Swedish',
    cs:'Czech', ur:'Urdu', he:'Hebrew', ro:'Romanian', hu:'Hungarian'
  };

  const srcName = LANG_NAMES[srcLang] || srcLang;
  const tgtName = LANG_NAMES[tgtLang] || tgtLang;
  const autoDetect = srcLang === 'auto';

  const systemPrompt = autoDetect
    ? `You are a professional translator with auto language detection. Detect the source language of the given text and translate it to ${tgtName}. Call the provide_translation tool with the result.`
    : `You are a professional translator. Translate the given text from ${srcName} to ${tgtName}. Call the provide_translation tool with the result.`;

  // Structured output via tool-use, not hand-written JSON in free text. The earlier
  // version asked the model to "respond ONLY in this exact JSON format" as plain text,
  // then JSON.parse'd it with a fallback that dumped the raw text on failure. That broke
  // in real use whenever a translation naturally contained a quotation mark (e.g.
  // quoting a UI element name like "Documents") — the model doesn't reliably escape an
  // internal `"` as `\"` in hand-written JSON, one unescaped quote breaks JSON.parse, and
  // the raw near-JSON blob ends up displayed as the "translation" in the UI. Confirmed
  // live across MD/ODT/PPTX/RTF in both Chinese and German — same root cause every time.
  // Tool-use sidesteps the whole class of bug: the API parses/validates the arguments
  // itself and hands back a real object, so there's no free-text JSON for an unescaped
  // quote (or stray prose before/after the JSON) to break.
  const TRANSLATE_TOOL = {
    name: 'provide_translation',
    description: 'Provide the translation result for the given text.',
    input_schema: {
      type: 'object',
      properties: {
        detected: { type: 'string', description: 'ISO 639-1 code of the detected/source language' },
        detectedName: { type: 'string', description: 'Full English name of the detected/source language' },
        translation: { type: 'string', description: 'The translated text, in the target language' }
      },
      required: ['detected', 'detectedName', 'translation']
    }
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // 4096 gives real headroom for a ~3000-char document chunk in any target
        // language without being an unbounded blank check (see prior session's fix for
        // the truncation bug this was originally raised to 4096 for).
        max_tokens: 4096,
        system: systemPrompt,
        tools: [TRANSLATE_TOOL],
        tool_choice: { type: 'tool', name: 'provide_translation' },
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const toolUse = data.content?.find(b => b.type === 'tool_use' && b.name === 'provide_translation');
    if (toolUse?.input?.translation !== undefined) {
      incrementMonthlyTranslateUsage(uid);
      return res.status(200).json(toolUse.input);
    }

    // Shouldn't normally happen with tool_choice forcing the tool call, but keep a
    // safety net rather than a hard 500 if the API ever returns a plain text block
    // instead (e.g. a refusal).
    const raw = data.content?.find(b => b.type === 'text')?.text || '';
    incrementMonthlyTranslateUsage(uid);
    return res.status(200).json({
      detected: srcLang,
      detectedName: srcName,
      translation: raw || '[No translation returned]'
    });
  } catch (err) {
    console.error('Translate error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// =====================================================================================
// Phone / Video Call monthly usage caps -- Sept 8 2026 (Greg's call): prevent a user
// from running up Twilio/Deepgram/TTS charges beyond what the Starter tier's $27.99/mo
// actually covers. Same fail-open RTDB pattern as the 574/mo translate cap above: an
// RTDB error logs clearly and lets the request through rather than blocking real usage
// over an infra hiccup. Sized from TalkBridge_Cost_Cap_Model.xlsx (Tier Caps sheet,
// Starter row): 35 min/mo domestic phone, 13 min/mo international phone, 609 min/mo
// video. Every account gets the Starter allotment for now -- there's no live
// tier-selection or billing yet (blocked on LLC formation), so this is the same flat
// free/beta cap approach already used for the 574 translate cap.
// =====================================================================================
const PHONE_DOMESTIC_CAP_SEC = 35 * 60;
const PHONE_INTL_CAP_SEC = 13 * 60;
const VIDEO_MONTHLY_CAP_SEC = 609 * 60;
// Hard per-call safety net independent of the monthly cap -- caps any single call at
// 90 minutes so one forgotten/stuck-open call can't itself blow past a user's whole
// monthly allotment before the after-the-fact usage increment (below) ever runs.
// Twilio hangs the call up itself when this is hit.
const CALL_HARD_TIME_LIMIT_SEC = 90 * 60;

// CallSid -> { uid, route, leg } for calls placed via /api/call/bridge, used by
// /api/call/status to attribute Twilio's own reported CallDuration back to a user once
// the call actually completes (source of truth for phone minutes -- not client-reported).
const callUsageMeta = new Map();

// NANP (North American Numbering Plan, +1) covers US + Canada -- the only "domestic"
// countries in V1 scope. Everything else in scope (+44 UK, +49 Germany, +33 France,
// +81 Japan) is "international" for cap purposes.
function isNanpNumber(e164) {
  return typeof e164 === 'string' && e164.startsWith('+1');
}

async function getMonthlyPhoneUsageSec(uid, route) {
  const field = route === 'domestic' ? 'domesticSec' : 'internationalSec';
  const url = `${FIREBASE_DB_URL}/usage/phone/${currentMonthKey()}/${uid}/${field}.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url);
    const val = await res.json();
    if (!res.ok || (val && typeof val === 'object' && val.error)) {
      console.error('[phone-cap] usage read failed:', res.status, JSON.stringify(val));
      return 0; // fail open -- a read error shouldn't block a real user
    }
    return typeof val === 'number' ? val : 0;
  } catch (err) {
    console.error('[phone-cap] usage read failed:', err.message);
    return 0;
  }
}
async function incrementMonthlyPhoneUsageSec(uid, route, seconds) {
  if (!seconds || seconds <= 0) return;
  const field = route === 'domestic' ? 'domesticSec' : 'internationalSec';
  const url = `${FIREBASE_DB_URL}/usage/phone/${currentMonthKey()}/${uid}.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: { '.sv': { increment: seconds } } }),
    });
    const val = await res.json();
    if (!res.ok || (val && typeof val === 'object' && val.error)) {
      console.error('[phone-cap] increment failed:', res.status, JSON.stringify(val));
    }
  } catch (err) {
    console.error('[phone-cap] increment failed:', err.message);
  }
}

async function getMonthlyVideoUsageSec(uid) {
  const url = `${FIREBASE_DB_URL}/usage/video/${currentMonthKey()}/${uid}.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url);
    const val = await res.json();
    if (!res.ok || (val && typeof val === 'object' && val.error)) {
      console.error('[video-cap] usage read failed:', res.status, JSON.stringify(val));
      return 0;
    }
    return typeof val === 'number' ? val : 0;
  } catch (err) {
    console.error('[video-cap] usage read failed:', err.message);
    return 0;
  }
}
async function incrementMonthlyVideoUsageSec(uid, seconds) {
  if (!seconds || seconds <= 0) return;
  const url = `${FIREBASE_DB_URL}/usage/video/${currentMonthKey()}.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [uid]: { '.sv': { increment: seconds } } }),
    });
    const val = await res.json();
    if (!res.ok || (val && typeof val === 'object' && val.error)) {
      console.error('[video-cap] increment failed:', res.status, JSON.stringify(val));
    }
  } catch (err) {
    console.error('[video-cap] increment failed:', err.message);
  }
}

app.post('/api/livekit-token', async (req, res) => {
  const { roomName, participantName } = req.body;
  if (!roomName || !participantName) {
    return res.status(400).json({ error: 'roomName and participantName are required' });
  }
  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'Sign in required for Video Call.' });
  const videoUsageSec = await getMonthlyVideoUsageSec(uid);
  if (videoUsageSec >= VIDEO_MONTHLY_CAP_SEC) {
    return res.status(429).json({ error: `Monthly video call limit reached (${Math.round(VIDEO_MONTHLY_CAP_SEC / 60)} min). Resets at the start of next month. (Option to purchase more credits coming soon.)` });
  }
  try {
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: participantName }
    );
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    return res.json({ token, url: process.env.LIVEKIT_URL });
  } catch (err) {
    console.error('LiveKit token error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// --- Video call usage heartbeat -- client pings this every 30s while in an active
// video call; server ticks the caller's monthly video-minute usage by the same amount
// and tells the client to leave if the monthly cap is now exceeded. This is the
// enforcement point for a call already in progress (the check above only blocks a NEW
// call from starting); duration is measured server-side from these pings rather than
// trusted from the client, so a client can under-report (lose tracking) but not
// over-claim free minutes.
const VIDEO_HEARTBEAT_SEC = 30;
app.post('/api/videocall/heartbeat', async (req, res) => {
  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'Sign in required.' });
  await incrementMonthlyVideoUsageSec(uid, VIDEO_HEARTBEAT_SEC);
  const usageSec = await getMonthlyVideoUsageSec(uid);
  if (usageSec >= VIDEO_MONTHLY_CAP_SEC) {
    return res.status(200).json({ ok: false, error: `Monthly video call limit reached (${Math.round(VIDEO_MONTHLY_CAP_SEC / 60)} min). Resets at the start of next month. (Option to purchase more credits coming soon.)` });
  }
  return res.status(200).json({ ok: true });
});

// --- Outbound phone call (Twilio Voice) ---
app.post('/api/call/start', async (req, res) => {
  const { to, targetLang } = req.body;
  if (!to) return res.status(400).json({ error: 'Destination phone number (to) is required' });
  try {
    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://talk-bridge.org/api/call/twiml?targetLang=${encodeURIComponent(targetLang || 'es')}`,
      statusCallback: 'https://talk-bridge.org/api/call/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
    return res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('Call start error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/call/twiml', (req, res) => {
  const targetLang = req.query.targetLang || 'es';
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'This is a test call from Talk Bridge. The translation pipeline will connect here soon.');
  res.type('text/xml');
  res.send(twiml.toString());
});

const FAILED_CALL_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);
app.post('/api/call/status', (req, res) => {
  const status = req.body?.CallStatus;
  const sid = req.body?.CallSid;
  const duration = req.body?.CallDuration; // seconds -- Twilio only sends this on 'completed'
  console.log('Call status update:', status, sid, duration ? `duration=${duration}s` : '');
  if (FAILED_CALL_STATUSES.has(status) && roomBySid.has(sid)) {
    const room = roomBySid.get(sid);
    roomBySid.delete(sid);
    cleanupFailedRecording(room);
  }
  if (callUsageMeta.has(sid)) {
    const meta = callUsageMeta.get(sid);
    if (status === 'completed' || FAILED_CALL_STATUSES.has(status)) {
      callUsageMeta.delete(sid);
      if (meta.leg === 'A' && status === 'completed' && duration) {
        incrementMonthlyPhoneUsageSec(meta.uid, meta.route, parseInt(duration, 10) || 0);
      }
    }
  }
  res.sendStatus(200);
});

// --- Two-leg conference bridge (live interpreted call) ---
app.post('/api/call/bridge', async (req, res) => {
  const { partyA, partyB, langA, langB, record } = req.body;
  if (!partyA || !partyB) {
    return res.status(400).json({ error: 'partyA and partyB phone numbers are required' });
  }
  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'Sign in required to place a call.' });

  // Domestic = both legs in the US/Canada NANP (+1); International = either leg
  // outside it (UK/Germany/France/Japan -- the rest of V1 scope). Matches the cost
  // model's own "both legs domestic" vs "worst-case route" assumption.
  const route = (isNanpNumber(partyA) && isNanpNumber(partyB)) ? 'domestic' : 'international';
  const capSec = route === 'domestic' ? PHONE_DOMESTIC_CAP_SEC : PHONE_INTL_CAP_SEC;
  const usageSec = await getMonthlyPhoneUsageSec(uid, route);
  if (usageSec >= capSec) {
    return res.status(429).json({ error: `Monthly ${route} phone limit reached (${Math.round(capSec / 60)} min). Resets at the start of next month. (Option to purchase more credits coming soon.)` });
  }

  const room = `talkbridge-${Date.now()}`;
  const recordFlag = record ? '1' : '0';
  try {
    const callA = await twilioClient.calls.create({
      to: partyA,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://talk-bridge.org/api/call/stream-twiml?room=${encodeURIComponent(room)}&leg=A&lang=${encodeURIComponent(langA || 'en')}&record=${recordFlag}`,
      statusCallback: 'https://talk-bridge.org/api/call/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeLimit: CALL_HARD_TIME_LIMIT_SEC
    });
    const callB = await twilioClient.calls.create({
      to: partyB,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://talk-bridge.org/api/call/stream-twiml?room=${encodeURIComponent(room)}&leg=B&lang=${encodeURIComponent(langB || 'es')}&record=${recordFlag}`,
      statusCallback: 'https://talk-bridge.org/api/call/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeLimit: CALL_HARD_TIME_LIMIT_SEC
    });
    // Tracked regardless of recording -- this is what lets /api/call/status attribute
    // Twilio's own reported CallDuration back to the right user + route for the
    // monthly cap. Only leg A's completion increments usage (both legs run
    // concurrently, so counting both would double the minutes); leg B is tracked only
    // so its entry gets cleaned up too. Unrelated to (and unchanged from) the
    // recording no-answer cleanup below, which still keys off roomBySid.
    callUsageMeta.set(callA.sid, { uid, route, leg: 'A' });
    callUsageMeta.set(callB.sid, { uid, route, leg: 'B' });
    if (record) {
      roomBySid.set(callA.sid, room);
      roomBySid.set(callB.sid, room);
    }
    return res.json({ room, callASid: callA.sid, callBSid: callB.sid });
  } catch (err) {
    console.error('Bridge call error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/call/hangup', async (req, res) => {
  const { callASid, callBSid } = req.body;
  if (!callASid && !callBSid) {
    return res.status(400).json({ error: 'callASid or callBSid required' });
  }
  const results = {};
  try {
    if (callASid) {
      await twilioClient.calls(callASid).update({ status: 'completed' });
      results.callA = 'completed';
    }
    if (callBSid) {
      await twilioClient.calls(callBSid).update({ status: 'completed' });
      results.callB = 'completed';
    }
    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('Hangup error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/call/conference-twiml', (req, res) => {
  const room = req.query.room || 'talkbridge-default';
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(room);
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/call/stream-twiml', (req, res) => {
  const room = req.query.room || 'talkbridge-default';
  const leg = req.query.leg || 'A';
  const lang = req.query.lang || 'en';
  const record = req.query.record === '1';
  const twiml = new twilio.twiml.VoiceResponse();
  if (record) {
    twiml.say('This call may be recorded for quality and translation purposes.');
  }
  const connect = twiml.connect();
  const stream = connect.stream({ url: 'wss://talk-bridge.org/ws/call-audio' });
  stream.parameter({ name: 'room', value: room });
  stream.parameter({ name: 'leg', value: leg });
  stream.parameter({ name: 'lang', value: lang });
  stream.parameter({ name: 'record', value: record ? '1' : '0' });
  res.type('text/xml');
  res.send(twiml.toString());
});
// --- Call recording download ---
app.get('/api/call/recording/:room', (req, res) => {
  const room = req.params.room;
  if (!/^[a-zA-Z0-9_-]+$/.test(room)) {
    return res.status(400).json({ error: 'Invalid room id' });
  }
  const filePath = path.join(RECORDINGS_DIR, `${room}.wav`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording not found - it may still be processing, or this call was not recorded.' });
  }
  res.download(filePath, `talkbridge-call-${room}.wav`);
});
// --- Video call recording (chunked upload from the browser's canvas+WebAudio
// compositor - see VideoCall.jsx). Uploaded in ~5s chunks as the call happens rather
// than one file at the end, so a crashed tab or dropped connection only loses the last
// few seconds. LiveKit's self-hosted Egress was considered and rejected for this: it
// needs Redis wired into the live production LiveKit server and only supports
// S3/Azure/GCS output, not a local file on Apollo1 (confirmed against LiveKit's own
// docs, Sept 6 session) - a plain chunked upload avoids both problems entirely. ---
app.post('/api/videocall/recording/start', (req, res) => {
  const { room } = req.body;
  if (!room || !/^[a-zA-Z0-9_-]+$/.test(room)) {
    return res.status(400).json({ error: 'Invalid room id' });
  }
  const recordingId = `videocall-${room}-${Date.now()}`;
  const tmpPath = path.join(RECORDINGS_DIR, `${recordingId}.webm.part`);
  const stream = fs.createWriteStream(tmpPath);
  videoRecordingSessions.set(recordingId, { stream, room, tmpPath, lastActivity: Date.now() });
  console.log(`[videocall-recording] started ${recordingId}`);
  res.json({ recordingId });
});
app.post('/api/videocall/recording/:id/chunk', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  const session = videoRecordingSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'No such recording session (it may have already been stopped or timed out)' });
  session.lastActivity = Date.now();
  session.stream.write(req.body, (err) => {
    if (err) {
      console.error(`[videocall-recording] write failed for ${req.params.id}:`, err);
      return res.status(500).json({ error: 'Write failed' });
    }
    res.sendStatus(200);
  });
});
app.post('/api/videocall/recording/:id/stop', (req, res) => {
  const session = videoRecordingSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'No such recording session' });
  finalizeVideoRecordingSession(req.params.id, session);
  res.json({ ok: true });
});
app.get('/api/videocall/recording/:room', (req, res) => {
  const room = req.params.room;
  if (!/^[a-zA-Z0-9_-]+$/.test(room)) {
    return res.status(400).json({ error: 'Invalid room id' });
  }
  fs.readdir(RECORDINGS_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'Could not read recordings' });
    const matches = files.filter((f) => f.startsWith(`videocall-${room}-`) && f.endsWith('.webm'));
    if (matches.length === 0) {
      return res.status(404).json({ error: 'No recording found for this room' });
    }
    matches.sort();
    const latest = matches[matches.length - 1];
    res.download(path.join(RECORDINGS_DIR, latest), `talkbridge-videocall-${room}.webm`);
  });
});

// --- Real-time captioning: /ws/transcribe ---
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const DEEPGRAM_LANG_MAP = {
  auto: 'multi', zh: 'zh', sw: 'sw', ur: 'ur'
};

function toDeepgramLang(code) {
  return DEEPGRAM_LANG_MAP[code] || code || 'en';
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const callWss = new WebSocketServer({ noServer: true });
const captionWss = new WebSocketServer({ noServer: true });
const captionSubscribers = new Map(); // room -> Set of ws
const callLegs = new Map(); // room -> { A: ws, B: ws }
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
// Retention: recordings (phone .wav, video call .webm) and any orphaned in-progress
// .webm.part files (a video recording whose browser tab crashed/closed before calling
// the /stop endpoint) are auto-deleted on a schedule so Apollo1's disk doesn't fill up
// as call volume grows. Orphaned .part files get a much shorter grace period since they
// can never be completed - unlike a finished recording someone might come back for.
const RECORDING_RETENTION_DAYS = 30;
const ORPHAN_PART_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day
function cleanupOldRecordings() {
  fs.readdir(RECORDINGS_DIR, (err, files) => {
    if (err) return console.error('[recording] cleanup readdir failed:', err);
    const now = Date.now();
    files.forEach((file) => {
      const filePath = path.join(RECORDINGS_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (statErr) return;
        const maxAge = file.endsWith('.part')
          ? ORPHAN_PART_RETENTION_MS
          : RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        if (now - stats.mtimeMs > maxAge) {
          fs.unlink(filePath, (unlinkErr) => {
            if (!unlinkErr) console.log(`[recording] deleted old file (retention): ${file}`);
          });
        }
      });
    });
  });
}
cleanupOldRecordings();
setInterval(cleanupOldRecordings, 24 * 60 * 60 * 1000);

// Retention: Group Chat message history (chats/{room}/messages in Firebase RTDB) grows
// forever otherwise -- the client's limitToLast(50) only bounds what's displayed, not
// what's stored. Same daily-sweep shape as cleanupOldRecordings() above, but hits the
// RTDB REST API (database secret, not Admin SDK) instead of the filesystem. 180 days,
// not 30: unlike call recordings, chat text is cheap to keep and people expect to be
// able to scroll back further.
const CHAT_RETENTION_DAYS = 180;
async function cleanupOldChatMessages() {
  if (!FIREBASE_DB_URL || !FIREBASE_DB_SECRET) return;
  try {
    const roomsRes = await fetch(`${FIREBASE_DB_URL}/chats.json?shallow=true&auth=${FIREBASE_DB_SECRET}`);
    const rooms = await roomsRes.json();
    if (!roomsRes.ok || (rooms && typeof rooms === 'object' && rooms.error)) {
      console.error('[chat-retention] room list read failed:', roomsRes.status, JSON.stringify(rooms));
      return;
    }
    if (!rooms) return;
    const cutoff = Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const room of Object.keys(rooms)) {
      const msgsUrl = `${FIREBASE_DB_URL}/chats/${room}/messages.json?orderBy="timestamp"&endAt=${cutoff}&auth=${FIREBASE_DB_SECRET}`;
      const msgsRes = await fetch(msgsUrl);
      const oldMsgs = await msgsRes.json();
      if (!msgsRes.ok || (oldMsgs && typeof oldMsgs === 'object' && oldMsgs.error)) {
        console.error(`[chat-retention] message read failed for #${room}:`, msgsRes.status, JSON.stringify(oldMsgs));
        continue;
      }
      if (!oldMsgs) continue;
      const ids = Object.keys(oldMsgs);
      if (ids.length === 0) continue;
      const deletePatch = Object.fromEntries(ids.map((id) => [id, null]));
      const delRes = await fetch(`${FIREBASE_DB_URL}/chats/${room}/messages.json?auth=${FIREBASE_DB_SECRET}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deletePatch),
      });
      if (!delRes.ok) {
        console.error(`[chat-retention] delete failed for #${room}:`, delRes.status);
        continue;
      }
      console.log(`[chat-retention] deleted ${ids.length} old message(s) from #${room}`);
    }
  } catch (err) {
    console.error('[chat-retention] cleanup failed:', err.message);
  }
}
cleanupOldChatMessages();
setInterval(cleanupOldChatMessages, 24 * 60 * 60 * 1000);
// In-memory video call recording sessions (chunked upload in progress) - see the
// /api/videocall/recording/* routes below. A session with no chunk activity for 5
// minutes is assumed abandoned (crashed/closed tab that never called /stop) and is
// auto-finalized so it doesn't leak an open file handle or sit in this Map forever.
const videoRecordingSessions = new Map(); // recordingId -> { stream, room, tmpPath, lastActivity }
function finalizeVideoRecordingSession(recordingId, session) {
  videoRecordingSessions.delete(recordingId);
  session.stream.end(() => {
    const finalPath = session.tmpPath.replace(/\.part$/, '');
    fs.stat(session.tmpPath, (err, stats) => {
      if (err) return;
      if (stats.size === 0) {
        fs.unlink(session.tmpPath, () => {});
        return;
      }
      fs.rename(session.tmpPath, finalPath, (renameErr) => {
        if (!renameErr) console.log(`[videocall-recording] finalized ${finalPath}`);
      });
    });
  });
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, session] of videoRecordingSessions.entries()) {
    if (session.lastActivity < cutoff) {
      console.log(`[videocall-recording] auto-finalizing abandoned session ${id} (no activity for 5min)`);
      finalizeVideoRecordingSession(id, session);
    }
  }
}, 60 * 1000);
const recordingRooms = new Map(); // room -> { A: {path, done}, B: {path, done} }
const roomBySid = new Map(); // callSid -> room (only tracked when recording is on, for no-answer cleanup)
function cleanupFailedRecording(room) {
  if (!recordingRooms.has(room)) return;
  recordingRooms.delete(room);
  ['A', 'B'].forEach((leg) => {
    const p = path.join(RECORDINGS_DIR, `${room}-${leg}.raw`);
    fs.unlink(p, () => {}); // ignore errors - the leg that never answered has no file
  });
  console.log(`[recording] cleaned up incomplete recording for room=${room} (call did not complete)`);
}
function maybeMixRecording(room) {
  const info = recordingRooms.get(room);
  if (!info || !info.A || !info.B || !info.A.done || !info.B.done) return;
  recordingRooms.delete(room);
  const outPath = path.join(RECORDINGS_DIR, `${room}.wav`);
  const ff = spawn('ffmpeg', [
    '-f', 'mulaw', '-ar', '8000', '-i', info.A.path,
    '-f', 'mulaw', '-ar', '8000', '-i', info.B.path,
    '-filter_complex', '[0:a][1:a]amerge=inputs=2',
    '-ac', '2',
    outPath
  ]);
  ff.stderr.on('data', (d) => console.log(`[recording] ffmpeg[${room}]: ${d}`));
  ff.on('close', (code) => {
    if (code === 0) {
      console.log(`[recording] saved ${outPath}`);
      fs.unlink(info.A.path, () => {});
      fs.unlink(info.B.path, () => {});
    } else {
      console.error(`[recording] ffmpeg failed for room=${room} code=${code}`);
    }
  });
}
const CALL_LANG_NAMES = {
  auto:'Auto-Detected', en:'English', es:'Spanish', fr:'French', de:'German',
  it:'Italian', pt:'Portuguese', zh:'Chinese', ja:'Japanese', ko:'Korean',
  ar:'Arabic', ru:'Russian', hi:'Hindi', sw:'Swahili', nl:'Dutch',
  pl:'Polish', tr:'Turkish', vi:'Vietnamese', th:'Thai', uk:'Ukrainian',
  id:'Indonesian', fa:'Persian', bn:'Bengali', el:'Greek', sv:'Swedish',
  cs:'Czech', ur:'Urdu', he:'Hebrew', ro:'Romanian', hu:'Hungarian'
};

async function translateForCall(text, srcLang, tgtLang) {
  const srcName = CALL_LANG_NAMES[srcLang] || srcLang;
  const tgtName = CALL_LANG_NAMES[tgtLang] || tgtLang;
  const systemPrompt = `You are a professional live interpreter on a phone call. Translate the given spoken text from ${srcName} to ${tgtName}. Keep it natural and conversational, not formal document style. Call the provide_translation tool with the result.`;
  const TRANSLATE_TOOL = {
    name: 'provide_translation',
    description: 'Provide the translation result for the given text.',
    input_schema: {
      type: 'object',
      properties: {
        translation: { type: 'string', description: 'The translated text, in the target language' }
      },
      required: ['translation']
    }
  };
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: systemPrompt,
      tools: [TRANSLATE_TOOL],
      tool_choice: { type: 'tool', name: 'provide_translation' },
      messages: [{ role: 'user', content: text }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const toolUse = data.content?.find(b => b.type === 'tool_use' && b.name === 'provide_translation');
  if (toolUse?.input?.translation !== undefined) {
    return toolUse.input.translation;
  }
  throw new Error('No translation returned');
}

const TTS_VOICE_MODELS = {
  en: 'aura-2-thalia-en',
  es: 'aura-2-celeste-es',
  fr: 'aura-2-agathe-fr',
  de: 'aura-2-julius-de',
  it: 'aura-2-melia-it',
  nl: 'aura-2-beatrix-nl',
  ja: 'aura-2-fujin-ja'
};

const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const ELEVENLABS_TTS_LANGUAGES = new Set([
  'pt', 'zh', 'ko', 'ar', 'ru', 'hi', 'pl', 'tr', 'vi', 'uk', 'id', 'el', 'sv', 'cs', 'ro', 'hu'
]);

// Google Cloud TTS (Chirp3-HD) covers the languages ElevenLabs/Deepgram don't.
// Confirmed via a live voices.list API call (not docs) on 2026-09-05 -- Persian (fa-IR)
// returned zero voices and is intentionally NOT included; dropped from phone-feature
// scope for now rather than adding a 4th vendor for one language.
const GOOGLE_TTS_VOICE_MODELS = {
  th: { languageCode: 'th-TH', name: 'th-TH-Chirp3-HD-Achernar' },
  bn: { languageCode: 'bn-IN', name: 'bn-IN-Chirp3-HD-Achernar' },
  ur: { languageCode: 'ur-IN', name: 'ur-IN-Chirp3-HD-Achernar' },
  he: { languageCode: 'he-IL', name: 'he-IL-Chirp3-HD-Achernar' }
};

async function speakViaGoogleCloud(text, legInfo) {
  const voice = GOOGLE_TTS_VOICE_MODELS[legInfo.lang];
  if (!voice) return;
  const startTime = Date.now();
  try {
    const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voice.languageCode, name: voice.name },
        audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 }
      })
    });
    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[call-audio] TTS(google) http error status=${response.status} body=${errBody}`);
      return;
    }
    const data = await response.json();
    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    if (legInfo.ws.readyState !== legInfo.ws.OPEN) {
      console.log(`[call-audio] TTS(google) skipping send, target leg websocket closed (lang=${legInfo.lang})`);
      return;
    }
    legInfo.ws.send(JSON.stringify({
      event: 'media',
      streamSid: legInfo.streamSid,
      media: { payload: audioBuffer.toString('base64') }
    }));
    const totalTime = Date.now() - startTime;
    console.log(`[call-audio] TTS(google) complete: ${audioBuffer.length} bytes, total=${totalTime}ms (lang=${legInfo.lang})`);
  } catch (err) {
    console.error(`[call-audio] TTS(google) exception message=${err?.message}`, err);
  }
}

async function speakToLeg(text, legInfo) {
  if (!legInfo || !legInfo.ws || !legInfo.streamSid || !text) return;
  if (legInfo.ws.readyState !== legInfo.ws.OPEN) {
    console.log(`[call-audio] skipping TTS send, target leg websocket not open (lang=${legInfo.lang})`);
    return;
  }
  if (TTS_VOICE_MODELS[legInfo.lang]) {
    return speakViaDeepgram(text, legInfo);
  }
  if (ELEVENLABS_TTS_LANGUAGES.has(legInfo.lang)) {
    return speakViaElevenLabs(text, legInfo);
  }
  if (GOOGLE_TTS_VOICE_MODELS[legInfo.lang]) {
    return speakViaGoogleCloud(text, legInfo);
  }
  console.log(`[call-audio] no TTS voice available for lang=${legInfo.lang}, skipping speak-back`);
}

async function speakViaDeepgram(text, legInfo) {
  const model = TTS_VOICE_MODELS[legInfo.lang];
  const ttsUrl = `wss://api.deepgram.com/v1/speak?model=${model}&encoding=mulaw&sample_rate=8000&container=none`;
  const startTime = Date.now();
  let firstChunkTime = null;
  let totalBytes = 0;
  let chunkCount = 0;

  const ttsWs = new WebSocket(ttsUrl, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
  });

  ttsWs.on('open', () => {
    ttsWs.send(JSON.stringify({ type: 'Speak', text }));
    ttsWs.send(JSON.stringify({ type: 'Flush' }));
  });

  ttsWs.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        console.log(`[call-audio] TTS(deepgram) first audio chunk after ${firstChunkTime - startTime}ms (lang=${legInfo.lang})`);
      }
      totalBytes += data.length;
      chunkCount += 1;
      if (legInfo.ws.readyState === legInfo.ws.OPEN) {
        legInfo.ws.send(JSON.stringify({
          event: 'media',
          streamSid: legInfo.streamSid,
          media: { payload: data.toString('base64') }
        }));
      }
    } else {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      if (msg.type === 'Flushed') {
        const totalMs = Date.now() - startTime;
        console.log(`[call-audio] TTS(deepgram) complete: ${totalBytes} bytes in ${chunkCount} chunks, total=${totalMs}ms, first-chunk=${firstChunkTime ? firstChunkTime - startTime : 'n/a'}ms (lang=${legInfo.lang})`);
        ttsWs.send(JSON.stringify({ type: 'Close' }));
      } else if (msg.type === 'Warning') {
        console.error(`[call-audio] TTS(deepgram) warning: ${JSON.stringify(msg)}`);
      }
    }
  });

  ttsWs.on('error', (err) => {
    console.error(`[call-audio] TTS(deepgram) websocket error message=${err?.message}`, err);
  });

  ttsWs.on('close', () => {});
}

// =====================================================================================
// ElevenLabs shared monthly credit pool tracking -- Sept 8 2026. Auto Top Up is
// confirmed OFF, so the real risk isn't overage cost, it's the pool silently pausing
// mid-month (no more ElevenLabs-routed TTS for ANY user until next month) with no
// warning. This is a single shared counter across every user (not a per-user cap),
// sized from TalkBridge_Cost_Cap_Model.xlsx (ElevenLabs Pool sheet): 30,000
// characters/month at 1 credit/char worst case, alert at 70% (21,000 chars). Only
// speakViaElevenLabs() ever sends text to ElevenLabs -- Video Call captions are
// text-only, no TTS -- so this one hook point covers all real usage.
const ELEVENLABS_POOL_CHARS = 30000;
const ELEVENLABS_ALERT_THRESHOLD = 0.7;
let elevenLabsAlertFiredForMonth = null; // yyyy-mm once the alert has fired, so it only logs once per month

async function incrementElevenLabsPoolUsage(chars) {
  if (!chars || chars <= 0) return;
  const key = currentMonthKey();
  const url = `${FIREBASE_DB_URL}/usage/_aggregate/elevenlabs/${key}.json?auth=${FIREBASE_DB_SECRET}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chars: { '.sv': { increment: chars } } }),
    });
    const val = await res.json();
    if (!res.ok || (val && val.error)) {
      console.error('[elevenlabs-pool] increment failed:', res.status, JSON.stringify(val));
      return;
    }
    const newTotal = typeof val?.chars === 'number' ? val.chars : null;
    if (newTotal === null) return;
    const thresholdChars = ELEVENLABS_POOL_CHARS * ELEVENLABS_ALERT_THRESHOLD;
    if (newTotal >= ELEVENLABS_POOL_CHARS) {
      console.error(`[elevenlabs-pool] POOL LIKELY EXHAUSTED: ${newTotal}/${ELEVENLABS_POOL_CHARS} characters used this month -- ElevenLabs TTS may already be failing for all users until next month.`);
    } else if (newTotal >= thresholdChars && elevenLabsAlertFiredForMonth !== key) {
      elevenLabsAlertFiredForMonth = key;
      console.error(`[elevenlabs-pool] ALERT: ${newTotal}/${ELEVENLABS_POOL_CHARS} characters used this month (${Math.round((newTotal / ELEVENLABS_POOL_CHARS) * 100)}%) -- the shared ElevenLabs pool may pause before month-end (Auto Top Up is off). Check the ElevenLabs dashboard / consider upgrading the plan.`);
    }
  } catch (err) {
    console.error('[elevenlabs-pool] increment failed:', err.message);
  }
}

async function speakViaElevenLabs(text, legInfo) {
  incrementElevenLabsPoolUsage(text.length); // fire-and-forget -- shared pool tracking, doesn't block the TTS call
  const startTime = Date.now();
  let firstChunkTime = null;
  let totalBytes = 0;
  let chunkCount = 0;
  const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_flash_v2_5&language_code=${legInfo.lang}&output_format=ulaw_8000`;

  const ttsWs = new WebSocket(wsUrl);

  ttsWs.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.error(`[call-audio] TTS(elevenlabs) handshake rejected status=${res.statusCode} body=${body}`);
    });
  });

  ttsWs.on('open', () => {
    console.log(`[call-audio] TTS(elevenlabs) connection opened (lang=${legInfo.lang})`);
    ttsWs.send(JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1 },
      xi_api_key: process.env.ELEVENLABS_API_KEY
    }));
    ttsWs.send(JSON.stringify({ text: `${text} ` }));
    ttsWs.send(JSON.stringify({ text: '' }));
  });

  ttsWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (msg.audio) {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        console.log(`[call-audio] TTS(elevenlabs) first audio chunk after ${firstChunkTime - startTime}ms (lang=${legInfo.lang})`);
      }
      totalBytes += Buffer.from(msg.audio, 'base64').length;
      chunkCount += 1;
      if (legInfo.ws.readyState === legInfo.ws.OPEN) {
        legInfo.ws.send(JSON.stringify({
          event: 'media',
          streamSid: legInfo.streamSid,
          media: { payload: msg.audio }
        }));
      }
    }
    if (msg.isFinal || msg.is_final) {
      const totalMs = Date.now() - startTime;
      console.log(`[call-audio] TTS(elevenlabs) complete: ${totalBytes} bytes in ${chunkCount} chunks, total=${totalMs}ms, first-chunk=${firstChunkTime ? firstChunkTime - startTime : 'n/a'}ms (lang=${legInfo.lang})`);
      ttsWs.close();
    }
  });

  ttsWs.on('error', (err) => {
    console.error(`[call-audio] TTS(elevenlabs) websocket error message=${err?.message}`, err);
  });

  ttsWs.on('close', (code, reason) => {
    console.log(`[call-audio] TTS(elevenlabs) closed code=${code} reason=${reason?.toString()}`);
  });
}

callWss.on('connection', (ws) => {
  let room = null;
  let leg = null;
  let bytesReceived = 0;
  let msgCount = 0;
  let streamSid = null;
  let dgConnection = null;
  let transcriptBuffer = '';
  let recordStream = null;
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      console.error('[call-audio] failed to parse message:', e.message);
      return;
    }
    if (data.event === 'connected') {
      console.log('[call-audio] connected event received');
    } else if (data.event === 'start') {
      streamSid = data.start.streamSid;
      const params = data.start.customParameters || {};
      room = params.room || 'unknown-room';
      leg = params.leg || 'unknown-leg';
      const lang = params.lang || 'en';
      const record = params.record === '1';
      if (!callLegs.has(room)) callLegs.set(room, {});
      callLegs.get(room)[leg] = { ws, lang, streamSid };
      console.log(`[call-audio] stream started room=${room} leg=${leg} lang=${lang} streamSid=${streamSid} record=${record}`);
      if (record) {
        if (!recordingRooms.has(room)) recordingRooms.set(room, {});
        const recPath = path.join(RECORDINGS_DIR, `${room}-${leg}.raw`);
        recordStream = fs.createWriteStream(recPath);
        recordingRooms.get(room)[leg] = { path: recPath, done: false };
      }
      dgConnection = deepgram.listen.live({
        model: 'nova-3',
        language: lang,
        smart_format: true,
        interim_results: true,
        endpointing: 300,
        utterance_end_ms: 1000,
        encoding: 'mulaw',
        sample_rate: 8000
      });
      dgConnection.on(LiveTranscriptionEvents.Open, () => {
        console.log(`[call-audio][room=${room} leg=${leg}] Deepgram connection opened`);
      });
      dgConnection.on(LiveTranscriptionEvents.Transcript, (dgData) => {
        const transcript = dgData?.channel?.alternatives?.[0]?.transcript;
        if (transcript && dgData.is_final) {
          transcriptBuffer = transcriptBuffer ? `${transcriptBuffer} ${transcript}` : transcript;
          console.log(`[call-audio][room=${room} leg=${leg}] segment: "${transcript}" (buffer: "${transcriptBuffer}")`);
        }
      });
      dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        const fullText = transcriptBuffer.trim();
        transcriptBuffer = '';
        if (!fullText) return;
        console.log(`[call-audio][room=${room} leg=${leg}] utterance complete: "${fullText}"`);
        const otherLeg = leg === 'A' ? 'B' : 'A';
        const otherInfo = callLegs.get(room)?.[otherLeg];
        if (otherInfo && otherInfo.ws.readyState === otherInfo.ws.OPEN) {
          translateForCall(fullText, lang, otherInfo.lang)
            .then((translated) => {
              console.log(`[call-audio][room=${room} leg=${leg}->${otherLeg}] translated: "${translated}"`);
              speakToLeg(translated, otherInfo);
              if (otherLeg === 'A') {
                const subs = captionSubscribers.get(room);
                if (subs) {
                  const payload = JSON.stringify({ type: 'caption', text: translated });
                  subs.forEach((subWs) => {
                    if (subWs.readyState === subWs.OPEN) subWs.send(payload);
                  });
                }
              }
            })
            .catch((err) => {
              console.error(`[call-audio][room=${room} leg=${leg}] translation error:`, err.message);
            });
        } else if (otherInfo) {
          console.log(`[call-audio][room=${room} leg=${leg}] other leg disconnected, skipping translation`);
        } else {
          console.log(`[call-audio][room=${room} leg=${leg}] other leg not connected yet, skipping translation`);
        }
      });
      dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error(`[call-audio][room=${room} leg=${leg}] Deepgram error: message=${err?.message} type=${err?.type}`, err?.error || err);
      });
      dgConnection.on(LiveTranscriptionEvents.Close, () => {
        console.log(`[call-audio][room=${room} leg=${leg}] Deepgram connection closed`);
      });
    } else if (data.event === 'media') {
      const audioBuffer = Buffer.from(data.media.payload, 'base64');
      bytesReceived += audioBuffer.length;
      msgCount += 1;
      if (dgConnection) {
        dgConnection.send(audioBuffer);
      }
      if (recordStream) {
        recordStream.write(audioBuffer);
      }
      if (msgCount % 100 === 0) {
        console.log(`[call-audio][room=${room} leg=${leg}] audio received so far: ${bytesReceived} bytes in ${msgCount} messages`);
      }
    } else if (data.event === 'stop') {
      console.log(`[call-audio] stream stopped room=${room} leg=${leg}, total bytes=${bytesReceived}, messages=${msgCount}`);
      if (dgConnection) {
        dgConnection.finish();
        dgConnection = null;
      }
      if (recordStream) {
        const rs = recordStream;
        const finishedRoom = room;
        const finishedLeg = leg;
        recordStream = null;
        rs.end(() => {
          const info = recordingRooms.get(finishedRoom);
          if (info && info[finishedLeg]) info[finishedLeg].done = true;
          maybeMixRecording(finishedRoom);
        });
      }
      if (room && callLegs.has(room)) {
        delete callLegs.get(room)[leg];
        if (Object.keys(callLegs.get(room)).length === 0) callLegs.delete(room);
      }
    }
  });
  ws.on('close', () => {
    console.log(`[call-audio] websocket closed room=${room} leg=${leg}`);
    if (dgConnection) {
      dgConnection.finish();
      dgConnection = null;
    }
    if (recordStream) {
      const rs = recordStream;
      const finishedRoom = room;
      const finishedLeg = leg;
      recordStream = null;
      rs.end(() => {
        const info = recordingRooms.get(finishedRoom);
        if (info && info[finishedLeg]) info[finishedLeg].done = true;
        maybeMixRecording(finishedRoom);
      });
    }
    if (room && callLegs.has(room)) {
      delete callLegs.get(room)[leg];
      if (Object.keys(callLegs.get(room)).length === 0) callLegs.delete(room);
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/ws/call-audio') {
    callWss.handleUpgrade(req, socket, head, (ws) => {
      callWss.emit('connection', ws, req);
    });
    return;
  }
  if (pathname === '/ws/call-captions') {
    captionWss.handleUpgrade(req, socket, head, (ws) => {
      captionWss.emit('connection', ws, req);
    });
    return;
  }
  if (pathname === '/ws/transcribe') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

captionWss.on('connection', (ws, req) => {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const room = searchParams.get('room');
  if (!room) { ws.close(); return; }
  if (!captionSubscribers.has(room)) captionSubscribers.set(room, new Set());
  captionSubscribers.get(room).add(ws);
  console.log(`[call-captions] subscriber joined room=${room}, total=${captionSubscribers.get(room).size}`);
  ws.on('close', () => {
    const subs = captionSubscribers.get(room);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) captionSubscribers.delete(room);
    }
  });
});

wss.on('connection', (ws, req) => {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const lang = toDeepgramLang(searchParams.get('lang'));

  const connId = Math.random().toString(36).slice(2, 8);
  let bytesReceived = 0;
  let msgCount = 0;
  const userAgent = req.headers['user-agent'] || 'unknown';
  console.log(`[transcribe][${connId}] client connected, lang=${lang}, ua=${userAgent}`);

  const dgConnectAttemptTime = Date.now();
  console.log(`[transcribe][${connId}] calling deepgram.listen.live() now`);
  const dgConnection = deepgram.listen.live({
    model: 'nova-3',
    language: lang,
    smart_format: true,
    interim_results: false,
    encoding: 'opus',
    container: 'webm'
  });

  let dgOpened = false;
  const openWatchdog = setTimeout(() => {
    if (!dgOpened) {
      console.warn(`[transcribe][${connId}] WARNING: Deepgram Open event has NOT fired after 8000ms`);
    }
  }, 8000);
  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    dgOpened = true;
    clearTimeout(openWatchdog);
    const elapsed = Date.now() - dgConnectAttemptTime;
    console.log(`[transcribe][${connId}] Deepgram connection opened (took ${elapsed}ms)`);
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript;
    console.log(`[transcribe][${connId}] transcript event, final=${data.is_final}, text="${transcript}"`);
    if (transcript && transcript.trim() && data.is_final) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'transcript', text: transcript.trim() }));
      }
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[transcribe][${connId}] Deepgram error:`, err);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, (event) => {
    console.log(`[transcribe][${connId}] Deepgram connection closed, bytesReceived=${bytesReceived}, msgCount=${msgCount}, code=${event?.code}, reason=${event?.reason}, wasClean=${event?.wasClean}`);
  });

  ws.on('message', (data) => {
    bytesReceived += data.length || 0;
    msgCount += 1;
    if (msgCount % 20 === 0) {
      console.log(`[transcribe][${connId}] audio received so far: ${bytesReceived} bytes in ${msgCount} messages`);
    }
    if (dgConnection.getReadyState() === 1 /* OPEN */) {
      dgConnection.send(data);
    }
  });

  ws.on('close', () => {
    console.log('[transcribe] client disconnected');
    try { dgConnection.finish(); } catch (e) { /* already closed */ }
  });

  ws.on('error', (err) => {
    console.error('[transcribe] client ws error:', err);
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`TalkBridge server running on port ${PORT}`));
