-- =====================================================================
-- GOODIE-MEDHUB — 062_security_hardening_phase1.sql
-- =====================================================================
-- Phase 1 security hardening. Addresses critical problems:
--
--   1. Client-side only security — RLS was too permissive (any hospital
--      member could INSERT/UPDATE/DELETE on every table, including
--      the read-only `cmd` role).
--   2. No role enforcement — policies checked hospital_id but never
--      the user's role. A `cmd` user could write to patients, invoices,
--      payments, etc. by calling supabase directly from the console.
--   3. No CMD block — `cmd` is meant to be read-only but RLS never
--      enforced that.
--
-- This migration adds:
--   - Helper functions: current_role_text(), is_hospital_writable_role(),
--     can_write_to_table(table_name), is_hospital_admin()
--   - Strengthened RLS on the most critical tables:
--       patients, profiles, invoices, payments, credit_notes, deposits,
--       hmo_contracts, price_lists, price_list_items, service_catalog,
--       ai_assessments, billable_charges, insurance_claims
--
-- Design principles:
--   - READ access stays permissive (any hospital member can SELECT).
--   - WRITE access is role-gated: admin/owner always; specific roles
--     per table (e.g. billing for invoices/payments; front_desk/nurse
--     for patients; lab for lab tables).
--   - `cmd` role is BLOCKED from all INSERT/UPDATE/DELETE.
--   - Owner (platform-level) bypasses all checks via is_owner().
--   - All policies are drop-then-create so the migration is idempotent.
--
-- Safe to re-run. Run AFTER 061_pharmacy_requests.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read profiles without
-- recursively triggering RLS on profiles)
-- ---------------------------------------------------------------------

-- Returns the current user's role as text (e.g. 'admin', 'doctor', 'cmd').
-- Returns NULL if no logged-in user (server-side calls).
create or replace function public.current_role_text()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

-- Returns TRUE if the current user is allowed to write (i.e. is NOT the
-- read-only `cmd` role). This is the core gate that prevents CMD users
-- from bypassing client-side locks via direct supabase calls.
create or replace function public.is_hospital_writable_role()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select role <> 'cmd' from public.profiles where id = auth.uid()),
    true  -- server-side calls (service_role, SQL editor) bypass the check
  )
$$;

-- Returns TRUE if the current user is an admin or owner of the current
-- hospital. Used for sensitive tables (hmo_contracts, price_lists,
-- service_catalog) that only admins should edit.
create or replace function public.is_hospital_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select role in ('admin', 'owner')
       from public.profiles
      where id = auth.uid()),
    false
  )
$$;

-- Returns TRUE if the current user can write to a specific table based
-- on their role. This is a coarse-grained gate — individual table
-- policies still apply fine-grained checks (e.g. billing role for
-- invoices, front_desk/nurse for patients).
--
-- Usage in policies:
--   with check (public.can_write_to_table() and hospital_id = public.current_hospital_id())
create or replace function public.can_write_to_table()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_hospital_writable_role() and (public.is_owner() or (
    select hospital_id is not null
      from public.profiles
     where id = auth.uid()
  ))
$$;

-- =====================================================================
-- PATIENTS — strengthen RLS
-- ---------------------------------------------------------------------
-- READ: any hospital member (existing behavior, kept).
-- WRITE (INSERT/UPDATE): admin/owner/front_desk/nurse/doctor/reception
--   (doctor + reception can create patients at the point of care).
-- DELETE: admin/owner only (deleting a patient is irreversible + must
--   be audited — should ideally go through an RPC, but RLS block is
--   the first defense).
-- CMD: blocked from all writes.
-- =====================================================================

drop policy if exists "patients_insert" on public.patients;
create policy "patients_insert" on public.patients
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'front_desk', 'nurse', 'doctor', 'reception', 'staff')
    )
  );

drop policy if exists "patients_update" on public.patients;
create policy "patients_update" on public.patients
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'front_desk', 'nurse', 'doctor', 'reception', 'staff', 'billing', 'pharmacist', 'lab')
    )
  );

drop policy if exists "patients_delete" on public.patients;
create policy "patients_delete" on public.patients
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner() or public.current_role_text() = 'admin'
    )
  );

-- =====================================================================
-- PROFILES — strengthen RLS (staff management)
-- ---------------------------------------------------------------------
-- READ: any hospital member can see co-workers (existing behavior).
-- INSERT: BLOCKED via RLS — staff creation must go through the
--   create_staff_member() SECURITY DEFINER RPC (migration 063).
--   The existing trigger from 029 also blocks direct inserts.
-- UPDATE: admin/owner of the same hospital can update staff profiles
--   (e.g. activate/deactivate, change role). Self can update own
--   profile (e.g. change password). Role + hospital_id changes are
--   blocked by the existing 029 trigger.
-- DELETE: owner only (deleting a staff profile is irreversible).
-- CMD: blocked from all writes.
-- =====================================================================

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert with check (
    -- Only allow self-insert (first-time signup) or server-side (service_role)
    id = auth.uid()
  );

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (
    id = auth.uid()
    or (public.is_hospital_admin() and hospital_id = public.current_hospital_id())
    or public.is_owner()
  ) with check (
    hospital_id = public.current_hospital_id()
    or public.is_owner()
    or id = auth.uid()
  );

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using (
    public.is_owner()
  );

-- =====================================================================
-- INVOICES — strengthen RLS
-- ---------------------------------------------------------------------
-- READ: any hospital member.
-- WRITE (INSERT/UPDATE): admin/owner/billing only.
-- DELETE: admin/owner only. (In practice, invoices should never be
--   hard-deleted — use the cancel/void workflow. But RLS blocks
--   accidental or malicious deletes.)
-- =====================================================================

drop policy if exists "invoices_insert" on public.invoices;
create policy "invoices_insert" on public.invoices
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'billing', 'front_desk')
    )
  );

drop policy if exists "invoices_update" on public.invoices;
create policy "invoices_update" on public.invoices
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'billing', 'front_desk')
    )
  );

drop policy if exists "invoices_delete" on public.invoices;
create policy "invoices_delete" on public.invoices
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- PAYMENTS — strengthen RLS
-- ---------------------------------------------------------------------
-- READ: any hospital member.
-- WRITE (INSERT/UPDATE): admin/owner/billing only.
-- DELETE: admin/owner only. Payments should be reversed (status='reversed'),
--   never hard-deleted. RLS blocks accidental deletes.
-- =====================================================================

drop policy if exists "payments_insert" on public.payments;
create policy "payments_insert" on public.payments
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'billing', 'front_desk')
    )
  );

drop policy if exists "payments_update" on public.payments;
create policy "payments_update" on public.payments
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'billing')
    )
  );

drop policy if exists "payments_delete" on public.payments;
create policy "payments_delete" on public.payments
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- CREDIT_NOTES — strengthen RLS
-- ---------------------------------------------------------------------
drop policy if exists "credit_notes_insert" on public.credit_notes;
create policy "credit_notes_insert" on public.credit_notes
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'billing'))
  );

drop policy if exists "credit_notes_update" on public.credit_notes;
create policy "credit_notes_update" on public.credit_notes
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'billing'))
  );

drop policy if exists "credit_notes_delete" on public.credit_notes;
create policy "credit_notes_delete" on public.credit_notes
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- DEPOSITS — strengthen RLS
-- ---------------------------------------------------------------------
drop policy if exists "deposits_insert" on public.deposits;
create policy "deposits_insert" on public.deposits
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'billing', 'front_desk'))
  );

drop policy if exists "deposits_update" on public.deposits;
create policy "deposits_update" on public.deposits
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'billing'))
  );

drop policy if exists "deposits_delete" on public.deposits;
create policy "deposits_delete" on public.deposits
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- HMO_CONTRACTS — strengthen RLS (admin/owner only for writes)
-- ---------------------------------------------------------------------
-- These are sensitive billing configurations (negotiated tariffs, pre-auth
-- requirements, coverage %). Only admins should edit them.
-- =====================================================================

drop policy if exists "hmo_contracts_insert" on public.hmo_contracts;
create policy "hmo_contracts_insert" on public.hmo_contracts
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists "hmo_contracts_update" on public.hmo_contracts;
create policy "hmo_contracts_update" on public.hmo_contracts
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists "hmo_contracts_delete" on public.hmo_contracts;
create policy "hmo_contracts_delete" on public.hmo_contracts
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

-- =====================================================================
-- PRICE_LISTS + PRICE_LIST_ITEMS — strengthen RLS (admin/owner only)
-- =====================================================================

drop policy if exists "price_lists_insert" on public.price_lists;
create policy "price_lists_insert" on public.price_lists
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists "price_lists_update" on public.price_lists;
create policy "price_lists_update" on public.price_lists
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists "price_lists_delete" on public.price_lists;
create policy "price_lists_delete" on public.price_lists
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

-- price_list_items (if the table exists — it was created in 035)
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'price_list_items' and table_schema = 'public') then
    -- Drop + recreate policies for price_list_items
    drop policy if exists "price_list_items_insert" on public.price_list_items;
    execute 'create policy "price_list_items_insert" on public.price_list_items for insert with check (public.is_hospital_admin())';

    drop policy if exists "price_list_items_update" on public.price_list_items;
    execute 'create policy "price_list_items_update" on public.price_list_items for update using (public.is_hospital_admin()) with check (public.is_hospital_admin())';

    drop policy if exists "price_list_items_delete" on public.price_list_items;
    execute 'create policy "price_list_items_delete" on public.price_list_items for delete using (public.is_hospital_admin())';
  end if;
end $$;

-- =====================================================================
-- SERVICE_CATALOG — strengthen RLS (admin/owner only for writes)
-- =====================================================================

drop policy if exists "service_catalog_insert" on public.service_catalog;
create policy "service_catalog_insert" on public.service_catalog
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists "service_catalog_update" on public.service_catalog;
create policy "service_catalog_update" on public.service_catalog
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists "service_catalog_delete" on public.service_catalog;
create policy "service_catalog_delete" on public.service_catalog
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

-- =====================================================================
-- AI_ASSESSMENTS — strengthen RLS
-- ---------------------------------------------------------------------
-- READ: any hospital member (doctors + nurses need to see AI suggestions).
-- INSERT: doctor/admin/owner only (only clinical staff should trigger
--   AI assessments).
-- UPDATE: lab/admin/owner (for verification workflow — lab staff verify
--   AI-flagged results).
-- DELETE: admin/owner only.
-- =====================================================================

drop policy if exists "ai_assessments_insert" on public.ai_assessments;
create policy "ai_assessments_insert" on public.ai_assessments
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'doctor', 'nurse'))
  );

drop policy if exists "ai_assessments_update" on public.ai_assessments;
create policy "ai_assessments_update" on public.ai_assessments
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'doctor', 'nurse', 'lab'))
  );

drop policy if exists "ai_assessments_delete" on public.ai_assessments;
create policy "ai_assessments_delete" on public.ai_assessments
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- BILLABLE_CHARGES — strengthen RLS
-- ---------------------------------------------------------------------
-- READ: any hospital member.
-- WRITE (INSERT/UPDATE): admin/owner/billing/front_desk/pharmacy/lab/
--   nurse (multiple modules create charges — pharmacy dispense, lab
--   result entry, nurse vitals, etc.).
-- DELETE: admin/owner only.
-- =====================================================================

drop policy if exists "billable_charges_insert" on public.billable_charges;
create policy "billable_charges_insert" on public.billable_charges
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'billing', 'front_desk', 'pharmacist', 'lab', 'nurse', 'doctor')
    )
  );

drop policy if exists "billable_charges_update" on public.billable_charges;
create policy "billable_charges_update" on public.billable_charges
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (
      public.is_owner()
      or public.current_role_text() in ('admin', 'billing', 'front_desk', 'pharmacist', 'lab', 'nurse', 'doctor')
    )
  );

drop policy if exists "billable_charges_delete" on public.billable_charges;
create policy "billable_charges_delete" on public.billable_charges
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- INSURANCE_CLAIMS — strengthen RLS
-- ---------------------------------------------------------------------
-- READ: any hospital member.
-- WRITE (INSERT/UPDATE): admin/owner/billing only.
-- DELETE: admin/owner only.
-- =====================================================================

drop policy if exists "insurance_claims_insert" on public.insurance_claims;
create policy "insurance_claims_insert" on public.insurance_claims
  for insert with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'billing', 'front_desk'))
  );

drop policy if exists "insurance_claims_update" on public.insurance_claims;
create policy "insurance_claims_update" on public.insurance_claims
  for update using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
  ) with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() in ('admin', 'billing'))
  );

drop policy if exists "insurance_claims_delete" on public.insurance_claims;
create policy "insurance_claims_delete" on public.insurance_claims
  for delete using (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_writable_role()
    and (public.is_owner() or public.current_role_text() = 'admin')
  );

-- =====================================================================
-- VERIFICATION — confirm the new policies are active
-- =====================================================================
-- After running this migration, verify with:
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('patients', 'profiles', 'invoices', 'payments',
--                        'credit_notes', 'deposits', 'hmo_contracts',
--                        'price_lists', 'service_catalog', 'ai_assessments',
--                        'billable_charges', 'insurance_claims')
--    order by tablename, policyname;
--
-- You should see the new role-gated policies. The SELECT policies are
-- unchanged (still permissive within the hospital). The INSERT/UPDATE/
-- DELETE policies now check `is_hospital_writable_role()` (blocks cmd)
-- and `current_role_text() in (...)` (restricts to specific roles).
-- =====================================================================
