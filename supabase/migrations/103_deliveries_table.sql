-- =====================================================================
-- GOODIE-MEDHUB — 103_deliveries_table.sql
-- ---------------------------------------------------------------------
-- Delivery module: tracks every ANC patient's labour + delivery event.
-- Replaces the workaround of overloading patients.anc_edd with
-- 'Delivered' (which destroyed the original EDD). Instead, each
-- delivery gets its own row in `deliveries` with full clinical detail:
--   • delivery type (vaginal / c-section / assisted / miscarriage)
--   • baby gender + weight + APGAR scores
--   • labour onset, duration, complications
--   • birth attendant + facility
--
-- We ALSO add two summary columns back to `patients` so the patient
-- profile can show "Delivered on <date>" without joining:
--   • anc_delivery_status  (pregnant | delivered | miscarried)
--   • anc_delivery_date    (the date the delivery happened)
--
-- Safe to re-run: every statement uses IF NOT EXISTS / guarded alter.
-- =====================================================================

-- -----------------------------------------------------------------
-- 1. The deliveries table — one row per delivery event.
--    A patient could in theory have multiple deliveries across
--    pregnancies (this hospital delivers a baby → 1 row; same patient
--    returns 2 years later → 2nd row). Each row is a self-contained
--    clinical record. The patient's profile reads the most recent row
--    for its "Delivered on ..." summary.
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id           uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id            uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,

  -- Link to the ANC booking record (patients.anc_lmp / anc_edd are
  -- stored on patients, so we link back rather than duplicate them).
  -- Loose — no FK — because the ANC data lives on patients.

  -- Delivery event metadata
  delivery_date         date NOT NULL DEFAULT CURRENT_DATE,
  delivery_type         text NOT NULL CHECK (delivery_type IN
                          ('vaginal','c_section','assisted_vaginal','miscarriage','stillbirth')),
  labour_onset          text CHECK (labour_onset IN ('spontaneous','induced','augmented','scheduled','n/a')),
  gestational_age_weeks integer,         -- weeks at delivery (may differ from booking EDD if preterm)
  labour_duration_hours numeric(5,2),

  -- Baby outcome (single baby per row; for twins etc. create one row per baby)
  baby_gender           text CHECK (baby_gender IN ('male','female','ambiguous','unknown')),
  baby_weight_kg        numeric(5,3),    -- 3 dp so 2.345 kg is precise
  apgar_1min            integer CHECK (apgar_1min >= 0 AND apgar_1min <= 10),
  apgar_5min            integer CHECK (apgar_5min >= 0 AND apgar_5min <= 10),
  baby_outcome          text CHECK (baby_outcome IN ('alive','stillbirth','neonatal_death')),

  -- Clinical notes
  complications         text,             -- free text: e.g. "PPH, retained placenta"
  delivery_notes        text,              -- free text: any notes from the birth attendant

  -- Staff + facility
  birth_attendant_name   text,             -- doctor / midwife name (denormalized for history)
  birth_attendant_role   text CHECK (birth_attendant_role IN
                          ('doctor','midwife','nurse','other')),
  delivery_location      text,             -- "Labour Ward", "Theatre", "Home delivery", etc.

  -- Audit columns
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS deliveries_patient_idx
  ON public.deliveries (patient_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS deliveries_hospital_idx
  ON public.deliveries (hospital_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS deliveries_type_idx
  ON public.deliveries (hospital_id, delivery_type);

-- Row Level Security — same pattern as anc_visits
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deliveries_select_own_hospital" ON public.deliveries;
CREATE POLICY "deliveries_select_own_hospital" ON public.deliveries
  FOR SELECT USING (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "deliveries_insert_own_hospital" ON public.deliveries;
CREATE POLICY "deliveries_insert_own_hospital" ON public.deliveries
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id()
    AND public.is_hospital_writable_role());

DROP POLICY IF EXISTS "deliveries_update_own_hospital" ON public.deliveries;
CREATE POLICY "deliveries_update_own_hospital" ON public.deliveries
  FOR UPDATE USING (hospital_id = public.current_hospital_id()
    AND public.is_hospital_writable_role());

DROP POLICY IF EXISTS "deliveries_delete_own_hospital" ON public.deliveries;
CREATE POLICY "deliveries_delete_own_hospital" ON public.deliveries
  FOR DELETE USING (hospital_id = public.current_hospital_id()
    AND (public.is_owner() OR public.current_role_text() = 'admin'));

-- Grant privileges to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deliveries TO authenticated;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_deliveries_updated_at ON public.deliveries;
CREATE TRIGGER trg_deliveries_updated_at
  BEFORE UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Realtime publication
ALTER TABLE public.deliveries REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.deliveries;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------
-- 2. Summary columns on patients so the profile shows delivery status
--    without joining to deliveries. Updated by the application when
--    a delivery row is created.
-- -----------------------------------------------------------------
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS anc_delivery_status text
  CHECK (anc_delivery_status IN ('pregnant','delivered','miscarried'));

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS anc_delivery_date date;

-- Backfill existing ANC patients who have no delivery status to 'pregnant'.
-- (Only updates rows where the column is NULL — safe to re-run.)
UPDATE public.patients
   SET anc_delivery_status = 'pregnant'
 WHERE category = 'anc'
   AND anc_delivery_status IS NULL;

-- Index for fast filtering in the Delivery module list view
CREATE INDEX IF NOT EXISTS patients_anc_delivery_status_idx
  ON public.patients (hospital_id, category, anc_delivery_status);

-- -----------------------------------------------------------------
-- 3. RLS / realtime for the new patients columns — no extra policies
--    needed; the existing patients RLS already covers SELECT/UPDATE
--    for any column on the row. Realtime on `patients` is already
--    enabled (migration 056), so updates to anc_delivery_status /
--    anc_delivery_date will fire the existing realtime alert.
-- -----------------------------------------------------------------

-- -----------------------------------------------------------------
-- Verification queries (run after applying):
--   \d public.deliveries
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='patients'
--      AND column_name LIKE 'anc_delivery%';
-- -----------------------------------------------------------------
