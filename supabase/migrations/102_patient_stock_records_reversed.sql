-- =====================================================================
-- GOODIE-MEDHUB — 102_patient_stock_records_reversed.sql
-- Adds `reversed` + `reversed_at` + `reversed_by` columns to
-- patient_stock_records so a mistakenly dispensed drug can be
-- voided (un-dispensed) without destroying the audit trail.
--
-- A dispense touches 4-5 tables (pharmacy_items / inventory_items,
-- patient_stock_records, billable_charges, prescriptions, optionally
-- pharmacy_requests). The reverse function must restore stock,
-- void the billable charge, reset the prescription status, and flag
-- the patient_stock_records row as reversed — but NOT delete it.
-- We keep the original record so the patient's "Items Given" tab
-- history stays intact (shows the dispense, then the reversal).
--
-- SAFE TO RE-RUN: every statement uses IF NOT EXISTS / guarded alter.
-- =====================================================================

-- 1. `reversed` boolean — defaults to false. True means this dispense
--    has been voided; stock has been returned to the shelf, the
--    billable charge has been voided, and the prescription (if any)
--    has been reset to 'active'.
alter table public.patient_stock_records
  add column if not exists reversed boolean not null default false;

-- 2. `reversed_at` timestamptz — when the reversal happened. NULL on
--    active dispenses.
alter table public.patient_stock_records
  add column if not exists reversed_at timestamptz;

-- 3. `reversed_by` uuid — the staff member who performed the reversal.
--    Loose FK to profiles (no constraint — keeps old rows valid).
alter table public.patient_stock_records
  add column if not exists reversed_by uuid;

-- 4. `reversed_reason` text — required for audit (e.g. "Wrong patient",
--    "Wrong dosage", "Patient returned item"). Stored on the row so
--    anyone looking at the dispense later sees why it was voided.
alter table public.patient_stock_records
  add column if not exists reversed_reason text;

-- 5. Optional reverse FK to the linked billable_charge that was voided
--    in the same reversal. Loose (no constraint) — the row may have
--    been hard-deleted by an admin.
alter table public.patient_stock_records
  add column if not exists voided_billable_charge_id uuid;

-- 6. Optional FK to the linked prescription that was reset to 'active'.
--    Loose. Helps the reversal UI find what to reset.
alter table public.patient_stock_records
  add column if not exists linked_prescription_id uuid;

-- 7. Optional FK to the linked pharmacy_request that was reset to 'pending'.
--    Loose. Same purpose.
alter table public.patient_stock_records
  add column if not exists linked_pharmacy_request_id uuid;

-- 8. Index for "show me all reversed dispenses for this patient" queries.
create index if not exists patient_stock_records_reversed_idx
  on public.patient_stock_records (hospital_id, patient_id, reversed);

-- ---------------------------------------------------------------------
-- Verification (run after applying):
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'patient_stock_records'
--      and column_name like 'reversed%' or column_name like 'voided%' or column_name like 'linked%';
--   -- should return: reversed, reversed_at, reversed_by, reversed_reason,
--   -- voided_billable_charge_id, linked_prescription_id, linked_pharmacy_request_id
-- ---------------------------------------------------------------------
