import type Database from 'better-sqlite3';

/**
 * The create_task / update_task tool logic, kept apart from tools.ts (and from db.ts) so it can run against any database,
 * including a throwaway one in tests. Every outcome says truthfully what happened: a task is never reported as created or
 * updated when no row changed.
 */

type Db = Pick<Database.Database, 'prepare' | 'transaction'>;

export const TASK_STATES = ['working', 'needs_input', 'done'] as const;
export type TaskState = typeof TASK_STATES[number];
/** States that are still open work: a second task with the same title for the same Bot is a duplicate. Done never blocks. */
const ACTIVE_STATES: readonly TaskState[] = ['working', 'needs_input'];
const MAX_TITLE = 300;

/** Same task title regardless of case, spacing, Unicode form or a trailing full stop. */
export function normalizeTaskTitle(title: string) {
  return String(title ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!…\s]+$/u, '');
}

interface BotRow { id: string; name: string; user_id: string; kind: string | null; hidden: number | null; deleted_at: number | null; parent_bot_id: string | null }

export type CreateTaskResult =
  | { ok: true; created: true; taskId: string; botId: string; botName: string }
  | { ok: true; created: false; duplicate: true; taskId: string; botId: string; botName: string; state: TaskState; title: string }
  | { ok: false; error: 'empty_title' | 'unknown_bot' | 'not_assignable'; message: string };

export interface CreateTaskInput {
  userId: string;
  /** The Bot calling the tool: the default assignee. */
  callerBotId: string;
  title: unknown;
  /** Optional: assign to another active Bot on the same team, by name (as in send_to_bot). */
  botName?: unknown;
  newId: () => string;
  now: () => number;
}

function teamBot(db: Db, userId: string, name: string) {
  // Visible bots first, so a helper named like a teammate never shadows the teammate.
  return db.prepare('SELECT id, name, user_id, kind, hidden, deleted_at, parent_bot_id FROM bots WHERE user_id=? AND lower(name)=lower(?) AND deleted_at IS NULL ORDER BY COALESCE(hidden,0), created_at')
    .get(userId, name) as BotRow | undefined;
}

export function createTask(db: Db, input: CreateTaskInput): CreateTaskResult {
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  const key = normalizeTaskTitle(title);
  if (!key) return { ok: false, error: 'empty_title', message: 'Task not created: the title is empty.' };

  const caller = db.prepare('SELECT id, name, user_id, kind, hidden, deleted_at, parent_bot_id FROM bots WHERE id=?').get(input.callerBotId) as BotRow | undefined;
  if (!caller || caller.user_id !== input.userId || caller.deleted_at) return { ok: false, error: 'unknown_bot', message: 'Task not created: your Bot was not found.' };

  let target = caller;
  const wanted = typeof input.botName === 'string' ? input.botName.trim().replace(/^@/, '') : '';
  if (wanted && wanted.toLowerCase() !== caller.name.toLowerCase()) {
    const found = teamBot(db, input.userId, wanted);
    if (!found) {
      const team = (db.prepare("SELECT name FROM bots WHERE user_id=? AND deleted_at IS NULL AND COALESCE(hidden,0)=0 AND COALESCE(kind,'')!='room' ORDER BY created_at").all(input.userId) as { name: string }[]).map(b => b.name);
      return { ok: false, error: 'unknown_bot', message: `Task not created: no active Bot named "${wanted}". Team: ${team.join(', ') || 'none'}.` };
    }
    if (found.kind === 'room') return { ok: false, error: 'not_assignable', message: `Task not created: "${found.name}" is a group chat, not a Bot.` };
    if (found.hidden && found.parent_bot_id !== caller.id) return { ok: false, error: 'not_assignable', message: `Task not created: "${found.name}" is another Bot's helper.` };
    target = found;
  }

  // Check and insert in one transaction so two calls racing with the same title still make one row.
  return db.transaction((): CreateTaskResult => {
    const open = db.prepare(`SELECT id, title, state FROM tasks WHERE bot_id=? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(target.id, ...ACTIVE_STATES) as { id: string; title: string; state: TaskState }[];
    const existing = open.find(t => normalizeTaskTitle(t.title) === key);
    if (existing) return { ok: true, created: false, duplicate: true, taskId: existing.id, botId: target.id, botName: target.name, state: existing.state, title: existing.title };
    const id = input.newId();
    const at = input.now();
    const assignedBy = target.id === caller.id ? null : caller.id;
    db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at,assigned_by) VALUES (?,?,?,'working',?,?,?)").run(id, target.id, title, at, at, assignedBy);
    return { ok: true, created: true, taskId: id, botId: target.id, botName: target.name };
  })();
}

export type UpdateTaskResult =
  | { ok: true; taskId: string; botId: string; state: TaskState; previousState: TaskState }
  | { ok: false; error: 'invalid_state' | 'not_found' | 'not_owner'; message: string };

export interface UpdateTaskInput { userId: string; callerBotId: string; taskId: unknown; state: unknown; note?: unknown; now: () => number }

export function updateTask(db: Db, input: UpdateTaskInput): UpdateTaskResult {
  const state = String(input.state ?? '') as TaskState;
  if (!TASK_STATES.includes(state)) return { ok: false, error: 'invalid_state', message: `Task not updated: state must be one of ${TASK_STATES.join(', ')}.` };
  const taskId = String(input.taskId ?? '').trim();
  const note = typeof input.note === 'string' ? input.note : null;
  // The assignee, or the Bot that handed the task out, may update it. Read and write in one transaction so the
  // reported previous state is the one actually replaced.
  const updated = taskId ? db.transaction(() => {
    const before = db.prepare('SELECT bot_id, state FROM tasks WHERE id=? AND (bot_id=? OR assigned_by=?)').get(taskId, input.callerBotId, input.callerBotId) as { bot_id: string; state: TaskState } | undefined;
    if (!before) return undefined;
    const changes = db.prepare('UPDATE tasks SET state=?, note=COALESCE(?, note), updated_at=? WHERE id=?').run(state, note, input.now(), taskId).changes;
    return changes > 0 ? before : undefined;
  })() : undefined;
  if (updated) return { ok: true, taskId, botId: updated.bot_id, state, previousState: updated.state };
  // Nothing changed: say why. A task of another user's Bot is reported as missing, so nothing about it leaks.
  const row = taskId ? db.prepare('SELECT t.bot_id, b.name, b.user_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=?').get(taskId) as { bot_id: string; name: string; user_id: string } | undefined : undefined;
  if (!row || row.user_id !== input.userId) return { ok: false, error: 'not_found', message: `Task not updated: no task with id "${taskId}". Create it with create_task first.` };
  return { ok: false, error: 'not_owner', message: `Task not updated: task "${taskId}" belongs to ${row.name}, not you. Only the Bot it is assigned to (or the Bot that assigned it) can update it.` };
}
