import { db, now as dbNow } from './db.js';
import { getLive } from './store.js';
import { suspendComputer } from './computer.js';
import { isBotBusy } from './agent/loop.js';
import { appEnv } from './env.js';
/**
 * Computer hibernation: suspend a user's desktops when no bot turn is running and no
 * viewer WebSocket is connected for MARION_IDLE_SUSPEND_MIN minutes (default 20).
 * The next computer tool call wakes it again through ensureComputer().
 */
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
export const idleConfig = {
    idleMin: num(appEnv('IDLE_SUSPEND_MIN'), 20),
    sweepSec: num(appEnv('IDLE_SWEEP_SEC'), 60),
    /** Log decisions but never call suspend (for test servers sharing a real VM). */
    dryRun: appEnv('IDLE_DRY_RUN') === '1',
};
// ---------- viewer tracking (called from vnc.ts) ----------
const viewers = new Map();
const lastBusy = new Map();
export function viewerOpened(userId) {
    viewers.set(userId, (viewers.get(userId) ?? 0) + 1);
    lastBusy.set(userId, Date.now());
    console.log(`[idle] viewer connected user=${userId} (now ${viewers.get(userId)})`);
}
export function viewerClosed(userId) {
    const n = Math.max(0, (viewers.get(userId) ?? 1) - 1);
    if (n)
        viewers.set(userId, n);
    else
        viewers.delete(userId);
    lastBusy.set(userId, Date.now());
    console.log(`[idle] viewer disconnected user=${userId} (now ${n})`);
}
export const viewerCount = (userId) => viewers.get(userId) ?? 0;
export function createIdleWatcher(deps, opts) {
    const startedAt = deps.now();
    const busyAt = new Map();
    const announced = new Set();
    const inFlight = new Set();
    function decide(userId) {
        const turns = deps.anyTurnRunning(userId);
        const v = deps.viewers(userId);
        if (turns || v > 0) {
            busyAt.set(userId, deps.now());
            announced.delete(userId);
            return { action: 'busy', reason: turns ? 'turn running' : `${v} viewer(s)` };
        }
        const last = Math.max(busyAt.get(userId) ?? startedAt, lastBusy.get(userId) ?? 0, deps.lastActivity(userId));
        const idleMs = deps.now() - last;
        return idleMs >= opts.idleMs ? { action: 'suspend', idleMs } : { action: 'wait', idleMs };
    }
    async function sweep() {
        const out = {};
        for (const c of deps.computers()) {
            if (c.status !== 'running' || inFlight.has(c.userId))
                continue;
            const d = decide(c.userId);
            out[c.userId] = d;
            if (d.action !== 'suspend')
                continue;
            const mins = Math.round(d.idleMs / 6000) / 10;
            if (opts.dryRun) {
                if (!announced.has(c.userId))
                    deps.log(`[idle] (dry run) would suspend computer for user=${c.userId} after ${mins} min idle`);
                announced.add(c.userId);
                continue;
            }
            inFlight.add(c.userId);
            deps.log(`[idle] suspending computer for user=${c.userId}: no turns or viewers for ${mins} min`);
            try {
                await deps.suspend(c.userId);
            }
            catch (e) {
                deps.log(`[idle] suspend failed for user=${c.userId}: ${e?.message ?? e}`);
                busyAt.set(c.userId, deps.now()); // back off a full window before retrying
            }
            finally {
                inFlight.delete(c.userId);
            }
        }
        return out;
    }
    return { decide, sweep };
}
// ---------- production wiring ----------
export function startIdleWatcher() {
    const watcher = createIdleWatcher({
        now: dbNow,
        computers: () => db.prepare("SELECT user_id, status FROM computers").all().map((r) => ({ userId: r.user_id, status: r.status })),
        anyTurnRunning: (userId) => db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId).some((b) => isBotBusy(b.id) || getLive(b.id).isRunning),
        viewers: viewerCount,
        lastActivity: (userId) => {
            const b = db.prepare('SELECT MAX(updated_at) t FROM bots WHERE user_id=?').get(userId);
            const c = db.prepare('SELECT updated_at t FROM computers WHERE user_id=?').get(userId);
            return Math.max(b?.t ?? 0, c?.t ?? 0);
        },
        suspend: (userId) => suspendComputer(userId),
        log: (m) => console.log(m),
    }, { idleMs: idleConfig.idleMin * 60_000, dryRun: idleConfig.dryRun });
    const timer = setInterval(() => { watcher.sweep().catch((e) => console.warn('[idle] sweep failed', e)); }, idleConfig.sweepSec * 1000);
    timer.unref?.();
    console.log(`[idle] hibernation after ${idleConfig.idleMin} min without turns or viewers${idleConfig.dryRun ? ' (dry run)' : ''}`);
    return { watcher, stop: () => clearInterval(timer) };
}
//# sourceMappingURL=idle.js.map