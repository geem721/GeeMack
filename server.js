import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import deepgramSdk from '@deepgram/sdk';
const { createClient, LiveTranscriptionEvents } = deepgramSdk;
import { AccessToken } from 'livekit-server-sdk';
import twilio from 'twilio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.post('/api/translate', async (req, res) => {
  const { text, srcLang, tgtLang } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

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
        model: 'claude-sonnet-4-6',
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
      return res.status(200).json(toolUse.input);
    }

    // Shouldn't normally happen with tool_choice forcing the tool call, but keep a
    // safety net rather than a hard 500 if the API ever returns a plain text block
    // instead (e.g. a refusal).
    const raw = data.content?.find(b => b.type === 'text')?.text || '';
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

app.post('/api/livekit-token', async (req, res) => {
  const { roomName, participantName } = req.body;
  if (!roomName || !participantName) {
    return res.status(400).json({ error: 'roomName and participantName are required' });
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

app.post('/api/call/status', (req, res) => {
  console.log('Call status update:', req.body?.CallStatus, req.body?.CallSid);
  res.sendStatus(200);
});

// --- Two-leg conference bridge (live interpreted call) ---
app.post('/api/call/bridge', async (req, res) => {
  const { partyA, partyB, langA, langB } = req.body;
  if (!partyA || !partyB) {
    return res.status(400).json({ error: 'partyA and partyB phone numbers are required' });
  }
  const room = `talkbridge-${Date.now()}`;
  try {
    const callA = await twilioClient.calls.create({
      to: partyA,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://talk-bridge.org/api/call/stream-twiml?room=${encodeURIComponent(room)}&leg=A&lang=${encodeURIComponent(langA || 'en')}`,
      statusCallback: 'https://talk-bridge.org/api/call/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
    const callB = await twilioClient.calls.create({
      to: partyB,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://talk-bridge.org/api/call/stream-twiml?room=${encodeURIComponent(room)}&leg=B&lang=${encodeURIComponent(langB || 'es')}`,
      statusCallback: 'https://talk-bridge.org/api/call/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
    return res.json({ room, callASid: callA.sid, callBSid: callB.sid });
  } catch (err) {
    console.error('Bridge call error:', err);
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
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: 'wss://talk-bridge.org/ws/call-audio' });
  stream.parameter({ name: 'room', value: room });
  stream.parameter({ name: 'leg', value: leg });
  stream.parameter({ name: 'lang', value: lang });
  res.type('text/xml');
  res.send(twiml.toString());
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
const callLegs = new Map(); // room -> { A: ws, B: ws }
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
      model: 'claude-sonnet-4-6',
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

async function speakViaElevenLabs(text, legInfo) {
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
      if (!callLegs.has(room)) callLegs.set(room, {});
      callLegs.get(room)[leg] = { ws, lang, streamSid };
      console.log(`[call-audio] stream started room=${room} leg=${leg} lang=${lang} streamSid=${streamSid}`);
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
      if (msgCount % 100 === 0) {
        console.log(`[call-audio][room=${room} leg=${leg}] audio received so far: ${bytesReceived} bytes in ${msgCount} messages`);
      }
    } else if (data.event === 'stop') {
      console.log(`[call-audio] stream stopped room=${room} leg=${leg}, total bytes=${bytesReceived}, messages=${msgCount}`);
      if (dgConnection) {
        dgConnection.finish();
        dgConnection = null;
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
  if (pathname === '/ws/transcribe') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
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
