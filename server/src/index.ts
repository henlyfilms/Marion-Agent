import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { desktopAccessHeader, hasDesktopAccess } from './lib/desktop-access.js';
import { remoteAccessFor, remoteWorkspaceUser } from './lib/auth.js';
import { migrateStarterAgent } from './db.js';
import './features/schema.js';
import { migrateUniversalSkills } from './features/universal-skills.js';
import { featuresApi } from './routes-features.js';
import { startLifeSync } from './features/life-link.js';
import { startLifeOutbox } from './features/life-outbox.js';
import { recoverAgentSessions } from './features/agent-sessions.js';
import { busyCount, setOwnerPid, startOrphanWatch } from './lib/lifecycle.js';
import { startAutoUpdate } from './features/app-update.js';
import { appEnv, env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue } from './agent/loop.js';
import { configApi } from './routes-config.js';
import { startIdleWatcher } from './idle.js';
import { startMemoryConsolidation } from './agent/memory.js';

initSubagents();
initRooms();
migrateStarterAgent();
migrateUniversalSkills();

const app = new Hono();
app.use('*', async (c, next) => {
  if (!hasDesktopAccess(c.req.header(desktopAccessHeader))) {
    const access = remoteAccessFor(c);
    if (!access) return c.text('Forbidden', 403);
    const pathname = c.req.path;
    const publicAuth = ['/api/auth/me', '/api/auth/mobile'].includes(pathname);
    if (pathname.startsWith('/api/')) {
      c.header('Cache-Control', 'no-store');
      if (access.kind === 'browser' && !['GET', 'HEAD'].includes(c.req.method) && c.req.header('origin') !== access.origin) {
        return c.json({ error: 'Open Marion Agent directly at its configured HTTPS address.' }, 403);
      }
      if (!publicAuth && !remoteWorkspaceUser(c.req.header('cookie'), access)) {
        return c.json({ error: 'Pair this device with Marion Agent first.' }, 401);
      }
    }
  }
  await next();
});
// Cookie auth: reject cross-origin form/text POSTs (JSON requests already need a CORS preflight, which we never allow).
app.use('/api/*', csrf({ origin: env.trustedOrigins }));
app.get('/api/health', (c) => c.json({
  ok: true, app: 'marion-agent', model: env.localModelName, provider: 'local', desktopInstance: appEnv('DESKTOP_INSTANCE'),
  // The Mac app reads these to adopt a server that kept running, and to swap in a new build only when nothing is running.
  build: appEnv('BUILD_ID') ?? null, busy: busyCount(), pid: process.pid,
}));
// The Mac app tells the server it is the owner now (after a relaunch or an update). Only the app's own token gets here.
app.post('/api/desktop/attach', async (c) => {
  if (!appEnv('DESKTOP_TOKEN') || !hasDesktopAccess(c.req.header(desktopAccessHeader))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({})) as { pid?: unknown };
  setOwnerPid(Number(body.pid));
  return c.json({ ok: true, busy: busyCount() });
});
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', featuresApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => console.log(`[marion-agent] server on http://${env.host.includes(':') ? `[${env.host}]` : env.host}:${info.port} (model ${env.localModelName})`));
if (!env.allowedEmails.length && !env.openSignup) console.warn('[auth] ALLOWED_EMAILS is not set and SERVER_URL is not localhost: new sign-ups are disabled.');
if (env.devLoginRequested && !env.devLogin) console.warn('[auth] DEV_LOGIN=1 ignored: dev sign-in only works when HOST is loopback and SERVER_URL is a localhost URL.');
attachVncRelay(server as unknown as Server);
// MARION_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (appEnv('NO_SCHEDULER') !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
  initProactive(enqueue);
} else console.log('[marion-agent] scheduler disabled (MARION_NO_SCHEDULER=1)');
try { recoverAgentSessions(); } catch (error) { console.warn('[marion-agent] could not tidy relayed sessions', (error as Error).message); }
startIdleWatcher();
startOrphanWatch();
if (appEnv('NO_SCHEDULER') !== '1') startAutoUpdate();
startMemoryConsolidation();
if (appEnv('NO_SCHEDULER') !== '1') { startLifeSync(); startLifeOutbox(); }
