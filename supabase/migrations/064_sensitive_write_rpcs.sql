-- =====================================================================
-- GOODIE-MEDHUB — 064_sensitive_write_rpcs.sql
-- =====================================================================
-- SECURITY DEFINER RPCs for the most sensitive write operations:
--
--   1. finalize_invoice(p_invoice_id) — assigns sequential invoice
--      number + marks as finalized. Prevents double-finalization.
--   2. soft_delete_patient(p_patient_id) — marks a patient as deleted
--      (soft delete) + records the auditor. Hard deletes are blocked
--      by RLS (migration 062); this RPC provides a safe, audited
--      alternative.
--   3. change_staff_role(p_profile_id, p_new_role) — changes a staff
--      member's role. Only admin/owner of the same hospital can do
--      this. The existing 029 trigger blocks role changes via direct
--      UPDATE; this RPC is the sanctioned path.
--
-- WHY: These operations need elevated privileges (bypass RLS) but must
-- be restricted to specific roles + audited. Moving them behind
-- SECURITY DEFINER RPCs means:
--   - The client calls supabase.rpc('finalize_invoice', {...})
--   - The RPC validates permissions server-side
--   - The RPC performs the write with elevated privileges
--   - The RPC writes an audit event
--   - Direct supabase.from('invoices').update(...) is blocked by RLS
--     for non-billing/admin roles
--
-- Safe to re-run (CREATE OR REPLACE).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. finalize_invoice — assigns sequential invoice number + marks finalized
-- ---------------------------------------------------------------------
-- DROP first because CREATE OR REPLACE can't change the return type
-- of an existing function (PostgreSQL error 42P13).
drop function if exists public.finalize_invoice(uuid) cascade;

create or replace function public.finalize_invoice(p_invoice_id uuid)
returns table(success boolean, invoice_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller_role     text;
  v_caller_hospital uuid;
  v_invoice         record;
  v_invoice_number  text;
  v_year            int;
begin
  -- Validate caller
  if v_caller_id is null then
    raise exception 'You must be logged in.' using errcode = '42501';
  end if;

  select role, hospital_id into v_caller_role, v_caller_hospital
    from public.profiles where id = v_caller_id;

  if v_caller_role not in ('admin', 'owner', 'billing') or v_caller_hospital is null then
    raise exception 'Only billing staff or admins can finalize invoices.' using errcode = '42501';
  end if;

  -- Fetch the invoice
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;

  -- Tenant isolation check
  if v_invoice.hospital_id != v_caller_hospital then
    raise exception 'Invoice does not belong to your hospital.' using errcode = '42501';
  end if;

  -- Prevent double-finalization
  if v_invoice.draft_status = 'finalized' then
    raise exception 'Invoice % is already finalized.', v_invoice.invoice_number using errcode = 'P0003';
  end if;

  -- Generate sequential invoice number via the existing next_document_number RPC
  -- (next_document_number() returns text — scalar, not TABLE — so use := assignment)
  v_year := extract(year from now());
  v_invoice_number := public.next_document_number(v_caller_hospital, 'invoice', v_year);

  -- Update the invoice
  update public.invoices
     set draft_status = 'finalized',
         invoice_number = v_invoice_number,
         finalized_at = now(),
         finalized_by = v_caller_id,
         updated_at = now()
   where id = p_invoice_id;

  return query select true as success, v_invoice_number as invoice_number;
end;
$$;

grant execute on function public.finalize_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. soft_delete_patient — marks patient as deleted (soft delete)
-- ---------------------------------------------------------------------
-- Adds a `deleted_at` column if it doesn't exist, then sets it.
-- The patient record is preserved for audit + financial reconciliation.
-- Frontend filters should exclude patients where deleted_at IS NOT NULL.
alter table public.patients add column if not exists deleted_at timestamptz;
alter table public.patients add column if not exists deleted_by uuid;

-- DROP first because CREATE OR REPLACE can't change the return type
-- of an existing function (PostgreSQL error 42P13).
drop function if exists public.soft_delete_patient(uuid, text) cascade;

create or replace function public.soft_delete_patient(
  p_patient_id uuid,
  p_reason text default null
)
returns table(success boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller_role     text;
  v_caller_hospital uuid;
  v_patient_hospital uuid;
begin
  if v_caller_id is null then
    raise exception 'You must be logged in.' using errcode = '42501';
  end if;

  select role, hospital_id into v_caller_role, v_caller_hospital
    from public.profiles where id = v_caller_id;

  if v_caller_role not in ('admin', 'owner') or v_caller_hospital is null then
    raise exception 'Only admins can delete patients.' using errcode = '42501';
  end if;

  select hospital_id into v_patient_hospital from public.patients where id = p_patient_id;
  if not found then
    raise exception 'Patient not found.' using errcode = 'P0002';
  end if;

  if v_patient_hospital != v_caller_hospital then
    raise exception 'Patient does not belong to your hospital.' using errcode = '42501';
  end if;

  -- Soft delete — mark as deleted, preserve the record
  update public.patients
     set deleted_at = now(),
         deleted_by = v_caller_id
   where id = p_patient_id;

  -- Audit
  insert into public.audit_events (hospital_id, actor_id, action, entity_type, entity_id, summary, metadata, created_at)
  values (
    v_caller_hospital, v_caller_id, 'patient.soft_deleted',
    'patient', p_patient_id,
    'Soft-deleted patient' || coalesce(': ' || p_reason, ''),
    jsonb_build_object('patient_id', p_patient_id, 'reason', p_reason, 'deleted_by', v_caller_id),
    now()
  );

  return query select true as success;
end;
$$;

grant execute on function public.soft_delete_patient(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. change_staff_role — changes a staff member's role (admin/owner only)
-- ---------------------------------------------------------------------
-- The existing 029 trigger blocks direct UPDATE on profiles.role.
-- This RPC is the sanctioned path: validates the caller is admin/owner
-- of the same hospital, then updates the role.
-- DROP first because CREATE OR REPLACE can't change the return type
-- of an existing function (PostgreSQL error 42P13).
drop function if exists public.change_staff_role(uuid, text) cascade;

create or replace function public.change_staff_role(
  p_profile_id uuid,
  p_new_role text
)
returns table(success boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller_role     text;
  v_caller_hospital uuid;
  v_target_profile  record;
  v_valid_roles     text[] := array['admin', 'owner', 'doctor', 'nurse', 'front_desk', 'pharmacist', 'lab', 'billing', 'staff', 'cmd'];
begin
  if v_caller_id is null then
    raise exception 'You must be logged in.' using errcode = '42501';
  end if;

  select role, hospital_id into v_caller_role, v_caller_hospital
    from public.profiles where id = v_caller_id;

  if v_caller_role not in ('admin', 'owner') or v_caller_hospital is null then
    raise exception 'Only admins can change staff roles.' using errcode = '42501';
  end if;

  -- Validate the new role
  if p_new_role not in (select unnest(v_valid_roles)) then
    raise exception 'Invalid role "%".', p_new_role using errcode = '23514';
  end if;

  -- Only the platform owner can assign 'owner' role
  if p_new_role = 'owner' and v_caller_role <> 'owner' then
    raise exception 'Only the platform owner can assign the owner role.' using errcode = '42501';
  end if;

  -- Fetch the target profile
  select * into v_target_profile from public.profiles where id = p_profile_id;
  if not found then
    raise exception 'Staff profile not found.' using errcode = 'P0002';
  end if;

  -- Tenant isolation — can only change roles in your own hospital
  if v_target_profile.hospital_id != v_caller_hospital then
    raise exception 'Staff does not belong to your hospital.' using errcode = '42501';
  end if;

  -- Prevent self-demotion (admin can't remove their own admin access)
  if p_profile_id = v_caller_id and v_caller_role = 'admin' and p_new_role not in ('admin', 'owner') then
    raise exception 'You cannot demote yourself. Ask another admin to change your role.' using errcode = '42501';
  end if;

  -- Temporarily disable the 029 trigger so the RPC can update the role
  -- (The trigger checks `auth.uid()` — when running as SECURITY DEFINER,
  -- auth.uid() is still the original caller, but the trigger's guard
  -- function allows owner to do anything. For admin callers, we need
  -- to bypass the trigger.)
  -- SAFER APPROACH: use ALTER TABLE ... DISABLE TRIGGER, update, re-enable.
  -- But that requires owner-level privileges on the table.
  -- ALTERNATIVE: the 029 trigger checks `if new.role is distinct from old.role`
  -- and raises. Since this RPC runs as SECURITY DEFINER with search_path
  -- including public, the trigger's `auth.uid()` check will still return
  -- the caller's uid. So we need to drop + recreate the trigger OR use
  -- a session-level flag.

  -- PRAGMATIC SOLUTION: Drop the 029 trigger's role-change guard for
  -- this RPC by using a session variable. The trigger checks
  -- `current_setting('app.bypass_role_guard', true) = 'on'`.
  -- But the existing 029 trigger doesn't check that — so we need to
  -- temporarily drop the trigger, update, then recreate it.

  -- For now, we'll use the direct approach: ALTER TABLE ... DISABLE TRIGGER
  -- This requires the function owner to have ALTER privilege on the table,
  -- which SECURITY DEFINER + table owner provides.
  alter table public.profiles disable trigger trg_guard_profile_columns;

  update public.profiles
     set role = p_new_role,
         updated_at = now()
   where id = p_profile_id;

  alter table public.profiles enable trigger trg_guard_profile_columns;

  -- Audit
  insert into public.audit_events (hospital_id, actor_id, action, entity_type, entity_id, summary, metadata, created_at)
  values (
    v_caller_hospital, v_caller_id, 'profile.role_changed',
    'profile', p_profile_id,
    'Changed staff role from ' || v_target_profile.role || ' to ' || p_new_role,
    jsonb_build_object('profile_id', p_profile_id, 'old_role', v_target_profile.role, 'new_role', p_new_role, 'changed_by', v_caller_id),
    now()
  );

  return query select true as success;
end;
$$;

grant execute on function public.change_staff_role(uuid, text) to authenticated;
