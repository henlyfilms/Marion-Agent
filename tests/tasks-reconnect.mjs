// Reconnect refresh: after the event stream drops and reconnects, every Tasks list (all tasks and each Bot's) refetches,
// so a stale list never lingers. The stream core runs on a fake EventSource; the wiring is checked in the source.
// Usage: node --import tsx tests/tasks-reconnect.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEventStream, invalidateTaskVersions, TASKS_RESYNC_KEY } from '../web/src/lib/eventStream.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

const CLOSED = 2;
function harness() {
  const sources = [];
  const timers = [];
  const log = { resyncs: 0, connected: [], events: [] };
  const stop = createEventStream({
    connect: () => { const s = { readyState: 0, onopen: null, onmessage: null, onerror: null, closed: false, close() { this.closed = true; } }; sources.push(s); return s; },
    onEvent: (data) => log.events.push(data),
    setConnected: (on) => log.connected.push(on),
    resync: () => { log.resyncs++; },
    closed: CLOSED,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  return { sources, timers, log, stop };
}

test('first connect does not resync; a reconnect after a dropped connection does', () => {
  const h = harness();
  h.sources[0].onopen();
  assert.equal(h.log.resyncs, 0);
  h.sources[0].readyState = CLOSED;
  h.sources[0].onerror();
  assert.deepEqual(h.log.connected, [true, false]);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 1000);
  h.timers.shift().fn();
  assert.equal(h.sources.length, 2, 'a new EventSource is opened');
  h.sources[1].onopen();
  assert.equal(h.log.resyncs, 1);
  h.stop();
  assert.equal(h.sources[1].closed, true);
});

test('the browser\'s own auto-retry (CONNECTING, not CLOSED) also resyncs when it reopens', () => {
  const h = harness();
  h.sources[0].onopen();
  h.sources[0].readyState = 0;
  h.sources[0].onerror();
  assert.equal(h.timers.length, 0, 'no manual reconnect while the browser retries');
  h.sources[0].onopen();
  assert.equal(h.log.resyncs, 1);
});

test('NEGATIVE: bad event JSON is ignored, good events pass through; nothing reconnects after stop', () => {
  const h = harness();
  const warn = console.warn; console.warn = () => {};
  try { h.sources[0].onmessage({ data: '{nope' }); } finally { console.warn = warn; }
  h.sources[0].onmessage({ data: '{"type":"tasks","botId":"b1"}' });
  assert.deepEqual(h.log.events, [{ type: 'tasks', botId: 'b1' }]);
  h.sources[0].readyState = CLOSED;
  h.sources[0].onerror();
  h.stop();
  assert.equal(h.timers.length, 0, 'pending reconnect cancelled');
});

test('backoff doubles to a 15 s cap and resets after a successful open', () => {
  const h = harness();
  const delays = [];
  for (let i = 0; i < 6; i++) {
    const s = h.sources.at(-1);
    s.readyState = CLOSED; s.onerror();
    const t = h.timers.shift(); delays.push(t.ms); t.fn();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
  h.sources.at(-1).onopen();
  h.sources.at(-1).readyState = CLOSED; h.sources.at(-1).onerror();
  assert.equal(h.timers[0].ms, 1000);
});

test('invalidateTaskVersions bumps the all-tasks list, every open per-Bot list and the resync key, and nothing else', () => {
  const before = { tasks: 3, 'tasks:b1': 1, 'tasks:b2': 7, 'memories:b1': 2, sessions: 4 };
  const after = invalidateTaskVersions(before);
  assert.deepEqual(after, { tasks: 4, 'tasks:b1': 2, 'tasks:b2': 8, 'memories:b1': 2, sessions: 4, [TASKS_RESYNC_KEY]: 1 });
  assert.equal(before.tasks, 3, 'input not mutated');
  assert.deepEqual(invalidateTaskVersions({}), { tasks: 1, [TASKS_RESYNC_KEY]: 1 }, 'works before any task view opened');
  assert.equal(invalidateTaskVersions(after)[TASKS_RESYNC_KEY], 2);
});

test('wiring: events.ts resyncs Tasks on reconnect; every Tasks list depends on the resync key', () => {
  const events = read('web/src/lib/events.ts');
  assert.match(events, /createEventStream\(/);
  assert.match(events, /resync:\s*resyncAfterReconnect/);
  assert.match(events, /export function resyncAfterReconnect\(\)[\s\S]*useConfigUI\.getState\(\)\.invalidateTasks\(\)/);
  const store = read('web/src/configStore.ts');
  assert.match(store, /invalidateTasks:\s*\(\)\s*=>\s*set\(\{\s*versions:\s*invalidateTaskVersions\(get\(\)\.versions\)/);
  const view = read('web/src/components/config/TasksView.tsx');
  assert.match(view, /useVersion\(TASKS_RESYNC_KEY\)/);
  assert.match(view, /\[botId, v, resynced\]/, 'the fetch effect re-runs when the resync key moves');
});

console.log(`\n${passed} passed`);
