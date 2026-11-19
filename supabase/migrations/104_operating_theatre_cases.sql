-- =====================================================================
-- GOODIE-MEDHUB — 104_operating_theatre_cases.sql
-- ---------------------------------------------------------------------
-- Operating Theatre (Thaether) module — tracks surgical cases end-to-
-- end: scheduling → pre-op assessment → intra-op notes → post-op
-- recovery → case closure. Replaces ad-hoc notes scattered across
-- the patient's drug chart / vitals history with one structured case
-- record per surgery.
--
-- Each case is a self-contained record that can be progressively
-- updated as the case moves through its workflow. The status column
-- tracks where in the workflow the case is right now.
--
-- Safe to re-run: every statement uses IF NOT EXISTS / guarded alter.
-- =====================================================================

-- -----------------------------------------------------------------
-- 1. The theatre_cases table — one row per surgical case.
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.theatre_cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,

  -- Case identification
  case_number         text,            -- e.g. OT-2026-0001 (assigned at scheduling)
  procedure_name      text NOT NULL,    -- e.g. "Appendectomy", "C-Section", "Hernia repair"
  procedure_code      text,             -- optional ICD-10-PCS or hospital procedure code
  category            text CHECK (category IN ('elective','urgent','emergency')),
  laterality          text CHECK (laterality IN ('left','right','bilateral','n/a')),

  -- Scheduling
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  theatre_room        text,             -- "Theatre 1", "Theatre 2"
  status              text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN (
                        'scheduled',          -- booked, not yet started
                        'pre_op_assessment',  -- patient in pre-op
                        'in_theatre',         -- surgery in progress
                        'recovery',           -- in PACU / recovery ward
                        'completed',          -- case closed, patient out of recovery
                        'cancelled'           -- case called off
                      )),

  -- Pre-op assessment
  pre_op_diagnosis    text,
  pre_op_notes        text,
  asa_classification  text CHECK (asa_classification IN ('I','II','III','IV','V','VI','n/a')),
  fasting_status      text CHECK (fasting_status IN ('fasted','not_fasted','unknown')),
  consent_obtained    boolean DEFAULT false,
  consent_obtained_by uuid,              -- staff who took consent

  -- Theatre team
  surgeon_name        text,
  surgeon_id         uuid,              -- FK to profiles (loose)
  anesthetist_name   text,
  anesthetist_id     uuid,
  scrub_nurse_name   text,
  circulating_nurse  text,

  -- Anesthesia
  anesthesia_type     text CHECK (anesthesia_type IN ('general','spinal','epidural','local','regional','sedation','none')),
  anesthesia_notes   text,

  -- Intra-op details
  actual_start       timestamptz,
  actual_end         timestamptz,
  intra_op_findings  text,
  procedure_performed text,              -- what was actually done (may differ from scheduled)
  complications       text,
  blood_loss_ml       integer,
  fluids_given_ml     integer,
  specimens_sent      text,               -- e.g. "Appendix to histology"
  implants_used       text,               -- e.g. "Mesh 10x15cm"

  -- Post-op / recovery
  recovery_room_entry timestamptz,
  recovery_room_exit  timestamptz,
  post_op_diagnosis   text,
  post_op_notes       text,
  disposition         text CHECK (disposition IN ('home','ward','icu','hdw','transfer','death')),

  -- Audit
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS theatre_cases_patient_idx
  ON public.theatre_cases (patient_id, scheduled_start DESC);
CREATE INDEX IF NOT EXISTS theatre_cases_hospital_idx
  ON public.theatre_cases (hospital_id, scheduled_start DESC);
CREATE INDEX IF NOT EXISTS theatre_cases_status_idx
  ON public.theatre_cases (hospital_id, status);
CREATE INDEX IF NOT EXISTS theatre_cases_surgeon_idx
  ON public.theatre_cases (hospital_id, surgeon_id);

-- Row Level Security — same pattern as deliveries / anc_visits
ALTER TABLE public.theatre_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "theatre_cases_select_own_hospital" ON public.theatre_cases;
CREATE POLICY "theatre_cases_select_own_hospital" ON public.theatre_cases
  FOR SELECT USING (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "theatre_cases_insert_own_hospital" ON public.theatre_cases;
CREATE POLICY "theatre_cases_insert_own_hospital" ON public.theatre_cases
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id()
    AND public.is_hospital_writable_role());

DROP POLICY IF EXISTS "theatre_cases_update_own_hospital" ON public.theatre_cases;
CREATE POLICY "theatre_cases_update_own_hospital" ON public.theatre_cases
  FOR UPDATE USING (hospital_id = public.current_hospital_id()
    AND public.is_hospital_writable_role());

DROP POLICY IF EXISTS "theatre_cases_delete_own_hospital" ON public.theatre_cases;
CREATE POLICY "theatre_cases_delete_own_hospital" ON public.theatre_cases
  FOR DELETE USING (hospital_id = public.current_hospital_id()
    AND (public.is_owner() OR public.current_role_text() = 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.theatre_cases TO authenticated;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_theatre_cases_updated_at ON public.theatre_cases;
CREATE TRIGGER trg_theatre_cases_updated_at
  BEFORE UPDATE ON public.theatre_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Realtime publication
ALTER TABLE public.theatre_cases REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.theatre_cases;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------
-- Verification queries:
--   \d public.theatre_cases
--   SELECT status, count(*) FROM public.theatre_cases GROUP BY status;
-- -----------------------------------------------------------------
