// =====================================================================
// GOODIE-MEDHUB — handoverSummary.js
// =====================================================================
// Auto-generates a clinical summary for shift handover.
//
// Pulls from existing IndexedDB data (via the arrays passed in):
//   - Critical patients (from patient_vitals_alerts — severity = 'critical')
//   - Pending investigations (lab_orders with status != 'completed')
//   - Abnormal lab results (lab_orders with is_abnormal = true)
//   - High early warning scores (calculated from latest vitals)
//   - Pending discharges (patients with queue_status = 'discharged' but no discharge summary)
//   - Unresolved tasks (from handover_tasks)
//
// Returns a structured JSON object that can be stored in the
// auto_generated_summary column + displayed in the ShiftHandover UI.
// =====================================================================

// ---------------------------------------------------------------------
// calculateMEWS — Modified Early Warning Score
// ---------------------------------------------------------------------
// Returns a score 0-12+ based on vitals.
// Higher = more critical.
//
// | Score | 0 | 1 | 2 | 3 |
// |-------|---|---|---|---|
// | RR    | 9-14 | 15-20 | 21-29 | ≤8 or ≥30 |
// | HR    | 50-100 | 101-110 | 111-129 | ≤49 or ≥130 |
// | SBP   | 100-179 | 80-99 | 70-79 | ≤69 or ≥180 |
// | Temp  | 35-38.4 | 34-34.9 or 38.5-39 | <34 or >39 | — |
// | SpO2  | ≥95 | 91-94 | 86-90 | ≤85 |
// | AVPU  | Alert | — | Reacts to voice | Reacts to pain / Unresponsive |
// ---------------------------------------------------------------------
export function calculateMEWS(vitals) {
  if (!vitals) return 0
  let score = 0

  // Respiratory rate
  const rr = parseInt(vitals.respiratory_rate)
  if (!isNaN(rr)) {
    if (rr <= 8 || rr >= 30) score += 3
    else if (rr <= 14) score += 0
    else if (rr <= 20) score += 1
    else if (rr <= 29) score += 2
  }

  // Heart rate
  const hr = parseInt(vitals.pulse_rate)
  if (!isNaN(hr)) {
    if (hr <= 49 || hr >= 130) score += 3
    else if (hr <= 100) score += 0
    else if (hr <= 110) score += 1
    else if (hr <= 129) score += 2
  }

  // Systolic BP
  const bpParts = (vitals.blood_pressure || '').split('/')
  const sbp = parseInt(bpParts[0])
  if (!isNaN(sbp)) {
    if (sbp <= 69 || sbp >= 180) score += 3
    else if (sbp <= 99) score += 1
    else if (sbp <= 79) score += 2
    else score += 0
  }

  // Temperature
  const temp = parseFloat(vitals.temperature)
  if (!isNaN(temp)) {
    if (temp < 34 || temp > 39) score += 2
    else if (temp < 35 || temp >= 38.5) score += 1
  }

  // SpO2
  const spo2 = parseFloat(vitals.spo2)
  if (!isNaN(spo2)) {
    if (spo2 <= 85) score += 3
    else if (spo2 <= 90) score += 2
    else if (spo2 <= 94) score += 1
  }

  // Conscious level (from nurse notes or urgency)
  const urgency = (vitals.urgency || '').toLowerCase()
  if (urgency === 'emergency') score += 2

  return score
}

// ---------------------------------------------------------------------
// MEWS risk level
// ---------------------------------------------------------------------
export function mewsRiskLevel(score) {
  if (score >= 7) return { level: 'critical', label: 'CRITICAL — escalate to ICU', color: 'var(--danger)' }
  if (score >= 5) return { level: 'urgent', label: 'URGENT — call doctor immediately', color: 'var(--danger)' }
  if (score >= 3) return { level: 'warning', label: 'WARNING — increase monitoring', color: 'var(--gold)' }
  return { level: 'stable', label: 'Stable', color: 'var(--success)' }
}

// ---------------------------------------------------------------------
// generateHandoverSummary — the main function
// ---------------------------------------------------------------------
// Inputs:
//   { vitals, labOrders, labTests, patients, vitalsAlerts, handoverTasks }
//
// Returns:
//   {
//     criticalPatients: [{ patient, reason, mewsScore, riskLevel }],
//     pendingLabs: [{ patient, test, status, ordered_at }],
//     abnormalResults: [{ patient, test, result, is_abnormal }],
//     pendingDischarges: [{ patient, queue_status }],
//     unresolvedTasks: [{ task, status }],
//     stats: { totalCritical, totalPendingLabs, totalAbnormal, ... }
//   }
// ---------------------------------------------------------------------
export function generateHandoverSummary({
  vitals = [],
  labOrders = [],
  labTests = [],
  patients = [],
  vitalsAlerts = [],
  handoverTasks = [],
}) {
  const criticalPatients = []
  const pendingLabs = []
  const abnormalResults = []
  const pendingDischarges = []
  const unresolvedTasks = []

  // ---- 1. Critical patients (from vitals alerts + MEWS) ----
  // Get unique patient IDs from vitals alerts
  const alertPatientIds = new Set(
    vitalsAlerts.filter(a => a.severity === 'critical' && a.status === 'active').map(a => a.patient_id)
  )

  // Calculate MEWS for all patients with vitals
  const latestVitalsByPatient = {}
  for (const v of vitals) {
    if (!latestVitalsByPatient[v.patient_id] ||
        new Date(v.recorded_at || v.created_at) > new Date(latestVitalsByPatient[v.patient_id].recorded_at || latestVitalsByPatient[v.patient_id].created_at)) {
      latestVitalsByPatient[v.patient_id] = v
    }
  }

  for (const [patientId, v] of Object.entries(latestVitalsByPatient)) {
    const mewsScore = calculateMEWS(v)
    const risk = mewsRiskLevel(mewsScore)
    const patient = patients.find(p => p.id === patientId)

    if (risk.level === 'critical' || risk.level === 'urgent' || alertPatientIds.has(patientId)) {
      criticalPatients.push({
        patient_id: patientId,
        patient_name: patient?.full_name || v.patient_name || 'Unknown',
        reason: alertPatientIds.has(patientId) ? 'Active critical alert' : `MEWS: ${mewsScore} (${risk.label})`,
        mewsScore,
        riskLevel: risk.level,
        riskLabel: risk.label,
        riskColor: risk.color,
        latestBP: v.blood_pressure,
        latestHR: v.pulse_rate,
        latestSpO2: v.spo2,
        latestTemp: v.temperature,
        latestRR: v.respiratory_rate,
      })
    }
  }

  // Sort critical patients by MEWS score (highest first)
  criticalPatients.sort((a, b) => b.mewsScore - a.mewsScore)

  // ---- 2. Pending investigations (lab orders not completed) ----
  for (const lab of labOrders) {
    if (lab.status === 'completed' || lab.status === 'cancelled') continue
    const patient = patients.find(p => p.id === lab.patient_id)
    pendingLabs.push({
      patient_id: lab.patient_id,
      patient_name: patient?.full_name || lab.patient_name || 'Unknown',
      test: lab.test_name || lab.test_type || 'Lab order',
      status: lab.status || 'pending',
      ordered_at: lab.created_at,
    })
  }

  // Also check lab_tests table
  for (const lab of labTests) {
    if (lab.status === 'completed' || lab.status === 'cancelled') continue
    // Avoid duplicates — skip if already in pendingLabs for same patient + test
    if (pendingLabs.some(pl => pl.patient_id === lab.patient_id && pl.test === (lab.test_name || lab.test_type))) continue
    const patient = patients.find(p => p.id === lab.patient_id)
    pendingLabs.push({
      patient_id: lab.patient_id,
      patient_name: patient?.full_name || lab.patient_name || 'Unknown',
      test: lab.test_name || lab.test_type || 'Lab test',
      status: lab.status || 'pending',
      ordered_at: lab.created_at,
    })
  }

  // ---- 3. Abnormal lab results ----
  for (const lab of [...labOrders, ...labTests]) {
    if (lab.status !== 'completed') continue
    if (lab.is_abnormal || lab.abnormal_flag) {
      const patient = patients.find(p => p.id === lab.patient_id)
      // Avoid duplicates
      if (abnormalResults.some(ar => ar.patient_id === lab.patient_id && ar.test === (lab.test_name || lab.test_type))) continue
      abnormalResults.push({
        patient_id: lab.patient_id,
        patient_name: patient?.full_name || lab.patient_name || 'Unknown',
        test: lab.test_name || lab.test_type || 'Lab test',
        result: lab.result,
        is_abnormal: true,
      })
    }
  }

  // ---- 4. Pending discharges ----
  for (const p of patients) {
    if (p.queue_status === 'discharged' && !p.discharge_summary) {
      pendingDischarges.push({
        patient_id: p.id,
        patient_name: p.full_name,
        queue_status: p.queue_status,
        hospital_number: p.hospital_number,
      })
    }
    // Also check patients who are ready for discharge (in_lab, in_pharmacy)
    if ((p.queue_status === 'in_lab' || p.queue_status === 'in_pharmacy') && p.queue_updated_at) {
      const hoursSinceUpdate = (Date.now() - new Date(p.queue_updated_at).getTime()) / (1000 * 60 * 60)
      if (hoursSinceUpdate > 4) { // patient has been waiting >4 hours
        pendingDischarges.push({
          patient_id: p.id,
          patient_name: p.full_name,
          queue_status: p.queue_status,
          hours_waiting: Math.round(hoursSinceUpdate),
          note: `Waiting ${Math.round(hoursSinceUpdate)}h — may be ready for discharge`,
        })
      }
    }
  }

  // ---- 5. Unresolved tasks from previous handovers ----
  for (const task of handoverTasks) {
    if (task.status === 'pending' || task.status === 'in_progress') {
      unresolvedTasks.push({
        id: task.id,
        task: task.description || task.title || 'Task',
        patient_id: task.patient_id,
        status: task.status,
        priority: task.priority || 'routine',
      })
    }
  }

  // ---- Summary stats ----
  const stats = {
    totalCritical: criticalPatients.length,
    totalPendingLabs: pendingLabs.length,
    totalAbnormal: abnormalResults.length,
    totalPendingDischarges: pendingDischarges.length,
    totalUnresolvedTasks: unresolvedTasks.length,
  }

  return {
    criticalPatients,
    pendingLabs,
    abnormalResults,
    pendingDischarges,
    unresolvedTasks,
    stats,
    generatedAt: new Date().toISOString(),
  }
}
