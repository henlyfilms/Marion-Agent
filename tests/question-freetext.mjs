// Question cards ("Pick an option or reply in your own words"): a reply typed in the composer must answer the waiting
// question exactly once, like an option click, and resolve the card. Also covers option clicks, Skip, Stop, stale cards,
// replies in a different chat, and that a typed reply can never approve an approval card. Gate 3 follow-ups: attachments
// on a free-text reply (and attachment preparation failing: the card stays pending, no turn), whitespace-only input,
// "stop" typed while idle, dictated replies, voice-call messages, group chats, and reload persistence.
// Offline and in-process: a stubbed model endpoint stands in for the model, no ports. Needs `npm run build` first.
// Usage: node tests/question-freetext.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

process.env.DB_PATH = join(tmpdir(), `marion-question-freetext-${process.pid}.db`);
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8799';
process.env.APP_URL = 'http://127.0.0.1:8799';
process.env.XAI_API_KEY = '';
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_LOCAL_MODEL_API_KEY = '';
process.env.MARION_LOCAL_MODEL = 'fake';

const QUESTION = 'Which worktree should I apply the fix to?';
const OPTIONS = ['rock-solid-batch', 'a new worktree'];
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
/** What each foreground model request was asked: the newest user line, and which bot asked. */
const requests = [];
const toolRuns = [];
const gates = new Map();
const aborted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url instanceof Request ? url.url : url);
  if (href.includes('api.github.com')) { toolRuns.push(href); return new Response('{}', { status: 500 }); }
  if (!href.startsWith('http://127.0.0.1:9/v1')) return realFetch(url, init);
  if (href.includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const body = JSON.parse(String(init.body));
  const input = body.input ?? [];
  const system = textOf(input[0]?.content);
  const who = /^You are ([^,]+), a Bot/.exec(system)?.[1];
  const respond = (item) => {
    const events = [
      ...(item.type === 'message' ? [{ type: 'response.output_text.delta', delta: item.content[0].text }] : []),
      { type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [item] } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const say = (text) => respond({ type: 'message', id: `m${Math.random()}`, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  const call = (name, args) => respond({ type: 'function_call', id: `fc${Math.random()}`, call_id: `call${Math.random()}`, name, arguments: JSON.stringify(args) });
  if (!who) return say('{"memories":[]}'); // background work (memories, titles, compaction)
  const last = input.at(-1);
  const user = textOf([...input].reverse().find(item => item.role === 'user')?.content);
  if (last?.type === 'function_call_output') return say('Waiting on you.');
  requests.push({ who, user });
  const line = user.split('\n').at(-1);
  const hold = /long job (\w+)/.exec(line);
  if (hold) {
    await new Promise((resolve, reject) => {
      gates.set(hold[1], resolve);
      init.signal?.addEventListener('abort', () => { aborted.push(hold[1]); reject(init.signal.reason ?? new Error('aborted')); });
    });
  }
  if (line === 'ask me') return call('ask_user', { question: QUESTION, options: OPTIONS });
  if (line === 'make repo') return call('github_create_repo', { name: 'demo', visibility: 'private', description: 'demo' });
  return say(`Done with: ${line}`);
};

await import('../server/dist/features/schema.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api, routeHooks } = await import('../server/dist/routes.js');
const { roomsApi } = await import('../server/dist/routes-rooms.js');
const { isBotBusy } = await import('../server/dist/agent/loop.js');
const { showQuestionCard } = await import('../server/dist/agent/work-feed.js');
const { getLive } = await import('../server/dist/store.js');
const { db } = await import('../server/dist/db.js');

const waitFor = async (check, message, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(typeof message === 'function' ? message() : message);
};
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
const passed = [];
const pass = (name) => { passed.push(name); console.log(`PASS ${name}`); };

try {
  const origin = 'http://127.0.0.1:8799';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'question@example.com' }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const { bots: [bot] } = await (await api.request(`${origin}/bots`, { headers })).json();
  const post = (path, body) => api.request(`${origin}${path}`, { method: 'POST', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const rows = async (id = bot.id) => (await (await api.request(`${origin}/bots/${id}/rows`, { headers })).json()).rows;
  const send = (text, id = bot.id) => post(`/bots/${id}/messages`, { text });
  const idle = (id = bot.id) => waitFor(() => !isBotBusy(id), 'the bot never went idle');
  const questions = async (id = bot.id) => (await rows(id)).filter(r => r.body.type === 'card' && r.body.card === 'question');
  const lastQuestion = async (id = bot.id) => (await questions(id)).at(-1);
  const answered = (id) => requests.filter(r => (!id || r.who === id) && r.user.includes(`[Answer to "${QUESTION}"]`));
  const ask = async (id = bot.id) => {
    const before = (await questions(id)).length;
    assert.equal((await send('ask me', id)).status, 200);
    await waitFor(async () => (await questions(id)).length === before + 1, 'the question card never appeared');
    await idle(id);
    const card = await lastQuestion(id);
    assert.equal(card.body.status, 'pending');
    return card;
  };

  // 1. A typed free-text reply answers the waiting question exactly once and resolves the card.
  {
    const card = await ask();
    assert.deepEqual(getLive(bot.id).awaiting?.reason, 'your answer', 'the bot should be waiting on the answer');
    const base = requests.length;
    const reply = 'Use rock-solid-batch, but only the server part';
    assert.equal((await send(reply)).status, 200);
    await waitFor(async () => (await rows()).some(r => r.body.role === 'assistant' && (r.body.text ?? '').endsWith(reply)), () => `the reply was never answered: ${JSON.stringify(requests.slice(base))}`);
    await idle(); await settle();
    const after = (await rows()).find(r => r.seq === card.seq);
    assert.equal(after.body.status, 'answered', 'a free-text reply must resolve the question card');
    assert.equal(after.body.answer, reply, 'the card records the typed reply');
    const turns = requests.slice(base);
    assert.equal(turns.length, 1, `exactly one turn for the reply (no stray parallel turn): ${JSON.stringify(turns)}`);
    assert.ok(turns[0].user.includes(`[Answer to "${QUESTION}"] ${reply}`), `the turn is delivered as the answer: ${turns[0].user}`);
    assert.equal((await rows()).filter(r => r.body.type === 'message' && r.body.role === 'user' && r.body.text === reply).length, 1, 'the reply is shown once');
    assert.equal(getLive(bot.id).awaiting, null, 'the bot is no longer waiting on the answer');
    // The next message is an ordinary message again.
    const base2 = requests.length;
    await send('thanks');
    await waitFor(() => requests.length === base2 + 1, 'follow-up never ran');
    await idle();
    assert.ok(!requests.at(-1).user.includes('[Answer to'), 'a later message must not be delivered as an answer again');
    pass('free-text reply reaches the waiting question exactly once and resolves the card');
  }

  // 2. Option clicks still answer; a second click on the same (now resolved) card is refused and delivers nothing.
  {
    const card = await ask();
    const base = requests.length;
    assert.equal((await post(`/bots/${bot.id}/cards/${card.seq}/answer`, { answer: OPTIONS[0] })).status, 200);
    await waitFor(() => requests.length === base + 1, 'the option click was never delivered');
    await idle();
    assert.ok(requests.at(-1).user.includes(`[Answer to "${QUESTION}"] ${OPTIONS[0]}`));
    assert.equal((await lastQuestion()).body.status, 'answered');
    assert.equal((await lastQuestion()).body.answer, OPTIONS[0]);
    const again = await post(`/bots/${bot.id}/cards/${card.seq}/answer`, { answer: OPTIONS[1] });
    assert.equal(again.status, 409, 'a resolved card cannot be answered twice');
    const text = await post(`/bots/${bot.id}/messages`, { text: 'unrelated' });
    assert.equal(text.status, 200);
    await waitFor(() => requests.length === base + 2, 'follow-up never ran');
    await idle(); await settle();
    assert.equal(requests.length, base + 2, 'the second click must not deliver another answer');
    assert.ok(!requests.at(-1).user.includes('[Answer to'), 'a message after an option click is not an answer');
    assert.equal((await lastQuestion()).body.answer, OPTIONS[0], 'the chosen option is kept');
    pass('option clicks resolve the question once; repeat clicks are refused');
  }

  // 3a. Skip: the card is dismissed, nothing is sent to the model, and the next message is not an answer.
  {
    const card = await ask();
    const base = requests.length;
    assert.equal((await post(`/bots/${bot.id}/cards/${card.seq}/dismiss`)).status, 200);
    await settle();
    assert.equal(requests.length, base, 'skipping sends nothing to the model');
    assert.equal((await lastQuestion()).body.status, 'dismissed');
    assert.equal((await post(`/bots/${bot.id}/cards/${card.seq}/answer`, { answer: OPTIONS[0] })).status, 409, 'a skipped card cannot be answered');
    await send('something else');
    await waitFor(() => requests.length === base + 1, 'follow-up never ran');
    await idle();
    assert.ok(!requests.at(-1).user.includes('[Answer to'), 'a message after Skip is not an answer');
    assert.equal((await lastQuestion()).body.status, 'dismissed');
    pass('Skip dismisses the question; later messages are not answers');
  }

  // 3b. Stop: the Stop button leaves the question answerable; a typed "Stop." while busy stops and is not an answer.
  {
    const card = await ask();
    assert.equal((await post(`/bots/${bot.id}/interrupt`)).status, 200);
    assert.equal((await lastQuestion()).body.status, 'pending', 'the Stop button leaves the question open');
    const base = requests.length;
    assert.equal((await send('long job S')).status, 200); // answers the question, then runs long
    await waitFor(() => gates.has('S'), 'long job never started');
    assert.equal((await questions()).find(r => r.seq === card.seq).body.status, 'answered');
    // A relayed CLI asks a question while the turn is still running; the owner types "Stop."
    showQuestionCard(bot.id, db.prepare('SELECT user_id FROM bots WHERE id=?').get(bot.id).user_id, QUESTION, OPTIONS);
    const relayed = await lastQuestion();
    assert.equal((await send('Stop.')).status, 200);
    await idle(); await settle();
    assert.deepEqual(aborted, ['S'], 'a typed stop still aborts the running work');
    assert.equal(requests.length, base + 1, 'a stop starts no new turn');
    assert.equal((await rows()).filter(r => /^Stopped\./.test(r.body.text ?? '')).length, 1, 'the stop is acknowledged once');
    assert.equal((await questions()).find(r => r.seq === relayed.seq).body.status, 'pending', 'a stop is not taken as the answer');
    assert.equal((await post(`/bots/${bot.id}/cards/${relayed.seq}/dismiss`)).status, 200);
    pass('Stop still works and is never taken as an answer');
  }

  // 3c. QA gate 3b: a typed reply cannot revive a stopped action. The action asks a question while running, the owner
  // presses Stop, then types a reply: the reply is delivered once as an ordinary answer turn; the stopped action is never
  // re-sent to the model, never auto-resumed ([Interrupted work]), and stays aborted.
  {
    const jobRuns = () => requests.filter(r => r.user.split('\n').at(-1) === 'long job R').length;
    assert.equal((await send('long job R')).status, 200);
    await waitFor(() => gates.has('R'), 'long job R never started');
    showQuestionCard(bot.id, db.prepare('SELECT user_id FROM bots WHERE id=?').get(bot.id).user_id, QUESTION, OPTIONS);
    const waiting = await lastQuestion();
    assert.equal((await post(`/bots/${bot.id}/interrupt`)).status, 200);
    await idle(); await settle();
    assert.deepEqual(aborted.filter(id => id === 'R'), ['R'], 'Stop aborted the running action');
    assert.equal(jobRuns(), 1);
    const base = requests.length;
    const reply = 'Go with a new worktree';
    assert.equal((await send(reply)).status, 200);
    await waitFor(() => requests.length >= base + 1, 'the typed reply never ran');
    await idle();
    // Longer than the auto-resume delay (3 s), so a resume of the stopped action would have fired by now.
    await new Promise(resolve => setTimeout(resolve, 3500));
    const turns = requests.slice(base);
    assert.equal(turns.length, 1, `exactly one turn for the reply, no revived action: ${JSON.stringify(turns)}`);
    assert.ok(turns[0].user.endsWith(reply), 'the turn is the typed reply');
    assert.equal(jobRuns(), 1, 'the stopped action was never sent to the model again');
    assert.ok(!requests.some(r => r.user.includes('[Interrupted work]')), 'the stopped action was never auto-resumed');
    assert.deepEqual(aborted.filter(id => id === 'R'), ['R'], 'the stopped action stays stopped');
    assert.equal((await questions()).find(r => r.seq === waiting.seq).body.status, 'answered', 'the reply answers the waiting question once');
    pass('a typed reply cannot revive a stopped action');
  }

  // 4. Stale cards and other chats: a card from an earlier conversation, or a reply in another chat, never resolves it.
  {
    const card = await ask();
    assert.equal((await post(`/bots/${bot.id}/fresh`)).status, 200);
    const base = requests.length;
    const stale = await post(`/bots/${bot.id}/cards/${card.seq}/answer`, { answer: OPTIONS[0] });
    assert.ok(stale.status >= 400, 'a card from a cleared conversation cannot be answered');
    await send('new topic');
    await waitFor(() => requests.length === base + 1, 'follow-up never ran');
    await idle();
    assert.ok(!requests.at(-1).user.includes('[Answer to'), 'a message after a fresh start is not an answer to an old card');

    const other = (await (await post('/bots', { name: 'Second', job: 'Helps', description: 'Helps.', instructions: 'Help.' })).json()).bot;
    assert.ok(other?.id, 'second chat created');
    const waiting = await ask();
    const base2 = requests.length;
    await send('reply meant for another chat', other.id);
    await waitFor(() => requests.length === base2 + 1, 'the other chat never ran');
    await idle(other.id); await settle();
    assert.ok(!requests.at(-1).user.includes('[Answer to'), 'a message in another chat is not an answer');
    assert.equal(requests.at(-1).who, 'Second');
    assert.equal((await questions()).find(r => r.seq === waiting.seq).body.status, 'pending', 'another chat must not resolve this question');
    const cross = await post(`/bots/${other.id}/cards/${waiting.seq}/answer`, { answer: OPTIONS[0] });
    assert.ok(cross.status >= 400, 'a card cannot be answered through another chat');
    assert.equal((await questions()).find(r => r.seq === waiting.seq).body.status, 'pending');
    assert.equal(requests.length, base2 + 1, 'nothing was delivered to the waiting chat');
    assert.equal((await post(`/bots/${bot.id}/cards/${waiting.seq}/dismiss`)).status, 200);
    pass('stale cards and replies in another chat never resolve a waiting question');
  }

  // 5. A typed reply can never approve an approval card, even when it answers a question at the same time.
  {
    const base = requests.length;
    await send('make repo');
    await waitFor(async () => (await rows()).some(r => r.body.card === 'approval' && r.body.status === 'pending'), 'the approval card never appeared');
    await idle();
    const approval = (await rows()).find(r => r.body.card === 'approval' && r.body.status === 'pending');
    const userId = db.prepare('SELECT user_id FROM bots WHERE id=?').get(bot.id).user_id;
    showQuestionCard(bot.id, userId, 'Approve creating the repository?', ['Approve', "Don't approve"]);
    const q = await lastQuestion();
    await send('Approve');
    await waitFor(() => requests.length === base + 2, 'the typed reply never ran');
    await idle(); await settle();
    const ap = db.prepare('SELECT status FROM approvals WHERE id=?').get(approval.body.approvalId);
    assert.ok(!['allowed', 'always'].includes(ap.status), `a typed reply must not approve: ${ap.status}`);
    const card = (await rows()).find(r => r.seq === approval.seq);
    assert.ok(!['allowed', 'always'].includes(card.body.status), 'the approval card is not approved');
    assert.equal(toolRuns.length, 0, 'the approval-gated tool never ran');
    assert.equal((await questions()).find(r => r.seq === q.seq).body.status, 'answered', 'only the question was answered');
    pass('free-text replies cannot bypass approvals');
  }

  // 6. Gate 3 follow-ups, on fresh chats (nothing pending from the sections above).
  {
    const make = async (name) => (await (await post('/bots', { name, job: 'Helps', description: 'Helps.', instructions: 'Help.' })).json()).bot;
    const third = await make('Third');
    const fourth = await make('Fourth');
    const cookieOnly = { cookie: headers.cookie };
    const sendForm = (id, text, files) => {
      const form = new FormData();
      form.set('text', text);
      for (const [name, body, type] of files) form.append('attachments', new Blob([body], { type }), name);
      return api.request(`${origin}/bots/${id}/messages`, { method: 'POST', headers: cookieOnly, body: form });
    };

    // a) Attachments on a free-text reply: the reply answers the card once, keeps the attachment, one turn.
    {
      const card = await ask(third.id);
      const base = requests.length;
      const res = await sendForm(third.id, 'rock-solid-batch, see the notes', [['notes.txt', 'apply to server only', 'text/plain']]);
      assert.equal(res.status, 200, await res.clone().text());
      await waitFor(() => requests.length === base + 1, 'the attachment reply never ran');
      await idle(third.id); await settle();
      const after = (await questions(third.id)).find(r => r.seq === card.seq);
      assert.equal(after.body.status, 'answered');
      assert.equal(after.body.answer, 'rock-solid-batch, see the notes');
      assert.ok(requests.at(-1).user.includes(`[Answer to "${QUESTION}"] rock-solid-batch, see the notes`), requests.at(-1).user);
      const msg = (await rows(third.id)).find(r => r.body.type === 'message' && r.body.text === 'rock-solid-batch, see the notes');
      assert.equal(msg?.body.attachments?.[0]?.name, 'notes.txt', 'the attachment is kept on the reply');
      pass('a free-text reply with an attachment answers the card once and keeps the attachment');
    }

    // b) Attachment preparation throws: the card is NOT left answered with no turn queued.
    {
      const card = await ask(third.id);
      const base = requests.length;
      const real = routeHooks.forModel;
      routeHooks.forModel = async () => { throw new Error('frames failed'); };
      try {
        const res = await sendForm(third.id, 'rock-solid-batch', [['notes.txt', 'x', 'text/plain']]);
        assert.ok(res.status >= 500, `attachment failure surfaces as an error (${res.status})`);
      } finally { routeHooks.forModel = real; }
      await settle(); await idle(third.id);
      assert.equal(requests.length, base, 'no turn was queued');
      assert.equal((await questions(third.id)).find(r => r.seq === card.seq).body.status, 'pending', 'the card stays pending after an attachment error');
      // A retry then answers it normally.
      assert.equal((await send('rock-solid-batch', third.id)).status, 200);
      await waitFor(() => requests.length === base + 1, 'the retry never ran');
      await idle(third.id);
      assert.equal((await questions(third.id)).find(r => r.seq === card.seq).body.status, 'answered');
      pass('an attachment error never leaves the question card answered with no turn queued');
    }

    // c) Whitespace-only input: rejected, the card stays pending, no turn.
    {
      const card = await ask(third.id);
      const base = requests.length;
      for (const blank of ['   ', '\n\t ']) assert.equal((await send(blank, third.id)).status, 400, 'whitespace-only is empty');
      assert.equal((await post(`/bots/${third.id}/cards/${card.seq}/answer`, { answer: '   ' })).status, 400, 'a blank option answer is refused');
      await settle();
      assert.equal(requests.length, base);
      assert.equal((await questions(third.id)).find(r => r.seq === card.seq).body.status, 'pending');
      pass('whitespace-only input never answers a question card');

      // d) "stop" typed while idle: never an answer, no turn; the card stays pending.
      assert.equal(isBotBusy(third.id), false, 'idle');
      for (const word of ['stop', 'Stop.']) assert.equal((await send(word, third.id)).status, 200);
      await settle(); await idle(third.id);
      assert.equal(requests.length, base, 'an idle stop starts no turn');
      const still = (await questions(third.id)).find(r => r.seq === card.seq);
      assert.equal(still.body.status, 'pending', 'an idle "stop" does not answer the open question card');
      pass('"stop" typed while idle does not answer an open question card');

      // e) Dictation: a dictated reply (capitalised, punctuated) is a typed reply and answers the card once.
      const dictated = 'Rock-solid-batch, please.';
      assert.equal((await send(dictated, third.id)).status, 200);
      await waitFor(() => requests.length === base + 1, 'the dictated reply never ran');
      await idle(third.id); await settle();
      const done = (await questions(third.id)).find(r => r.seq === card.seq);
      assert.equal(done.body.status, 'answered');
      assert.equal(done.body.answer, dictated);
      assert.equal(answered(third.name).length >= 1, true);
      pass('a dictated reply answers the waiting question once');
    }

    // f) A voice-call message is not a typed answer: the card stays pending.
    {
      const card = await ask(third.id);
      const res = await post(`/bots/${third.id}/messages`, { text: 'rock-solid-batch', call: 'gate3-call' });
      assert.equal(res.status, 200, await res.clone().text());
      await settle(); await idle(third.id); await settle();
      const after = (await questions(third.id)).find(r => r.seq === card.seq);
      assert.equal(after.body.status, 'pending', 'a voice-call message does not answer the card');
      assert.ok(!requests.filter(r => r.who === 'Third').at(-1).user.includes('[Answer to'), 'the voice turn is not an answer');
      assert.equal((await post(`/bots/${third.id}/cards/${card.seq}/dismiss`)).status, 200);
      pass('voice-call messages do not answer a question card');
    }

    // g) Group chats are excluded: a message in a group never answers a question card (the group's or a member's).
    {
      const room = await (await roomsApi.request(`${origin}/`, { method: 'POST', headers, body: JSON.stringify({ name: 'Gate 3 group', botIds: [third.id, fourth.id] }) })).json();
      assert.ok(room.id, `group created: ${JSON.stringify(room)}`);
      const memberCard = await ask(fourth.id);
      const userId = db.prepare('SELECT user_id FROM bots WHERE id=?').get(third.id).user_id;
      showQuestionCard(room.id, userId, QUESTION, OPTIONS);
      const roomCard = await lastQuestion(room.id);
      assert.equal(roomCard.body.status, 'pending');
      assert.equal((await send('rock-solid-batch', room.id)).status, 200);
      await settle(); await idle(third.id); await idle(fourth.id); await settle();
      assert.equal((await questions(room.id)).find(r => r.seq === roomCard.seq).body.status, 'pending', 'a group message does not answer the group card');
      assert.equal((await questions(fourth.id)).find(r => r.seq === memberCard.seq).body.status, 'pending', "a group message does not answer a member's card");
      pass('group-chat messages never answer a question card');

      // h) Reload persistence: the answered state and the answer survive a fresh read (GET rows and the DB row).
      const base = requests.length;
      assert.equal((await send('a new worktree', fourth.id)).status, 200);
      await waitFor(() => requests.length > base, 'the reply never ran');
      await idle(fourth.id); await settle();
      const reloaded = (await (await api.request(`${origin}/bots/${fourth.id}/rows`, { headers })).json()).rows.find(r => r.seq === memberCard.seq);
      assert.equal(reloaded.body.status, 'answered');
      assert.equal(reloaded.body.answer, 'a new worktree');
      const stored = JSON.parse(db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(fourth.id, memberCard.seq).body);
      assert.equal(stored.status, 'answered', 'persisted in the database');
      assert.equal((await post(`/bots/${fourth.id}/cards/${memberCard.seq}/answer`, { answer: OPTIONS[0] })).status, 409, 'still answered after reload');
      assert.equal((await rows(fourth.id)).filter(r => r.body.type === 'message' && r.body.role === 'user' && r.body.text === 'a new worktree').length, 1);
      pass('an answered question card stays answered after a reload');
    }
  }

  console.log(`\nAll ${passed.length} question-card checks passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const release of gates.values()) release();
  globalThis.fetch = realFetch;
  await rm(process.env.DB_PATH, { force: true });
  process.exit(process.exitCode ?? 0);
}
