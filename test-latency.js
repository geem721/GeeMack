import 'dotenv/config';
import WebSocket from 'ws';

const SAMPLE_TEXT = "Hey, are you still coming by later? I wanted to grab dinner around seven if that works for you.";
const SRC_LANG = 'en';
const TGT_LANG = 'es';

async function translateForCall(text, srcLang, tgtLang) {
  const systemPrompt = `You are a professional live interpreter on a phone call. Translate the given spoken text from ${srcLang} to ${tgtLang}. Keep it natural and conversational, not formal document style. Call the provide_translation tool with the result.`;
  const TRANSLATE_TOOL = {
    name: 'provide_translation',
    description: 'Provide the translation result for the given text.',
    input_schema: {
      type: 'object',
      properties: { translation: { type: 'string', description: 'The translated text, in the target language' } },
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
  if (toolUse?.input?.translation !== undefined) return toolUse.input.translation;
  throw new Error('No translation returned');
}

function speakViaDeepgram(text, lang) {
  return new Promise((resolve, reject) => {
    const model = { es: 'aura-2-celeste-es', en: 'aura-2-thalia-en', fr: 'aura-2-agathe-fr', de: 'aura-2-julius-de' }[lang] || 'aura-2-thalia-en';
    const ttsUrl = `wss://api.deepgram.com/v1/speak?model=${model}&encoding=mulaw&sample_rate=8000&container=none`;
    const startTime = Date.now();
    let firstChunkTime = null;
    let totalBytes = 0;
    const ttsWs = new WebSocket(ttsUrl, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
    ttsWs.on('open', () => {
      ttsWs.send(JSON.stringify({ type: 'Speak', text }));
      ttsWs.send(JSON.stringify({ type: 'Flush' }));
    });
    ttsWs.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!firstChunkTime) firstChunkTime = Date.now();
        totalBytes += data.length;
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Flushed') {
          ttsWs.send(JSON.stringify({ type: 'Close' }));
          resolve({ firstChunkMs: firstChunkTime - startTime, totalMs: Date.now() - startTime, bytes: totalBytes });
        }
      }
    });
    ttsWs.on('error', reject);
  });
}

async function main() {
  console.log(`Sample text (${SRC_LANG}): "${SAMPLE_TEXT}"`);
  console.log('--- Running 3 trials ---\n');
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const translated = await translateForCall(SAMPLE_TEXT, SRC_LANG, TGT_LANG);
    const translateMs = Date.now() - t0;
    console.log(`Trial ${i}: translate=${translateMs}ms -> "${translated}"`);
    const tts = await speakViaDeepgram(translated, TGT_LANG);
    console.log(`Trial ${i}: TTS first-chunk=${tts.firstChunkMs}ms, TTS total=${tts.totalMs}ms, bytes=${tts.bytes}`);
    console.log(`Trial ${i}: TOTAL (translate + TTS-first-chunk) = ${translateMs + tts.firstChunkMs}ms\n`);
  }
}
main().catch((err) => { console.error('Test failed:', err); process.exit(1); });
