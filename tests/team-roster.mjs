// Roster token bloat (Olaf's list_team audit: 11 static statuses in the prompt, then 12 live rows + 12 message
// excerpts from list_team). Now:
//  - the system prompt's team section names each Bot and its job but carries no volatile status;
//  - list_team reads status live on every call and returns routing fields with zero message excerpts by default;
//  - excerpts come back only for Bots named in messages_from (unknown names are reported, not guessed).
// Runs the real tool implementation and prompt builder against a temporary database.
// Usage: npm run build && node tests/team-roster.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-team-roster-'));
process.env.DB_PATH = join(work, 'marion.db');
process.env.MARION_NO_SCHEDULER = '1';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.HOST = '127.0.0.1';
process.env.PATH = work;

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  const { db } = await import('../server/dist/db.js');
  await import('../server/dist/features/schema.js');
  await import('../server/dist/db-config.js');
  (await import('../server/dist/agent/subagents.js')).initSubagents();
  (await import('../server/dist/agent/rooms.js')).initRooms();
  const { createBotRecord } = await import('../server/dist/features/bots.js');
  const { toolMap, functionSchemas } = await import('../server/dist/agent/tools.js');
  const { appendRow, setLive } = await import('../server/dist/store.js');
  const { liveTeamPrompt } = await import('../server/dist/agent/prompt.js');
  const { DEFAULT_UNIVERSAL_SKILLS } = await import('../server/dist/features/universal-skills.js');
  const { TEMPLATES } = await import('../server/dist/features/templates.js');

  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', 1000);
  const olaf = createBotRecord('u1', { name: 'Olaf' });
  const names = ['Ada', 'Ben', 'Cleo', 'Dev', 'Eve', 'Finn', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai'];
  const bots = Object.fromEntries(names.map(name => [name, createBotRecord('u1', { name })]));
  const room = createBotRecord('u1', { name: 'Standup' });
  db.prepare("UPDATE bots SET kind='room' WHERE id=?").run(room.id);
  const helper = createBotRecord('u1', { name: 'Ada helper' });
  db.prepare('UPDATE bots SET hidden=1, parent_bot_id=? WHERE id=?').run(bots.Ada.id, helper.id);
  for (const name of names) appendRow(bots[name].id, 'message', { role: 'assistant', text: `SECRET-${name} `.repeat(40) });
  appendRow(olaf.id, 'message', { role: 'assistant', text: 'olaf says hi' });

  const listTeam = async (args = {}) => JSON.parse((await toolMap.get('list_team').impl(args, { userId: 'u1', botId: olaf.id, depth: 0, enqueueBotMessage: () => {} })).output);
  const excerpts = (r) => r.team.filter(m => 'lastMessage' in m);

  await test('system prompt team section has no volatile status', () => {
    setLive(bots.Ben.id, { isRunning: true });
    const prompt = liveTeamPrompt('u1', olaf.id);
    for (const name of names) assert.match(prompt, new RegExp(`- ${name}\\b`), `${name} listed`);
    assert.doesNotMatch(prompt, /\bidle\b|— working|waiting for the user/, 'no status words');
    assert.doesNotMatch(prompt, /SECRET-/, 'no message text');
    assert.doesNotMatch(prompt, /Standup|Ada helper/, 'no rooms or hidden helpers');
    assert.match(prompt, /list_team/);
    setLive(bots.Ben.id, { isRunning: false });
    assert.equal(liveTeamPrompt('u1', olaf.id), prompt, 'prompt is identical whatever the live status (cache-stable)');
  });

  await test('one live list_team call sees a flipped status and returns zero excerpts by default', async () => {
    const before = await listTeam();
    assert.equal(before.team.length, 12, '12 visible Bots including the caller');
    assert.equal(before.team.find(m => m.name === 'Cleo').status, 'idle');
    setLive(bots.Cleo.id, { isRunning: true });
    const after = await listTeam();
    assert.equal(after.team.find(m => m.name === 'Cleo').status, 'working', 'status read live, not from the prompt');
    setLive(bots.Cleo.id, { isRunning: false, awaiting: { reason: 'your answer', since: Date.now() } });
    assert.equal((await listTeam()).team.find(m => m.name === 'Cleo').status, 'waiting for the user');
    assert.equal(excerpts(after).length, 0, 'zero message excerpts by default');
    assert.doesNotMatch(JSON.stringify(after), /SECRET-|olaf says hi/);
    const cleo = after.team.find(m => m.name === 'Cleo');
    assert.deepEqual(Object.keys(cleo).sort(), ['job', 'lastActiveAt', 'model', 'name', 'role', 'status', 'you']);
    assert.ok(cleo.lastActiveAt, 'last activity kept for routing');
    assert.equal(after.team.find(m => m.name === 'Olaf').you, true);
    assert.equal(after.unknownNames, undefined);
  });

  await test('opt-in returns only the explicitly named Bot\'s excerpt (case-insensitive, @ allowed)', async () => {
    const r = await listTeam({ messages_from: ['@cleo'] });
    assert.deepEqual(excerpts(r).map(m => m.name), ['Cleo']);
    assert.ok(r.team.find(m => m.name === 'Cleo').lastMessage.startsWith('SECRET-Cleo'));
    assert.ok(r.team.find(m => m.name === 'Cleo').lastMessage.length <= 200, 'excerpt capped');
    assert.doesNotMatch(JSON.stringify(r), new RegExp(`SECRET-(${names.filter(n => n !== 'Cleo').join('|')})|olaf says hi`), 'no other Bot\'s text');
  });

  await test('negative: unknown, empty, hidden and room names give no excerpt and are reported', async () => {
    const r = await listTeam({ messages_from: ['Nobody', '', '  ', 'Ada helper', 'Standup', 42] });
    assert.equal(excerpts(r).length, 0);
    assert.deepEqual(r.unknownNames.sort(), ['ada helper', 'nobody', 'standup']);
    const empty = await listTeam({ messages_from: [] });
    assert.equal(excerpts(empty).length, 0);
    assert.equal(empty.unknownNames, undefined);
  });

  await test('default list_team output is far smaller than the old one with excerpts', async () => {
    const lean = JSON.stringify(await listTeam()).length;
    const all = JSON.stringify(await listTeam({ messages_from: [...names, 'Olaf'] })).length;
    assert.ok(lean * 2 < all, `lean ${lean} vs all excerpts ${all}`);
  });

  await test('schema, description, prompts and skills stay in sync', () => {
    const schema = functionSchemas('u1', olaf.id).find(t => t.name === 'list_team');
    assert.equal(schema.parameters.properties.messages_from.type, 'array');
    assert.deepEqual(schema.parameters.required, []);
    assert.match(schema.description, /messages_from/);
    assert.match(schema.description, /No message text by default/);
    assert.doesNotMatch(schema.description, /its latest message\. Use/);
    const guide = DEFAULT_UNIVERSAL_SKILLS.find(s => s.key === 'marion-agent-guide').body;
    assert.match(guide, /messages_from/);
    assert.doesNotMatch(JSON.stringify(TEMPLATES), /list_team for status and each Bot's latest message/);
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
