-- =====================================================================
-- GOODIE-MEDHUB — fix orphaned patient_drug_charts rows
--
-- ROOT CAUSE (context for the operator running this)
--   MedicationChart.jsx's "Add Chart Entry" form was creating rows
--   without setting chart_status, and allowed prescription_id = NULL
--   when the nurse didn't pick a prescription from the dropdown.
--   The DB column has DEFAULT 'pending', so the row was saved with
--   chart_status='pending' and prescription_id=NULL.
--
--   The workflow that flips pending -> given
--   (drugChartWorkflow.js recordMedicationAdministration) looks up
--   chart rows BY prescription_id — so a NULL-prescription_id row
--   can never be matched and never moves out of 'pending'. These
--   are the rows that show as "stuck" in the QA Sync panel.
--
--   The companion code fix (MedicationChart.jsx handleSubmit) now sets
--   chart_status='given' when no prescription is linked, so NEW manual
--   entries won't get stuck. This script cleans up the EXISTING
--   orphan rows.
--
-- HOW TO USE
--   1. Run STEP 0 (schema probe). It tells you the ACTUAL column
--      names on both tables — needed because the app's "schema-gap
--      tolerance" layer silently drops columns Postgres rejects, so
--      the live schema may diverge from what the source code writes.
--   2. Run STEP 1 (dry run). It lists the orphan rows.
--   3. Pick OPTION A (DELETE) or OPTION B (UPDATE -> 'given').
--      OPTION B is the recommended default — it preserves the rows
--      and stops them showing as stuck, without destroying data.
--   4. Run STEP 2 (verify).
--
-- SAFETY
--   - Every multi-statement option is wrapped in BEGIN/COMMIT.
--   - The cross-checks below use ONLY columns verified to exist on
--     the live DB (patient_id, entry_date, administered_at).
--   - Option A's DELETE excludes any chart row whose (patient_id,
--     entry_date) matches an existing medication_administrations row,
--     so a real-but-unsynced administration won't be lost.
-- =====================================================================


-- =====================================================================
-- STEP 0 — SCHEMA PROBE (run first; no transaction needed)
-- =====================================================================
-- Lists the actual columns on both tables. Use this to confirm
-- column names before trusting the cross-check in STEP 1.

SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('patient_drug_charts', 'medication_administrations')
 ORDER BY table_name, ordinal_position;


-- =====================================================================
-- STEP 1 — DRY RUN: see what would be affected (rolled back)
-- =====================================================================
BEGIN;

-- How many orphan rows are there?
SELECT COUNT(*) AS orphan_pending_count
  FROM public.patient_drug_charts
 WHERE prescription_id IS NULL
   AND chart_status = 'pending';

-- What do they look like? (limit 50 for readability)
SELECT id, patient_id, drug_name, chart_status,
       entry_date, entry_time, created_at
  FROM public.patient_drug_charts
 WHERE prescription_id IS NULL
   AND chart_status = 'pending'
 ORDER BY created_at DESC
 LIMIT 50;

-- Cross-check: do any of these orphans have a linked administration?
-- (If yes, the row IS real and was administered — prefer Option B
--  UPDATE over Option A DELETE.)
--
-- We match on (patient_id, entry_date) only. We do NOT match on
-- drug_name because medication_administrations may not have that
-- column on the live DB (the app silently drops columns Postgres
-- rejects — see migration 004's comment about the schema-gap
-- tolerance layer). administered_at is a timestamptz; we cast both
-- sides to date for the join. If your STEP 0 probe shows the column
-- is actually named differently (e.g. 'admin_time'), adjust here.
SELECT c.id AS chart_id, c.patient_id, c.drug_name, c.entry_date,
       a.id AS admin_id, a.administered_at
  FROM public.patient_drug_charts c
  LEFT JOIN public.medication_administrations a
    ON a.patient_id = c.patient_id
   AND a.administered_at::date = c.entry_date::date
 WHERE c.prescription_id IS NULL
   AND c.chart_status = 'pending'
   AND a.id IS NOT NULL
 LIMIT 50;

ROLLBACK;  -- dry run only; nothing is committed


-- =====================================================================
-- OPTION A — DELETE the orphan rows
--
-- Use this if the orphan rows are test data, duplicates, or junk
-- entries that were never real medication administrations.
--
-- The NOT EXISTS guard preserves any chart row that has a matching
-- medication_administrations entry on (patient_id, entry_date).
-- =====================================================================
-- BEGIN;
--
-- -- Show what will be deleted (one more sanity check, then commit below).
-- SELECT id, patient_id, drug_name, chart_status, created_at
--   FROM public.patient_drug_charts
--  WHERE prescription_id IS NULL
--    AND chart_status = 'pending';
--
-- DELETE FROM public.patient_drug_charts c
--  WHERE c.prescription_id IS NULL
--    AND c.chart_status = 'pending'
--    AND NOT EXISTS (
--      SELECT 1
--        FROM public.medication_administrations a
--       WHERE a.patient_id = c.patient_id
--         AND a.administered_at::date = c.entry_date::date
--    );
--
-- COMMIT;


-- =====================================================================
-- OPTION B — UPDATE the orphans to chart_status='given'
--
-- Use this if the orphan rows represent real meds the nurse actually
-- administered but couldn't link to a prescription (e.g. OTC meds,
-- PRN meds without a doctor's order, or meds given before the
-- prescription sync landed). This preserves the row as a record that
-- the med was charted, and stops it from showing as stuck.
--
-- This is the safer option and the recommended default.
-- =====================================================================
-- BEGIN;
--
-- UPDATE public.patient_drug_charts
--    SET chart_status = 'given'
--  WHERE prescription_id IS NULL
--    AND chart_status = 'pending';
--
-- -- Verify the update landed.
-- SELECT chart_status, COUNT(*) AS row_count
--   FROM public.patient_drug_charts
--  WHERE prescription_id IS NULL
--  GROUP BY chart_status;
--
-- COMMIT;


-- =====================================================================
-- STEP 2 — VERIFY after whichever option you ran
-- =====================================================================
-- Should now return ZERO rows.
SELECT COUNT(*) AS remaining_orphan_pending
  FROM public.patient_drug_charts
 WHERE prescription_id IS NULL
   AND chart_status = 'pending';

-- Sanity-check the overall chart_status distribution.
SELECT chart_status, COUNT(*) AS row_count
  FROM public.patient_drug_charts
 GROUP BY chart_status
 ORDER BY row_count DESC;
