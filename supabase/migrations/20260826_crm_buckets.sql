-- ============================================================================
-- 20260826_crm_buckets: CRM buckets + follow-ups, and the global business directory.
-- ----------------------------------------------------------------------------
-- Safe to run more than once: every statement is guarded (add column if not exists,
-- create table if not exists, create index if not exists, create or replace, and
-- do-blocks for the things Postgres has no "if not exists" for).
--
-- Apply in the Supabase SQL editor, then keep supabase/schema.sql as the master copy
-- (it already contains everything below).
-- ============================================================================

-- ── 1. leads: which bucket a lead lives in, and its follow-up date ──────────
-- bucket values: qualified | inactive | has_website.
-- follow_up_at null = the bucket's working list; set = its follow-up list (soonest first).
-- Both are added with a default / as nullable, so existing rows need no backfill and the
-- ALTER is metadata-only on Postgres 11+ (no table rewrite, safe on a live table).
alter table public.leads add column if not exists bucket       text not null default 'qualified';
alter table public.leads add column if not exists follow_up_at timestamptz;

-- Deliberately no CHECK constraint on bucket: the store normalizes unknown values to
-- 'qualified' on read, so a stray value can never hide a lead, and adding a constraint to
-- a live table risks failing on data we cannot inspect from here.

create index if not exists leads_user_bucket_idx   on public.leads (user_id, bucket);
create index if not exists leads_user_followup_idx on public.leads (user_id, follow_up_at);

-- ── 2. business_directory: the operator's global mega directory ─────────────
-- EVERY business ever scanned by ANY user, deduped on (source, external_id).
-- NO user_id, on purpose: one global list the operator owns, so other services can be
-- sold into it later.
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

-- ── 3. Lock it to the service role ──────────────────────────────────────────
-- RLS on with ZERO policies denies every client JWT outright. The service-role key
-- bypasses RLS, so data/store.js recordDirectory() is the only way in.
alter table public.business_directory enable row level security;

-- Enforce "zero policies" on a re-run: drop anything that ever got added here.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'business_directory'
  loop
    execute format('drop policy if exists %I on public.business_directory', p.policyname);
  end loop;
end $$;

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

-- ── 4. Re-scan merge trigger ────────────────────────────────────────────────
-- PostgREST upserts always send the full column list, so without this a thinner re-scan
-- would null out a phone or email we already had. Keeping the merge in the DB lets
-- recordDirectory() stay a plain .upsert().
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
