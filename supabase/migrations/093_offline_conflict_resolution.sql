-- =====================================================================
-- GOODIE-MEDHUB — 093_offline_conflict_resolution.sql
-- =====================================================================
-- Adds version tracking columns to critical clinical tables for
-- conflict resolution during offline sync.
--
-- Strategy: field-level merge for clinical fields, last-write-wins
-- for administrative fields.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
ALTER TABLE public.patient_vitals ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
ALTER TABLE public.admission_requests ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;

-- Add a trigger to auto-increment _version on update
-- (so we can detect if a record was changed remotely while we were offline)

CREATE OR REPLACE FUNCTION public.increment_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW._version = COALESCE(OLD._version, 0) + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patients_version ON public.patients;
CREATE TRIGGER trg_patients_version BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.increment_version();

DROP TRIGGER IF EXISTS trg_patient_vitals_version ON public.patient_vitals;
CREATE TRIGGER trg_patient_vitals_version BEFORE UPDATE ON public.patient_vitals
  FOR EACH ROW EXECUTE FUNCTION public.increment_version();

DROP TRIGGER IF EXISTS trg_prescriptions_version ON public.prescriptions;
CREATE TRIGGER trg_prescriptions_version BEFORE UPDATE ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.increment_version();

DROP TRIGGER IF EXISTS trg_invoices_version ON public.invoices;
CREATE TRIGGER trg_invoices_version BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.increment_version();

DROP TRIGGER IF EXISTS trg_admission_requests_version ON public.admission_requests;
CREATE TRIGGER trg_admission_requests_version BEFORE UPDATE ON public.admission_requests
  FOR EACH ROW EXECUTE FUNCTION public.increment_version();

DO $_$
BEGIN
  RAISE NOTICE 'Version tracking added to 5 critical tables.';
END $_$;
