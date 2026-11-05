import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import TrashIcon from '../../components/icons/TrashIcon'
import AppIcon from '../../components/icons'
import { formatDate, formatDateTime, getTimezone, calculateAge } from '../../lib/datetime'
import { TagAutocomplete } from '../../components/ClinicalAutocomplete'
import Autocomplete from '../../components/common/Autocomplete'
import LabResultViewer from '../../components/LabResultViewer'
import { writeAudit } from '../../lib/audit'
import { escapeHtml } from '../../lib/escapeHtml'
import { labStage, normalizeLabRow, LAB_STAGE_LABEL } from '../../lib/lab'
import { SYMPTOM_OPTIONS, DIAGNOSIS_OPTIONS, FREQUENCY_OPTIONS, ROUTE_OPTIONS, DEFAULT_TEMPLATES } from '../../lib/clinicalData'
import AdmissionRequestModal from '../../components/AdmissionRequestModal'
import LabTestPicker from '../../components/LabTestPicker'
import { useBillingCatalog, formatMoney } from '../../lib/billingService'
import AiDiagnostics from './AiDiagnostics'
import CodeSuggestionPanel from '../../components/ai/CodeSuggestionPanel'
import VirtualConsultation from '../../components/VirtualConsultation'
import MedicationSafetyAlert from '../../components/MedicationSafetyAlert'
import { checkMedicationSafety } from '../../lib/drugInteractionEngine'

// NEW: Global Medication Reference List (allows searching even if hospital has 0 stock)
const GLOBAL_MEDICATIONS = [
  { id: 'GMED-001', name: 'Ceftriaxone 1g Injection', generic: 'Ceftriaxone', strength: '1g', form: 'Injection', route: 'IV/IM' },
  { id: 'GMED-002', name: 'Ceftriaxone 500mg Injection', generic: 'Ceftriaxone', strength: '500mg', form: 'Injection', route: 'IV/IM' },
  { id: 'GMED-003', name: 'Amoxicillin 500mg Capsule', generic: 'Amoxicillin', strength: '500mg', form: 'Capsule', route: 'Oral' },
  { id: 'GMED-004', name: 'Paracetamol 500mg Tablet', generic: 'Paracetamol', strength: '500mg', form: 'Tablet', route: 'Oral' },
  { id: 'GMED-005', name: 'Artesunate 120mg Injection', generic: 'Artesunate', strength: '120mg', form: 'Injection', route: 'IV' },
  { id: 'GMED-006', name: 'Methyldopa 250mg Tablet', generic: 'Methyldopa', strength: '250mg', form: 'Tablet', route: 'Oral' },
  // Can be expanded or moved to a database table later
]

// Matches the hospital's printed Laboratory Test Request Form categories,
// so a doctor can select several tests at once instead of one at a time.
const LAB_TEST_CATEGORIES = [
  { category: 'Haematology', tests: ['Full Blood Count (FBC)', 'ESR', 'Peripheral Smear', 'Bleeding Time', 'Clotting Time', 'PCV/Haematocrit', 'Blood Group & Rh'] },
  { category: 'Chemistry', tests: ['Fasting Blood Sugar', 'Random Blood Sugar', 'HbA1c', 'Urea', 'Creatinine', 'Uric Acid', 'Lipid Profile', 'Liver Function Test', 'Electrolytes (Na, K, Cl, HCO3)', 'Calcium', 'Phosphorus'] },
  { category: 'Serology / Immunology', tests: ['HIV 1 & 2', 'Hepatitis B (HBsAg)', 'Hepatitis C (HCV)', 'VDRL', 'Widal Test', 'ASO Titre', 'CRP', 'RF Factor', 'Malaria Parasite', 'Typhoid IgM / IgG', 'Dengue NS1 / IgM / IgG'] },
  { category: 'Microbiology', tests: ['Urine MCS', 'Stool MCS', 'Sputum MCS', 'Wound Swab MCS', 'Blood Culture', 'High Vaginal Swab', 'GeneXpert (TB)'] },
  { category: 'Urinalysis', tests: ['Urinalysis (Routine)', 'Pregnancy Test (Urine)', 'Microalbumin'] },
  { category: 'Parasitology', tests: ['Stool Ova & Parasite', 'Malaria Parasite (Stool/Blood)'] },
]

const EMPTY_MED = { 
  inventory_item_id: null, global_med_id: null, drugName: '', dose: '', route: '', frequency: '', frequencyCustom: '', 
  duration: '', quantity: '', instructions: '', stock_at_prescription: 0, 
  availability_status: null, accepted_unavailable: false 
}

export default function DoctorWorkbench() {
  const { profile, hospital } = useAuth()
  const timezone = getTimezone(hospital)
  const { records: patients, loading: loadingPatients, updateRecord: updatePatient, syncFromServer: syncPatients } = useOfflineTable('patients', hospital?.id)
  const { records: vitals, loading: loadingVitals, updateRecord: updateVitals, syncFromServer: syncVitals } = useOfflineTable('patient_vitals', hospital?.id)
  const { records: labOrders, loading: loadingLabOrders, addRecord: addLabOrder, syncFromServer: syncLabOrders } = useOfflineTable('lab_orders', hospital?.id)
  const { records: labTests, syncFromServer: syncLabTests } = useOfflineTable('lab_tests', hospital?.id)
  const { records: prescriptions, loading: loadingPrescriptions, addRecord: addPrescription, updateRecord: updatePrescription, deleteRecord: deletePrescription, syncFromServer: syncPrescriptions } = useOfflineTable('prescriptions', hospital?.id)
  const { records: inventoryItems } = useOfflineTable('inventory_items', hospital?.id)
  const { records: hospitalTemplates, addRecord: addTemplate } = useOfflineTable('prescription_templates', hospital?.id)
  const { records: admissionRequests, addRecord: addAdmissionRequest } = useOfflineTable('admission_requests', hospital?.id)
  const { addRecord: addTimelineEvent } = useOfflineTable('admission_timeline_events', hospital?.id)
  const { addRecord: addPharmacyOrder } = useOfflineTable('pharmacy_orders', hospital?.id)
  
  const [showAdmissionModal, setShowAdmissionModal] = useState(false)
  const [showAiDiagnostics, setShowAiDiagnostics] = useState(false)
  const [showCodePanel, setShowCodePanel] = useState(false)
  const [showVirtualConsult, setShowVirtualConsult] = useState(false)
  const [virtualConsultData, setVirtualConsultData] = useState(null)
  const [medicationAlerts, setMedicationAlerts] = useState(null)
  const loading = loadingPatients || loadingVitals || loadingLabOrders || loadingPrescriptions
  const [activeVitalsId, setActiveVitalsId] = useState(null)
  const [toast, setToast] = useState(null)
  const [completing, setCompleting] = useState(false)

  const [chiefComplaints, setChiefComplaints] = useState(() => {
    try { return sessionStorage.getItem('dw_chiefComplaints') || '' } catch { return '' }
  })
  const [historyPresenting, setHistoryPresenting] = useState(() => {
    try { return sessionStorage.getItem('dw_historyPresenting') || '' } catch { return '' }
  })
  const [pastMedicalHistory, setPastMedicalHistory] = useState(() => {
    try { return sessionStorage.getItem('dw_pastMedicalHistory') || '' } catch { return '' }
  })
  const [pastSurgicalHistory, setPastSurgicalHistory] = useState(() => {
    try { return sessionStorage.getItem('dw_pastSurgicalHistory') || '' } catch { return '' }
  })
  const [drugHistory, setDrugHistory] = useState(() => {
    try { return sessionStorage.getItem('dw_drugHistory') || '' } catch { return '' }
  })
  const [allergyHistory, setAllergyHistory] = useState(() => {
    try { return sessionStorage.getItem('dw_allergyHistory') || '' } catch { return '' }
  })
  const [familySocialHistory, setFamilySocialHistory] = useState(() => {
    try { return sessionStorage.getItem('dw_familySocialHistory') || '' } catch { return '' }
  })
  const [examinationFindings, setExaminationFindings] = useState(() => {
    try { return sessionStorage.getItem('dw_examinationFindings') || '' } catch { return '' }
  })
  const [clinicalNotes, setClinicalNotes] = useState(() => {
    try { return sessionStorage.getItem('dw_clinicalNotes') || '' } catch { return '' }
  })
  const [treatmentPlan, setTreatmentPlan] = useState(() => {
    try { return sessionStorage.getItem('dw_treatmentPlan') || '' } catch { return '' }
  })
  const [followUpNotes, setFollowUpNotes] = useState(() => {
    try { return sessionStorage.getItem('dw_followUpNotes') || '' } catch { return '' }
  })
  const [symptoms, setSymptoms] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('dw_symptoms') || '[]') } catch { return [] }
  })
  const [diagnoses, setDiagnoses] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('dw_diagnoses') || '[]') } catch { return [] }
  })

  const [selectedLabTests, setSelectedLabTests] = useState([])
  const [otherLabTests, setOtherLabTests] = useState('')
  const [labPriority, setLabPriority] = useState('routine')
  const [labNotes, setLabNotes] = useState('')
  const [savingLabOrder, setSavingLabOrder] = useState(false)
  // ---- LabTestPicker modal state (Section 2 upgrade) ----
  // Replaces the hardcoded LAB_TEST_CATEGORIES checkbox grid with a
  // catalog-driven multi-select modal. Resolves prices + HMO split per
  // test using the same useBillingCatalog hook as the cashier.
  const [showLabPicker, setShowLabPicker] = useState(false)
  const [pendingLabSelection, setPendingLabSelection] = useState([])
  const { catalog, priceLists, priceListItems, contracts } = useBillingCatalog()

  const [medications, setMedications] = useState([])
  const [medBuilder, setMedBuilder] = useState(EMPTY_MED)
  const [editingMedLocalId, setEditingMedLocalId] = useState(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [savingPrescriptions, setSavingPrescriptions] = useState(false)

  // ---- Drug Interaction Engine reference data ----
  // These are shared reference tables (not hospital-scoped) — loaded
  // once per session and cached in IndexedDB via useOfflineTable.
  // Pass null as hospitalId since they're reference data.
  const { records: drugInteractionData } = useOfflineTable('drug_interactions', null)
  const { records: allergyClassData } = useOfflineTable('drug_allergy_classes', null)

  // Lab Result Viewer (shared with the Laboratory module)
  const [viewRow, setViewRow] = useState(null)
  const [viewHistory, setViewHistory] = useState([])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3600) }

  // Realtime: the instant the laboratory completes a result for THIS
  // hospital, re-sync and — if it belongs to the selected patient —
  // announce it. UPDATE events need migration 008 (replica identity
  // full + publication); without it the 30s poll below still delivers.
  useRealtimeAlert('lab_orders', hospital?.id, (row) => {
    syncLabOrders()
    if (labStage(row.status) === 'completed' && row.patient_id === activePatient?.id) {
      showToast(`Lab result ready: ${row.test_name} — ${row.patient_name}`)
    }
  }, { event: 'UPDATE' })
  useRealtimeAlert('lab_tests', hospital?.id, (row) => {
    syncLabTests()
    if (labStage(row.status) === 'completed' && row.patient_id === activePatient?.id) {
      showToast(`Lab result ready: ${row.test_name} — ${row.patient_name}`)
    }
  }, { event: 'UPDATE' })

  // ---- Realtime: nurse just recorded vitals OR sent patient to doctor ----
  // INSERT fires when nurse saves a new vitals record (new encounter).
  // UPDATE fires when nurse updates the vitals record (e.g. marks it
  // "sent to doctor" / changes queue_status). Either way the doctor's
  // patient list must refresh — previously they had to F5.
  useRealtimeAlert('patient_vitals', hospital?.id, (row) => {
    syncVitals()
    syncPatients()  // queue_status may have changed on the patient row too
    // Only toast if this is an actual queue entry — NOT a "recorded"
    // vitals entry from the Patient Profile (which has status='recorded').
    // PatientProfile.jsx's handleSaveVitals uses status='recorded' to
    // avoid auto-queueing; only Nursing triage + the explicit "Send to
    // Doctor" button use status='waiting'.
    if (row.status === 'waiting' && row.patient_name) {
      showToast(`New vitals ready: ${row.patient_name}`)
    }
  }, { event: 'INSERT' })
  useRealtimeAlert('patient_vitals', hospital?.id, (row) => {
    syncVitals()
    syncPatients()
    // Only toast if the patient was just sent to the doctor queue
    // (status changed to "waiting" via the "Send to Doctor" button,
    // OR queue_status === "with_doctor")
    if (row.queue_status === 'with_doctor' || row.status === 'sent_to_doctor' || row.status === 'waiting') {
      showToast(`Patient sent to your queue: ${row.patient_name || 'a patient'}`)
    }
  }, { event: 'UPDATE' })

  // ---- Realtime: prescription changes (nurse cancelled/added) -----------
  useRealtimeAlert('prescriptions', hospital?.id, (row) => {
    syncPrescriptions()
  }, { event: 'INSERT' })
  useRealtimeAlert('prescriptions', hospital?.id, (row) => {
    syncPrescriptions()
  }, { event: 'UPDATE' })

  // ---- Realtime: patient queue status changes ---------------------------
  // When nurse moves a patient through the queue (waiting → triaged →
  // with_doctor), this refreshes the doctor's patient list instantly.
  useRealtimeAlert('patients', hospital?.id, (row) => {
    syncPatients()
  }, { event: 'UPDATE' })

  // ---- Auto-save consultation draft to sessionStorage ----
  // This prevents data loss when the doctor accidentally clicks away,
  // the system goes to sleep, or the browser tab is refreshed.
  // The draft is cleared when the consultation is completed (in handleCompleteConsultation)
  // or when the doctor opens a new patient (in openConsultation).
  useEffect(() => {
    const fields = {
      dw_chiefComplaints: chiefComplaints,
      dw_historyPresenting: historyPresenting,
      dw_pastMedicalHistory: pastMedicalHistory,
      dw_pastSurgicalHistory: pastSurgicalHistory,
      dw_drugHistory: drugHistory,
      dw_allergyHistory: allergyHistory,
      dw_familySocialHistory: familySocialHistory,
      dw_examinationFindings: examinationFindings,
      dw_clinicalNotes: clinicalNotes,
      dw_treatmentPlan: treatmentPlan,
      dw_followUpNotes: followUpNotes,
    }
    try {
      Object.entries(fields).forEach(([k, v]) => sessionStorage.setItem(k, v || ''))
      sessionStorage.setItem('dw_symptoms', JSON.stringify(symptoms || []))
      sessionStorage.setItem('dw_diagnoses', JSON.stringify(diagnoses || []))
    } catch {}
  }, [chiefComplaints, historyPresenting, pastMedicalHistory, pastSurgicalHistory, drugHistory, allergyHistory, familySocialHistory, examinationFindings, clinicalNotes, treatmentPlan, followUpNotes, symptoms, diagnoses])

  // ---- Safety net when realtime is unavailable ----
  // flaky connection): poll quietly while a consultation is open.
  // Also polls vitals + prescriptions so the doctor's queue refreshes
  // even if the realtime subscription fails.
  useEffect(() => {
    if (!hospital?.id) return
    // Always poll the patient + vitals lists while DoctorWorkbench is open
    const id = setInterval(() => {
      syncPatients()
      syncVitals()
      syncPrescriptions()
      // Only sync labs while a consultation is active (heavier query)
      if (activeVitalsId) {
        syncLabOrders()
        syncLabTests()
      }
    }, 30000)  // 30s — same cadence as before, just expanded scope
    return () => clearInterval(id)
  }, [activeVitalsId, hospital?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // NEW: Drug options = Hospital Inventory first, then the global
  // reference list (so doctors can prescribe even with 0 stock).
  // Filtering happens inside the shared Autocomplete; the option's right
  // slot carries live stock so similar names stay distinguishable.
  const drugOptions = useMemo(() => {
    const map = new Map()
    const push = (key, opt) => { if (!map.has(key)) map.set(key, opt) }

    inventoryItems.forEach(it => {
      if (String(it.category).toLowerCase() !== 'drug') return
      push(String(it.name).toLowerCase(), {
        id: `inv-${it.id}`, inventoryId: it.id, globalMedId: null,
        label: it.name, generic: it.generic_name || 'Generic',
        strength: it.strength || '', form: it.dosage_form || '', route: it.route || '',
        stock: Number(it.quantity || 0),
      })
    })

    GLOBAL_MEDICATIONS.forEach(gm => {
      const hospMatch = inventoryItems.find(it =>
        String(it.name).toLowerCase() === gm.name.toLowerCase() && String(it.category).toLowerCase() === 'drug')
      push(gm.name.toLowerCase(), {
        id: `gmed-${gm.id}`, inventoryId: hospMatch?.id || null, globalMedId: gm.id,
        label: gm.name, generic: gm.generic, strength: gm.strength, form: gm.form, route: gm.route,
        stock: hospMatch ? Number(hospMatch.quantity || 0) : 0,
      })
    })

    return [...map.values()].map(o => ({
      ...o,
      sublabel: [o.generic, o.form, o.strength].filter(Boolean).join(' · '),
      right: o.stock > 0 ? `In stock: ${o.stock}` : 'Out of stock',
      rightTone: o.stock > 0 ? 'good' : 'bad',
    }))
  }, [inventoryItems])

  function selectDrug(item) {
    setMedBuilder(b => ({
      ...b,
      inventory_item_id: item.inventoryId ?? null,
      global_med_id: item.globalMedId ?? null,
      drugName: item.label,
      dose: item.strength || b.dose,
      route: item.route || item.form || b.route,
      stock_at_prescription: item.stock || 0,
      availability_status: (item.stock || 0) > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
      accepted_unavailable: false
    }))
  }

  const queue = vitals.filter(v => v.status === 'waiting').sort((a, b) => {
    const order = { Emergency: 0, Urgent: 1, Routine: 2 }
    const urgencyDiff = (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3)
    if (urgencyDiff !== 0) return urgencyDiff
    return new Date(a.recorded_at || a.created_at) - new Date(b.recorded_at || b.created_at)
  })

  const activeVitals = vitals.find(v => v.id === activeVitalsId) || null
  const activePatient = activeVitals ? patients.find(p => p.id === activeVitals.patient_id) || null : null
  const activePatientLabOrders = activeVitals ? labOrders.filter(o => o.patient_vitals_id === activeVitals.id) : []

  // NEW: Patient age, shown to the doctor throughout the consultation.
  // `age` is stored directly on the patient record at registration, but
  // some older/imported records may only have `date_of_birth` — so we
  // fall back to calculating it from that when `age` itself is empty.
  // Returns something like "34y · Male", or '' when nothing is known.
  function patientMeta(p) {
    if (!p) return ''
    const age = p.age ?? (p.date_of_birth ? calculateAge(p.date_of_birth) : null)
    const parts = []
    if (age !== null && age !== undefined && age !== '') parts.push(`${age}y`)
    if (p.gender) parts.push(p.gender)
    return parts.join(' · ')
  }

  // ---- ANC info for the active patient (Section 4 enhancement) ----
  // If the patient is an ANC registrant, compute gestational age +
  // trimester + days-to-EDD from their stored anc_lmp / anc_edd so the
  // doctor sees the obstetric context at the top of the workbench.
  // Returns null for non-ANC patients.
  function ancInfo(p) {
    if (!p || p.category !== 'anc' || !p.anc_lmp) return null
    const lmp = new Date(p.anc_lmp + 'T12:00:00')
    if (isNaN(lmp.getTime())) return null
    const now = new Date()
    const daysPregnant = Math.floor((now - lmp) / (24 * 60 * 60 * 1000))
    const weeksPregnant = Math.floor(daysPregnant / 7)
    const trimester = weeksPregnant < 13 ? 1 : weeksPregnant < 28 ? 2 : 3
    const edd = p.anc_edd ? new Date(p.anc_edd + 'T12:00:00') : null
    const daysToEdd = edd ? Math.floor((edd - now) / (24 * 60 * 60 * 1000)) : null
    return {
      lmp: p.anc_lmp,
      edd: p.anc_edd,
      weeksPregnant,
      trimester,
      daysToEdd,
      isOverdue: daysToEdd !== null && daysToEdd < 0,
    }
  }

  // Laboratory results for the selected patient — across ALL encounters,
  // from both doctor orders (lab_orders) and lab-raised requests
  // (lab_tests). Completed results surface on top; in-progress orders
  // show the pipeline stage so the doctor knows what is pending.
  const patientLabRows = useMemo(() => {
    if (!activePatient) return { completed: [], active: [] }
    const rows = [
      ...labOrders.filter(r => r.patient_id === activePatient.id).map(r => normalizeLabRow(r, 'doctor')),
      ...labTests.filter(r => r.patient_id === activePatient.id).map(r => normalizeLabRow(r, 'lab')),
    ].filter(Boolean)
    const completed = rows.filter(r => r.stage === 'completed')
      .sort((a, b) => new Date(b.resultedAt || 0) - new Date(a.resultedAt || 0))
    const active = rows.filter(r => r.stage !== 'completed' && r.stage !== 'cancelled')
      .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0))
    return { completed, active }
  }, [activePatient, labOrders, labTests])

  // Abnormal results lead the list — the doctor sees the red flags first.
  const sortedCompletedResults = useMemo(
    () => [...patientLabRows.completed].sort((a, b) => {
      const rank = f => (f === 'critical' ? 0 : f === 'high' || f === 'low' ? 1 : 2)
      const abn = rank(a.abnormalFlag) - rank(b.abnormalFlag)
      if (abn !== 0) return abn
      return new Date(b.resultedAt || 0) - new Date(a.resultedAt || 0)
    }),
    [patientLabRows.completed]
  )

  function openLabViewer(row){
    const patient = patients.find(p => p.id === row.patientId) || null
    const history = patientLabRows.completed.filter(r => r.id !== row.id && r.testName === row.testName)
    setViewHistory(history)
    setViewRow({ ...row, patient })
  }

  const allTemplates = [...DEFAULT_TEMPLATES, ...hospitalTemplates.map(t => ({ ...t, builtin: false }))]

  function openConsultation(v) {
    setActiveVitalsId(v.id)
    setChiefComplaints(v.chief_complaints || ''); setHistoryPresenting(v.history_presenting_complaint || '')
    setPastMedicalHistory(v.past_medical_history || ''); setPastSurgicalHistory(v.past_surgical_history || '')
    setDrugHistory(v.drug_history || ''); setAllergyHistory(v.allergy_history || '')
    setFamilySocialHistory(v.family_social_history || ''); setExaminationFindings(v.examination_findings || v.observations || '')
    setClinicalNotes(v.clinical_notes || ''); setTreatmentPlan(v.treatment_plan || ''); setFollowUpNotes(v.follow_up_notes || '')
    setSymptoms(Array.isArray(v.symptoms) ? v.symptoms : []); setDiagnoses(Array.isArray(v.diagnoses) ? v.diagnoses : [])
    
    const existing = prescriptions.filter(p => p.patient_vitals_id === v.id && p.status !== 'cancelled').map(p => ({
      localId: p.id, dbId: p.id, inventory_item_id: p.inventory_item_id, drugName: p.drug_name, dose: p.dosage, 
      route: p.route || '', frequency: p.frequency || '', frequencyCustom: '', duration: p.duration || '', 
      quantity: p.quantity || '', instructions: p.instructions || '', stock_at_prescription: p.stock_at_prescription || 0,
      availability_status: p.availability_status || 'AVAILABLE', accepted_unavailable: p.availability_status === 'UNAVAILABLE'
    }))
    setMedications(existing); resetMedBuilder(); setShowPreview(false); setSelectedTemplateId('')
  }

  function clearWorkbench() {
    setActiveVitalsId(null); setChiefComplaints(''); setHistoryPresenting(''); setPastMedicalHistory(''); setPastSurgicalHistory('')
    setDrugHistory(''); setAllergyHistory(''); setFamilySocialHistory(''); setExaminationFindings(''); setClinicalNotes('')
    setTreatmentPlan(''); setFollowUpNotes(''); setSymptoms([]); setDiagnoses([]); setSelectedLabTests([]); setOtherLabTests(''); setLabPriority('routine'); setLabNotes('')
    setMedications([]); resetMedBuilder(); setSelectedTemplateId(''); setShowPreview(false)
    // Clear the auto-saved draft from sessionStorage so the next consultation starts fresh
    try {
      ['dw_chiefComplaints','dw_historyPresenting','dw_pastMedicalHistory','dw_pastSurgicalHistory','dw_drugHistory','dw_allergyHistory','dw_familySocialHistory','dw_examinationFindings','dw_clinicalNotes','dw_treatmentPlan','dw_followUpNotes','dw_symptoms','dw_diagnoses'].forEach(k => sessionStorage.removeItem(k))
    } catch {}
  }

  function resetMedBuilder() { setMedBuilder(EMPTY_MED); setEditingMedLocalId(null) }

  function toggleLabTest(name) {
    setSelectedLabTests(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name])
  }

  async function handleSendLabOrders(e) {
    e.preventDefault()
    // ---- Build the test list from either source ----
    // 1. pendingLabSelection: rich test objects from the new LabTestPicker
    //    modal (each has { id, name, code, price, patientAmount, hmoAmount,
    //    sample_type, requires_pre_auth, contractId, ... })
    // 2. selectedLabTests: legacy bare test-name strings (kept for
    //    backward compat — the old checkbox grid is gone but the state
    //    is still wired in case any external code sets it)
    // 3. otherLabTests: comma-separated free-text extras
    const extras = otherLabTests.split(',').map(s => s.trim()).filter(Boolean)
    const catalogTests = pendingLabSelection.map(t => t.name)
    const allTests = [...catalogTests, ...extras]
    if (!activeVitals || allTests.length === 0) return
    if (!hospital || !profile) return showToast('Still loading your account...')
    setSavingLabOrder(true)
    try {
      // Every test in this submission shares one request_group id, so
      // Laboratory can treat them as a single request even though each
      // test is still its own row (needed for individual result entry).
      const requestGroup = crypto.randomUUID()

      // Insert each lab order row. Catalog-picked tests carry the
      // resolved price + HMO split + sample type + pre-auth requirement
      // so the lab and cashier can see the expected cost without
      // re-resolving. Free-text extras (otherLabTests) only carry the
      // test name — the lab can price them at result-entry time.
      for (let i = 0; i < catalogTests.length; i++) {
        const testName = catalogTests[i]
        const t = pendingLabSelection[i]
        await addLabOrder({
          patient_vitals_id: activeVitals.id,
          patient_id: activePatient?.id || activeVitals.patient_id,
          patient_name: activePatient?.full_name || 'Unknown',
          test_name: testName,
          test_code: t?.code || null,
          sample_type: t?.sample_type || null,
          notes: labNotes || null,
          priority: labPriority,
          request_group: requestGroup,
          status: 'requested',
          requested_at: new Date().toISOString(),
          created_by: profile.id,
          // NEW: capture the resolved price + HMO split so the lab and
          // cashier can see the expected cost without re-resolving.
          estimated_price: t?.price || null,
          hmo_amount: t?.hmoAmount || 0,
          patient_amount: t?.patientAmount || t?.price || 0,
          hmo_contract_id: t?.contractId || null,
          requires_pre_auth: t?.requiresPreAuth || false,
        })
      }
      // Free-text extras — no catalog entry, no price resolution
      for (const testName of extras) {
        await addLabOrder({
          patient_vitals_id: activeVitals.id,
          patient_id: activePatient?.id || activeVitals.patient_id,
          patient_name: activePatient?.full_name || 'Unknown',
          test_name: testName,
          notes: labNotes || null,
          priority: labPriority,
          request_group: requestGroup,
          status: 'requested',
          requested_at: new Date().toISOString(),
          created_by: profile.id,
        })
      }
      writeAudit({
        hospitalId: hospital.id, actor: profile, action: 'lab_order.sent',
        entityType: 'lab_order', entityId: requestGroup, patientId: activePatient?.id || activeVitals.patient_id,
        summary: `${allTests.length} lab test(s) ordered for ${activePatient?.full_name || 'patient'} (${labPriority})`,
        metadata: { tests: allTests, priority: labPriority, request_group: requestGroup },
      })
      // Clear state — picker selection + free-text extras + notes
      setPendingLabSelection([])
      setSelectedLabTests([])
      setOtherLabTests('')
      setLabPriority('routine')
      setLabNotes('')
      setShowLabPicker(false)
      showToast(`${allTests.length} lab test${allTests.length === 1 ? '' : 's'} sent to laboratory`)
    } catch (err) { showToast(err.message) } finally { setSavingLabOrder(false) }
  }

  // Called by LabTestPicker when the doctor clicks "Confirm"
  function handleConfirmLabTests({ tests, priority, clinicalNotes }) {
    setPendingLabSelection(tests)
    setLabPriority(priority)
    setLabNotes(clinicalNotes)
    setShowLabPicker(false)
    // Auto-scroll the lab panel into view so the doctor sees the selection
    // and can click "Send Lab Order" to commit.
    setTimeout(() => {
      const labPanel = document.querySelector('[data-lab-panel]')
      if (labPanel) labPanel.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
  }

  function handleAddOrUpdateMedToDraft() {
    if (!medBuilder.drugName.trim() || !medBuilder.dose.trim()) return showToast('Drug name and dose are required')
    if (medBuilder.availability_status === 'UNAVAILABLE' && !medBuilder.accepted_unavailable) return showToast('Please choose whether to continue prescribing or remove the unavailable medication.')

    // ---- DRUG INTERACTION ENGINE ----
    // Run safety checks before adding the medication to the prescription.
    // If alerts are found, show them in the MedicationSafetyAlert component.
    // The doctor can override (with a reason for hard alerts) or cancel.
    if (activePatient && !medicationAlerts) {
      const patientCtx = {
        patient: activePatient,
        allergyHistory,
        pastMedicalHistory,
        familySocialHistory,
        drugHistory,
      }
      const alerts = checkMedicationSafety({
        drugName: medBuilder.drugName,
        patientCtx,
        activeMeds: medications,
        labOrders: activePatientLabOrders,
        drugInteractions: drugInteractionData || [],
        allergyClasses: allergyClassData || [],
      })
      if (alerts.length > 0) {
        setMedicationAlerts(alerts)
        return // Don't add the medication yet — wait for the doctor's decision
      }
    }

    // If we get here (no alerts or override was processed), add the medication
    if (editingMedLocalId) {
      setMedications(meds => meds.map(m => m.localId === editingMedLocalId ? { ...m, ...medBuilder, localId: m.localId, dbId: m.dbId } : m))
    } else {
      setMedications(meds => [...meds, { ...medBuilder, localId: crypto.randomUUID(), dbId: null }])
    }
    resetMedBuilder()
  }

  // Handle the doctor's override decision from MedicationSafetyAlert
  async function handleMedicationOverride(alerts, reason) {
    // Log all alerts to the medication_safety_alerts table
    for (const alert of alerts) {
      try {
        await supabase.from('medication_safety_alerts').insert({
          hospital_id: hospital.id,
          patient_id: activePatient.id,
          consultation_id: activeVitals?.id || null,
          alert_type: alert.type,
          severity: alert.severity,
          drug_name: alert.drugName,
          interacting_with: alert.interactingWith,
          mechanism: alert.mechanism,
          recommendation: alert.recommendation,
          was_overridden: true,
          override_reason: reason,
          overridden_by: profile.id,
          overridden_at: new Date().toISOString(),
        })
      } catch (e) {
        console.warn('Could not log medication safety alert:', e.message)
      }
    }

    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'medication.override',
      entityType: 'patient_vitals', entityId: activeVitals?.id || null,
      patientId: activePatient?.id,
      summary: `Overrode ${alerts.length} medication safety alert(s) for ${medBuilder.drugName}: ${reason}`,
      metadata: {
        drug_name: medBuilder.drugName,
        alert_count: alerts.length,
        alert_types: alerts.map(a => a.type),
        override_reason: reason,
      },
    })

    // Clear the alerts + add the medication
    setMedicationAlerts(null)
    if (editingMedLocalId) {
      setMedications(meds => meds.map(m => m.localId === editingMedLocalId ? { ...m, ...medBuilder, localId: m.localId, dbId: m.dbId } : m))
    } else {
      setMedications(meds => [...meds, { ...medBuilder, localId: crypto.randomUUID(), dbId: null }])
    }
    resetMedBuilder()
  }

  function handleMedicationAbort() {
    setMedicationAlerts(null)
    showToast('Medication not added — safety alert not overridden')
  }

  function getActiveAdmissionRequest(patientId) {
    if (!patientId) return null
    return admissionRequests.filter(r => r.patient_id === patientId && r.status !== 'cancelled' && r.status !== 'rejected').sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null
  }

  async function handleSubmitAdmissionRequest(payload) {
    if (!activePatient || !hospital || !profile) return showToast('Still loading your account...')
    const request = await addAdmissionRequest({ patient_id: activePatient.id, doctor_id: profile.id, doctor_name: profile.full_name || null, status: 'pending', ...payload })
    try { await addTimelineEvent({ patient_id: activePatient.id, admission_request_id: request?.id || null, event_type: 'recommended', description: `Dr. ${profile.full_name || 'Unknown'} recommended admission${payload.diagnosis ? ` — ${payload.diagnosis}` : ''}.`, created_by: profile.id }) } catch {}
    setShowAdmissionModal(false); showToast('Admission recommendation submitted.')
  }

  function handleEditMed(m) {
    setMedBuilder({ ...m }); setEditingMedLocalId(m.localId)
  }

  async function handleRemoveMed(m) {
    if (m.dbId) { if (!confirm(`Remove ${m.drugName}?`)) return; await deletePrescription(m.dbId) }
    setMedications(meds => meds.filter(x => x.localId !== m.localId))
    if (editingMedLocalId === m.localId) resetMedBuilder()
  }

  function handleApplyTemplate() {
    const template = allTemplates.find(t => t.id === selectedTemplateId)
    if (!template) return
    const loaded = template.medications.map(med => ({ localId: crypto.randomUUID(), dbId: null, inventory_item_id: null, drugName: med.drug_name, dose: med.dose, route: med.route || '', frequency: med.frequency || '', frequencyCustom: '', duration: med.duration || '', quantity: med.quantity || '', instructions: med.instructions || '', stock_at_prescription: 0, availability_status: 'AVAILABLE', accepted_unavailable: false }))
    setMedications(meds => [...meds, ...loaded]); setSelectedTemplateId(''); showToast(`Loaded "${template.name}"`)
  }

  async function handleSaveAsTemplate() {
    if (medications.length === 0) return
    const name = prompt('Template name:')
    if (!name) return
    const category = prompt('Category (optional):') || null
    try {
      await addTemplate({ name, category, medications: medications.map(m => ({ drug_name: m.drugName, dose: m.dose, route: m.route, frequency: m.frequency === 'Custom' ? m.frequencyCustom : m.frequency, duration: m.duration, quantity: m.quantity, instructions: m.instructions })), created_by: profile?.id })
      showToast('Template saved')
    } catch (err) { showToast(err.message) }
  }

  async function handleSavePrescriptions(status) {
    if (!activeVitals || medications.length === 0) return
    if (!hospital || !profile) return showToast('Still loading account...')
    
    const unaccepted = medications.find(m => m.availability_status === 'UNAVAILABLE' && !m.accepted_unavailable)
    if (unaccepted) return showToast('Some medications are unavailable. Please accept or remove them first.')

    setSavingPrescriptions(true)
    try {
      const updated = []
      for (const m of medications) {
        const payload = {
          patient_vitals_id: activeVitals.id, patient_id: activeVitals.patient_id, patient_name: activePatient?.full_name || 'Unknown',
          encounter_id: activeVitals.id, doctor_id: profile?.id, inventory_item_id: m.inventory_item_id, drug_name: m.drugName,
          dosage: m.dose, route: m.route || null, frequency: (m.frequency === 'Custom' ? m.frequencyCustom : m.frequency) || null,
          duration: m.duration || null, quantity: m.quantity || null, instructions: m.instructions || null,
          availability_status: m.availability_status || 'AVAILABLE', stock_at_prescription: m.stock_at_prescription || 0,
          status, prescribed_at: new Date().toISOString(), created_by: profile.id
        }
        if (m.dbId) { await updatePrescription(m.dbId, payload); updated.push(m) } 
        else {
          const saved = await addPrescription(payload)
          if (status === 'active' && saved?.id) {
            await addPharmacyOrder({ hospital_id: hospital.id, prescription_id: saved.id, patient_id: activeVitals.patient_id, patient_name: payload.patient_name, encounter_id: activeVitals.id, doctor_id: profile?.id, doctor_name: profile?.full_name, status: 'pending_pharmacy' })
          }
          updated.push({ ...m, dbId: saved?.id || null })
        }
      }
      setMedications(updated)
      if (status === 'active') {
        writeAudit({
          hospitalId: hospital.id, actor: profile, action: 'prescription.finalized',
          entityType: 'prescription', entityId: activeVitals.id, patientId: activeVitals.patient_id,
          summary: `Prescription finalized for ${activePatient?.full_name || 'Unknown'} (${medications.length} medication${medications.length === 1 ? '' : 's'})`,
          metadata: { drugs: medications.map(m => m.drugName) },
        })
      }
      showToast(status === 'draft' ? 'Draft saved' : 'Prescription finalized & sent to Pharmacy')
    } catch (err) { showToast(err.message) } finally { setSavingPrescriptions(false) }
  }

  function handlePrint() {
    if (medications.length === 0) return
    const patientName = activePatient?.full_name || 'Patient'
    const rows = medications.map((m, i) => `<li><strong>${i + 1}. ${escapeHtml(m.drugName)}</strong><br/>${escapeHtml(m.dose)} ${escapeHtml(m.route || '')} ${escapeHtml(m.frequency || '')}${m.duration ? ` for ${escapeHtml(m.duration)}` : ''}.${m.instructions ? `<br/><em>${escapeHtml(m.instructions)}</em>` : ''}</li>`).join('')
    const html = `<html><head><title>Prescription</title><style>body{font-family:sans-serif;padding:32px;color:#111}h1{font-size:18px}.meta{color:#555;font-size:13px;margin-bottom:20px}ol{padding-left:20px}li{margin-bottom:14px}</style></head><body><h1>${escapeHtml(hospital?.name || 'Prescription')}</h1><div class="meta">Patient: ${escapeHtml(patientName)} · Date: ${formatDate(new Date(), getTimezone(hospital))} · Dr: ${escapeHtml(profile?.full_name || '')}</div><ol>${rows}</ol></body></html>`
    const win = window.open('', '_blank'); if (!win) return; win.document.write(html); win.document.close(); win.focus(); win.print()
  }

  async function handleCompleteConsultation() {
    if (!activeVitals) return
    if (!confirm(`Complete consultation for ${activePatient?.full_name}?`)) return
    setCompleting(true)
    try {
      if (medications.length > 0) await handleSavePrescriptions('active')
      const diagnosisSummary = diagnoses.map(d => d.code ? `${d.label} — ${d.code}` : d.label).join('; ')
      await updateVitals(activeVitals.id, {
        status: 'completed', chief_complaints: chiefComplaints || null, history_presenting_complaint: historyPresenting || null,
        past_medical_history: pastMedicalHistory || null, past_surgical_history: pastSurgicalHistory || null, drug_history: drugHistory || null,
        allergy_history: allergyHistory || null, family_social_history: familySocialHistory || null, examination_findings: examinationFindings || null,
        observations: examinationFindings || null, clinical_notes: clinicalNotes || null, treatment_plan: treatmentPlan || null,
        follow_up_notes: followUpNotes || null, symptoms, diagnoses, diagnosis: diagnosisSummary || null,
        completed_at: new Date().toISOString(), completed_by: profile?.id || null,
        // completed_by_name — surfaced on the patient's History tab so the
        // attending doctor is visible without a separate profiles lookup.
        completed_by_name: profile?.full_name || null,
      })
      if (activePatient) {
        const hasLabOrders = activePatientLabOrders.length > 0
        const hasPrescriptions = medications.length > 0
        await updatePatient(activePatient.id, { queue_status: (hasLabOrders || hasPrescriptions) ? 'in_lab' : 'discharged', queue_updated_at: new Date().toISOString() })
      }
      // Audit trail — previously absent, so the consultation-complete action
      // was invisible in the audit log. Now logs every consultation with
      // the diagnosis summary + encounter ID so it can be traced.
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'consultation.completed',
        entityType: 'patient_vitals', entityId: activeVitals.id,
        patientId: activePatient?.id || null,
        summary: `Completed consultation for ${activePatient?.full_name || 'patient'}${diagnosisSummary ? ` — ${diagnosisSummary}` : ''}`,
        metadata: {
          patient_id: activePatient?.id,
          patient_vitals_id: activeVitals.id,
          chief_complaint: chiefComplaints || null,
          diagnosis: diagnosisSummary || null,
          has_prescriptions: medications.length > 0,
          has_lab_orders: activePatientLabOrders.length > 0,
          prescription_count: medications.length,
          lab_order_count: activePatientLabOrders.length,
        },
      })
      showToast('Consultation completed'); clearWorkbench()
    } catch (err) { showToast(err.message) } finally { setCompleting(false) }
  }

  function vitalRow(label, value, unit) {
    return <div><div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div><div style={{ fontSize: 14, fontWeight: 700 }}>{value ? `${value}${unit ? ' ' + unit : ''}` : '—'}</div></div>
  }
  function summaryRow(label, value) {
    return <div style={{ display: 'flex', gap: 12, paddingBottom: 10, borderBottom: '1px solid var(--line-soft)' }}><div style={{ width: 120, color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase' }}>{label}</div><div style={{ flex: 1, fontSize: 13 }}>{value || <span style={{ color: 'var(--muted)' }}>—</span>}</div></div>
  }

  const historySummary = [chiefComplaints && `Chief complaint: ${chiefComplaints}`, historyPresenting && `HPC: ${historyPresenting}`, pastMedicalHistory && `PMH: ${pastMedicalHistory}`, pastSurgicalHistory && `PSH: ${pastSurgicalHistory}`, drugHistory && `Drug Hx: ${drugHistory}`, allergyHistory && `Allergies: ${allergyHistory}`, familySocialHistory && `Family/Social: ${familySocialHistory}`].filter(Boolean).join(' · ')
  return (
    <>
      <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 20, gap: 12 }}>
        <div className="dash-stat-card"><div className="dash-stat-icon" style={{ background: 'rgba(139,124,246,0.14)', color: 'var(--violet)' }}><AppIcon name="users" size={20} /></div><div><div className="dash-stat-label">Waiting for Doctor</div><div className="dash-stat-value">{queue.length}</div><div className="dash-stat-delta" style={{ color: 'var(--gold)' }}>triaged</div></div></div>
        <div className="dash-stat-card"><div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}><AppIcon name="check" size={20} /></div><div><div className="dash-stat-label">Completed</div><div className="dash-stat-value">{vitals.filter(v => v.status === 'completed').length}</div><div className="dash-stat-delta">total</div></div></div>
        <div className="dash-stat-card"><div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}><AppIcon name="clipboard" size={20} /></div><div style={{ flex: 1, minWidth: 0 }}><div className="dash-stat-label">Active Consultation</div><div className="dash-stat-value" style={{ fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePatient?.full_name || 'None'}</div>{activePatient && patientMeta(activePatient) && <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', marginTop: 2 }}>{patientMeta(activePatient)}</div>}<div className="dash-stat-delta">{activeVitals ? 'in progress' : 'select'}</div>{activePatient && (() => { const req = getActiveAdmissionRequest(activePatient.id); if (!req) return <button type="button" className="btn btn-ghost" style={{ width: 'auto', marginTop: 10, padding: '6px 12px', fontSize: 12 }} onClick={() => setShowAdmissionModal(true)}>Recommend Admission</button>; const l = { pending: 'Requested', approved: 'Approved', converted: 'Admitted' }; const c = { pending: 'var(--gold)', approved: 'var(--teal)', converted: 'var(--teal)' }; return <div style={{ marginTop: 10, display: 'inline-block', padding: '5px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 700, color: c[req.status] || 'var(--muted)', background: 'var(--bg-elevated)', border: `1px solid ${c[req.status]}` }}>{l[req.status] || req.status}</div> })()}</div></div>
      </div>

      <div className="dash-row dash-row-2">
        <div className="dash-panel"><div className="dash-panel-head"><div><div className="dash-panel-title">Consultation Queue</div><div className="dash-panel-sub">Triaged patients</div></div></div>{loading ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div> : queue.length === 0 ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No patients waiting.</div> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{queue.map(v => { const p = patients.find(pt => pt.id === v.patient_id); const isActive = activeVitalsId === v.id; return <div key={v.id} role="button" tabIndex={0} aria-label={`Open consultation for ${p?.full_name || v.patient_name}`} onClick={() => openConsultation(v)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConsultation(v) } }} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '10px 14px', borderRadius: 10, background: isActive ? 'var(--teal-soft)' : 'var(--bg-elevated)', border: isActive ? '1px solid var(--teal)' : '1px solid var(--line-soft)' }}><div style={{ minWidth: 0 }}><div style={{ fontWeight: 700, color: isActive ? 'var(--teal)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p?.full_name || v.patient_name}{patientMeta(p) && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>({patientMeta(p)})</span>}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>BP {v.blood_pressure || '—'} · Pulse {v.pulse_rate || '—'}</div></div><span style={{ fontSize: 11, fontWeight: 700, color: v.urgency === 'Emergency' ? 'var(--danger)' : 'var(--gold)', flexShrink: 0 }}>{v.urgency || 'Waiting'}</span></div> })}</div>}</div>
        <div className="dash-panel"><div className="dash-panel-head"><div><div className="dash-panel-title">Recorded Vitals</div><div className="dash-panel-sub">{activePatient ? `${activePatient.full_name}${patientMeta(activePatient) ? ' · ' + patientMeta(activePatient) : ''}` : 'No patient selected'}</div></div></div>{!activeVitals ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Select a patient from the queue.</div> : <><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>{vitalRow('Blood Pressure', activeVitals.blood_pressure)}{vitalRow('Pulse', activeVitals.pulse_rate, 'bpm')}{vitalRow('Temperature', activeVitals.temperature, '°C')}{vitalRow('SpO2', activeVitals.spo2, '%')}{vitalRow('Resp Rate', activeVitals.respiratory_rate, 'bpm')}{vitalRow('Weight', activeVitals.weight, 'kg')}{vitalRow('Height', activeVitals.height, 'cm')}{vitalRow('Urgency', activeVitals.urgency)}</div>{activeVitals.nurse_notes && <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line-soft)', fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>Nurse note: "{activeVitals.nurse_notes}"</div>}</>}</div>
      </div>

      {activeVitals && (
        <>
          {/* ---- ANC banner (Section 4 enhancement) ----
              When the active patient is an ANC registrant, surface their
              obstetric context (LMP, EDD, gestational age, trimester,
              days-to-EDD) above the consultation form so the doctor has
              the pregnancy context immediately visible. */}
          {activePatient && ancInfo(activePatient) && (
            <div style={{
              marginTop: 16, padding: '12px 16px', borderRadius: 10,
              background: 'rgba(232,184,46,0.06)', border: '1px solid rgba(232,184,46,0.25)',
              display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5,
            }}>
              <div style={{ fontWeight: 700, color: 'var(--gold)', letterSpacing: '.02em' }}>
                🤰 ANC Patient
              </div>
              <div><span style={{ color: 'var(--muted)' }}>LMP:</span> <strong style={{ color: 'var(--ivory)' }}>{ancInfo(activePatient).lmp}</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>EDD:</span> <strong style={{ color: 'var(--ivory)' }}>{ancInfo(activePatient).edd || '—'}</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>Gest age:</span> <strong style={{ color: 'var(--ivory)' }}>{ancInfo(activePatient).weeksPregnant}w</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>Trimester:</span> <strong style={{ color: 'var(--ivory)' }}>{ancInfo(activePatient).trimester}</strong></div>
              {ancInfo(activePatient).daysToEdd !== null && (
                <div style={{
                  padding: '3px 10px', borderRadius: 8, fontWeight: 700,
                  background: ancInfo(activePatient).isOverdue ? 'var(--danger-soft)' : ancInfo(activePatient).daysToEdd <= 14 ? 'var(--warning-soft)' : 'rgba(0,199,199,0.10)',
                  color: ancInfo(activePatient).isOverdue ? 'var(--danger)' : ancInfo(activePatient).daysToEdd <= 14 ? 'var(--warning)' : 'var(--teal)',
                }}>
                  {ancInfo(activePatient).isOverdue
                    ? `${Math.abs(ancInfo(activePatient).daysToEdd)} day${Math.abs(ancInfo(activePatient).daysToEdd) === 1 ? '' : 's'} overdue`
                    : `${ancInfo(activePatient).daysToEdd} day${ancInfo(activePatient).daysToEdd === 1 ? '' : 's'} to EDD`}
                </div>
              )}
            </div>
          )}

          <div className="dash-panel" style={{ marginTop: 20 }}>
            <div className="dash-panel-head"><div><div className="dash-panel-title">History & Clinical Notes</div><div className="dash-panel-sub">Consultation record</div></div></div>
            <div className="field"><label>Chief Complaint</label><textarea rows={2} value={chiefComplaints} onChange={e => setChiefComplaints(e.target.value)} placeholder="e.g. Fever and headache for 3 days" /></div>
            <div className="field"><label>History of Presenting Complaint</label><textarea rows={3} value={historyPresenting} onChange={e => setHistoryPresenting(e.target.value)} placeholder="Onset, duration, character, associated symptoms…" /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>Past Medical History</label><textarea rows={2} value={pastMedicalHistory} onChange={e => setPastMedicalHistory(e.target.value)} placeholder="e.g. Hypertension diagnosed 2019" /></div>
              <div className="field"><label>Past Surgical History</label><textarea rows={2} value={pastSurgicalHistory} onChange={e => setPastSurgicalHistory(e.target.value)} placeholder="e.g. Appendectomy 2015" /></div>
              <div className="field"><label>Drug History</label><textarea rows={2} value={drugHistory} onChange={e => setDrugHistory(e.target.value)} placeholder="Current / regular medications" /></div>
              <div className="field"><label>Allergy History</label><textarea rows={2} value={allergyHistory} onChange={e => setAllergyHistory(e.target.value)} placeholder="e.g. Penicillin — rash" /></div>
            </div>
            <div className="field"><label>Family / Social History</label><textarea rows={2} value={familySocialHistory} onChange={e => setFamilySocialHistory(e.target.value)} placeholder="Smoking, alcohol, occupation, family conditions…" /></div>
            <div className="field"><label>Symptoms</label><TagAutocomplete options={SYMPTOM_OPTIONS} value={symptoms} onChange={setSymptoms} placeholder="Type to search symptoms, e.g. fev…" /></div>
            <div className="field"><label>Diagnosis</label><TagAutocomplete options={DIAGNOSIS_OPTIONS} value={diagnoses} onChange={setDiagnoses} placeholder="Type to search diagnoses, e.g. mala…" /></div>
            <div className="field"><label>Examination Findings</label><textarea rows={3} value={examinationFindings} onChange={e => setExaminationFindings(e.target.value)} placeholder="On examination…" /></div>
            <div className="field"><label>Clinical Notes</label><textarea rows={3} value={clinicalNotes} onChange={e => setClinicalNotes(e.target.value)} placeholder="Additional notes…" /></div>
            <div className="field"><label>Treatment Plan</label><textarea rows={2} value={treatmentPlan} onChange={e => setTreatmentPlan(e.target.value)} placeholder="e.g. Antipyretics, rest, review in 3 days" /></div>
            <div className="field"><label>Follow-up Notes</label><textarea rows={2} value={followUpNotes} onChange={e => setFollowUpNotes(e.target.value)} placeholder="e.g. Return in 1 week, sooner if symptoms worsen" /></div>
          </div>

          {/* CONSULTATION ACTION TOOLBAR — always visible when a patient is selected.
              These buttons used to be buried inside the prescription section (which
              only rendered when activeVitals was set). Now they're at the top level
              so the doctor can access AI Assist, AI Codes, and Virtual Consult
              without needing to add a medication first. */}
          {activePatient && (
            <div className="dash-panel" style={{ marginTop: 20, padding: 14 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 8 }}>
                  Quick Actions
                </div>
                <button type="button" className="btn btn-primary" style={{ width: 'auto', background: 'var(--violet)', color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setShowAiDiagnostics(true)} disabled={!activePatient} title="Get AI-assisted differential diagnosis and recommendations">
                  AI Assist
                </button>
                <button type="button" className="btn btn-ghost" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--violet)', borderColor: 'rgba(118,87,232,0.3)' }} onClick={() => setShowCodePanel(s => !s)} disabled={!activeVitals} title="Get AI-suggested ICD-10 codes + discharge summary">
                  AI Codes
                </button>
                <button type="button" className="btn btn-ghost" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--teal)', borderColor: 'var(--teal-border)' }} onClick={async () => {
                  if (!activePatient) {
                    setToast('Select a patient from the queue first')
                    setTimeout(() => setToast(null), 3000)
                    return
                  }
                  try {
                    const roomId = `vc-${activePatient.id}-${Date.now()}`
                    const { data, error } = await supabase.from('virtual_consultations').insert({
                      hospital_id: hospital.id,
                      patient_id: activePatient.id,
                      patient_name: activePatient.full_name,
                      doctor_id: profile.id,
                      doctor_name: profile.full_name,
                      status: 'scheduled',
                      room_id: roomId,
                      scheduled_start: new Date().toISOString(),
                    }).select().single()
                    if (error) throw error
                    if (data) {
                      setVirtualConsultData({ consultationId: data.id, roomId })
                      setShowVirtualConsult(true)
                    }
                  } catch (err) {
                    setToast('Could not start virtual consultation: ' + (err.message || 'Unknown error'))
                    setTimeout(() => setToast(null), 5000)
                  }
                }} disabled={!activePatient} title="Start a video consultation with this patient">
                  Virtual Consult
                </button>
              </div>
            </div>
          )}

          <div className="dash-row dash-row-2" style={{ marginTop: 20 }}>
            <div className="dash-panel" data-lab-panel>
              <div className="dash-panel-head">
                <div>
                  <div className="dash-panel-title">Lab Orders</div>
                  <div className="dash-panel-sub">Select tests from the catalog — sent as one request</div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: 'auto', padding: '7px 14px', fontSize: 12 }}
                  onClick={() => setShowLabPicker(true)}
                  disabled={!activeVitals}
                  title="Open the lab test catalog picker"
                >
                  <AppIcon name="plus" size={14} /> Select Laboratory Tests
                </button>
              </div>

              {/* ---- Pending selection review (from LabTestPicker) ---- */}
              {pendingLabSelection.length > 0 ? (
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(0,199,199,0.06)', border: '1px solid var(--teal-border)', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                    {pendingLabSelection.length} test{pendingLabSelection.length === 1 ? '' : 's'} selected
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {pendingLabSelection.map(t => (
                      <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
                        <div>
                          <span style={{ fontWeight: 600, color: 'var(--ivory)' }}>{t.name}</span>
                          {t.code && <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)' }}>{t.code}</span>}
                          {t.sample_type && <span style={{ marginLeft: 8, fontSize: 10.5, color: 'var(--gold)' }}>· {t.sample_type}</span>}
                          {t.requiresPreAuth && <span style={{ marginLeft: 8, fontSize: 10.5, color: 'var(--violet)', fontWeight: 600 }}>· pre-auth</span>}
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--teal)', fontWeight: 700 }}>
                          {formatMoney(t.patientAmount)}
                          {t.hmoAmount > 0 && <span style={{ color: 'var(--muted)', fontWeight: 500, marginLeft: 6 }}>+ HMO {formatMoney(t.hmoAmount)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--line-soft)', display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 }}>
                    <span style={{ color: 'var(--muted)' }}>Patient total</span>
                    <span style={{ color: 'var(--teal)', fontFamily: 'var(--font-mono)' }}>
                      {formatMoney(pendingLabSelection.reduce((s, t) => s + Number(t.patientAmount || 0), 0))}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: 'auto', padding: '5px 10px', fontSize: 11, marginTop: 8 }}
                    onClick={() => setShowLabPicker(true)}
                  >
                    Edit selection
                  </button>
                </div>
              ) : (
                <div style={{ padding: 14, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px dashed var(--line)', fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
                  No tests selected yet. Click <strong style={{ color: 'var(--teal)' }}>Select Laboratory Tests</strong> above to open the catalog picker.
                </div>
              )}

              <form onSubmit={handleSendLabOrders}>
                {/* Free-text extras (kept for non-catalog tests) */}
                <div className="field"><label>Other Tests (not in catalog)</label><input value={otherLabTests} onChange={e => setOtherLabTests(e.target.value)} placeholder="Comma-separated, e.g. Special Stain" /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field">
                    <label>Priority</label>
                    <select value={labPriority} onChange={e => setLabPriority(e.target.value)}>
                      <option value="routine">Routine</option>
                      <option value="urgent">Urgent</option>
                      <option value="stat">Stat (Very Urgent)</option>
                    </select>
                  </div>
                  <div className="field"><label>Clinical Notes</label><input value={labNotes} onChange={e => setLabNotes(e.target.value)} placeholder="Optional" /></div>
                </div>
                {(() => {
                  const extraCount = otherLabTests.split(',').map(s => s.trim()).filter(Boolean).length
                  const total = pendingLabSelection.length + extraCount
                  return total > 0 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>{total} test{total === 1 ? '' : 's'} ready to send</div>
                })()}
                <button type="submit" className="btn btn-primary" disabled={savingLabOrder || (pendingLabSelection.length === 0 && !otherLabTests.trim())}>{savingLabOrder ? 'Sending…' : 'Send Lab Order'}</button>
              </form>
              {activePatientLabOrders.length > 0 && <ul className="dash-legend" style={{ marginTop: 16 }}>{activePatientLabOrders.map(o => { const stage = labStage(o.status); return <li key={o.id}><span className="dash-legend-name"><span className="dash-legend-dot" style={{ background: o.priority === 'stat' ? 'var(--danger)' : o.priority === 'urgent' ? 'var(--gold)' : 'var(--teal)' }} />{o.test_name}</span><span className="dash-legend-val" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span className={`lab-stage is-${stage}`}>{LAB_STAGE_LABEL[stage]}</span>{stage === 'completed' && <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '3px 9px', fontSize: 11 }} onClick={() => openLabViewer(normalizeLabRow(o, 'doctor'))} aria-label={`View completed result for ${o.test_name}`}>View Result</button>}</span></li> })}</ul>}
            </div>

            <div className="dash-panel">
              <div className="dash-panel-head"><div><div className="dash-panel-title">Prescription</div><div className="dash-panel-sub">Build medications</div></div></div>
              <div className="field"><label>Load Template</label><div style={{ display: 'flex', gap: 8 }}><select value={selectedTemplateId} onChange={e => setSelectedTemplateId(e.target.value)} style={{ flex: 1 }}><option value="">Select…</option><optgroup label="Built-in">{DEFAULT_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>{hospitalTemplates.length > 0 && <optgroup label="Hospital">{hospitalTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}</select><button type="button" className="btn btn-ghost" style={{ width: 'auto' }} onClick={handleApplyTemplate} disabled={!selectedTemplateId}>Load</button></div></div>

              <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14, marginTop: 6 }}>
                <div className="field">
                  <label>Drug / Medication Search</label>
                  {/* Shared combobox (global rule): one dropdown behaviour,
                      keyboard + touch + ARIA; stock shown per option so
                      similar names are distinguishable. Unmatched queries
                      can continue as free-typed medication. */}
                  <Autocomplete
                    options={drugOptions}
                    value={null}
                    onChange={item => { if (item) selectDrug(item) }}
                    placeholder="Search medication by generic or brand name…"
                    allowFreeText
                    freeTextLabel='Keep "{query}" as free-typed medication'
                    emptyText="No match in hospital inventory or the global reference list"
                    ariaLabel="Medication search"
                  />
                </div>

                {medBuilder.availability_status === 'UNAVAILABLE' && (
                  <div style={{ border: '1px solid var(--danger)', background: 'rgba(235,87,87,0.05)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                    <div style={{ color: 'var(--danger)', fontWeight: 800, marginBottom: 6, display: 'inline-flex', alignItems: 'center', gap: 6 }}><AppIcon name="alert" size={14} /> Medication Unavailable</div>
                    <div style={{ fontSize: 13, marginBottom: 8 }}>This medication is not available in the hospital.</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Current hospital stock: 0</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }} onClick={() => setMedBuilder(b => ({ ...b, accepted_unavailable: true }))}>Continue Prescribing</button>
                      <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 12, border: '1px solid var(--danger)', color: 'var(--danger)' }} onClick={resetMedBuilder}>Remove Medication</button>
                    </div>
                  </div>
                )}
                {medBuilder.accepted_unavailable && <div style={{ fontSize: 12, color: 'var(--gold)', marginBottom: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}><AppIcon name="warning" size={13} /> UNAVAILABLE AT TIME OF PRESCRIPTION</div>}
                {medBuilder.availability_status === 'AVAILABLE' && medBuilder.drugName && <div style={{ fontSize: 12, color: 'var(--teal)', marginBottom: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}><AppIcon name="check" size={13} /> AVAILABLE (Hospital Stock: {medBuilder.stock_at_prescription})</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field"><label>Dose</label><input value={medBuilder.dose} onChange={e => setMedBuilder(b => ({ ...b, dose: e.target.value }))} placeholder="e.g. 500 mg" /></div>
                  <div className="field"><label>Route</label><select value={medBuilder.route} onChange={e => setMedBuilder(b => ({ ...b, route: e.target.value }))}><option value="">Select route…</option>{ROUTE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
                  <div className="field"><label>Frequency</label><select value={medBuilder.frequency} onChange={e => setMedBuilder(b => ({ ...b, frequency: e.target.value }))}><option value="">Select frequency…</option>{FREQUENCY_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}</select></div>
                  {medBuilder.frequency === 'Custom' && <div className="field"><label>Custom Freq</label><input value={medBuilder.frequencyCustom} onChange={e => setMedBuilder(b => ({ ...b, frequencyCustom: e.target.value }))} placeholder="e.g. Every other day" /></div>}
                  <div className="field"><label>Duration</label><input value={medBuilder.duration} onChange={e => setMedBuilder(b => ({ ...b, duration: e.target.value }))} placeholder="e.g. 7 days" /></div>
                  <div className="field"><label>Quantity</label><input value={medBuilder.quantity} onChange={e => setMedBuilder(b => ({ ...b, quantity: e.target.value }))} placeholder="e.g. 21 tablets" /></div>
                </div>
                <div className="field"><label>Instructions</label><input value={medBuilder.instructions} onChange={e => setMedBuilder(b => ({ ...b, instructions: e.target.value }))} placeholder="e.g. Take 1 tablet after meals" /></div>
                <button type="button" className="btn btn-primary" onClick={handleAddOrUpdateMedToDraft}>{editingMedLocalId ? 'Update Medication' : '+ Add Medication'}</button>
                {editingMedLocalId && <button type="button" className="btn btn-ghost" style={{ marginTop: 8 }} onClick={resetMedBuilder}>Cancel Edit</button>}

                {/* Drug Interaction Engine — shows alerts when the engine finds issues */}
                {medicationAlerts && medicationAlerts.length > 0 && (
                  <MedicationSafetyAlert
                    alerts={medicationAlerts}
                    onOverride={handleMedicationOverride}
                    onAbort={handleMedicationAbort}
                  />
                )}
              </div>

              {medications.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>Medications ({medications.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {medications.map(m => (
                      <div key={m.localId} style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{m.drugName}</div>
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.dose} · {m.route || '—'} · {m.frequency}{m.duration ? ` · ${m.duration}` : ''}</div>
                            {m.availability_status === 'AVAILABLE' && <div style={{ fontSize: 11, color: 'var(--teal)', marginTop: 6, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="check" size={11} /> AVAILABLE</div>}
                            {m.availability_status === 'UNAVAILABLE' && m.accepted_unavailable && <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 6, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="warning" size={11} /> UNAVAILABLE AT TIME OF PRESCRIPTION</div>}
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" onClick={() => handleEditMed(m)} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }}>Edit</button>
                            <button type="button" onClick={() => handleRemoveMed(m)} className="icon-btn-delete" style={{ width: 28, height: 28 }}><TrashIcon size={13}/></button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => setShowPreview(s => !s)}>{showPreview ? 'Hide' : 'Preview'}</button>
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto' }} onClick={() => handleSavePrescriptions('draft')} disabled={savingPrescriptions}>Save Draft</button>
                    <button type="button" className="btn btn-primary" style={{ width: 'auto' }} onClick={() => handleSavePrescriptions('active')} disabled={savingPrescriptions}>Finalize</button>
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto' }} onClick={handlePrint}>Print</button>
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto' }} onClick={handleSaveAsTemplate}>Save as Template</button>
                  </div>
                  {showPreview && <div style={{ marginTop: 16, padding: 16, borderRadius: 10, background: 'var(--bg-elevated)' }}><ol style={{ paddingLeft: 20 }}>{medications.map(m => <li key={m.localId} style={{ fontSize: 13.5, marginBottom: 8 }}><strong>{m.drugName}</strong> - {m.dose} {m.route} {m.frequency}</li>)}</ol></div>}
                </div>
              )}
            </div>
          </div>

          {/* LABORATORY RESULTS — dedicated panel (global lab workflow
              rule). Completed/verified results for the selected patient
              across ALL encounters; abnormal flags lead the list; realtime
              + a 30s poll keep it live; every row opens the shared
              LabResultViewer with comparison history. */}
          <div className="dash-panel" style={{ marginTop: 20 }}>
            <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="dash-panel-title">Laboratory Results</div>
                <div className="dash-panel-sub">{activePatient ? `${activePatient.full_name}${patientMeta(activePatient) ? ' · ' + patientMeta(activePatient) : ''}` : 'No patient selected'} · completed &amp; verified results, newest first</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => { syncLabOrders(); syncLabTests() }}
                aria-label="Refresh laboratory results"
              >
                <AppIcon name="refresh" size={14} /> Refresh
              </button>
            </div>

            {!activeVitals ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>Select a patient from the queue to see their lab results.</div>
            ) : sortedCompletedResults.length === 0 && patientLabRows.active.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>No lab results for this patient yet. Order tests from the Lab Orders panel.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sortedCompletedResults.map(r => (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open result for ${r.testName}${r.abnormalFlag && r.abnormalFlag !== 'normal' ? ` (${r.abnormalFlag})` : ''}`}
                    onClick={() => openLabViewer(r)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLabViewer(r) } }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                      padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                      background: r.abnormalFlag && r.abnormalFlag !== 'normal' ? 'var(--danger-soft)' : 'var(--bg-elevated)',
                      border: r.abnormalFlag && r.abnormalFlag !== 'normal' ? '1px solid rgba(240,79,95,0.35)' : '1px solid var(--line-soft)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {r.testName}
                        {r.abnormalFlag && r.abnormalFlag !== 'normal' && <span className={`lab-flag is-${r.abnormalFlag}`}>{r.abnormalFlag}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        Resulted {r.resultedAt ? formatDateTime(r.resultedAt, timezone) : '—'}
                        {r.verifiedBy ? ` · by ${r.verifiedBy}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.result || '—'}{r.resultUnit ? ` ${r.resultUnit}` : ''}
                      </span>
                      <AppIcon name="chevron" size={15} />
                    </div>
                  </div>
                ))}
                {patientLabRows.active.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, margin: '6px 0' }}>In progress</div>
                    {patientLabRows.active.map(r => (
                      <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)', marginBottom: 6 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{r.testName}{r.origin === 'lab' ? <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: 'rgba(201,169,97,0.14)', color: 'var(--gold)', verticalAlign: 'middle' }}>LAB-RAISED</span> : null}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Requested {r.requestedAt ? formatDateTime(r.requestedAt, timezone) : '—'}</div>
                        </div>
                        <span className={`lab-stage is-${r.stage}`} style={{ flexShrink: 0 }}>{LAB_STAGE_LABEL[r.stage]}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="dash-panel" style={{ marginTop: 20 }}>
            <div className="dash-panel-head"><div><div className="dash-panel-title">Consultation Summary</div></div></div>
            <div>{summaryRow('Patient', activePatient ? `${activePatient.full_name}${patientMeta(activePatient) ? ' · ' + patientMeta(activePatient) : ''}` : null)}{summaryRow('History', historySummary)}{summaryRow('Symptoms', symptoms.map(s => s.label).join(', '))}{summaryRow('Vitals', `BP ${activeVitals.blood_pressure || '—'} · Pulse ${activeVitals.pulse_rate || '—'}`)}{summaryRow('Diagnosis', diagnoses.map(d => d.label).join(', '))}{summaryRow('Prescription', medications.map(m => m.drugName).join('; '))}{summaryRow('Plan', treatmentPlan)}</div>
          </div>

          <div className="dash-panel" style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div><div className="dash-panel-title">Finish Up</div><div className="dash-panel-sub">Finalizes meds and completes visit</div></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={clearWorkbench}>Cancel</button>
              <button className="btn btn-primary" style={{ width: 'auto' }} onClick={handleCompleteConsultation} disabled={completing}>{completing ? 'Completing…' : 'Complete Consultation'}</button>
            </div>
          </div>
        </>
      )}

      {toast && <div className="dash-toast dash-toast-success" role="status">{toast}</div>}
      {viewRow && (
        <LabResultViewer
          row={viewRow}
          patient={viewRow.patient}
          history={viewHistory}
          hospital={hospital}
          onClose={() => { setViewRow(null); setViewHistory([]) }}
        />
      )}
      {showAdmissionModal && activePatient && <AdmissionRequestModal patient={activePatient} consultationId={activeVitals?.id} prefillDiagnosis={diagnoses.map(d => d.label).join(', ')} onSubmit={handleSubmitAdmissionRequest} onClose={() => setShowAdmissionModal(false)} />}

      {/* ---- LabTestPicker modal (Section 2 upgrade) ----
          Catalog-driven multi-select for lab tests. Replaces the old
          hardcoded LAB_TEST_CATEGORIES checkbox grid. */}
      {showLabPicker && (
        <LabTestPicker
          catalog={catalog}
          priceLists={priceLists}
          priceListItems={priceListItems}
          contracts={contracts}
          patient={activePatient}
          initialSelected={pendingLabSelection.map(t => t.id)}
          onConfirm={handleConfirmLabTests}
          onClose={() => setShowLabPicker(false)}
        />
      )}

      {showAiDiagnostics && (
        <AiDiagnostics
          patientId={activePatient?.id || null}
          encounterId={activeVitals?.id || null}
          assessmentType="consultation"
          onClose={() => setShowAiDiagnostics(false)}
        />
      )}

      {/* AI Code Suggestion Panel — ICD-10 + procedure codes + discharge summary */}
      {showCodePanel && activeVitals && activePatient && (
        <CodeSuggestionPanel
          activeVitals={activeVitals}
          activePatient={activePatient}
          onClose={() => setShowCodePanel(false)}
        />
      )}

      {/* Virtual Consultation — full-screen video call overlay */}
      {showVirtualConsult && virtualConsultData && (
        <VirtualConsultation
          patient={activePatient}
          hospital={hospital}
          consultationId={virtualConsultData.consultationId}
          roomId={virtualConsultData.roomId}
          onClose={() => { setShowVirtualConsult(false); setVirtualConsultData(null) }}
        />
      )}
    </>
  )
}
