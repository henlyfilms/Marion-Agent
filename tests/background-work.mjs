// Background work: `shell` with background:true starts detached and returns at once (log + exit file), and
// there is no cap on how many subagents work at once. No Docker, no ports.
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
const subagents = await import('../server/src/agent/subagents.ts');
const { initSubagents, createSubagent } = subagents;
const { backgroundScript } = await import('../server/src/agent/tools.ts');
initSubagents();

// 1. The background script returns immediately, survives, and records output and the exit code (/workspace → temp dir).
const script = backgroundScript('job-abc-1', `echo "it's running"; sleep 1; echo done; exit 3`).replaceAll('/workspace', `'${work.replaceAll("'", "'\\''")}'`);
const t0 = Date.now();
const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
assert.ok(Date.now() - t0 < 900, `returns at once, not after the 1 s job (${Date.now() - t0} ms)`);
assert.match(out.stdout.trim(), /^\d+$/, 'prints the pid');
await new Promise(r => setTimeout(r, 1600));
assert.equal(readFileSync(join(work, '.jobs/job-abc-1.log'), 'utf8'), "it's running\ndone\n", 'quotes survive and output is logged');
assert.equal(readFileSync(join(work, '.jobs/job-abc-1.exit'), 'utf8').trim(), '3', 'the exit code is recorded');
assert.throws(() => backgroundScript('x; rm -rf /', 'true'), /Invalid job id/);
console.log('PASS: background shell returns at once and keeps running with its log and exit code.');

// 2. No subagent cap: far more than the old limit of 6 helpers can work at once, and the parent can keep adding more.
const userId = 'user_bg';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, 'bg@example.com', 'Owner', now());
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_parent', userId, 'Parent', now(), now());
const made = Array.from({ length: 40 }, (_, n) => createSubagent('bot_parent', `goal ${n}`, `h${n}`));
assert.equal(new Set(made.map(s => s.id)).size, 40, 'every helper gets its own id');
assert.equal(db.prepare('SELECT COUNT(*) n FROM bots WHERE parent_bot_id=? AND hidden=1').get('bot_parent').n, 40);
assert.equal(subagents.MAX_ACTIVE_SUBAGENTS, undefined, 'no active-helper cap is exported any more');
console.log('PASS: 40 helpers can work at once (no cap); each is its own hidden bot.');

rmSync(work, { recursive: true, force: true });
process.exit(0);
