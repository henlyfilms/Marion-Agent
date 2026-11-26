// Running Claude Code sessions show as active in Sessions even when their transcript has been quiet for minutes
// (a long tool call or a long think), and only as many sessions per folder as there are live `claude` processes.
// Uses a temporary HOME with fake transcripts and a fake process lookup; no real CLIs.
// Usage: node --import tsx tests/running-claude-sessions.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'marion-running-claude-'));
process.env.MARION_SESSIONS_HOME = home;
const { listCodingSessions, setClaudeProcessProbe, markRunningClaude } = await import('../server/src/features/sessions.ts');

const transcript = (id, cwd, title, ageMs) => {
  const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', cwd, message: { content: title } }) + '\n');
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
};
transcript('fresh', '/work/alpha', 'Fresh in alpha', 10_000);
transcript('quiet', '/work/beta', 'Quiet but running in beta', 20 * 60_000);
transcript('old-beta', '/work/beta', 'Old finished beta session', 5 * 3600_000);
transcript('two-a', '/work/gamma', 'Gamma newer', 30 * 60_000);
transcript('two-b', '/work/gamma', 'Gamma older', 40 * 60_000);
transcript('done', '/work/delta', 'Finished delta', 2 * 3600_000);

const byTitle = () => Object.fromEntries(listCodingSessions('claude').map(s => [s.title, s.active]));

setClaudeProcessProbe(() => []);
assert.deepEqual(byTitle(), {
  'Fresh in alpha': true, 'Quiet but running in beta': false, 'Old finished beta session': false,
  'Gamma newer': false, 'Gamma older': false, 'Finished delta': false,
}, 'with no claude process running, only recently written transcripts are active');

setClaudeProcessProbe(() => ['/work/alpha', '/work/beta', '/work/gamma', '/work/gamma']);
assert.deepEqual(byTitle(), {
  'Fresh in alpha': true, 'Quiet but running in beta': true, 'Old finished beta session': false,
  'Gamma newer': true, 'Gamma older': true, 'Finished delta': false,
}, 'a live process keeps its quiet session running; one process claims one session; other folders stay finished');
console.log('PASS: running Claude Code sessions are listed as active, per live process, even when quiet.');

// A fresh transcript uses up the folder's one process, so an older session in the same folder is not also "running".
const sessions = [
  { id: 'a', provider: 'claude', title: 'a', project: '', path: '/f', updatedAt: 3, active: true },
  { id: 'b', provider: 'claude', title: 'b', project: '', path: '/f', updatedAt: 2, active: false },
  { id: 'c', provider: 'codex', title: 'c', project: '', path: '/f', updatedAt: 1, active: false },
];
assert.deepEqual(markRunningClaude(sessions, ['/f']).map(s => s.active), [true, false, false]);
assert.deepEqual(markRunningClaude(sessions, ['/f', '/f']).map(s => s.active), [true, true, false], 'only Claude sessions are matched');
console.log('PASS: a live process is never counted for two sessions.');

setClaudeProcessProbe(null);
rmSync(home, { recursive: true, force: true });
process.exit(0);
