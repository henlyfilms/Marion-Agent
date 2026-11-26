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
  assert.match(prompt, /- ResearchBot \(Research\).* — working/);
  assert.match(prompt, /- ApprovalBot.* — waiting for the user/);
  assert.match(prompt, /- IdleBot.* — idle/);
  assert.doesNotMatch(prompt, /- SelfBot|HiddenBot|RoomBot|OtherPrivateBot/);
  setLive(working.id, { isRunning: false });
  assert.match(await systemPrompt('owner', self.id, true), /- ResearchBot.* — idle/);
  console.log('PASS: system prompts show refreshed working, idle, and waiting statuses for visible teammates only.');
} finally {
  db.close();
}
