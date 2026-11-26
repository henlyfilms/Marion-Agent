// Per-bot computers start, stop and report independently: one bot's slow start never holds up another bot's computer
// (background tasks use several in parallel), two starts of the same bot create one container, and a failed start of one bot
// does not mark the others broken. Uses a fake `docker` on PATH; no real Docker, no ports. Needs `npm run build` first.
// Usage: node tests/computer-parallel.mjs
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'marion-computer-'));
const state = join(dir, 'state');
await mkdir(state);
await writeFile(join(dir, 'docker'), `#!/bin/bash
S='${state}'
echo "$@" >> "$S/log"
last="\${@: -1}"
case "$1" in
  info) echo 27;;
  context) echo desktop;;
  image|network) exit 0;;
  container)
    if [ -f "$S/$last.up" ]; then echo true; elif [ -f "$S/$last.made" ]; then echo false; else echo "Error: No such object: $last" >&2; exit 1; fi;;
  run)
    n=""; prev=""; for a in "$@"; do [ "$prev" = "--name" ] && n="$a"; prev="$a"; done
    [ -f "$S/slow.$n" ] && sleep 1.5
    [ -f "$S/broken.$n" ] && { echo "boom: cannot create container" >&2; exit 1; }
    touch "$S/$n.up" "$S/$n.made";;
  start) touch "$S/$2.up";;
  stop) rm -f "$S/$last.up";;
  exec) echo "1280 800";;
esac
`);
await chmod(join(dir, 'docker'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.DB_PATH = join(dir, 'test.db');
process.env.MARION_NO_SCHEDULER = '1';
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.SERVER_URL = 'http://127.0.0.1:8796';
process.env.APP_URL = 'http://127.0.0.1:8796';

await import('../server/dist/features/schema.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/dist/routes.js');
const { screenFor, computerState, suspendComputer, refreshComputer } = await import('../server/dist/computer.js');
const { db } = await import('../server/dist/db.js');

try {
  const origin = 'http://127.0.0.1:8796';
  const login = await api.request(`${origin}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'computers@example.com' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const make = async (name) => (await (await api.request(`${origin}/bots`, { method: 'POST', headers, body: JSON.stringify({ name }) })).json()).bot.id;
  const slow = await make('Slow'), fast = await make('Fast'), bad = await make('Bad');
  const { user_id: userId } = db.prepare('SELECT user_id FROM bots WHERE id=?').get(slow);
  const box = (id) => `marion-desktop-${id}`;
  await writeFile(join(state, `slow.${box(slow)}`), '');
  await writeFile(join(state, `broken.${box(bad)}`), '');
  const log = async () => (await readFile(join(state, 'log'), 'utf8')).split('\n');

  // 1. A slow start does not block another bot's computer.
  const t0 = Date.now();
  let fastDone = 0, slowDone = 0;
  const a = screenFor(userId, slow).then(() => { slowDone = Date.now() - t0; });
  const b = screenFor(userId, fast).then(() => { fastDone = Date.now() - t0; });
  await Promise.all([a, b]);
  assert.ok(slowDone >= 1400, `the slow computer really was slow (${slowDone} ms)`);
  assert.ok(fastDone < slowDone - 700, `the fast bot's computer must not wait for the slow one (${fastDone} vs ${slowDone} ms)`);
  assert.deepEqual(computerState(userId).screens.filter(s => s.running).map(s => s.botId).sort(), [slow, fast].sort());
  assert.equal(computerState(userId).status, 'running');

  // 2. Waking the same computer twice at once makes one container.
  const again = [...await log()].filter(l => l.startsWith('run ') && l.includes(box(fast))).length;
  await Promise.all([screenFor(userId, fast), screenFor(userId, fast), screenFor(userId, fast)]);
  assert.equal((await log()).filter(l => l.startsWith('run ') && l.includes(box(fast))).length, again, 'an awake computer is never started again');

  // 3. One bot failing to start leaves the others (and the overall status) healthy.
  await assert.rejects(screenFor(userId, bad), /boom|could not|failed|Docker/i);
  assert.equal(computerState(userId).status, 'running', 'a failed bot must not mark running computers as broken');
  assert.equal(computerState(userId).screens.find(s => s.botId === fast)?.running, true);

  // 4. A container that died is noticed and revived on the next use.
  await rm(join(state, `${box(fast)}.up`));
  assert.equal((await refreshComputer(userId)).screens.find(s => s.botId === fast)?.running, false);
  await screenFor(userId, fast);
  assert.equal(computerState(userId).screens.find(s => s.botId === fast)?.running, true, 'a stopped computer wakes again');

  // 5. Suspending stops every computer.
  await suspendComputer(userId);
  assert.equal(computerState(userId).status, 'suspended');
  assert.ok(computerState(userId).screens.every(s => !s.running));
  console.log('PASS: bot computers start/stop independently and in parallel, no duplicate containers, failures stay isolated, dead containers revive, suspend stops all.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
