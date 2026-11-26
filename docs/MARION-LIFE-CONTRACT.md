# Marion Agent → Marion Life contract

For Barry (the Marion Life bot) to implement the Life side. Marion Agent already talks to Life through
`POST https://marionberry.app/api/mcp` (JSON-RPC 2.0, `method: "tools/call"`, `Authorization: Bearer mb_…`, the
same revocable key as `save_agent_chats`). Two new tools are called the same way. Marion Agent treats a JSON-RPC
error `-32601` / "unknown tool" as "not implemented yet": it keeps the data in its local outbox, retries every 30
minutes, and sends everything the moment the tool exists. Nothing is lost while Life catches up.

Both tools must be **idempotent** (upsert by the id given) because Marion Agent may resend after a timeout.
Return `{ "ok": true }` (as `structuredContent` or JSON text). Any other result or HTTP error means "try again later".

## 1. `save_agent_sessions` – finished Claude sessions

Called whenever a Claude run finishes (success, failure or stopped): `ask_subscription`, a subscription-backed
Claude chat turn, a Claude agent inside `orchestrate`, and Claude team members (`team_delegate`, `team_discuss`).
Several finishes with the same `id` (e.g. the steps of one chat turn, or the plan and review calls of one
orchestration agent) arrive as updates to one record: `calls` counts them, the latest status/summary wins.

Arguments (a batch, at most 20 per call and under 64 KB):

```json
{ "sessions": [ {
  "id": "marion-agent:ask:<bot id>:<generation>:<epoch ms>",
  "source": "marion_agent",
  "provider": "claude",
  "kind": "ask_subscription | subscription_bot | orchestration | team",
  "title": "Fix the login redirect",
  "summary": "≤ ~700 chars: opening + closing words of Claude's final reply",
  "request": "the owner's request, ≤ 1500 chars",
  "status": "completed | failed | stopped",
  "error": null,
  "started_at": "2026-11-25T20:00:00.000Z",
  "ended_at": "2026-11-25T20:00:05.000Z",
  "duration_ms": 5000,
  "calls": 1,
  "model": "claude-opus-5-5", "model_label": "Claude Opus 5.5", "effort": "medium",
  "tokens": { "input": 100, "output": 20 },
  "marion_bot_id": "…", "bot_name": "Quinn", "bot_job": "Researcher",
  "chat_id": "<bot id>:<generation>",
  "chat_generation": 1,
  "folder": { "name": "Marion Agent", "path": "/Users/…/Marion Agent" },
  "role": "worker | orchestrator | member | discussion | null",
  "agent": "Claude Opus 5.5 | null",
  "group_id": "ties sessions of one orchestration/team run or relay session together"
} ] }
```

`chat_id` is the same id `save_agent_chats` uses (`<bot id>:<generation>`), so Life can link a summary to the
copied chat. `tokens`, `folder`, `role`, `agent`, `group_id`, `error` may be `null`.

Suggested table `life_agent_sessions`: `id text primary key (user-scoped)`, `user_id`, `provider`, `kind`, `title`,
`summary`, `request`, `status`, `error`, `started_at`, `ended_at`, `duration_ms`, `calls`, `model`, `model_label`,
`effort`, `tokens jsonb`, `marion_bot_id`, `bot_name`, `bot_job`, `chat_id`, `chat_generation`, `folder jsonb`,
`role`, `agent`, `group_id`, `updated_at`; index `(user_id, ended_at desc)`; include `title` + `summary` in the
Second Brain search.

## 2. `archive_deleted_item` – the "Deleted" folder

Called when the owner deletes a chat or bot in Marion Agent (sidebar, or a bot using `marion_app delete_bot`),
and once at startup for chats that were already in "Recently deleted". In Marion Agent a chat *is* a bot, so
`item_type` is always `"bot"`; a bot's chats are its "Start fresh" generations. Marion Agent keeps its own 30-day
recovery; **Life's copy is permanent** and must stay even after Marion Agent purges its own.

Each deletion is sent as `parts` calls, in order, each under 600 KB, keyed by `archive_id` + `part`
(upsert on that pair). `archive_id` is `"<bot id>:<deleted_at epoch ms>"`; deleting the same bot again after a
restore makes a new `archive_id`.

**Part 0 – the bot:**

```json
{
  "archive_id": "bot_x:1700000000000", "status": "deleted", "part": 0, "parts": 3,
  "item_type": "bot",
  "deleted_at": "ISO", "deleted_by": "sidebar | agent_tool | api | startup_backfill", "restore_until": "ISO (deleted_at + 30 days)",
  "marion_bot_id": "bot_x",
  "name": "Quinn", "job": "Researcher", "description": "…", "kind": "agent | room",
  "instructions": "full instructions text",
  "profile": { "…every other column of Marion Agent's bots row (colors, model, voice, effort, orchestration…)": "…" },
  "avatar_image": "data URL or null",
  "memories": [ { "id", "bot_id", "text", "source", "created_at" } ],
  "skills":   [ { "id", "bot_id", "name", "description", "body", "created_at", "updated_at" } ],
  "routines": [ { "id", "name", "prompt", "schedule", "timezone", "enabled", "last_run_at", "created_at" } ],
  "tasks":    [ { "id", "title", "state", "note", "created_at", "updated_at" } ],
  "chat_count": 2, "message_count": 41,
  "truncated": false
}
```

**Parts 1…n – one per chat generation that has messages:**

```json
{
  "archive_id": "bot_x:1700000000000", "status": "deleted", "part": 1, "parts": 3,
  "item_type": "bot", "marion_bot_id": "bot_x",
  "chat": {
    "id": "bot_x:1", "generation": 1, "title": "first user message",
    "started_at": "ISO", "last_message_at": "ISO", "message_count": 20, "truncated": false,
    "transcript": "[ISO] You:\n…\n\n[ISO] Quinn:\n…",
    "messages": [ { "seq": 1, "role": "user | assistant", "from": { "kind": "bot|routine|voice|model", "name": "…" },
                    "text": "…", "at": "ISO", "attachments": [ { "name", "mime", "size" } ] } ]
  }
}
```

`transcript` has the same format as `save_agent_chats`, so the existing indexer can read it. A chat bigger than the
call limit is sent with its oldest messages dropped and `truncated: true` (Marion Agent's local archive keeps all of
it). Attachment **files** are not sent, only their names; they stay in the local archive.

**Restore notice** (no `part`): `{ "archive_id": "…", "status": "restored", "restored_at": "ISO" }`. Mark the
item "Restored in Marion Agent" but keep it in Deleted.

Suggested tables: `life_deleted_items(user_id, archive_id pk, item_type, marion_bot_id, name, job, description,
kind, instructions, profile jsonb, avatar_image, memories jsonb, skills jsonb, routines jsonb, tasks jsonb,
chat_count, message_count, deleted_at, deleted_by, restore_until, status, restored_at, parts_received int, parts int)`
and `life_deleted_item_chats(archive_id, part, chat_id, generation, title, started_at, last_message_at,
message_count, truncated, transcript, messages jsonb, primary key (archive_id, part))`. Show an item in the Deleted
folder once part 0 has arrived; it is complete when `parts_received = parts`.

## Local fallback in Marion Agent

- Outbox table `life_outbox` in Marion Agent's SQLite database (Settings → Marion Life shows what is waiting).
- Deleted archive: `<app data>/Deleted/<bot id>-<deleted at>/archive.json` plus `attachments/`
  (`~/Library/Application Support/Marion Agent/Deleted/` in the Mac app). Written before anything is sent and never
  removed by Marion Agent.
- Everything respects Settings → Marion Life: nothing is sent unless the link is on, and the minute timer only runs
  when "auto sync" is on. "Sync now" always sends what is waiting.
