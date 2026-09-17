import 'dotenv/config';

const TEST_PHRASES = [
  "Break a leg out there tonight, I know you'll crush it.",
  "Yeah nah, I'm not really feeling like doing that today, tbh.",
  "Can you grab like 2.5 kilos of flour and meet me at 47 Oak Street around quarter to nine?",
  "My cousin Xiomara said she'll bring the tamales, so we're good on food.",
  "Honestly, it is what it is, we'll figure it out as we go."
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
  if (effort) body.effort = effort;

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

  for (const phrase of TEST_PHRASES) {
    console.log(`\n=== "${phrase}" ===`);
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
    console.log(`${v.name}: avg=${avg}ms  (${times.join(', ')}ms)`);
  }
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
