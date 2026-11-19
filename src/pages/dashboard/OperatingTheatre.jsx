import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import PatientAutocomplete from '../../components/common/PatientAutocomplete'
import PatientProfile from '../../components/PatientProfile'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import AppIcon from '../../components/icons'
import { writeAudit } from '../../lib/audit'

// =====================================================================
// GOODIE-MEDHUB — Operating Theatre (Thaether) module
// ---------------------------------------------------------------------
// Tracks every surgical case from scheduling to post-op discharge.
// Each case is a row in `theatre_cases` (migration 104) with:
//   • Scheduling fields (procedure, scheduled start/end, theatre room)
//   • Pre-op assessment (ASA class, fasting, consent, diagnosis)
//   • Theatre team (surgeon, anaesthetist, scrub nurse, circulating)
//   • Anaesthesia details
//   • Intra-op findings (start/end, complications, blood loss, etc.)
//   • Post-op recovery + disposition (home/ward/ICU)
//
// Workflow: scheduled → pre_op_assessment → in_theatre → recovery →
//           completed (or cancelled at any step).
//
// The case detail modal is multi-section (Scheduling / Pre-op /
// Theatre / Anaesthesia / Intra-op / Post-op). Each section can be
// saved independently — staff don't have to fill everything at once.
// =====================================================================

const STATUS_FLOW = [
  { value: 'scheduled',          label: 'Scheduled',          color: 'var(--gold)',  bg: 'rgba(201,169,97,0.14)' },
  { value: 'pre_op_assessment',   label: 'Pre-Op Assessment',  color: 'var(--violet)',bg: 'rgba(118,87,232,0.14)' },
  { value: 'in_theatre',         label: 'In Theatre',         color: 'var(--blue)',   bg: 'rgba(76,141,255,0.14)' },
  { value: 'recovery',           label: 'Recovery',           color: 'var(--teal)',   bg: 'var(--teal-soft)' },
  { value: 'completed',          label: 'Completed',          color: 'var(--teal)',   bg: 'var(--teal-soft)' },
  { value: 'cancelled',          label: 'Cancelled',           color: 'var(--danger)', bg: 'rgba(225,104,94,0.14)' },
]

const CATEGORIES = [
  { value: 'elective',  label: 'Elective' },
  { value: 'urgent',    label: 'Urgent' },
  { value: 'emergency', label: 'Emergency' },
]

const LATERALITIES = [
  { value: 'left',     label: 'Left' },
  { value: 'right',    label: 'Right' },
  { value: 'bilateral', label: 'Bilateral' },
  { value: 'n/a',      label: 'N/A' },
]

const ASA_CLASSES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'n/a']

const ANESTHESIA_TYPES = [
  { value: 'general',  label: 'General' },
  { value: 'spinal',   label: 'Spinal' },
  { value: 'epidural', label: 'Epidural' },
  { value: 'local',    label: 'Local' },
  { value: 'regional', label: 'Regional' },
  { value: 'sedation', label: 'Sedation' },
  { value: 'none',     label: 'None' },
]

const DISPOSITIONS = [
  { value: 'home',     label: 'Discharged Home' },
  { value: 'ward',     label: 'Ward Admission' },
  { value: 'icu',      label: 'ICU' },
  { value: 'hdw',      label: 'High Dependency Ward' },
  { value: 'transfer', label: 'Transferred Out' },
  { value: 'death',    label: 'Death' },
]

function fmtDateTime(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleString()
}

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString()
}

function toDateTimeLocal(isoStr) {
  if (!isoStr) return ''
  const dt = new Date(isoStr)
  if (Number.isNaN(dt.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

function fromDateTimeLocal(value) {
  if (!value) return null
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString()
}

export default function OperatingTheatre() {
  const { profile, hospital } = useAuth()
  const { records: cases, addRecord: addCase, updateRecord: updateCase, syncFromServer: syncCases } = useOfflineTable('theatre_cases', hospital?.id)
  const { records: patients } = useOfflineTable('patients', hospital?.id)

  // Realtime: refresh case list when changes happen elsewhere.
  useRealtimeAlert('theatre_cases', hospital?.id, () => { syncCases() })

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [profilePatientId, setProfilePatientId] = useState(null)
  const [showNewCaseModal, setShowNewCaseModal] = useState(false)
  const [editingCase, setEditingCase] = useState(null) // case object — opens detail modal

  if (profilePatientId) {
    return <PatientProfile patientId={profilePatientId} onClose={() => setProfilePatientId(null)} />
  }

  // Enrich cases with patient name
  const casesWithPatient = useMemo(() => {
    return cases.map(c => {
      const patient = patients.find(p => p.id === c.patient_id)
      return { ...c, patient_name: patient?.full_name || 'Unknown patient', patient }
    })
  }, [cases, patients])

  // Sorted: scheduled start DESC (most recent first)
  const sorted = useMemo(() => {
    return [...casesWithPatient].sort((a, b) => {
      const sa = a.scheduled_start ? new Date(a.scheduled_start).getTime() : 0
      const sb = b.scheduled_start ? new Date(b.scheduled_start).getTime() : 0
      return sb - sa
    })
  }, [casesWithPatient])

  const filtered = useMemo(() => {
    let list = sorted
    if (statusFilter !== 'all') list = list.filter(c => c.status === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(c =>
        (c.patient_name || '').toLowerCase().includes(q) ||
        (c.procedure_name || '').toLowerCase().includes(q) ||
        (c.case_number || '').toLowerCase().includes(q) ||
        (c.surgeon_name || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [sorted, search, statusFilter])

  // Summary stats
  const stats = useMemo(() => {
    const total = casesWithPatient.length
    const scheduled = casesWithPatient.filter(c => c.status === 'scheduled').length
    const inProgress = casesWithPatient.filter(c => ['pre_op_assessment', 'in_theatre'].includes(c.status)).length
    const inRecovery = casesWithPatient.filter(c => c.status === 'recovery').length
    const completedToday = casesWithPatient.filter(c => {
      if (c.status !== 'completed') return false
      const e = c.actual_end || c.updated_at
      if (!e) return false
      const today = new Date(); today.setHours(0, 0, 0, 0)
      return new Date(e) >= today
    }).length
    return { total, scheduled, inProgress, inRecovery, completedToday }
  }, [casesWithPatient])

  const {
    currentPage, totalPages, totalItems, startIndex, endIndex, pageSize,
    pageItems, setPage, setPageSize,
  } = usePagination({ items: filtered, initialPageSize: 10 })

  // ---- Case detail save handler (partial updates — same pattern as
  // PatientProfile's updatePatient). Each section of the detail modal
  // calls updateCase(id, partialPayload) + writeAudit.
  async function handleCaseUpdate(theCase, updates, section) {
    try {
      await updateCase(theCase.id, updates)
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: `theatre.case_${section}_updated`,
        entityType: 'theatre_case', entityId: theCase.id,
        patientId: theCase.patient_id,
        summary: `Updated ${section} for theatre case "${theCase.procedure_name}" (${theCase.case_number || theCase.id.slice(0, 8)}) — patient ${theCase.patient_name}`,
        metadata: { case_id: theCase.id, section, updates_keys: Object.keys(updates) },
      })
      // Refresh the editingCase object so the modal shows the latest values
      const updated = { ...theCase, ...updates }
      setEditingCase(updated)
    } catch (err) {
      window.alert(`Could not save ${section}: ${err.message || err}`)
    }
  }

  async function handleStatusChange(theCase, newStatus) {
    if (newStatus === theCase.status) return
    const updates = { status: newStatus }
    // Auto-stamp timestamps when transitioning through workflow stages
    const now = new Date().toISOString()
    if (newStatus === 'in_theatre' && !theCase.actual_start) updates.actual_start = now
    if (newStatus === 'recovery' && !theCase.actual_end) updates.actual_end = now
    if (newStatus === 'recovery' && !theCase.recovery_room_entry) updates.recovery_room_entry = now
    if (newStatus === 'completed' && !theCase.recovery_room_exit) updates.recovery_room_exit = now
    await handleCaseUpdate(theCase, updates, 'status')
  }

  return (
    <>
      <div className="dash-stats" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}>
            <AppIcon name="bed" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Total Cases</div>
            <div className="dash-stat-value">{stats.total}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <AppIcon name="calendar" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Scheduled</div>
            <div className="dash-stat-value">{stats.scheduled}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(76,141,255,0.14)', color: 'var(--blue)' }}>
            <AppIcon name="activity" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">In Progress</div>
            <div className="dash-stat-value">{stats.inProgress}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <AppIcon name="check" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">In Recovery / Done Today</div>
            <div className="dash-stat-value">{stats.inRecovery} / {stats.completedToday}</div>
          </div>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Operating Theatre</div>
            <div className="dash-panel-sub">{hospital?.name || 'your hospital'} · surgical case management</div>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search patient / procedure / case # / surgeon…" />
          <button className="btn btn-primary" style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }} onClick={() => setShowNewCaseModal(true)}>+ New Case</button>
          <ModuleHistoryButton moduleKey="operating_theatre" />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {[
            { v: 'all', label: `All (${stats.total})` },
            ...STATUS_FLOW.map(s => ({
              v: s.value,
              label: `${s.label} (${casesWithPatient.filter(c => c.status === s.value).length})`,
            })),
          ].map(chip => (
            <button
              key={chip.v}
              type="button"
              className="btn btn-ghost"
              style={{
                width: 'auto', padding: '6px 12px', fontSize: 12,
                borderColor: statusFilter === chip.v ? 'var(--teal)' : 'var(--line)',
                color: statusFilter === chip.v ? 'var(--teal)' : 'var(--text)',
              }}
              onClick={() => setStatusFilter(chip.v)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="dash-empty-state">No theatre cases match this filter. Click "+ New Case" to schedule one.</div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Case #</th>
                    <th>Patient</th>
                    <th>Procedure</th>
                    <th>Scheduled</th>
                    <th>Surgeon</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(c => {
                    const statusInfo = STATUS_FLOW.find(s => s.value === c.status) || STATUS_FLOW[0]
                    return (
                      <tr key={c.id}>
                        <td style={{ padding: 12, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{c.case_number || c.id.slice(0, 8)}</td>
                        <td style={{ padding: 12 }}>
                          <div style={{ fontWeight: 700 }}>{c.patient_name}</div>
                          {c.patient?.hospital_number && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.patient.hospital_number}</div>}
                        </td>
                        <td style={{ padding: 12 }}>
                          <div>{c.procedure_name}</div>
                          {c.category && (
                            <div style={{ fontSize: 11, color: c.category === 'emergency' ? 'var(--danger)' : c.category === 'urgent' ? 'var(--gold)' : 'var(--muted)', marginTop: 2 }}>
                              {CATEGORIES.find(x => x.value === c.category)?.label || c.category}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: 12, fontSize: 12 }}>
                          {c.scheduled_start ? fmtDateTime(c.scheduled_start) : '—'}
                          {c.theatre_room && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.theatre_room}</div>}
                        </td>
                        <td style={{ padding: 12, fontSize: 12 }}>{c.surgeon_name || '—'}</td>
                        <td style={{ padding: 12 }}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: statusInfo.bg, color: statusInfo.color }}>
                            {statusInfo.label}
                          </span>
                        </td>
                        <td style={{ padding: 12, textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setEditingCase(c)}>Open</button>
                            <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setProfilePatientId(c.patient_id)}>Profile</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              startIndex={startIndex}
              endIndex={endIndex}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="cases"
            />
          </>
        )}
      </div>

      {showNewCaseModal && (
        <NewCaseModal
          patients={patients}
          onClose={() => setShowNewCaseModal(false)}
          onSave={async (payload) => {
            // Auto-generate case number: OT-<year>-<5-digit-sequence>
            const year = new Date().getFullYear()
            const seq = String(cases.length + 1).padStart(5, '0')
            const caseNumber = `OT-${year}-${seq}`
            const newCase = await addCase({
              ...payload,
              hospital_id: hospital.id,
              case_number: caseNumber,
              status: 'scheduled',
            })
            writeAudit({
              hospitalId: hospital?.id, actor: profile,
              action: 'theatre.case_created',
              entityType: 'theatre_case', entityId: newCase.id,
              patientId: payload.patient_id,
              summary: `Scheduled new theatre case ${caseNumber}: "${payload.procedure_name}" for ${patients.find(p => p.id === payload.patient_id)?.full_name || 'patient'}`,
              metadata: { case_id: newCase.id, case_number: caseNumber, procedure: payload.procedure_name, scheduled_start: payload.scheduled_start },
            })
            setShowNewCaseModal(false)
            setEditingCase({ ...newCase, patient_name: patients.find(p => p.id === payload.patient_id)?.full_name, patient: patients.find(p => p.id === payload.patient_id) })
          }}
        />
      )}

      {editingCase && (
        <CaseDetailModal
          theCase={editingCase}
          onClose={() => setEditingCase(null)}
          onUpdate={handleCaseUpdate}
          onStatusChange={handleStatusChange}
        />
      )}
    </>
  )
}

// =====================================================================
// NewCaseModal — minimal scheduling form (patient + procedure + date)
// =====================================================================
function NewCaseModal({ patients, onClose, onSave }) {
  const [patient, setPatient] = useState(null)
  const [procedureName, setProcedureName] = useState('')
  const [category, setCategory] = useState('elective')
  const [scheduledStart, setScheduledStart] = useState('')
  const [theatreRoom, setTheatreRoom] = useState('Theatre 1')
  const [surgeonName, setSurgeonName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!patient) return setError('Select a patient.')
    if (!procedureName.trim()) return setError('Procedure name is required.')
    setSaving(true)
    try {
      await onSave({
        patient_id: patient.id,
        procedure_name: procedureName.trim(),
        category,
        scheduled_start: scheduledStart ? fromDateTimeLocal(scheduledStart) : null,
        theatre_room: theatreRoom.trim() || null,
        surgeon_name: surgeonName.trim() || null,
      })
    } catch (err) {
      setError(err.message || 'Could not create case.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 520, width: 'calc(100% - 32px)' }}>
        <div className="dash-modal-title">New Theatre Case</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Schedule a surgery — more detail can be added after creation.</div>
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Patient *</label>
            <PatientAutocomplete
              patients={patients}
              value={patient ? { id: patient.id, label: patient.full_name, patient } : null}
              onChange={opt => setPatient(opt?.patient || null)}
              ariaLabel="Patient"
            />
          </div>
          <div className="dash-field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Procedure Name *</label>
              <input value={procedureName} onChange={e => setProcedureName(e.target.value)} placeholder="e.g. Appendectomy, C-Section, Hernia repair" />
            </div>
            <div className="field">
              <label>Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Scheduled Start</label>
              <input type="datetime-local" value={scheduledStart} onChange={e => setScheduledStart(e.target.value)} />
            </div>
            <div className="field">
              <label>Theatre Room</label>
              <input value={theatreRoom} onChange={e => setTheatreRoom(e.target.value)} />
            </div>
            <div className="field">
              <label>Surgeon Name</label>
              <input value={surgeonName} onChange={e => setSurgeonName(e.target.value)} placeholder="Dr. name" />
            </div>
          </div>
          <div className="dash-modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Schedule Case'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// =====================================================================
// CaseDetailModal — full case view with editable sections
// =====================================================================
function CaseDetailModal({ theCase, onClose, onUpdate, onStatusChange }) {
  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 820, width: 'calc(100% - 32px)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="dash-modal-title">{theCase.procedure_name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
          {theCase.patient_name}{theCase.case_number ? ` · ${theCase.case_number}` : ''}
        </div>

        {/* Status workflow bar */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {STATUS_FLOW.map(s => {
            const active = theCase.status === s.value
            return (
              <button
                key={s.value}
                type="button"
                className="btn btn-ghost"
                disabled={theCase.status === 'completed' || theCase.status === 'cancelled'}
                style={{
                  width: 'auto', padding: '5px 11px', fontSize: 11,
                  background: active ? s.bg : 'transparent',
                  color: active ? s.color : 'var(--muted)',
                  borderColor: active ? s.color : 'var(--line)',
                  fontWeight: active ? 700 : 500,
                }}
                onClick={() => onStatusChange(theCase, s.value)}
                title={`Set status to ${s.label}`}
              >
                {s.label}
              </button>
            )
          })}
        </div>

        <CaseSection title="Scheduling" defaultOpen>
          <EditableRow label="Procedure" value={theCase.procedure_name} onSave={v => onUpdate(theCase, { procedure_name: v }, 'scheduling')} />
          <EditableRow label="Procedure Code" value={theCase.procedure_code || ''} onSave={v => onUpdate(theCase, { procedure_code: v || null }, 'scheduling')} />
          <EditableRow label="Category" type="select" options={CATEGORIES} value={theCase.category || 'elective'} onSave={v => onUpdate(theCase, { category: v }, 'scheduling')} />
          <EditableRow label="Laterality" type="select" options={LATERALITIES} value={theCase.laterality || 'n/a'} onSave={v => onUpdate(theCase, { laterality: v }, 'scheduling')} />
          <EditableRow label="Scheduled Start" type="datetime" value={theCase.scheduled_start} onSave={v => onUpdate(theCase, { scheduled_start: v }, 'scheduling')} />
          <EditableRow label="Scheduled End" type="datetime" value={theCase.scheduled_end} onSave={v => onUpdate(theCase, { scheduled_end: v }, 'scheduling')} />
          <EditableRow label="Theatre Room" value={theCase.theatre_room || ''} onSave={v => onUpdate(theCase, { theatre_room: v || null }, 'scheduling')} />
        </CaseSection>

        <CaseSection title="Pre-Op Assessment">
          <EditableRow label="Pre-Op Diagnosis" value={theCase.pre_op_diagnosis || ''} onSave={v => onUpdate(theCase, { pre_op_diagnosis: v || null }, 'pre_op')} />
          <EditableRow label="ASA Classification" type="select" options={ASA_CLASSES.map(a => ({ value: a, label: a }))} value={theCase.asa_classification || 'n/a'} onSave={v => onUpdate(theCase, { asa_classification: v }, 'pre_op')} />
          <EditableRow label="Fasting Status" type="select" options={[{ value: 'fasted', label: 'Fasted' }, { value: 'not_fasted', label: 'Not Fasted' }, { value: 'unknown', label: 'Unknown' }]} value={theCase.fasting_status || 'unknown'} onSave={v => onUpdate(theCase, { fasting_status: v }, 'pre_op')} />
          <EditableRow label="Consent Obtained" type="checkbox" value={!!theCase.consent_obtained} onSave={v => onUpdate(theCase, { consent_obtained: v }, 'pre_op')} />
          <EditableRow label="Pre-Op Notes" type="textarea" value={theCase.pre_op_notes || ''} onSave={v => onUpdate(theCase, { pre_op_notes: v || null }, 'pre_op')} />
        </CaseSection>

        <CaseSection title="Theatre Team">
          <EditableRow label="Surgeon" value={theCase.surgeon_name || ''} onSave={v => onUpdate(theCase, { surgeon_name: v || null }, 'team')} />
          <EditableRow label="Anaesthetist" value={theCase.anesthetist_name || ''} onSave={v => onUpdate(theCase, { anesthetist_name: v || null }, 'team')} />
          <EditableRow label="Scrub Nurse" value={theCase.scrub_nurse_name || ''} onSave={v => onUpdate(theCase, { scrub_nurse_name: v || null }, 'team')} />
          <EditableRow label="Circulating Nurse" value={theCase.circulating_nurse || ''} onSave={v => onUpdate(theCase, { circulating_nurse: v || null }, 'team')} />
        </CaseSection>

        <CaseSection title="Anaesthesia">
          <EditableRow label="Type" type="select" options={ANESTHESIA_TYPES} value={theCase.anesthesia_type || 'none'} onSave={v => onUpdate(theCase, { anesthesia_type: v }, 'anaesthesia')} />
          <EditableRow label="Notes" type="textarea" value={theCase.anesthesia_notes || ''} onSave={v => onUpdate(theCase, { anesthesia_notes: v || null }, 'anaesthesia')} />
        </CaseSection>

        <CaseSection title="Intra-Op">
          <EditableRow label="Actual Start" type="datetime" value={theCase.actual_start} onSave={v => onUpdate(theCase, { actual_start: v }, 'intra_op')} />
          <EditableRow label="Actual End" type="datetime" value={theCase.actual_end} onSave={v => onUpdate(theCase, { actual_end: v }, 'intra_op')} />
          <EditableRow label="Procedure Performed" value={theCase.procedure_performed || ''} onSave={v => onUpdate(theCase, { procedure_performed: v || null }, 'intra_op')} />
          <EditableRow label="Intra-Op Findings" type="textarea" value={theCase.intra_op_findings || ''} onSave={v => onUpdate(theCase, { intra_op_findings: v || null }, 'intra_op')} />
          <EditableRow label="Complications" type="textarea" value={theCase.complications || ''} onSave={v => onUpdate(theCase, { complications: v || null }, 'intra_op')} />
          <EditableRow label="Blood Loss (ml)" type="number" value={theCase.blood_loss_ml ?? ''} onSave={v => onUpdate(theCase, { blood_loss_ml: v === '' ? null : parseInt(v, 10) }, 'intra_op')} />
          <EditableRow label="Fluids Given (ml)" type="number" value={theCase.fluids_given_ml ?? ''} onSave={v => onUpdate(theCase, { fluids_given_ml: v === '' ? null : parseInt(v, 10) }, 'intra_op')} />
          <EditableRow label="Specimens Sent" value={theCase.specimens_sent || ''} onSave={v => onUpdate(theCase, { specimens_sent: v || null }, 'intra_op')} />
          <EditableRow label="Implants Used" value={theCase.implants_used || ''} onSave={v => onUpdate(theCase, { implants_used: v || null }, 'intra_op')} />
        </CaseSection>

        <CaseSection title="Post-Op / Recovery">
          <EditableRow label="Recovery Room Entry" type="datetime" value={theCase.recovery_room_entry} onSave={v => onUpdate(theCase, { recovery_room_entry: v }, 'post_op')} />
          <EditableRow label="Recovery Room Exit" type="datetime" value={theCase.recovery_room_exit} onSave={v => onUpdate(theCase, { recovery_room_exit: v }, 'post_op')} />
          <EditableRow label="Post-Op Diagnosis" value={theCase.post_op_diagnosis || ''} onSave={v => onUpdate(theCase, { post_op_diagnosis: v || null }, 'post_op')} />
          <EditableRow label="Post-Op Notes" type="textarea" value={theCase.post_op_notes || ''} onSave={v => onUpdate(theCase, { post_op_notes: v || null }, 'post_op')} />
          <EditableRow label="Disposition" type="select" options={DISPOSITIONS} value={theCase.disposition || 'ward'} onSave={v => onUpdate(theCase, { disposition: v }, 'post_op')} />
        </CaseSection>

        <div style={{ marginTop: 18, fontSize: 11, color: 'var(--muted)' }}>
          Created {fmtDateTime(theCase.created_at)} · Last updated {fmtDateTime(theCase.updated_at)}
        </div>

        <div className="dash-modal-actions" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// CaseSection — collapsible section with title
// =====================================================================
function CaseSection({ title, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 12, paddingTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 13, fontWeight: 700, color: 'var(--text)',
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10,
        }}
      >
        <AppIcon name={open ? 'chevron' : 'arrowRight'} size={14} />
        {title}
      </button>
      {open && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div>}
    </div>
  )
}

// =====================================================================
// EditableRow — click-to-edit label/value row with save-on-blur
// =====================================================================
function EditableRow({ label, value, type, options, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function startEdit() { setDraft(value); setEditing(true) }
  function save() {
    setEditing(false)
    if (type === 'checkbox') {
      onSave(!value)
      return
    }
    if (type === 'datetime') {
      onSave(fromDateTimeLocal(draft))
      return
    }
    if (draft !== value) onSave(draft)
  }

  const displayValue = (() => {
    if (type === 'checkbox') return value ? 'Yes' : 'No'
    if (type === 'datetime') return fmtDateTime(value)
    if (type === 'select' && options) {
      return options.find(o => o.value === value)?.label || value || '—'
    }
    return value || '—'
  })()

  return (
    <div className="field">
      <label>{label}</label>
      {editing ? (
        type === 'select' ? (
          <select
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={save}
          >
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : type === 'checkbox' ? (
          <input type="checkbox" checked={!!value} onChange={save} autoFocus />
        ) : type === 'datetime' ? (
          <input
            type="datetime-local"
            value={toDateTimeLocal(value)}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={save}
          />
        ) : type === 'textarea' ? (
          <textarea
            rows={2}
            value={draft ?? ''}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={save}
          />
        ) : type === 'number' ? (
          <input
            type="number"
            value={draft ?? ''}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={save}
          />
        ) : (
          <input
            value={draft ?? ''}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={save}
          />
        )
      ) : (
        <div
          onClick={startEdit}
          style={{
            minHeight: 32, padding: '6px 10px', borderRadius: 6,
            border: '1px solid var(--line)', cursor: 'pointer',
            fontSize: 13, background: 'var(--bg-elevated)',
            wordBreak: 'break-word', whiteSpace: 'pre-wrap',
          }}
          title="Click to edit"
        >
          {displayValue}
        </div>
      )}
    </div>
  )
}
