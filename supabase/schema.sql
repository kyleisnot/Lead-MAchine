-- ============================================================================
-- Lead Machine — Supabase (Postgres) schema
-- ----------------------------------------------------------------------------
-- Multi-tenant: every row is owned by a user (user_id = auth.users.id) and
-- Row Level Security guarantees each user can ONLY ever see/change their own
-- rows. This is the whole point of "made for Supabase, multiple users".
--
-- To connect later:
--   1. Create a project at https://supabase.com
--   2. SQL Editor → paste + run this whole file
--   3. Put the project URL + keys in .env and set DATA_PROVIDER=supabase
-- ============================================================================

-- ── profiles: one row per user, holds their plan/tier + monthly token allotment ──
create table if not exists public.profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  email                    text,
  tier                     text    not null default 'trial',      -- trial | starter | pro
  monthly_token_allotment  integer not null default 0,            -- 0 = no plan yet (blocked)
  created_at               timestamptz not null default now()
);

-- ── leads: the prospects surfaced to a user + their CRM state ──
create table if not exists public.leads (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source         text not null,
  external_id    text not null,
  name           text,
  category       text,
  city           text,
  state          text,
  phone          text,
  email          text,
  website        text,
  lead_json      jsonb,
  site_data      jsonb,
  preview_path   text,
  email_subject  text,
  email_body     text,
  status         text not null default 'new',      -- new | preview_built | sent | skipped
  created_at     timestamptz not null default now(),
  contacted_at   timestamptz,
  saved          boolean not null default false,
  saved_at       timestamptz,
  crm_stage      text not null default 'New',
  notes          text not null default '',
  dismissed      boolean not null default false,
  contacted_on   timestamptz,
  activity_verdict    text,
  activity_verdict_at timestamptz,
  activity_seen  text,
  dedup_key      text,
  unique (user_id, source, external_id)            -- dedup is PER user, not global
);
create index if not exists leads_user_status_idx on public.leads (user_id, status);
create index if not exists leads_user_dedup_idx  on public.leads (user_id, dedup_key);
create index if not exists leads_user_saved_idx  on public.leads (user_id, saved);

-- ── checked_businesses: the "brain" — everything ever scanned, so we never re-check ──
create table if not exists public.checked_businesses (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source       text not null,
  external_id  text not null,
  name         text,
  has_website  boolean,
  niche        text,
  city         text,
  state        text,
  checked_at   timestamptz not null default now(),
  primary key (user_id, source, external_id)
);
create index if not exists checked_user_site_idx on public.checked_businesses (user_id, has_website);

-- ── searches: cached search results (so repeat searches are free) ──
create table if not exists public.searches (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key         text not null,
  data        jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- ── app_state: small per-user key/value store (last search, etc.) ──
create table if not exists public.app_state (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key      text not null,
  value    jsonb,
  primary key (user_id, key)
);

-- ── usage_log: per-user metering (searches, builds, AI $) → drives token accounting ──
create table if not exists public.usage_log (
  id       bigint generated always as identity primary key,
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind     text,
  cost     numeric not null default 0,
  at       timestamptz not null default now()
);
create index if not exists usage_user_at_idx on public.usage_log (user_id, at);

-- ── manual_followups: a user's own reminders ──
create table if not exists public.manual_followups (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null,
  note        text not null default '',
  due         date,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security — the guarantee that user A never sees user B's data.
-- ============================================================================
alter table public.profiles           enable row level security;
alter table public.leads              enable row level security;
alter table public.checked_businesses enable row level security;
alter table public.searches           enable row level security;
alter table public.app_state          enable row level security;
alter table public.usage_log          enable row level security;
alter table public.manual_followups   enable row level security;

-- profiles: a user can read/update only their own profile.
create policy "own profile" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- every other table: a user can do anything ONLY to rows they own.
create policy "own rows" on public.leads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.checked_businesses
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.searches
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.app_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.usage_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.manual_followups
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- Auto-create a profile (trial tier) whenever someone signs up.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, tier, monthly_token_allotment)
  values (new.id, new.email, 'unassigned', 0)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── wins: a user's closed deals — their trophy case, and the operator's "did they sell" signal ──
create table if not exists public.wins (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_name text not null,
  amount      numeric,
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists wins_user_idx on public.wins (user_id, created_at desc);
alter table public.wins enable row level security;
create policy "own wins" on public.wins
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
