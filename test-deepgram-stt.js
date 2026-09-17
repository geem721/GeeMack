import 'dotenv/config';
import WebSocket from 'ws';

const params = new URLSearchParams({
  model: 'nova-3',
  language: 'es',
  smart_format: 'true',
  interim_results: 'true',
  endpointing: '300',
  utterance_end_ms: '600',
  encoding: 'mulaw',
  sample_rate: '8000'
});
const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
console.log(`Connecting to: ${url}`);

const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });

ws.on('open', () => {
  console.log('OPENED successfully');
  ws.close();
});
ws.on('unexpected-response', (req, res) => {
  console.log(`UNEXPECTED RESPONSE: status=${res.statusCode}`);
  console.log('headers:', JSON.stringify(res.headers, null, 2));
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => { console.log('body:', body); process.exit(1); });
});
ws.on('error', (err) => {
  console.log('ERROR event:', err?.message || err);
});
ws.on('close', (code, reason) => {
  console.log(`CLOSED code=${code} reason=${reason?.toString()}`);
});
