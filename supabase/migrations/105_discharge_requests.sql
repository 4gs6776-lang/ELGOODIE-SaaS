-- =====================================================================
-- GOODIE-MEDHUB — 105_discharge_requests.sql
-- ---------------------------------------------------------------------
-- Discharge workflow module — multi-step flow for releasing a patient
-- from the hospital:
--   1. Doctor initiates discharge (writes discharge summary + take-home
--      drugs + discharge request)
--   2. Nurse acknowledges + records nursing discharge notes
--   3. Billing clears the patient's outstanding balance (verifies
--      payment / flags outstanding)
--   4. Final sign-off → patient is discharged; their queue status
--      flips to 'discharged'.
--
-- Each discharge has ONE row in `discharge_requests` that moves
-- through workflow stages. The take-home drugs are stored as a JSONB
-- array on the same row (loose; not linked to prescriptions because
-- take-home drugs are NOT billable charges — they're the doctor's
-- "go home with these" instructions).
--
-- If the take-home drugs should ALSO be dispensed from pharmacy, the
-- cashier can convert them to billable_charges (status 'pending')
-- from the discharge UI — that's an application concern, not schema.
--
-- Safe to re-run: every statement uses IF NOT EXISTS / guarded alter.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.discharge_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,

  -- Workflow
  status              text NOT NULL DEFAULT 'doctor_pending'
                      CHECK (status IN (
                        'doctor_pending',         -- doctor needs to write summary
                        'nurse_pending',          -- doctor done; nurse to confirm
                        'billing_pending',        -- nurse done; billing to clear
                        'ready_for_discharge',    -- billing cleared; final sign-off
                        'discharged',             -- patient left the hospital
                        'cancelled'               -- discharge called off
                      )),

  -- ---- Doctor section (Step 1) ----
  discharge_type      text CHECK (discharge_type IN ('home','transfer','ama','death','absconded')),
  discharge_diagnosis text,
  working_diagnosis   text,
  admission_diagnosis text,                -- what they came in with
  course_in_hospital  text,                -- free text summary of treatment course
  investigations      text,                -- notable labs / imaging + results
  treatment_given     text,                -- medications / procedures administered
  discharge_summary   text,                -- narrative summary (the "official" summary)
  follow_up_plan       text,                -- "Review in surgical OPD in 2 weeks"
  follow_up_date      date,
  take_home_drugs     jsonb,                -- array of {drug, dose, frequency, duration, quantity, instructions}
  is_deceased         boolean DEFAULT false,
  death_date          timestamptz,
  doctor_id           uuid,
  doctor_name         text,
  doctor_signed_at    timestamptz,

  -- ---- Nurse section (Step 2) ----
  nursing_discharge_notes text,
  patient_condition_at_discharge text CHECK (patient_condition_at_discharge IN ('stable','improved','unchanged','deteriorated','critical','deceased')),
  nurse_id            uuid,
  nurse_name          text,
  nurse_signed_at     timestamptz,

  ---- Billing section (Step 3) ----
  outstanding_balance numeric(14,2),        -- snapshot of patient's outstanding at discharge time
  payment_status      text CHECK (payment_status IN ('cleared','partial','outstanding','waived')),
  billing_notes       text,
  billing_staff_id    uuid,
  billing_staff_name  text,
  billing_signed_at   timestamptz,

  ---- Final (Step 4) ----
  final_discharged_at timestamptz,
  final_discharged_by uuid,
  final_discharged_by_name text,

  ---- Admission link (so the Admissions module can mark the bed free) ----
  admission_id        uuid,                  -- FK to admissions (loose, no constraint)

  -- Audit
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS discharge_requests_patient_idx
  ON public.discharge_requests (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS discharge_requests_hospital_idx
  ON public.discharge_requests (hospital_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS discharge_requests_status_idx
  ON public.discharge_requests (hospital_id, status);

-- RLS — same pattern as deliveries / theatre_cases
ALTER TABLE public.discharge_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "discharge_requests_select_own_hospital" ON public.discharge_requests;
CREATE POLICY "discharge_requests_select_own_hospital" ON public.discharge_requests
  FOR SELECT USING (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "discharge_requests_insert_own_hospital" ON public.discharge_requests;
CREATE POLICY "discharge_requests_insert_own_hospital" ON public.discharge_requests
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id()
    AND public.is_hospital_writable_role());

DROP POLICY IF EXISTS "discharge_requests_update_own_hospital" ON public.discharge_requests;
CREATE POLICY "discharge_requests_update_own_hospital" ON public.discharge_requests
  FOR UPDATE USING (hospital_id = public.current_hospital_id()
    AND public.is_hospital_writable_role());

DROP POLICY IF EXISTS "discharge_requests_delete_own_hospital" ON public.discharge_requests;
CREATE POLICY "discharge_requests_delete_own_hospital" ON public.discharge_requests
  FOR DELETE USING (hospital_id = public.current_hospital_id()
    AND (public.is_owner() OR public.current_role_text() = 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.discharge_requests TO authenticated;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_discharge_requests_updated_at ON public.discharge_requests;
CREATE TRIGGER trg_discharge_requests_updated_at
  BEFORE UPDATE ON public.discharge_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Realtime publication
ALTER TABLE public.discharge_requests REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.discharge_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------
-- Verification:
--   \d public.discharge_requests
--   SELECT status, count(*) FROM public.discharge_requests GROUP BY status;
-- -----------------------------------------------------------------
