import { busyBotCount } from '../agent/loop.js';
import { activeProviderRuns } from '../agent/subscriptions.js';
import { appEnv } from '../env.js';

/**
 * Keeps the local server alive while work is running, even after the Mac app window is closed, the app is
 * quit by accident, or the app is replaced by an update. The app starts this server detached from itself
 * (see Marion Agent Installer/payload/Resources/app/server-host.cjs) and tells it who the owner app is.
 * When that app is gone the server keeps going while any bot turn or Claude/Codex/Gemini run is active, and
 * exits once everything has been idle for IDLE_EXIT_MS (long enough that a relaunch re-adopts it).
 */

const IDLE_EXIT_MS = 60_000;
let ownerPid = Number(appEnv('OWNER_PID')) || 0;

/** Work in progress: bot turns (including their Claude relays) plus any provider CLI still running. */
export const busyCount = () => busyBotCount() + activeProviderRuns();

export const setOwnerPid = (pid: number) => { if (Number.isInteger(pid) && pid > 1) ownerPid = pid; };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export function startOrphanWatch(exit: () => void = () => process.exit(0)) {
  if (!appEnv('DESKTOP_TOKEN')) return; // only the Mac app launches the server this way
  let idleSince = 0;
  const timer = setInterval(() => {
    const orphan = ownerPid > 0 && !alive(ownerPid);
    if (!orphan || busyCount() > 0) { idleSince = 0; return; }
    idleSince ||= Date.now();
    if (Date.now() - idleSince >= IDLE_EXIT_MS) {
      console.log('[marion-agent] the app is closed and nothing is running: stopping the background server');
      exit();
    }
  }, 5000);
  timer.unref?.();
}
