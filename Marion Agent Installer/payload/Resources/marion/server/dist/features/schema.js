import { db } from '../db.js';
import '../db-config.js';
/** Idempotent schema for templates, coordination, context, notifications, teaching and the Marion Life link. */
function addColumn(table, col, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('bots', 'role', 'TEXT');
addColumn('bots', 'template_id', 'TEXT');
addColumn('bots', 'context_tokens', 'INTEGER');
addColumn('bots', 'compact_at_tokens', 'INTEGER');
addColumn('bots', 'integrations', 'TEXT');
addColumn('bots', 'last_reflected_at', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
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
export function getSetting(userId, key, fallback) {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(userId, key);
    if (!row)
        return fallback;
    try {
        return { ...fallback, ...JSON.parse(row.value) };
    }
    catch {
        return fallback;
    }
}
export function setSetting(userId, key, value) {
    db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
        .run(userId, key, JSON.stringify(value));
}
export function getSecret(key) {
    return db.prepare('SELECT value FROM app_secrets WHERE key=?').get(key)?.value ?? null;
}
export function setSecret(key, value) {
    if (value === null)
        db.prepare('DELETE FROM app_secrets WHERE key=?').run(key);
    else
        db.prepare('INSERT INTO app_secrets(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
export const featureSchemaReady = true;
//# sourceMappingURL=schema.js.map