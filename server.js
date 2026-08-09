import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';
import deepgramSdk from '@deepgram/sdk';
const { createClient, LiveTranscriptionEvents } = deepgramSdk;
import { AccessToken } from 'livekit-server-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/translate', async (req, res) => {
  const { text, srcLang, tgtLang } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const LANG_NAMES = {
    auto:'Auto-Detected', en:'English', es:'Spanish', fr:'French', de:'German',
    it:'Italian', pt:'Portuguese', zh:'Chinese', ja:'Japanese', ko:'Korean',
    ar:'Arabic', ru:'Russian', hi:'Hindi', sw:'Swahili', nl:'Dutch',
    pl:'Polish', tr:'Turkish', vi:'Vietnamese', th:'Thai', uk:'Ukrainian',
    id:'Indonesian', fa:'Persian', bn:'Bengali', el:'Greek', sv:'Swedish',
    cs:'Czech', ur:'Urdu'
  };

  const srcName = LANG_NAMES[srcLang] || srcLang;
  const tgtName = LANG_NAMES[tgtLang] || tgtLang;
  const autoDetect = srcLang === 'auto';

  const systemPrompt = autoDetect
    ? `You are a professional translator with auto language detection. When given text:
1. First detect the source language
2. Translate to ${tgtName}
3. Respond ONLY in this exact JSON format (no markdown, no extra text):
{"detected":"<ISO language code>","detectedName":"<Full language name>","translation":"<translated text>"}`
    : `You are a professional translator. Translate from ${srcName} to ${tgtName}. Respond ONLY in this exact JSON format (no markdown, no extra text):
{"detected":"${srcLang}","detectedName":"${srcName}","translation":"<translated text>"}`;

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
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content?.find(b => b.type === 'text')?.text || '{}';
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      return res.status(200).json(parsed);
    } catch {
      return res.status(200).json({ detected: srcLang, detectedName: srcName, translation: raw });
    }
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

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
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
    model: 'nova-2',
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
