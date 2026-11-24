-- ============================================================================
-- Marion Life: chats from Marion Agent
-- ============================================================================
-- Adds one table to the Marion Life database:
--
--   life_agent_chats   one row per Marion Agent chat (a Bot's conversation,
--                      until "Start fresh"): which Bot, a title, the full
--                      transcript, how many messages, and when it started and
--                      last changed. Marion Agent on the Mac keeps it up to
--                      date about a minute after each reply.
--
-- Who sees it: your own rows only, and only with the Life app
-- (public.has_app_access('life')), like every Life table. Marion Agent writes
-- with the project's service key, which stays on the Mac.
--
-- Run it once in Supabase -> SQL Editor. Safe to run more than once. It all
-- happens in one go: every change is made, or none.
-- ============================================================================

begin;

create table if not exists public.life_agent_chats (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  marion_bot_id text not null,
  generation integer not null,
  bot_name text not null,
  bot_job text,
  title text not null default '',
  transcript text not null default '',
  message_count integer not null default 0,
  started_at timestamptz not null,
  last_message_at timestamptz not null,
  source text not null default 'marion-agent',
  updated_at timestamptz not null default now(),
  constraint life_agent_chats_transcript_length check (char_length(transcript) <= 500000)
);

create index if not exists life_agent_chats_user_recent on public.life_agent_chats (user_id, last_message_at desc);
create index if not exists life_agent_chats_search on public.life_agent_chats
  using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(transcript, '')));

create or replace function public.life_agent_chats_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists life_agent_chats_touch on public.life_agent_chats;
create trigger life_agent_chats_touch before update on public.life_agent_chats
  for each row execute function public.life_agent_chats_touch();

alter table public.life_agent_chats enable row level security;

drop policy if exists life_agent_chats_own_read on public.life_agent_chats;
create policy life_agent_chats_own_read on public.life_agent_chats
  for select to authenticated
  using (user_id = auth.uid() and public.has_app_access('life'));

drop policy if exists life_agent_chats_own_delete on public.life_agent_chats;
create policy life_agent_chats_own_delete on public.life_agent_chats
  for delete to authenticated
  using (user_id = auth.uid() and public.has_app_access('life'));

grant select, delete on public.life_agent_chats to authenticated;

commit;
