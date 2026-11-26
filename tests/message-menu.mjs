import assert from 'node:assert/strict';

// Disposable in-memory database; no listener or model calls. Usage: npm run build && node tests/message-menu.mjs
process.env.DB_PATH = ':memory:';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');

const { createBotRecord } = await import('../server/dist/features/bots.js');
const { appendRow, getBot, getRow } = await import('../server/dist/store.js');
const { isWorkFxChoice, WORK_FX_STYLES } = await import('../server/dist/avatarShapes.js');

try {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'Owner', Date.now());
  const { id } = createBotRecord('owner', { name: 'Scout' });

  // Working animation: defaults to "auto", accepts every style, persists, and rejects anything else.
  assert.equal(getBot(id).workFx, 'auto');
  assert.deepEqual([...WORK_FX_STYLES], ['halo', 'orbit', 'comet', 'ripple', 'sparkle', 'swirl']);
  for (const style of ['auto', ...WORK_FX_STYLES]) assert.ok(isWorkFxChoice(style), style);
  for (const bad of ['', 'spin', null, 4, undefined]) assert.ok(!isWorkFxChoice(bad), String(bad));
  db.prepare('UPDATE bots SET work_fx=? WHERE id=?').run('comet', id);
  assert.equal(getBot(id).workFx, 'comet');
  db.prepare('UPDATE bots SET work_fx=? WHERE id=?').run('not-a-style', id);
  assert.equal(getBot(id).workFx, 'auto', 'a bad stored value falls back to auto');
  console.log('PASS: working animation choice is stored per bot and validated.');

  // Reply / forward details survive in the stored message.
  const first = appendRow(id, 'message', { type: 'message', role: 'assistant', text: 'Here is the plan.' });
  const reply = appendRow(id, 'message', {
    type: 'message', role: 'user', text: 'Make it shorter',
    replyTo: { seq: first.seq, role: 'assistant', name: 'Scout', text: 'Here is the plan.' },
  });
  const forwarded = appendRow(id, 'message', { type: 'message', role: 'user', text: 'FYI', forwarded: { name: 'Atlas' } });
  assert.deepEqual(getRow(id, reply.seq).body.replyTo, { seq: first.seq, role: 'assistant', name: 'Scout', text: 'Here is the plan.' });
  assert.deepEqual(getRow(id, forwarded.seq).body.forwarded, { name: 'Atlas' });
  console.log('PASS: reply quotes and forward labels are kept with the message.');
} finally {
  db.close();
}
