// Starts, adopts and replaces Marion Agent's local server so it OUTLIVES the app window, the app, and app updates.
//
//  - The server runs detached (its own session, output in server.log). Quitting, force-quitting or replacing the
//    app does not touch it, so running bots and Claude/Codex/Gemini relays keep going.
//  - The app writes server-session.json (token, instance, pid, build). The next app launch reads it and re-adopts the
//    running server with the same token: nothing restarts, the window just reconnects.
//  - The server runs from a copy of the app's server files (server-runtime/<build>), so replacing Marion Agent.app
//    during an update cannot pull files out from under a server that is still busy.
//  - A server from an older build is replaced only when nothing is running (health.busy === 0), then the window reloads.
//  - A server whose app is gone exits by itself once it has been idle for a minute (server/src/lib/lifecycle.ts).
//
// No Electron imports on purpose: this file is plain Node so its pieces can be tested.
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_FILE = 'server-session.json';
const RUNTIME_DIR = 'server-runtime';
const MAX_LOG = 5 * 1024 * 1024;

const safe = value => String(value).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'build';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createServerHost(options) {
  const { dataDir, resources, appDir, host, port, origin, accessHeader, buildId, ownerPid, baseEnvironment = () => ({}), environment = () => ({}) } = options;
  const sessionPath = path.join(dataDir, SESSION_FILE);
  const runtimeRoot = path.join(dataDir, RUNTIME_DIR);
  const state = { token: '', instanceId: '', pid: 0, build: '', runtime: '', adopted: false };
  let watcher;
  let replacing = false;

  const readSession = () => {
    try {
      const value = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      return value && typeof value.token === 'string' && typeof value.instanceId === 'string' && Number.isInteger(value.pid) ? value : null;
    } catch { return null; }
  };
  const writeSession = () => {
    const temp = `${sessionPath}.${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({ token: state.token, instanceId: state.instanceId, pid: state.pid, build: state.build, runtime: state.runtime, at: Date.now() }), { mode: 0o600 });
    fs.renameSync(temp, sessionPath);
  };

  async function health(token, timeout = 800) {
    try {
      const response = await fetch(`${origin}/api/health`, { headers: { [accessHeader]: token }, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) return null;
      const body = await response.json();
      return body?.app === 'marion-agent' ? body : null;
    } catch { return null; }
  }

  /** Copy the server files next to the app data (instant on APFS: files are cloned, not duplicated). Falls back to running in place. */
  function prepareRuntime() {
    const inPlace = {
      dir: '',
      node: path.join(resources, 'runtime', 'node'),
      backend: path.join(resources, 'marion', 'server'),
      entry: path.join(appDir, 'server.cjs'),
    };
    const dir = path.join(runtimeRoot, safe(buildId));
    const ready = { dir, node: path.join(dir, 'node'), backend: path.join(dir, 'marion', 'server'), entry: path.join(dir, 'server.cjs') };
    try {
      if (fs.existsSync(path.join(dir, '.ready'))) return ready;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const mode = fs.constants.COPYFILE_FICLONE;
      fs.cpSync(path.join(resources, 'marion'), path.join(dir, 'marion'), { recursive: true, mode, verbatimSymlinks: true });
      fs.copyFileSync(inPlace.node, ready.node, mode);
      fs.chmodSync(ready.node, 0o755);
      fs.copyFileSync(inPlace.entry, ready.entry, mode);
      fs.writeFileSync(path.join(dir, '.ready'), buildId);
      return ready;
    } catch (error) {
      console.warn('[server-host] could not copy the server files; running them from the app instead:', error.message);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      return inPlace;
    }
  }

  function pruneRuntimes(...keep) {
    try {
      const keepNames = new Set(keep.filter(Boolean).map(dir => path.basename(dir)));
      for (const name of fs.readdirSync(runtimeRoot)) {
        if (!keepNames.has(name)) fs.rmSync(path.join(runtimeRoot, name), { recursive: true, force: true });
      }
    } catch { /* nothing to prune */ }
  }

  function openLog() {
    const file = path.join(dataDir, 'server.log');
    try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    return fs.openSync(file, 'a', 0o600);
  }

  async function launch() {
    const token = randomBytes(32).toString('base64url');
    const instanceId = randomBytes(16).toString('hex');
    const runtime = prepareRuntime();
    const log = openLog();
    let exited = false;
    const child = spawn(runtime.node, [`--env-file-if-exists=${path.join(dataDir, '.env')}`, runtime.entry], {
      cwd: runtime.backend,
      env: {
        ...baseEnvironment(),
        ...process.env,
        ...environment(),
        HOST: host, PORT: String(port), SERVER_URL: origin, APP_URL: origin,
        MARION_DESKTOP_TOKEN: token, MARION_DESKTOP_INSTANCE: instanceId, MARION_APP_DATA: dataDir,
        MARION_BUILD_ID: buildId, MARION_OWNER_PID: String(ownerPid),
      },
      detached: true,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    child.once('error', () => { exited = true; });
    child.once('exit', () => { exited = true; });
    child.unref();
    for (let attempt = 0; attempt < 75 && !exited; attempt++) {
      const body = await health(token, 300);
      if (body && body.desktopInstance === instanceId) {
        Object.assign(state, { token, instanceId, pid: body.pid || child.pid, build: buildId, runtime: runtime.dir, adopted: false });
        writeSession();
        pruneRuntimes(runtime.dir);
        return true;
      }
      await sleep(200);
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    return false;
  }

  async function attach() {
    try {
      await fetch(`${origin}/api/desktop/attach`, {
        method: 'POST', headers: { [accessHeader]: state.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: ownerPid }), signal: AbortSignal.timeout(1500),
      });
    } catch { /* the server keeps its previous owner; the app still works */ }
  }

  /**
   * Ask the server to agree to being replaced. It answers in one step ("nothing is running, and from now on I take no
   * new work"), so a turn can't start between our check and the stop. 'busy' means leave it alone; 'unsupported' is an
   * older server without this call (the idle check from /api/health is all there is for those).
   */
  async function retire(session) {
    try {
      const response = await fetch(`${origin}/api/desktop/retire`, {
        method: 'POST', headers: { [accessHeader]: session.token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return 'ok';
      return response.status === 409 ? 'busy' : 'unsupported';
    } catch { return 'unsupported'; }
  }

  /** Stop a server we know about (only when it is idle, or when the owner asked to stop everything). */
  async function terminate(session) {
    if (!session?.pid) return;
    const body = await health(session.token);
    // Only ever signal a process that proved it is our server (same instance), never a recycled pid.
    if (!body || body.desktopInstance !== session.instanceId || body.pid !== session.pid) return;
    try { process.kill(session.pid, 'SIGTERM'); } catch { return; }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await health(session.token, 300))) return;
      await sleep(250);
    }
    try { process.kill(session.pid, 'SIGKILL'); } catch { /* gone */ }
  }

  /** Re-adopt the running server, or start one. Resolves once the server answers with this app's token. */
  async function ensure() {
    const saved = readSession();
    if (saved) {
      const body = await health(saved.token);
      if (body && body.desktopInstance === saved.instanceId) {
        Object.assign(state, { token: saved.token, instanceId: saved.instanceId, pid: body.pid || saved.pid, build: body.build || saved.build || '', runtime: saved.runtime || '', adopted: true });
        // An older build that is not running anything is replaced right now, before any window opens.
        if (state.build !== buildId && body.busy === 0 && (await retire(saved)) !== 'busy') {
          await terminate(saved);
          if (!(await launch())) throw new Error(`Check whether another app is using port ${port}. You can also check the data folder in Library → Application Support → Marion Agent.`);
          return { ...state };
        }
        await attach();
        pruneRuntimes(state.runtime && path.basename(state.runtime), safe(buildId));
        return { ...state };
      }
    }
    if (!(await launch())) throw new Error(`Check whether another app is using port ${port}. You can also check the data folder in Library → Application Support → Marion Agent.`);
    return { ...state };
  }

  async function replace(reason, { onlyIfIdle = false } = {}) {
    if (replacing) return false;
    replacing = true;
    try {
      if (onlyIfIdle && (await retire({ token: state.token })) === 'busy') return false; // work started: keep the server
      console.log(`[server-host] replacing the server (${reason})`);
      await terminate({ token: state.token, instanceId: state.instanceId, pid: state.pid });
      return await launch();
    } finally { replacing = false; }
  }

  /**
   * Keep an eye on the server while the app is open:
   *  - older build + nothing running -> swap in this build's server and tell the window to reload;
   *  - server stopped answering (crashed) -> start a fresh one and reload.
   */
  function watch(onReplaced) {
    let misses = 0;
    watcher = setInterval(async () => {
      if (replacing) return;
      const body = await health(state.token, 1500);
      if (!body || body.desktopInstance !== state.instanceId) {
        if (++misses >= 3 && (await replace('the server stopped responding'))) { misses = 0; onReplaced(); }
        return;
      }
      misses = 0;
      if (body.build !== buildId && body.busy === 0 && (await replace('a new version is ready and nothing is running', { onlyIfIdle: true }))) onReplaced();
    }, 4000);
    watcher.unref?.();
  }

  /** "Quit and stop everything": the one way the app deliberately ends the server. */
  async function stop() {
    clearInterval(watcher);
    await terminate({ token: state.token, instanceId: state.instanceId, pid: state.pid });
    try { fs.rmSync(sessionPath, { force: true }); } catch { /* best effort */ }
  }

  return { ensure, watch, stop, state, prepareRuntime, readSession };
}

module.exports = { createServerHost };
