// Update checks are not cached, and errors/reconnects cannot preserve a stale badge.
import assert from 'node:assert/strict';
import { updateAvailable, useAppUpdate } from '../web/src/lib/appUpdate.ts';

let behind = 1;
let offline = false;
let calls = 0;
globalThis.fetch = async (url, request) => {
  assert.match(url, /^\/api\/app\/update\?current=/);
  assert.equal(request.cache, 'no-store');
  calls++;
  if (offline) throw new Error('reconnecting');
  return Response.json({ supported: true, behind, install: { state: 'idle' } });
};
const check = () => useAppUpdate.getState().check();
const badge = () => updateAvailable(useAppUpdate.getState().status);

await Promise.all([check(), check()]);
assert.equal(calls, 1, 'initial and focus polling share a pending check');
assert.equal(badge(), true);
offline = true;
await check();
assert.equal(badge(), false, 'failed polling removes the stale availability signal');
offline = false;
behind = 0;
await check();
assert.equal(useAppUpdate.getState().status.behind, 0, 'the next check sees the new install');
assert.equal(badge(), false);
console.log('PASS: fresh polling clears stale availability on reconnect.');
