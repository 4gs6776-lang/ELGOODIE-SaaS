-- =====================================================================
-- GOODIE-MEDHUB — 110_rls_owner_bypass_patients_pharmacy_requests.sql
-- =====================================================================
-- SYMPTOM
--   Staff click "Send to Pharmacy" on a patient profile (or save any
--   edit to a patient). The offline sync queue then fails with:
--     ERROR 42501: new row violates row-level security policy
--     (USING expression) for table "patients"
--     ERROR 42501: new row violates row-level security policy
--     for table "pharmacy_requests"
--   The "Sync queue" UI shows the rows stuck with Retry/Skip, and
--   Retry always fails again.
--
-- ROOT CAUSE
--   An OWNER logs in with `profiles.hospital_id = NULL` by design —
--   owners switch hospitals via a localStorage selection in the
--   dashboard, NOT via their profile row (see context/AuthContext.jsx:
--   "owner hospital selection ... profile.hospital_id is null").
--
--   The RLS helper current_hospital_id() / current_user_hospital_id()
--   both read `profiles.hospital_id` for auth.uid(), so for an owner
--   they return NULL.
--
--   Migration 003 wrote every table's INSERT/UPDATE policy as:
--       hospital_id = current_hospital_id() OR public.is_owner()
--   so an owner was always allowed (the OR is_owner() rescued the
--   NULL comparison). 129 policy clauses in 003 use this pattern.
--
--   But two later migrations re-created the policies for two tables
--   using an AND-chain that BURIED the is_owner() check behind the
--   failing hospital_id comparison, so it could never rescue owners:
--
--     • 062_security_hardening_phase1.sql (lines 119-142) rewrote
--       patients INSERT/UPDATE/DELETE as:
--         hospital_id = current_hospital_id()
--         AND is_hospital_writable_role()
--         AND ( is_owner() OR role in (...) )
--       For an owner, current_hospital_id() is NULL → the first AND
--       clause is false → the whole expression is false → 42501,
--       EVEN THOUGH is_owner() is true. The owner bypass is dead.
--
--     • 101_pharmacy_requests_schema_rls_fix.sql (lines 162-179)
--       rewrote pharmacy_requests INSERT/UPDATE as:
--         hospital_id = current_user_hospital_id()
--         AND is_hospital_writable_role()
--       with NO is_owner() bypass at all → owners always fail.
--
--   Non-owner staff (admin/nurse/doctor/etc.) have a real
--   hospital_id on their profile, so current_hospital_id() returns
--   the right value and the AND-chain passes for them. Only owners
--   (and anyone whose profile.hospital_id is NULL) are blocked.
--
-- FIX (this migration)
--   Recreate the INSERT/UPDATE/DELETE policies for patients and
--   pharmacy_requests with is_owner() as a TOP-LEVEL OR clause, so
--   an owner bypasses the hospital_id comparison entirely (matching
--   003's intent and the 129 other policies that already work this
--   way). Non-owner role restrictions from 062 (front_desk/nurse/
--   doctor/etc. for insert; expanded list for update) are preserved
--   inside their own AND-group so role-based write access is unchanged
--   for non-owners.
--
--   Idempotent: DROP POLICY IF EXISTS before each CREATE. Safe to
--   re-run. No data is touched.
-- =====================================================================

-- =====================================================================
-- 1. patients — restore OR is_owner() as a top-level bypass
-- =====================================================================

drop policy if exists "patients_insert" on public.patients;
create policy "patients_insert" on public.patients
  for insert with check (
    public.is_owner()
    or (
      hospital_id = public.current_hospital_id()
      and public.is_hospital_writable_role()
      and public.current_role_text() in ('admin', 'front_desk', 'nurse', 'doctor', 'reception', 'staff')
    )
  );

drop policy if exists "patients_update" on public.patients;
create policy "patients_update" on public.patients
  for update using (
    public.is_owner()
    or (
      hospital_id = public.current_hospital_id()
      and public.is_hospital_writable_role()
    )
  ) with check (
    public.is_owner()
    or (
      hospital_id = public.current_hospital_id()
      and public.is_hospital_writable_role()
      and public.current_role_text() in ('admin', 'front_desk', 'nurse', 'doctor', 'reception', 'staff', 'billing', 'pharmacist', 'lab')
    )
  );

-- DELETE kept as 062 intended (owner or admin only), with the bypass.
drop policy if exists "patients_delete" on public.patients;
create policy "patients_delete" on public.patients
  for delete using (
    public.is_owner()
    or (
      hospital_id = public.current_hospital_id()
      and public.is_hospital_writable_role()
      and public.current_role_text() = 'admin'
    )
  );

-- =====================================================================
-- 2. pharmacy_requests — add the missing OR is_owner() bypass
-- =====================================================================

drop policy if exists pharmacy_requests_insert on public.pharmacy_requests;
create policy pharmacy_requests_insert on public.pharmacy_requests
  for insert to authenticated
  with check (
    public.is_owner()
    or (
      hospital_id = public.current_user_hospital_id()
      and public.is_hospital_writable_role()
    )
  );

drop policy if exists pharmacy_requests_update on public.pharmacy_requests;
create policy pharmacy_requests_update on public.pharmacy_requests
  for update to authenticated
  using (
    public.is_owner()
    or (
      hospital_id = public.current_user_hospital_id()
      and public.is_hospital_writable_role()
    )
  )
  with check (
    public.is_owner()
    or (
      hospital_id = public.current_user_hospital_id()
      and public.is_hospital_writable_role()
    )
  );

-- =====================================================================
-- 3. Verification — show the live policies so you can confirm the
--    is_owner() bypass is now top-level on both tables.
-- =====================================================================
select
  tablename, policyname, cmd,
  case
    when with_check is null then qual
    else with_check
  end as check_expr
from pg_policies
where schemaname = 'public'
  and tablename in ('patients', 'pharmacy_requests')
  and cmd in ('insert', 'update', 'delete')
order by tablename, cmd;
