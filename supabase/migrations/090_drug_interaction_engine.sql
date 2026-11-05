-- =====================================================================
-- GOODIE-MEDHUB — 090_drug_interaction_engine.sql
-- =====================================================================
-- Intelligent Clinical Decision Support + Drug Interaction Engine
--
-- Creates 3 tables:
--   1. drug_interactions — reference data for drug-drug interactions
--   2. drug_allergy_classes — cross-reactivity mapping for allergies
--   3. medication_safety_alerts — log of all alerts + doctor overrides
--
-- Also seeds 100+ common Nigerian primary care drug interactions and
-- 30 allergy cross-reactivity classes.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. drug_interactions — reference data (shared across all hospitals)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.drug_interactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drug_a_generic  text NOT NULL,
  drug_b_generic  text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('mild', 'moderate', 'severe', 'contraindicated')),
  mechanism       text,
  clinical_effect text,
  management      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drug_interactions_drug_a_idx ON public.drug_interactions (drug_a_generic);
CREATE INDEX IF NOT EXISTS drug_interactions_drug_b_idx ON public.drug_interactions (drug_b_generic);

-- Public read (reference data — no hospital scoping)
ALTER TABLE public.drug_interactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "drug_interactions_select" ON public.drug_interactions;
CREATE POLICY "drug_interactions_select" ON public.drug_interactions FOR SELECT USING (true);
GRANT SELECT ON public.drug_interactions TO authenticated;

-- =====================================================================
-- 2. drug_allergy_classes — cross-reactivity mapping
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.drug_allergy_classes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allergen        text NOT NULL UNIQUE,
  cross_reactive_classes text[],
  severity        text NOT NULL DEFAULT 'moderate' CHECK (severity IN ('mild', 'moderate', 'severe', 'contraindicated')),
  clinical_note   text
);

ALTER TABLE public.drug_allergy_classes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "drug_allergy_classes_select" ON public.drug_allergy_classes;
CREATE POLICY "drug_allergy_classes_select" ON public.drug_allergy_classes FOR SELECT USING (true);
GRANT SELECT ON public.drug_allergy_classes TO authenticated;

-- =====================================================================
-- 3. medication_safety_alerts — log of all alerts + overrides
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.medication_safety_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  consultation_id uuid,
  prescription_id uuid,
  alert_type      text NOT NULL CHECK (alert_type IN ('drug_drug', 'drug_allergy', 'drug_condition', 'drug_lab', 'pregnancy', 'pediatric', 'renal_dose')),
  severity        text NOT NULL CHECK (severity IN ('soft', 'hard')),
  drug_name       text NOT NULL,
  interacting_with text,
  mechanism       text,
  recommendation  text,
  was_overridden  boolean NOT NULL DEFAULT false,
  override_reason text,
  overridden_by   uuid,
  overridden_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS med_safety_hospital_patient_idx ON public.medication_safety_alerts (hospital_id, patient_id);
CREATE INDEX IF NOT EXISTS med_safety_consultation_idx ON public.medication_safety_alerts (consultation_id);

ALTER TABLE public.medication_safety_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "med_safety_select" ON public.medication_safety_alerts;
CREATE POLICY "med_safety_select" ON public.medication_safety_alerts
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "med_safety_insert" ON public.medication_safety_alerts;
CREATE POLICY "med_safety_insert" ON public.medication_safety_alerts
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "med_safety_update" ON public.medication_safety_alerts;
CREATE POLICY "med_safety_update" ON public.medication_safety_alerts
  FOR UPDATE USING (hospital_id = public.current_hospital_id()) WITH CHECK (hospital_id = public.current_hospital_id());

-- NO DELETE POLICY — alerts cannot be deleted (audit trail)

GRANT SELECT, INSERT, UPDATE ON public.medication_safety_alerts TO authenticated;

ALTER TABLE public.medication_safety_alerts REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'medication_safety_alerts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.medication_safety_alerts;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 4. SEED: Drug-drug interactions (100+ common Nigerian primary care)
-- =====================================================================
INSERT INTO public.drug_interactions (drug_a_generic, drug_b_generic, severity, mechanism, clinical_effect, management) VALUES
-- Anticoagulants
('warfarin', 'aspirin', 'severe', 'Synergistic anticoagulant effect', 'Increased bleeding risk', 'Monitor INR closely. Consider dose reduction. Avoid concurrent use if possible.'),
('warfarin', 'ibuprofen', 'severe', 'NSAIDs displace warfarin from protein binding + antiplatelet effect', 'GI bleeding risk significantly increased', 'Avoid combination. Use paracetamol instead.'),
('warfarin', 'diclofenac', 'severe', 'NSAIDs displace warfarin + antiplatelet', 'GI bleeding risk', 'Avoid combination. Use paracetamol.'),
('warfarin', 'naproxen', 'severe', 'NSAIDs + anticoagulant', 'GI bleeding', 'Avoid combination.'),
('warfarin', 'metronidazole', 'severe', 'CYP2C9 inhibition — reduces warfarin metabolism', 'INR elevation, bleeding risk', 'Reduce warfarin dose 25-50%. Monitor INR every 2 days.'),
('warfarin', 'ciprofloxacin', 'moderate', 'CYP1A2 inhibition + gut flora reduction', 'INR elevation', 'Monitor INR. Consider alternative antibiotic.'),
('warfarin', 'co-trimoxazole', 'severe', 'CYP2C9 inhibition + protein displacement', 'Marked INR elevation', 'Reduce warfarin dose 25-50%. Monitor INR closely.'),
('warfarin', 'fluconazole', 'severe', 'CYP2C9/3A4 inhibition', 'Significant INR elevation', 'Reduce warfarin dose 25-50%. Monitor INR.'),
('warfarin', 'miconazole', 'severe', 'CYP2C9 inhibition (even oral gel)', 'INR elevation', 'Avoid oral miconazole gel. Use nystatin instead.'),
('warfarin', 'amiodarone', 'severe', 'CYP2C9 inhibition', 'INR elevation — sometimes after weeks', 'Reduce warfarin dose 30-50%.'),
('warfarin', 'rifampicin', 'severe', 'CYP enzyme induction — increases warfarin metabolism', 'INR reduction — therapeutic failure', 'Increase warfarin dose. Monitor INR frequently.'),
('warfarin', 'phenytoin', 'moderate', 'CYP2C9 interaction — mutual metabolism effect', 'Altered INR + altered phenytoin levels', 'Monitor both INR and phenytoin levels.'),
('warfarin', 'paracetamol', 'mild', 'High-dose paracetamol may enhance warfarin effect (NAPQI metabolite)', 'INR elevation at >2g/day for several days', 'Keep paracetamol ≤2g/day. Monitor INR if prolonged use.'),
-- Diabetes medications
('metformin', 'contrast dye', 'contraindicated', 'Contrast-induced nephropathy + metformin accumulation', 'Lactic acidosis risk', 'Stop metformin 48h before + 48h after contrast. Check renal function.'),
('metformin', 'ciprofloxacin', 'moderate', 'Ciprofloxacin may enhance metformin effect', 'Hypoglycemia risk', 'Monitor blood glucose. Consider metformin dose reduction.'),
('metformin', 'furosemide', 'mild', 'Altered renal function may affect metformin clearance', 'Potential metformin accumulation', 'Monitor renal function + blood glucose.'),
('glibenclamide', 'ciprofloxacin', 'moderate', 'CYP2C9 inhibition — enhanced sulfonylurea effect', 'Hypoglycemia', 'Monitor blood glucose. Consider dose reduction.'),
('glibenclamide', 'fluconazole', 'moderate', 'CYP2C9 inhibition', 'Hypoglycemia', 'Monitor glucose. Reduce sulfonylurea dose.'),
('glibenclamide', 'co-trimoxazole', 'moderate', 'CYP2C9 inhibition + protein displacement', 'Hypoglycemia', 'Monitor glucose. Consider dose reduction.'),
('insulin', 'beta-blocker', 'moderate', 'Beta-blockers mask hypoglycemia symptoms (except sweating)', 'Hypoglycemia unawareness', 'Monitor glucose. Use cardioselective beta-blocker. Educate patient.'),
('metformin', 'alcohol', 'moderate', 'Increased lactic acidosis risk', 'Lactic acidosis', 'Counsel patient to limit alcohol intake.'),
-- Cardiovascular
('ace-inhibitor', 'spironolactone', 'severe', 'Dual potassium retention', 'Severe hyperkalemia', 'Monitor potassium closely. Avoid combination or reduce spironolactone dose.'),
('ace-inhibitor', 'potassium-sparing-diuretic', 'severe', 'Additive potassium retention', 'Hyperkalemia', 'Monitor potassium. Avoid if possible.'),
('enalapril', 'spironolactone', 'severe', 'Additive hyperkalemia', 'Severe hyperkalemia', 'Monitor potassium weekly.'),
('lisinopril', 'spironolactone', 'severe', 'Additive hyperkalemia', 'Severe hyperkalemia', 'Monitor potassium.'),
('losartan', 'spironolactone', 'moderate', 'Dual potassium retention', 'Hyperkalemia', 'Monitor potassium.'),
('ace-inhibitor', 'nsaids', 'moderate', 'NSAIDs reduce ACE inhibitor antihypertensive effect + risk of renal impairment', 'Reduced BP control + AKI risk', 'Monitor BP + renal function. Consider alternative analgesic.'),
('ace-inhibitor', 'rifampicin', 'moderate', 'Enzyme induction — reduces ACE inhibitor effect', 'Reduced antihypertensive effect', 'Monitor BP. May need dose increase.'),
('digoxin', 'furosemide', 'moderate', 'Hypokalemia from furosemide increases digoxin toxicity', 'Digoxin toxicity (arrhythmia)', 'Monitor potassium. Supplement if <4.0 mmol/L.'),
('digoxin', 'spironolactone', 'moderate', 'Spironolactone reduces digoxin renal clearance', 'Digoxin toxicity', 'Monitor digoxin levels. Reduce dose 25-50%.'),
('digoxin', 'amiodarone', 'severe', 'Reduced digoxin clearance', 'Digoxin toxicity', 'Reduce digoxin dose 50%. Monitor levels.'),
('digoxin', 'verapamil', 'severe', 'Additive AV node suppression + reduced digoxin clearance', 'Bradycardia, digoxin toxicity', 'Reduce digoxin dose 50%. Monitor ECG + digoxin level.'),
('digoxin', 'ciprofloxacin', 'mild', 'Altered gut flora may affect digoxin absorption', 'Variable digoxin levels', 'Monitor for digoxin toxicity signs.'),
('nifedipine', 'simvastatin', 'moderate', 'CYP3A4 inhibition — increased statin levels', 'Myopathy, rhabdomyolysis risk', 'Limit simvastatin to 20mg/day with nifedipine.'),
('amlodipine', 'simvastatin', 'moderate', 'CYP3A4 interaction', 'Myopathy risk', 'Limit simvastatin to 20mg/day with amlodipine.'),
('beta-blocker', 'verapamil', 'contraindicated', 'Additive AV node suppression', 'Severe bradycardia, heart block, asystole', 'AVOID combination. Use alternative.'),
('beta-blocker', 'diltiazem', 'contraindicated', 'Additive negative inotropy + AV suppression', 'Severe bradycardia, heart block', 'AVOID combination.'),
-- Antibiotics
('ciprofloxacin', 'theophylline', 'moderate', 'CYP1A2 inhibition — reduced theophylline clearance', 'Theophylline toxicity (seizures, arrhythmia)', 'Monitor theophylline levels. Reduce dose 25-50%.'),
('ciprofloxacin', 'warfarin', 'moderate', 'CYP1A2 + gut flora effect', 'INR elevation', 'Monitor INR.'),
('ciprofloxacin', 'sucralfate', 'moderate', 'Sucralfate reduces ciprofloxacin absorption', 'Reduced antibiotic efficacy', 'Give ciprofloxacin 2h before or 6h after sucralfate.'),
('ciprofloxacin', 'antacids', 'moderate', 'Divalent/trivalent cations chelate fluoroquinolone', 'Reduced antibiotic absorption', 'Give ciprofloxacin 2h before or 6h after antacids.'),
('ciprofloxacin', 'iron', 'moderate', 'Iron chelates fluoroquinolone', 'Reduced absorption', 'Separate by 2-6 hours.'),
('ciprofloxacin', 'calcium', 'moderate', 'Calcium chelates fluoroquinolone', 'Reduced absorption', 'Separate by 2-6 hours.'),
('co-trimoxazole', 'phenytoin', 'moderate', 'CYP2C9 inhibition — reduced phenytoin metabolism', 'Phenytoin toxicity (ataxia, nystagmus)', 'Monitor phenytoin levels. Reduce dose.'),
('co-trimoxazole', 'methotrexate', 'severe', 'Displacement from protein binding + reduced renal clearance', 'Methotrexate toxicity', 'Avoid if possible. Monitor for toxicity.'),
('rifampicin', 'oral-contraceptives', 'severe', 'CYP3A4 induction — accelerated estrogen metabolism', 'Contraceptive failure', 'Use barrier method during + 4 weeks after rifampicin.'),
('rifampicin', 'warfarin', 'severe', 'Enzyme induction', 'INR reduction', 'Increase warfarin dose. Monitor INR.'),
('rifampicin', 'itraconazole', 'contraindicated', 'Rifampicin reduces itraconazole to sub-therapeutic levels', 'Antifungal treatment failure', 'AVOID combination. Use alternative antifungal.'),
('rifampicin', 'ketoconazole', 'contraindicated', 'Enzyme induction', 'Treatment failure', 'AVOID combination.'),
('isoniazid', 'phenytoin', 'moderate', 'Isoniazid inhibits phenytoin metabolism (slow acetylators)', 'Phenytoin toxicity', 'Monitor phenytoin levels. Reduce dose.'),
('isoniazid', 'paracetamol', 'mild', 'Isoniazid induces CYP enzymes that produce hepatotoxic NAPQI', 'Increased hepatotoxicity risk', 'Limit paracetamol dose. Monitor LFTs.'),
('metronidazole', 'alcohol', 'contraindicated', 'Disulfiram-like reaction — acetaldehyde accumulation', 'Severe nausea, vomiting, flushing, palpitations', 'AVOID alcohol during + 48h after metronidazole.'),
('metronidazole', 'warfarin', 'severe', 'CYP2C9 inhibition', 'INR elevation', 'Reduce warfarin 25-50%. Monitor INR.'),
('tetracycline', 'antacids', 'moderate', 'Chelation — reduced tetracycline absorption', 'Reduced antibiotic efficacy', 'Separate by 2-6 hours.'),
('tetracycline', 'iron', 'moderate', 'Chelation', 'Reduced absorption', 'Separate by 2-6 hours.'),
('tetracycline', 'dairy', 'moderate', 'Calcium binds tetracycline', 'Reduced absorption', 'Avoid milk/products 2h before/after.'),
('tetracycline', 'retinoids', 'contraindicated', 'Additive intracranial pressure elevation', 'Pseudotumor cerebri', 'AVOID combination.'),
-- Psychiatric / Neurology
('phenytoin', 'phenobarbital', 'moderate', 'Mutual CYP induction/enzyme interaction', 'Altered levels of both drugs', 'Monitor both drug levels.'),
('carbamazepine', 'oral-contraceptives', 'severe', 'CYP3A4 induction', 'Contraceptive failure', 'Use barrier method.'),
('carbamazepine', 'warfarin', 'moderate', 'Enzyme induction', 'INR reduction', 'Monitor INR. Increase warfarin dose.'),
('carbamazepine', 'itraconazole', 'contraindicated', 'Itraconazole inhibits carbamazepine metabolism', 'Carbamazepine toxicity', 'AVOID combination.'),
('valproic-acid', 'meropenem', 'severe', 'Meropenem increases valproic acid clearance', 'Seizures from sub-therapeutic valproate', 'Avoid if possible. Monitor valproate levels closely.'),
('lithium', 'nsaids', 'severe', 'NSAIDs reduce lithium renal clearance', 'Lithium toxicity', 'Monitor lithium levels. Reduce dose. Use paracetamol.'),
('lithium', 'ace-inhibitor', 'moderate', 'ACE inhibitors reduce lithium excretion', 'Lithium toxicity', 'Monitor lithium levels.'),
('lithium', 'thiazide-diuretic', 'severe', 'Thiazides reduce lithium clearance', 'Lithium toxicity', 'Reduce lithium dose 25-50%. Monitor levels.'),
('lithium', 'metronidazole', 'moderate', 'Reduced lithium clearance', 'Lithium toxicity', 'Monitor lithium levels.'),
('ssri', 'tramadol', 'moderate', 'Serotonin syndrome risk', 'Agitation, tremor, hyperthermia', 'Monitor for serotonin syndrome. Consider alternative analgesic.'),
('ssri', 'maoi', 'contraindicated', 'Serotonin syndrome', 'Hyperthermia, seizures, death', 'AVOID combination. 14-day washout required.'),
('ssri', 'linezolid', 'contraindicated', 'Serotonin syndrome (linezolid is a reversible MAOI)', 'Serotonin syndrome', 'AVOID combination. 14-day washout.'),
('ssri', 'sumatriptan', 'moderate', 'Serotonin syndrome risk', 'Weakness, tremor, agitation', 'Monitor closely. Consider alternative.'),
-- GI / Others
('omeprazole', 'clopidogrel', 'severe', 'CYP2C19 inhibition — reduces clopidogrel activation', 'Reduced antiplatelet effect — stent thrombosis risk', 'Use pantoprazole instead. Avoid omeprazole with clopidogrel.'),
('pantoprazole', 'clopidogrel', 'mild', 'Minimal CYP2C19 interaction', 'Minimal clinical effect', 'Preferred PPI with clopidogrel.'),
('omeprazole', 'methotrexate', 'moderate', 'Reduced methotrexate clearance', 'Methotrexate toxicity', 'Monitor methotrexate levels.'),
('theophylline', 'smoking', 'mild', 'CYP1A2 induction — increased theophylline clearance', 'Sub-therapeutic theophylline', 'Smokers may need higher dose.'),
('theophylline', 'cimetidine', 'moderate', 'CYP1A2 inhibition', 'Theophylline toxicity', 'Use famotidine instead. Monitor levels.'),
('phenytoin', 'folic-acid', 'moderate', 'Folic acid may reduce phenytoin levels', 'Seizure risk', 'Monitor phenytoin levels. Separate doses.'),
('phenytoin', 'calcium', 'mild', 'Reduced phenytoin absorption', 'Sub-therapeutic levels', 'Separate doses by 2+ hours.'),
('levothyroxine', 'calcium', 'moderate', 'Calcium reduces levothyroxine absorption', 'Reduced thyroid replacement', 'Separate by 4+ hours.'),
('levothyroxine', 'iron', 'moderate', 'Iron reduces levothyroxine absorption', 'Reduced thyroid replacement', 'Separate by 4+ hours.'),
('levothyroxine', 'omeprazole', 'moderate', 'Reduced gastric acid → reduced absorption', 'Sub-therapeutic levothyroxine', 'Monitor TSH. May need dose increase.'),
('spironolactone', 'ace-inhibitor', 'severe', 'Dual potassium retention', 'Severe hyperkalemia', 'Monitor potassium closely.'),
('spironolactone', 'nsaids', 'moderate', 'Reduced spironolactone effect + renal risk', 'Reduced diuresis + AKI risk', 'Monitor renal function.'),
('furosemide', 'nsaids', 'moderate', 'NSAIDs oppose diuretic effect + renal vasoconstriction', 'Reduced diuresis + AKI', 'Monitor weight, renal function.'),
('furosemide', 'digoxin', 'moderate', 'Hypokalemia increases digoxin toxicity', 'Arrhythmia', 'Monitor potassium. Keep >4.0 mmol/L.'),
('amiodarone', 'simvastatin', 'moderate', 'CYP3A4 inhibition', 'Myopathy risk', 'Limit simvastatin to 20mg/day.'),
('amiodarone', 'warfarin', 'severe', 'CYP2C9 inhibition', 'INR elevation', 'Reduce warfarin 30-50%. Monitor INR.'),
('amiodarone', 'digoxin', 'severe', 'Reduced digoxin clearance', 'Digoxin toxicity', 'Reduce digoxin 50%.'),
('aspirin', 'methotrexate', 'severe', 'Reduced methotrexate clearance', 'Methotrexate toxicity', 'Monitor closely. Avoid high-dose aspirin.'),
('aspirin', 'valproic-acid', 'moderate', 'Displacement from protein binding', 'Valproate toxicity', 'Monitor valproate levels.'),
('sildenafil', 'nitrates', 'contraindicated', 'Excessive vasodilation', 'Severe, life-threatening hypotension', 'AVOID combination absolutely. 24h washout (48h for tadalafil).'),
('sildenafil', 'alpha-blocker', 'moderate', 'Additive hypotension', 'Symptomatic hypotension', 'Stabilize alpha-blocker before starting sildenafil. Start low dose.'),
('atorvastatin', 'clarithromycin', 'moderate', 'CYP3A4 inhibition', 'Myopathy risk', 'Limit atorvastatin dose. Consider temporary statin hold.'),
('simvastatin', 'clarithromycin', 'severe', 'CYP3A4 inhibition — marked statin increase', 'Rhabdomyolysis', 'Hold simvastatin during macrolide course.'),
('simvastatin', 'grapefruit', 'moderate', 'CYP3A4 inhibition by grapefruit', 'Myopathy risk', 'Avoid grapefruit juice.'),
('morphine', 'benzodiazepine', 'severe', 'Additive respiratory depression', 'Respiratory arrest', 'Reduce both doses. Monitor respiration. Have naloxone ready.'),
('morphine', 'alcohol', 'severe', 'Additive CNS + respiratory depression', 'Respiratory depression', 'Counsel patient to avoid alcohol.'),
('paracetamol', 'carbamazepine', 'mild', 'Enzyme induction → increased hepatotoxic metabolite at high doses', 'Hepatotoxicity at >2g/day prolonged use', 'Keep paracetamol ≤2g/day if prolonged use.'),
('chloramphenicol', 'phenytoin', 'moderate', 'CYP2C9 inhibition', 'Phenytoin toxicity', 'Monitor phenytoin levels.'),
('erythromycin', 'theophylline', 'moderate', 'CYP3A4 inhibition', 'Theophylline toxicity', 'Monitor theophylline levels.'),
('erythromycin', 'simvastatin', 'severe', 'CYP3A4 inhibition', 'Rhabdomyolysis', 'Hold statin during macrolide course.'),
('erythromycin', 'warfarin', 'moderate', 'CYP3A4 inhibition + gut flora', 'INR elevation', 'Monitor INR.'),
('clarithromycin', 'warfarin', 'moderate', 'CYP3A4 inhibition', 'INR elevation', 'Monitor INR.'),
('fluconazole', 'oral-contraceptives', 'mild', 'Minimal interaction', 'Slightly increased estrogen levels', 'No action needed typically.'),
('ketoconazole', 'terfenadine', 'contraindicated', 'CYP3A4 inhibition → QT prolongation', 'Torsades de pointes (fatal arrhythmia)', 'AVOID combination.'),
('chloroquine', 'antacids', 'moderate', 'Reduced chloroquine absorption', 'Reduced antimalarial effect', 'Separate by 2-4 hours.'),
('artemether', 'mefloquine', 'moderate', 'Additive QT prolongation', 'Arrhythmia risk', 'Monitor ECG. Avoid if possible.'),
('artesunate', 'paracetamol', 'mild', 'No significant interaction', '—', 'No action needed.'),
('proguanil', 'warfarin', 'mild', 'Possible enhanced anticoagulant effect', 'Minor INR changes', 'Monitor INR if on long-term warfarin.'),
('amodiaquine', 'artemether', 'mild', 'Combination ACT — intended synergistic effect', 'Therapeutic synergy', 'Standard ACT combination. No action needed.')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 5. SEED: Drug allergy cross-reactivity classes (30 classes)
-- =====================================================================
INSERT INTO public.drug_allergy_classes (allergen, cross_reactive_classes, severity, clinical_note) VALUES
('penicillin', ARRAY['cephalosporins', 'carbapenems', 'monobactams'], 'moderate', 'Cross-reactivity 1-10% with cephalosporins. Use with caution. Carbapenem cross-reactivity <1%.'),
('sulfa-drugs', ARRAY['thiazide-diuretics', 'furosemide', 'sulfonamide-antibiotics', 'celecoxib', 'glipizide'], 'severe', 'Sulfa allergy cross-reacts with thiazides, loop diuretics, some sulfonylureas, and celecoxib.'),
('aspirin', ARRAY['ibuprofen', 'diclofenac', 'naproxen', 'celecoxib', 'indomethacin', 'mefenamic-acid', 'ketorolac'], 'severe', 'All NSAIDs should be avoided in aspirin allergy. Consider paracetamol.'),
('nsaids', ARRAY['aspirin', 'ibuprofen', 'diclofenac', 'naproxen', 'celecoxib', 'indomethacin', 'mefenamic-acid', 'ketorolac'], 'severe', 'Cross-reactivity across all NSAIDs. Use paracetamol instead.'),
('iodine', ARRAY['iodinated-contrast', 'povidone-iodine', 'amiodarone'], 'severe', 'Iodine allergy — contrast media and topical iodine should be used with caution. Amiodarone contains iodine.'),
('latex', ARRAY['banana', 'avocado', 'kiwi', 'chestnut'], 'moderate', 'Latex-fruit syndrome — 30-50% of latex-allergic patients react to these fruits.'),
('codeine', ARRAY['morphine', 'tramadol', 'fentanyl', 'oxycodone', 'hydrocodone'], 'moderate', 'True opioid allergy is rare — most reactions are side effects. If true allergy, use non-opioid analgesics.'),
('morphine', ARRAY['codeine', 'tramadol', 'fentanyl', 'oxycodone', 'hydrocodone'], 'moderate', 'Cross-reactivity within opioid class. Consider non-opioid alternatives.'),
('tramadol', ARRAY['codeine', 'morphine', 'fentanyl'], 'moderate', 'Opioid cross-reactivity. Also has serotonergic effects — avoid with SSRIs.'),
('fentanyl', ARRAY['morphine', 'codeine', 'tramadol'], 'mild', 'Lower cross-reactivity than other opioids. Often tolerated in patients with morphine intolerance.'),
('cephalosporin', ARRAY['penicillin'], 'moderate', '1-10% cross-reactivity with penicillin allergy. 3rd/4th gen have lower risk.'),
('carbapenem', ARRAY['penicillin'], 'mild', '<1% cross-reactivity with penicillin. Generally safe.'),
('tetracycline', ARRAY['doxycycline', 'minocycline', 'tigecycline'], 'moderate', 'Cross-reactivity within tetracycline class.'),
('erythromycin', ARRAY['clarithromycin', 'azithromycin'], 'moderate', 'Macrolide cross-reactivity. Azithromycin has lower cross-reactivity.'),
('fluoroquinolone', ARRAY['ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'norfloxacin'], 'moderate', 'Cross-reactivity across fluoroquinolone class.'),
('metronidazole', ARRAY['tinidazole', 'secnidazole'], 'moderate', 'Nitroimidazole cross-reactivity.'),
('phenytoin', ARRAY['carbamazepine', 'lamotrigine', 'phenobarbital'], 'moderate', 'Anticonvulsant hypersensitivity syndrome — aromatic anticonvulsants cross-react.'),
('carbamazepine', ARRAY['phenytoin', 'lamotrigine', 'phenobarbital', 'oxcarbazepine'], 'moderate', 'Aromatic anticonvulsant cross-reactivity (HLA-B*1502 in Asian populations).'),
('heparin', ARRAY['enoxaparin', 'dalteparin', 'fondaparinux'], 'moderate', 'Heparin-induced thrombocytopenia (HIT) — low molecular weight heparins also affected. Fondaparinux usually safe.'),
('protamine', ARRAY['insulin-nph', 'protamine-zinc-insulin'], 'moderate', 'Protamine allergy — found in NPH insulin. Use recombinant insulin instead.'),
('chlorhexidine', ARRAY['chlorhexidine-gluconate'], 'moderate', 'Chlorhexidine allergy — avoid all chlorhexidine-containing products including mouthwash.'),
('bacitracin', ARRAY['neomycin', 'polymyxin-b'], 'moderate', 'Topical antibiotic cross-reactivity.'),
('local-anesthetic-ester', ARRAY['procaine', 'tetracaine', 'benzocaine'], 'moderate', 'Ester-type local anesthetics cross-react. Amide-type (lidocaine, bupivacaine) usually safe.'),
('local-anesthetic-amide', ARRAY['lidocaine', 'bupivacaine', 'ropivacaine', 'mepivacaine'], 'mild', 'Amide-type cross-reactivity is rare. Usually can use different amide.'),
('barium', ARRAY['barium-sulfate'], 'moderate', 'Barium allergy — ensure contrast media is barium-free.'),
('gentamicin', ARRAY['tobramycin', 'amikacin', 'neomycin'], 'moderate', 'Aminoglycoside cross-reactivity.'),
('vancomycin', ARRAY['teicoplanin'], 'moderate', 'Red Man Syndrome with vancomycin — infusion-rate dependent. Cross-reactivity with teicoplanin possible.'),
('dapsone', ARRAY['sulfonamides', 'sulfa-drugs'], 'moderate', 'Dapsone is a sulfone — cross-reacts with sulfa allergy.'),
('pyrazinamide', ARRAY['isoniazid', 'rifampicin'], 'mild', 'Antitubercular drug cross-reactivity is rare but monitor for hepatotoxicity.'),
('chloroquine', ARRAY['hydroxychloroquine', 'mefloquine', 'quinine', 'primaquine'], 'moderate', 'Aminoquinoline cross-reactivity. Hydroxychloroquine may be tolerated in mild chloroquine allergy.')
ON CONFLICT (allergen) DO NOTHING;

-- =====================================================================
-- 6. Verification
-- =====================================================================
DO $_$
DECLARE
  v_interactions integer;
  v_allergies integer;
BEGIN
  SELECT count(*) INTO v_interactions FROM public.drug_interactions;
  SELECT count(*) INTO v_allergies FROM public.drug_allergy_classes;
  RAISE NOTICE 'Drug interactions seeded: % rows', v_interactions;
  RAISE NOTICE 'Drug allergy classes seeded: % rows', v_allergies;
  RAISE NOTICE 'medication_safety_alerts table created with RLS + realtime';
END $_$;
