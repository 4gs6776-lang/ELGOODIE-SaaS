-- =====================================================================
-- GOODIE-MEDHUB — 091_shift_handover_sbar_upgrade.sql
-- =====================================================================
-- Upgrades the existing shift_handovers table with SBAR fields +
-- auto-generated clinical summary.
--
-- The existing table (migration 005) already has:
--   id, hospital_id, shift_type, outgoing_staff_id, outgoing_staff_name,
--   incoming_staff_id, incoming_staff_name, status, handover_notes,
--   acknowledged_by, acknowledged_by_name, acknowledged_at, created_at
--
-- This migration ADDS:
--   sbar_situation, sbar_background, sbar_assessment, sbar_recommendation,
--   auto_generated_summary (JSONB with critical patients, pending labs, etc.)
--
-- Safe to re-run. Idempotent.
-- =====================================================================

ALTER TABLE public.shift_handovers ADD COLUMN IF NOT EXISTS sbar_situation text;
ALTER TABLE public.shift_handovers ADD COLUMN IF NOT EXISTS sbar_background text;
ALTER TABLE public.shift_handovers ADD COLUMN IF NOT EXISTS sbar_assessment text;
ALTER TABLE public.shift_handovers ADD COLUMN IF NOT EXISTS sbar_recommendation text;
ALTER TABLE public.shift_handovers ADD COLUMN IF NOT EXISTS auto_generated_summary jsonb;

-- =====================================================================
-- Verification
-- =====================================================================
DO $_$
BEGIN
  RAISE NOTICE 'shift_handovers table upgraded with SBAR columns.';
END $_$;
