// Agent task tools: create_task assigns to the calling Bot by default or to another active Bot by name (unknown, deleted,
// group-chat and other Bots' helpers are refused), never makes a duplicate of an open task with the same normalized
// title (done tasks don't block), and update_task says truthfully when nothing was updated (missing task vs another
// Bot's task) instead of "Updated.". Runs the real tool implementations against a temporary database.
// Usage: npm run build && node tests/task-tools.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'marion-task-tools-'));
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
  const { normalizeTaskTitle } = await import('../server/dist/agent/task-tools.js');
  const { hub } = await import('../server/dist/lib/hub.js');

  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', 1000);
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u2', 'b@example.com', 'B', 1000);
  const ada = createBotRecord('u1', { name: 'Ada' });
  const ben = createBotRecord('u1', { name: 'Ben' });
  const gone = createBotRecord('u1', { name: 'Gone' });
  db.prepare('UPDATE bots SET deleted_at=?, hidden=1 WHERE id=?').run(Date.now(), gone.id);
  const room = createBotRecord('u1', { name: 'Standup' });
  db.prepare("UPDATE bots SET kind='room' WHERE id=?").run(room.id);
  const helper = createBotRecord('u1', { name: 'Ben helper' });
  db.prepare('UPDATE bots SET hidden=1, parent_bot_id=? WHERE id=?').run(ben.id, helper.id);
  const stranger = createBotRecord('u2', { name: 'Stranger' });

  const events = [];
  hub.subscribe('u1', ev => { if (ev.type === 'tasks') events.push(ev.botId); });
  const ctx = (bot, userId = 'u1') => ({ userId, botId: bot.id, depth: 0, enqueueBotMessage: () => {} });
  const call = async (name, args, bot = ada, userId) => JSON.parse((await toolMap.get(name).impl(args, ctx(bot, userId))).output);
  const rows = (botId) => db.prepare('SELECT * FROM tasks WHERE bot_id=? ORDER BY created_at').all(botId);

  await test('schema and description stay in sync with the behaviour', () => {
    const schema = functionSchemas('u1', ada.id).find(t => t.name === 'create_task');
    assert.deepEqual(schema.parameters.required, ['title']);
    assert.equal(schema.parameters.properties.bot_name.type, 'string');
    assert.match(schema.description, /bot_name/);
    assert.match(schema.description, /duplicate/i);
    const update = functionSchemas('u1', ada.id).find(t => t.name === 'update_task');
    assert.deepEqual(update.parameters.properties.state.enum, ['working', 'needs_input', 'done']);
    assert.match(update.description, /another Bot/);
  });

  await test('create_task assigns to the calling Bot by default', async () => {
    events.length = 0;
    const r = await call('create_task', { title: 'Draft the Q3 report' });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.bot, 'Ada');
    assert.equal(rows(ada.id).length, 1);
    assert.equal(rows(ada.id)[0].id, r.task_id);
    assert.equal(rows(ada.id)[0].state, 'working');
    assert.deepEqual(events, [ada.id]);
  });

  await test('create_task assigns to another active Bot by name (case-insensitive, @ allowed)', async () => {
    events.length = 0;
    const r = await call('create_task', { title: 'Book flights', bot_name: '@ben' });
    assert.equal(r.created, true);
    assert.equal(r.bot, 'Ben');
    assert.equal(rows(ben.id).length, 1);
    assert.equal(rows(ada.id).length, 1, 'not also added to the caller');
    assert.deepEqual(events, [ben.id], 'the assignee\'s task list refreshes');
    assert.equal(rows(ben.id)[0].assigned_by, ada.id, 'storage records who assigned it');
    const { toTask } = await import('../server/dist/store.js');
    assert.equal(toTask(rows(ben.id)[0]).assignedBy, ada.id, 'API shape carries assignedBy');
    assert.equal(rows(ada.id)[0].assigned_by, null, 'a Bot\'s own task has no assigner');
    assert.ok(!('assignedBy' in toTask(rows(ada.id)[0])));
    const self = await call('create_task', { title: 'Self by name', bot_name: 'Ada' });
    assert.equal(self.created, true);
    assert.equal(rows(ada.id).length, 2);
  });

  await test('NEGATIVE: unknown, deleted, group-chat, foreign helper and other-user Bots are refused without a row', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
    for (const [name, error, pattern] of [
      ['Nobody', 'unknown_bot', /no active Bot named "Nobody".*Team: .*Ada.*Ben/],
      ['Gone', 'unknown_bot', /no active Bot named "Gone"/],
      ['Standup', 'not_assignable', /group chat/],
      ['Ben helper', 'not_assignable', /another Bot's helper/],
      ['Stranger', 'unknown_bot', /no active Bot named "Stranger"/],
    ]) {
      const r = await call('create_task', { title: 'Anything', bot_name: name });
      assert.equal(r.ok, false, name);
      assert.equal(r.error, error, name);
      assert.match(r.message, pattern, name);
      assert.ok(!('task_id' in r), `${name}: no task id is claimed`);
    }
    assert.doesNotMatch((await call('create_task', { title: 'x', bot_name: 'Nobody' })).message, /Gone|Stranger|Ben helper|Standup/, 'team list hides deleted, foreign, hidden and rooms');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, before);
    // Ben may assign to his own helper.
    const own = await call('create_task', { title: 'Helper job', bot_name: 'Ben helper' }, ben);
    assert.equal(own.created, true);
  });

  await test('NEGATIVE: an empty title makes no task', async () => {
    const before = rows(ada.id).length;
    for (const title of ['', '   ', undefined]) {
      const r = await call('create_task', { title });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'empty_title');
    }
    assert.equal(rows(ada.id).length, before);
  });

  await test('duplicate open task (same normalized title, same Bot) returns the existing task, no new row', async () => {
    assert.equal(normalizeTaskTitle('  Draft   the Q3 REPORT. '), 'draft the q3 report');
    const first = rows(ada.id).find(t => t.title === 'Draft the Q3 report');
    events.length = 0;
    const before = rows(ada.id).length;
    for (const title of ['Draft the Q3 report', '  draft THE   q3 report.', 'Ｄraft the Q3 report']) {
      const r = await call('create_task', { title });
      assert.equal(r.ok, true, title);
      assert.equal(r.created, false, title);
      assert.equal(r.duplicate, true, title);
      assert.equal(r.task_id, first.id, title);
      assert.match(r.message, /already have an open task/, title);
    }
    assert.equal(rows(ada.id).length, before);
    assert.deepEqual(events, [], 'no refresh event when nothing changed');
    // needs_input is still open: still a duplicate.
    db.prepare("UPDATE tasks SET state='needs_input' WHERE id=?").run(first.id);
    const waiting = await call('create_task', { title: 'draft the q3 report' });
    assert.equal(waiting.created, false);
    assert.equal(waiting.state, 'needs_input');
    // Assigned to someone else: says who already has it.
    const dupForBen = await call('create_task', { title: 'BOOK flights', bot_name: 'Ben' });
    assert.equal(dupForBen.created, false);
    assert.match(dupForBen.message, /Ben already has an open task "Book flights"/);
    assert.equal(rows(ben.id).length, 1);
  });

  await test('same title for a different Bot is not a duplicate', async () => {
    const r = await call('create_task', { title: 'Draft the Q3 report', bot_name: 'Ben' });
    assert.equal(r.created, true);
    assert.equal(rows(ben.id).filter(t => normalizeTaskTitle(t.title) === 'draft the q3 report').length, 1);
  });

  await test('a done task does not block creating the same task again', async () => {
    const first = rows(ada.id).find(t => t.title === 'Draft the Q3 report');
    const done = await call('update_task', { task_id: first.id, state: 'done' });
    assert.equal(done.ok, true);
    const again = await call('create_task', { title: 'Draft the Q3 report' });
    assert.equal(again.created, true);
    assert.notEqual(again.task_id, first.id);
    assert.equal(rows(ada.id).filter(t => t.title === 'Draft the Q3 report').length, 2);
    const dup = await call('create_task', { title: 'Draft the Q3 report' });
    assert.equal(dup.task_id, again.task_id, 'the new open one is now the duplicate target');
  });

  await test('update_task on an owned task updates it and reports the new state', async () => {
    const task = rows(ada.id).find(t => t.state === 'working');
    events.length = 0;
    const r = await call('update_task', { task_id: task.id, state: 'needs_input', note: 'Which quarter?' });
    assert.deepEqual(r, { ok: true, task_id: task.id, state: 'needs_input', previous_state: task.state });
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
    assert.equal(row.state, 'needs_input');
    assert.equal(row.note, 'Which quarter?');
    assert.deepEqual(events, [ada.id]);
  });

  await test('NEGATIVE: update_task on a missing task id says not found (not "Updated.")', async () => {
    events.length = 0;
    const out = (await toolMap.get('update_task').impl({ task_id: 'task_missing', state: 'done' }, ctx(ada))).output;
    assert.notEqual(out, 'Updated.');
    const r = JSON.parse(out);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_found');
    assert.match(r.message, /no task with id "task_missing"/);
    assert.deepEqual(events, [], 'no refresh event for a no-op');
  });

  await test('the Bot that assigned a task may update it; the event refreshes the assignee\'s list', async () => {
    const assigned = rows(ben.id).find(t => t.assigned_by === ada.id && t.state === 'working');
    events.length = 0;
    const r = await call('update_task', { task_id: assigned.id, state: 'done', note: 'Confirmed by Ben' });
    assert.equal(r.ok, true);
    assert.equal(r.previous_state, 'working');
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get(assigned.id).state, 'done');
    assert.deepEqual(events, [ben.id]);
    // and the assignee may too
    const back = await call('update_task', { task_id: assigned.id, state: 'working' }, ben);
    assert.equal(back.ok, true);
    assert.equal(back.previous_state, 'done');
  });

  await test('NEGATIVE: update_task on an unrelated Bot\'s task says who owns it and changes nothing', async () => {
    await call('create_task', { title: 'Ben\'s own errand' }, ben);
    const bens = rows(ben.id).find(t => !t.assigned_by);
    assert.ok(bens, 'Ben has a task Ada neither owns nor assigned');
    const r = await call('update_task', { task_id: bens.id, state: 'done', note: 'hijack' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_owner');
    assert.match(r.message, /belongs to Ben/);
    const after = db.prepare('SELECT * FROM tasks WHERE id=?').get(bens.id);
    assert.equal(after.state, bens.state);
    assert.equal(after.note, bens.note);
    assert.equal(after.updated_at, bens.updated_at);
  });

  await test('NEGATIVE: another user\'s task is reported as not found (nothing leaks)', async () => {
    db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES ('task_foreign',?,'Secret','working',1,1)").run(stranger.id);
    const r = await call('update_task', { task_id: 'task_foreign', state: 'done' });
    assert.equal(r.error, 'not_found');
    assert.doesNotMatch(r.message, /Stranger|Secret/);
    assert.equal(db.prepare("SELECT state FROM tasks WHERE id='task_foreign'").get().state, 'working');
  });

  await test('NEGATIVE: update_task with an invalid state or empty id changes nothing', async () => {
    const task = rows(ada.id)[0];
    const bad = await call('update_task', { task_id: task.id, state: 'finished' });
    assert.equal(bad.error, 'invalid_state');
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id).state, task.state);
    assert.equal((await call('update_task', { task_id: '', state: 'done' })).error, 'not_found');
  });

  await test('prompts, universal skill and UI stay in sync with assignment / duplicate / truthful-update behaviour', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    assert.match(read('server/src/agent/prompt.ts'), /create_task[^\n]*bot_name[^\n]*not duplicated[^\n]*update_task[^\n]*ok: true/);
    assert.match(read('server/src/features/universal-skills.ts'), /create_task[^\n]*bot_name[^\n]*update_task[^\n]*ok: true/);
    assert.match(read('server/src/features/templates.ts'), /create_task with bot_name per piece/);
    const view = read('web/src/components/config/TasksView.tsx');
    assert.match(view, /t\.assignedBy/); assert.match(view, /from \{assigner\.name\}/);
    assert.match(functionSchemas('u1', ada.id).find(t => t.name === 'update_task').description, /assigned to you, or one you assigned/);
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
