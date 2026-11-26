import { db, now } from './db.js';
import { desktop } from './desktop.js';
import { hub } from './lib/hub.js';
import type { ComputerState } from './types.js';

export const BOX_ROOT = '/workspace';
const operations = new Map<string, Promise<unknown>>();

/**
 * Operations are serialized per desktop (key), not per user: each bot has its own computer, so one bot's slow start (a Docker
 * image build, Colima booting) must never hold up another bot's computer that background tasks are using in parallel.
 */
function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = operations.get(key);
  const result = (pending ? pending.catch(() => undefined) : Promise.resolve()).then(operation);
  operations.set(key, result);
  const forget = () => { if (operations.get(key) === result) operations.delete(key); };
  void result.then(forget, forget);
  return result;
}

function assigned(userId: string) {
  // Older screen assignments used provider-issued IDs. Ignore those rows until a desktop is created.
  const rows = db.prepare('SELECT bot_id AS botId, screen_id AS screenId, running FROM screens WHERE user_id=? AND screen_id=bot_id')
    .all(userId) as { botId: string; screenId: string; running: number }[];
  return rows.map(row => ({ ...row, running: Boolean(row.running) }));
}

function setStatus(userId: string, status: ComputerState['status'], error: string | null = null) {
  db.prepare(`INSERT INTO computers(user_id,status,error,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`)
    .run(userId, status, error, now());
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
}

export function computerState(userId: string): ComputerState {
  const row = db.prepare('SELECT status,error FROM computers WHERE user_id=?').get(userId) as Pick<ComputerState, 'status' | 'error'> | undefined;
  const screens = assigned(userId);
  return { status: row?.status ?? 'absent', error: row?.error ?? null, screens };
}

export function screenFor(userId: string, botId: string): Promise<string> {
  return serialize(botId, async () => {
    if (!db.prepare("SELECT 1 FROM bots WHERE id=? AND user_id=? AND kind!='room'").get(botId, userId)) {
      throw new Error('Bot desktop not found');
    }
    try {
      const awake = await desktop.running(botId).catch(error => {
        if (String(error).includes('Start Docker Desktop or Colima')) return false;
        throw error;
      });
      if (!awake) {
        setStatus(userId, 'starting');
        try { await desktop.start(botId); }
        catch (error) {
          // Docker missing/stopped needs the owner; anything else (a wedged or half-made container, a slow machine) gets one
          // clean retry on a fresh container. The /workspace volume is kept, so files survive.
          if (/Install Docker|Start Docker|Colima|image .* unavailable|Could not build/i.test(String(error))) throw error;
          await desktop.reset(botId);
          await desktop.start(botId);
        }
      }
      db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,running) VALUES (?,?,?,?,1)').run(botId, userId, botId, now());
      setStatus(userId, 'running');
      return botId;
    } catch (error) {
      // One bot's computer failing must not mark the others (still running in parallel) as broken.
      if (assigned(userId).some(screen => screen.running && screen.botId !== botId)) setStatus(userId, 'running');
      else setStatus(userId, 'error', (error as Error).message.slice(0, 300));
      throw error;
    }
  });
}

export function ensureComputer(userId: string) {
  const bot = db.prepare("SELECT id FROM bots WHERE user_id=? AND kind!='room' AND deleted_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1").get(userId) as { id: string } | undefined;
  if (!bot) return Promise.reject(new Error('Create a bot first'));
  return screenFor(userId, bot.id);
}

export function stopDesktop(userId: string, botId: string) {
  return serialize(botId, async () => {
    if (!assigned(userId).some(screen => screen.botId === botId)) return;
    await desktop.stop(botId);
    db.prepare('UPDATE screens SET running=0 WHERE bot_id=?').run(botId);
    setStatus(userId, assigned(userId).some(screen => screen.running) ? 'running' : 'suspended');
  });
}

export async function suspendComputer(userId: string) {
  const screens = assigned(userId);
  if (!screens.length) return;
  setStatus(userId, 'suspending');
  const results = await Promise.allSettled(screens.map(({ botId }) => serialize(botId, async () => {
    await desktop.stop(botId);
    db.prepare('UPDATE screens SET running=0 WHERE bot_id=?').run(botId);
  })));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) {
    setStatus(userId, 'error', (failed.reason as Error).message.slice(0, 300));
    throw failed.reason;
  }
  setStatus(userId, 'suspended');
}

export async function refreshComputer(userId: string) {
  const current = computerState(userId);
  if (!current.screens.length && current.status === 'error') return current;
  try {
    let running = false;
    let changed = false;
    for (const screen of current.screens) {
      // Wait for this bot's own start/stop to settle, but never for another bot's.
      const awake = await serialize(botKey(screen.botId), async () => Boolean(await desktop.running(screen.botId)));
      if (awake !== screen.running) {
        db.prepare('UPDATE screens SET running=? WHERE bot_id=?').run(Number(awake), screen.botId);
        changed = true;
      }
      running ||= awake;
    }
    const status = running ? 'running' : current.screens.length ? 'suspended' : 'absent';
    if (changed || status !== current.status) setStatus(userId, status);
  } catch (error) {
    setStatus(userId, 'error', (error as Error).message.slice(0, 300));
  }
  return computerState(userId);
}

const botKey = (botId: string) => botId;
