-- =====================================================================
-- GOODIE-MEDHUB — 109_diagnose_rls_42501_sync_failures.sql
-- =====================================================================
-- PURPOSE
--   Diagnostic + (optional) cleanup for the sync-queue errors:
--     "new row violates row-level security policy (USING expression)
--      for table 'patients'"
--     "new row violates row-level security policy for table
--      'pharmacy_requests'"
--   (Postgres error code 42501)
--
--   These errors mean a queued offline row was rejected by the table's
--   INSERT RLS policy. The most common root cause is that the logged-in
--   user's own `profiles.hospital_id` is NULL or does not match the
--   `hospital_id` on the row being inserted — because the policy checks
--   `hospital_id = public.current_hospital_id()`, and
--   current_hospital_id() reads profiles.hospital_id for auth.uid().
--   If that is NULL, the equality is false → 42501.
--
--   NOTE: This file is run in the Supabase SQL editor (or psql) as the
--   service_role / postgres superuser. The SELECTs are read-only
--   diagnostics. The DELETE at the bottom is OPTIONAL and clearly
--   marked — run it only if you want to remove the specific orphaned
--   stuck rows whose ids appear in your sync-queue UI.
--
--   Safe to run as-is. Nothing is destructive until you uncomment the
--   final DELETE block.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Show the CURRENT database user and what current_hospital_id()
--    resolves to FOR YOU right now. If current_hospital_id() returns
--    NULL here, every INSERT policy that uses it will fail with 42501
--    for that user — that is the root cause.
-- ---------------------------------------------------------------------
select
  auth.uid()                                       as auth_uid,
  current_user                                     as db_user,
  public.current_hospital_id()                    as current_hospital_id,
  public.current_user_hospital_id()                as current_user_hospital_id,
  public.is_hospital_writable_role()               as is_writable_role,
  public.is_hospital_admin()                       as is_hospital_admin;

-- ---------------------------------------------------------------------
-- 2. Your own profile row — is hospital_id set?
--    If hospital_id IS NULL here, that is the bug: fix it by updating
--    the profile row to the correct hospital_id, e.g.
--      update public.profiles set hospital_id = '<correct-hospital-uuid>'
--       where id = '<your-auth-uid>';
-- ---------------------------------------------------------------------
select
  id,
  full_name,
  role,
  hospital_id,
  (hospital_id is null) as hospital_id_is_null
from public.profiles
where id = auth.uid();

-- ---------------------------------------------------------------------
-- 3. Any OTHER profiles with a NULL hospital_id (these users will ALL
--    hit the same 42501 on every INSERT they trigger).
-- ---------------------------------------------------------------------
select id, full_name, role, hospital_id, created_at
from public.profiles
where hospital_id is null
order by created_at desc
limit 50;

-- ---------------------------------------------------------------------
-- 4. The specific stuck rows from your sync queue.
--    Replace the two ids with the ones shown in your UI:
--      patients           a4524582-08c4-4979-b317-aa86bd92c0a0
--      pharmacy_requests  bd00a88a-f45f-4ecd-9f1b-71fa1bead188
--    This shows whether the row already exists on the server, and what
--    hospital_id it carries.
-- ---------------------------------------------------------------------
select 'patients' as table_name, id, hospital_id, full_name, created_at
from public.patients
where id in ('a4524582-08c4-4979-b317-aa86bd92c0a0')

union all

select 'pharmacy_requests', id, hospital_id, patient_name, created_at
from public.pharmacy_requests
where id in ('bd00a88a-f45f-4ecd-9f1b-71fa1bead188');

-- ---------------------------------------------------------------------
-- 5. Inspect the LIVE INSERT policies on both tables so you can see
--    exactly what the WITH CHECK expression is.
-- ---------------------------------------------------------------------
select
  schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('patients', 'pharmacy_requests')
  and cmd in ('insert', 'update')
order by tablename, cmd;

-- ---------------------------------------------------------------------
-- 6. (OPTIONAL) Clean up the two stuck rows on the server.
--    ONLY run this if the rows are confirmed orphans (section 4 shows
--    they exist with a wrong/NULL hospital_id, and you do NOT want
--    them). The client-side copy will be auto-discarded by the new
--    retry cap in useOfflineTable.js after 3 attempts regardless.
--
--    Uncomment the block below to delete the specific orphaned rows:
--
-- delete from public.pharmacy_requests
--  where id = 'bd00a88a-f45f-4ecd-9f1b-71fa1bead188';
--
-- delete from public.patients
--  where id = 'a4524582-08c4-4979-b317-aa86bd92c0a0';
-- ---------------------------------------------------------------------
