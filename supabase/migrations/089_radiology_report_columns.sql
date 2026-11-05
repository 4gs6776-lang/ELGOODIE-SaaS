-- =====================================================================
-- GOODIE-MEDHUB — 089_radiology_report_columns.sql
-- =====================================================================
-- Adds detailed radiology report columns to the existing radiology_scans
-- table. Supports the new Radiology Report Form feature.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS patient_id uuid;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS referring_doctor text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS contrast_used text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS radiation_dose text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS technique text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS findings text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS impression text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS recommendation text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS scan_image_path text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS reported_by uuid;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS reported_by_name text;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS reported_at timestamptz;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS sent_to_nurse boolean NOT NULL DEFAULT false;
ALTER TABLE public.radiology_scans ADD COLUMN IF NOT EXISTS sent_to_nurse_at timestamptz;

-- Add 'ready_for_printing' to the status check (if a constraint exists)
-- Since the original table was created outside tracked migrations, we
-- just update the status via application logic — no constraint to alter.

CREATE INDEX IF NOT EXISTS radiology_scans_status_idx
  ON public.radiology_scans (hospital_id, status);

CREATE INDEX IF NOT EXISTS radiology_scans_sent_to_nurse_idx
  ON public.radiology_scans (hospital_id, sent_to_nurse);

DO $$
BEGIN
  RAISE NOTICE 'radiology_scans table extended with report columns.';
END $$;
