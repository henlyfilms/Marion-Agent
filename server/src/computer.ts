import { db, now } from './db.js';
import { desktop } from './desktop.js';
import { hub } from './lib/hub.js';
import type { ComputerState } from './types.js';

export const BOX_ROOT = '/workspace';
const operations = new Map<string, Promise<unknown>>();

function serialize<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const pending = operations.get(userId);
  const result = (pending ? pending.catch(() => undefined) : Promise.resolve()).then(operation);
  operations.set(userId, result);
  const forget = () => { if (operations.get(userId) === result) operations.delete(userId); };
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
  return serialize(userId, async () => {
    if (!db.prepare("SELECT 1 FROM bots WHERE id=? AND user_id=? AND kind!='room'").get(botId, userId)) {
      throw new Error('Bot desktop not found');
    }
    try {
      if (!await desktop.running(botId)) {
        setStatus(userId, 'starting');
        await desktop.start(botId);
      }
      db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,running) VALUES (?,?,?,?,1)').run(botId, userId, botId, now());
      setStatus(userId, 'running');
      return botId;
    } catch (error) {
      setStatus(userId, 'error', (error as Error).message.slice(0, 300));
      throw error;
    }
  });
}

export function ensureComputer(userId: string) {
  const bot = db.prepare("SELECT id FROM bots WHERE user_id=? AND kind!='room' ORDER BY is_primary DESC, created_at LIMIT 1").get(userId) as { id: string } | undefined;
  if (!bot) return Promise.reject(new Error('Create a bot first'));
  return screenFor(userId, bot.id);
}

export function stopDesktop(userId: string, botId: string) {
  return serialize(userId, async () => {
    if (!assigned(userId).some(screen => screen.botId === botId)) return;
    await desktop.stop(botId);
    db.prepare('UPDATE screens SET running=0 WHERE bot_id=?').run(botId);
    setStatus(userId, assigned(userId).some(screen => screen.running) ? 'running' : 'suspended');
  });
}

export function suspendComputer(userId: string) {
  return serialize(userId, async () => {
    const screens = assigned(userId);
    if (!screens.length) return;
    setStatus(userId, 'suspending');
    try {
      for (const { botId } of screens) {
        await desktop.stop(botId);
        db.prepare('UPDATE screens SET running=0 WHERE bot_id=?').run(botId);
      }
      setStatus(userId, 'suspended');
    } catch (error) {
      setStatus(userId, 'error', (error as Error).message.slice(0, 300));
      throw error;
    }
  });
}

export function refreshComputer(userId: string) {
  return serialize(userId, async () => {
    const current = computerState(userId);
    if (!current.screens.length && current.status === 'error') return current;
    try {
      let running = false;
      let changed = false;
      for (const screen of current.screens) {
        const awake = Boolean(await desktop.running(screen.botId));
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
  });
}
