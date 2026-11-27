import { db } from '../db.js';
import '../db-config.js';

/** Idempotent schema for templates, coordination, context, notifications, teaching and the Marion Life link. */
function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

addColumn('bots', 'role', 'TEXT');
addColumn('bots', 'template_id', 'TEXT');
addColumn('bots', 'context_tokens', 'INTEGER');
addColumn('bots', 'compact_at_tokens', 'INTEGER');
addColumn('bots', 'integrations', 'TEXT');
addColumn('bots', 'last_reflected_at', 'INTEGER');
addColumn('bots', 'avatar_glow', 'INTEGER NOT NULL DEFAULT 0');
/** Theme → Upload photo: a small square image (data URL, resized in the browser) shown instead of the berry. */
addColumn('bots', 'avatar_image', 'TEXT');
/** Theme → Working animation: 'auto' or one of the aura styles. */
addColumn('bots', 'work_fx', "TEXT NOT NULL DEFAULT 'auto'");
/** Set when a chat is deleted; it can be restored for DELETED_KEEP_MS before it is removed for good. */
addColumn('bots', 'deleted_at', 'INTEGER');
/** Bot settings → Access → Full access (whole home folder for its CLIs, no approval prompts for them). */
addColumn('bots', 'full_access', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS user_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_messages_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_bot_id TEXT NOT NULL,
  to_bot_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_messages_log_pair ON bot_messages_log(from_bot_id, to_bot_id, created_at);
-- Everything Marion Agent still has to tell Marion Life (or already told it): Claude session summaries and
-- deleted chats/bots. Rows wait here while Life is off, unreachable, or hasn't added the matching tool yet.
CREATE TABLE IF NOT EXISTS life_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS life_outbox_pending ON life_outbox(user_id, sent_at, next_attempt_at);
-- Every run Marion relayed to Claude, Codex or Gemini (ask_subscription, subscription-backed bots, orchestrate, team):
-- running, finished, failed or stopped, kept locally so Marion Agent can show them (the Sessions view).
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  request TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error TEXT,
  chat_generation INTEGER,
  folder_path TEXT,
  folder_label TEXT,
  model TEXT,
  model_label TEXT,
  effort TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  active_calls INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  agent TEXT,
  group_id TEXT,
  rotated TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_user ON agent_sessions(user_id, started_at);
CREATE INDEX IF NOT EXISTS agent_sessions_bot ON agent_sessions(bot_id, started_at);
CREATE TABLE IF NOT EXISTS life_sync (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  synced_rev INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  error TEXT,
  PRIMARY KEY (bot_id, generation)
);
`);

addColumn('agent_sessions', 'cloud_url', 'TEXT');

export function getSetting<T>(userId: string, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(userId, key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return { ...fallback as any, ...JSON.parse(row.value) } as T; } catch { return fallback; }
}

export function setSetting(userId: string, key: string, value: unknown) {
  db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
    .run(userId, key, JSON.stringify(value));
}

export function getSecret(key: string): string | null {
  return (db.prepare('SELECT value FROM app_secrets WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function setSecret(key: string, value: string | null) {
  if (value === null) db.prepare('DELETE FROM app_secrets WHERE key=?').run(key);
  else db.prepare('INSERT INTO app_secrets(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

