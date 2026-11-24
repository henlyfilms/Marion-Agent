import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import Database from 'better-sqlite3';

const work = await mkdtemp(join(tmpdir(), 'marion-workspace-smoke-'));
const dbPath = join(work, 'marion.db');
const origin = 'http://127.0.0.1:' + (process.env.MARION_TEST_PORT ?? '8797');
const accessToken = randomBytes(20).toString('hex');
const mobileOrigin = 'https://marion-phone.example.test';
const mobilePassphrase = randomBytes(24).toString('base64url');
const mobileHeaders = { Host: new URL(mobileOrigin).host, 'X-Forwarded-Proto': 'https', Origin: mobileOrigin };
const browserOrigin = 'https://marion-browser.example.test';
const browserPassphrase = randomBytes(24).toString('base64url');
const browserHeaders = { Host: new URL(browserOrigin).host, 'X-Forwarded-Proto': 'https', Origin: browserOrigin };
const mobileRequest = (path, { headers = mobileHeaders, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
  const req = request(origin + path, { headers, method }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      resolve({ status: res.statusCode, headers: res.headers, body: res.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
    });
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end(body);
});
const headers = { 'x-marion-desktop-session': accessToken };
const claudeMode = join(work, 'claude-mode');
const claudeRequests = join(work, 'claude-requests');
const agyRequests = join(work, 'agy-requests');
const codexRequests = join(work, 'codex-requests');
await writeFile(join(work, 'claude'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { appendFileSync, readFileSync } = require('node:fs');
const mode = readFileSync(${JSON.stringify(claudeMode)}, 'utf8');
const args = process.argv.slice(2);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
if (args.includes('status')) {
  console.log(JSON.stringify({
    loggedIn: mode !== 'signed-out',
    authMethod: mode === 'api' ? 'api_key' : 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: mode === 'subscription' ? 'pro' : null,
  }));
  process.exit(mode === 'signed-out' ? 1 : 0);
}
assert.ok(args.includes('--print') && args.includes('--strict-mcp-config') && args.includes('--restricted'));
assert.equal(args[args.indexOf('--tools') + 1], '');
assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
assert.equal(mode, 'subscription');
appendFileSync(${JSON.stringify(claudeRequests)}, readFileSync(0, 'utf8') + '\\n');
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'Claude test reply', usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 10 }}));
`, { mode: 0o700 });
await writeFile(join(work, 'agy'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('gemini-4-neon-medium\\tGemini 4 Neon (Medium)');
  console.log('gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)');
  process.exit(0);
}
assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-neon');
assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
writeFileSync(${JSON.stringify(agyRequests)}, JSON.stringify(args));
console.log(JSON.stringify({event: 'result', result: {status: 'SUCCESS', response: 'Gemini test reply'}}));
`, { mode: 0o700 });
await writeFile(join(work, 'codex'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const send = message => console.log(JSON.stringify(message));
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'model/list') send({ id, result: { data: [{
    model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', isDefault: true,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }],
  }] } });
  if (method === 'thread/start') { assert.equal(params.model, 'gpt-6.2-sol'); send({ id, result: { thread: { id: 'thread_test' } } }); }
  if (method === 'turn/start') {
    assert.equal(params.effort, 'xhigh');
    writeFileSync(${JSON.stringify(codexRequests)}, JSON.stringify(params));
    send({ method: 'item/completed', params: { threadId: 'thread_test', item: { type: 'agentMessage', text: 'Codex test reply' } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread_test', tokenUsage: { total: { inputTokens: 210, outputTokens: 14 } } } });
    send({ method: 'turn/completed', params: { threadId: 'thread_test', turn: { status: 'completed' } } });
  }
});
`, { mode: 0o700 });
const baseEnv = {
  ...process.env,
  PATH: work + delimiter + process.env.PATH,
  ANTHROPIC_API_KEY: 'fixture-should-not-be-passed',
  CLAUDE_CODE_OAUTH_TOKEN: 'fixture-should-not-be-passed',
  DB_PATH: dbPath, HOST: '127.0.0.1', PORT: new URL(origin).port,
  APP_URL: origin, SERVER_URL: origin, MARION_NO_SCHEDULER: '1',
  MARION_MOBILE_ORIGIN: mobileOrigin, MARION_MOBILE_PASSPHRASE: mobilePassphrase,
  MARION_BROWSER_ORIGIN: browserOrigin,
  DEV_LOGIN: '1', COMPOSIO_API_KEY: '', XAI_API_KEY: '',
};

let server;
async function stop() {
  if (!server) return;
  if (server.exitCode === null && server.signalCode === null) {
    const exit = once(server, 'exit');
    server.kill();
    await exit;
  }
  server = undefined;
}

async function start(native, browserPairingPassphrase = browserPassphrase) {
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('../server/', import.meta.url),
    env: { ...baseEnv, MARION_DESKTOP_TOKEN: native ? accessToken : '', MARION_BROWSER_PASSPHRASE: browserPairingPassphrase },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await fetch(origin + '/api/health', { headers }).catch(() => null))?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Marion did not start');
}

try {
  await start(false);
  const legacy = await fetch(origin + '/api/auth/dev', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'existing@example.test', name: 'Existing profile' }),
  });
  assert.equal(legacy.status, 200);
  const cookie = legacy.headers.get('set-cookie').split(';')[0];
  const identity = await fetch(origin + '/api/auth/me', { headers: { cookie } }).then(response => response.json());
  const original = await fetch(origin + '/api/bots', { headers: { cookie } }).then(response => response.json());
  await stop();
  const legacyDb = new Database(dbPath);
  try {
    legacyDb.exec(`
      DROP TABLE chat_provider_preferences;
      CREATE TABLE chat_provider_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'gemini'))
      );
    `);
    legacyDb.prepare('INSERT INTO chat_provider_preferences VALUES (?,?)').run(identity.user.id, 'gemini');
  } finally { legacyDb.close(); }
  await start(true);

  assert.equal((await fetch(origin + '/api/auth/me')).status, 403);
  const response = await fetch(origin + '/api/auth/me', { headers });
  const workspace = await response.json();
  assert.equal(workspace.localWorkspace, true);
  assert.deepEqual(workspace.user, { id: identity.user.id, name: 'Local workspace', email: '', avatarUrl: null });
  assert.equal(workspace.devLogin, false);
  assert.equal(workspace.googleLogin, false);
  const newCookie = response.headers.get('set-cookie').split(';')[0];
  const signedIn = { ...headers, cookie: newCookie, 'Content-Type': 'application/json' };
  const migrated = await fetch(origin + '/api/bots', { headers: signedIn }).then(response => response.json());
  assert.deepEqual(migrated.bots.map(bot => bot.id), original.bots.map(bot => bot.id));

  assert.equal((await fetch(origin + '/api/auth/dev', { method: 'POST', headers: signedIn, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/api/auth/google/start', { headers: signedIn })).status, 403);
  const settings = origin + '/api/settings/chat-provider';
  assert.equal((await fetch(settings, { headers })).status, 401);
  assert.equal((await fetch(settings, { headers: signedIn }).then(result => result.json())).provider, 'gemini');
  assert.equal((await fetch(settings, {
    method: 'PUT', headers: { ...signedIn, Origin: 'https://outside.example' }, body: '{"provider":"codex"}',
  })).status, 403);
  assert.equal((await fetch(settings, {
    method: 'PUT', headers: { ...signedIn, Origin: origin }, body: '{"provider":"local"}',
  })).status, 200);
  const claudeSetting = await fetch(settings, {
    method: 'PUT', headers: { ...signedIn, Origin: origin }, body: '{"provider":"claude"}',
  });
  assert.equal(claudeSetting.status, 200);
  assert.equal((await claudeSetting.json()).provider, 'claude');

  const bot = origin + '/api/bots/' + migrated.bots[0].id;
  await writeFile(claudeMode, 'subscription');
  const picker = await fetch(bot + '/chat-model?discover=1', { headers: signedIn }).then(response => response.json());
  assert.ok(picker.models.some(model => model.id === 'claude-opus-5-5' && model.efforts.includes('xhigh')));
  assert.ok(picker.models.some(model => model.id === 'gemini-4-neon' && model.efforts.includes('xhigh')));
  assert.ok(picker.models.some(model => model.id === 'gpt-6.2-sol' && model.efforts.includes('xhigh')));
  const pick = { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' };
  const update = (selection) => fetch(bot + '/chat-model', {
    method: 'PUT', headers: { ...signedIn, Origin: origin }, body: JSON.stringify(selection),
  });
  assert.equal((await update({ ...pick, effort: 'unsupported' })).status, 400);
  assert.equal((await update(pick)).status, 200);
  const selection = await fetch(bot + '/chat-model', { headers: signedIn }).then(response => response.json());
  assert.deepEqual(selection.selection, { ...pick, label: 'Claude Opus 5.5' });

  assert.equal((await mobileRequest('/api/bots')).status, 401);
  assert.equal((await mobileRequest('/api/auth/me', { headers: { ...mobileHeaders, 'X-Forwarded-Proto': 'http' } })).status, 403);
  const pair = (passphrase, headers = mobileHeaders) => mobileRequest('/api/auth/mobile', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }),
  });
  assert.equal((await pair(mobilePassphrase, { ...mobileHeaders, Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await pair('wrong phrase')).status, 401);
  const paired = await pair(mobilePassphrase);
  assert.equal(paired.status, 200);
  const mobileCookie = paired.headers['set-cookie'][0];
  assert.match(mobileCookie, /; Secure/i);
  assert.match(mobileCookie, /; HttpOnly/i);
  const mobileSession = { ...mobileHeaders, Cookie: mobileCookie.split(';')[0] };
  const mobile = (await mobileRequest('/api/auth/me', { headers: mobileSession })).body;
  assert.equal(mobile.mobileLogin, true);
  assert.equal(mobile.user.id, identity.user.id);
  assert.equal((await mobileRequest('/api/settings/mobile-access?reveal=1', { headers: mobileSession })).status, 403);
  const mobileRoster = (await mobileRequest('/api/bots', { headers: mobileSession })).body;
  assert.deepEqual(mobileRoster.bots.map(bot => bot.id), migrated.bots.map(bot => bot.id));

  const browserConfig = await fetch(origin + '/api/settings/browser-access', { headers: signedIn });
  assert.deepEqual(await browserConfig.json(), { origin: browserOrigin, passphrase: null });
  const browserSecret = await fetch(origin + '/api/settings/browser-access?reveal=1', { headers: signedIn });
  assert.deepEqual(await browserSecret.json(), { origin: browserOrigin, passphrase: browserPassphrase });
  assert.equal(browserSecret.headers.get('cache-control'), 'no-store');
  assert.equal((await mobileRequest('/api/auth/me', { headers: browserHeaders })).body.mobileLogin, true);
  assert.equal((await mobileRequest('/api/bots', { headers: browserHeaders })).status, 401);
  assert.equal((await mobileRequest('/api/auth/me', { headers: { ...browserHeaders, 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await pair(mobilePassphrase, browserHeaders)).status, 401);
  assert.equal((await pair(browserPassphrase)).status, 401);
  const pairedBrowser = await pair(browserPassphrase, browserHeaders);
  assert.equal(pairedBrowser.status, 200);
  const browserCookie = pairedBrowser.headers['set-cookie'][0];
  assert.match(browserCookie, /^__Host-marion_agent_browser=/);
  assert.match(browserCookie, /; Secure/i);
  assert.match(browserCookie, /; HttpOnly/i);
  assert.match(browserCookie, /; Max-Age=28800/i);
  const browserSession = { ...browserHeaders, Cookie: browserCookie.split(';')[0] };
  const browserRoster = (await mobileRequest('/api/bots', { headers: browserSession })).body;
  assert.deepEqual(browserRoster.bots.map(bot => bot.id), migrated.bots.map(bot => bot.id));
  assert.equal((await mobileRequest('/api/bots', { headers: { ...browserHeaders, Cookie: mobileSession.Cookie } })).status, 401);
  assert.equal((await mobileRequest('/api/bots', { headers: { ...mobileHeaders, Cookie: browserSession.Cookie } })).status, 401);
  assert.equal((await mobileRequest('/api/bots', { headers: { ...mobileHeaders, Cookie: browserSession.Cookie.replace('__Host-marion_agent_browser', 'marion_agent_session') } })).status, 401);
  assert.equal((await mobileRequest('/api/settings/browser-access?reveal=1', { headers: browserSession })).status, 403);
  assert.equal((await mobileRequest('/api/auth/logout', { method: 'POST', headers: { ...browserSession, Origin: mobileOrigin } })).status, 403);
  assert.equal((await mobileRequest('/api/auth/logout', { method: 'POST', headers: browserSession })).status, 200);
  assert.equal((await mobileRequest('/api/bots', { headers: browserSession })).status, 401);

  assert.equal((await mobileRequest('/api/auth/logout', { method: 'POST', headers: mobileSession })).status, 200);
  assert.equal((await mobileRequest('/api/bots', { headers: mobileSession })).status, 401);

  const second = await fetch(origin + '/api/bots', {
    method: 'POST', headers: signedIn, body: '{"name":"Second chat"}',
  }).then(response => response.json());
  async function chat(mode, text, expected, usage) {
    await writeFile(claudeMode, mode);
    const message = await fetch(bot + '/messages', {
      method: 'POST', headers: signedIn, body: JSON.stringify({ text }),
    });
    assert.equal(message.status, 200);
    const { row: sent } = await message.json();
    for (let attempt = 0; attempt < 50; attempt++) {
      const { rows } = await fetch(bot + '/rows', { headers: signedIn }).then(response => response.json());
      const response = rows.find(row => row.seq > sent.seq && row.body.text?.includes(expected));
      if (response && (!usage || response.body.usage)) {
        if (usage) {
          const count = response.body.usage[0];
          assert.equal(count.estimated, usage.estimated);
          if (usage.input) assert.equal(count.input, usage.input);
          if (usage.output) assert.equal(count.output, usage.output);
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Expected Claude authentication warning or reply to be saved in the transcript.');
  }
  await chat('signed-out', 'Signed-out check', 'claude auth login');
  await chat('api', 'API check', 'claude auth login');
  await chat('missing-plan', 'Missing plan check', 'claude auth login');
  await assert.rejects(readFile(claudeRequests), { code: 'ENOENT' });
  await chat('subscription', 'Subscription check', 'Claude test reply', { estimated: false, input: 120, output: 10 });
  assert.match(await readFile(claudeRequests, 'utf8'), /Current user message:\nSubscription check/);
  assert.equal((await update({ provider: 'gemini', model: 'gemini-4-neon', effort: 'xhigh' })).status, 200);
  await chat('subscription', 'Gemini routing check', 'Gemini test reply', { estimated: true });
  assert.match(await readFile(agyRequests, 'utf8'), /gemini-4-neon/);
  assert.equal((await update({ provider: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' })).status, 200);
  await chat('subscription', 'Codex routing check', 'Codex test reply', { estimated: false, input: 210, output: 14 });
  assert.match(await readFile(codexRequests, 'utf8'), /"effort":"xhigh"/);
  const secondSelection = await fetch(origin + '/api/bots/' + second.bot.id + '/chat-model', { headers: signedIn }).then(response => response.json());
  assert.equal(secondSelection.selection.provider, 'claude');
  assert.equal(secondSelection.selection.model, 'claude-sonnet-5-5');
  const claudeDefault = origin + '/api/settings/subscription-model/claude';
  const defaultChoice = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
  assert.equal((await fetch(claudeDefault, {
    method: 'PUT', headers: { ...signedIn, Origin: origin }, body: JSON.stringify(defaultChoice),
  })).status, 200);
  const newDefault = await fetch(claudeDefault, { headers: signedIn }).then(response => response.json());
  assert.deepEqual(newDefault.selection, defaultChoice);
  const inherited = await fetch(origin + '/api/bots/' + second.bot.id + '/chat-model', { headers: signedIn }).then(response => response.json());
  assert.deepEqual(inherited.selection, defaultChoice);
  const override = await fetch(bot + '/chat-model', { headers: signedIn }).then(response => response.json());
  assert.equal(override.selection.provider, 'codex');
  assert.equal(override.selection.effort, 'xhigh');

  const database = new Database(dbPath, { readonly: true });
  try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1); }
  finally { database.close(); }
  const beforeRotation = await pair(browserPassphrase, browserHeaders);
  assert.equal(beforeRotation.status, 200);
  const oldBrowserSession = { ...browserHeaders, Cookie: beforeRotation.headers['set-cookie'][0].split(';')[0] };
  await stop();
  const nextPassphrase = randomBytes(24).toString('base64url');
  await start(true, nextPassphrase);
  const restarted = await fetch(bot + '/chat-model', { headers: signedIn }).then(response => response.json());
  assert.equal(restarted.selection.model, 'gpt-6.2-sol');
  assert.equal(restarted.selection.effort, 'xhigh');
  assert.equal((await mobileRequest('/api/bots', { headers: oldBrowserSession })).status, 401);
  assert.equal((await pair(nextPassphrase, browserHeaders)).status, 200);
  console.log('PASS: native workspace migration, isolated iPhone and browser pairing, exact Codex, Gemini and Claude model/effort routing, and subscription-only authentication.');
} finally {
  await stop();
  await rm(work, { recursive: true, force: true });
}
