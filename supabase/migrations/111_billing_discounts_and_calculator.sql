-- =====================================================================
-- GOODIE-MEDHUB — 111_billing_discounts_and_calculator.sql
-- =====================================================================
-- Integrated Smart Calculator & Discount Management System for the
-- Billing Module.
--
-- DESIGN PRINCIPLES
--   • REUSE existing infrastructure — do NOT duplicate:
--       - approval_requests table already supports request_type='discount'
--         (052_approval_requests.sql:32). We reuse it for the approval
--         workflow instead of creating a parallel discount_approvals table.
--       - audit_events table (007) + the direct INSERT pattern used by
--         existing SECURITY DEFINER RPCs (064_sensitive_write_rpcs.sql:154).
--       - RLS helpers current_hospital_id() / is_owner() /
--         is_hospital_admin() / is_hospital_writable_role() (003, 062).
--   • Backend is the authority for ALL money math. A SECURITY DEFINER
--     RPC recomputes subtotal/discount/grand_total from invoice_items
--     inside a transaction; the frontend's number is only a preview.
--   • Tenant isolation via current_hospital_id() on every policy.
--   • Idempotent (ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS).
--
-- SAFE TO RE-RUN. No data loss. Does NOT touch existing invoice rows
-- (all new columns default to 0 / 'none' / null).
-- =====================================================================

-- =====================================================================
-- 1. HOSPITAL DISCOUNT SETTINGS  (per-hospital configurable limits)
-- =====================================================================
-- Replaces the "hospital settings" requirement. One row per hospital.
-- Created on first read via a trigger, or by an admin in Settings.
-- ---------------------------------------------------------------------

create table if not exists public.hospital_discount_settings (
  id                              uuid primary key default gen_random_uuid(),
  hospital_id                     uuid not null references public.hospitals(id) on delete cascade,
  -- Maximum percentage a cashier (billing role) may self-apply without
  -- approval. Anything above this auto-routes to approval_requests.
  max_cashier_discount_percent   numeric(5,2) not null default 5.00
                                  check (max_cashier_discount_percent >= 0 and max_cashier_discount_percent <= 100),
  -- Threshold above which ANY discount (even by admin) is logged for
  -- review. Does not block — purely a flag for reports.
  review_threshold_percent        numeric(5,2) not null default 20.00
                                  check (review_threshold_percent >= 0 and review_threshold_percent <= 100),
  -- Per-invoice maximum fixed-amount discount (0 = no cap). Guards
  -- against typos that discount more than the invoice.
  max_invoice_discount_amount     numeric(14,2) not null default 0
                                  check (max_invoice_discount_amount >= 0),
  enable_item_discounts           boolean not null default true,
  enable_invoice_discounts        boolean not null default true,
  requires_reason                 boolean not null default true,
  -- Roles allowed to APPROVE discount requests. Default admin+owner,
  -- matching the existing approval_requests UPDATE policy (052:147).
  approver_roles                  text[] not null default array['admin','owner'],
  updated_by                      uuid,
  updated_at                      timestamptz not null default now(),
  created_at                      timestamptz not null default now(),
  unique (hospital_id)
);

alter table public.hospital_discount_settings enable row level security;
alter table public.hospital_discount_settings replica identity full;

drop policy if exists hospital_discount_settings_select on public.hospital_discount_settings;
create policy hospital_discount_settings_select on public.hospital_discount_settings
  for select to authenticated using (
    hospital_id = public.current_hospital_id() or public.is_owner()
  );

-- Only admins/owners can change discount limits.
drop policy if exists hospital_discount_settings_insert on public.hospital_discount_settings;
create policy hospital_discount_settings_insert on public.hospital_discount_settings
  for insert to authenticated with check (
    hospital_id = public.current_hospital_id()
    and public.is_hospital_admin()
  );

drop policy if exists hospital_discount_settings_update on public.hospital_discount_settings;
create policy hospital_discount_settings_update on public.hospital_discount_settings
  for update to authenticated
  using (hospital_id = public.current_hospital_id() and public.is_hospital_admin())
  with check (hospital_id = public.current_hospital_id() and public.is_hospital_admin());

-- Auto-create a default settings row for a hospital if missing.
-- Called from get_discount_settings() RPC; also safe to call manually.
create or replace function public.ensure_discount_settings(p_hospital_id uuid)
returns public.hospital_discount_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.hospital_discount_settings;
begin
  select * into v_row
    from public.hospital_discount_settings
   where hospital_id = p_hospital_id;
  if not found then
    insert into public.hospital_discount_settings (hospital_id)
    values (p_hospital_id)
    on conflict (hospital_id) do nothing
    returning * into v_row;
    select * into v_row
      from public.hospital_discount_settings
     where hospital_id = p_hospital_id;
  end if;
  return v_row;
end;
$$;

-- =====================================================================
-- 2. DISCOUNT COLUMNS ON invoices + invoice_items
-- =====================================================================
-- The existing flat `discount` numeric column on invoices (used by
-- CashierWorkspace.jsx:306) is PRESERVED for backward compatibility.
-- These new structured columns carry the type/reason/approval metadata
-- that the flat column could not.
-- ---------------------------------------------------------------------

alter table public.invoices
  add column if not exists discount_type              text not null default 'none'
    check (discount_type in ('none','fixed','percent','item')),
  add column if not exists discount_percent           numeric(5,2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100),
  add column if not exists discount_reason            text,
  add column if not exists discount_approved_by       uuid,
  add column if not exists discount_approved_at        timestamptz,
  add column if not exists discount_approval_request_id uuid;

-- invoice_items: per-line discount columns (for item-specific discounts).
alter table public.invoice_items
  add column if not exists discount_amount numeric(14,2) not null default 0
    check (discount_amount >= 0),
  add column if not exists discount_percent numeric(5,2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100);

-- =====================================================================
-- 3. CORE RPC — apply_invoice_discount
-- =====================================================================
-- SECURITY DEFINER. The single authoritative path that writes a
-- discount to a finalized/draft invoice. Validates everything server-
-- side inside a transaction:
--   • invoice belongs to caller's hospital
--   • invoice is not cancelled / written_off
--   • discount value is within bounds (cannot exceed eligible subtotal)
--   • if an approval_request is supplied, it must be status='approved'
--     and point at this invoice
--   • recomputes grand_total from invoice_items (server-authoritative)
--   • preserves subtotal + amount_paid; recomputes balance
--   • writes a full audit_events row with before/after values
-- Never trusts a hospital_id / cashier_id / amount from the client.
-- ---------------------------------------------------------------------

create or replace function public.apply_invoice_discount(
  p_invoice_id           uuid,
  p_discount_type        text,         -- 'fixed' | 'percent' | 'item'
  p_discount_value       numeric,      -- amount (fixed) or percent (0-100)
  p_reason               text,
  p_approval_request_id  uuid default null,
  p_item_discounts       jsonb default null  -- [{item_id, amount, percent}] for 'item' type
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv            public.invoices;
  v_settings       public.hospital_discount_settings;
  v_subtotal       numeric(14,2);
  v_discount_amt   numeric(14,2);
  v_discount_pct   numeric(5,2);
  v_grand_total    numeric(14,2);
  v_amount_paid    numeric(14,2);
  v_balance        numeric(14,2);
  v_old_discount   numeric(14,2);
  v_old_total      numeric(14,2);
  v_caller         record;
  v_item_row       record;
  v_item_total     numeric(14,2);
  v_line_discount  numeric(14,2);
begin
  -- -------------------------------------------------------------------
  -- Caller identity (never trust client-supplied IDs).
  -- -------------------------------------------------------------------
  select id, role, full_name, hospital_id
    into v_caller
    from public.profiles
   where id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Not authenticated');
  end if;

  -- -------------------------------------------------------------------
  -- Lock + validate the invoice row.
  -- -------------------------------------------------------------------
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Invoice not found');
  end if;
  if v_inv.hospital_id is distinct from v_caller.hospital_id
     and v_caller.role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'Invoice does not belong to your hospital');
  end if;
  if v_inv.status = 'cancelled' or v_inv.status = 'written_off' then
    return jsonb_build_object('ok', false, 'error', 'Cannot discount a cancelled or written-off invoice');
  end if;
  if v_inv.draft_status = 'written_off' then
    return jsonb_build_object('ok', false, 'error', 'Cannot discount a written-off invoice');
  end if;

  -- -------------------------------------------------------------------
  -- Settings (auto-create defaults if missing).
  -- -------------------------------------------------------------------
  v_settings := public.ensure_discount_settings(v_inv.hospital_id);

  if p_reason is null or btrim(p_reason) = '' then
    if v_settings.requires_reason then
      return jsonb_build_object('ok', false, 'error', 'A discount reason is required');
    end if;
  end if;

  if p_discount_type not in ('fixed','percent','item') then
    return jsonb_build_object('ok', false, 'error', 'Invalid discount type');
  end if;

  -- -------------------------------------------------------------------
  -- Compute the server-authoritative subtotal from invoice_items.
  -- This is the eligible amount for discounting.
  -- -------------------------------------------------------------------
  select coalesce(sum(total), 0) into v_subtotal
    from public.invoice_items
   where invoice_id = p_invoice_id;
  v_subtotal := round(v_subtotal::numeric, 2);

  if v_subtotal <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Invoice has no billable items to discount');
  end if;

  v_old_discount := coalesce(v_inv.discount, 0);
  v_old_total    := coalesce(v_inv.grand_total, 0);
  v_amount_paid  := coalesce(v_inv.amount_paid, 0);

  -- -------------------------------------------------------------------
  -- Validate the approval request, if supplied.
  -- -------------------------------------------------------------------
  if p_approval_request_id is not null then
    declare
      v_req record;
    begin
      select * into v_req
        from public.approval_requests
       where id = p_approval_request_id
         and hospital_id = v_inv.hospital_id
         and request_type = 'discount'
         and entity_id = p_invoice_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'Approval request not found for this invoice');
      end if;
      if v_req.status <> 'approved' then
        return jsonb_build_object('ok', false, 'error', 'Discount has not been approved');
      end if;
    end;
  else
    -- No approval supplied: caller must be within their self-apply limit.
    -- Owner/admin bypass; billing role checked against max_cashier_discount_percent.
    if v_caller.role not in ('admin','owner') then
      if p_discount_type = 'percent' and p_discount_value > v_settings.max_cashier_discount_percent then
        return jsonb_build_object('ok', false, 'error',
          'Discount exceeds your authorization (' || v_settings.max_cashier_discount_percent || '%). Request approval first.');
      end if;
      if p_discount_type = 'fixed' and v_subtotal > 0
         and (p_discount_value / v_subtotal * 100) > v_settings.max_cashier_discount_percent then
        return jsonb_build_object('ok', false, 'error',
          'Discount exceeds your authorization. Request approval first.');
      end if;
    end if;
  end if;

  -- -------------------------------------------------------------------
  -- Compute the discount amount (server-authoritative).
  -- -------------------------------------------------------------------
  if p_discount_type = 'percent' then
    if p_discount_value < 0 or p_discount_value > 100 then
      return jsonb_build_object('ok', false, 'error', 'Percentage must be between 0 and 100');
    end if;
    v_discount_pct := round(p_discount_value::numeric, 2);
    v_discount_amt := round(v_subtotal * v_discount_pct / 100, 2);
  elsif p_discount_type = 'fixed' then
    if p_discount_value < 0 then
      return jsonb_build_object('ok', false, 'error', 'Discount amount cannot be negative');
    end if;
    v_discount_pct := 0;
    v_discount_amt := round(p_discount_value::numeric, 2);
  else  -- 'item'
    if p_item_discounts is null or jsonb_array_length(p_item_discounts) = 0 then
      return jsonb_build_object('ok', false, 'error', 'Item discount requires at least one line item');
    end if;
    v_discount_amt := 0;
    v_discount_pct := 0;
  end if;

  -- Cannot discount more than the eligible subtotal (no negative invoice).
  if v_discount_amt > v_subtotal then
    return jsonb_build_object('ok', false, 'error',
      'Discount (' || v_discount_amt || ') exceeds eligible subtotal (' || v_subtotal || ')');
  end if;

  -- Per-hospital absolute cap (0 = no cap).
  if v_settings.max_invoice_discount_amount > 0
     and v_discount_amt > v_settings.max_invoice_discount_amount then
    return jsonb_build_object('ok', false, 'error',
      'Discount exceeds hospital maximum (' || v_settings.max_invoice_discount_amount || ')');
  end if;

  -- -------------------------------------------------------------------
  -- For item discounts: apply per-line and sum.
  -- -------------------------------------------------------------------
  if p_discount_type = 'item' then
    -- Reset existing per-line discounts on this invoice first.
    update public.invoice_items
       set discount_amount = 0, discount_percent = 0
     where invoice_id = p_invoice_id;

    for v_item_row in
      select * from jsonb_array_elements(p_item_discounts) as elem
    loop
      select * into v_item_total
        from public.invoice_items
       where id = (v_item_row->>'item_id')::uuid
         and invoice_id = p_invoice_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'Line item not found on this invoice');
      end if;
      if coalesce((v_item_row->>'amount')::numeric, 0) > 0 then
        v_line_discount := round((v_item_row->>'amount')::numeric, 2);
      elsif coalesce((v_item_row->>'percent')::numeric, 0) > 0 then
        v_line_discount := round(v_item_total * (v_item_row->>'percent')::numeric / 100, 2);
      else
        v_line_discount := 0;
      end if;
      if v_line_discount > v_item_total then
        return jsonb_build_object('ok', false, 'error', 'Line discount exceeds line total');
      end if;
      update public.invoice_items
         set discount_amount = v_line_discount,
             discount_percent = coalesce((v_item_row->>'percent')::numeric, 0)
       where id = (v_item_row->>'item_id')::uuid;
      v_discount_amt := v_discount_amt + v_line_discount;
    end loop;
    v_discount_amt := round(v_discount_amt, 2);
  end if;

  -- -------------------------------------------------------------------
  -- Recompute grand total + balance (preserve amount_paid).
  -- -------------------------------------------------------------------
  v_grand_total := greatest(0, v_subtotal - v_discount_amt + coalesce(v_inv.tax, 0));
  v_balance     := greatest(0, v_grand_total - v_amount_paid);

  -- -------------------------------------------------------------------
  -- Apply. Update the existing flat `discount` column too so legacy
  -- receipts/reports that read `discount` stay consistent.
  -- -------------------------------------------------------------------
  update public.invoices
     set discount              = v_discount_amt,
         discount_type         = p_discount_type,
         discount_percent      = v_discount_pct,
         discount_reason       = p_reason,
         discount_approved_by  = case when p_approval_request_id is not null
                                      then (select approver_id from public.approval_requests
                                             where id = p_approval_request_id)
                                      else null end,
         discount_approved_at  = case when p_approval_request_id is not null
                                      then (select approved_at from public.approval_requests
                                             where id = p_approval_request_id)
                                      else null end,
         discount_approval_request_id = p_approval_request_id,
         grand_total           = v_grand_total,
         balance               = v_balance,
         status                = case when v_balance <= 0 then 'paid'
                                       when v_amount_paid > 0 then 'partial'
                                       else status end,
         updated_at            = now()
   where id = p_invoice_id;

  -- -------------------------------------------------------------------
  -- Audit (append-only). before/after values captured.
  -- -------------------------------------------------------------------
  insert into public.audit_events (
    hospital_id, actor_id, actor_role, actor_name,
    action, entity_type, entity_id, patient_id, summary, metadata, created_at
  ) values (
    v_inv.hospital_id, v_caller.id, v_caller.role, v_caller.full_name,
    'billing.discount_applied', 'invoice', p_invoice_id, v_inv.patient_id,
    'Applied ' || p_discount_type || ' discount of ₦' || v_discount_amt
      || ' to invoice ' || coalesce(v_inv.invoice_number, p_invoice_id::text)
      || coalesce(': ' || p_reason, ''),
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'discount_type', p_discount_type,
      'discount_percent', v_discount_pct,
      'discount_amount', v_discount_amt,
      'reason', p_reason,
      'subtotal_before', v_subtotal,
      'discount_before', v_old_discount,
      'total_before', v_old_total,
      'total_after', v_grand_total,
      'balance_after', v_balance,
      'amount_paid', v_amount_paid,
      'approval_request_id', p_approval_request_id,
      'caller_role', v_caller.role
    ),
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'invoice_id', p_invoice_id,
    'subtotal', v_subtotal,
    'discount_amount', v_discount_amt,
    'discount_percent', v_discount_pct,
    'grand_total', v_grand_total,
    'amount_paid', v_amount_paid,
    'balance', v_balance
  );
end;
$$;

-- =====================================================================
-- 4. RPC — create_discount_approval_request
-- =====================================================================
-- A cashier calls this when their desired discount exceeds their limit.
-- Creates a pending approval_requests row (request_type='discount')
-- reusing the existing approval infrastructure (052). Does NOT modify
-- the invoice.
-- ---------------------------------------------------------------------

create or replace function public.create_discount_approval_request(
  p_invoice_id      uuid,
  p_discount_type   text,
  p_discount_value  numeric,
  p_reason          text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv      public.invoices;
  v_caller   record;
  v_subtotal numeric(14,2);
  v_amount   numeric(14,2);
  v_pct      numeric(5,2);
  v_req_id   uuid;
  v_existing uuid;
begin
  select id, role, full_name, hospital_id into v_caller
    from public.profiles where id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Not authenticated');
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Invoice not found');
  end if;
  if v_inv.hospital_id is distinct from v_caller.hospital_id
     and v_caller.role <> 'owner' then
    return jsonb_build_object('ok', false, 'error', 'Invoice does not belong to your hospital');
  end if;

  -- Prevent duplicate pending requests for the same invoice.
  select id into v_existing from public.approval_requests
   where hospital_id = v_inv.hospital_id
     and entity_id = p_invoice_id
     and request_type = 'discount'
     and status = 'pending';
  if found then
    return jsonb_build_object('ok', false, 'error',
      'A pending discount request already exists for this invoice', 'request_id', v_existing);
  end if;

  select coalesce(sum(total), 0) into v_subtotal
    from public.invoice_items where invoice_id = p_invoice_id;

  if p_discount_type = 'percent' then
    v_pct := p_discount_value;
    v_amount := round(v_subtotal * v_pct / 100, 2);
  else
    v_amount := p_discount_value;
    v_pct := case when v_subtotal > 0 then round(v_amount / v_subtotal * 100, 2) else 0 end;
  end if;

  insert into public.approval_requests (
    hospital_id, request_type, entity_type, entity_id,
    amount, requested_by, requested_by_name, reason,
    approver_role, status, payload
  ) values (
    v_inv.hospital_id, 'discount', 'invoice', p_invoice_id,
    v_amount, v_caller.id, v_caller.full_name, p_reason,
    'admin', 'pending',
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'patient_id', v_inv.patient_id,
      'subtotal', v_subtotal,
      'discount_type', p_discount_type,
      'discount_value', p_discount_value,
      'discount_amount', v_amount,
      'discount_percent', v_pct,
      'reason', p_reason
    )
  )
  returning id into v_req_id;

  insert into public.audit_events (
    hospital_id, actor_id, actor_role, actor_name,
    action, entity_type, entity_id, patient_id, summary, metadata, created_at
  ) values (
    v_inv.hospital_id, v_caller.id, v_caller.role, v_caller.full_name,
    'billing.discount_approval_requested', 'invoice', p_invoice_id, v_inv.patient_id,
    'Requested ' || p_discount_type || ' discount approval (₦' || v_amount
      || ') for invoice ' || coalesce(v_inv.invoice_number, p_invoice_id::text),
    jsonb_build_object(
      'invoice_id', p_invoice_id, 'approval_request_id', v_req_id,
      'discount_type', p_discount_type, 'discount_amount', v_amount,
      'discount_percent', v_pct, 'reason', p_reason
    ),
    now()
  );

  return jsonb_build_object('ok', true, 'request_id', v_req_id, 'amount', v_amount, 'percent', v_pct);
end;
$$;

-- =====================================================================
-- 5. RPC — get_discount_settings  (read config; auto-creates defaults)
-- =====================================================================
create or replace function public.get_discount_settings(p_hospital_id uuid)
returns public.hospital_discount_settings
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.ensure_discount_settings(p_hospital_id);
end;
$$;

-- =====================================================================
-- 6. REALTIME + INDEXES
-- =====================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'hospital_discount_settings'
  ) then
    alter publication supabase_realtime add table public.hospital_discount_settings;
  end if;
end $$;

create index if not exists invoices_discount_approval_idx
  on public.invoices (hospital_id, discount_approval_request_id)
  where discount_approval_request_id is not null;

create index if not exists invoice_items_discount_idx
  on public.invoice_items (invoice_id)
  where discount_amount > 0;

-- =====================================================================
-- 7. GRANT execute on the new RPCs to authenticated users.
-- =====================================================================
grant execute on function public.apply_invoice_discount(uuid,text,numeric,text,uuid,jsonb) to authenticated;
grant execute on function public.create_discount_approval_request(uuid,text,numeric,text) to authenticated;
grant execute on function public.get_discount_settings(uuid) to authenticated;
grant execute on function public.ensure_discount_settings(uuid) to authenticated;

-- =====================================================================
-- 8. VERIFICATION — show the live state after running.
-- =====================================================================
select 'hospital_discount_settings' as table_name,
       count(*) as rows
  from public.hospital_discount_settings
union all
select 'invoices discount_type column',
       count(*)
  from information_schema.columns
 where table_schema='public' and table_name='invoices' and column_name='discount_type'
union all
select 'invoice_items discount_amount column',
       count(*)
  from information_schema.columns
 where table_schema='public' and table_name='invoice_items' and column_name='discount_amount';
