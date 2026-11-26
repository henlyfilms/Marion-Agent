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

rmSync(work, { recursive: true, force: true });
process.exit(0);
