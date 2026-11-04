-- =====================================================================
-- GOODIE-MEDHUB — 085_ai_coding_tables.sql
-- =====================================================================
-- AI-Powered Coding & Documentation Assist
--
-- Creates:
--   1. icd10_codes — reference table with common Nigerian primary care codes
--   2. consultation_codes — links consultations to ICD-10 + procedure codes
--
-- Also extends the existing ai_assessments table (from migration 018)
-- to support 'coding' and 'documentation' assessment types.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. Extend ai_assessments to support coding + documentation types
-- =====================================================================
-- The existing assessment_type column has a CHECK constraint. We need
-- to drop + recreate it to include the new types.
ALTER TABLE public.ai_assessments DROP CONSTRAINT IF EXISTS ai_assessments_assessment_type_check;
ALTER TABLE public.ai_assessments ADD CONSTRAINT ai_assessments_assessment_type_check
  CHECK (assessment_type IN ('triage', 'consultation', 'coding', 'documentation'));

-- =====================================================================
-- 2. icd10_codes — reference table (seeded with common Nigerian codes)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.icd10_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  description text NOT NULL,
  chapter     text,
  category    text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS icd10_codes_code_idx ON public.icd10_codes (code);
CREATE INDEX IF NOT EXISTS icd10_codes_description_idx ON public.icd10_codes (description);

-- Public read (reference data — no hospital scoping needed)
ALTER TABLE public.icd10_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "icd10_codes_select" ON public.icd10_codes;
CREATE POLICY "icd10_codes_select" ON public.icd10_codes
  FOR SELECT USING (true);

GRANT SELECT ON public.icd10_codes TO authenticated;

-- =====================================================================
-- 3. Seed common Nigerian primary care ICD-10 codes
-- =====================================================================
INSERT INTO public.icd10_codes (code, description, chapter, category) VALUES
  -- Infectious diseases
  ('A00', 'Cholera', 'I. Certain infectious and parasitic diseases', 'Intestinal infectious diseases'),
  ('A09', 'Other gastroenteritis and colitis of infectious origin', 'I. Certain infectious and parasitic diseases', 'Intestinal infectious diseases'),
  ('A95', 'Yellow fever', 'I. Certain infectious and parasitic diseases', 'Arthropod-borne viral fevers'),
  ('A96', 'Arenaviral haemorrhagic fever (Lassa fever)', 'I. Certain infectious and parasitic diseases', 'Arthropod-borne viral fevers'),
  ('B05', 'Measles', 'I. Certain infectious and parasitic diseases', 'Viral infections characterized by skin and mucous membrane lesions'),
  ('B06', 'Rubella [German measles]', 'I. Certain infectious and parasitic diseases', 'Viral infections characterized by skin and mucous membrane lesions'),
  ('B16', 'Acute hepatitis B', 'I. Certain infectious and parasitic diseases', 'Viral hepatitis'),
  ('B17', 'Other acute viral hepatitis', 'I. Certain infectious and parasitic diseases', 'Viral hepatitis'),
  ('B19', 'Unspecified viral hepatitis', 'I. Certain infectious and parasitic diseases', 'Viral hepatitis'),
  ('B20', 'Human immunodeficiency virus [HIV] disease', 'I. Certain infectious and parasitic diseases', 'HIV'),
  ('B50', 'Plasmodium falciparum malaria', 'I. Certain infectious and parasitic diseases', 'Protozoal diseases'),
  ('B54', 'Unspecified malaria', 'I. Certain infectious and parasitic diseases', 'Protozoal diseases'),
  ('B77', 'Ascariasis', 'I. Certain infectious and parasitic diseases', 'Helminthiases'),
  -- Respiratory
  ('J00', 'Acute nasopharyngitis [common cold]', 'X. Diseases of the respiratory system', 'Acute upper respiratory infections'),
  ('J01', 'Acute sinusitis', 'X. Diseases of the respiratory system', 'Acute upper respiratory infections'),
  ('J02', 'Acute pharyngitis', 'X. Diseases of the respiratory system', 'Acute upper respiratory infections'),
  ('J03', 'Acute tonsillitis', 'X. Diseases of the respiratory system', 'Acute upper respiratory infections'),
  ('J06', 'Acute upper respiratory infection of multiple/unspecified sites', 'X. Diseases of the respiratory system', 'Acute upper respiratory infections'),
  ('J11', 'Influenza, virus not identified', 'X. Diseases of the respiratory system', 'Influenza and pneumonia'),
  ('J20', 'Acute bronchitis', 'X. Diseases of the respiratory system', 'Acute lower respiratory infections'),
  ('J22', 'Unspecified acute lower respiratory infection', 'X. Diseases of the respiratory system', 'Acute lower respiratory infections'),
  ('J45', 'Asthma', 'X. Diseases of the respiratory system', 'Chronic lower respiratory diseases'),
  ('J44', 'Other chronic obstructive pulmonary disease', 'X. Diseases of the respiratory system', 'Chronic lower respiratory diseases'),
  ('J18', 'Pneumonia, organism unspecified', 'X. Diseases of the respiratory system', 'Influenza and pneumonia'),
  -- Digestive
  ('K29', 'Gastritis and duodenitis', 'XI. Diseases of the digestive system', 'Diseases of oesophagus, stomach and duodenum'),
  ('K35', 'Acute appendicitis', 'XI. Diseases of the digestive system', 'Diseases of appendix'),
  ('K52', 'Noninfective gastroenteritis and colitis', 'XI. Diseases of the digestive system', 'Noninfective enteritis and colitis'),
  ('K80', 'Cholelithiasis (gallstones)', 'XI. Diseases of the digestive system', 'Disorders of gallbladder, biliary tract and pancreas'),
  -- Cardiovascular
  ('I10', 'Essential (primary) hypertension', 'IX. Diseases of the circulatory system', 'Hypertensive diseases'),
  ('I11', 'Hypertensive heart disease', 'IX. Diseases of the circulatory system', 'Hypertensive diseases'),
  ('I20', 'Angina pectoris', 'IX. Diseases of the circulatory system', 'Ischaemic heart diseases'),
  ('I21', 'Acute myocardial infarction', 'IX. Diseases of the circulatory system', 'Ischaemic heart diseases'),
  ('I50', 'Heart failure', 'IX. Diseases of the circulatory system', 'Other forms of heart disease'),
  ('I63', 'Cerebral infarction (stroke)', 'IX. Diseases of the circulatory system', 'Cerebrovascular diseases'),
  ('I64', 'Stroke, not specified as haemorrhage or infarction', 'IX. Diseases of the circulatory system', 'Cerebrovascular diseases'),
  -- Endocrine / metabolic
  ('E10', 'Type 1 diabetes mellitus', 'IV. Endocrine, nutritional and metabolic diseases', 'Diabetes mellitus'),
  ('E11', 'Type 2 diabetes mellitus', 'IV. Endocrine, nutritional and metabolic diseases', 'Diabetes mellitus'),
  ('E66', 'Overweight and obesity', 'IV. Endocrine, nutritional and metabolic diseases', 'Metabolic disorders'),
  ('E78', 'Disorders of lipoprotein metabolism and other lipidaemias', 'IV. Endocrine, nutritional and metabolic diseases', 'Metabolic disorders'),
  ('E83', 'Disorders of mineral metabolism', 'IV. Endocrine, nutritional and metabolic diseases', 'Metabolic disorders'),
  -- Pregnancy / childbirth
  ('O00', 'Ectopic pregnancy', 'XV. Pregnancy, childbirth and the puerperium', 'Pregnancy with abortive outcome'),
  ('O20', 'Haemorrhage in early pregnancy', 'XV. Pregnancy, childbirth and the puerperium', 'Edema, proteinuria and hypertensive disorders'),
  ('O21', 'Excessive vomiting in pregnancy', 'XV. Pregnancy, childbirth and the puerperium', 'Edema, proteinuria and hypertensive disorders'),
  ('O47', 'False labour', 'XV. Pregnancy, childbirth and the puerperium', 'Other maternal disorders predominantly related to pregnancy'),
  ('O80', 'Encounter for full-term uncomplicated delivery', 'XV. Pregnancy, childbirth and the puerperium', 'Delivery'),
  -- Skin
  ('L01', 'Impetigo', 'XII. Diseases of the skin and subcutaneous tissue', 'Infections of the skin and subcutaneous tissue'),
  ('L02', 'Cutaneous abscess, furuncle and carbuncle', 'XII. Diseases of the skin and subcutaneous tissue', 'Infections of the skin and subcutaneous tissue'),
  ('L20', 'Atopic dermatitis', 'XII. Diseases of the skin and subcutaneous tissue', 'Dermatitis and eczema'),
  ('L30', 'Dermatitis, unspecified', 'XII. Diseases of the skin and subcutaneous tissue', 'Dermatitis and eczema'),
  -- Injury / external
  ('S00', 'Superficial injury of head', 'XIX. Injury, poisoning and certain other consequences of external causes', 'Injuries to the head'),
  ('S01', 'Open wound of head', 'XIX. Injury, poisoning and certain other consequences of external causes', 'Injuries to the head'),
  ('S52', 'Fracture of forearm', 'XIX. Injury, poisoning and certain other consequences of external causes', 'Injuries to the elbow and forearm'),
  ('S82', 'Fracture of lower leg, including ankle', 'XIX. Injury, poisoning and certain other consequences of external causes', 'Injuries to the knee and lower leg'),
  -- Symptoms / general
  ('R07', 'Pain in throat and chest', 'XVIII. Symptoms, signs and abnormal clinical and laboratory findings', 'Symptoms and signs involving the circulatory and respiratory systems'),
  ('R10', 'Abdominal pain', 'XVIII. Symptoms, signs and abnormal clinical and laboratory findings', 'Symptoms and signs involving the digestive system and abdomen'),
  ('R11', 'Nausea and vomiting', 'XVIII. Symptoms, signs and abnormal clinical and laboratory findings', 'Symptoms and signs involving the digestive system and abdomen'),
  ('R50', 'Fever of other and unknown origin', 'XVIII. Symptoms, signs and abnormal clinical and laboratory findings', 'General symptoms and signs'),
  ('R51', 'Headache', 'XVIII. Symptoms, signs and abnormal clinical and laboratory findings', 'General symptoms and signs'),
  ('R53', 'Malaise and fatigue', 'XVIII. Symptoms, signs and abnormal clinical and laboratory findings', 'General symptoms and signs'),
  -- Mental health
  ('F32', 'Depressive episode', 'V. Mental and behavioural disorders', 'Mood [affective] disorders'),
  ('F41', 'Other anxiety disorders', 'V. Mental and behavioural disorders', 'Neurotic, stress-related and somatoform disorders'),
  -- Genitourinary
  ('N10', 'Acute tubulo-interstitial nephritis', 'XIV. Diseases of the genitourinary system', 'Tubulo-interstitial kidney diseases'),
  ('N39', 'Other disorders of urinary system (UTI)', 'XIV. Diseases of the genitourinary system', 'Other diseases of urinary system'),
  ('N70', 'Salpingitis and oophoritis (PID)', 'XIV. Diseases of the genitourinary system', 'Inflammatory diseases of female pelvic organs'),
  -- Eye / ENT
  ('H10', 'Conjunctivitis', 'VII. Diseases of the eye and adnexa', 'Disorders of conjunctiva'),
  ('H66', 'Acute otitis media', 'VIII. Diseases of the ear and mastoid process', 'Otitis media and mastoiditis')
ON CONFLICT (code) DO NOTHING;

-- =====================================================================
-- 4. consultation_codes — links consultations to codes
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.consultation_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  consultation_id uuid REFERENCES public.patient_vitals(id) ON DELETE CASCADE,
  code_type       text NOT NULL CHECK (code_type IN ('icd10', 'procedure', 'lab')),
  code            text NOT NULL,
  code_description text,
  is_ai_suggested boolean NOT NULL DEFAULT false,
  is_accepted     boolean NOT NULL DEFAULT false,
  accepted_by      uuid REFERENCES public.profiles(id),
  accepted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consultation_codes_hospital_idx ON public.consultation_codes (hospital_id);
CREATE INDEX IF NOT EXISTS consultation_codes_consultation_idx ON public.consultation_codes (consultation_id);
CREATE INDEX IF NOT EXISTS consultation_codes_code_idx ON public.consultation_codes (code_type, code);

ALTER TABLE public.consultation_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "consultation_codes_select" ON public.consultation_codes;
CREATE POLICY "consultation_codes_select" ON public.consultation_codes
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "consultation_codes_insert" ON public.consultation_codes;
CREATE POLICY "consultation_codes_insert" ON public.consultation_codes
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "consultation_codes_update" ON public.consultation_codes;
CREATE POLICY "consultation_codes_update" ON public.consultation_codes
  FOR UPDATE USING (hospital_id = public.current_hospital_id())
  WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "consultation_codes_delete" ON public.consultation_codes;
CREATE POLICY "consultation_codes_delete" ON public.consultation_codes
  FOR DELETE USING (hospital_id = public.current_hospital_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consultation_codes TO authenticated;

ALTER TABLE public.consultation_codes REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'consultation_codes') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.consultation_codes;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 5. Verification
-- =====================================================================
DO $_$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.icd10_codes;
  RAISE NOTICE 'ICD-10 codes seeded: % rows', v_count;
  RAISE NOTICE 'consultation_codes table created with RLS + realtime';
  RAISE NOTICE 'ai_assessments table extended to support coding + documentation types';
END $_$;
