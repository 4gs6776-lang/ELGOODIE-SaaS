import { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import PatientProfile from '../../components/PatientProfile'
import SearchInput from '../../components/common/SearchInput'
import PatientAutocomplete from '../../components/common/PatientAutocomplete'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import { writeAudit } from '../../lib/audit'
import AiDiagnostics from './AiDiagnostics'
import {
  checkVitalsAgainstLimits,
  buildAlertReason,
  checkPatientEligibility,
  hasUnresolvedAlert,
  isNewBreachWorse,
} from '../../lib/vitalsAlerts'

const URGENCY_LEVELS = ['Routine', 'Urgent', 'Emergency']

export default function Nursing(){
  const { profile, hospital } = useAuth()
  const { records: patients, updateRecord: updatePatient } = useOfflineTable('patients', hospital?.id)
  const { records: vitalsQueue, loading, addRecord: addVitals } = useOfflineTable('patient_vitals', hospital?.id)
  const { records: staff } = useOfflineTable('profiles', hospital?.id)
  const { records: prescriptions, updateRecord: updatePrescription } = useOfflineTable('prescriptions', hospital?.id)
  const {
  records: medicationAdministrations,
  addRecord: addMedicationAdministration
} = useOfflineTable('medication_administrations', hospital?.id)

  // ---- Early-warning alert hooks ----
  const { records: vitalsLimits } = useOfflineTable('hospital_vitals_limits', hospital?.id)
  const { records: existingAlerts, addRecord: addAlert } = useOfflineTable('patient_vitals_alerts', hospital?.id)
  const { records: admissions } = useOfflineTable('admissions', hospital?.id)
  const { records: beds } = useOfflineTable('beds', hospital?.id)

  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [profilePatientId, setProfilePatientId] = useState(null)
  const [selectedPatientId, setSelectedPatientId] = useState('')
  const [assignedDoctor, setAssignedDoctor] = useState('')
  const [urgency, setUrgency] = useState('Routine')
  const [saving, setSaving] = useState(false)
  const [aiTriagePatientId, setAiTriagePatientId] = useState(null)
  const [pharmPatientId, setPharmPatientId] = useState(null)
  // Send to Pharmacy modal state
  const [pharmDrug, setPharmDrug] = useState('')
  const [pharmQty, setPharmQty] = useState('')
  const [pharmNotes, setPharmNotes] = useState('')
  const [pharmSaving, setPharmSaving] = useState(false)
  const [pharmError, setPharmError] = useState('')

  const { addRecord: addPrescription } = useOfflineTable('prescriptions', hospital?.id)

  const [vitals, setVitals] = useState({
    temperature: '', blood_pressure: '', pulse_rate: '', respiratory_rate: '', spo2: '', weight: '', height: '', nurse_notes: '',
  })

  const doctors = staff ? staff.filter(s => s.role === 'doctor' || s.role === 'admin') : []

  // Checked-in patients are surfaced first, but any patient can be triaged.
  const [triagePatientSearch, setTriagePatientSearch] = useState('')
  const readyForTriage = patients
    .filter(p => p.queue_status === 'waiting')
    .filter(p => !triagePatientSearch.trim() || p.full_name.toLowerCase().includes(triagePatientSearch.trim().toLowerCase()))
  const otherPatients = patients
    .filter(p => p.queue_status !== 'waiting')
    .filter(p => !triagePatientSearch.trim() || p.full_name.toLowerCase().includes(triagePatientSearch.trim().toLowerCase()))

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // ---- Realtime: see new patients + queue changes instantly ----
  useRealtimeAlert('patients', hospital?.id, () => {})
  useRealtimeAlert('patients', hospital?.id, () => {}, { event: 'UPDATE' })
  useRealtimeAlert('patient_vitals', hospital?.id, () => {})
  useRealtimeAlert('prescriptions', hospital?.id, () => {})

  // ---- Polling safety net (every 30s) ----
  useEffect(() => {
    if (!hospital?.id) return
    const id = setInterval(() => {}, 30000)  // useOfflineTable auto-refreshes via localChangeListeners
    return () => clearInterval(id)
  }, [hospital?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleQueueWithVitals(e){
    e.preventDefault()
    if (!selectedPatientId || !assignedDoctor) return
    if (!hospital || !profile) {
      showToast('Still loading your account — try again in a moment')
      return
    }

    const patientObj = patients.find(p => p.id === selectedPatientId)
    setSaving(true)
    try {
      const nowIso = new Date().toISOString()
      const savedVitals = {
        patient_id: patientObj?.id,
        patient_name: patientObj ? patientObj.full_name : 'Unknown Patient',
        assigned_doctor: assignedDoctor,
        urgency,
        status: 'waiting',
        recorded_at: nowIso,
        created_by: profile.id,
        ...vitals,
      }
      await addVitals(savedVitals)

      // Sync with Reception's board — patient moves from "Waiting" to "In Consultation".
      if (patientObj) {
        await updatePatient(patientObj.id, { queue_status: 'in_consultation', queue_updated_at: nowIso })
      }

      // ---- Early-warning alert check --------------------------------
      // Only for admitted inpatients who are adults. Walk-in, outpatient,
      // ANC, pediatric — all excluded. If no limits configured, no alerts.
      if (vitalsLimits && vitalsLimits.length > 0 && patientObj) {
        const eligibility = checkPatientEligibility(patientObj, admissions)
        if (eligibility.eligible) {
          // Find previous vitals row for comparison
          const previousVitals = vitalsQueue
            .filter(v => v.patient_id === patientObj.id && v.recorded_at < nowIso)
            .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null

          // Find bed info for this patient
          const bed = (beds || []).find(b => b.patient_name === patientObj.full_name && b.status === 'occupied')

          const breaches = checkVitalsAgainstLimits(savedVitals, vitalsLimits, previousVitals)
          for (const breach of breaches) {
            // Check if there's already an unresolved alert for this vital+direction
            const alreadyAlerted = hasUnresolvedAlert(existingAlerts, patientObj.id, breach.vitalName, breach.limitDirection)
            if (alreadyAlerted) {
              // Only create a new alert if the new breach is WORSE
              if (!isNewBreachWorse(existingAlerts, patientObj.id, breach.vitalName, breach.limitDirection, breach.severity)) {
                continue  // skip — same or lesser severity, don't duplicate
              }
            }

            const reason = buildAlertReason(breach)
            await addAlert({
              hospital_id: hospital.id,
              patient_id: patientObj.id,
              patient_name: patientObj.full_name,
              vitals_id: null,  // can't get the ID from addVitals return reliably
              admission_id: eligibility.admission?.id || null,
              bed_id: bed?.id || null,
              ward_section: bed?.section || null,
              severity: breach.severity,
              vital_name: breach.vitalName,
              vital_value: breach.value,
              vital_unit: breach.unit,
              limit_value: breach.limitValue,
              limit_direction: breach.limitDirection,
              previous_value: breach.previousValue || null,
              previous_time: breach.previousTime || null,
              recorded_by: profile.id,
              recorded_by_name: profile.full_name,
              recorded_at: breach.recordedAt,
              status: 'active',
              reason,
            })

            writeAudit({
              hospitalId: hospital.id, actor: profile,
              action: 'vitals_alert.created',
              entityType: 'patient_vitals_alert', entityId: null,
              patientId: patientObj.id,
              summary: `Early-warning alert: ${reason}`,
              metadata: {
                patient_id: patientObj.id,
                vital_name: breach.vitalName,
                value: breach.value,
                limit: breach.limitValue,
                direction: breach.limitDirection,
                severity: breach.severity,
              },
            })

            showToast(`⚠ Alert: ${reason}`)
          }
        }
      }

      setSelectedPatientId(''); setAssignedDoctor(''); setUrgency('Routine')
      setVitals({ temperature: '', blood_pressure: '', pulse_rate: '', respiratory_rate: '', spo2: '', weight: '', height: '', nurse_notes: '' })
      showToast('Vitals saved — sent to doctor queue')
    } catch (err) {
      showToast(err.message || 'Could not save vitals')
    } finally {
      setSaving(false)
    }
  }

  function urgencyColor(u){
    if (u === 'Emergency') return { bg: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }
    if (u === 'Urgent') return { bg: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }
    return { bg: 'var(--teal-soft)', color: 'var(--teal)' }
  }

  const activeQueue = vitalsQueue
    .filter(q => q.status !== 'completed')
    .sort((a, b) => {
      const order = { Emergency: 0, Urgent: 1, Routine: 2 }
      return (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3)
    })

  const nursingSearch = searchTerm.trim().toLowerCase()
  const visibleActiveQueue = nursingSearch ? activeQueue.filter(item => [item.patient_name, item.patient_id, item.urgency, item.assigned_doctor].some(v => String(v || '').toLowerCase().includes(nursingSearch))) : activeQueue

  const activeOrders = prescriptions
    .filter(p => p.status === 'active')
    .sort((a, b) => new Date(b.prescribed_at || b.created_at) - new Date(a.prescribed_at || a.created_at))

  // Patient lookup — search any patient (not just those currently in the
  // queue), see their details, doctor's orders, and latest consultation.
  const [selectedLookupPatientId, setSelectedLookupPatientId] = useState('')

  const selectedLookupPatient = patients.find(p => p.id === selectedLookupPatientId) || null
  const lookupOrders = selectedLookupPatient
    ? activeOrders.filter(rx => rx.patient_name === selectedLookupPatient.full_name)
    : []
  const lookupLatestConsultation = selectedLookupPatient
    ? vitalsQueue
        .filter(v => v.patient_id === selectedLookupPatient.id && v.status === 'completed')
        .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))[0]
    : null

  function selectLookupPatient(id){
    setSelectedLookupPatientId(id)
  }

  async function handleMarkAdministered(rx){
  if (!hospital || !profile) {
    showToast('Account is still loading — try again')
    return
  }

  try {
    // The database refuses medication_administrations rows without a
    // patient. Prescriptions issued before patient_id was added to the
    // payload (or built from a vitals row that lacked it) would otherwise
    // poison the sync queue with a permanent NOT-NULL failure — resolve
    // by name as a fallback, and refuse cleanly if the link truly cannot
    // be established.
    const resolvedPatientId =
      rx.patient_id ||
      patients.find((p) => p.full_name === rx.patient_name)?.id ||
      null

    if (!resolvedPatientId) {
      showToast('Cannot record: this prescription has no linked patient. Ask the doctor to re-issue it.')
      return
    }

    await addMedicationAdministration({
      patient_id: resolvedPatientId,
      prescription_id: rx.id,

      patient_name: rx.patient_name,
      drug_name: rx.drug_name,
      dosage: rx.dosage || '',
      route: rx.route || '',
      frequency: rx.frequency || '',
      instructions: rx.instructions || '',

      administered_by: profile.id,
      administered_by_name: profile.full_name || 'Nurse',

      status: 'administered',
      administered_at: new Date().toISOString(),

      notes: ''
    })

    await updatePrescription(rx.id, {
      status: 'dispensed',
      administered_at: new Date().toISOString(),
      administered_by: profile.id
    })

    showToast(
      `${rx.drug_name} administered to ${rx.patient_name}`
    )

  } catch (err) {
    showToast(err.message || 'Could not record medication administration')
  }
}

  return (
    <>
      <div className="dash-panel" style={{ marginBottom: 16 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Nurses' Triage & Vitals Station</div>
            <div className="dash-panel-sub">Capture clinical measurements and send patients to the doctor queue</div>
          </div>
          <ModuleHistoryButton moduleKey="nursing" />
        </div>
      </div>

      <div className="dash-row dash-row-2">
        <div className="dash-panel">
          <div className="dash-panel-head">
            <div className="dash-panel-title">Triage Patient & Record Vitals</div>
          </div>

          {readyForTriage.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              No patients currently checked in at Reception waiting for triage.
            </div>
          )}

          <form onSubmit={handleQueueWithVitals}>
            <div className="field">
              <label>Search Patients</label>
              <input
                value={triagePatientSearch}
                onChange={e => setTriagePatientSearch(e.target.value)}
                placeholder="Type a name to filter the list below…"
              />
            </div>
            <div className="field">
              <label>Select Patient</label>
              <select value={selectedPatientId} onChange={e => setSelectedPatientId(e.target.value)}>
                <option value="">-- Choose Patient --</option>
                {readyForTriage.length > 0 && (
                  <optgroup label="Checked-In (Waiting)">
                    {readyForTriage.map(p => (
                      <option key={p.id} value={p.id}>{p.full_name}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All Patients">
                  {otherPatients.map(p => (
                    <option key={p.id} value={p.id}>{p.full_name}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="field">
                <label>Assign Doctor</label>
                <select value={assignedDoctor} onChange={e => setAssignedDoctor(e.target.value)}>
                  <option value="">-- Select Doctor --</option>
                  {doctors.map(d => <option key={d.id} value={d.full_name}>{d.full_name}</option>)}
                  <option value="Duty Doctor">Duty Doctor</option>
                </select>
              </div>
              <div className="field">
                <label>Priority / Urgency</label>
                <select value={urgency} onChange={e => setUrgency(e.target.value)}>
                  {URGENCY_LEVELS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 12, marginBottom: 8, fontSize: 12, fontWeight: 700, color: 'var(--teal)' }}>
              CLINICAL VITALS
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="field">
                <label>Temperature (°C)</label>
                <input value={vitals.temperature} onChange={e => setVitals({ ...vitals, temperature: e.target.value })} placeholder="36.8" />
              </div>
              <div className="field">
                <label>Blood Pressure</label>
                <input value={vitals.blood_pressure} onChange={e => setVitals({ ...vitals, blood_pressure: e.target.value })} placeholder="120/80" />
              </div>
              <div className="field">
                <label>Pulse Rate (bpm)</label>
                <input value={vitals.pulse_rate} onChange={e => setVitals({ ...vitals, pulse_rate: e.target.value })} placeholder="75" />
              </div>
              <div className="field">
                <label>Resp. Rate (bpm)</label>
                <input value={vitals.respiratory_rate} onChange={e => setVitals({ ...vitals, respiratory_rate: e.target.value })} placeholder="18" />
              </div>
              <div className="field">
                <label>SpO2 (%)</label>
                <input value={vitals.spo2} onChange={e => setVitals({ ...vitals, spo2: e.target.value })} placeholder="98" />
              </div>
              <div className="field">
                <label>Weight (kg)</label>
                <input value={vitals.weight} onChange={e => setVitals({ ...vitals, weight: e.target.value })} placeholder="68" />
              </div>
              <div className="field">
                <label>Height (cm)</label>
                <input value={vitals.height} onChange={e => setVitals({ ...vitals, height: e.target.value })} placeholder="175" />
              </div>
            </div>

            <div className="field">
              <label>Nurse Observations / Complaints</label>
              <input value={vitals.nurse_notes} onChange={e => setVitals({ ...vitals, nurse_notes: e.target.value })} placeholder="e.g. Patient complains of severe migraine since morning" />
            </div>

            <button type="submit" className="btn btn-primary" disabled={saving} style={{ marginTop: 8 }}>
              {saving ? 'Saving…' : 'Save Vitals & Send to Doctor Queue'}
            </button>
          </form>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <div className="dash-panel-title">Active Consultation Queue ({activeQueue.filter(q => q.status === 'waiting').length})</div>
            <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search active patients by name or ID" style={{ minWidth: 240, maxWidth: 360 }} />
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
          ) : (
            <ul className="dash-legend">
              {visibleActiveQueue.map(item => {
                const uc = urgencyColor(item.urgency)
                return (
                  <li key={item.id} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '12px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                      <strong
                        onClick={() => item.patient_id && selectLookupPatient(item.patient_id)}
                        style={{ cursor: item.patient_id ? 'pointer' : 'default', color: selectedLookupPatientId === item.patient_id ? 'var(--teal)' : undefined }}
                        title="Click to view this patient's details and doctor's orders"
                      >
                        {item.patient_name}
                      </strong>
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: uc.bg, color: uc.color, fontWeight: 700 }}>
                        {item.urgency}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>Doctor: <strong>{item.assigned_doctor}</strong></div>
                    <div style={{ fontSize: 11, color: 'var(--ivory)', background: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6, width: '100%' }}>
                      <div><strong>BP:</strong> {item.blood_pressure || 'N/A'} · <strong>Temp:</strong> {item.temperature ? `${item.temperature}°C` : 'N/A'}</div>
                      <div><strong>Pulse:</strong> {item.pulse_rate || 'N/A'} · <strong>SpO2:</strong> {item.spo2 ? `${item.spo2}%` : 'N/A'} · <strong>Weight:</strong> {item.weight ? `${item.weight}kg` : 'N/A'}</div>
                      {item.nurse_notes && <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--gold)' }}>"{item.nurse_notes}"</div>}
                    </div>
                  </li>
                )
              })}
              {activeQueue.length === 0 && (
                <li style={{ color: 'var(--muted)', fontSize: 13 }}>No patients waiting in queue.</li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Patient Lookup</div>
            <div className="dash-panel-sub">Search any patient to view their details and doctor's orders</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {selectedLookupPatient && (
              <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 12, background: 'var(--violet)', color: '#fff' }} onClick={() => setAiTriagePatientId(selectedLookupPatient.id)} title="Get AI-assisted triage assessment">
                AI Triage
              </button>
            )}
            {selectedLookupPatient && (
              <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 12, background: 'var(--teal)', color: '#00251F' }} onClick={() => setPharmPatientId(selectedLookupPatient.id)} title="Send a medication request to Pharmacy">
                Send to Pharmacy
              </button>
            )}
            {selectedLookupPatient && (
              <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }} onClick={() => setProfilePatientId(selectedLookupPatient.id)}>
                View Full Profile
              </button>
            )}
            {selectedLookupPatient && (
              <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }} onClick={() => setSelectedLookupPatientId('')}>
                Clear
              </button>
            )}
          </div>
        </div>

        {!selectedLookupPatient && (
          <div className="field" style={{ marginBottom: 0 }}>
            <PatientAutocomplete
              patients={patients}
              value={null}
              onChange={opt => { if (opt?.patient) selectLookupPatient(opt.patient.id) }}
              placeholder="Search patients by name…"
              ariaLabel="Patient lookup"
            />
          </div>
        )}

        {selectedLookupPatient && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Name</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedLookupPatient.full_name}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Age / Gender</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedLookupPatient.age || '—'}{selectedLookupPatient.gender ? ` · ${selectedLookupPatient.gender}` : ''}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Phone</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedLookupPatient.phone || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Blood Group / Genotype</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedLookupPatient.blood_group || '—'}{selectedLookupPatient.genotype ? ` · ${selectedLookupPatient.genotype}` : ''}</div>
              </div>
              {selectedLookupPatient.emergency_contact_name && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Emergency Contact</div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedLookupPatient.emergency_contact_name}{selectedLookupPatient.emergency_contact_phone ? ` — ${selectedLookupPatient.emergency_contact_phone}` : ''}</div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Queue Status</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedLookupPatient.queue_status ? selectedLookupPatient.queue_status.replace('_', ' ') : 'Not in queue'}</div>
              </div>
            </div>

            {lookupLatestConsultation && (
              <div style={{ marginBottom: 18, padding: '10px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Latest Consultation</div>
                {lookupLatestConsultation.diagnoses?.length > 0 && (
                  <div style={{ fontSize: 12.5, marginBottom: 4 }}>
                    <strong>Diagnosis:</strong> {lookupLatestConsultation.diagnoses.map(d => d.code ? `${d.label} (${d.code})` : d.label).join(', ')}
                  </div>
                )}
                {lookupLatestConsultation.treatment_plan && (
                  <div style={{ fontSize: 12.5 }}><strong>Treatment Plan:</strong> {lookupLatestConsultation.treatment_plan}</div>
                )}
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Doctor's Orders
            </div>
            {lookupOrders.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No active doctor's orders for {selectedLookupPatient.full_name}.</div>
            ) : (
              <ul className="dash-legend">
                {lookupOrders.map(rx => (
                  <li key={rx.id} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '12px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                      <strong style={{ color: 'var(--ivory)' }}>{rx.drug_name}</strong>
                      <button
                        onClick={() => handleMarkAdministered(rx)}
                        className="btn btn-ghost"
                        style={{ padding: '4px 10px', fontSize: 11 }}
                      >
                        Mark Administered
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {rx.dosage}{rx.route ? ` · ${rx.route}` : ''}{rx.frequency ? ` · ${rx.frequency}` : ''}{rx.duration ? ` · ${rx.duration}` : ''}
                    </div>
                    {rx.instructions && <div style={{ fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic' }}>{rx.instructions}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
          padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 700, zIndex: 60, maxWidth: '85vw', textAlign: 'center',
        }}>
          {toast}
        </div>
      )}

      {profilePatientId && (
        <PatientProfile
          patientId={profilePatientId}
          patient={patients.find(p => p.id === profilePatientId)}
          onClose={() => setProfilePatientId(null)}
        />
      )}

      {aiTriagePatientId && (
        <AiDiagnostics
          patientId={aiTriagePatientId}
          assessmentType="triage"
          onClose={() => setAiTriagePatientId(null)}
        />
      )}

      {/* ---- Send to Pharmacy modal ---- */}
      {pharmPatientId && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setPharmPatientId(null) }}>
          <div className="card dash-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">Send to Pharmacy</div>
            <div className="dash-modal-body">
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
                For <strong style={{ color: 'var(--teal)' }}>{patients.find(p => p.id === pharmPatientId)?.full_name || 'patient'}</strong>
              </div>
              {pharmError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{pharmError}</div>}
              <form id="nursing-pharm-form" onSubmit={async (e) => {
                e.preventDefault()
                setPharmError('')
                if (!pharmDrug.trim()) { setPharmError('Drug name is required.'); return }
                if (!pharmQty.trim()) { setPharmError('Quantity is required.'); return }
                setPharmSaving(true)
                try {
                  const p = patients.find(p => p.id === pharmPatientId)
                  await addPrescription({
                    patient_id: pharmPatientId,
                    patient_name: p?.full_name || 'Patient',
                    drug_name: pharmDrug.trim(),
                    dosage: null, route: null, frequency: null, duration: null,
                    quantity: pharmQty.trim(),
                    instructions: pharmNotes.trim() || null,
                    status: 'active',
                    prescribed_at: new Date().toISOString(),
                    doctor_id: profile?.id || null,
                    created_by: profile?.id || null,
                  })
                  showToast(`"${pharmDrug}" sent to Pharmacy for ${p?.full_name || 'patient'}`)
                  setPharmPatientId(null)
                  setPharmDrug(''); setPharmQty(''); setPharmNotes('')
                } catch (err) {
                  setPharmError(err.message || 'Could not send to pharmacy.')
                } finally {
                  setPharmSaving(false)
                }
              }}>
                <div className="field">
                  <label>Drug Name *</label>
                  <input value={pharmDrug} onChange={e => setPharmDrug(e.target.value)} placeholder="e.g. Paracetamol 500mg" autoFocus required />
                </div>
                <div className="field">
                  <label>Quantity *</label>
                  <input value={pharmQty} onChange={e => setPharmQty(e.target.value)} placeholder="e.g. 20 tablets" required />
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <input value={pharmNotes} onChange={e => setPharmNotes(e.target.value)} placeholder="e.g. For headache, give TDS" />
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setPharmPatientId(null)} disabled={pharmSaving}>Cancel</button>
              <button type="submit" form="nursing-pharm-form" className="btn btn-primary" disabled={pharmSaving}>{pharmSaving ? 'Sending…' : 'Send to Pharmacy'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
