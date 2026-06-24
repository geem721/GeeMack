import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

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

const PORT = 3000;
app.listen(PORT, () => console.log(`TalkBridge server running on port ${PORT}`));
