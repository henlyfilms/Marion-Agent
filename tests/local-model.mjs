import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requests = [];
const grokEnabled = process.argv.includes('--grok');
const fakeModel = createServer(async (req, res) => {
  const data = [];
  for await (const chunk of req) data.push(chunk);
  const request = JSON.parse(Buffer.concat(data).toString());
  requests.push({ url: req.url, request });
  const first = requests.length === 1;
  const item = first
    ? {
      type: 'function_call', id: 'fc_smoke', call_id: 'call_smoke',
      name: grokEnabled ? 'ask_grok' : 'remember',
      arguments: grokEnabled ? '{"prompt":"Grok approval smoke prompt"}' : '{"text":"Marion smoke fact"}',
    }
    : { type: 'message', id: 'msg_smoke', role: 'assistant', content: [{ type: 'output_text', text: 'Saved locally.', annotations: [] }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (!first) {
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Saved locally.' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`);
  }
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [item] } })}\n\n`);
});
await new Promise(resolve => fakeModel.listen(0, '127.0.0.1', resolve));
const workDir = await mkdtemp(join(tmpdir(), 'marion-model-smoke-'));
const port = process.env.MARION_TEST_PORT ?? '8795';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: {
    ...process.env, DB_PATH: join(workDir, 'smoke.db'),
    PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app,
    DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1',
    XAI_API_KEY: grokEnabled ? 'unused-grok-smoke-value' : '', COMPOSIO_API_KEY: '',
    MARION_LOCAL_MODEL_URL: `http://127.0.0.1:${fakeModel.address().port}/v1`,
    MARION_LOCAL_MODEL_API_KEY: '', MARION_LOCAL_MODEL: 'qwen-local-smoke',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
const waitFor = async (check, message) => {
  for (let count = 0; count < 70; count++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
};

try {
  await waitFor(async () => {
    const health = await fetch(app + '/api/health').catch(() => null);
    return health?.ok && (await health.json()).model === 'qwen-local-smoke';
  }, 'Marion Agent never started');
  const login = await fetch(app + '/api/auth/dev', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'local-model@example.com' }),
  });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await fetch(app + '/api/bots', { headers }).then(response => response.json());
  const url = app + '/api/bots/' + bot.id;
  const userMessage = await fetch(url + '/messages', { method: 'POST', headers, body: JSON.stringify({ text: 'Save a smoke fact.' }) });
  assert.equal(userMessage.status, 200);
  if (grokEnabled) {
    let approval;
    await waitFor(async () => {
      const { rows } = await fetch(url + '/rows', { headers }).then(response => response.json());
      approval = rows.find(row => row.body.card === 'approval' && row.body.tool === 'ask_grok')?.body;
      return approval?.status === 'pending';
    }, 'Grok did not request approval');
    assert.equal(requests.length, 1);
    assert.equal(approval.detail, 'Grok approval smoke prompt');
    const denied = await fetch(app + '/api/approvals/' + approval.approvalId, {
      method: 'POST', headers, body: JSON.stringify({ decision: 'deny' }),
    });
    assert.equal(denied.status, 200);
  }
  await waitFor(async () => {
    const { rows } = await fetch(url + '/rows', { headers }).then(response => response.json());
    return rows.some(row => row.body.role === 'assistant' && row.body.text === 'Saved locally.' && !row.body.streaming);
  }, 'assistant response was not saved');
  assert.equal(requests.length, 2);
  for (const { url, request } of requests) {
    assert.equal(url, '/v1/responses');
    assert.equal(request.model, 'qwen-local-smoke');
    assert.equal(request.stream, true);
    assert.ok(request.tools.every(tool => tool.type === 'function'));
    assert.equal(request.tools.some(tool => tool.name === 'ask_grok'), grokEnabled);
  }
  const output = requests[1].request.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_smoke')?.output;
  if (grokEnabled) {
    assert.match(output, /declined/);
    console.log('PASS: optional Grok call stopped for approval and was denied, while chat stayed local.');
  } else {
    assert.equal(output, 'Saved to memory.');
    console.log('PASS: local chat, streaming response, tool execution and replay without provider keys.');
  }
} finally {
  child.kill();
  await stopped;
  await new Promise(resolve => fakeModel.close(resolve));
  await rm(workDir, { recursive: true, force: true });
}
