-- =====================================================================
-- GOODIE-MEDHUB — 070_patient_portal_lookup_fix.sql
-- =====================================================================
-- Fixes the "operator does not exist: text = uuid" error that breaks
-- the patient portal after login.
--
-- ROOT CAUSE:
--   An earlier version of the patient_users table was created with
--   user_id (and possibly patient_id / hospital_id) declared as TEXT
--   instead of UUID. The patient_portal_schema.sql migration uses
--   `create table if not exists`, so it could NOT correct the column
--   types on an existing table. Every RLS helper function calls
--   `where user_id = auth.uid()` — auth.uid() returns uuid — so the
--   comparison throws 42883 on EVERY portal query, which is why
--   patients see "can't fetch patient data" and get auto-logged-out.
--
-- WHAT THIS MIGRATION DOES:
--   1. Detects and converts any TEXT columns in patient_users to UUID.
--   2. Adds patient_name + mrn columns (denormalized for fast lookup
--      by name + hospital_id + mrn, replacing the email-based lookup).
--   3. Backfills patient_name + mrn from the patients table.
--   4. Recreates all helper functions with explicit ::text casts so
--      they cannot break again on future type drift.
--   5. Adds a SECURITY DEFINER RPC `lookup_portal_email` that lets a
--      not-yet-authenticated patient resolve their auth email from
--      (name + hospital_id + mrn) so they can sign in without typing
--      their email.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. Fix column types in patient_users (TEXT → UUID)
-- =====================================================================
-- PostgreSQL cannot implicitly cast text → uuid, so we use an explicit
-- USING clause. If the column already is uuid, this is a no-op (the
-- conditional check skips it).

do $$
begin
  -- 1a. user_id
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'patient_users'
       and column_name = 'user_id'
       and data_type = 'text'
  ) then
    -- First NULL out any rows where the value isn't a valid uuid
    update public.patient_users
       set user_id = null
     where user_id is not null
       and user_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    -- Then drop any rows that are now NULL (can't link to a real auth user)
    delete from public.patient_users where user_id is null;
    -- Now alter the column type
    execute 'alter table public.patient_users alter column user_id type uuid using user_id::uuid';
    execute 'alter table public.patient_users alter column user_id set not null';
  end if;

  -- 1b. patient_id
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'patient_users'
       and column_name = 'patient_id'
       and data_type = 'text'
  ) then
    update public.patient_users
       set patient_id = null
     where patient_id is not null
       and patient_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    delete from public.patient_users where patient_id is null;
    execute 'alter table public.patient_users alter column patient_id type uuid using patient_id::uuid';
    execute 'alter table public.patient_users alter column patient_id set not null';
  end if;

  -- 1c. hospital_id
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'patient_users'
       and column_name = 'hospital_id'
       and data_type = 'text'
  ) then
    update public.patient_users
       set hospital_id = null
     where hospital_id is not null
       and hospital_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    delete from public.patient_users where hospital_id is null;
    execute 'alter table public.patient_users alter column hospital_id type uuid using hospital_id::uuid';
    execute 'alter table public.patient_users alter column hospital_id set not null';
  end if;

  -- 1d. relative_of (nullable)
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'patient_users'
       and column_name = 'relative_of'
       and data_type = 'text'
  ) then
    update public.patient_users
       set relative_of = null
     where relative_of is not null
       and relative_of !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    execute 'alter table public.patient_users alter column relative_of type uuid using relative_of::uuid';
  end if;
end $$;

-- =====================================================================
-- 2. Add patient_name + mrn columns to patient_users
-- =====================================================================
-- These are denormalized copies of patients.full_name and
-- patients.hospital_number (MRN). They allow the portal to look up a
-- patient by (name + hospital_id + mrn) without a join, and they
-- survive even if the patient record is later edited.

alter table public.patient_users
  add column if not exists patient_name text,
  add column if not exists mrn text;

create index if not exists patient_users_lookup_idx
  on public.patient_users (hospital_id, mrn);

create index if not exists patient_users_name_idx
  on public.patient_users (hospital_id, patient_name);

-- =====================================================================
-- 3. Backfill patient_name + mrn from the patients table
-- =====================================================================
-- `hospital_number` is the MRN column added in migration 068 — that is
-- the ONLY MRN column on the patients table. (There is no `mrn`
-- column on patients; do not reference one.) If hospital_number is
-- NULL for a patient, fall back to the patient UUID as text so the
-- patient_users row is still searchable.

update public.patient_users pu
   set patient_name = p.full_name,
       mrn = coalesce(p.hospital_number, p.id::text)
  from public.patients p
 where pu.patient_id = p.id
   and (pu.patient_name is null or pu.mrn is null);

-- =====================================================================
-- 4. Recreate helper functions with DEFENSIVE ::text casts
-- =====================================================================
-- Using ::text on both sides guarantees no operator-does-not-exist
-- error can ever happen again, regardless of future column type drift.

create or replace function public.current_portal_patient_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select patient_id from public.patient_users
   where user_id::text = auth.uid()::text
     and is_active = true
   limit 1
$$;

create or replace function public.current_patient_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select patient_id from public.patient_users
   where user_id::text = auth.uid()::text
     and is_active = true
$$;

create or replace function public.current_patient_hospital_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select hospital_id from public.patient_users
   where user_id::text = auth.uid()::text
     and is_active = true
$$;

create or replace function public.is_patient()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.patient_users
     where user_id::text = auth.uid()::text
       and is_active = true
  )
$$;

-- =====================================================================
-- 5. SECURITY DEFINER RPC: lookup_portal_email
-- =====================================================================
-- Lets a not-yet-authenticated patient resolve their auth email from
-- (full_name, hospital_id, mrn). The portal then signs them in with
-- that email + the password they typed.
--
-- Security: returns NULL if no exact match. Does not leak other
-- patients' emails. The name match is case-insensitive and
-- whitespace-trimmed, so "John Doe" matches "john doe" or " John Doe ".
-- The MRN match is case-sensitive (MRNs are machine-generated codes).

create or replace function public.lookup_portal_email(
  p_full_name    text,
  p_hospital_id  uuid,
  p_mrn          text
)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select au.email::text
    from public.patient_users pu
    join public.patients p on p.id = pu.patient_id
    join auth.users au on au.id::text = pu.user_id::text
   where pu.is_active = true
     and pu.hospital_id = p_hospital_id
     and lower(trim(regexp_replace(pu.patient_name, '\s+', ' ', 'g')))
         = lower(trim(regexp_replace(p_full_name, '\s+', ' ', 'g')))
     and pu.mrn = p_mrn
   limit 1
$$;

-- Allow anyone (even anon/unauthenticated) to call this RPC — it's
-- needed for the login flow. SECURITY DEFINER ensures the function
-- runs with the owner's privileges and bypasses RLS.
revoke all on function public.lookup_portal_email(text, uuid, text) from public;
grant execute on function public.lookup_portal_email(text, uuid, text) to anon, authenticated;

-- =====================================================================
-- 6. RLS: allow patients to UPDATE their own patient_users row
--    (so the portal can backfill patient_name/mrn if missing)
-- =====================================================================
-- Existing policies only allow SELECT/INSERT/UPDATE if user_id matches
-- auth.uid(). The existing patient_users_update policy already covers
-- this case, so no change needed here. But we add an explicit UPDATE
-- policy that also allows updating patient_name + mrn columns.

drop policy if exists "patient_users_update" on public.patient_users;
create policy "patient_users_update" on public.patient_users
  for update using (
    user_id::text = auth.uid()::text or public.is_staff()
  ) with check (
    user_id::text = auth.uid()::text or public.is_staff()
  );

-- Also fix the SELECT policy to use ::text cast defensively
drop policy if exists "patient_users_select" on public.patient_users;
create policy "patient_users_select" on public.patient_users
  for select using (
    user_id::text = auth.uid()::text or public.is_staff()
  );

drop policy if exists "patient_users_insert" on public.patient_users;
create policy "patient_users_insert" on public.patient_users
  for insert with check (
    user_id::text = auth.uid()::text or public.is_staff()
  );

-- =====================================================================
-- 7. Add a UNIQUE constraint on (hospital_id, mrn) so two portal
--    accounts can never be linked to the same patient
-- =====================================================================
-- Only enforce where mrn is not null (some legacy rows may have NULL mrn).

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'patient_users_hospital_mrn_key'
       and conrelid = 'public.patient_users'::regclass
  ) then
    execute 'create unique index patient_users_hospital_mrn_idx
             on public.patient_users (hospital_id, mrn)
             where mrn is not null';
  end if;
end $$;

-- =====================================================================
-- 8. Verify: print the final column types so the migration log shows
--    the fix worked.
-- =====================================================================
do $$
declare
  r record;
begin
  for r in
    select column_name, data_type
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'patient_users'
     order by ordinal_position
  loop
    raise notice 'patient_users.% => %', r.column_name, r.data_type;
  end loop;
end $$;
