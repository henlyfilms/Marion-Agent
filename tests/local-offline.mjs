// Local model on bad Wi-Fi: connected apps never answer, the local model is cold.
// The bot must still reply quickly, and show "Loading <model>" while the model boots.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOAD_MS = 2500;
let loaded = false;
const requests = [];
// A cloud service on poor Wi-Fi: accepts the connection, never answers.
const stalled = new Set();
const blackhole = createServer(req => { stalled.add(req); });
// A cold Ollama: /api/ps lists nothing until the first request finishes loading the model.
const fakeOllama = createServer(async (req, res) => {
  const data = [];
  for await (const chunk of req) data.push(chunk);
  if (req.url === '/api/ps') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: loaded ? [{ name: 'qwen-cold', model: 'qwen-cold' }] : [] }));
  }
  requests.push(req.url);
  if (!loaded) { await new Promise(resolve => setTimeout(resolve, LOAD_MS)); loaded = true; }
  const item = { type: 'message', id: 'msg_offline', role: 'assistant', content: [{ type: 'output_text', text: 'Hi from your Mac.', annotations: [] }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi from your Mac.' })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`);
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [item] } })}\n\n`);
});
await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => fakeOllama.listen(0, '127.0.0.1', resolve));

const workDir = await mkdtemp(join(tmpdir(), 'marion-offline-'));
const port = process.env.MARION_TEST_PORT ?? '8796';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: {
    ...process.env, DB_PATH: join(workDir, 'offline.db'),
    PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app,
    DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', XAI_API_KEY: '',
    COMPOSIO_API_KEY: 'offline-test', COMPOSIO_BASE_URL: `http://127.0.0.1:${blackhole.address().port}`,
    MARION_LOCAL_MODEL_URL: `http://127.0.0.1:${fakeOllama.address().port}/v1`,
    MARION_LOCAL_MODEL_API_KEY: '', MARION_LOCAL_MODEL: 'qwen-cold',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
const waitFor = async (check, message, ms = 7000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
};

try {
  await waitFor(async () => (await fetch(app + '/api/health').catch(() => null))?.ok, 'Marion Agent never started');
  const login = await fetch(app + '/api/auth/dev', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'offline@example.com' }),
  });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await fetch(app + '/api/bots', { headers }).then(r => r.json());
  const url = app + '/api/bots/' + bot.id;
  const sent = Date.now();
  assert.equal((await fetch(url + '/messages', { method: 'POST', headers, body: JSON.stringify({ text: 'Hi' }) })).status, 200);

  let sawLoading = false;
  await waitFor(async () => {
    const { live } = await fetch(app + '/api/bots', { headers }).then(r => r.json());
    const activity = (Array.isArray(live) ? live.find(l => l.botId === bot.id) : live?.[bot.id])?.activity;
    sawLoading ||= activity?.kind === 'loading_model' && activity.detail === 'qwen-cold';
    return sawLoading;
  }, 'no "loading model" activity while the local model was cold');

  await waitFor(async () => {
    const { rows } = await fetch(url + '/rows', { headers }).then(r => r.json());
    const error = rows.find(row => row.body.type === 'notice' && row.body.tone === 'error');
    if (error) assert.fail(`bot failed: ${error.body.text}`);
    return rows.some(row => row.body.role === 'assistant' && row.body.text === 'Hi from your Mac.' && !row.body.streaming);
  }, 'the bot never answered while connected apps were unreachable', 15_000);
  const took = Date.now() - sent;
  assert.ok(took < LOAD_MS + 7000, `reply took ${took}ms`);
  assert.equal(requests.length, 1);

  // Second message: apps are known to be unreachable and the model is warm, so no waiting.
  const again = Date.now();
  await fetch(url + '/messages', { method: 'POST', headers, body: JSON.stringify({ text: 'Again' }) });
  await waitFor(async () => {
    const { rows } = await fetch(url + '/rows', { headers }).then(r => r.json());
    return rows.filter(row => row.body.role === 'assistant' && !row.body.streaming).length >= 2;
  }, 'second reply never came');
  assert.ok(Date.now() - again < 2500, `second reply took ${Date.now() - again}ms`);
  console.log(`PASS: offline local chat replied in ${took}ms (cold load shown), then ${Date.now() - again}ms warm.`);
} finally {
  child.kill();
  await stopped;
  for (const req of stalled) req.socket.destroy();
  await Promise.all([blackhole, fakeOllama].map(s => new Promise(resolve => s.close(resolve))));
  await rm(workDir, { recursive: true, force: true });
}
