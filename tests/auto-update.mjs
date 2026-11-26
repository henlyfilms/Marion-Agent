// Auto-update: ON by default, saved in settings, and only installs when it is safe (nothing running, nobody mid-chat,
// a clean newer commit). Uses a temporary Git folder and a temporary database; no update is really started.
// Usage: node --import tsx tests/auto-update.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-auto-update-'));
const source = join(work, 'source');
const git = (...args) => execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
mkdirSync(join(source, 'scripts'), { recursive: true });
writeFileSync(join(source, 'scripts', 'package-distributions.sh'), '#!/bin/bash\n');
git('init', '-q');
git('add', '.');
git('commit', '-qm', 'first');
const built = git('rev-parse', '--short=7', 'HEAD');
writeFileSync(join(source, 'change.txt'), 'x');
git('add', '.');
git('commit', '-qm', 'second');

process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_SOURCE_DIR = source;
process.env.MARION_DESKTOP_TOKEN = 'token';
process.env.MARION_BUILD_ID = `${built}.1700000000`;
process.env.MARION_NO_SCHEDULER = '1';

const { db, now } = await import('../server/src/db.ts');
await import('../server/src/features/schema.ts');
const { autoUpdateTick, updateSettings, setAutoUpdate } = await import('../server/src/features/app-update.ts');

const userId = 'user_test';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'owner@example.com', 'Owner', now());
db.prepare('INSERT INTO desktop_workspace(slot,user_id) VALUES (1,?)').run(userId);

let started = 0;
const start = () => { started++; return { ok: true }; };
const tick = (extra = {}) => autoUpdateTick({ busy: () => 0, start, ...extra });

// Default: ON, with nothing saved.
assert.equal(updateSettings(userId).autoUpdate, true, 'Auto-update is on by default');
assert.equal(db.prepare("SELECT COUNT(*) n FROM user_settings WHERE key='app-update'").get().n, 0, 'default needs no saved value');
console.log('PASS: Auto-update is ON by default.');

assert.equal(await tick({ busy: () => 1 }), 'busy', 'never starts while a bot or relay is running');
assert.equal(started, 0);
assert.equal(await tick(), 'started', 'installs the newer commit when it is quiet');
assert.equal(started, 1);
assert.equal(await tick(), 'retry-later', 'the same commit is not retried straight away');
console.log('PASS: auto-update waits for running work, installs when quiet, and does not loop.');

// Recent chat activity holds it back.
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_x', userId, 'Quinn', now(), now());
db.prepare("INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES ('bot_x',1,1,1,'message','{}',?)").run(now());
db.prepare("DELETE FROM user_settings WHERE key='app-update'").run();
assert.equal(await tick(), 'recently-active');
assert.equal(await tick({ at: now() + 6 * 60_000 }), 'started');
console.log('PASS: auto-update waits until nobody has chatted for a few minutes.');

// The switch: off is saved and respected; back on works.
setAutoUpdate(userId, false);
assert.equal(updateSettings(userId).autoUpdate, false);
assert.equal(await tick({ at: now() + 7 * 3600_000 }), 'off');
setAutoUpdate(userId, true);
assert.equal(updateSettings(userId).autoUpdate, true);
console.log('PASS: the Auto-update switch is saved and respected.');

// A dirty source folder is never auto-built; an up-to-date build does nothing.
writeFileSync(join(source, 'change.txt'), 'edited');
db.prepare("DELETE FROM user_settings WHERE key='app-update'").run();
assert.equal(await tick({ at: now() + 14 * 3600_000 }), 'dirty');
git('checkout', '--', 'change.txt');
process.env.MARION_BUILD_ID = `${git('rev-parse', '--short=7', 'HEAD')}.1700000001`;
assert.equal(await tick({ at: now() + 14 * 3600_000 }), 'current');
console.log('PASS: auto-update skips a dirty source folder and an up-to-date build.');

// ---- No false "Update available" right after installing the latest build ----
// The new app can adopt a server that is still running the OLD build (it is swapped only when idle), and that server's own
// build id and web bundle are old. The app reports the build it really is when it attaches; the update check trusts that.
const { setAppBuild, installedBuild } = await import('../server/src/lib/lifecycle.ts');
const { updateStatus } = await import('../server/src/features/app-update.ts');
const head = git('rev-parse', '--short=7', 'HEAD');
process.env.MARION_BUILD_ID = `${built}.1700000000`; // the old server still running
assert.equal((await updateStatus(installedBuild(built))).behind, 1, 'without the app reporting, an old server looks behind');
setAppBuild('not-a-commit');
assert.equal(installedBuild(built), built, 'a malformed build from the app is ignored');
setAppBuild(`${head}.1700000002`);
assert.equal(installedBuild(built), head, 'the installed app build wins over what the old server and web bundle report');
assert.equal((await updateStatus(installedBuild(built))).behind, 0, 'no "Update available" right after installing the latest build');
assert.equal(await tick({ at: now() + 20 * 3600_000 }), 'current', 'and auto-update does not reinstall the build that is already installed');
writeFileSync(join(source, 'newer.txt'), 'y');
git('add', '.');
git('commit', '-qm', 'third');
assert.equal((await updateStatus(installedBuild(built))).behind, 1, 'a genuinely newer commit still shows as an update');
console.log('PASS: the installed app build decides "Update available", not the old server that kept running.');

// ---- "Install update" never interrupts running bots or relayed sessions ----
// 1. The app swap leaves the detached server (and the bots/relays it runs) alone: the installer only closes the Mac app,
//    never signals node/server processes; the new app re-adopts the server and only replaces it once it is idle.
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const installer = readFileSync(new URL('Marion Agent Installer/Install Marion Agent.command', root), 'utf8');
const killers = installer.split('\n').filter(line => /\b(pkill|killall|kill)\b/.test(line));
assert.ok(killers.length > 0 && killers.every(line => line.includes('/Contents/MacOS/Electron')), 'the installer only ever signals the Mac app itself');
assert.ok(!/server-runtime|server\.cjs|runtime\/node/.test(killers.join('\n')), 'the installer never signals the background server');
const host = readFileSync(new URL('Marion Agent Installer/payload/Resources/app/server-host.cjs', root), 'utf8');
assert.match(host, /detached: true/, 'the server runs detached so quitting/replacing the app does not touch it');
assert.match(host, /body\.busy === 0 && \(await retire\(saved\)\) !== 'busy'/, 'launch-time swap needs idle AND the server agreeing');
assert.match(host, /replace\([^)]*\{ onlyIfIdle: true \}\)/, 'the watcher only swaps after the server agrees it is idle');
const main = readFileSync(new URL('Marion Agent Installer/payload/Resources/app/main.cjs', root), 'utf8');
const stopCalls = main.match(/serverHost\.stop\(\)/g) ?? [];
assert.equal(stopCalls.length, 1, 'only "Quit and Stop Background Work" (behind a confirmation) stops the server');
assert.match(main, /before-quit', \(\) => \{ quitting = true; \}\)/, 'plain quit/update leaves the server running');
console.log('PASS: Install update only restarts the app; the background server and its work are not signalled.');

// ---- Commits that don't change the installed app never show "Update available" ----
{
  const built2 = git('rev-parse', '--short=7', 'HEAD');
  mkdirSync(join(source, 'tests'), { recursive: true });
  mkdirSync(join(source, 'docs'), { recursive: true });
  writeFileSync(join(source, 'tests', 'x.mjs'), 'x');
  writeFileSync(join(source, 'docs', 'y.txt'), 'y');
  writeFileSync(join(source, 'README.md'), 'readme');
  git('add', '.');
  git('commit', '-qm', 'tests and docs only');
  assert.equal((await updateStatus(built2)).behind, 0, 'a tests/docs/README-only commit is not an update for the installed app');
  writeFileSync(join(source, 'app.txt'), 'z');
  git('add', '.');
  git('commit', '-qm', 'app change');
  const after = await updateStatus(built2);
  assert.equal(after.behind, 1, 'a real app change after it still counts');
  assert.deepEqual(after.changes, ['app change']);
  console.log('PASS: only commits that change the installed app count as an update.');

  // History rewrites: the installed commit is not an ancestor of HEAD, but the shipped files are identical.
  const installed = git('rev-parse', '--short=7', 'HEAD');
  git('checkout', '-q', '-b', 'rewritten');
  writeFileSync(join(source, 'notes.md'), 'n');
  git('add', '.');
  git('commit', '-qm', 'notes only');
  git('commit', '-q', '--amend', '-m', 'notes only (amended)');
  git('checkout', '-q', '-');
  git('reset', '-q', '--hard', 'rewritten~1');
  git('commit', '-q', '--allow-empty', '-m', 'rewritten history');
  assert.equal((await updateStatus(installed)).behind, 0, 'a different HEAD with identical app files is not an update');
  git('branch', '-qD', 'rewritten');
  // An app change that was reverted leaves the app identical to what is installed.
  writeFileSync(join(source, 'app.txt'), 'changed');
  git('add', '.');
  git('commit', '-qm', 'app tweak');
  assert.equal((await updateStatus(installed)).behind, 1, 'the tweak is an update while it is in');
  git('revert', '--no-edit', 'HEAD');
  assert.equal((await updateStatus(installed)).behind, 0, 'a reverted app change is not an update');
  console.log('PASS: rewritten or reverted history with identical app files is not an update.');
}

// ---- Packaging stamps ONE commit everywhere, and the app retries its attach ----
{
  const root2 = new URL('../', import.meta.url);
  const pack = readFileSync(new URL('scripts/package-distributions.sh', root2), 'utf8');
  assert.equal((pack.match(/git rev-parse --short=7 HEAD 2>\/dev\/null \|\| echo dev\)"\s*$/gm) ?? []).length, 1, 'HEAD is read once for the stamp');
  assert.match(pack, /export MARION_BUILD_COMMIT="\$commit"/, 'the web build gets the same pinned commit');
  assert.match(pack, /printf '%s\.%s\\n' "\$commit" "\$\(date \+%s\)" > "\$resources\/BUILD_ID"/, 'BUILD_ID uses the pinned commit');
  assert.ok(pack.indexOf('MARION_BUILD_COMMIT') < pack.indexOf('npm run build -w web'), 'pinned before the web build starts');
  const vite = readFileSync(new URL('web/vite.config.ts', root2), 'utf8');
  assert.match(vite, /process\.env\.MARION_BUILD_COMMIT/, 'vite stamps the pinned commit');
  assert.match(host, /if \(!attached && body\.build !== buildId\) await attach\(\)/, 'a lost first attach is retried while the server is old');
  assert.match(host, /attached = response\.ok/, 'attach success is tracked');
  const { reportedAppBuild } = await import('../server/src/lib/lifecycle.ts');
  assert.equal(reportedAppBuild(), head, 'the server exposes which app build it was told (health.appBuild)');
  console.log('PASS: one pinned commit across BUILD_ID and web bundle; attach is retried until it lands.');
}

// 2. The server only agrees to be replaced when it is idle, in one atomic step, and then takes no new work.
const { retire, isRetiring, busyCount } = await import('../server/src/lib/lifecycle.ts');
assert.equal(busyCount(), 0);
// A running bot turn (a held queue entry) makes it refuse and stay available.
db.prepare('INSERT OR IGNORE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_busy', userId, 'Busy', now(), now());
let release;
const hold = new Promise(resolve => { release = resolve; });
const { runInBotQueue } = await import('../server/src/agent/loop.ts');
const running = runInBotQueue('bot_busy', () => hold);
assert.equal(busyCount(), 1, 'a running turn or relayed session counts as busy');
assert.deepEqual(retire(), { busy: 1 }, 'a busy server refuses to retire');
assert.equal(isRetiring(), false, 'refusing leaves the server taking work as usual');
release();
await running;
await new Promise(resolve => setImmediate(resolve));
assert.equal(busyCount(), 0);
assert.deepEqual(retire(), { ok: true }, 'an idle server agrees to retire');
assert.equal(isRetiring(), true, 'and from then on turns away new requests until the app stops it');
console.log('PASS: the server refuses to be replaced while a bot or relayed session runs, and agrees atomically only when idle.');

rmSync(work, { recursive: true, force: true });
process.exit(0);
