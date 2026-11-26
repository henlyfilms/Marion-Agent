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
CREATE TABLE IF NOT EXISTS life_sync (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  synced_rev INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  error TEXT,
  PRIMARY KEY (bot_id, generation)
);
`);

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

