import assert from 'node:assert/strict';

// No listener or model calls: use the voice prompt to skip app discovery.
process.env.DB_PATH = ':memory:';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();

const { createBotRecord } = await import('../server/dist/features/bots.js');
const { setLive } = await import('../server/dist/store.js');
const { systemPrompt } = await import('../server/dist/agent/prompt.js');
try {
  const user = db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)');
  user.run('owner', 'owner@example.com', 'Owner', Date.now());
  user.run('other', 'other@example.com', 'Other', Date.now());
  const bot = (name, options = {}) => createBotRecord('owner', { name, ...options });
  const self = bot('SelfBot');
  const working = bot('ResearchBot', { label: 'Research' });
  const waiting = bot('ApprovalBot');
  bot('IdleBot');
  const hidden = bot('HiddenBot');
  const room = bot('RoomBot');
  db.prepare('UPDATE bots SET hidden=1 WHERE id=?').run(hidden.id);
  db.prepare("UPDATE bots SET kind='room' WHERE id=?").run(room.id);
  createBotRecord('other', { name: 'OtherPrivateBot' });
  setLive(working.id, { isRunning: true });
  setLive(waiting.id, { isRunning: true, awaiting: { reason: 'Approval' } });
  const prompt = await systemPrompt('owner', self.id, true);
  // Status is volatile, so the prompt names teammates and jobs only; list_team reads status live (tests/team-roster.mjs).
  assert.match(prompt, /- ResearchBot \(Research\)\n/);
  assert.match(prompt, /- ApprovalBot\n/);
  assert.match(prompt, /- IdleBot\n?/);
  assert.doesNotMatch(prompt, / — (working|idle|waiting for the user)/);
  assert.doesNotMatch(prompt, /- SelfBot|HiddenBot|RoomBot|OtherPrivateBot/);
  setLive(working.id, { isRunning: false });
  setLive(waiting.id, { isRunning: false, awaiting: null });
  const again = await systemPrompt('owner', self.id, true);
  const section = (p) => p.slice(p.indexOf('- Other Bots on the team'), p.indexOf('- IdleBot'));
  assert.equal(section(again), section(prompt), 'team section is the same whatever the live status');
  console.log('PASS: system prompts list visible teammates only, with no volatile status.');
} finally {
  db.close();
}
