// Background work: `shell` with background:true starts detached and returns at once (log + exit file), helpers that already
// finished no longer use up the subagent slots, and up to 6 can work at once. No Docker, no ports.
// Usage: node --import tsx tests/background-work.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-bg-'));
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';
const { db, now } = await import('../server/src/db.ts');
await import('../server/src/features/schema.ts');
const { initSubagents, createSubagent, MAX_ACTIVE_SUBAGENTS } = await import('../server/src/agent/subagents.ts');
const { backgroundScript } = await import('../server/src/agent/tools.ts');
initSubagents();

// 1. The background script returns immediately, survives, and records output and the exit code (/workspace → temp dir).
const script = backgroundScript('job-abc-1', `echo "it's running"; sleep 1; echo done; exit 3`).replaceAll('/workspace', work);
const t0 = Date.now();
const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
assert.ok(Date.now() - t0 < 900, `returns at once, not after the 1 s job (${Date.now() - t0} ms)`);
assert.match(out.stdout.trim(), /^\d+$/, 'prints the pid');
await new Promise(r => setTimeout(r, 1600));
assert.equal(readFileSync(join(work, '.jobs/job-abc-1.log'), 'utf8'), "it's running\ndone\n", 'quotes survive and output is logged');
assert.equal(readFileSync(join(work, '.jobs/job-abc-1.exit'), 'utf8').trim(), '3', 'the exit code is recorded');
assert.throws(() => backgroundScript('x; rm -rf /', 'true'), /Invalid job id/);
console.log('PASS: background shell returns at once and keeps running with its log and exit code.');

// 2. Subagent slots: only helpers that are still working count.
const userId = 'user_bg';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'bg@example.com', 'Owner', now());
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_parent', userId, 'Parent', now(), now());
const busy = new Set();
const spawn = (n) => { const s = createSubagent('bot_parent', `goal ${n}`, `h${n}`, id => busy.has(id)); busy.add(s.id); return s; };
const made = Array.from({ length: MAX_ACTIVE_SUBAGENTS }, (_, n) => spawn(n));
assert.equal(MAX_ACTIVE_SUBAGENTS, 6);
assert.throws(() => spawn(99), /already working at once/, 'a 7th simultaneous helper waits');
busy.delete(made[0].id); busy.delete(made[1].id); // two finished and reported back
assert.doesNotThrow(() => spawn(100), 'finished helpers free their slot even if the parent has not removed them');
assert.doesNotThrow(() => spawn(101));
assert.throws(() => spawn(102), /already working at once/);
console.log('PASS: up to 6 helpers work in parallel; finished ones no longer block new ones.');

rmSync(work, { recursive: true, force: true });
process.exit(0);
