// The desktop app's server host: the server is detached, re-adopted after the app quits, and replaced by a newer
// build only while idle. Uses a fake "node" program and a stubbed health endpoint, so it needs no open port and
// no Electron. Usage: node tests/server-host.mjs
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServerHost } = require('../Marion Agent Installer/payload/Resources/app/server-host.cjs');

const root = mkdtempSync(join(tmpdir(), 'marion-host-'));
const dataDir = join(root, 'data');
const resources = join(root, 'Resources');
const appDir = join(resources, 'app');
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(resources, 'marion', 'server', 'dist'), { recursive: true });
mkdirSync(join(resources, 'runtime'), { recursive: true });
mkdirSync(appDir, { recursive: true });
writeFileSync(join(resources, 'marion', 'server', 'dist', 'index.js'), '// server');
writeFileSync(join(appDir, 'server.cjs'), '// entry');
// A stand-in "node": records its pid and the build/owner it was given, then just waits like a server would.
const fakeNode = join(resources, 'runtime', 'node');
writeFileSync(fakeNode, `#!/bin/sh\necho $$ > "${dataDir}/fake.pid"\necho "$MARION_BUILD_ID $MARION_OWNER_PID $MARION_DESKTOP_TOKEN $MARION_DESKTOP_INSTANCE" > "${dataDir}/fake.env"\nexec sleep 120\n`);
chmodSync(fakeNode, 0o755);

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = () => Number(readFileSync(join(dataDir, 'fake.pid'), 'utf8'));
const origin = 'http://127.0.0.1:1';
let busy = 0;
let attached = [];
/** Stands in for the server's /api/health and /api/desktop/attach. */
globalThis.fetch = async (url, init) => {
  if (!existsSync(join(dataDir, 'fake.pid')) || !alive(pidOf())) throw new Error('connection refused');
  const [build, , token, instance] = readFileSync(join(dataDir, 'fake.env'), 'utf8').trim().split(' ');
  if (init.headers['x-marion-desktop-session'] !== token) return new Response('Forbidden', { status: 403 });
  if (String(url).endsWith('/api/desktop/attach')) { attached.push(JSON.parse(init.body).pid); return Response.json({ ok: true, busy }); }
  return Response.json({ ok: true, app: 'marion-agent', desktopInstance: instance, build, busy, pid: pidOf() });
};

const make = (buildId, ownerPid) => createServerHost({ dataDir, resources, appDir, host: '127.0.0.1', port: 1, origin, accessHeader: 'x-marion-desktop-session', buildId, ownerPid });
const stopFake = () => { if (existsSync(join(dataDir, 'fake.pid'))) try { process.kill(pidOf(), 'SIGKILL'); } catch { /* gone */ } };

try {
  // 1. First launch starts a detached server from a copy of the server files and remembers its token.
  const first = make('build-1', 1001);
  const started = await first.ensure();
  assert.equal(started.adopted, false);
  assert.ok(alive(pidOf()), 'server is running');
  assert.ok(existsSync(join(dataDir, 'server-runtime', 'build-1', 'marion', 'server', 'dist', 'index.js')), 'server files copied next to the app data');
  assert.ok(existsSync(join(dataDir, 'server-runtime', 'build-1', 'node')));
  const session = JSON.parse(readFileSync(join(dataDir, 'server-session.json'), 'utf8'));
  assert.equal(session.token, started.token);
  assert.equal(session.pid, pidOf());
  const serverPid = pidOf();
  console.log('PASS: the server starts detached from a copy of its files and its session is saved.');

  // 2. The app quits (nothing is told to stop). A new launch of the SAME build re-adopts the same server.
  const second = make('build-1', 1002);
  const adopted = await second.ensure();
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.token, started.token);
  assert.equal(pidOf(), serverPid, 'no new server was started');
  assert.deepEqual(attached, [1002], 'the new app became the owner');
  console.log('PASS: after the app quits and reopens, the running server is re-adopted untouched.');

  // 3. An update: the new build finds the old server busy and leaves it alone (bots keep running)...
  busy = 2;
  const third = make('build-2', 1003);
  const during = await third.ensure();
  assert.equal(during.adopted, true);
  assert.equal(pidOf(), serverPid, 'a busy server is never replaced');
  assert.ok(alive(serverPid));
  let reloaded = 0;
  third.watch(() => { reloaded++; });
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(reloaded, 0);
  assert.ok(alive(serverPid), 'still running while busy');
  console.log('PASS: an update does not interrupt a server that is busy.');

  // ...and swaps it for the new build as soon as it is idle, then asks the window to reload.
  busy = 0;
  await new Promise(resolve => setTimeout(resolve, 9000));
  assert.equal(reloaded, 1, 'window reloads once');
  assert.notEqual(pidOf(), serverPid, 'a new server took over');
  assert.ok(!alive(serverPid), 'the old server is gone');
  assert.match(readFileSync(join(dataDir, 'fake.env'), 'utf8'), /^build-2 1003 /);
  assert.ok(existsSync(join(dataDir, 'server-runtime', 'build-2')) && !existsSync(join(dataDir, 'server-runtime', 'build-1')), 'old copy cleaned up');
  console.log('PASS: once idle, the new build\'s server replaces it and the window is told to reload.');

  // 4. Deliberate "Quit and Stop Background Work" ends the server and forgets the session.
  await third.stop();
  assert.ok(!alive(pidOf()));
  assert.ok(!existsSync(join(dataDir, 'server-session.json')));
  console.log('PASS: Quit and Stop Background Work ends the server.');

  // 5. A stale session whose pid is not our server is never signalled.
  writeFileSync(join(dataDir, 'server-session.json'), JSON.stringify({ token: 'x', instanceId: 'y', pid: process.pid, build: 'old' }));
  const fresh = make('build-3', 1004);
  const recovered = await fresh.ensure();
  assert.equal(recovered.adopted, false);
  assert.ok(alive(process.pid), 'this test process was not signalled');
  await fresh.stop();
  console.log('PASS: a stale session never causes an unrelated process to be signalled.');
} finally {
  stopFake();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
