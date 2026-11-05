// =====================================================================
// GOODIE-MEDHUB — Drug Interaction Engine
// =====================================================================
// The core clinical decision support engine for medication safety.
//
// Runs 6 checks when a doctor adds a medication:
//   1. Drug–Drug interactions (against active prescriptions)
//   2. Drug–Allergy interactions (against patient's allergy history)
//   3. Drug–Condition interactions (against past medical history)
//   4. Drug–Lab interactions (against latest renal function labs)
//   5. Pregnancy checking (from history/ANC)
//   6. Pediatric dosing (if age < 13)
//
// Returns an array of alerts. Each alert has:
//   { type, severity, drugName, interactingWith, mechanism, recommendation }
//
// Severity levels:
//   'soft'  — yellow warning. Doctor can override with a reason.
//   'hard'  — red block. Doctor MUST type a justification to override.
//
// The engine runs entirely client-side using data from IndexedDB
// (via useOfflineTable). No API calls — checks complete in <50ms.
// =====================================================================

// ---------------------------------------------------------------------
// normalizeDrugName — extracts the generic name from a drug string
// ---------------------------------------------------------------------
// The DoctorWorkbench's medBuilder.drugName might be a brand name
// (e.g., "Augmentin") or a generic (e.g., "Amoxicillin"). We need to
// normalize to the generic for lookup.
//
// For now, we use a simple mapping + lowercase matching. In production,
// this would use a proper drug database (RxNorm / WHO ATC).
// ---------------------------------------------------------------------
const BRAND_TO_GENERIC = {
  'augmentin': 'amoxicillin',
  'amoxil': 'amoxicillin',
  'flagyl': 'metronidazole',
  'voltaren': 'diclofenac',
  'brufen': 'ibuprofen',
  'advil': 'ibuprofen',
  'motrin': 'ibuprofen',
  'panadol': 'paracetamol',
  'tylenol': 'paracetamol',
  'lasix': 'furosemide',
  'aldactone': 'spironolactone',
  'tenormin': 'atenolol',
  'cipro': 'ciprofloxacin',
  'bactrim': 'co-trimoxazole',
  'septrin': 'co-trimoxazole',
  'glucophage': 'metformin',
  'daonil': 'glibenclamide',
  'coumadin': 'warfarin',
  'digoxin-lanoxin': 'digoxin',
  'lanoxin': 'digoxin',
  'cordarone': 'amiodarone',
  'verelan': 'verapamil',
  'calan': 'verapamil',
  'dilantin': 'phenytoin',
  'tegretol': 'carbamazepine',
  'valproate': 'valproic-acid',
  'depakote': 'valproic-acid',
  'zithromax': 'azithromycin',
  'biaxin': 'clarithromycin',
  'prilosec': 'omeprazole',
  'protonix': 'pantoprazole',
  'viagra': 'sildenafil',
  'lipitor': 'atorvastatin',
  'zocor': 'simvastatin',
  'lopressor': 'metoprolol',
  'tenormin': 'atenolol',
  'norvasc': 'amlodipine',
  'procardia': 'nifedipine',
  'cardizem': 'diltiazem',
  'altace': 'ramipril',
  'vasotec': 'enalapril',
  'prinvil': 'lisinopril',
  'cozaar': 'losartan',
  'diovan': 'valsartan',
  'plavix': 'clopidogrel',
  'lantus': 'insulin',
  'humalog': 'insulin',
  'novolog': 'insulin',
  'levemir': 'insulin',
}

function normalizeDrugName(name) {
  if (!name) return ''
  const lower = name.toLowerCase().trim()
  // Check brand → generic mapping
  if (BRAND_TO_GENERIC[lower]) return BRAND_TO_GENERIC[lower]
  // Try to extract generic if the string contains "generic (brand)" format
  const match = lower.match(/^([a-z-]+)/)
  return match ? match[1] : lower
}

// ---------------------------------------------------------------------
// extractAllergies — parses the allergy history text field
// ---------------------------------------------------------------------
// The allergy_history field is free-text (e.g., "Penicillin — rash,
// Sulfa drugs"). We need to extract individual allergens.
// ---------------------------------------------------------------------
function extractAllergies(allergyText) {
  if (!allergyText || typeof allergyText !== 'string') return []
  const lower = allergyText.toLowerCase()
  const allergens = []

  // Common allergen patterns
  const patterns = [
    { pattern: /penicillin|amoxicillin|ampicillin|augmentin/i, name: 'penicillin' },
    { pattern: /sulfa|sulphonamide|co-trimoxazole|septrin|bactrim|trimethoprim/i, name: 'sulfa-drugs' },
    { pattern: /aspirin|asa\b/i, name: 'aspirin' },
    { pattern: /ibuprofen|diclofenac|naproxen|nsaid|brufen|voltaren|indomethacin|mefenamic/i, name: 'nsaids' },
    { pattern: /iodine|contrast|povidone/i, name: 'iodine' },
    { pattern: /latex/i, name: 'latex' },
    { pattern: /codeine|morphine|tramadol|opioid/i, name: 'codeine' },
    { pattern: /cephalosporin|cefuroxime|cefixime|ceftriaxone/i, name: 'cephalosporin' },
    { pattern: /erythromycin|azithromycin|clarithromycin/i, name: 'erythromycin' },
    { pattern: /tetracycline|doxycycline/i, name: 'tetracycline' },
    { pattern: /metronidazole|flagyl/i, name: 'metronidazole' },
    { pattern: /chloroquine|antimalarial/i, name: 'chloroquine' },
    { pattern: /phenytoin|dilantin/i, name: 'phenytoin' },
    { pattern: /carbamazepine|tegretol/i, name: 'carbamazepine' },
    { pattern: /heparin|enoxaparin/i, name: 'heparin' },
    { pattern: /gentamicin|aminoglycoside/i, name: 'gentamicin' },
    { pattern: /vancomycin/i, name: 'vancomycin' },
    { pattern: /dapsone/i, name: 'dapsone' },
    { pattern: /barbiturate|phenobarbital/i, name: 'phenobarbital' },
    { pattern: /local.anesthetic|lidocaine|bupivacaine/i, name: 'local-anesthetic-amide' },
    { pattern: /procaine|tetracaine|benzocaine/i, name: 'local-anesthetic-ester' },
  ]

  for (const { pattern, name } of patterns) {
    if (pattern.test(lower) && !allergens.includes(name)) {
      allergens.push(name)
    }
  }

  return allergens
}

// ---------------------------------------------------------------------
// checkPregnancy — checks if the patient might be pregnant
// ---------------------------------------------------------------------
function checkPregnancy(historyText, patientCategory) {
  if (patientCategory === 'anc') return true
  const lower = (historyText || '').toLowerCase()
  return /pregnan|gravid|antenatal|anc|expected.*date.*delivery|edd|lmp/i.test(lower)
}

// ---------------------------------------------------------------------
// checkPediatric — checks if the patient is a pediatric patient
// ---------------------------------------------------------------------
function checkPediatric(patient) {
  if (!patient) return false
  if (patient.age != null) return parseInt(patient.age) < 13
  if (patient.date_of_birth) {
    const age = Math.floor((Date.now() - new Date(patient.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000))
    return age < 13
  }
  return false
}

// ---------------------------------------------------------------------
// getLatestLab — finds the latest lab result for a given test name
// ---------------------------------------------------------------------
function getLatestLab(labOrders, testNamePattern) {
  if (!labOrders || labOrders.length === 0) return null
  const matching = labOrders.filter(l =>
    new RegExp(testNamePattern, 'i').test(l.test_name || l.test_type || '') &&
    l.status === 'completed' &&
    l.result != null
  )
  if (matching.length === 0) return null
  return matching.sort((a, b) => new Date(b.resulted_at || b.created_at) - new Date(a.resulted_at || a.created_at))[0]
}

// ---------------------------------------------------------------------
// MAIN: checkMedicationSafety — runs all 6 checks
// ---------------------------------------------------------------------
// Inputs:
//   drugName        — the drug the doctor is about to prescribe
//   patientCtx      — { patient, allergyHistory, pastMedicalHistory,
//                       familySocialHistory, drugHistory }
//   activeMeds      — array of { drugName } currently in the prescription builder
//   labOrders       — array of completed lab results
//   drugInteractions  — from useOfflineTable('drug_interactions')
//   allergyClasses    — from useOfflineTable('drug_allergy_classes')
//
// Returns:
//   array of alert objects
// ---------------------------------------------------------------------
export function checkMedicationSafety({
  drugName,
  patientCtx,
  activeMeds = [],
  labOrders = [],
  drugInteractions = [],
  allergyClasses = [],
}) {
  const alerts = []
  const generic = normalizeDrugName(drugName)
  if (!generic) return alerts

  const { patient, allergyHistory, pastMedicalHistory, familySocialHistory, drugHistory } = patientCtx || {}

  // ===== 1. DRUG-DRUG INTERACTIONS =====
  // Check against other drugs already in the prescription builder
  // + drugs in the patient's drug history
  const otherDrugs = [
    ...activeMeds.map(m => normalizeDrugName(m.drugName)).filter(d => d && d !== generic),
    ...extractDrugsFromHistory(drugHistory).filter(d => d !== generic),
  ]

  for (const otherDrug of otherDrugs) {
    const interaction = drugInteractions.find(di =>
      (di.drug_a_generic === generic && di.drug_b_generic === otherDrug) ||
      (di.drug_a_generic === otherDrug && di.drug_b_generic === generic)
    )
    if (interaction) {
      alerts.push({
        type: 'drug_drug',
        severity: interaction.severity === 'contraindicated' ? 'hard' :
                  interaction.severity === 'severe' ? 'hard' : 'soft',
        drugName,
        interactingWith: otherDrug,
        mechanism: interaction.mechanism,
        clinicalEffect: interaction.clinical_effect,
        recommendation: interaction.management || 'Monitor closely.',
        rawSeverity: interaction.severity,
      })
    }
  }

  // ===== 2. DRUG-ALLERGY INTERACTIONS =====
  const patientAllergens = extractAllergies(allergyHistory)
  for (const allergen of patientAllergens) {
    // Direct match: the drug name contains the allergen
    if (generic.includes(allergen) || drugName.toLowerCase().includes(allergen)) {
      const allergyClass = allergyClasses.find(ac => ac.allergen === allergen)
      alerts.push({
        type: 'drug_allergy',
        severity: allergyClass?.severity === 'severe' || allergyClass?.severity === 'contraindicated' ? 'hard' : 'soft',
        drugName,
        interactingWith: allergen,
        mechanism: `Patient has documented allergy to ${allergen}`,
        clinicalEffect: allergyClass?.clinical_note || 'Allergic reaction risk',
        recommendation: `Avoid ${drugName}. Consider alternative medication class.`,
        rawSeverity: allergyClass?.severity || 'moderate',
      })
    }

    // Cross-reactivity: check if the drug matches a cross-reactive class
    const allergyClass = allergyClasses.find(ac => ac.allergen === allergen)
    if (allergyClass?.cross_reactive_classes) {
      for (const crossClass of allergyClass.cross_reactive_classes) {
        if (generic.includes(crossClass) || drugName.toLowerCase().includes(crossClass)) {
          // Avoid duplicate alerts
          if (!alerts.some(a => a.interactingWith === `${allergen} (cross-reactive: ${crossClass})`)) {
            alerts.push({
              type: 'drug_allergy',
              severity: allergyClass.severity === 'severe' || allergyClass.severity === 'contraindicated' ? 'hard' : 'soft',
              drugName,
              interactingWith: `${allergen} (cross-reactive: ${crossClass})`,
              mechanism: `Patient allergic to ${allergen} — cross-reacts with ${crossClass}`,
              clinicalEffect: allergyClass.clinical_note || 'Possible allergic cross-reaction',
              recommendation: `Use with caution. Consider alternative. Monitor for allergic reactions.`,
              rawSeverity: allergyClass.severity || 'moderate',
            })
          }
        }
      }
    }
  }

  // ===== 3. DRUG-CONDITION INTERACTIONS =====
  const pmh = (pastMedicalHistory || '').toLowerCase()
  const conditionInteractions = [
    { condition: /asthma|copd|bronchospasm/i, drugs: ['beta-blocker', 'propranolol', 'atenolol', 'metoprolol', 'bisoprolol'], severity: 'hard', reason: 'Beta-blockers can cause bronchospasm in asthma/COPD patients' },
    { condition: /peptic.ulcer|gastric.ulcer|gi.bleed/i, drugs: ['nsaids', 'ibuprofen', 'diclofenac', 'naproxen', 'aspirin', 'ketorolac'], severity: 'hard', reason: 'NSAIDs can cause GI bleeding in patients with peptic ulcer disease' },
    { condition: /renal.impairment|chronic.kidney|ckd|renal.failure/i, drugs: ['metformin', 'nsaids', 'gentamicin', 'tetracycline'], severity: 'hard', reason: 'This drug is contraindicated or requires dose adjustment in renal impairment' },
    { condition: /heart.failure|cardiac.failure/i, drugs: ['nsaids', 'verapamil', 'diltiazem'], severity: 'soft', reason: 'May worsen heart failure' },
    { condition: /g6pd|glucose-6-phosphate/i, drugs: ['primaquine', 'sulfadoxine', 'dapsone', 'nitrofurantoin'], severity: 'hard', reason: 'Risk of hemolysis in G6PD deficiency' },
    { condition: /glaucoma/i, drugs: ['anticholinergic', 'atropine', 'tricyclic'], severity: 'soft', reason: 'May worsen glaucoma' },
    { condition: /epilep|seizure/i, drugs: ['tramadol', 'bupropion', 'chloroquine'], severity: 'soft', reason: 'May lower seizure threshold' },
    { condition: /porphyria/i, drugs: ['barbiturate', 'phenytoin', 'carbamazepine', 'sulfonamide'], severity: 'hard', reason: 'May precipitate acute porphyric crisis' },
  ]

  for (const ci of conditionInteractions) {
    if (ci.condition.test(pmh)) {
      for (const drugPattern of ci.drugs) {
        if (generic.includes(drugPattern) || drugName.toLowerCase().includes(drugPattern)) {
          alerts.push({
            type: 'drug_condition',
            severity: ci.severity,
            drugName,
            interactingWith: ci.condition.source,
            mechanism: ci.reason,
            clinicalEffect: ci.reason,
            recommendation: ci.severity === 'hard' ? 'Avoid this drug. Consider alternative.' : 'Use with caution. Monitor closely.',
            rawSeverity: ci.severity === 'hard' ? 'severe' : 'moderate',
          })
        }
      }
    }
  }

  // ===== 4. DRUG-LAB (RENAL FUNCTION) INTERACTIONS =====
  // Check latest creatinine/eGFR for renal dosing
  const creatinineLab = getLatestLab(labOrders, 'creatinine|renal|egfr|urea|bun')
  if (creatinineLab) {
    const creatinine = parseFloat(creatinineLab.result)
    if (!isNaN(creatinine) && creatinine > 1.5) {
      // Elevated creatinine — check for renally-cleared drugs
      const renalDrugs = [
        { drug: 'metformin', threshold: 1.5, severity: 'hard', reason: `Metformin contraindicated when creatinine > 1.5 mg/dL (current: ${creatinine}). Risk of lactic acidosis.` },
        { drug: 'metformin', threshold: 1.3, severity: 'soft', reason: `Caution: creatinine ${creatinine} — metformin dose may need reduction.` },
        { drug: 'gentamicin', threshold: 1.5, severity: 'soft', reason: `Renal function impaired (creatinine ${creatinine}) — gentamicin requires dose adjustment + monitoring.` },
        { drug: 'digoxin', threshold: 1.5, severity: 'soft', reason: `Renal function impaired — digoxin dose may need reduction.` },
        { drug: 'enoxaparin', threshold: 1.5, severity: 'soft', reason: `Renal function impaired — enoxaparin dose adjustment needed.` },
        { drug: 'spironolactone', threshold: 1.5, severity: 'soft', reason: `Renal impairment — increased hyperkalemia risk with spironolactone.` },
        { drug: 'allopurinol', threshold: 1.5, severity: 'soft', reason: `Renal impairment — allopurinol dose reduction needed.` },
        { drug: 'vancomycin', threshold: 1.5, severity: 'soft', reason: `Renal impairment — vancomycin requires dose adjustment + level monitoring.` },
      ]
      for (const rd of renalDrugs) {
        if (generic.includes(rd.drug) && creatinine >= rd.threshold) {
          alerts.push({
            type: 'renal_dose',
            severity: rd.severity,
            drugName,
            interactingWith: `Serum creatinine ${creatinine} mg/dL`,
            mechanism: rd.reason,
            clinicalEffect: rd.reason,
            recommendation: rd.severity === 'hard' ? 'AVOID — contraindicated in renal impairment at this level.' : 'Reduce dose. Monitor renal function.',
            rawSeverity: rd.severity === 'hard' ? 'severe' : 'moderate',
          })
        }
      }
    }
  }

  // ===== 5. PREGNANCY CHECKING =====
  const isPregnant = checkPregnancy(familySocialHistory + ' ' + pastMedicalHistory, patient?.category)
  if (isPregnant) {
    const pregnancyCategories = [
      { drugs: ['isotretinoin', 'accutane', 'tretinoin'], category: 'X', severity: 'hard', reason: 'Absolutely contraindicated in pregnancy — teratogenic' },
      { drugs: ['warfarin'], category: 'X', severity: 'hard', reason: 'Contraindicated in pregnancy — teratogenic (fetal warfarin syndrome)' },
      { drugs: ['methotrexate'], category: 'X', severity: 'hard', reason: 'Contraindicated — abortifacient + teratogenic' },
      { drugs: ['misoprostol'], category: 'X', severity: 'hard', reason: 'Contraindicated (unless used for abortion induction)' },
      { drugs: ['tetracycline', 'doxycycline'], category: 'D', severity: 'hard', reason: 'Causes tooth discoloration + bone growth inhibition in fetus' },
      { drugs: ['ciprofloxacin', 'levofloxacin'], category: 'C', severity: 'soft', reason: 'Caution — animal studies show cartilage damage' },
      { drugs: ['co-trimoxazole', 'sulfamethoxazole'], category: 'D', severity: 'hard', reason: 'Folate antagonism — neural tube defect risk in 1st trimester' },
      { drugs: ['ibuprofen', 'diclofenac', 'naproxen', 'aspirin'], category: 'C/D', severity: 'soft', reason: 'Avoid in 3rd trimester — premature closure of ductus arteriosus' },
      { drugs: ['lisinopril', 'enalapril', 'ramipril', 'losartan', 'valsartan'], category: 'D', severity: 'hard', reason: 'Fetal renal damage — especially 2nd/3rd trimester' },
      { drugs: ['phenytoin', 'carbamazepine', 'valproic-acid', 'phenobarbital'], category: 'D', severity: 'hard', reason: 'Teratogenic — neural tube defects' },
      { drugs: ['chloroquine', 'mefloquine'], category: 'C', severity: 'soft', reason: 'Use only if benefit outweighs risk. Mefloquine preferred for prophylaxis.' },
    ]
    for (const pc of pregnancyCategories) {
      for (const drugPattern of pc.drugs) {
        if (generic.includes(drugPattern) || drugName.toLowerCase().includes(drugPattern)) {
          alerts.push({
            type: 'pregnancy',
            severity: pc.severity,
            drugName,
            interactingWith: `Pregnancy (Category ${pc.category})`,
            mechanism: pc.reason,
            clinicalEffect: pc.reason,
            recommendation: pc.severity === 'hard' ? 'AVOID — contraindicated in pregnancy.' : 'Use with caution. Consider safer alternative.',
            rawSeverity: pc.severity === 'hard' ? 'severe' : 'moderate',
          })
        }
      }
    }
  }

  // ===== 6. PEDIATRIC DOSING =====
  if (checkPediatric(patient)) {
    const pediatricWarnings = [
      { drugs: ['tetracycline', 'doxycycline'], ageLimit: 8, reason: 'Tetracyclines cause tooth discoloration in children < 8 years' },
      { drugs: ['ciprofloxacin', 'levofloxacin'], ageLimit: 18, reason: 'Fluoroquinolones may cause cartilage damage in children' },
      { drugs: ['aspirin'], ageLimit: 16, reason: 'Aspirin associated with Reye syndrome in children with viral illness' },
      { drugs: ['codeine'], ageLimit: 12, reason: 'Codeine contraindicated in children < 12 (FDA black box — ultra-rapid metabolizers)' },
      { drugs: ['metoclopramide'], ageLimit: 1, reason: 'Metoclopramide — high risk of extrapyramidal side effects in children < 1 year' },
    ]
    const patientAge = patient?.age != null ? parseInt(patient.age) : null
    for (const pw of pediatricWarnings) {
      for (const drugPattern of pw.drugs) {
        if (generic.includes(drugPattern) || drugName.toLowerCase().includes(drugPattern)) {
          if (patientAge != null && patientAge < pw.ageLimit) {
            alerts.push({
              type: 'pediatric',
              severity: 'hard',
              drugName,
              interactingWith: `Pediatric patient (${patientAge} years old)`,
              mechanism: pw.reason,
              clinicalEffect: pw.reason,
              recommendation: 'Avoid in this age group. Use pediatric-appropriate alternative.',
              rawSeverity: 'severe',
            })
          } else if (patientAge == null) {
            alerts.push({
              type: 'pediatric',
              severity: 'soft',
              drugName,
              interactingWith: 'Pediatric patient (age unknown)',
              mechanism: pw.reason,
              clinicalEffect: pw.reason,
              recommendation: 'Verify age. This drug may be contraindicated in young children.',
              rawSeverity: 'moderate',
            })
          }
        }
      }
    }

    // General pediatric flag
    alerts.push({
      type: 'pediatric',
      severity: 'soft',
      drugName,
      interactingWith: `Pediatric patient (${patientAge || 'unknown'} years old)`,
      mechanism: 'Pediatric dosing required — weight-based calculation needed',
      clinicalEffect: 'Standard adult dosing may be inappropriate',
      recommendation: 'Verify dose is appropriate for patient weight and age. Use pediatric dosing reference.',
      rawSeverity: 'mild',
    })
  }

  return alerts
}

// ---------------------------------------------------------------------
// Helper: extract drugs from the patient's drug history text
// ---------------------------------------------------------------------
function extractDrugsFromHistory(drugHistory) {
  if (!drugHistory || typeof drugHistory !== 'string') return []
  const drugs = []
  const known = [
    'metformin', 'glibenclamide', 'insulin', 'warfarin', 'aspirin',
    'ibuprofen', 'diclofenac', 'atenolol', 'enalapril', 'lisinopril',
    'amlodipine', 'nifedipine', 'furosemide', 'spironolactone',
    'digoxin', 'amiodarone', 'ciprofloxacin', 'metronidazole',
    'phenytoin', 'carbamazepine', 'valproic-acid', 'omeprazole',
    'prednisolone', 'hydrocortisone', 'salbutamol', 'theophylline',
  ]
  const lower = drugHistory.toLowerCase()
  for (const drug of known) {
    if (lower.includes(drug)) drugs.push(drug)
  }
  return drugs
}
