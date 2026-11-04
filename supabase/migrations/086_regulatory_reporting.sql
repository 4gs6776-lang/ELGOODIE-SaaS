-- =====================================================================
-- GOODIE-MEDHUB — 086_regulatory_reporting.sql
-- =====================================================================
-- Public Health / Regulatory Reporting Module
--
-- Creates:
--   1. regulatory_reports — log of generated reports (audit trail)
--   2. notifiable_diseases — Nigerian FMoH IDSR list (seeded)
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. regulatory_reports — audit trail of generated reports
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.regulatory_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  report_type     text NOT NULL CHECK (report_type IN (
    'disease_surveillance', 'maternal_mortality', 'notifiable_diseases',
    'immunization', 'birth_registration', 'death_registration',
    'inpatient_statistics', 'outpatient_statistics', 'custom'
  )),
  date_from       date NOT NULL,
  date_to         date NOT NULL,
  filters         jsonb,
  generated_by    uuid REFERENCES public.profiles(id),
  generated_by_name text,
  file_format     text CHECK (file_format IN ('excel', 'pdf', 'csv', 'preview')),
  row_count       integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS regulatory_reports_hospital_idx
  ON public.regulatory_reports (hospital_id, created_at DESC);

ALTER TABLE public.regulatory_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "regulatory_reports_select" ON public.regulatory_reports;
CREATE POLICY "regulatory_reports_select" ON public.regulatory_reports
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "regulatory_reports_insert" ON public.regulatory_reports;
CREATE POLICY "regulatory_reports_insert" ON public.regulatory_reports
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "regulatory_reports_delete" ON public.regulatory_reports;
CREATE POLICY "regulatory_reports_delete" ON public.regulatory_reports
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, DELETE ON public.regulatory_reports TO authenticated;

ALTER TABLE public.regulatory_reports REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'regulatory_reports') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.regulatory_reports;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 2. notifiable_diseases — Nigerian FMoH IDSR list (seeded)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.notifiable_diseases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disease_name  text NOT NULL UNIQUE,
  icd10_code    text,
  is_active     boolean NOT NULL DEFAULT true,
  reporting_timeline text CHECK (reporting_timeline IN ('immediate', 'weekly', 'monthly'))
);

-- Public read (reference data)
ALTER TABLE public.notifiable_diseases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notifiable_diseases_select" ON public.notifiable_diseases;
CREATE POLICY "notifiable_diseases_select" ON public.notifiable_diseases
  FOR SELECT USING (true);
GRANT SELECT ON public.notifiable_diseases TO authenticated;

-- =====================================================================
-- 3. Seed Nigerian notifiable diseases (FMoH IDSR list)
-- =====================================================================
INSERT INTO public.notifiable_diseases (disease_name, icd10_code, reporting_timeline) VALUES
  ('Yellow Fever', 'A95', 'immediate'),
  ('Lassa Fever', 'A96', 'immediate'),
  ('Cholera', 'A00', 'immediate'),
  ('Cerebrospinal Meningitis (CSM)', 'A39', 'immediate'),
  ('Measles', 'B05', 'immediate'),
  ('Poliomyelitis (AFP)', 'A80', 'immediate'),
  ('Acute Flaccid Paralysis (AFP)', 'G83', 'immediate'),
  ('Guinea Worm (Dracunculiasis)', 'B72', 'immediate'),
  ('Neonatal Tetanus', 'A33', 'immediate'),
  ('Diphtheria', 'A36', 'immediate'),
  ('Whooping Cough (Pertussis)', 'A37', 'weekly'),
  ('Tuberculosis', 'A15', 'weekly'),
  ('Leprosy', 'A30', 'monthly'),
  ('HIV/AIDS', 'B20', 'monthly'),
  ('Malaria', 'B50', 'weekly'),
  ('Typhoid Fever', 'A01', 'weekly'),
  ('Acute Viral Hepatitis', 'B17', 'weekly'),
  ('Rabies', 'A82', 'immediate'),
  ('Ebola Viral Disease', 'A98.4', 'immediate'),
  ('Monkeypox', 'B04', 'immediate'),
  ('Acute Respiratory Infection (Severe)', 'J22', 'weekly'),
  ('Diarrhoeal Disease (Severe)', 'A09', 'weekly'),
  ('Maternal Deaths', 'O75', 'monthly'),
  ('Births (Live)', 'Z37.0', 'monthly'),
  ('Stillbirths', 'Z37.1', 'monthly')
ON CONFLICT (disease_name) DO NOTHING;

-- =====================================================================
-- 4. Verification
-- =====================================================================
DO $_$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.notifiable_diseases;
  RAISE NOTICE 'Notifiable diseases seeded: % rows', v_count;
  RAISE NOTICE 'regulatory_reports table created with RLS + realtime';
END $_$;
