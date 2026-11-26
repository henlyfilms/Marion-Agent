// Universal memory: storage, idempotent seeding, prompt injection, remember/recall with `universal`.
// No listener and no model calls (in-memory database). Usage: npm run build && node tests/universal-memory.mjs
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();

const { createBotRecord } = await import('../server/dist/features/bots.js');
const { systemPrompt } = await import('../server/dist/agent/prompt.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
const M = await import('../server/dist/features/universal-memory.js');

const SEED = "Claude Code is always launched in auto mode (never don't ask mode unless explicitly instructed by the user).";
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const occurrences = (text, needle) => text.split(needle).length - 1;

try {
  const addUser = db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)');
  addUser.run('u1', 'one@example.com', 'One', 1000);
  addUser.run('u2', 'two@example.com', 'Two', 1000);

  // ---- idempotent seeding ----
  M.migrateUniversalMemories();
  M.migrateUniversalMemories();
  M.ensureUniversalMemories('u1');
  for (const u of ['u1', 'u2']) {
    const rows = db.prepare('SELECT text FROM universal_memories WHERE user_id=?').all(u);
    assert.equal(rows.length, 1, `${u}: seeded exactly once after repeated startups`);
    assert.equal(rows[0].text, SEED);
  }
  // A pre-existing identical memory (any spacing/case) is not duplicated by seeding.
  addUser.run('u3', 'three@example.com', 'Three', 1000);
  db.prepare('INSERT INTO universal_memories(id,user_id,text,created_at,updated_at) VALUES (?,?,?,?,?)').run('x1', 'u3', SEED.toUpperCase(), 1, 1);
  M.migrateUniversalMemories();
  assert.equal(count('SELECT COUNT(*) n FROM universal_memories WHERE user_id=?', 'u3'), 1, 'no duplicate next to an existing identical memory');
  console.log('PASS idempotent seeding');

  // ---- storage: add / dedupe / edit / delete / isolation ----
  const a = M.addUniversalMemory('u1', '  The user prefers   metric units. ');
  assert.ok(a.ok && a.created && a.memory.text === 'The user prefers metric units.', 'whitespace is normalised');
  const again = M.addUniversalMemory('u1', 'the user prefers metric units.');
  assert.ok(again.ok && !again.created && again.memory.id === a.memory.id, 'duplicates are reused');
  assert.equal(M.addUniversalMemory('u1', '   ').ok, false, 'empty text is rejected');
  const edited = M.updateUniversalMemory('u1', a.memory.id, 'The user prefers imperial units.');
  assert.ok(edited.ok && edited.memory.text === 'The user prefers imperial units.');
  assert.equal(M.updateUniversalMemory('u1', a.memory.id, SEED).ok, false, 'editing into a duplicate is rejected');
  assert.equal(M.updateUniversalMemory('u2', a.memory.id, 'hijack').ok, false, 'other users cannot edit it');
  assert.equal(M.deleteUniversalMemory('u2', a.memory.id), false, 'other users cannot delete it');
  assert.equal(M.listUniversalMemories('u2').length, 1, 'users do not see each other\'s memories');
  const b = M.addUniversalMemory('u1', 'Temporary fact.');
  assert.equal(M.deleteUniversalMemory('u1', b.memory.id), true);
  assert.equal(M.getUniversalMemory('u1', b.memory.id), undefined);
  M.ensureUniversalMemories('u1');
  M.deleteUniversalMemory('u1', M.listUniversalMemories('u1').find((m) => m.text === SEED).id);
  M.migrateUniversalMemories();
  assert.ok(!M.listUniversalMemories('u1').some((m) => m.text === SEED), 'deleting the seeded memory keeps it deleted on restart');
  M.addUniversalMemory('u1', SEED); // restore for the prompt checks below
  console.log('PASS storage, dedupe, edit, delete, isolation');

  // ---- prompt injection: every bot of the user, alongside its own memories ----
  const bot1 = createBotRecord('u1', { name: 'Ada' }), bot2 = createBotRecord('u1', { name: 'Bo' });
  const other = createBotRecord('u2', { name: 'Cy' });
  db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)').run('m1', bot1.id, 'Ada-only private memory', 10);
  for (const bot of [bot1, bot2]) {
    const prompt = await systemPrompt('u1', bot.id);
    assert.equal(occurrences(prompt, SEED), 1, `${bot.name}: universal memory appears exactly once`);
    assert.match(prompt, /Universal memory/);
    assert.match(prompt, /imperial units/);
  }
  const p1 = await systemPrompt('u1', bot1.id), p2 = await systemPrompt('u1', bot2.id);
  assert.match(p1, /Ada-only private memory/);
  assert.doesNotMatch(p2, /Ada-only private memory/, 'per-bot memories stay private');
  assert.doesNotMatch(await systemPrompt('u2', other.id), /imperial units/, 'other users do not get them');
  const late = createBotRecord('u1', { name: 'Late' });
  assert.match(await systemPrompt('u1', late.id), /imperial units/, 'new bots get them too');
  console.log('PASS prompt injection');

  // ---- remember / recall ----
  const remember = toolMap.get('remember'), recall = toolMap.get('recall');
  assert.equal(remember.parameters.properties.universal.type, 'boolean');
  const ctx1 = { userId: 'u1', botId: bot1.id }, ctx2 = { userId: 'u1', botId: bot2.id };
  await remember.impl({ text: 'Private to Ada: likes tea' }, ctx1);
  assert.equal(count('SELECT COUNT(*) n FROM memories WHERE bot_id=? AND text=?', bot1.id, 'Private to Ada: likes tea'), 1, 'plain remember stays per-bot');
  assert.ok(!M.listUniversalMemories('u1').some((m) => /likes tea/.test(m.text)));
  const saved = await remember.impl({ text: 'The office is in Lisbon.', universal: true }, ctx1);
  assert.match(saved.output, /universal/i);
  assert.equal(count('SELECT COUNT(*) n FROM memories WHERE text=?', 'The office is in Lisbon.'), 0, 'universal remember is not stored per-bot');
  await remember.impl({ text: 'the office is in lisbon.', universal: true }, ctx2);
  assert.equal(M.listUniversalMemories('u1').filter((m) => /Lisbon/.test(m.text)).length, 1, 'universal remember does not duplicate');
  for (const ctx of [ctx1, ctx2]) {
    const hits = JSON.parse((await recall.impl({ query: 'office Lisbon' }, ctx)).output);
    assert.ok(hits.includes('The office is in Lisbon.'), 'every bot recalls the universal memory');
  }
  const teaForBo = JSON.parse((await recall.impl({ query: 'tea' }, ctx2)).output);
  assert.ok(!teaForBo.includes('Private to Ada: likes tea'), 'recall keeps per-bot memories private');
  const teaForAda = JSON.parse((await recall.impl({ query: 'tea' }, ctx1)).output);
  assert.ok(teaForAda.includes('Private to Ada: likes tea'), 'recall still finds per-bot memories');
  assert.deepEqual(JSON.parse((await recall.impl({ query: 'Lisbon' }, { userId: 'u2', botId: other.id })).output), [], 'other users do not recall them');
  console.log('PASS remember(universal) and recall');
} finally {
  db.close();
}
