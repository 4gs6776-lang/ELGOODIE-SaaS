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
// GOODIE-MEDHUB — Discharge module
// ---------------------------------------------------------------------
// Multi-step discharge workflow:
//   Step 1 (Doctor):  Writes discharge summary, discharge diagnosis,
//                     take-home drugs, follow-up plan.
//   Step 2 (Nurse):   Confirms patient condition, records nursing
//                     discharge notes.
//   Step 3 (Billing): Verifies payment status, clears outstanding
//                     balance (or flags as outstanding / waived).
//   Step 4 (Final):   Final sign-off — patient is marked discharged;
//                     their queue_status flips to 'discharged'.
//
// Take-home drugs are stored as a JSONB array on the discharge row.
// They are NOT billable charges by default (the doctor's "go home
// with these" instructions). If the cashier wants to bill for them,
// the discharge UI has a "Send to Pharmacy" button that creates
// billable_charges (status 'pending') for each drug — the patient
// then pays at the pharmacy counter, the drugs are dispensed, and
// the dispense flow runs as normal.
//
// Migration: 105_discharge_requests.sql
// =====================================================================

const STATUS_FLOW = [
  { value: 'doctor_pending',       label: 'Doctor Pending',        color: 'var(--gold)',   bg: 'rgba(201,169,97,0.14)' },
  { value: 'nurse_pending',         label: 'Nurse Pending',         color: 'var(--violet)', bg: 'rgba(118,87,232,0.14)' },
  { value: 'billing_pending',       label: 'Billing Pending',       color: 'var(--blue)',   bg: 'rgba(76,141,255,0.14)' },
  { value: 'ready_for_discharge',   label: 'Ready for Discharge',   color: 'var(--teal)',   bg: 'var(--teal-soft)' },
  { value: 'discharged',            label: 'Discharged',            color: 'var(--teal)',   bg: 'var(--teal-soft)' },
  { value: 'cancelled',             label: 'Cancelled',             color: 'var(--danger)', bg: 'rgba(225,104,94,0.14)' },
]

const DISCHARGE_TYPES = [
  { value: 'home',       label: 'Home Discharge' },
  { value: 'transfer',   label: 'Transfer to Another Facility' },
  { value: 'ama',        label: 'Against Medical Advice (AMA)' },
  { value: 'death',      label: 'Death' },
  { value: 'absconded',  label: 'Absconded' },
]

const PATIENT_CONDITIONS = [
  { value: 'stable',      label: 'Stable' },
  { value: 'improved',    label: 'Improved' },
  { value: 'unchanged',   label: 'Unchanged' },
  { value: 'deteriorated', label: 'Deteriorated' },
  { value: 'critical',    label: 'Critical' },
  { value: 'deceased',    label: 'Deceased' },
]

const PAYMENT_STATUSES = [
  { value: 'cleared',     label: 'Cleared' },
  { value: 'partial',     label: 'Partial Payment' },
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'waived',      label: 'Waived' },
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

function fmtMoney(n) {
  const v = Number(n || 0)
  return `₦${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function Discharge() {
  const { profile, hospital } = useAuth()
  const { records: dischargeRequests, addRecord: addDischarge, updateRecord: updateDischarge, syncFromServer: syncDischarges } = useOfflineTable('discharge_requests', hospital?.id)
  const { records: patients, updateRecord: updatePatient } = useOfflineTable('patients', hospital?.id)
  const { records: admissions, updateRecord: updateAdmission } = useOfflineTable('admissions', hospital?.id)
  const { records: invoices } = useOfflineTable('invoices', hospital?.id)
  const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id)
  const { records: pharmacyItems } = useOfflineTable('pharmacy_items', hospital?.id)

  useRealtimeAlert('discharge_requests', hospital?.id, () => { syncDischarges() })

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [profilePatientId, setProfilePatientId] = useState(null)
  const [showNewModal, setShowNewModal] = useState(false)
  const [editingId, setEditingId] = useState(null)

  if (profilePatientId) {
    return <PatientProfile patientId={profilePatientId} onClose={() => setProfilePatientId(null)} />
  }

  // Enrich discharge rows with patient + computed outstanding balance
  const enriched = useMemo(() => {
    return dischargeRequests.map(d => {
      const patient = patients.find(p => p.id === d.patient_id)
      const patientInvoices = invoices.filter(inv => inv.patient_id === d.patient_id || inv.patient_name === patient?.full_name)
      const outstanding = patientInvoices
        .filter(inv => inv.status === 'unpaid' || inv.status === 'partial')
        .reduce((sum, inv) => sum + Number(inv.balance ?? inv.amount ?? 0), 0)
      const activeAdmission = admissions.find(a => a.patient_id === d.patient_id && a.status === 'active')
      return { ...d, patient, patient_name: patient?.full_name || 'Unknown patient', outstandingBalance: outstanding, activeAdmission }
    })
  }, [dischargeRequests, patients, invoices, admissions])

  const sorted = useMemo(() => {
    return [...enriched].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [enriched])

  const filtered = useMemo(() => {
    let list = sorted
    if (statusFilter !== 'all') list = list.filter(d => d.status === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(d =>
        (d.patient_name || '').toLowerCase().includes(q) ||
        (d.discharge_diagnosis || '').toLowerCase().includes(q) ||
        (d.patient?.hospital_number || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [sorted, search, statusFilter])

  const stats = useMemo(() => {
    return {
      total: enriched.length,
      doctorPending: enriched.filter(d => d.status === 'doctor_pending').length,
      nursePending: enriched.filter(d => d.status === 'nurse_pending').length,
      billingPending: enriched.filter(d => d.status === 'billing_pending').length,
      ready: enriched.filter(d => d.status === 'ready_for_discharge').length,
      dischargedToday: enriched.filter(d => {
        if (d.status !== 'discharged') return false
        const e = d.final_discharged_at
        if (!e) return false
        const today = new Date(); today.setHours(0, 0, 0, 0)
        return new Date(e) >= today
      }).length,
    }
  }, [enriched])

  const editingCase = editingId ? enriched.find(d => d.id === editingId) : null

  async function handleUpdate(theDischarge, updates, sectionLabel) {
    try {
      await updateDischarge(theDischarge.id, updates)
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: `discharge.${sectionLabel}_updated`,
        entityType: 'discharge_request', entityId: theDischarge.id,
        patientId: theDischarge.patient_id,
        summary: `Updated ${sectionLabel} for discharge of ${theDischarge.patient_name}`,
        metadata: { discharge_id: theDischarge.id, section: sectionLabel, keys: Object.keys(updates) },
      })
    } catch (err) {
      window.alert(`Could not save: ${err.message || err}`)
    }
  }

  async function handleAdvance(theDischarge, newStatus) {
    if (newStatus === theDischarge.status) return
    const now = new Date().toISOString()
    const updates = { status: newStatus }

    // Stamp the signer when moving past each gate
    if (newStatus === 'nurse_pending' && !theDischarge.doctor_signed_at) {
      updates.doctor_signed_at = now
      updates.doctor_id = profile?.id || null
      updates.doctor_name = profile?.full_name || null
    }
    if (newStatus === 'billing_pending' && !theDischarge.nurse_signed_at) {
      updates.nurse_signed_at = now
      updates.nurse_id = profile?.id || null
      updates.nurse_name = profile?.full_name || null
    }
    if (newStatus === 'ready_for_discharge' && !theDischarge.billing_signed_at) {
      updates.billing_signed_at = now
      updates.billing_staff_id = profile?.id || null
      updates.billing_staff_name = profile?.full_name || null
    }
    if (newStatus === 'discharged' && !theDischarge.final_discharged_at) {
      updates.final_discharged_at = now
      updates.final_discharged_by = profile?.id || null
      updates.final_discharged_by_name = profile?.full_name || null
    }

    await handleUpdate(theDischarge, updates, 'status')

    // When fully discharged, also flip the patient's queue_status so
    // they leave the active queue AND mark any active admission as
    // discharged (frees the bed).
    if (newStatus === 'discharged') {
      try {
        await updatePatient(theDischarge.patient_id, {
          queue_status: 'discharged',
          queue_updated_at: now,
        })
      } catch (e) { /* patient update failed — non-fatal */ }
      if (theDischarge.activeAdmission) {
        try {
          await updateAdmission(theDischarge.activeAdmission.id, {
            status: 'discharged',
            discharged_at: now,
            discharged_by: profile?.id || null,
          })
        } catch (e) { /* admission update failed — non-fatal */ }
      }
    }
  }

  // Convert take-home drugs to billable charges (so the cashier /
  // pharmacy can dispense them through the normal flow).
  async function sendTakeHomeToPharmacy(theDischarge) {
    if (!theDischarge.take_home_drugs || !Array.isArray(theDischarge.take_home_drugs) || theDischarge.take_home_drugs.length === 0) {
      window.alert('No take-home drugs recorded for this discharge.')
      return
    }
    if (!window.confirm(`Send ${theDischarge.take_home_drugs.length} take-home drug(s) to the Billing Queue?\n\nThe cashier will see pending charges for each drug — the patient pays, then the pharmacy dispenses.`)) return
    try {
      for (const drug of theDischarge.take_home_drugs) {
        // Look up the pharmacy item to get its current selling price
        const item = pharmacyItems.find(p => (p.name || '').toLowerCase() === String(drug.drug || '').toLowerCase())
        const unitPrice = item ? Number(item.selling_price || 0) : Number(drug.unit_price || 0)
        const qty = Number(drug.quantity || 1)
        await addBillableCharge({
          hospital_id: hospital.id,
          patient_id: theDischarge.patient_id,
          patient_name: theDischarge.patient_name,
          source_module: 'Discharge',
          source_transaction_id: `DISCH-${theDischarge.id.slice(0, 8)}-${Date.now().toString().slice(-4)}`,
          item_name: `${drug.drug}${drug.dosage ? ` ${drug.dosage}` : ''}`,
          category: 'Drug',
          quantity: qty,
          unit_price: unitPrice,
          total: unitPrice * qty,
          status: 'pending',
          created_by: profile?.id,
        })
      }
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'discharge.take_home_drugs_to_pharmacy',
        entityType: 'discharge_request', entityId: theDischarge.id,
        patientId: theDischarge.patient_id,
        summary: `Sent ${theDischarge.take_home_drugs.length} take-home drug(s) from discharge of ${theDischarge.patient_name} to the Billing Queue`,
        metadata: { discharge_id: theDischarge.id, drug_count: theDischarge.take_home_drugs.length },
      })
      window.alert(`${theDischarge.take_home_drugs.length} take-home drug(s) sent to Billing Queue.`)
    } catch (err) {
      window.alert(`Could not send drugs to pharmacy: ${err.message || err}`)
    }
  }

  const {
    currentPage, totalPages, totalItems, startIndex, endIndex, pageSize,
    pageItems, setPage, setPageSize,
  } = usePagination({ items: filtered, initialPageSize: 10 })

  return (
    <>
      <div className="dash-stats" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}>
            <AppIcon name="users" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Total Discharges</div>
            <div className="dash-stat-value">{stats.total}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <AppIcon name="doctor" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Doctor Pending</div>
            <div className="dash-stat-value">{stats.doctorPending}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(76,141,255,0.14)', color: 'var(--blue)' }}>
            <AppIcon name="billing" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Billing Pending</div>
            <div className="dash-stat-value">{stats.billingPending}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <AppIcon name="check" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Ready / Discharged Today</div>
            <div className="dash-stat-value">{stats.ready} / {stats.dischargedToday}</div>
          </div>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Discharge Workflow</div>
            <div className="dash-panel-sub">{hospital?.name || 'your hospital'} · doctor → nurse → billing → final</div>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search patient / diagnosis / MRN…" />
          <button className="btn btn-primary" style={{ width: 'auto', padding: '8px 16px', fontSize: 13 }} onClick={() => setShowNewModal(true)}>+ New Discharge</button>
          <ModuleHistoryButton moduleKey="discharge" />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {[
            { v: 'all', label: `All (${stats.total})` },
            ...STATUS_FLOW.map(s => ({
              v: s.value,
              label: `${s.label} (${enriched.filter(d => d.status === s.value).length})`,
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
          <div className="dash-empty-state">No discharge requests match this filter. Click "+ New Discharge" to start one.</div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Outstanding</th>
                    <th>Created</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(d => {
                    const statusInfo = STATUS_FLOW.find(s => s.value === d.status) || STATUS_FLOW[0]
                    return (
                      <tr key={d.id}>
                        <td style={{ padding: 12 }}>
                          <div style={{ fontWeight: 700 }}>{d.patient_name}</div>
                          {d.patient?.hospital_number && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.patient.hospital_number}</div>}
                        </td>
                        <td style={{ padding: 12, fontSize: 12 }}>
                          {DISCHARGE_TYPES.find(t => t.value === d.discharge_type)?.label || '—'}
                        </td>
                        <td style={{ padding: 12 }}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: statusInfo.bg, color: statusInfo.color }}>
                            {statusInfo.label}
                          </span>
                        </td>
                        <td style={{ padding: 12, fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: d.outstandingBalance > 0 ? 'var(--danger)' : 'var(--teal)' }}>
                          {fmtMoney(d.outstandingBalance)}
                        </td>
                        <td style={{ padding: 12, fontSize: 12 }}>{fmtDateTime(d.created_at)}</td>
                        <td style={{ padding: 12, textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setEditingId(d.id)}>Open</button>
                            <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setProfilePatientId(d.patient_id)}>Profile</button>
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
              itemLabel="discharges"
            />
          </>
        )}
      </div>

      {showNewModal && (
        <NewDischargeModal
          patients={patients}
          admissions={admissions}
          onClose={() => setShowNewModal(false)}
          onSave={async (payload) => {
            const newDischarge = await addDischarge({
              ...payload,
              hospital_id: hospital.id,
              status: 'doctor_pending',
              created_by: profile?.id,
            })
            writeAudit({
              hospitalId: hospital?.id, actor: profile,
              action: 'discharge.created',
              entityType: 'discharge_request', entityId: newDischarge.id,
              patientId: payload.patient_id,
              summary: `Initiated discharge request for ${patients.find(p => p.id === payload.patient_id)?.full_name || 'patient'}`,
              metadata: { discharge_id: newDischarge.id, discharge_type: payload.discharge_type },
            })
            setShowNewModal(false)
            setEditingId(newDischarge.id)
          }}
        />
      )}

      {editingCase && (
        <DischargeDetailModal
          theDischarge={editingCase}
          onClose={() => setEditingId(null)}
          onUpdate={handleUpdate}
          onAdvance={handleAdvance}
          onSendToPharmacy={sendTakeHomeToPharmacy}
        />
      )}
    </>
  )
}

// =====================================================================
// NewDischargeModal — start a discharge request
// =====================================================================
function NewDischargeModal({ patients, admissions, onClose, onSave }) {
  const [patient, setPatient] = useState(null)
  const [dischargeType, setDischargeType] = useState('home')
  const [admissionId, setAdmissionId] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Filter to patients currently admitted (in active admissions) — those
  // are the ones needing discharge. But we allow ANY patient so the
  // doctor can discharge outpatients / emergency cases too.
  const admittedPatientIds = useMemo(() => {
    return new Set(admissions.filter(a => a.status === 'active').map(a => a.patient_id))
  }, [admissions])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!patient) return setError('Select a patient.')
    setSaving(true)
    try {
      await onSave({
        patient_id: patient.id,
        discharge_type: dischargeType,
        admission_id: admissionId || null,
      })
    } catch (err) {
      setError(err.message || 'Could not create discharge request.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 480, width: 'calc(100% - 32px)' }}>
        <div className="dash-modal-title">Start Discharge Request</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Choose the patient and the discharge type. The doctor can then fill in the full discharge summary.</div>
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
            {patient && admittedPatientIds.has(patient.id) && (
              <div style={{ fontSize: 11.5, color: 'var(--teal)', marginTop: 4 }}>✓ Patient is currently admitted</div>
            )}
            {patient && !admittedPatientIds.has(patient.id) && (
              <div style={{ fontSize: 11.5, color: 'var(--gold)', marginTop: 4 }}>Note: patient has no active admission — outpatient discharge</div>
            )}
          </div>
          <div className="field">
            <label>Discharge Type *</label>
            <select value={dischargeType} onChange={e => setDischargeType(e.target.value)}>
              {DISCHARGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="dash-modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Start Discharge'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// =====================================================================
// DischargeDetailModal — multi-section workflow form
// =====================================================================
function DischargeDetailModal({ theDischarge, onClose, onUpdate, onAdvance, onSendToPharmacy }) {
  const currentStatusIdx = STATUS_FLOW.findIndex(s => s.value === theDischarge.status)
  const isFinal = theDischarge.status === 'discharged' || theDischarge.status === 'cancelled'
  const doctorDone = !!theDischarge.doctor_signed_at
  const nurseDone = !!theDischarge.nurse_signed_at
  const billingDone = !!theDischarge.billing_signed_at

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 820, width: 'calc(100% - 32px)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="dash-modal-title">Discharge — {theDischarge.patient_name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
          Created {fmtDateTime(theDischarge.created_at)} · Outstanding {fmtMoney(theDischarge.outstandingBalance)}
        </div>

        {/* Workflow progress bar */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {STATUS_FLOW.filter(s => s.value !== 'cancelled').map(s => {
            const idx = STATUS_FLOW.findIndex(x => x.value === s.value)
            const active = theDischarge.status === s.value
            const done = idx < currentStatusIdx
            return (
              <div
                key={s.value}
                style={{
                  padding: '5px 11px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                  background: active ? s.bg : done ? 'var(--teal-soft)' : 'var(--bg-elevated)',
                  color: active ? s.color : done ? 'var(--teal)' : 'var(--muted)',
                  border: `1px solid ${active || done ? s.color : 'var(--line)'}`,
                }}
              >
                {done ? '✓ ' : ''}{s.label}
              </div>
            )
          })}
        </div>

        {theDischarge.status === 'cancelled' && (
          <div className="error-box" style={{ marginBottom: 14 }}>This discharge was cancelled.</div>
        )}

        {/* ---- Doctor section ---- */}
        <Section title="1. Doctor — Discharge Summary" locked={doctorDone || isFinal}>
          <EditableRow label="Discharge Type" type="select" options={DISCHARGE_TYPES} value={theDischarge.discharge_type || 'home'} onSave={v => onUpdate(theDischarge, { discharge_type: v }, 'doctor')} />
          <EditableRow label="Admission Diagnosis" value={theDischarge.admission_diagnosis || ''} onSave={v => onUpdate(theDischarge, { admission_diagnosis: v || null }, 'doctor')} />
          <EditableRow label="Working Diagnosis" value={theDischarge.working_diagnosis || ''} onSave={v => onUpdate(theDischarge, { working_diagnosis: v || null }, 'doctor')} />
          <EditableRow label="Discharge Diagnosis" value={theDischarge.discharge_diagnosis || ''} onSave={v => onUpdate(theDischarge, { discharge_diagnosis: v || null }, 'doctor')} />
          <EditableRow label="Course in Hospital" type="textarea" value={theDischarge.course_in_hospital || ''} onSave={v => onUpdate(theDischarge, { course_in_hospital: v || null }, 'doctor')} />
          <EditableRow label="Investigations / Results" type="textarea" value={theDischarge.investigations || ''} onSave={v => onUpdate(theDischarge, { investigations: v || null }, 'doctor')} />
          <EditableRow label="Treatment Given" type="textarea" value={theDischarge.treatment_given || ''} onSave={v => onUpdate(theDischarge, { treatment_given: v || null }, 'doctor')} />
          <EditableRow label="Discharge Summary" type="textarea" value={theDischarge.discharge_summary || ''} onSave={v => onUpdate(theDischarge, { discharge_summary: v || null }, 'doctor')} />
          <EditableRow label="Follow-Up Plan" type="textarea" value={theDischarge.follow_up_plan || ''} onSave={v => onUpdate(theDischarge, { follow_up_plan: v || null }, 'doctor')} />
          <EditableRow label="Follow-Up Date" type="date" value={theDischarge.follow_up_date} onSave={v => onUpdate(theDischarge, { follow_up_date: v }, 'doctor')} />
          <EditableRow label="Deceased?" type="checkbox" value={!!theDischarge.is_deceased} onSave={v => onUpdate(theDischarge, { is_deceased: v, discharge_type: v ? 'death' : theDischarge.discharge_type }, 'doctor')} />
          {theDischarge.is_deceased && (
            <EditableRow label="Death Date / Time" type="datetime" value={theDischarge.death_date} onSave={v => onUpdate(theDischarge, { death_date: v }, 'doctor')} />
          )}
          {/* Take-home drugs — a sub-component */}
          <div style={{ gridColumn: '1 / -1' }}>
            <TakeHomeDrugsEditor
              drugs={theDischarge.take_home_drugs || []}
              onChange={drugs => onUpdate(theDischarge, { take_home_drugs: drugs }, 'doctor')}
            />
          </div>
          {!doctorDone && (
            <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onAdvance(theDischarge, 'nurse_pending')}
              >
                Sign off as Doctor → Send to Nurse
              </button>
            </div>
          )}
          {doctorDone && (
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--teal)', marginTop: 4 }}>
              ✓ Signed by {theDischarge.doctor_name || 'doctor'} on {fmtDateTime(theDischarge.doctor_signed_at)}
            </div>
          )}
        </Section>

        {/* ---- Nurse section ---- */}
        <Section title="2. Nurse — Discharge Confirmation" locked={nurseDone || isFinal || !doctorDone}>
          {!doctorDone && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Doctor must sign off first.</div>}
          <EditableRow label="Patient Condition at Discharge" type="select" options={PATIENT_CONDITIONS} value={theDischarge.patient_condition_at_discharge || 'stable'} onSave={v => onUpdate(theDischarge, { patient_condition_at_discharge: v }, 'nurse')} />
          <div style={{ gridColumn: '1 / -1' }}>
            <EditableRow label="Nursing Discharge Notes" type="textarea" value={theDischarge.nursing_discharge_notes || ''} onSave={v => onUpdate(theDischarge, { nursing_discharge_notes: v || null }, 'nurse')} />
          </div>
          {doctorDone && !nurseDone && (
            <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
              <button type="button" className="btn btn-primary" onClick={() => onAdvance(theDischarge, 'billing_pending')}>
                Sign off as Nurse → Send to Billing
              </button>
            </div>
          )}
          {nurseDone && (
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--teal)', marginTop: 4 }}>
              ✓ Signed by {theDischarge.nurse_name || 'nurse'} on {fmtDateTime(theDischarge.nurse_signed_at)}
            </div>
          )}
        </Section>

        {/* ---- Billing section ---- */}
        <Section title="3. Billing — Payment Clearance" locked={billingDone || isFinal || !nurseDone}>
          {!nurseDone && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Nurse must sign off first.</div>}
          <div style={{ gridColumn: '1 / -1', padding: 12, background: 'var(--bg-elevated)', borderRadius: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Outstanding Balance (snapshot)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: theDischarge.outstandingBalance > 0 ? 'var(--danger)' : 'var(--teal)' }}>{fmtMoney(theDischarge.outstandingBalance)}</div>
          </div>
          <EditableRow label="Payment Status" type="select" options={PAYMENT_STATUSES} value={theDischarge.payment_status || 'outstanding'} onSave={v => onUpdate(theDischarge, { payment_status: v, outstanding_balance: theDischarge.outstandingBalance }, 'billing')} />
          <EditableRow label="Billing Notes" type="textarea" value={theDischarge.billing_notes || ''} onSave={v => onUpdate(theDischarge, { billing_notes: v || null }, 'billing')} />
          {nurseDone && !billingDone && (
            <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
              <button type="button" className="btn btn-primary" onClick={() => onAdvance(theDischarge, 'ready_for_discharge')}>
                Sign off as Billing → Mark Ready for Discharge
              </button>
            </div>
          )}
          {billingDone && (
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--teal)', marginTop: 4 }}>
              ✓ Signed by {theDischarge.billing_staff_name || 'billing'} on {fmtDateTime(theDischarge.billing_signed_at)}
            </div>
          )}
        </Section>

        {/* ---- Final section ---- */}
        <Section title="4. Final — Discharge Patient" locked={isFinal || !billingDone}>
          {!billingDone && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Billing must clear first.</div>}
          {billingDone && !isFinal && (
            <div style={{ gridColumn: '1 / -1' }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: 'var(--teal)' }}
                onClick={() => onAdvance(theDischarge, 'discharged')}
              >
                ✓ Final Discharge — Patient Leaves Hospital
              </button>
            </div>
          )}
        </Section>

        {/* ---- Take-home drugs → pharmacy ---- */}
        {theDischarge.take_home_drugs && Array.isArray(theDischarge.take_home_drugs) && theDischarge.take_home_drugs.length > 0 && (
          <Section title="Take-Home Drugs → Pharmacy" locked={false}>
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                Send the take-home drugs to the Billing Queue so the cashier charges for them and the pharmacy dispenses. The drugs will appear as pending charges for this patient.
              </div>
              <button type="button" className="btn btn-ghost" style={{ borderColor: 'var(--violet)', color: 'var(--violet)' }} onClick={() => onSendToPharmacy(theDischarge)}>
                Send {theDischarge.take_home_drugs.length} drug(s) to Pharmacy →
              </button>
            </div>
          </Section>
        )}

        {/* ---- Cancel ---- */}
        {!isFinal && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
            <button
              type="button"
              className="btn btn-ghost dash-danger-btn"
              onClick={() => {
                if (window.confirm('Cancel this discharge request? The patient will NOT be discharged.')) {
                  onAdvance(theDischarge, 'cancelled')
                }
              }}
            >
              Cancel Discharge Request
            </button>
          </div>
        )}

        <div className="dash-modal-actions" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// TakeHomeDrugsEditor — list of take-home drugs (JSONB array)
// =====================================================================
function TakeHomeDrugsEditor({ drugs, onChange }) {
  function add() {
    onChange([...(drugs || []), { drug: '', dosage: '', frequency: '', duration: '', quantity: 1, instructions: '' }])
  }
  function update(idx, key, value) {
    const next = [...drugs]
    next[idx] = { ...next[idx], [key]: value }
    onChange(next)
  }
  function remove(idx) {
    onChange(drugs.filter((_, i) => i !== idx))
  }

  return (
    <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 10, marginTop: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Take-Home Drugs</div>
      {(!drugs || drugs.length === 0) && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>No take-home drugs added yet.</div>
      )}
      {drugs && drugs.map((d, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto', gap: 6, marginBottom: 6, alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 10 }}>Drug</label>
            <input value={d.drug || ''} onChange={e => update(i, 'drug', e.target.value)} placeholder="e.g. Paracetamol" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 10 }}>Dosage</label>
            <input value={d.dosage || ''} onChange={e => update(i, 'dosage', e.target.value)} placeholder="500mg" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 10 }}>Frequency</label>
            <input value={d.frequency || ''} onChange={e => update(i, 'frequency', e.target.value)} placeholder="BD" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 10 }}>Duration</label>
            <input value={d.duration || ''} onChange={e => update(i, 'duration', e.target.value)} placeholder="5 days" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 10 }}>Qty</label>
            <input type="number" min="1" value={d.quantity ?? 1} onChange={e => update(i, 'quantity', parseInt(e.target.value, 10) || 1)} />
          </div>
          <button type="button" className="icon-btn-delete" title="Remove" onClick={() => remove(i)}>✕</button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11, marginTop: 6 }} onClick={add}>+ Add Drug</button>
    </div>
  )
}

// =====================================================================
// Section — collapsible workflow section (locked = read-only)
// =====================================================================
function Section({ title, locked, children }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 14, paddingTop: 14 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 13, fontWeight: 700, color: 'var(--text)',
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, width: '100%',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AppIcon name={open ? 'chevron' : 'arrowRight'} size={14} />
          {title}
        </span>
        {locked && <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>locked</span>}
      </button>
      {open && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, opacity: locked ? 0.85 : 1 }}>{children}</div>}
    </div>
  )
}

// =====================================================================
// EditableRow — same pattern as OperatingTheatre.jsx
// =====================================================================
function EditableRow({ label, value, type, options, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function startEdit() { setDraft(value); setEditing(true) }
  function save() {
    setEditing(false)
    if (type === 'checkbox') { onSave(!value); return }
    if (type === 'datetime') { onSave(fromDateTimeLocalLocal(draft)); return }
    if (type === 'date') { onSave(draft || null); return }
    if (draft !== value) onSave(draft)
  }
  function fromDateTimeLocalLocal(v) {
    if (!v) return null
    const dt = new Date(v)
    if (Number.isNaN(dt.getTime())) return null
    return dt.toISOString()
  }
  function toDateTimeLocalLocal(isoStr) {
    if (!isoStr) return ''
    const dt = new Date(isoStr)
    if (Number.isNaN(dt.getTime())) return ''
    const pad = n => String(n).padStart(2, '0')
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
  }

  const displayValue = (() => {
    if (type === 'checkbox') return value ? 'Yes' : 'No'
    if (type === 'datetime') return fmtDateTime(value)
    if (type === 'date') return fmtDate(value)
    if (type === 'select' && options) return options.find(o => o.value === value)?.label || value || '—'
    return value || '—'
  })()

  return (
    <div className="field">
      <label>{label}</label>
      {editing ? (
        type === 'select' ? (
          <select value={draft} autoFocus onChange={e => setDraft(e.target.value)} onBlur={save}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : type === 'checkbox' ? (
          <input type="checkbox" checked={!!value} onChange={save} autoFocus />
        ) : type === 'datetime' ? (
          <input type="datetime-local" value={toDateTimeLocalLocal(value)} autoFocus onChange={e => setDraft(e.target.value)} onBlur={save} />
        ) : type === 'date' ? (
          <input type="date" value={draft || ''} autoFocus onChange={e => setDraft(e.target.value)} onBlur={save} />
        ) : type === 'textarea' ? (
          <textarea rows={3} value={draft ?? ''} autoFocus onChange={e => setDraft(e.target.value)} onBlur={save} />
        ) : (
          <input value={draft ?? ''} autoFocus onChange={e => setDraft(e.target.value)} onBlur={save} />
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
