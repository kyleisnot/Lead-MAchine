-- ============================================================================
-- 20260827_wins_leads: link a win to the company that produced it.
-- ----------------------------------------------------------------------------
-- A win becomes the mirror of a company's Won stage instead of a separate thing the
-- user types twice. Setting a company to Won creates its win, moving it off Won removes
-- that win, and the amount stays editable. Wins typed by hand for deals from outside the
-- tool keep lead_id null and are never touched by a stage change.
--
-- Safe to run more than once: the column add is guarded, the foreign key is created only
-- when it is missing, and both indexes are create-if-not-exists. A second run is a clean
-- no-op, and running it against a database built from supabase/schema.sql changes nothing.
--
-- This migration does NOT touch the leads table.
--
-- Assumes public.wins and public.leads already exist (both ship in supabase/schema.sql).
-- Apply in the Supabase SQL editor, then keep supabase/schema.sql as the master copy
-- (it already contains everything below).
-- ============================================================================

-- ── 1. wins.lead_id: which company this win came from ───────────────────────
-- Nullable on purpose. A null lead_id means "typed by hand", and ON DELETE SET NULL means
-- deleting a company blanks the link rather than erasing the revenue: closed money has to
-- outlive the company record it came from. That is also why this is not ON DELETE CASCADE.
--
-- On Postgres 11+ adding a nullable column with no default is metadata-only (no table
-- rewrite), so this is safe on a live table.
alter table public.wins add column if not exists lead_id bigint;

-- The foreign key, added separately so that a database where someone already added a bare
-- lead_id column by hand still ends up with the constraint. Matching on the column rather
-- than the constraint name, so a differently named existing key is not duplicated.
do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
    where con.conrelid = 'public.wins'::regclass
      and con.contype = 'f'
      and att.attname = 'lead_id'
  ) then
    alter table public.wins
      add constraint wins_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;
end $$;

-- ── 2. indexes ──────────────────────────────────────────────────────────────
-- Every lookup is "this user's win for this company", so the user_id leads the index.
create index if not exists wins_user_lead_idx on public.wins (user_id, lead_id);

-- One linked win per company, per user. Partial, so any number of manual wins (lead_id
-- null) still fit: a NULL is never equal to another NULL, but saying it outright is what
-- makes the intent unmistakable and keeps the index small. This is also what makes the
-- store's setWinForLead() upsert safe to call twice.
create unique index if not exists wins_user_lead_uniq
  on public.wins (user_id, lead_id) where lead_id is not null;
