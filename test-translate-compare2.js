import 'dotenv/config';

const TEST_PHRASES = [
  { tag: 'idiom', text: "Break a leg out there tonight, I know you'll crush it." },
  { tag: 'slang', text: "Yeah nah, I'm not really feeling like doing that today, tbh." },
  { tag: 'numbers/address', text: "Can you grab like 2.5 kilos of flour and meet me at 47 Oak Street around quarter to nine?" },
  { tag: 'name', text: "My cousin Xiomara said she'll bring the tamales, so we're good on food." },
  { tag: 'idiom', text: "Honestly, it is what it is, we'll figure it out as we go." },
  { tag: 'sarcasm', text: "Oh great, another Monday, just what I needed." },
  { tag: 'double negation', text: "I don't not want to go, I just don't want to go alone." },
  { tag: 'directness/name', text: "Tell Marcus he can't just show up whenever he feels like it, that's not how this works." },
  { tag: 'phrasal verb/numbers', text: "Can you look after the dog while I go pick up my sister from the airport, her flight lands at 6:47?" },
  { tag: 'conditional', text: "If I'd known you were coming, I would've made more food." },
  { tag: 'technical/numbers', text: "Flight 2280 to Chicago is now boarding at gate B14, final call." },
  { tag: 'emotional/apology', text: "I'm so sorry about earlier, I didn't mean to snap at you like that." },
  { tag: 'disfluency', text: "So, um, I was gonna say, like, maybe we should just wait a bit longer before we, I don't know, decide anything?" },
  { tag: 'regional slang', text: "Are y'all coming to the cookout or nah?" },
  { tag: 'loanwords/tech', text: "Can you check my email real quick and see if the WiFi password's in there?" },
  { tag: 'idiom/tone', text: "He's not exactly the sharpest tool in the shed, but he means well." },
  { tag: 'casual', text: "I could really go for some tacos right about now, not gonna lie." },
  { tag: 'phrasal verb', text: "She's been putting off calling the doctor for weeks now." },
  { tag: 'currency/numbers', text: "That'll be $47.50, do you want that on the card ending in 6821?" },
  { tag: 'idiom/opinion', text: "Honestly? I think he's full of it, but that's just my two cents." }
];
const SRC_LANG = 'English';
const TGT_LANG = 'Spanish';

const VARIANTS = [
  { name: 'Sonnet 5 (current)', model: 'claude-sonnet-5', effort: null },
  { name: 'Sonnet 5 (effort:low)', model: 'claude-sonnet-5', effort: 'low' },
  { name: 'Haiku 4.5', model: 'claude-haiku-4-5-20251001', effort: null }
];

async function translate(text, model, effort) {
  const systemPrompt = `You are a professional live interpreter on a phone call. Translate the given spoken text from ${SRC_LANG} to ${TGT_LANG}. Keep it natural and conversational, not formal document style. Call the provide_translation tool with the result.`;
  const TRANSLATE_TOOL = {
    name: 'provide_translation',
    description: 'Provide the translation result for the given text.',
    input_schema: {
      type: 'object',
      properties: { translation: { type: 'string', description: 'The translated text, in the target language' } },
      required: ['translation']
    }
  };
  const body = {
    model,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [TRANSLATE_TOOL],
    tool_choice: { type: 'tool', name: 'provide_translation' },
    messages: [{ role: 'user', content: text }]
  };
  if (effort) body.output_config = { effort };

  const t0 = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - t0;
  const data = await response.json();
  if (data.error) return { ms, text: `ERROR: ${data.error.message}` };
  const toolUse = data.content?.find(b => b.type === 'tool_use' && b.name === 'provide_translation');
  return { ms, text: toolUse?.input?.translation ?? 'NO TRANSLATION RETURNED' };
}

async function main() {
  const totals = {};
  VARIANTS.forEach(v => totals[v.name] = []);

  for (const { tag, text: phrase } of TEST_PHRASES) {
    console.log(`\n=== [${tag}] "${phrase}" ===`);
    for (const v of VARIANTS) {
      const result = await translate(phrase, v.model, v.effort);
      totals[v.name].push(result.ms);
      console.log(`[${v.name}] ${result.ms}ms -> "${result.text}"`);
    }
  }

  console.log('\n=== AVERAGES ===');
  for (const v of VARIANTS) {
    const times = totals[v.name];
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const sorted = [...times].sort((a,b) => a-b);
    console.log(`${v.name}: avg=${avg}ms  min=${sorted[0]}ms  max=${sorted[sorted.length-1]}ms`);
  }
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
