import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { getTimezone, dayKeyInZone, todayKeyInZone } from '../../lib/datetime'
import { writeAudit } from '../../lib/audit'
import useMediaQuery from '../../lib/useMediaQuery'
import ConnectionState from '../../components/common/ConnectionState'
import Timestamp from '../../components/common/Timestamp'
import Autocomplete from '../../components/common/Autocomplete'
import Pagination from '../../components/common/Pagination'
import { usePagination } from '../../lib/usePagination'

// Section 5 — stats row
// Section 6 — Requests list
// Section 7 — Review screen (approve w/ bed assignment, or reject)
// Section 8 — Discharge flow (checklist + discharge + bed cleaning)

const EDITOR_ROLES = ['doctor', 'nurse', 'admin', 'owner']

// Names shown in the audit trail for the three discharge checks.
const CHECK_LABEL = {
  billing_cleared: 'Billing clearance',
  pharmacy_cleared: 'Pharmacy clearance',
  doctor_signed: 'Doctor sign-off',
}

// ---------------------------------------------------------------------
// Keeping the user's place (preserve-user-work rule)
//
// Dashboard removes this screen when you switch modules, which used to
// wipe the filter and any half-finished review or discharge. These
// variables live OUTSIDE the component so they survive leaving and
// coming back. They are MEMORY ONLY (never localStorage/sessionStorage)
// because they can hold clinical notes; a browser reload or sign-out
// clears them, and they are tagged with hospital + user so another
// account never sees them.
// ---------------------------------------------------------------------
let screenState = null    // { owner, filter, reqPageSize, activePageSize }
let reviewDraft = null    // { owner, requestId, mode, selectedBedId, rejectReason }
let dischargeDraft = null // { owner, admissionId, reason }

function ownerKey(hospital, profile) {
  return `${hospital?.id || ''}:${profile?.id || ''}`
}

const cardStyle = {
  border: '1px solid var(--line-soft)',
  background: 'var(--bg-elevated)',
  borderRadius: 10,
  padding: 12,
  display: 'grid',
  gap: 8,
}

export default function Admissions(){
  const { hospital, profile } = useAuth()
  const timezone = getTimezone(hospital)
  const canEdit = EDITOR_ROLES.includes(profile?.role)
  const canToggleBilling = canEdit || profile?.role === 'billing'
  const canTogglePharmacy = canEdit || profile?.role === 'pharmacist'

  const { records: admissionRequests, loading: loadingRequests, updateRecord: updateRequest } = useOfflineTable('admission_requests', hospital?.id)
  const { records: admissions, loading: loadingAdmissions, addRecord: addAdmission, updateRecord: updateAdmission, isOnline, pendingCount } = useOfflineTable('admissions', hospital?.id)
  const { records: beds, loading: loadingBeds, updateRecord: updateBed } = useOfflineTable('beds', hospital?.id)
  const { records: patients, loading: loadingPatients } = useOfflineTable('patients', hospital?.id)

  // Phones get stacked record cards instead of an 8-column table.
  const isPhone = useMediaQuery('(max-width: 767px)')
  const owner = ownerKey(hospital, profile)
  const savedScreen = screenState && screenState.owner === owner ? screenState : null
  const savedReview = reviewDraft && reviewDraft.owner === owner ? reviewDraft : null
  const savedDischarge = dischargeDraft && dischargeDraft.owner === owner ? dischargeDraft : null

  const loading = loadingRequests || loadingAdmissions || loadingBeds || loadingPatients
  // "Admitted Today" must use the hospital's timezone (Stage 1 req. #11),
  // not the viewer's device timezone like the old toDateString() compare.
  const todayKey = todayKeyInZone(timezone)

  const patientById = (patientId) => patients.find(p => p.id === patientId)
  const patientName = (patientId) => patientById(patientId)?.full_name || 'Unknown Patient'
  // Name plus MRN underneath, so two patients with similar names can
  // never be mistaken for each other on an admission.
  function renderPatient(patientId){
    const p = patientById(patientId)
    const mrn = p?.patient_id || p?.hospital_number
    return (
      <div>
        <div style={{ fontWeight: 600 }}>{p?.full_name || 'Unknown Patient'}</div>
        {mrn && <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>MRN {mrn}</div>}
      </div>
    )
  }
  const bedById = (bedId) => beds.find(b => b.id === bedId)

  const pendingRequests = admissionRequests.filter(r => r.status === 'pending').length
  const approvedRequests = admissionRequests.filter(r => r.status === 'converted').length
  const admittedToday = admissions.filter(a => a.admitted_at && dayKeyInZone(a.admitted_at, timezone) === todayKey).length
  const currentlyAdmitted = admissions.filter(a => a.status === 'active').length
  const availableBeds = beds.filter(b => b.status === 'available').length
  const occupiedBeds = beds.filter(b => b.status === 'occupied').length
  const pendingCleaning = beds.filter(b => b.status === 'cleaning').length

  const stats = [
    { label: 'Pending Requests', value: pendingRequests, color: 'var(--gold)' },
    { label: 'Admitted (Converted)', value: approvedRequests, color: 'var(--teal)' },
    { label: 'Admitted Today', value: admittedToday, color: 'var(--teal)' },
    { label: 'Currently Admitted', value: currentlyAdmitted, color: 'var(--blue)' },
    { label: 'Available Beds', value: availableBeds, color: 'var(--muted)' },
    { label: 'Occupied Beds', value: occupiedBeds, color: 'var(--blue)' },
    { label: 'Pending Cleaning', value: pendingCleaning, color: 'var(--gold)' },
  ]

  const [toast, setToast] = useState(null)
  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // --- Section 6: Requests list ---
  const [filter, setFilter] = useState(savedScreen?.filter || 'pending')
  const filteredRequests = admissionRequests
    .filter(r => filter === 'all' || r.status === filter)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // Global Pagination Rule: requests pile up over the years, so this list
  // is paged. Changing the filter jumps back to page 1.
  const {
    pageItems: pagedRequests, currentPage: reqPage, setCurrentPage: setReqPage,
    pageSize: reqPageSize, setPageSize: setReqPageSize,
    totalPages: reqTotalPages, totalItems: reqTotalItems,
    startIndex: reqStart, endIndex: reqEnd,
  } = usePagination(filteredRequests, { pageSize: savedScreen?.reqPageSize || 10, resetKey: filter })

  // --- Section 7: Review screen ---
  const [reviewingId, setReviewingId] = useState(savedReview?.requestId || null)
  const reviewing = reviewingId ? admissionRequests.find(r => r.id === reviewingId) || null : null
  const [selectedBedId, setSelectedBedId] = useState(savedReview?.selectedBedId || '')
  const [rejectReason, setRejectReason] = useState(savedReview?.rejectReason || '')
  const [mode, setMode] = useState(savedReview?.mode || null) // 'approve' | 'reject' | null
  const [busy, setBusy] = useState(false)

  function openReview(request){
    setReviewingId(request.id)
    setSelectedBedId('')
    setRejectReason('')
    setMode(null)
  }

  function closeReview(){
    setReviewingId(null)
    setSelectedBedId('')
    setRejectReason('')
    setMode(null)
  }

  // Closing with a typed rejection reason asks first (unsaved-work rule).
  function closeReviewSafe(){
    if (rejectReason.trim() && !confirm('Discard the rejection reason you typed?')) return
    closeReview()
  }

  async function handleApprove(){
    if (!reviewing || !selectedBedId) return
    // Another device may have handled this request or taken the bed while
    // this window was open: check the LIVE data before writing anything.
    if (reviewing.status !== 'pending') {
      showToast('This request has already been handled.')
      closeReview()
      return
    }
    const bed = beds.find(b => b.id === selectedBedId)
    if (!bed || bed.status !== 'available') {
      showToast('That bed is no longer available — choose another.')
      setSelectedBedId('')
      return
    }
    setBusy(true)
    try {
      const name = patientName(reviewing.patient_id)
      const admissionNumber = `ADM-${Date.now().toString().slice(-8)}`
      const nowISO = new Date().toISOString()

      const created = await addAdmission({
        patient_id: reviewing.patient_id,
        admission_request_id: reviewing.id,
        admission_number: admissionNumber,
        admission_type: reviewing.admission_type,
        diagnosis: reviewing.diagnosis,
        reason: reviewing.reason,
        ward: bed?.section || reviewing.requested_ward,
        bed_id: selectedBedId,
        attending_doctor_id: reviewing.doctor_id,
        attending_doctor_name: reviewing.doctor_name,
        admitted_by: profile.id,
        admitted_at: nowISO,
        status: 'active',
      })

      await updateBed(selectedBedId, {
        status: 'occupied',
        patient_name: name,
        doctor_name: reviewing.doctor_name,
        // The hospital's calendar day, not the UTC day (a late-night
        // admission used to be dated tomorrow/yesterday).
        admission_date: todayKeyInZone(timezone),
        diagnosis: reviewing.diagnosis,
        billing_cleared: false,
        pharmacy_cleared: false,
        doctor_signed: false,
      })

      // 'converted' = the request has become a real, active admission.
      // Kept in sync with the status Patient Overview's admission card
      // checks for ("Currently Admitted").
      await updateRequest(reviewing.id, {
        status: 'converted',
        reviewed_by: profile.id,
        reviewed_at: nowISO,
      })

      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: 'admission.approve',
        entityType: 'admission',
        entityId: created?.id || null,
        patientId: reviewing.patient_id,
        summary: `${name} admitted to ${bed.section} — Bed ${bed.bed_number} (${admissionNumber})`,
        metadata: { admission_request_id: reviewing.id, bed_id: selectedBedId, admission_number: admissionNumber },
      })

      showToast(`${name} admitted — ${admissionNumber}`)
      closeReview()
    } catch (err) {
      showToast(err.message || 'Could not complete admission')
    } finally {
      setBusy(false)
    }
  }

  async function handleReject(){
    if (!reviewing || !rejectReason.trim()) return
    if (reviewing.status !== 'pending') {
      showToast('This request has already been handled.')
      closeReview()
      return
    }
    setBusy(true)
    try {
      await updateRequest(reviewing.id, {
        status: 'rejected',
        rejection_reason: rejectReason.trim(),
        reviewed_by: profile.id,
        reviewed_at: new Date().toISOString(),
      })
      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: 'admission.reject',
        entityType: 'admission_request',
        entityId: reviewing.id,
        patientId: reviewing.patient_id,
        summary: `Admission request for ${patientName(reviewing.patient_id)} rejected`,
        metadata: { reason: rejectReason.trim() },
      })
      showToast(`Request for ${patientName(reviewing.patient_id)} rejected`)
      closeReview()
    } catch (err) {
      showToast(err.message || 'Could not reject request')
    } finally {
      setBusy(false)
    }
  }

  const availableBedOptions = beds.filter(b => b.status === 'available')

  // Options for the searchable bed picker. Beds in the ward the doctor
  // asked for come first and are labelled, so the common choice is on top.
  const bedOptions = useMemo(() => {
    const wanted = String(reviewing?.requested_ward || '').trim().toLowerCase()
    return availableBedOptions
      .map(b => ({
        id: b.id,
        label: `${b.section} — Bed ${b.bed_number}`,
        sublabel: b.bed_type || b.type || '',
        right: wanted && String(b.section || '').trim().toLowerCase() === wanted ? 'Requested ward' : '',
        rightTone: 'good',
      }))
      .sort((a, b) => (b.right ? 1 : 0) - (a.right ? 1 : 0) || a.label.localeCompare(b.label, undefined, { numeric: true }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beds, reviewing?.id, reviewing?.requested_ward])
  const selectedBedOpt = bedOptions.find(o => o.id === selectedBedId) || null

  // --- Section 8: Discharge flow ---
  const activeAdmissions = admissions
    .filter(a => a.status === 'active')
    .sort((a, b) => new Date(b.admitted_at) - new Date(a.admitted_at))

  const cleaningBeds = beds.filter(b => b.status === 'cleaning')

  // "Currently Admitted" is bounded by the number of beds but can still
  // reach dozens in a large hospital, so it is paged as well.
  const {
    pageItems: pagedActive, currentPage: activePage, setCurrentPage: setActivePage,
    pageSize: activePageSize, setPageSize: setActivePageSize,
    totalPages: activeTotalPages, totalItems: activeTotalItems,
    startIndex: activeStart, endIndex: activeEnd,
  } = usePagination(activeAdmissions, { pageSize: savedScreen?.activePageSize || 10 })

  const [dischargeBusyId, setDischargeBusyId] = useState(null)
  const [confirmingDischargeId, setConfirmingDischargeId] = useState(savedDischarge?.admissionId || null)
  const confirmingDischarge = confirmingDischargeId ? admissions.find(a => a.id === confirmingDischargeId) || null : null
  const [dischargeReason, setDischargeReason] = useState(savedDischarge?.reason || '')

  // Remember the filter/page sizes and any unfinished review or discharge
  // while this screen is away (memory only — see the note at the top).
  useEffect(() => {
    screenState = { owner, filter, reqPageSize, activePageSize }
  }, [owner, filter, reqPageSize, activePageSize])
  useEffect(() => {
    reviewDraft = reviewingId ? { owner, requestId: reviewingId, mode, selectedBedId, rejectReason } : null
  }, [owner, reviewingId, mode, selectedBedId, rejectReason])
  useEffect(() => {
    dischargeDraft = confirmingDischargeId ? { owner, admissionId: confirmingDischargeId, reason: dischargeReason } : null
  }, [owner, confirmingDischargeId, dischargeReason])

  // Warn before a refresh/close would throw away typed clinical notes.
  const hasTypedWork = Boolean(rejectReason.trim() || dischargeReason.trim())
  useEffect(() => {
    if (!hasTypedWork) return undefined
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasTypedWork])

  async function toggleChecklistItem(admission, field, value){
    const bed = bedById(admission.bed_id)
    if (!bed) return
    setDischargeBusyId(admission.id)
    try {
      await updateBed(bed.id, { [field]: value })
      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: 'admission.clearance',
        entityType: 'admission',
        entityId: admission.id,
        patientId: admission.patient_id,
        summary: `${CHECK_LABEL[field]} ${value ? 'confirmed' : 'withdrawn'} for ${patientName(admission.patient_id)}`,
        metadata: { field, value },
      })
    } catch (err) {
      showToast(err.message || 'Could not update the clearance')
    } finally {
      setDischargeBusyId(null)
    }
  }

  function openConfirmDischarge(admission){
    setConfirmingDischargeId(admission.id)
    setDischargeReason('')
  }

  function closeConfirmDischarge(){
    setConfirmingDischargeId(null)
    setDischargeReason('')
  }

  function closeConfirmDischargeSafe(){
    if (dischargeReason.trim() && !confirm('Discard the discharge notes you typed?')) return
    closeConfirmDischarge()
  }

  async function handleDischarge(){
    if (!confirmingDischarge) return
    const admission = confirmingDischarge
    if (admission.status !== 'active') {
      showToast('This patient has already been discharged.')
      closeConfirmDischarge()
      return
    }
    const bed = bedById(admission.bed_id)
    if (!bed || !(bed.billing_cleared && bed.pharmacy_cleared && bed.doctor_signed)) return

    setDischargeBusyId(admission.id)
    try {
      await updateAdmission(admission.id, {
        status: 'discharged',
        discharge_date: new Date().toISOString(),
        discharge_reason: dischargeReason.trim() || null,
      })
      await updateBed(bed.id, {
        status: 'cleaning',
        patient_name: null,
        doctor_name: null,
        admission_date: null,
        diagnosis: null,
        billing_cleared: false,
        pharmacy_cleared: false,
        doctor_signed: false,
      })
      // B-FIX: Do NOT write status='discharged' or discharge_reason to
      // admission_requests. The admission_requests.status stays 'converted'.
      // Discharge info (discharge_date, discharge_reason) is stored ONLY in
      // the admissions table. PatientProfile derives the admission card
      // from the linked admission's status — if admissions.status='discharged',
      // the card is hidden.
      //
      // The previous code wrote status='discharged' to admission_requests,
      // which is an invalid status for that table (only 'pending', 'approved',
      // 'converted', 'cancelled', 'rejected' are valid). This caused sync
      // errors on every discharge.
      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: 'admission.discharge',
        entityType: 'admission',
        entityId: admission.id,
        patientId: admission.patient_id,
        summary: `${patientName(admission.patient_id)} discharged from ${bed.section} — Bed ${bed.bed_number}`,
        metadata: { admission_number: admission.admission_number || null, notes: dischargeReason.trim() || null },
      })
      showToast(`${patientName(admission.patient_id)} discharged`)
      closeConfirmDischarge()
    } catch (err) {
      showToast(err.message || 'Could not discharge patient')
    } finally {
      setDischargeBusyId(null)
    }
  }

  async function markBedReady(bed){
    setDischargeBusyId(bed.id)
    try {
      await updateBed(bed.id, { status: 'available' })
      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: 'bed.ready',
        entityType: 'bed',
        entityId: bed.id,
        summary: `${bed.section} — Bed ${bed.bed_number} marked available after cleaning`,
      })
      showToast(`${bed.section} — Bed ${bed.bed_number} marked available`)
    } catch (err) {
      showToast(err.message || 'Could not update the bed')
    } finally {
      setDischargeBusyId(null)
    }
  }

  return (
    <div>
      <div className="dash-panel" style={{ marginBottom: 16 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Admissions</div>
            <div className="dash-panel-sub">
              Requests, bed assignment, and active admissions
              <span style={{ display: 'inline-flex', marginLeft: 8, verticalAlign: 'middle' }}><ConnectionState isOnline={isOnline} pendingCount={pendingCount} /></span>
              {!canEdit && !canToggleBilling && !canTogglePharmacy && <span style={{ marginLeft: 8, opacity: .7 }}>· View only</span>}
              {!canEdit && canToggleBilling && <span style={{ marginLeft: 8, opacity: .7 }}>· Billing clearance only</span>}
              {!canEdit && canTogglePharmacy && <span style={{ marginLeft: 8, opacity: .7 }}>· Pharmacy clearance only</span>}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="dash-panel" style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
      ) : (
        <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 20 }}>
          {stats.map(s => (
            <div className="dash-stat-card" key={s.label}>
              <div>
                <div className="dash-stat-label">{s.label}</div>
                <div className="dash-stat-value" style={{ color: s.color }}>{s.value}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Section 6: Requests list */}
      <div className="dash-panel" style={{ marginBottom: 20 }}>
        <div className="dash-panel-head">
          <div className="dash-panel-title">Admission Requests</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['pending', 'converted', 'rejected', 'all'].map(f => (
              <button
                key={f}
                className={`btn btn-ghost ${filter === f ? 'active' : ''}`}
                style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="dash-empty">Loading…</div>
        ) : filteredRequests.length === 0 ? (
          <div className="dash-empty">No {filter === 'all' ? '' : filter} requests.</div>
        ) : (
          <>
            {isPhone ? (
              <div style={{ display: 'grid', gap: 10 }}>
                {pagedRequests.map(r => (
                  <div key={r.id} style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, fontSize: 14 }}>{renderPatient(r.patient_id)}</div>
                      <span className={`dash-status ${r.status === 'pending' ? 'review' : 'stable'}`} style={{ fontSize: 11 }}>{r.status}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                      {[r.admission_type, r.priority && `${r.priority} priority`, r.requested_ward].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div style={{ fontSize: 12.5 }}>
                      {r.doctor_name || 'No doctor listed'} · <Timestamp iso={r.created_at} timezone={timezone} />
                    </div>
                    <button className="btn btn-ghost" style={{ width: '100%', minHeight: 40 }} onClick={() => openReview(r)}>
                      {canEdit && r.status === 'pending' ? 'Review' : 'View'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Requesting Doctor</th>
                    <th>Ward</th>
                    <th>Type</th>
                    <th>Priority</th>
                    <th>Requested At</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRequests.map(r => (
                    <tr key={r.id}>
                      <td>{renderPatient(r.patient_id)}</td>
                      <td>{r.doctor_name || '—'}</td>
                      <td>{r.requested_ward || '—'}</td>
                      <td>{r.admission_type || '—'}</td>
                      <td>{r.priority || '—'}</td>
                      <td><Timestamp iso={r.created_at} timezone={timezone} /></td>
                      <td><span className={`dash-status ${r.status === 'pending' ? 'review' : 'stable'}`}>{r.status}</span></td>
                      <td>
                        <button className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => openReview(r)}>
                          {canEdit && r.status === 'pending' ? 'Review' : 'View'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <Pagination
              currentPage={reqPage}
              totalPages={reqTotalPages}
              totalItems={reqTotalItems}
              startIndex={reqStart}
              endIndex={reqEnd}
              pageSize={reqPageSize}
              onPageChange={setReqPage}
              onPageSizeChange={setReqPageSize}
              itemLabel="requests"
            />
          </>
        )}
      </div>

      {/* Section 8: Currently admitted / discharge */}
      <div className="dash-panel" style={{ marginBottom: 20 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Currently Admitted</div>
            <div className="dash-panel-sub">All three checks are required before a patient can be discharged</div>
          </div>
        </div>

        {loading ? (
          <div className="dash-empty">Loading…</div>
        ) : activeAdmissions.length === 0 ? (
          <div className="dash-empty">No patients currently admitted.</div>
        ) : (
          <>
            {isPhone ? (
              <div style={{ display: 'grid', gap: 10 }}>
                {pagedActive.map(a => {
                  const bed = bedById(a.bed_id)
                  const allCleared = bed && bed.billing_cleared && bed.pharmacy_cleared && bed.doctor_signed
                  const rowBusy = dischargeBusyId === a.id
                  return (
                    <div key={a.id} style={cardStyle}>
                      <div style={{ fontSize: 14 }}>{renderPatient(a.patient_id)}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                        {bed ? `${bed.section} — Bed ${bed.bed_number}` : 'No bed'} · {a.attending_doctor_name || 'No doctor listed'}
                      </div>
                      <div style={{ fontSize: 12.5 }}>Admitted <Timestamp iso={a.admitted_at} timezone={timezone} /></div>
                      <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 6 }}>
                        {[
                          ['billing_cleared', canToggleBilling],
                          ['pharmacy_cleared', canTogglePharmacy],
                          ['doctor_signed', canEdit],
                        ].map(([field, allowed]) => (
                          <label key={field} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 40, fontSize: 13, opacity: allowed ? 1 : 0.6 }}>
                            <span>{CHECK_LABEL[field]}</span>
                            <input
                              type="checkbox"
                              className="gmed-check"
                              aria-label={`${CHECK_LABEL[field]} for ${patientName(a.patient_id)}`}
                              checked={!!bed?.[field]}
                              disabled={!allowed || rowBusy || !bed}
                              onChange={e => toggleChecklistItem(a, field, e.target.checked)}
                            />
                          </label>
                        ))}
                      </div>
                      {canEdit && (
                        <button
                          className="btn btn-ghost"
                          style={{ width: '100%', minHeight: 40 }}
                          disabled={!allCleared || rowBusy}
                          onClick={() => openConfirmDischarge(a)}
                        >
                          Discharge
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Bed</th>
                    <th>Doctor</th>
                    <th>Admitted</th>
                    <th>Billing</th>
                    <th>Pharmacy</th>
                    <th>Doctor Sign-off</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedActive.map(a => {
                    const bed = bedById(a.bed_id)
                    const allCleared = bed && bed.billing_cleared && bed.pharmacy_cleared && bed.doctor_signed
                    const rowBusy = dischargeBusyId === a.id
                    return (
                      <tr key={a.id}>
                        <td>{renderPatient(a.patient_id)}</td>
                        <td>{bed ? `${bed.section} — Bed ${bed.bed_number}` : '—'}</td>
                        <td>{a.attending_doctor_name || '—'}</td>
                        <td><Timestamp iso={a.admitted_at} timezone={timezone} /></td>
                        <td>
                          <input
                            type="checkbox"
                            className="gmed-check"
                            aria-label={`Billing cleared for ${patientName(a.patient_id)}`}
                            checked={!!bed?.billing_cleared}
                            disabled={!canToggleBilling || rowBusy || !bed}
                            onChange={e => toggleChecklistItem(a, 'billing_cleared', e.target.checked)}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            className="gmed-check"
                            aria-label={`Pharmacy cleared for ${patientName(a.patient_id)}`}
                            checked={!!bed?.pharmacy_cleared}
                            disabled={!canTogglePharmacy || rowBusy || !bed}
                            onChange={e => toggleChecklistItem(a, 'pharmacy_cleared', e.target.checked)}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            className="gmed-check"
                            aria-label={`Doctor sign-off for ${patientName(a.patient_id)}`}
                            checked={!!bed?.doctor_signed}
                            disabled={!canEdit || rowBusy || !bed}
                            onChange={e => toggleChecklistItem(a, 'doctor_signed', e.target.checked)}
                          />
                        </td>
                        <td>
                          {canEdit && (
                            <button
                              className="btn btn-ghost"
                              style={{ width: 'auto', padding: '4px 10px' }}
                              disabled={!allCleared || rowBusy}
                              onClick={() => openConfirmDischarge(a)}
                            >
                              Discharge
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            )}
            <Pagination
              currentPage={activePage}
              totalPages={activeTotalPages}
              totalItems={activeTotalItems}
              startIndex={activeStart}
              endIndex={activeEnd}
              pageSize={activePageSize}
              onPageChange={setActivePage}
              onPageSizeChange={setActivePageSize}
              itemLabel="admissions"
            />
          </>
        )}
      </div>

      {/* Cleaning queue */}
      {cleaningBeds.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 20 }}>
          <div className="dash-panel-head">
            <div className="dash-panel-title">Beds Awaiting Cleaning</div>
          </div>
          <div className="dash-table-wrap">
          <table className="dash-full-table">
            <thead><tr><th>Section</th><th>Bed</th><th></th></tr></thead>
            <tbody>
              {cleaningBeds.map(b => (
                <tr key={b.id}>
                  <td>{b.section}</td>
                  <td>{b.bed_number}</td>
                  <td>
                    {canEdit && (
                      <button
                        className="btn btn-ghost"
                        style={{ width: 'auto', padding: '4px 10px' }}
                        disabled={dischargeBusyId === b.id}
                        onClick={() => markBedReady(b)}
                      >
                        Mark Ready
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Section 7: Review screen */}
      {reviewing && (
        <div className="dash-modal-backdrop">
          <div className="card dash-modal">
            <div className="dash-modal-title">
              {canEdit && reviewing.status === 'pending' ? 'Review Request' : 'Request Details'}
            </div>
            <div className="dash-modal-body">
              <div className="field"><label>Patient</label><div>{patientName(reviewing.patient_id)}</div></div>
              <div className="field"><label>Requesting Doctor</label><div>{reviewing.doctor_name || '—'}</div></div>
              <div className="dash-field-grid">
                <div className="field"><label>Admission Type</label><div>{reviewing.admission_type || '—'}</div></div>
                <div className="field"><label>Priority</label><div>{reviewing.priority || '—'}</div></div>
                {reviewing.requested_ward && <div className="field"><label>Requested Ward</label><div>{reviewing.requested_ward}</div></div>}
                {reviewing.requested_bed_type && <div className="field"><label>Requested Bed Type</label><div>{reviewing.requested_bed_type}</div></div>}
                {reviewing.expected_los && <div className="field"><label>Expected LOS</label><div>{reviewing.expected_los}</div></div>}
                <div className="field"><label>Status</label><div><span className={`dash-status ${reviewing.status === 'pending' ? 'review' : 'stable'}`}>{reviewing.status}</span></div></div>
                <div className="field"><label>Requested</label><div><Timestamp iso={reviewing.created_at} timezone={timezone} /></div></div>
                {reviewing.reviewed_at && <div className="field"><label>Reviewed</label><div><Timestamp iso={reviewing.reviewed_at} timezone={timezone} /></div></div>}
              </div>
              <div className="field"><label>Diagnosis</label><div>{reviewing.diagnosis || '—'}</div></div>
              <div className="field"><label>Reason</label><div>{reviewing.reason || '—'}</div></div>
              {reviewing.isolation_required && (
                <div className="field"><label>Isolation</label><div>Required</div></div>
              )}
              {reviewing.special_instructions && (
                <div className="field"><label>Special Instructions</label><div>{reviewing.special_instructions}</div></div>
              )}
              {reviewing.clinical_notes && (
                <div className="field"><label>Clinical Notes</label><div>{reviewing.clinical_notes}</div></div>
              )}
              {reviewing.status === 'rejected' && reviewing.rejection_reason && (
                <div className="field"><label>Rejection Reason</label><div>{reviewing.rejection_reason}</div></div>
              )}

              {canEdit && reviewing.status === 'pending' && mode === 'approve' && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Assign Bed {reviewing.requested_ward ? `(requested: ${reviewing.requested_ward})` : ''}</label>
                  <Autocomplete
                    options={bedOptions}
                    value={selectedBedOpt}
                    onChange={o => setSelectedBedId(o?.id || '')}
                    placeholder="Search ward or bed number…"
                    emptyText="No available bed matches"
                    ariaLabel="Bed"
                  />
                  {availableBedOptions.length === 0 && (
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>No beds currently available.</div>
                  )}
                </div>
              )}

              {canEdit && reviewing.status === 'pending' && mode === 'reject' && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Reason for Rejection</label>
                  <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="e.g. No bed capacity, insufficient info…" />
                </div>
              )}
            </div>

            {canEdit && reviewing.status === 'pending' && mode === null && (
              <div className="dash-modal-actions">
                <button className="btn btn-ghost" onClick={closeReviewSafe}>Close</button>
                <button className="btn btn-ghost dash-danger-btn" onClick={() => setMode('reject')}>Reject</button>
                <button className="btn btn-primary" onClick={() => setMode('approve')}>Approve</button>
              </div>
            )}
            {canEdit && reviewing.status === 'pending' && mode === 'approve' && (
              <div className="dash-modal-actions">
                <button className="btn btn-ghost" onClick={() => setMode(null)} disabled={busy}>Back</button>
                <button className="btn btn-primary" onClick={handleApprove} disabled={busy || !selectedBedId}>
                  {busy ? 'Admitting…' : 'Confirm Admission'}
                </button>
              </div>
            )}
            {canEdit && reviewing.status === 'pending' && mode === 'reject' && (
              <div className="dash-modal-actions">
                <button className="btn btn-ghost" onClick={() => setMode(null)} disabled={busy}>Back</button>
                <button className="btn btn-primary dash-danger-btn" onClick={handleReject} disabled={busy || !rejectReason.trim()}>
                  {busy ? 'Rejecting…' : 'Confirm Rejection'}
                </button>
              </div>
            )}
            {(!canEdit || reviewing.status !== 'pending') && (
              <div className="dash-modal-actions">
                <button className="btn btn-ghost" onClick={closeReviewSafe}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Discharge confirmation */}
      {confirmingDischarge && (
        <div className="dash-modal-backdrop">
          <div className="card dash-modal">
            <div className="dash-modal-title">Confirm Discharge</div>
            <div className="dash-modal-body">
              <div className="field"><label>Patient</label><div>{patientName(confirmingDischarge.patient_id)}</div></div>
              <div className="field">
                <label>Discharge Notes (optional)</label>
                <input value={dischargeReason} onChange={e => setDischargeReason(e.target.value)} placeholder="e.g. Recovered, referred, follow-up in 2 weeks…" />
              </div>
            </div>
            <div className="dash-modal-actions">
              <button className="btn btn-ghost" onClick={closeConfirmDischargeSafe} disabled={dischargeBusyId === confirmingDischarge.id}>Cancel</button>
              <button className="btn btn-primary" onClick={handleDischarge} disabled={dischargeBusyId === confirmingDischarge.id}>
                {dischargeBusyId === confirmingDischarge.id ? 'Discharging…' : 'Confirm Discharge'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="dash-toast">{toast}</div>}
    </div>
  )
}
