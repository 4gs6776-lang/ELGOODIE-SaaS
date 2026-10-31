-- =====================================================================
-- GOODIE-MEDHUB — 069_patient_portal_rls_fix.sql
-- =====================================================================
-- FIX: Patient portal users can't read the patients table because
-- current_hospital_id() returns NULL for them (they don't have a
-- profiles row — they're patients, not staff).
--
-- This migration adds a new RLS policy that allows patient portal
-- users to read their OWN patient record (and only their own) via
-- the patient_users table link.
--
-- Also fixes: allows portal users to read their own invoices,
-- lab_orders, payments, and appointments (same issue — RLS was
-- checking current_hospital_id() which is NULL for portal users).
--
-- Safe to re-run.
-- =====================================================================

-- Helper: get the patient_id for the current portal user
create or replace function public.current_portal_patient_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select patient_id from public.patient_users
   where user_id = auth.uid() and is_active = true
   limit 1
$$;

-- =====================================================================
-- 1. patients — allow portal users to read their OWN record
-- =====================================================================
-- Keep the existing staff policy (hospital_id = current_hospital_id)
-- and ADD a new policy for portal users (patient_id matches their link).
-- Both policies are OR'd together by PostgreSQL.

drop policy if exists "patients_select_portal" on public.patients;
create policy "patients_select_portal" on public.patients
  for select using (
    id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 2. invoices — allow portal users to read their own invoices
-- =====================================================================
drop policy if exists "invoices_select_portal" on public.invoices;
create policy "invoices_select_portal" on public.invoices
  for select using (
    patient_id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 3. payments — allow portal users to read their own payments
-- =====================================================================
drop policy if exists "payments_select_portal" on public.payments;
create policy "payments_select_portal" on public.payments
  for select using (
    patient_id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 4. lab_orders — allow portal users to read their own lab orders
-- =====================================================================
drop policy if exists "lab_orders_select_portal" on public.lab_orders;
create policy "lab_orders_select_portal" on public.lab_orders
  for select using (
    patient_id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 5. lab_tests — allow portal users to read their own lab tests
-- =====================================================================
drop policy if exists "lab_tests_select_portal" on public.lab_tests;
create policy "lab_tests_select_portal" on public.lab_tests
  for select using (
    patient_id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 6. appointments — allow portal users to read their own appointments
-- =====================================================================
drop policy if exists "appointments_select_portal" on public.appointments;
create policy "appointments_select_portal" on public.appointments
  for select using (
    patient_id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 7. hospitals — allow portal users to read their own hospital
-- =====================================================================
drop policy if exists "hospitals_select_portal" on public.hospitals;
create policy "hospitals_select_portal" on public.hospitals
  for select using (
    id = (
      select hospital_id from public.patient_users
       where user_id = auth.uid() and is_active = true
       limit 1
    )
  );

-- =====================================================================
-- 8. payments INSERT — allow portal users to create payment records
--    (for Paystack payment integration)
-- =====================================================================
drop policy if exists "payments_insert_portal" on public.payments;
create policy "payments_insert_portal" on public.payments
  for insert with check (
    patient_id = public.current_portal_patient_id()
  );

-- =====================================================================
-- 9. invoices UPDATE — allow portal users to update invoice balance
--    (after a successful Paystack payment)
-- =====================================================================
drop policy if exists "invoices_update_portal" on public.invoices;
create policy "invoices_update_portal" on public.invoices
  for update using (
    patient_id = public.current_portal_patient_id()
  ) with check (
    patient_id = public.current_portal_patient_id()
  );
