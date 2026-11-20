import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import PatientProfile from '../../components/PatientProfile'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import AppIcon from '../../components/icons'
import { writeAudit } from '../../lib/audit'

// =====================================================================
// GOODIE-MEDHUB — Delivery module
// ---------------------------------------------------------------------
// Lists every ANC patient and their delivery status:
//   • Delivered — has a delivery record on file (anc_delivery_status='delivered')
//   • Pregnant — booked for ANC, awaiting delivery (anc_delivery_status='pregnant')
//   • Miscarried — pregnancy ended before viability (anc_delivery_status='miscarried')
//
// Midwives / OBGYNs can:
//   • Click "Record Delivery" on any pending patient to capture the full
//     clinical delivery record (delivery type, baby weight, APGAR,
//     complications, birth attendant, etc).
//   • Click "View" on any delivered patient to see the delivery summary
//     (read-only) AND open their patient profile.
//
// When a delivery is recorded, two writes happen:
//   1. A new row is inserted into `deliveries` (full clinical detail)
//   2. The patient's `anc_delivery_status` is set to 'delivered' AND
//      `anc_delivery_date` is set to the delivery date. This is what
//      makes the patient profile auto-update — PatientProfile reads
//      patients.anc_delivery_status / anc_delivery_date directly,
//      so the EDD section on the profile now shows "Delivered on <date>"
//      instead of the original EDD.
//
// Migration: 103_deliveries_table.sql
// =====================================================================

const DELIVERY_TYPES = [
  { value: 'vaginal',          label: 'Vaginal (SVD)' },
  { value: 'c_section',       label: 'Caesarean Section' },
  { value: 'assisted_vaginal', label: 'Assisted Vaginal (Forceps / Vacuum)' },
  { value: 'miscarriage',     label: 'Miscarriage' },
  { value: 'stillbirth',      label: 'Stillbirth' },
]

const LABOUR_ONSETS = [
  { value: 'spontaneous', label: 'Spontaneous' },
  { value: 'induced',     label: 'Induced' },
  { value: 'augmented',   label: 'Augmented' },
  { value: 'scheduled',   label: 'Scheduled (elective C-Section)' },
  { value: 'n/a',         label: 'N/A (miscarriage / stillbirth)' },
]

const BABY_GENDERS = [
  { value: 'male',      label: 'Male' },
  { value: 'female',    label: 'Female' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'unknown',   label: 'Unknown' },
]

const BABY_OUTCOMES = [
  { value: 'alive',           label: 'Alive' },
  { value: 'stillbirth',      label: 'Stillbirth' },
  { value: 'neonatal_death',  label: 'Neonatal Death' },
]

const ATTENDANT_ROLES = [
  { value: 'doctor',  label: 'Doctor' },
  { value: 'midwife', label: 'Midwife' },
  { value: 'nurse',   label: 'Nurse' },
  { value: 'other',   label: 'Other' },
]

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString()
}

function fmtDateTime(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleString()
}

function gestAgeFromLmp(lmpStr) {
  if (!lmpStr) return null
  const lmp = new Date(lmpStr)
  if (Number.isNaN(lmp.getTime())) return null
  const today = new Date()
  const days = Math.floor((today - lmp) / (1000 * 60 * 60 * 24))
  if (days < 0 || days > 320) return null
  return Math.floor(days / 7)
}

function trimesterFromLmp(lmpStr) {
  const w = gestAgeFromLmp(lmpStr)
  if (w == null) return null
  if (w < 13) return '1st trimester'
  if (w < 28) return '2nd trimester'
  return '3rd trimester'
}

function daysUntilEdd(eddStr) {
  if (!eddStr) return null
  const edd = new Date(eddStr)
  if (Number.isNaN(edd.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((edd - today) / (1000 * 60 * 60 * 24))
}

export default function Delivery() {
  const { profile, hospital } = useAuth()
  const { records: patients, updateRecord: updatePatient, syncFromServer: syncPatients } = useOfflineTable('patients', hospital?.id)
  const { records: deliveries, addRecord: addDelivery, syncFromServer: syncDeliveries } = useOfflineTable('deliveries', hospital?.id)

  // Realtime: when a delivery is recorded elsewhere (another device),
  // refresh both lists so the dashboard stays current.
  useRealtimeAlert('deliveries', hospital?.id, () => { syncDeliveries() })
  useRealtimeAlert('patients', hospital?.id, () => { syncPatients() })

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // all | pregnant | delivered | miscarried
  const [profilePatientId, setProfilePatientId] = useState(null)
  const [viewDeliveryFor, setViewDeliveryFor] = useState(null) // patientId — shows delivery summary modal
  const [recordFor, setRecordFor] = useState(null)             // patientId — opens record-delivery modal

  // All ANC patients + computed fields
  const ancPatients = useMemo(() => {
    return patients
      .filter(p => p.category === 'anc')
      .map(p => {
        const lastDelivery = deliveries
          .filter(d => d.patient_id === p.id)
          .sort((a, b) => new Date(b.delivery_date) - new Date(a.delivery_date))[0]
        return {
          ...p,
          gestAge: gestAgeFromLmp(p.anc_lmp),
          trimester: trimesterFromLmp(p.anc_lmp),
          daysUntilEdd: daysUntilEdd(p.anc_edd),
          deliveryStatus: p.anc_delivery_status || (lastDelivery ? 'delivered' : 'pregnant'),
          lastDelivery,
        }
      })
      .sort((a, b) => {
        // Delivered last so pending patients are at the top — they're
        // the ones needing attention. Within each group, sort by EDD
        // ascending (closest to delivery first).
        const statusOrder = { pregnant: 0, miscarried: 1, delivered: 2 }
        const sa = statusOrder[a.deliveryStatus] ?? 0
        const sb = statusOrder[b.deliveryStatus] ?? 0
        if (sa !== sb) return sa - sb
        const ea = a.daysUntilEdd ?? 9999
        const eb = b.daysUntilEdd ?? 9999
        return ea - eb
      })
  }, [patients, deliveries])

  // Filtered list
  const filtered = useMemo(() => {
    let list = ancPatients
    if (statusFilter !== 'all') list = list.filter(p => p.deliveryStatus === statusFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(p =>
        (p.full_name || '').toLowerCase().includes(q) ||
        (p.phone || '').toLowerCase().includes(q) ||
        (p.hospital_number || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [ancPatients, search, statusFilter])

  // Summary stats
  const stats = useMemo(() => {
    const total = ancPatients.length
    const delivered = ancPatients.filter(p => p.deliveryStatus === 'delivered').length
    const pregnant = ancPatients.filter(p => p.deliveryStatus === 'pregnant').length
    const miscarried = ancPatients.filter(p => p.deliveryStatus === 'miscarried').length
    const dueSoon = ancPatients.filter(p => p.deliveryStatus === 'pregnant' && p.daysUntilEdd != null && p.daysUntilEdd >= 0 && p.daysUntilEdd <= 30).length
    const overdue = ancPatients.filter(p => p.deliveryStatus === 'pregnant' && p.daysUntilEdd != null && p.daysUntilEdd < 0).length
    return { total, delivered, pregnant, miscarried, dueSoon, overdue }
  }, [ancPatients])

  // Pagination
  const {
    currentPage, totalPages, totalItems, startIndex, endIndex, pageSize,
    pageItems, setCurrentPage, setPageSize,
  } = usePagination(filtered, { pageSize: 10, resetKey: search + statusFilter })

  // Open the patient profile overlay (reuses the existing component).
  // IMPORTANT: this early return MUST come AFTER every hook above
  // (useMemo / usePagination / useState). Putting it before any hook
  // causes React error #300 ("Rendered more hooks than during the
  // previous render") the moment profilePatientId flips to non-null.
  if (profilePatientId) {
    return <PatientProfile patientId={profilePatientId} onClose={() => setProfilePatientId(null)} />
  }

  return (
    <>
      {/* ---- Summary stat cards ---- */}
      <div className="dash-stats" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}>
            <AppIcon name="users" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Total ANC Patients</div>
            <div className="dash-stat-value">{stats.total}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <AppIcon name="check" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Delivered</div>
            <div className="dash-stat-value">{stats.delivered}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <AppIcon name="clock" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Still Pregnant</div>
            <div className="dash-stat-value">{stats.pregnant}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}>
            <AppIcon name="alert" size={18} />
          </div>
          <div>
            <div className="dash-stat-label">Due ≤ 30 days / Overdue</div>
            <div className="dash-stat-value">{stats.dueSoon} / {stats.overdue}</div>
          </div>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Delivery Register</div>
            <div className="dash-panel-sub">{hospital?.name || 'your hospital'} · ANC → labour & delivery tracking</div>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name / phone / MRN…" />
          <ModuleHistoryButton moduleKey="delivery" />
        </div>

        {/* ---- Filter chips ---- */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {[
            { v: 'all', label: `All (${stats.total})` },
            { v: 'pregnant', label: `Pregnant (${stats.pregnant})` },
            { v: 'delivered', label: `Delivered (${stats.delivered})` },
            { v: 'miscarried', label: `Miscarried (${stats.miscarried})` },
          ].map(chip => (
            <button
              key={chip.v}
              type="button"
              className={`btn btn-ghost ${statusFilter === chip.v ? 'active' : ''}`}
              style={{
                width: 'auto', padding: '6px 14px', fontSize: 12,
                borderColor: statusFilter === chip.v ? 'var(--teal)' : 'var(--line)',
                color: statusFilter === chip.v ? 'var(--teal)' : 'var(--text)',
              }}
              onClick={() => setStatusFilter(chip.v)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* ---- Table ---- */}
        {filtered.length === 0 ? (
          <div className="dash-empty-state">No ANC patients match this filter.</div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Status</th>
                    <th>EDD</th>
                    <th>Gest. Age</th>
                    <th>Trimester</th>
                    <th>Last Delivery</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(p => {
                    const isDelivered = p.deliveryStatus === 'delivered'
                    const isMiscarried = p.deliveryStatus === 'miscarried'
                    return (
                      <tr key={p.id}>
                        <td style={{ padding: 12 }}>
                          <div style={{ fontWeight: 700 }}>{p.full_name}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                            {p.hospital_number ? `${p.hospital_number} · ` : ''}{p.phone || 'no phone'}
                          </div>
                        </td>
                        <td style={{ padding: 12 }}>
                          {isDelivered ? (
                            <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'var(--teal-soft)', color: 'var(--teal)' }}>Delivered</span>
                          ) : isMiscarried ? (
                            <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}>Miscarried</span>
                          ) : (
                            <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>Pregnant</span>
                          )}
                        </td>
                        <td style={{ padding: 12 }}>
                          {fmtDate(p.anc_edd)}
                          {p.daysUntilEdd != null && !isDelivered && !isMiscarried && (
                            <div style={{ fontSize: 10.5, color: p.daysUntilEdd < 0 ? 'var(--danger)' : 'var(--muted)', marginTop: 2 }}>
                              {p.daysUntilEdd < 0 ? `${Math.abs(p.daysUntilEdd)}d overdue` : `in ${p.daysUntilEdd}d`}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: 12 }}>{p.gestAge != null ? `${p.gestAge}w` : '—'}</td>
                        <td style={{ padding: 12 }}>{p.trimester || '—'}</td>
                        <td style={{ padding: 12, fontSize: 12 }}>
                          {p.lastDelivery ? (
                            <>
                              <div>{fmtDate(p.lastDelivery.delivery_date)}</div>
                              <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                                {DELIVERY_TYPES.find(t => t.value === p.lastDelivery.delivery_type)?.label || p.lastDelivery.delivery_type}
                                {p.lastDelivery.baby_weight_kg ? ` · ${p.lastDelivery.baby_weight_kg}kg` : ''}
                              </div>
                            </>
                          ) : '—'}
                        </td>
                        <td style={{ padding: 12, textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            {!isDelivered && !isMiscarried && (
                              <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setRecordFor(p)}>
                                Record Delivery
                              </button>
                            )}
                            {(isDelivered || isMiscarried) && (
                              <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setViewDeliveryFor(p)}>
                                View Delivery
                              </button>
                            )}
                            <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} onClick={() => setProfilePatientId(p.id)}>
                              Profile
                            </button>
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
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
              itemLabel="ANC patients"
            />
          </>
        )}
      </div>

      {/* ---- Record Delivery modal ---- */}
      {recordFor && (
        <RecordDeliveryModal
          patient={recordFor}
          onClose={() => setRecordFor(null)}
          onSave={async (payload) => {
            // 1. Insert the delivery row
            const newDelivery = await addDelivery(payload)
            // 2. Update the patient's summary columns so their profile
            //    auto-reflects the delivery (no profile refresh needed).
            const deliveryStatus = payload.delivery_type === 'miscarriage' ? 'miscarried' : 'delivered'
            await updatePatient(recordFor.id, {
              anc_delivery_status: deliveryStatus,
              anc_delivery_date: payload.delivery_date,
            })
            // 3. Audit
            writeAudit({
              hospitalId: hospital?.id, actor: profile,
              action: 'delivery.record',
              entityType: 'patient', entityId: recordFor.id,
              patientId: recordFor.id,
              summary: `Recorded ${DELIVERY_TYPES.find(t => t.value === payload.delivery_type)?.label || payload.delivery_type} delivery for ${recordFor.full_name} on ${fmtDate(payload.delivery_date)}`,
              metadata: {
                delivery_id: newDelivery?.id || null,
                delivery_type: payload.delivery_type,
                delivery_date: payload.delivery_date,
                baby_gender: payload.baby_gender,
                baby_weight_kg: payload.baby_weight_kg,
                apgar_1min: payload.apgar_1min,
                apgar_5min: payload.apgar_5min,
                baby_outcome: payload.baby_outcome,
                birth_attendant_name: payload.birth_attendant_name,
                complications: payload.complications,
              },
            })
            setRecordFor(null)
          }}
        />
      )}

      {/* ---- View Delivery summary modal ---- */}
      {viewDeliveryFor && viewDeliveryFor.lastDelivery && (
        <ViewDeliveryModal patient={viewDeliveryFor} delivery={viewDeliveryFor.lastDelivery} onClose={() => setViewDeliveryFor(null)} />
      )}
    </>
  )
}

// =====================================================================
// RecordDeliveryModal — full clinical capture form
// =====================================================================
function RecordDeliveryModal({ patient, onClose, onSave }) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    delivery_date: today,
    delivery_type: 'vaginal',
    labour_onset: 'spontaneous',
    gestational_age_weeks: patient.gestAge || '',
    labour_duration_hours: '',
    baby_gender: 'male',
    baby_weight_kg: '',
    apgar_1min: '',
    apgar_5min: '',
    baby_outcome: 'alive',
    complications: '',
    delivery_notes: '',
    birth_attendant_name: '',
    birth_attendant_role: 'doctor',
    delivery_location: 'Labour Ward',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!form.delivery_date) return setError('Delivery date is required.')
    if (!form.delivery_type) return setError('Delivery type is required.')
    if (form.baby_weight_kg !== '' && (Number(form.baby_weight_kg) <= 0 || Number(form.baby_weight_kg) > 10)) {
      return setError('Baby weight must be between 0 and 10 kg.')
    }
    if (form.apgar_1min !== '' && (Number(form.apgar_1min) < 0 || Number(form.apgar_1min) > 10)) {
      return setError('APGAR 1-min must be 0–10.')
    }
    if (form.apgar_5min !== '' && (Number(form.apgar_5min) < 0 || Number(form.apgar_5min) > 10)) {
      return setError('APGAR 5-min must be 0–10.')
    }
    setSaving(true)
    try {
      await onSave({
        hospital_id: patient.hospital_id,
        patient_id: patient.id,
        delivery_date: form.delivery_date,
        delivery_type: form.delivery_type,
        labour_onset: form.labour_onset || null,
        gestational_age_weeks: form.gestational_age_weeks === '' ? null : parseInt(form.gestational_age_weeks, 10),
        labour_duration_hours: form.labour_duration_hours === '' ? null : Number(form.labour_duration_hours),
        baby_gender: form.baby_gender || null,
        baby_weight_kg: form.baby_weight_kg === '' ? null : Number(form.baby_weight_kg),
        apgar_1min: form.apgar_1min === '' ? null : parseInt(form.apgar_1min, 10),
        apgar_5min: form.apgar_5min === '' ? null : parseInt(form.apgar_5min, 10),
        baby_outcome: form.baby_outcome || null,
        complications: form.complications.trim() || null,
        delivery_notes: form.delivery_notes.trim() || null,
        birth_attendant_name: form.birth_attendant_name.trim() || null,
        birth_attendant_role: form.birth_attendant_role || null,
        delivery_location: form.delivery_location.trim() || null,
        created_by: null, // set by useOfflineTable from profile
      })
    } catch (err) {
      setError(err.message || 'Could not save delivery record.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 720, width: 'calc(100% - 32px)' }}>
        <div className="dash-modal-title">Record Delivery</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          {patient.full_name}{patient.hospital_number ? ` · ${patient.hospital_number}` : ''} · EDD {fmtDate(patient.anc_edd)}
        </div>

        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="dash-field-grid">
            <div className="field">
              <label>Delivery Date *</label>
              <input type="date" max={today} value={form.delivery_date} onChange={e => set('delivery_date', e.target.value)} />
            </div>
            <div className="field">
              <label>Delivery Type *</label>
              <select value={form.delivery_type} onChange={e => set('delivery_type', e.target.value)}>
                {DELIVERY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Labour Onset</label>
              <select value={form.labour_onset} onChange={e => set('labour_onset', e.target.value)}>
                {LABOUR_ONSETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Gestational Age (weeks)</label>
              <input type="number" min="20" max="45" value={form.gestational_age_weeks} onChange={e => set('gestational_age_weeks', e.target.value)} />
            </div>
            <div className="field">
              <label>Labour Duration (hours)</label>
              <input type="number" min="0" step="0.5" value={form.labour_duration_hours} onChange={e => set('labour_duration_hours', e.target.value)} placeholder="e.g. 8.5" />
            </div>
            <div className="field">
              <label>Delivery Location</label>
              <input value={form.delivery_location} onChange={e => set('delivery_location', e.target.value)} placeholder="Labour Ward / Theatre / Home" />
            </div>

            <div className="field">
              <label>Baby Gender</label>
              <select value={form.baby_gender} onChange={e => set('baby_gender', e.target.value)}>
                {BABY_GENDERS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Baby Weight (kg)</label>
              <input type="number" min="0" step="0.001" value={form.baby_weight_kg} onChange={e => set('baby_weight_kg', e.target.value)} placeholder="e.g. 3.250" />
            </div>
            <div className="field">
              <label>APGAR 1 min</label>
              <input type="number" min="0" max="10" value={form.apgar_1min} onChange={e => set('apgar_1min', e.target.value)} />
            </div>
            <div className="field">
              <label>APGAR 5 min</label>
              <input type="number" min="0" max="10" value={form.apgar_5min} onChange={e => set('apgar_5min', e.target.value)} />
            </div>
            <div className="field">
              <label>Baby Outcome</label>
              <select value={form.baby_outcome} onChange={e => set('baby_outcome', e.target.value)}>
                {BABY_OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Birth Attendant Name</label>
              <input value={form.birth_attendant_name} onChange={e => set('birth_attendant_name', e.target.value)} placeholder="Dr. / Midwife name" />
            </div>
            <div className="field">
              <label>Birth Attendant Role</label>
              <select value={form.birth_attendant_role} onChange={e => set('birth_attendant_role', e.target.value)}>
                {ATTENDANT_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Complications</label>
            <input value={form.complications} onChange={e => set('complications', e.target.value)} placeholder="e.g. PPH, retained placenta, shoulder dystocia" />
          </div>
          <div className="field">
            <label>Delivery Notes</label>
            <textarea rows={3} value={form.delivery_notes} onChange={e => set('delivery_notes', e.target.value)} placeholder="Any additional notes…" />
          </div>

          <div className="dash-modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Delivery Record'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// =====================================================================
// ViewDeliveryModal — read-only summary of a recorded delivery
// =====================================================================
function ViewDeliveryModal({ patient, delivery, onClose }) {
  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 540, width: 'calc(100% - 32px)' }}>
        <div className="dash-modal-title">Delivery Summary</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          {patient.full_name} · Delivered {fmtDate(delivery.delivery_date)}
        </div>

        <div className="dash-field-grid" style={{ marginBottom: 16 }}>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Type</span><br /><strong>{DELIVERY_TYPES.find(t => t.value === delivery.delivery_type)?.label || delivery.delivery_type}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Labour Onset</span><br /><strong>{LABOUR_ONSETS.find(o => o.value === delivery.labour_onset)?.label || '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Gestational Age</span><br /><strong>{delivery.gestational_age_weeks ? `${delivery.gestational_age_weeks} weeks` : '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Labour Duration</span><br /><strong>{delivery.labour_duration_hours ? `${delivery.labour_duration_hours} hrs` : '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Baby Gender</span><br /><strong>{BABY_GENDERS.find(g => g.value === delivery.baby_gender)?.label || '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Baby Weight</span><br /><strong>{delivery.baby_weight_kg ? `${delivery.baby_weight_kg} kg` : '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>APGAR (1/5 min)</span><br /><strong>{delivery.apgar_1min ?? '—'} / {delivery.apgar_5min ?? '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Baby Outcome</span><br /><strong>{BABY_OUTCOMES.find(o => o.value === delivery.baby_outcome)?.label || '—'}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Birth Attendant</span><br /><strong>{delivery.birth_attendant_name || '—'}{delivery.birth_attendant_role ? ` (${ATTENDANT_ROLES.find(r => r.value === delivery.birth_attendant_role)?.label || delivery.birth_attendant_role})` : ''}</strong></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11 }}>Location</span><br /><strong>{delivery.delivery_location || '—'}</strong></div>
        </div>

        {delivery.complications && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: 'var(--muted)', fontSize: 11 }}>Complications</div>
            <div>{delivery.complications}</div>
          </div>
        )}
        {delivery.delivery_notes && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: 'var(--muted)', fontSize: 11 }}>Notes</div>
            <div>{delivery.delivery_notes}</div>
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14 }}>
          Recorded {fmtDateTime(delivery.created_at)}
        </div>

        <div className="dash-modal-actions" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
