-- ============================================================================
-- 20260827_accounts: account settings on profiles, support messages, token requests.
-- ----------------------------------------------------------------------------
-- Safe to run more than once: every statement is guarded (add column if not exists,
-- create table if not exists, create index if not exists, and do-blocks for the things
-- Postgres has no "if not exists" for). A second run is a clean no-op.
--
-- This migration does NOT touch the leads table.
--
-- Apply in the Supabase SQL editor, then keep supabase/schema.sql as the master copy
-- (it already contains everything below).
-- ============================================================================

-- ── 1. profiles: the account-settings fields ────────────────────────────────
-- All nullable except the onboarding flag, so existing rows need no backfill. On
-- Postgres 11+ adding a column with a constant default is metadata-only (no table
-- rewrite), so this is safe on a live table.
--
-- default_city / default_state / default_niche prefill the search form; they are a
-- convenience, never a filter, so a null just means "no prefill".
alter table public.profiles add column if not exists full_name     text;
alter table public.profiles add column if not exists agency_name   text;
alter table public.profiles add column if not exists phone         text;
alter table public.profiles add column if not exists default_city  text;
alter table public.profiles add column if not exists default_state text;
alter table public.profiles add column if not exists default_niche text;
alter table public.profiles add column if not exists onboarding_dismissed boolean not null default false;

-- ── 2. support_messages: a user writes in, the operator answers ─────────────
-- status: open (waiting on us) | answered (admin_reply is set) | closed.
-- Deliberately no CHECK constraint on status, matching how leads.bucket is handled:
-- an unexpected value must never make a message unreadable.
create table if not exists public.support_messages (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subject     text not null,
  body        text not null,
  status      text not null default 'open',      -- open | answered | closed
  created_at  timestamptz not null default now(),
  admin_reply text,
  replied_at  timestamptz
);

-- The user's own list is always "mine, newest first"; the operator's queue filters on status.
create index if not exists support_messages_user_idx   on public.support_messages (user_id, created_at desc);
create index if not exists support_messages_status_idx on public.support_messages (status);

alter table public.support_messages enable row level security;

-- A user can only ever see or write their own messages. The service-role client the
-- admin panel uses bypasses RLS, which is how the operator reads and replies to all of them.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'support_messages' and policyname = 'own messages'
  ) then
    create policy "own messages" on public.support_messages
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- ── 3. token_requests: "I need more tokens" ─────────────────────────────────
-- tokens_requested is what the user asked for; tokens_granted / price_usd / admin_note
-- are what the operator actually decided, and stay null until then.
create table if not exists public.token_requests (
  id               bigint generated always as identity primary key,
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tokens_requested integer not null,
  note             text not null default '',
  status           text not null default 'pending',   -- pending | approved | declined
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  tokens_granted   integer,
  price_usd        numeric,
  admin_note       text
);

create index if not exists token_requests_user_idx   on public.token_requests (user_id, created_at desc);
create index if not exists token_requests_status_idx on public.token_requests (status);

alter table public.token_requests enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'token_requests' and policyname = 'own requests'
  ) then
    create policy "own requests" on public.token_requests
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;
