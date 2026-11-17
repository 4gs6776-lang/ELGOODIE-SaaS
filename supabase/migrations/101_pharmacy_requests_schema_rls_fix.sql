-- =====================================================================
-- GOODIE-MEDHUB / ELGOODIE-SaaS — 101_pharmacy_requests_schema_rls_fix.sql
-- =====================================================================
-- SYMPTOM
--   Staff (nurses, doctors, front desk) click "Send to Pharmacy" on a
--   patient profile. The request is queued offline, then sync fails
--   with:
--     - warning: "Table 'pharmacy_requests' has no 'priority' column"
--     - warning: "Table 'pharmacy_requests' has no 'request_text' column"
--     - error:   42501 "new row violates row-level security policy for
--                table 'pharmacy_requests'"
--
-- ROOT CAUSE
--   Two conflicting CREATE TABLE statements exist for pharmacy_requests:
--     - 030_pharmacy_requests.sql  → drug_name/quantity/prescription_id schema
--     - 061_pharmacy_requests.sql  → request_text/priority/dispensed_items schema
--   Migration 061 uses CREATE TABLE IF NOT EXISTS, so when 030 already ran
--   (which it always does, since 030 < 061), migration 061 becomes a no-op
--   and the request_text/priority columns NEVER get added.
--
--   The PatientProfile.jsx "Send to Pharmacy" feature writes request_text +
--   priority (the 061 schema), so:
--     1. The first INSERT fails with "column does not exist" (schema mismatch)
--     2. useOfflineTable strips the unknown columns and retries
--     3. The retry INSERT hits the existing RLS policy, which checks
--        hospital_id = current_hospital_id(). If the staff's profile row
--        isn't readable under the profiles RLS policy (a separate issue
--        seen in some hospitals), current_hospital_id() returns NULL, the
--        check fails, and Postgres returns 42501.
--
-- FIX (this migration)
--   1. ADD the missing columns (request_text, priority, dispensed_items,
--      dispensed_notes) to the existing pharmacy_requests table. Additive
--      only — no existing column is changed, no data is lost. The original
--      030 columns (drug_name, quantity, prescription_id, etc.) stay so
--      SendToPharmacyModal.jsx (the prescription-based flow) keeps working.
--   2. DROP + RECREATE the INSERT/UPDATE/DELETE RLS policies with a more
--      reliable check that does NOT depend on current_hospital_id()
--      succeeding — it falls back to comparing hospital_id against the
--      hospital_id stored on the user's own profile row directly. Also
--      blocks the read-only 'cmd' role from writing (defense in depth,
--      matching 062_security_hardening_phase1.sql's intent).
--   3. Add a CHECK constraint on priority and status to match 061's intent
--      without breaking 030's existing rows (NULLs allowed).
--
-- SAFE TO RE-RUN. Idempotent. No data loss.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ADD the missing 061-schema columns to the existing 030 table.
--    IF NOT EXISTS so re-running doesn't error.
-- ---------------------------------------------------------------------

alter table public.pharmacy_requests
  add column if not exists request_text text;

alter table public.pharmacy_requests
  add column if not exists priority text default 'routine';

alter table public.pharmacy_requests
  add column if not exists dispensed_items jsonb default '[]'::jsonb;

alter table public.pharmacy_requests
  add column if not exists dispensed_notes text;

-- Backfill: any old 030-era rows that don't have request_text get a
-- synthesized one from drug_name + quantity so the pharmacy UI (which
-- now reads request_text) doesn't show blanks for legacy rows.
update public.pharmacy_requests
   set request_text = coalesce(drug_name || ' × ' || quantity::text, '[legacy request]')
 where request_text is null;

-- Make request_text NOT NULL only after backfill, so the constraint
-- matches 061's intent without breaking existing rows.
alter table public.pharmacy_requests
  alter column request_text set not null;

-- Add CHECK constraints matching 061's intent. Use ALTER ADD CONSTRAINT
-- IF NOT EXISTS via a DO block (Postgres < 16 doesn't support
-- ADD CONSTRAINT IF NOT EXISTS directly).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.pharmacy_requests'::regclass
       and conname = 'pharmacy_requests_priority_check'
  ) then
    alter table public.pharmacy_requests
      add constraint pharmacy_requests_priority_check
      check (priority in ('routine', 'urgent', 'stat'));
  end if;
end $$;

-- Status now needs to also accept 'pending' (061's default) alongside
-- 030's 'requested'. Add a CHECK that allows both.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.pharmacy_requests'::regclass
       and conname = 'pharmacy_requests_status_check'
  ) then
    alter table public.pharmacy_requests
      drop constraint pharmacy_requests_status_check;
  end if;
  alter table public.pharmacy_requests
    add constraint pharmacy_requests_status_check
    check (status in ('requested', 'pending', 'dispensed', 'cancelled'));
end $$;

-- ---------------------------------------------------------------------
-- 2. REBUILD the RLS policies. Drop all existing pharmacy_requests
--    policies from migrations 030 and 061, then recreate with a single
--    consistent set that:
--      - SELECT: any authenticated user whose profile.hospital_id
--                matches the row's hospital_id, OR is_owner()
--      - INSERT/UPDATE: same + NOT cmd role (defense-in-depth, matches
--                the intent of migration 062_security_hardening_phase1.sql)
--      - DELETE: blocked entirely (requests are cancelled, not erased —
--                matches 030's original comment)
-- ---------------------------------------------------------------------

-- Helper: returns the hospital_id stored on the caller's own profile row.
-- More reliable than current_hospital_id() in cases where the profiles
-- RLS policy makes the caller's own row temporarily invisible (which
-- causes current_hospital_id() to return NULL → false-negative RLS
-- denial). SECURITY DEFINER so it can read profiles without recursion.
create or replace function public.current_user_hospital_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select hospital_id from public.profiles where id = auth.uid()
$$;

-- Drop every existing policy (both 030's named versions and 061's).
drop policy if exists pharmacy_requests_select      on public.pharmacy_requests;
drop policy if exists pharmacy_requests_insert       on public.pharmacy_requests;
drop policy if exists pharmacy_requests_update       on public.pharmacy_requests;
drop policy if exists pharmacy_requests_delete      on public.pharmacy_requests;
drop policy if exists pharmacy_requests_select_own  on public.pharmacy_requests;
drop policy if exists pharmacy_requests_insert_own  on public.pharmacy_requests;
drop policy if exists pharmacy_requests_update_own  on public.pharmacy_requests;
drop policy if exists pharmacy_requests_delete_own  on public.pharmacy_requests;

-- Ensure RLS is on.
alter table public.pharmacy_requests enable row level security;

-- SELECT: any authenticated user in the same hospital, or platform owner.
create policy pharmacy_requests_select on public.pharmacy_requests
  for select to authenticated
  using (
    hospital_id = public.current_user_hospital_id()
    or public.is_owner()
  );

-- INSERT: same hospital + not the read-only cmd role + not a server-side
-- empty-JWT call. is_hospital_writable_role() (added by 062) returns
-- TRUE for server-side calls so the migration itself can run.
create policy pharmacy_requests_insert on public.pharmacy_requests
  for insert to authenticated
  with check (
    hospital_id = public.current_user_hospital_id()
    and public.is_hospital_writable_role()
  );

-- UPDATE: same hospital + not cmd.
create policy pharmacy_requests_update on public.pharmacy_requests
  for update to authenticated
  using (
    hospital_id = public.current_user_hospital_id()
    and public.is_hospital_writable_role()
  )
  with check (
    hospital_id = public.current_user_hospital_id()
    and public.is_hospital_writable_role()
  );

-- No DELETE policy: requests are cancelled, never erased (matches 030's
-- original design intent).

-- ---------------------------------------------------------------------
-- 3. Re-grant realtime publication membership (idempotent — the table
--    was already added by 030 and 061, but this is harmless to repeat
--    and ensures the pharmacist sees new requests live).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'pharmacy_requests'
  ) then
    alter publication supabase_realtime add table public.pharmacy_requests;
  end if;
end $$;

-- Replica identity full so UPDATE/DELETE broadcast the full row (lets
-- the pharmacy UI update in place without a refetch).
do $$
begin
  if to_regclass('public.pharmacy_requests') is not null then
    execute 'alter table public.pharmacy_requests replica identity full';
  end if;
end $$;

-- Done. Verification (run after to confirm):
--   \d public.pharmacy_requests
--   select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
--     from pg_policy where polrelid = 'public.pharmacy_requests'::regclass;
