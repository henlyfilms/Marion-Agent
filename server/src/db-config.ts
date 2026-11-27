import { db } from './db.js';

/**
 * Schema additions for bot settings, memory over time and hibernation.
 * Kept out of db.ts on purpose: everything here is idempotent (CREATE IF NOT EXISTS
 * and ALTERs guarded by a column check), so it is safe on old and new databases.
 */

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('skills', 'updated_at', 'INTEGER');
/** 'chat' = saved by the bot's remember tool, 'learned' = extracted by consolidation. */
addColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'chat'");

db.exec(`
-- Universal skills belong to a user (the team) and apply to every one of their Bots, so there is one copy to edit.
CREATE TABLE IF NOT EXISTS universal_skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS universal_skills_user_name ON universal_skills(user_id, lower(name));
-- Which shipped universal skills were already seeded for a user, so deleting one keeps it deleted.
CREATE TABLE IF NOT EXISTS universal_skill_seeds (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
-- Universal memories: durable facts shared by every Bot of a user. Seeds record which shipped ones were already added.
CREATE TABLE IF NOT EXISTS universal_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS universal_memories_user ON universal_memories(user_id, created_at);
CREATE TABLE IF NOT EXISTS universal_memory_seeds (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS local_model_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_sort_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sort TEXT NOT NULL CHECK (sort IN ('recent', 'name', 'custom'))
);
CREATE TABLE IF NOT EXISTS chat_provider_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'gemini', 'claude'))
);
-- Chat-only default reasoning effort per chat provider: applies to chats that inherit their model (no per-bot model
-- override). Builder, team, Ask and coding runs keep using subscription_model_preferences.
CREATE TABLE IF NOT EXISTS chat_effort_defaults (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('local', 'codex', 'gemini', 'claude')),
  effort TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS subscription_model_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'gemini', 'claude')),
  model TEXT NOT NULL,
  effort TEXT,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS browser_access_settings (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  session_hours INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_jobs (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_consolidated_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  method TEXT NOT NULL,
  items_before INTEGER NOT NULL,
  items_after INTEGER NOT NULL,
  chars_before INTEGER NOT NULL,
  chars_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Existing desktop databases constrain the provider column to the original two CLIs.
db.transaction(() => {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_provider_preferences'")
    .get() as { sql: string };
  if (table.sql.includes("'claude'")) return;
  db.exec(`
    ALTER TABLE chat_provider_preferences RENAME TO old_chat_provider_preferences;
    CREATE TABLE chat_provider_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'gemini', 'claude'))
    );
    INSERT INTO chat_provider_preferences SELECT user_id, provider FROM old_chat_provider_preferences;
    DROP TABLE old_chat_provider_preferences;
  `);
}).immediate();

