import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import PatientAutocomplete from '../../components/common/PatientAutocomplete'
import TrashIcon from '../../components/icons/TrashIcon'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import RadiologyReportForm from '../../components/RadiologyReportForm'
import { writeAudit } from '../../lib/audit'
import { FileText, Printer } from 'lucide-react'

const MODALITIES = ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Fluoroscopy']

export default function Radiology(){
  const { profile, hospital } = useAuth()
  const { records: scans, loading, isOnline, pendingCount, addRecord, deleteRecord, updateRecord } = useOfflineTable('radiology_scans', hospital?.id)
  const { records: patients, loading: loadingPatients } = useOfflineTable('patients', hospital?.id)
  const [showModal, setShowModal] = useState(false)
  const [showReportForm, setShowReportForm] = useState(null) // holds the scan object when the report form is open
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')

  const [selectedPatient, setSelectedPatient] = useState(null) // the patient object from PatientAutocomplete
  const [modality, setModality] = useState(MODALITIES[0])
  const [bodyPart, setBodyPart] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // ---- Realtime ----
  useRealtimeAlert('radiology_scans', hospital?.id, () => {})
  useRealtimeAlert('radiology_scans', hospital?.id, () => {}, { event: 'UPDATE' })

  function auditScan(action, scan, summary){
    writeAudit({
      hospitalId: hospital?.id,
      actor: profile,
      action,
      entityType: 'radiology_scan',
      entityId: scan.id,
      patientId: scan.patient_id || null,
      summary,
      metadata: { modality: scan.modality, body_part: scan.body_part },
    })
  }

  async function handleAdd(e){
    e.preventDefault()
    setFormError('')
    if (!selectedPatient) {
      setFormError('Please select a patient from the list.')
      return
    }
    if (!bodyPart) {
      setFormError('Body part / area is required.')
      return
    }
    if (!hospital || !profile) {
      setFormError('Still loading your account — try again in a moment.')
      return
    }
    setSaving(true)
    try {
      const saved = await addRecord({
        patient_id: selectedPatient.id,
        patient_name: selectedPatient.full_name,
        modality,
        body_part: bodyPart,
        status: 'requested',
        report: null,
        requested_at: new Date().toISOString(),
        created_by: profile.id,
      })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'radiology_scan.requested',
        entityType: 'radiology_scan', entityId: saved?.id || null,
        patientId: selectedPatient.id,
        summary: `Requested ${modality} scan — ${bodyPart} for ${selectedPatient.full_name}`,
        metadata: { patient_id: selectedPatient.id, patient_name: selectedPatient.full_name, modality, body_part: bodyPart, status: 'requested' },
      })
      setShowModal(false)
      setSelectedPatient(null); setModality(MODALITIES[0]); setBodyPart('')
      showToast(isOnline ? 'Scan requested' : 'Scan requested — will sync when back online')
    } catch (err) {
      setFormError(err.message || 'Could not save scan request')
    } finally {
      setSaving(false)
    }
  }

  async function handleStart(scan){
    await updateRecord(scan.id, { status: 'in_progress' })
    auditScan('radiology_scan.started', scan, `Started scan — ${scan.modality} (${scan.body_part}) for ${scan.patient_name}`)
    showToast(isOnline ? 'Marked in progress' : 'Marked in progress — will sync when back online')
  }

  // The old handleComplete used prompt() — now replaced by the
  // RadiologyReportForm modal (opened via the "Report" button).
  // The form handles saving findings, impression, etc. and optionally
  // sending to the nurse.

  async function handleReopen(scan){
    const previousStatus = scan.status
    await updateRecord(scan.id, { status: 'requested', sent_to_nurse: false })
    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'radiology_scan.reopened',
      entityType: 'radiology_scan', entityId: scan.id,
      patientId: scan.patient_id || null,
      summary: `Reopened scan — ${scan.modality} (${scan.body_part}) for ${scan.patient_name}`,
      metadata: { modality: scan.modality, body_part: scan.body_part, status_change: `${previousStatus} → requested` },
    })
    showToast(isOnline ? 'Marked requested' : 'Marked requested — will sync when back online')
  }

  function body_part_label(s){ return (s || '').trim() }

  async function handleArchive(scan){
    if (!confirm(`Archive this scan request for ${scan.patient_name} (${scan.modality} — ${scan.body_part})?\n\nIt will be hidden from this list, but the record is kept for the clinical history — nothing is permanently erased.`)) return
    await deleteRecord(scan.id)
    auditScan('radiology_scan.archived', scan, `Radiology scan archived — ${scan.modality} (${scan.body_part}) for ${scan.patient_name}`)
    showToast('Scan archived')
  }

  function statusMeta(status){
    if (status === 'ready_for_printing') return { label: 'Ready for Printing', bg: 'rgba(0,199,199,0.12)', color: 'var(--teal)' }
    if (status === 'completed') return { label: 'Completed', bg: 'var(--teal-soft)', color: 'var(--teal)' }
    if (status === 'in_progress') return { label: 'In Progress', bg: 'rgba(139,124,246,0.14)', color: 'var(--violet)' }
    return { label: 'Requested', bg: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }
  }

  function nextActionLabel(scan){
    if (scan.status === 'requested') return 'Start'
    if (scan.status === 'in_progress') return 'Report'
    if (scan.status === 'completed') return 'Edit Report'
    if (scan.status === 'ready_for_printing') return 'View Report'
    return 'Reopen'
  }

  function handleNextAction(scan){
    if (scan.status === 'requested') return handleStart(scan)
    // For in_progress, completed, ready_for_printing → open the report form
    return setShowReportForm(scan)
  }

  const sorted = [...scans].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))
  const radiologySearch = searchTerm.trim().toLowerCase()
  const visibleSorted = radiologySearch ? sorted.filter(s => [s.patient_name, s.patient_id, s.modality, s.body_part, s.request_number, s.status, s.report, s.findings, s.impression].some(v => String(v || '').toLowerCase().includes(radiologySearch))) : sorted
  const requestedCount = scans.filter(s => s.status === 'requested').length
  const inProgressCount = scans.filter(s => s.status === 'in_progress').length
  const completedCount = scans.filter(s => s.status === 'completed' || s.status === 'ready_for_printing').length
  const readyForPrintingCount = scans.filter(s => s.status === 'ready_for_printing').length

  const {
    pageItems: pagedScans, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(visibleSorted, { pageSize: 10, resetKey: radiologySearch })

  return (
    <>
      <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
          </div>
          <div>
            <div className="dash-stat-label">Requested</div>
            <div className="dash-stat-value">{requestedCount}</div>
            <div className="dash-stat-delta" style={{ color: 'var(--gold)' }}>awaiting imaging</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(139,124,246,0.14)', color: 'var(--violet)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M12 13v5M9.5 15.5h5"/></svg>
          </div>
          <div>
            <div className="dash-stat-label">In Progress</div>
            <div className="dash-stat-value">{inProgressCount}</div>
            <div className="dash-stat-delta" style={{ color: 'var(--violet)' }}>being scanned</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <div>
            <div className="dash-stat-label">Completed</div>
            <div className="dash-stat-value">{completedCount}</div>
            <div className="dash-stat-delta">reports done</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(0,199,199,0.12)', color: 'var(--teal)' }}>
            <Printer size={20} />
          </div>
          <div>
            <div className="dash-stat-label">Ready for Print</div>
            <div className="dash-stat-value">{readyForPrintingCount}</div>
            <div className="dash-stat-delta" style={{ color: 'var(--teal)' }}>sent to nurse</div>
          </div>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Imaging Requests</div>
            <div className="dash-panel-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: isOnline ? 'var(--teal)' : 'var(--danger)', display: 'inline-block' }} />
              {isOnline ? 'Online' : 'Offline'}{pendingCount > 0 ? ` · ${pendingCount} syncing` : ''}
            </div>
          </div>
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search patient, scan, findings or impression" style={{ minWidth: 260, maxWidth: 420 }} />
          <ModuleHistoryButton moduleKey="radiology" />
          <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => setShowModal(true)}>+ New Scan Request</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
        ) : visibleSorted.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No scan requests yet. Add your first one above.</div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Patient', 'Modality', 'Area', 'Status', 'Findings', 'Actions'].map(h => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedScans.map(scan => {
                  const meta = statusMeta(scan.status)
                  return (
                    <tr key={scan.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                      <td style={{ padding: 12, fontWeight: 700, fontSize: 13 }}>{scan.patient_name}</td>
                      <td style={{ padding: 12, color: 'var(--muted)', fontSize: 12.5 }}>{scan.modality}</td>
                      <td style={{ padding: 12, color: 'var(--muted)', fontSize: 12.5 }}>{scan.body_part}</td>
                      <td style={{ padding: 12 }}>
                        <span
                          onClick={() => handleNextAction(scan)}
                          style={{
                            fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
                            background: meta.bg, color: meta.color,
                          }}
                          title="Click to open report form"
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td style={{ padding: 12, fontSize: 12, color: 'var(--muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {scan.findings || scan.report || '—'}
                      </td>
                      <td style={{ padding: 12 }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {/* Report button — opens the detailed RadiologyReportForm */}
                          <button
                            onClick={() => setShowReportForm(scan)}
                            className="btn btn-ghost"
                            style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--teal)', borderColor: 'var(--teal-border)', display: 'flex', alignItems: 'center', gap: 4 }}
                            title="Open report form"
                          >
                            <FileText size={12} /> {nextActionLabel(scan)}
                          </button>
                          {scan.status === 'ready_for_printing' && (
                            <button
                              onClick={() => window.print()}
                              className="btn btn-ghost"
                              style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--muted)' }}
                              title="Print report"
                            >
                              <Printer size={12} />
                            </button>
                          )}
                          <button
                            onClick={() => handleArchive(scan)}
                            className="icon-btn-delete"
                            title="Archive"
                          ><TrashIcon size={14}/></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              startIndex={startIndex}
              endIndex={endIndex}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
              itemLabel="scan requests"
            />
          </>
        )}
      </div>

      {/* New Scan Request Modal */}
      {showModal && (
        <div className="dash-modal-backdrop">
          <div className="card dash-modal" style={{ maxWidth: 400 }}>
            <div className="dash-modal-title">New Scan Request</div>
            {formError && <div className="error-box">{formError}</div>}
            <form onSubmit={handleAdd}>
              <div className="dash-modal-body">
                <div className="field">
                  <label>Patient *</label>
                  <PatientAutocomplete
                    patients={patients}
                    value={null}
                    onChange={(option) => setSelectedPatient(option?.patient || null)}
                    loading={loadingPatients}
                    placeholder="Search patient by name, ID or phone…"
                  />
                  {selectedPatient && (
                    <div style={{ fontSize: 11, color: 'var(--teal)', marginTop: 4, fontWeight: 600 }}>
                      ✓ Selected: {selectedPatient.full_name}
                      {selectedPatient.hospital_number && ` · MRN: ${selectedPatient.hospital_number}`}
                      {selectedPatient.phone && ` · ${selectedPatient.phone}`}
                    </div>
                  )}
                </div>
                <div className="field">
                  <label>Modality</label>
                  <select value={modality} onChange={e => setModality(e.target.value)}>
                    {MODALITIES.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Body Part / Area</label>
                  <input value={bodyPart} onChange={e => setBodyPart(e.target.value)} placeholder="e.g. Chest, Left Knee" />
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Request'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Radiology Report Form Modal */}
      {showReportForm && (
        <RadiologyReportForm
          scan={showReportForm}
          onClose={() => setShowReportForm(null)}
          onUpdate={() => setShowReportForm(null)}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
          padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 700, zIndex: 60, maxWidth: '85vw', textAlign: 'center',
        }}>
          {toast}
        </div>
      )}
    </>
  )
}
