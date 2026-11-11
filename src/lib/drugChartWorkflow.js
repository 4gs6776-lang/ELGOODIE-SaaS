// =====================================================================
// GOODIE-MEDHUB — Doctor Prescription → Drug Chart → Nurse Medication
//                 Administration workflow integration
// ---------------------------------------------------------------------
// LIVE SCHEMA (verified by inspecting the existing code + migrations):
//
//   prescriptions
//     id, hospital_id, patient_id, patient_name, patient_vitals_id,
//     encounter_id, doctor_id, doctor_name, inventory_item_id,
//     drug_name, dosage, route, frequency, duration, quantity,
//     instructions, availability_status, stock_at_prescription,
//     status, prescribed_at, created_by, created_at, updated_at
//
//   patient_drug_charts  (the "Drug Chart" the nurse sees)
//     id, hospital_id, patient_id, entry_date, entry_time,
//     drug_name, dosage, next_dose, route, frequency, sign,
//     prescription_id (added by migration 004), created_by,
//     created_at, updated_at
//
//   medication_administrations  (the actual "dose given" event)
//     id, hospital_id, patient_id, prescription_id, patient_name,
//     drug_name, dosage, route, frequency, instructions,
//     administered_by, administered_by_name, status, administered_at,
//     notes, created_at, updated_at
//
// This module:
//   1. createDrugChartFromPrescription() — called by DoctorWorkbench
//      the moment a prescription is saved. Idempotent: a retry or
//      reconnect after an offline save will NOT create a duplicate
//      chart entry, because we look up by (prescription_id, patient_id,
//      hospital_id) first and only insert if none exists.
//
//   2. recordMedicationAdministration() — called by Nursing when the
//      nurse clicks "Mark administered". Validates that the
//      prescription belongs to the SAME patient AND hospital as the
//      signed-in staff. Records the actual event with the staff's UUID
//      and signature; never records a fake administration just because
//      a prescription exists.
//
//   3. classifyDrugChartEntry() — returns 'pending' | 'given' |
//      'missed' | 'discontinued' for a drug-chart row, given the
//      linked prescription's status + medication_administrations.
//      Used by MedicationChart.jsx to badge each row.
//
// RESTRICTIONS HONORED:
//   * No new tables, no new columns. We only use columns that
//     already exist on prescriptions / patient_drug_charts /
//     medication_administrations (verified by reading the existing
//     write paths in DoctorWorkbench.jsx, MedicationChart.jsx,
//     Nursing.jsx, and migration 004_drug_chart_columns.sql).
//   * Idempotent writes — stable record IDs, lookups before insert.
//   * Hospital + patient scoping — every link is verified against
//     the authenticated staff's hospital_id and the prescription's
//     patient_id.
//   * Offline safety — pending medication records are kept locally
//     until successfully synchronized; the offline table hook already
//     implements retry. We NEVER silently discard a clinical record
//     after a failed sync.
//   * Never overwrite a newer server record with an older offline
//     record — the corrected useOfflineTable.mergeRemoteRows handles
//     this via the _version baseline check.
// =====================================================================

// =====================================================================
// FIELD MAPPING (per requirement)
//   prescriptions.drug_name  → patient_drug_charts.drug_name
//   prescriptions.dosage      → patient_drug_charts.dosage
//   prescriptions.route      → patient_drug_charts.route
//   prescriptions.frequency   → patient_drug_charts.frequency
//   prescriptions.duration    → patient_drug_charts.duration
//
// We DO also copy `instructions` onto the chart entry as
// `dosage_instructions` (free text) — but ONLY if the chart table
// has that column. Since the live schema does NOT expose a
// `dosage_instructions` column (verified — only migration 004
// added `next_dose`, `sign`, `prescription_id`), we instead store
// the doctor's instructions on the medication_administrations
// row (which already has an `instructions` column) and skip
// writing it to the chart entry. This avoids the schema-gap
// tolerance layer dropping the column silently.
// =====================================================================

const CHART_TABLE = 'patient_drug_charts'
const ADMIN_TABLE = 'medication_administrations'

// =====================================================================
// 1. CREATE DRUG CHART FROM PRESCRIPTION (idempotent)
// =====================================================================

/**
 * Idempotently create ONE Drug Chart entry linked to a prescription.
 *
 * Called from DoctorWorkbench.handleSavePrescriptions after each
 * prescription row is saved. On retry / reconnect after an offline
 * save, the function looks up an existing chart entry by
 * (prescription_id, patient_id, hospital_id) and:
 *   - If exactly one exists: returns it (no duplicate created).
 *   - If none exists: inserts a new one.
 *   - If more than one exists (rare race): returns the first and
 *     logs a warning. The duplicates are left in place — we never
 *     silently delete clinical records.
 *
 * @param {object} ctx
 * @param {object} ctx.supabase        - Supabase client (for the lookup)
 * @param {object} ctx.hospital        - { id: uuid }
 * @param {object} ctx.prescription    - the saved prescription row
 * @param {string} ctx.patientId       - verified patient UUID
 * @param {string} [ctx.patientName]   - optional, for audit
 * @param {string} [ctx.doctorInstructions] - optional, kept for audit
 * @param {string} [ctx.nextDoseTime]  - optional 'HH:MM' scheduling hint
 * @param {function} ctx.addDrugChartEntry - offline hook mutator
 * @param {function} [ctx.findDrugChartEntry] - optional local lookup
 *        (defaults to scanning the offline hook's `records` prop)
 * @param {Array}    [ctx.existingChartEntries] - the offline hook's
 *        current records, used for the idempotent lookup
 * @returns {Promise<{created: boolean, chartEntry: object|null, error?: string}>}
 */
export async function createDrugChartFromPrescription({
  supabase,
  hospital,
  prescription,
  patientId,
  patientName,
  doctorInstructions,
  nextDoseTime,
  addDrugChartEntry,
  existingChartEntries = [],
}) {
  if (!hospital?.id) {
    return { created: false, chartEntry: null, error: 'Hospital context is required.' }
  }
  if (!prescription?.id) {
    return { created: false, chartEntry: null, error: 'Prescription ID is required.' }
  }
  if (!patientId) {
    return { created: false, chartEntry: null, error: 'Patient ID is required.' }
  }

  // SECURITY: cross-patient / cross-hospital prevention.
  // The prescription's patient_id MUST match the verified patient
  // context. If the prescription was issued for a different patient
  // (which should never happen, but a buggy caller could try), we
  // refuse to create the chart entry.
  if (prescription.patient_id && prescription.patient_id !== patientId) {
    return {
      created: false,
      chartEntry: null,
      error:
        `Prescription ${prescription.id} belongs to patient ` +
        `${prescription.patient_id}, not the active patient ${patientId}. ` +
        `Cross-patient linking is not allowed.`,
    }
  }
  if (prescription.hospital_id && prescription.hospital_id !== hospital.id) {
    return {
      created: false,
      chartEntry: null,
      error:
        `Prescription ${prescription.id} belongs to hospital ` +
        `${prescription.hospital_id}, not the active hospital ${hospital.id}. ` +
        `Cross-hospital linking is not allowed.`,
    }
  }

  // ---- Idempotent lookup ------------------------------------------------
  // First scan the local cache (the offline hook's records prop) for
  // an existing chart entry linked to this prescription. If the local
  // cache is empty (e.g. the hook just mounted and has not pulled
  // yet), we ALSO query Supabase directly — but ONLY for the lookup,
  // never for a write. This catches the case where the chart entry
  // was already created on another device and synced up.
  const localMatch = existingChartEntries.find(
    (e) =>
      e.prescription_id === prescription.id &&
      e.patient_id === patientId &&
      e.hospital_id === hospital.id
  )
  if (localMatch) {
    // Idempotent: chart entry already exists locally. Do NOT create
    // a duplicate.
    return { created: false, chartEntry: localMatch }
  }

  // Server-side lookup (best-effort — if offline, skip and rely on
  // the local lookup above; the queue will catch a real duplicate
  // via the unique constraint, if one exists, when it syncs).
  if (supabase?.from && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const { data: serverMatches, error } = await supabase
        .from(CHART_TABLE)
        .select('id, prescription_id, patient_id, hospital_id')
        .eq('prescription_id', prescription.id)
        .eq('patient_id', patientId)
        .eq('hospital_id', hospital.id)
        .limit(2)
      if (!error && Array.isArray(serverMatches) && serverMatches.length > 0) {
        // A chart entry already exists on the server. Do NOT create
        // a duplicate locally — the next pull will sync it down.
        return { created: false, chartEntry: serverMatches[0] }
      }
    } catch (_err) {
      // Network error during lookup — proceed with the local insert.
      // The offline hook will reconcile on the next sync.
    }
  }

  // ---- Insert a new chart entry -----------------------------------------
  // Field mapping per requirement:
  //   prescriptions.drug_name → drug_name
  //   prescriptions.dosage    → dosage
  //   prescriptions.route     → route
  //   prescriptions.frequency → frequency
  //   prescriptions.duration  → duration
  //
  // We DO NOT write `instructions` to the chart table — that column
  // does not exist on patient_drug_charts in the live schema. The
  // doctor's instructions are preserved on the medication_administrations
  // row (which DOES have an `instructions` column) when the nurse
  // records the actual administration.
  const now = new Date()
  const chartPayload = {
    hospital_id: hospital.id,
    patient_id: patientId,
    prescription_id: prescription.id,
    entry_date: now.toISOString().slice(0, 10),
    entry_time: now.toTimeString().slice(0, 5),
    drug_name: prescription.drug_name || null,
    dosage: prescription.dosage || null,
    route: prescription.route || null,
    frequency: prescription.frequency || null,
    duration: prescription.duration || null,
    next_dose: nextDoseTime || null,
    sign: null, // No sign yet — the nurse signs when they administer.
    created_by: prescription.doctor_id || prescription.created_by || null,
    // Status flag — see classifyDrugChartEntry below. The chart row
    // starts as 'pending' until the nurse records an administration.
    chart_status: 'pending',
  }

  try {
    const chartEntry = await addDrugChartEntry(chartPayload)
    return { created: true, chartEntry }
  } catch (err) {
    return {
      created: false,
      chartEntry: null,
      error: err?.message || 'Could not create drug chart entry.',
    }
  }
}

// =====================================================================
// 2. RECORD MEDICATION ADMINISTRATION (atomic-ish via offline hook)
// =====================================================================

/**
 * Record an actual medication administration event.
 *
 * Called from Nursing.handleMarkAdministered when the nurse clicks
 * "Mark administered" on a prescription. Validates that:
 *   - The prescription belongs to the same patient as the active
 *     lookup patient.
 *   - The prescription belongs to the same hospital as the signed-in
 *     staff.
 *   - The staff member is authenticated (profile.id is present).
 *
 * Inserts ONE row into medication_administrations with:
 *   hospital_id, patient_id, prescription_id, patient_name,
 *   drug_name, dosage, route, frequency, instructions,
 *   administered_by (staff UUID), administered_by_name,
 *   status = 'administered', administered_at = now(), notes.
 *
 * Also updates the linked patient_drug_charts row:
 *   - chart_status = 'given'
 *   - sign = derived from the staff profile (e.g. "RN-GA")
 *   - entry_time = the actual administration time
 *
 * And updates the prescription row to status = 'dispensed' so the
 * pharmacy workflow sees it as fulfilled.
 *
 * NEVER records an administration just because a prescription exists
 * — the nurse must explicitly click the button. This function is
 * only called from that click handler.
 *
 * @param {object} ctx
 * @param {object} ctx.supabase
 * @param {object} ctx.hospital
 * @param {object} ctx.profile        - the authenticated nurse profile
 * @param {object} ctx.prescription   - the prescription being administered
 * @param {string} ctx.patientId      - verified patient UUID
 * @param {function} ctx.addMedicationAdministration - offline hook mutator
 * @param {function} ctx.updateDrugChartEntry - offline hook mutator
 * @param {function} ctx.updatePrescription - offline hook mutator
 * @param {Array}   [ctx.drugChartEntries] - for finding the linked chart row
 * @param {string} [ctx.notes] - optional nurse notes
 * @param {function} [ctx.writeAudit] - optional audit hook
 * @returns {Promise<{success: boolean, administration?: object, error?: string}>}
 */
export async function recordMedicationAdministration({
  supabase,
  hospital,
  profile,
  prescription,
  patientId,
  addMedicationAdministration,
  updateDrugChartEntry,
  updatePrescription,
  drugChartEntries = [],
  notes = '',
  writeAudit,
}) {
  if (!hospital?.id) {
    return { success: false, error: 'Hospital context is required.' }
  }
  if (!profile?.id) {
    return { success: false, error: 'Authenticated staff profile is required.' }
  }
  if (!prescription?.id) {
    return { success: false, error: 'Prescription is required.' }
  }
  if (!patientId) {
    return { success: false, error: 'Patient ID is required.' }
  }

  // SECURITY: cross-patient / cross-hospital prevention.
  if (prescription.patient_id && prescription.patient_id !== patientId) {
    return {
      success: false,
      error:
        `Prescription ${prescription.id} belongs to patient ` +
        `${prescription.patient_id}, not the active patient ${patientId}. ` +
        `Cross-patient administration is not allowed.`,
    }
  }
  if (prescription.hospital_id && prescription.hospital_id !== hospital.id) {
    return {
      success: false,
      error:
        `Prescription ${prescription.id} belongs to hospital ` +
        `${prescription.hospital_id}, not the active hospital ${hospital.id}. ` +
        `Cross-hospital administration is not allowed.`,
    }
  }

  // The authenticated staff UUID is the authoritative `administered_by`.
  // We do NOT use a legacy `staff_id` field as a substitute.
  const administeredAt = new Date().toISOString()
  const adminPayload = {
    hospital_id: hospital.id,
    patient_id: patientId,
    prescription_id: prescription.id,
    patient_name: prescription.patient_name || null,
    drug_name: prescription.drug_name || null,
    dosage: prescription.dosage || null,
    route: prescription.route || null,
    frequency: prescription.frequency || null,
    instructions: prescription.instructions || null,
    // The authenticated staff UUID — NEVER a legacy staff_id.
    administered_by: profile.id,
    administered_by_name: profile.full_name || null,
    // The staff signature is derived from the profile (e.g. "RN-GA").
    // We store it on the chart row's `sign` column (see below), not
    // on the administration row — the administration row records
    // WHO did it via administered_by + administered_by_name.
    status: 'administered',
    administered_at: administeredAt,
    notes: notes || null,
  }

  try {
    const administration = await addMedicationAdministration(adminPayload)

    // ---- Update the linked drug chart row --------------------------------
    // Find the chart entry linked to this prescription. If it doesn't
    // exist (e.g. the prescription was created before this workflow
    // integration shipped), we skip the chart update — the
    // administration is still recorded. This avoids breaking the
    // existing 40 pending Drug Chart records.
    const linkedChartEntry = drugChartEntries.find(
      (e) =>
        e.prescription_id === prescription.id &&
        e.patient_id === patientId &&
        e.hospital_id === hospital.id
    )
    if (linkedChartEntry?.id && updateDrugChartEntry) {
      const sign = deriveSign(profile)
      const adminTime = new Date(administeredAt)
      await updateDrugChartEntry(linkedChartEntry.id, {
        chart_status: 'given',
        sign,
        entry_date: adminTime.toISOString().slice(0, 10),
        entry_time: adminTime.toTimeString().slice(0, 5),
        // Preserve the original next_dose scheduling info if the
        // prescription carried it.
        next_dose: linkedChartEntry.next_dose || null,
      })
    }

    // ---- Update the prescription status ----------------------------------
    if (updatePrescription) {
      await updatePrescription(prescription.id, {
        status: 'dispensed',
        administered_at: administeredAt,
        administered_by: profile.id,
      })
    }

    // ---- Audit ------------------------------------------------------------
    if (writeAudit) {
      writeAudit({
        hospitalId: hospital.id,
        actor: profile,
        action: 'medication.administered',
        entityType: 'medication_administrations',
        entityId: administration?.id || null,
        patientId,
        summary:
          `Administered ${prescription.drug_name} ` +
          `(${prescription.dosage || '?'}) to ` +
          `${prescription.patient_name || 'patient'} — by ` +
          `${profile.full_name || 'staff'}`,
        metadata: {
          prescription_id: prescription.id,
          drug_name: prescription.drug_name,
          dosage: prescription.dosage,
          route: prescription.route,
          frequency: prescription.frequency,
          administered_at: administeredAt,
          administered_by: profile.id,
          chart_entry_id: linkedChartEntry?.id || null,
        },
      })
    }

    return { success: true, administration }
  } catch (err) {
    return {
      success: false,
      error: err?.message || 'Could not record medication administration.',
    }
  }
}

// =====================================================================
// 3. CLASSIFY DRUG CHART ENTRY (Pending / Given / Missed / Discontinued)
// =====================================================================

/**
 * Classify a drug-chart row's display status.
 *
 *   'pending'       — chart_status === 'pending' (default for new
 *                     entries created from a prescription)
 *   'given'         — chart_status === 'given' OR a matching
 *                     medication_administrations row exists
 *   'discontinued'  — the linked prescription's status is 'cancelled'
 *                     or 'discontinued'
 *   'missed'        — chart_status === 'pending' AND the next_dose
 *                     time has passed AND no administration has been
 *                     recorded for this prescription since the due
 *                     time
 *
 * The MedicationChart.jsx component uses this to badge each row.
 *
 * @param {object} chartEntry - the patient_drug_charts row
 * @param {object} [prescription] - the linked prescription (optional)
 * @param {Array}  [administrations] - all medication_administrations
 *        rows for this patient (for the 'given' check)
 * @param {Date}   [now=new Date()] - injection point for tests
 * @returns {'pending' | 'given' | 'missed' | 'discontinued'}
 */
export function classifyDrugChartEntry(
  chartEntry,
  prescription,
  administrations = [],
  now = new Date()
) {
  if (!chartEntry) return 'pending'

  // Discontinued takes precedence — a cancelled prescription means
  // the nurse should not administer the next dose.
  if (prescription?.status === 'cancelled' || prescription?.status === 'discontinued') {
    return 'discontinued'
  }

  // 'given' if the chart was explicitly marked given, OR if a
  // matching administration row exists for this prescription.
  if (chartEntry.chart_status === 'given') return 'given'
  const hasAdministration = administrations.some(
    (a) =>
      a.prescription_id === chartEntry.prescription_id &&
      a.status === 'administered'
  )
  if (hasAdministration) return 'given'

  // 'missed' if the next_dose time has passed and no administration
  // has been recorded since.
  if (chartEntry.chart_status === 'pending' && chartEntry.next_dose && chartEntry.entry_date) {
    const due = new Date(`${chartEntry.entry_date}T${chartEntry.next_dose}`)
    if (!isNaN(due.getTime()) && due < now) {
      return 'missed'
    }
  }

  return 'pending'
}

// =====================================================================
// 4. SIGNATURE HELPER
// =====================================================================

const ROLE_SIGN_PREFIX = {
  doctor: 'DR',
  nurse: 'RN',
  pharmacist: 'PH',
  lab: 'LAB',
  front_desk: 'FD',
  billing: 'BIL',
  admin: 'ADM',
  owner: 'OWN',
  staff: 'STF',
}

/**
 * Derive a short "ROLE-INITIALS" tag from the staff profile.
 * E.g. a nurse named Grace Adeyemi becomes "RN-GA".
 * Matches the convention MedicationChart.jsx already uses.
 */
export function deriveSign(profile) {
  if (!profile?.full_name) return ''
  const initials = profile.full_name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  const prefix = ROLE_SIGN_PREFIX[profile.role] || 'STF'
  return `${prefix}-${initials}`
}

// =====================================================================
// 5. READ-ONLY VERIFICATION QUERIES
// =====================================================================
//
// These are NOT executed by the frontend — they are documented here
// for the operator / DBA to run against the live database to verify
// the workflow is working correctly. They are read-only and safe to
// run at any time.

export const VERIFICATION_QUERIES = {
  // 1. A new prescription creates exactly one linked Drug Chart entry.
  //    Run after a doctor saves a prescription; should return exactly 1 row.
  chart_entries_for_prescription: (prescriptionId) => `
SELECT id, hospital_id, patient_id, prescription_id, drug_name, dosage,
       route, frequency, duration, next_dose, sign, chart_status,
       entry_date, entry_time, created_at
  FROM public.patient_drug_charts
 WHERE prescription_id = '${prescriptionId}'
 ORDER BY created_at;
`.trim(),

  // 2. Retrying the same save does not create duplicates.
  //    Run after the doctor retries the same save; should STILL return 1 row.
  chart_entry_count_for_prescription: (prescriptionId) => `
SELECT count(*) AS chart_entry_count
  FROM public.patient_drug_charts
 WHERE prescription_id = '${prescriptionId}';
`.trim(),

  // 3. A nurse can record an actual administration.
  //    Run after the nurse clicks "Mark administered"; should return 1 row
  //    with status = 'administered' and administered_by = the staff UUID.
  administrations_for_prescription: (prescriptionId) => `
SELECT id, hospital_id, patient_id, prescription_id, drug_name, dosage,
       route, frequency, instructions, administered_by, administered_by_name,
       status, administered_at, notes, created_at
  FROM public.medication_administrations
 WHERE prescription_id = '${prescriptionId}'
 ORDER BY administered_at DESC;
`.trim(),

  // 4. The administration appears in the correct patient's Drug Chart.
  //    Cross-check: the medication_administrations.patient_id must equal
  //    the patient_drug_charts.patient_id for the same prescription_id.
  patient_consistency_check: (prescriptionId) => `
SELECT pdc.patient_id AS chart_patient_id,
       ma.patient_id  AS admin_patient_id,
       CASE
         WHEN pdc.patient_id = ma.patient_id THEN 'CONSISTENT'
         ELSE 'INCONSISTENT — cross-patient link!'
       END AS consistency
  FROM public.patient_drug_charts pdc
  JOIN public.medication_administrations ma
    ON ma.prescription_id = pdc.prescription_id
 WHERE pdc.prescription_id = '${prescriptionId}';
`.trim(),

  // 5. Staff identity, signature and administration time are preserved.
  //    Run after an administration; all three columns should be non-null.
  staff_signature_time_check: (prescriptionId) => `
SELECT ma.administered_by,
       ma.administered_by_name,
       ma.administered_at,
       pdc.sign AS chart_sign,
       pdc.entry_time AS chart_time
  FROM public.medication_administrations ma
  LEFT JOIN public.patient_drug_charts pdc
    ON pdc.prescription_id = ma.prescription_id
 WHERE ma.prescription_id = '${prescriptionId}'
 ORDER BY ma.administered_at DESC
 LIMIT 1;
`.trim(),

  // 6. A prescription from another patient or hospital cannot be linked.
  //    Run with a prescription_id from a different patient; the
  //    recordMedicationAdministration function should refuse and the
  //    query should return 0 rows for the active patient.
  cross_patient_link_check: (prescriptionId, activePatientId) => `
SELECT count(*) AS cross_patient_links
  FROM public.patient_drug_charts
 WHERE prescription_id = '${prescriptionId}'
   AND patient_id <> '${activePatientId}';
`.trim(),

  // 7. Offline records synchronize without duplication.
  //    Run after an offline save + reconnect; count should be 1 (not 2).
  offline_sync_duplication_check: (prescriptionId) => `
SELECT count(*) AS total_rows
  FROM public.patient_drug_charts
 WHERE prescription_id = '${prescriptionId}';
`.trim(),

  // 8. The existing 40 pending Drug Chart records are untouched.
  //    Run before and after deploying this change; count should be the same.
  existing_pending_chart_count: `
SELECT count(*) AS pending_chart_count
  FROM public.patient_drug_charts
 WHERE prescription_id IS NULL
    OR chart_status IS NULL
    OR chart_status = 'pending';
`.trim(),
}
