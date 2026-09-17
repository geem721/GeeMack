import 'dotenv/config';
import WebSocket from 'ws';

const CANDIDATES = [1000, 900, 800, 700, 650, 600];

function testValue(ms) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'es',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: String(ms),
      encoding: 'mulaw',
      sample_rate: '8000'
    });
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });

    ws.on('open', () => {
      resolve({ ms, ok: true });
      ws.close();
    });
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ms, ok: false, status: res.statusCode, body }));
    });
    ws.on('error', () => {});
  });
}

async function main() {
  for (const ms of CANDIDATES) {
    const result = await testValue(ms);
    if (result.ok) {
      console.log(`utterance_end_ms=${ms}: ACCEPTED`);
    } else {
      let msg = result.body;
      try { msg = JSON.parse(result.body).err_msg; } catch (e) {}
      console.log(`utterance_end_ms=${ms}: REJECTED (${result.status}) - ${msg}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}
main();
