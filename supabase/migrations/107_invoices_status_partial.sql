-- =====================================================================
-- GOODIE-MEDHUB — 107_invoices_status_partial.sql
--
-- Problem
-- -------
-- The original Phase 1 `invoices` table was created with a CHECK on the
-- `status` column that only allowed three payment states:
--
--     status IN ('paid','unpaid','cancelled')
--
-- (The constraint name Postgres auto-generated is `invoices_status_check`.)
--
-- Phase 2 (migration 041) introduced the `draft_status` column for the
-- *lifecycle* state (draft | finalized | cancelled | written_off) and
-- kept `status` for the *payment* state. The frontend billing code
-- (CashierWorkspace.jsx → handleSaveAsDraft / handleGenerateInvoice)
-- correctly derives `status` from the amount paid:
--
--     totalPaid >= amountOwed   → 'paid'
--     totalPaid > 0            → 'partial'      ← NOT in the old check
--     totalPaid === 0           → 'unpaid'
--
-- So whenever a patient made a PARTIAL payment (e.g. owed ₦10,000, paid
-- ₦5,000, balance ₦5,000) and the cashier clicked "Save as Draft" or
-- "Generate Invoice", the INSERT failed with:
--
--     new row for relation "invoices" violates check constraint
--     "invoices_status_check"
--
-- The partial payment was never recorded. Same bug on "Generate Invoice".
--
-- Fix
-- ---
-- Drop the old constraint and re-create it to include 'partial'. This is
-- a pure widening of the allowed set — existing rows ('paid' / 'unpaid' /
-- 'cancelled') all still satisfy the new constraint, so no data migration
-- is needed.
--
-- SAFE TO RE-RUN: the DROP is wrapped in a DO block that checks
-- information_schema first, so it won't error if run twice.
-- =====================================================================

do $$
begin
  -- Only drop the constraint if it actually exists (idempotent).
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public'
       and table_name   = 'invoices'
       and constraint_name = 'invoices_status_check'
  ) then
    alter table public.invoices drop constraint invoices_status_check;
  end if;
end $$;

-- New constraint: payment state. 'partial' = some, but not all, of the
-- grand total has been paid (amount_paid > 0 AND amount_paid < grand_total).
-- 'written_off' is also allowed because the write-off flow
-- (migration 094_invoice_writeoffs) flips status to 'written_off' when an
-- uncollectible balance is zeroed out, and some older rows already use it.
alter table public.invoices
  add constraint invoices_status_check
    check (status in ('unpaid','partial','paid','cancelled','written_off'));
