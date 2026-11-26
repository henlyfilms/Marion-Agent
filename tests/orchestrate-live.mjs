// Live orchestration check with the real CLIs (uses a little of your Codex and Gemini plan usage).
// Usage: npm run build && node tests/orchestrate-live.mjs "<orchestrator>" "<worker>" [count]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'marion-orch-')), 'o.db');
process.env.MARION_DESKTOP_TOKEN = 'test'; process.env.HOST = '127.0.0.1'; process.env.SERVER_URL = 'http://127.0.0.1:8870';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js'); await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { orchestrate } = await import('../server/dist/agent/orchestrate.js');
const { listRows } = await import('../server/dist/store.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', Date.now());
const bot = createBotRecord('u1', { name: 'Barry' });
const started = Date.now();
const result = await orchestrate({ userId: 'u1', botId: bot.id, allowSubscriptionTeam: true }, {
  goal: 'Write a tiny JavaScript function isPalindrome(s) that ignores case and non-letters, plus three example calls with expected results. Keep it short.',
  orchestrator: process.argv[2] ?? 'codex', workers: [process.argv[3] ?? 'gemini'], worker_count: Number(process.argv[4] ?? 2),
});
const card = listRows(bot.id).find(r => r.body.card === 'work').body;
console.log('took', Math.round((Date.now() - started) / 1000), 's');
console.log('agents', card.agents.map(a => `${a.role}:${a.label}`).join(', '));
console.log('phases', card.phases.map(p => `${p.title}=${p.status}`).join(' | '));
console.log('status', card.status, 'steps', card.steps.length);
for (const s of card.steps) console.log('  ', s.agent, s.kind, s.text.slice(0, 100));
console.log('\nREPORT:', result.output.slice(0, 900));
