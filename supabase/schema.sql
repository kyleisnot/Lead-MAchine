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

-- ── profiles: one row per user — their plan/tier + monthly token allotment, and the
--    account settings they fill in themselves (all nullable, all optional) ──
create table if not exists public.profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  email                    text,
  tier                     text    not null default 'trial',      -- trial | starter | pro
  monthly_token_allotment  integer not null default 0,            -- 0 = no plan yet (blocked)
  created_at               timestamptz not null default now(),
  full_name                text,
  agency_name              text,
  phone                    text,
  default_city             text,                                  -- prefills the search form
  default_state            text,
  default_niche            text,
  onboarding_dismissed     boolean not null default false
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
  bucket         text not null default 'qualified', -- qualified | inactive | has_website
  follow_up_at   timestamptz,                       -- null = the bucket's working list
  unique (user_id, source, external_id)            -- dedup is PER user, not global
);
create index if not exists leads_user_status_idx on public.leads (user_id, status);
create index if not exists leads_user_dedup_idx  on public.leads (user_id, dedup_key);
create index if not exists leads_user_saved_idx  on public.leads (user_id, saved);
create index if not exists leads_user_bucket_idx on public.leads (user_id, bucket);
create index if not exists leads_user_followup_idx on public.leads (user_id, follow_up_at);

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
-- A win is one of two things:
--   linked  → lead_id points at a saved company, and the win mirrors that company's Won stage.
--             Setting a company to Won creates it; moving it off Won removes it.
--   manual  → lead_id is null, a deal typed in by hand for work from outside the tool.
-- lead_id is deliberately nullable with ON DELETE SET NULL, not cascade: deleting a company
-- must blank the link and keep the win, because closed revenue has to outlive the record it
-- came from.
create table if not exists public.wins (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_name text not null,
  amount      numeric,
  note        text not null default '',
  created_at  timestamptz not null default now(),
  lead_id     bigint references public.leads(id) on delete set null
);
create index if not exists wins_user_idx on public.wins (user_id, created_at desc);
create index if not exists wins_user_lead_idx on public.wins (user_id, lead_id);
-- One linked win per company, per user. Partial, so any number of manual wins (lead_id null)
-- still fit: a NULL is not equal to another NULL, but being explicit is what makes the intent
-- unmistakable and keeps the index small.
create unique index if not exists wins_user_lead_uniq on public.wins (user_id, lead_id) where lead_id is not null;
alter table public.wins enable row level security;
create policy "own wins" on public.wins
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- business_directory: the operator's mega directory.
-- ----------------------------------------------------------------------------
-- EVERY business ever scanned by ANY user, deduped on (source, external_id).
-- It has NO user_id on purpose: this is one global list the operator owns, so other
-- services can be sold into it later. RLS is ON with ZERO policies, which denies every
-- client JWT outright; only the service-role key (which bypasses RLS) can read or write it.
-- ============================================================================
create table if not exists public.business_directory (
  source       text not null,
  external_id  text not null,
  name         text,
  niche        text,
  city         text,
  state        text,
  phone        text,
  email        text,
  website      text,
  has_website  boolean,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  primary key (source, external_id)
);
create index if not exists directory_site_idx  on public.business_directory (has_website);
create index if not exists directory_place_idx on public.business_directory (city, state);

alter table public.business_directory enable row level security;
-- No policies here, and none should ever be added. RLS with zero policies = deny all.

-- Belt and braces on top of RLS: no table grants for the client roles either.
-- Guarded because those roles only exist on a Supabase project.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.business_directory from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.business_directory from authenticated';
  end if;
end $$;

-- Re-scan merge. PostgREST upserts always send the full column list, so without this a
-- thinner re-scan would null out a phone or email we already had. Running it as a BEFORE
-- UPDATE trigger keeps that logic in the DB, where a plain .upsert() picks it up for free.
create or replace function public.business_directory_merge()
returns trigger language plpgsql as $$
begin
  new.name        := coalesce(nullif(new.name, ''), old.name);
  new.niche       := coalesce(nullif(new.niche, ''), old.niche);
  new.city        := coalesce(nullif(new.city, ''), old.city);
  new.state       := coalesce(nullif(new.state, ''), old.state);
  new.phone       := coalesce(nullif(new.phone, ''), old.phone);
  new.email       := coalesce(nullif(new.email, ''), old.email);
  new.website     := coalesce(nullif(new.website, ''), old.website);
  new.has_website := coalesce(new.has_website, old.has_website);
  new.first_seen  := old.first_seen;   -- first_seen never moves
  new.last_seen   := now();
  return new;
end; $$;

drop trigger if exists business_directory_merge_trg on public.business_directory;
create trigger business_directory_merge_trg
  before update on public.business_directory
  for each row execute function public.business_directory_merge();

-- ============================================================================
-- support_messages + token_requests: the two things a user sends the operator.
-- ----------------------------------------------------------------------------
-- Both are own-rows-only under RLS. The admin panel reads and answers them with the
-- service-role client, which bypasses RLS.
-- ============================================================================

-- ── support_messages: a user writes in, the operator answers ──
-- Deliberately no CHECK constraint on status, matching leads.bucket: an unexpected
-- value must never make a message unreadable.
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
create index if not exists support_messages_user_idx   on public.support_messages (user_id, created_at desc);
create index if not exists support_messages_status_idx on public.support_messages (status);

alter table public.support_messages enable row level security;

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

-- ── token_requests: "I need more tokens" ──
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
