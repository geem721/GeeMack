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
