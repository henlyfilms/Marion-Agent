// Public GitHub for builders on every provider (Claude, Codex, Gemini), still inside each CLI's sandbox.
//  - Claude: sandboxed Bash reaches GitHub hosts only (sandbox.network.allowedDomains); WebFetch is pre-approved for
//    GitHub hosts only; read-only folders stay --restricted with no Bash.
//  - Gemini (Antigravity): read_url allowed for GitHub hosts only; settings carry only keys agy knows (no sandboxAllowNetwork);
//    unsandboxed commands, execute_url and MCP stay denied.
//  - Codex: a builder turn keeps its file sandbox (workspace-write / read-only) with network on; plain chat stays offline.
//  - Every builder is told how to use public repositories; ask_subscription takes owner/repo or a GitHub URL.
// Fake claude/codex/agy executables: no listener, no network, no model calls.
// Usage: npm run build && node tests/github-access.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-github-access-'));
const log = (name) => join(bin, `${name}.jsonl`);
process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8787';
process.env.PATH = bin + delimiter + process.env.PATH;
process.env.GH_TOKEN = 'must-not-leak';

const script = (body) => `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`;
writeFileSync(join(bin, 'claude'), script(`
if (args.includes('status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log('claude'))}, JSON.stringify({ args, stdin: fs.readFileSync(0, 'utf8'), env: process.env }) + '\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Claude reply' }));
`), { mode: 0o700 });
writeFileSync(join(bin, 'agy'), script(`
if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon (High)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log('agy'))}, JSON.stringify({ args, stdin: fs.readFileSync(0, 'utf8') }) + '\\n');
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini reply' } }));
`), { mode: 0o700 });
writeFileSync(join(bin, 'codex'), script(`
const send = (m) => console.log(JSON.stringify(m));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'model/list') send({ id, result: { data: [{ model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })) }] } });
  if (method === 'thread/start' || method === 'turn/start') fs.appendFileSync(${JSON.stringify(log('codex'))}, JSON.stringify({ method, params }) + '\\n');
  if (method === 'thread/start') send({ id, result: { thread: { id: 't1' } } });
  if (method === 'turn/start') {
    send({ method: 'item/completed', params: { threadId: 't1', item: { type: 'agentMessage', text: 'Codex reply' } } });
    send({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  }
});
`), { mode: 0o700 });

// Fake git: "clones" any public repo (a README naming it) and refuses one called private-*, like GitHub without sign-in.
writeFileSync(join(bin, 'git'), script(`
fs.appendFileSync(${JSON.stringify(log('git'))}, JSON.stringify({ args, env: { GH_TOKEN: process.env.GH_TOKEN, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT } }) + '\\n');
const url = args.at(-2), target = args.at(-1);
if (/private-/.test(url)) { console.error('fatal: could not read Username for https://github.com: terminal prompts disabled'); process.exit(128); }
fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(require('node:path').join(target, 'README.md'), 'readme of ' + url);
`), { mode: 0o700 });

const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
const S = await import('../server/dist/agent/subscriptions.js');
const T = await import('../server/dist/agent/tools.js');
const lines = (name) => { try { return readFileSync(log(name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const flag = (args, name) => args[args.indexOf(name) + 1];
const after = (args, name) => { const out = []; for (let i = args.indexOf(name) + 1; i < args.length && !args[i].startsWith('--'); i++) out.push(args[i]); return out; };

try {
  const hosts = [...S.GITHUB_HOSTS];
  for (const host of ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com']) assert.ok(hosts.includes(host), host);
  assert.ok(hosts.every((host) => /(^|\.)github(usercontent)?\.com$/.test(host)), 'only GitHub hosts');
  assert.match(S.GITHUB_ACCESS_LINE, /git clone/); assert.match(S.GITHUB_ACCESS_LINE, /never push/);

  // ---- Claude ----
  const claudeWrite = S.folderArgs('claude', { path: '/tmp/x', write: true });
  const writeSettings = JSON.parse(flag(claudeWrite, '--settings'));
  assert.equal(writeSettings.sandbox.enabled, true, 'the file sandbox stays on');
  assert.equal(writeSettings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(writeSettings.sandbox.network.allowedDomains, hosts, 'sandboxed shell reaches GitHub hosts only');
  assert.deepEqual(flag(claudeWrite, '--tools').split(','), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch']);
  const writeAllowed = after(claudeWrite, '--allowedTools');
  for (const host of hosts) assert.ok(writeAllowed.includes(`WebFetch(domain:${host})`), host);
  assert.ok(!writeAllowed.includes('WebFetch') && !writeAllowed.includes('Bash'), 'no blanket WebFetch/Bash approval');
  assert.equal(flag(claudeWrite, '--permission-mode'), 'auto');
  const claudeRead = S.folderArgs('claude', { path: '/tmp/x', write: false });
  assert.ok(claudeRead.includes('--restricted'), 'read-only stays restricted');
  assert.deepEqual(flag(claudeRead, '--tools').split(','), ['Read', 'Glob', 'Grep', 'WebFetch'], 'no Bash in a read-only folder');
  assert.ok(after(claudeRead, '--allowedTools').includes('WebFetch(domain:api.github.com)'));
  assert.equal(JSON.parse(flag(claudeRead, '--settings')).sandbox, undefined);

  // ---- Gemini (Antigravity) ----
  for (const write of [true, false]) {
    const settings = JSON.parse(flag(S.folderArgs('gemini', { path: '/tmp/x', write }), '--settings'));
    for (const host of hosts) assert.ok(settings.permissions.allow.includes(`read_url(${host})`), `gemini read_url ${host}`);
    assert.ok(!settings.permissions.allow.includes('read_url(*)'), 'never every URL');
    for (const rule of ['unsandboxed(*)', 'execute_url(*)', 'mcp(*)']) assert.ok(settings.permissions.deny.includes(rule), `${rule} stays denied`);
    assert.ok(!settings.permissions.deny.includes('read_url(*)'), 'read_url(*) leaves deny so GitHub rules apply');
    assert.equal(settings.allowNonWorkspaceAccess, false);
    assert.equal(settings.sandboxAllowNetwork, undefined, `no sandboxAllowNetwork: agy rejects it and exits 1 (write=${write})`);
    assert.deepEqual(Object.keys(settings).filter((k) => !S.GEMINI_SETTINGS_KEYS.includes(k)), [], 'only settings keys agy knows');
    assert.equal(settings.permissions.deny.includes('command(*)'), !write, 'read-only folders run no commands');
    assert.ok(S.folderArgs('gemini', { path: '/tmp/x', write }).includes('--sandbox'));
  }

  // ---- Codex ----
  assert.deepEqual(S.codexTurnSandbox({ path: '/tmp/x', write: true }), { type: 'workspaceWrite', writableRoots: ['/tmp/x'], networkAccess: true });
  assert.deepEqual(S.codexTurnSandbox({ path: '/tmp/x', write: false }), { type: 'readOnly', networkAccess: true });
  assert.equal(S.codexTurnSandbox(), undefined, 'plain chat keeps the offline thread sandbox');

  // ---- environment: no tokens leak, git/gh never prompt ----
  const env = S.cliEnvironment();
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(env.GH_PROMPT_DISABLED, '1');

  // ---- real launches with a folder: each provider is told about public GitHub and gets the args above ----
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', 1000);
  const signal = new AbortController().signal;
  const folder = { path: bin, label: 'bin', write: true };
  for (const provider of ['claude', 'codex', 'gemini']) {
    const text = await S.subscriptionReply(S.subscriptionSelection('u1', provider), 'Read README of octo/public-lib', signal, [], { folder });
    assert.ok(text.length > 0, `${provider} replied`);
  }
  const claudeRun = lines('claude').at(-1);
  assert.ok(claudeRun.stdin.includes(S.GITHUB_ACCESS_LINE), 'Claude builder is told about public GitHub');
  assert.deepEqual(JSON.parse(flag(claudeRun.args, '--settings')).sandbox.network.allowedDomains, hosts);
  assert.equal(claudeRun.env.GH_TOKEN, undefined);
  const agyRun = lines('agy').at(-1);
  assert.ok(agyRun.stdin.includes('public GitHub') || agyRun.stdin.includes('Public GitHub'), 'Gemini builder is told about public GitHub');
  assert.ok(JSON.parse(flag(agyRun.args, '--settings')).permissions.allow.includes('read_url(github.com)'));
  const [thread, turn] = lines('codex').slice(-2);
  assert.ok(thread.params.baseInstructions.includes(S.GITHUB_ACCESS_LINE), 'Codex builder is told about public GitHub');
  assert.equal(thread.params.sandbox, 'workspace-write');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [bin], networkAccess: true });
  await S.subscriptionReply(S.subscriptionSelection('u1', 'codex'), 'hi', signal, []);
  assert.equal(lines('codex').at(-1).params.sandboxPolicy, undefined, 'plain Codex chat: no network turn policy');
  assert.ok(!lines('claude').some((run) => !run.args.includes('--settings')), 'sanity');
  await S.subscriptionReply(S.subscriptionSelection('u1', 'claude'), 'hi', signal, []);
  assert.ok(!lines('claude').at(-1).stdin.includes(S.GITHUB_ACCESS_LINE), 'plain Claude chat is not a builder');

  // ---- ask_subscription: a public owner/repo or GitHub URL ----
  assert.equal(T.githubRepoArg('https://github.com/facebook/react'), 'facebook/react');
  assert.equal(T.githubRepoArg('git@github.com:octo/lib.git'), 'octo/lib');
  assert.equal(T.githubRepoArg('octo/lib'), 'octo/lib');
  assert.equal(T.githubRepoArg(undefined), null); assert.equal(T.githubRepoArg(''), null);
  assert.throws(() => T.githubRepoArg('just some words'), /owner\/repo/);
  const scratch = await T.repoScratch('octo/lib');
  assert.equal(scratch.write, true); assert.match(scratch.path, /marion-repo-/); assert.ok(existsSync(scratch.path));
  rmSync(scratch.path, { recursive: true, force: true });
  assert.throws(() => T.githubRepoArg('../etc'), /owner\/repo/);
  const ask = T.TOOLS.find((tool) => tool.name === 'ask_subscription');
  assert.ok(ask.parameters.properties.repo, 'ask_subscription takes a GitHub repository');
  for (const name of ['orchestrate', 'team_delegate']) assert.ok(T.TOOLS.find((tool) => tool.name === name).parameters.properties.repo, `${name} takes a GitHub repository`);

  // ---- Marion clones a public repo itself, once, the same for every provider ----
  const G = await import('../server/dist/agent/github-checkout.js');
  const ready = await G.prepareRepoCheckout('octo/public-lib');
  assert.ok(ready.checkout && existsSync(join(ready.checkout, 'README.md')), 'cloned into the scratch folder');
  assert.ok(ready.checkout.startsWith(ready.folder.path) && ready.folder.write, 'the checkout sits in a writable scratch folder');
  assert.match(ready.note, /already cloned it for you/); assert.ok(ready.note.includes(ready.checkout));
  const gitRun = lines('git').at(-1);
  assert.ok(gitRun.args.includes('--depth') && gitRun.args.includes('https://github.com/octo/public-lib.git'), 'shallow anonymous HTTPS clone');
  assert.ok(gitRun.args.includes('credential.helper='), 'no credential helper');
  assert.equal(gitRun.env.GH_TOKEN, undefined, 'no token to git'); assert.equal(gitRun.env.GIT_TERMINAL_PROMPT, '0', 'git never prompts');
  await ready.cleanup(); assert.ok(!existsSync(ready.folder.path), 'scratch removed');
  const refused = await G.prepareRepoCheckout('octo/private-lib');
  assert.equal(refused.checkout, null, 'a failed clone does not throw');
  assert.match(refused.note, /could not clone it ahead/); assert.match(refused.note, /git clone --depth 1 https:\/\/github\.com\/octo\/private-lib\.git/);
  assert.ok(existsSync(refused.folder.path), 'the builder still gets its scratch folder'); await refused.cleanup();

  // ---- ask_subscription with only a repo: every provider gets the same ready checkout as its working folder ----
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('b1', 'u1', 'Quinn', 'Helper', '', '', 1000, 1000);
  for (const provider of ['claude', 'codex', 'gemini']) {
    const result = await ask.impl({ provider, prompt: 'Summarise the README', repo: 'https://github.com/octo/public-lib' }, { userId: 'u1', botId: 'b1', signal });
    assert.ok(result.output.length > 0, `${provider} answered`);
  }
  const claudeAsk = lines('claude').at(-1), agyAsk = lines('agy').at(-1), [codexThread, codexTurn] = lines('codex').slice(-2);
  for (const [name, text] of [['claude', claudeAsk.stdin], ['gemini', agyAsk.stdin], ['codex', codexTurn.params.input.map((part) => part.text ?? '').join('\n')]]) {
    assert.match(text, /Marion already cloned it for you/, `${name} is told about the ready checkout`);
    assert.match(text, /marion-repo-[^/\s]+\/public-lib/, `${name} gets the checkout path`);
  }
  assert.ok(claudeAsk.stdin.includes(S.GITHUB_ACCESS_LINE) && /Public GitHub|public GitHub/.test(agyAsk.stdin) && codexThread.params.baseInstructions.includes(S.GITHUB_ACCESS_LINE), 'and keep GitHub access');
  assert.equal(codexTurn.params.sandboxPolicy.type, 'workspaceWrite', 'Codex can work in the checkout');
  assert.ok(JSON.parse(flag(claudeAsk.args, '--settings')).sandbox.network, 'Claude sandbox keeps GitHub network');
  assert.equal(JSON.parse(flag(agyAsk.args, '--settings')).sandboxAllowNetwork, undefined, 'Gemini settings never carry the unknown sandboxAllowNetwork key');
  assert.ok(JSON.parse(flag(agyAsk.args, '--settings')).permissions.allow.includes('read_url(github.com)'), 'Gemini keeps GitHub reads');
  const scratchPaths = [...claudeAsk.stdin.matchAll(/(\S*marion-repo-[^/\s]+)/g)].map((m) => m[1]);
  assert.ok(scratchPaths.length && scratchPaths.every((p) => !existsSync(p.replace(/[.,]$/, ''))), 'scratch checkout removed after the run');
  console.log('PASS public GitHub for Claude, Codex and Gemini builders (GitHub-only where the CLI allows it, sandboxes kept), Marion-made checkout for ask_subscription/orchestrate/team, no token leak');
} finally {
  rmSync(bin, { recursive: true, force: true });
}
