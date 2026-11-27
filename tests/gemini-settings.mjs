// Gemini (Antigravity `agy`) --settings regression: agy rejects any settings.json key it does not know with
// `Error: --settings: unknown setting "<key>"` and exit code 1 (verified against agy 1.5.18 for `sandboxAllowNetwork`).
// Marion used to pass sandboxAllowNetwork for writable folders, so every Gemini builder run in such a folder failed.
//  - Every Gemini argument list (plain chat, photos, read-only folder, writable folder, folder + photos, /usage) carries
//    only keys in GEMINI_SETTINGS_KEYS, and never sandboxAllowNetwork.
//  - geminiSettingsJson refuses unknown keys (negative test), so a new key can't slip in unnoticed.
//  - Real launches through subscriptionReply against a strict fake agy (exits 1 on unknown flags/keys, like the real one)
//    succeed on the FIRST invocation: the fake logs every invocation (accepted or rejected) and the test asserts exactly
//    one accepted invocation per run and no retry warning, so a retry can't mask a bad flag.
// No network, no listener, no model calls.
// Usage: npm run build && node tests/gemini-settings.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-gemini-settings-'));
const log = join(bin, 'agy.jsonl');
process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.MARION_NO_SCHEDULER = '1';
process.env.HOST = '127.0.0.1';
process.env.PATH = bin + delimiter + process.env.PATH;

// The real agy's known keys we rely on; anything else makes the fake exit 1 exactly like agy does.
const KNOWN = ['modelProvider', 'allowNonWorkspaceAccess', 'permissions', 'enableTerminalSandbox'];
// Every flag Marion's Gemini launches may use; any other flag makes the fake exit 1 (like agy's own flag parser).
const FLAGS = { '--mode': 1, '--sandbox': 0, '--disable-slash-commands': 0, '--settings': 1, '--add-dir': 1,
  '--input-format': 1, '--output-format': 1, '--model': 1, '--effort': 1 };
// Every invocation is logged BEFORE validation, with its verdict, so a rejected first launch that a retry later
// papered over still shows up in the log (and fails the test).
writeFileSync(join(bin, 'agy'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon (High)'); process.exit(0); }
const FLAGS = ${JSON.stringify(FLAGS)};
const reject = (why) => { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, ok: false, why }) + '\\n'); console.error('Error: ' + why); process.exit(1); };
for (let i = 0; i < args.length; i++) {
  if (!(args[i] in FLAGS)) reject('unknown flag ' + args[i]);
  i += FLAGS[args[i]];
  if (i >= args.length) reject('missing value for ' + args[i - 1]);
}
const at = args.indexOf('--settings');
if (at >= 0) {
  let settings; try { settings = JSON.parse(args[at + 1]); } catch { reject('--settings: invalid JSON'); }
  for (const key of Object.keys(settings)) if (!${JSON.stringify(KNOWN)}.includes(key)) reject('--settings: unknown setting "' + key + '"');
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, ok: true }) + '\\n');
fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Gemini reply' } }));
`, { mode: 0o700 });

const flag = (args, name) => args[args.indexOf(name) + 1];
const keysOf = (args) => Object.keys(JSON.parse(flag(args, '--settings')));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  const { db } = await import('../server/dist/db.js');
  await import('../server/dist/features/schema.js');
  const S = await import('../server/dist/agent/subscriptions.js');

  await test('the allowlist is exactly the keys Marion needs, all known to agy', () => {
    assert.deepEqual([...S.GEMINI_SETTINGS_KEYS].sort(), ['allowNonWorkspaceAccess', 'modelProvider', 'permissions']);
    assert.ok(S.GEMINI_SETTINGS_KEYS.every((k) => KNOWN.includes(k)));
    assert.ok(!S.GEMINI_SETTINGS_KEYS.includes('sandboxAllowNetwork'));
  });

  await test('geminiSettingsJson refuses unknown keys (negative)', () => {
    assert.throws(() => S.geminiSettingsJson({ modelProvider: '', sandboxAllowNetwork: true }), /sandboxAllowNetwork/);
    assert.throws(() => S.geminiSettingsJson({ zzz: 1 }), /unsupported key/);
    assert.equal(S.geminiSettingsJson({ modelProvider: '' }), '{"modelProvider":""}');
  });

  await test('plain-chat and /usage settings carry only allowed keys', () => {
    assert.deepEqual(Object.keys(JSON.parse(S.googleSettings)).filter((k) => !S.GEMINI_SETTINGS_KEYS.includes(k)), []);
  });

  await test('folder args (read-only, writable, with photos) never carry sandboxAllowNetwork', () => {
    for (const write of [false, true]) for (const photos of [undefined, ['/tmp/p']]) {
      const args = S.folderArgs('gemini', { path: '/tmp/x', write }, photos);
      const settings = JSON.parse(flag(args, '--settings'));
      assert.equal(settings.sandboxAllowNetwork, undefined, `write=${write} photos=${!!photos}`);
      assert.deepEqual(keysOf(args).filter((k) => !S.GEMINI_SETTINGS_KEYS.includes(k)), [], `write=${write}`);
      assert.ok(args.includes('--sandbox'), 'the sandbox stays on');
      assert.equal(flag(args, '--mode'), write ? S.GEMINI_AUTO_MODE : 'plan');
      assert.equal(settings.permissions.deny.includes('command(*)'), !write, 'read-only folders still run no commands');
    }
  });

  await test('the FIRST launch of every Gemini run is accepted: one invocation per run, no retry masking a bad flag', async () => {
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', 1000);
    const signal = new AbortController().signal;
    const selection = S.subscriptionSelection('u1', 'gemini');
    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    const cases = [
      ['plain chat', undefined, []],
      ['plain chat + photo', undefined, [{ mime: 'image/png', data: Buffer.from('x') }]],
      ['read-only folder', { path: bin, label: 'bin', write: false }, []],
      ['writable folder', { path: bin, label: 'bin', write: true }, []],
      ['writable folder + photo', { path: bin, label: 'bin', write: true }, [{ mime: 'image/png', data: Buffer.from('x') }]],
    ];
    try {
      for (const [name, folder, images] of cases) {
        const before = readFileSync(log, { encoding: 'utf8', flag: 'a+' }).trim().split('\n').filter(Boolean).length;
        const text = await S.subscriptionReply(selection, 'hello', signal, images, folder ? { folder } : {});
        assert.equal(text, 'Gemini reply', name);
        const runs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(before);
        assert.equal(runs.length, 1, `${name}: exactly one agy invocation (a retry would add a second)`);
        const [first] = runs;
        assert.equal(first.ok, true, `${name}: first launch rejected: ${first.why}`);
        assert.equal(JSON.parse(flag(first.args, '--settings')).sandboxAllowNetwork, undefined, name);
        assert.ok(first.args.includes('--sandbox'), `${name}: sandbox on`);
        assert.equal(flag(first.args, '--mode'), folder?.write ? S.GEMINI_AUTO_MODE : 'plan', `${name}: approval mode`);
        const settings = JSON.parse(flag(first.args, '--settings'));
        assert.equal(settings.allowNonWorkspaceAccess, false, `${name}: no non-workspace access`);
        for (const rule of ['unsandboxed(*)', 'execute_url(*)', 'mcp(*)']) assert.ok(settings.permissions.deny.includes(rule), `${name}: still denies ${rule}`);
        for (const rule of settings.permissions.allow) assert.ok(!/^(read_file|write_file|read_url)\(\*\)$/.test(rule), `${name}: no blanket allow ${rule}`);
        for (const rule of settings.permissions.allow.filter((r) => r.startsWith('write_file('))) assert.ok(rule === `write_file(${bin}/**)`, `${name}: writes scoped to the folder, got ${rule}`);
        if (!folder?.write) assert.ok(settings.permissions.deny.includes('command(*)'), `${name}: no commands outside a writable folder`);
      }
    } finally { console.warn = warn; }
    assert.deepEqual(warnings.filter((w) => /retrying/.test(w)), [], 'no retry path was taken');
    const all = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(all.filter((r) => !r.ok), [], 'agy never rejected a launch');
  });

  await test('the strict fake really rejects a bad flag/key on the first launch (negative control)', async () => {
    const { spawnSync } = await import('node:child_process');
    const bad = spawnSync(join(bin, 'agy'), ['--settings', JSON.stringify({ sandboxAllowNetwork: true })], { input: '' });
    assert.equal(bad.status, 1);
    assert.match(String(bad.stderr), /unknown setting "sandboxAllowNetwork"/);
    const badFlag = spawnSync(join(bin, 'agy'), ['--yolo'], { input: '' });
    assert.equal(badFlag.status, 1);
    assert.match(String(badFlag.stderr), /unknown flag --yolo/);
  });

  console.log(`PASS gemini-settings (${passed} tests): no unknown --settings keys, sandboxAllowNetwork gone, strict fake agy accepts every first launch`);
} finally {
  rmSync(bin, { recursive: true, force: true });
}
