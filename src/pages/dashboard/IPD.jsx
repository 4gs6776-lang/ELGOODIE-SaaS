import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { supabase } from '../../lib/supabaseClient'
import { invalidateTable } from '../../lib/useTableCache'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import { writeAudit } from '../../lib/audit'
import AppIcon from '../../components/icons'

const SECTIONS = [
  { key: 'private', label: 'Private Suites' },
  { key: 'general', label: 'General Ward' },
  { key: 'icu', label: 'ICU' },
]

const STATUS_COLOR = {
  available: { bg: 'rgba(124,134,184,0.14)', border: 'var(--line)', text: 'var(--muted)', label: 'Available' },
  occupied: { bg: 'rgba(76,141,255,0.16)', border: 'rgba(76,141,255,0.4)', text: 'var(--blue)', label: 'Occupied' },
  cleaning: { bg: 'rgba(201,169,97,0.16)', border: 'rgba(201,169,97,0.4)', text: 'var(--gold)', label: 'Cleaning' },
  reserved: { bg: 'rgba(139,124,246,0.16)', border: 'rgba(139,124,246,0.4)', text: 'var(--violet)', label: 'Reserved' },
}

// Props: onGoToAdmissions — optional callback so the "available bed" info
// panel can jump the user straight to the Admissions module.
export default function IPD({ onGoToAdmissions }){
  const { profile, hospital } = useAuth()
  const { records: beds, loading, isOnline, pendingCount, addRecord, deleteRecord, updateRecord, refreshTable, syncFromServer } = useOfflineTable('beds', hospital?.id)

  const [toast, setToast] = useState(null)
  const [selectedBed, setSelectedBed] = useState(null)
  const [showAddBed, setShowAddBed] = useState(false)
  const [newSection, setNewSection] = useState('general')
  const [newBedNumber, setNewBedNumber] = useState('')

  const [showDischarge, setShowDischarge] = useState(false)
  const [billingCleared, setBillingCleared] = useState(false)
  const [pharmacyCleared, setPharmacyCleared] = useState(false)
  const [doctorSigned, setDoctorSigned] = useState(false)

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // Live alert — a new inpatient admission from another device refreshes bed status here.
  // syncFromServer (not refreshTable) so we actually pull the updated bed rows down,
  // not just re-read whatever was already sitting in the local offline cache.
  useRealtimeAlert('admissions', hospital?.id, () => {
    showToast('A new patient was admitted — bed list refreshed')
    syncFromServer()
  })

  async function handleAddBed(e){
    e.preventDefault()
    if (!newBedNumber) return
    const saved = await addRecord({ section: newSection, bed_number: newBedNumber, status: 'available', created_by: profile.id })
    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'ipd.bed_added',
      entityType: 'bed', entityId: saved?.id || null,
      summary: `Added bed ${newBedNumber} to ${SECTIONS.find(s => s.key === newSection)?.label || newSection}`,
      metadata: { section: newSection, bed_number: newBedNumber, status: 'available' },
    })
    setShowAddBed(false)
    setNewBedNumber('')
    showToast('Bed added')
  }

  function openBed(bed){
    setSelectedBed(bed)
    if (bed.status === 'occupied') {
      setBillingCleared(bed.billing_cleared); setPharmacyCleared(bed.pharmacy_cleared); setDoctorSigned(bed.doctor_signed)
    }
  }

  async function saveChecklist(){
    await updateRecord(selectedBed.id, { billing_cleared: billingCleared, pharmacy_cleared: pharmacyCleared, doctor_signed: doctorSigned })
    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'ipd.discharge_checklist_updated',
      entityType: 'bed', entityId: selectedBed.id,
      patientId: selectedBed.patient_id || null,
      summary: `Discharge checklist updated for bed ${selectedBed.bed_number} (${selectedBed.patient_name || 'no patient'})`,
      metadata: {
        bed_number: selectedBed.bed_number,
        patient_name: selectedBed.patient_name || null,
        billing_cleared: billingCleared,
        pharmacy_cleared: pharmacyCleared,
        doctor_signed: doctorSigned,
      },
    })
  }

  async function confirmDischarge(){
    await updateRecord(selectedBed.id, {
      status: 'cleaning',
      patient_name: null, doctor_name: null, diagnosis: null, admission_date: null,
      billing_cleared: false, pharmacy_cleared: false, doctor_signed: false,
    })
    // CRITICAL FIX (Bug: PatientProfile still shows "admitted" after discharge from IPD)
    // -----------------------------------------------------------------
    // Previously IPD's confirmDischarge only updated the bed table —
    // it didn't touch `admissions` or `admission_requests`. So
    // PatientProfile.jsx:273 (which reads from `admission_requests`)
    // kept showing "Currently Admitted" forever after a discharge
    // done from IPD.
    //
    // Now we look up the active admission for this bed + update it to
    // 'discharged', and also flip its linked admission_request to
    // 'discharged' so the PatientProfile card disappears.
    try {
      // Look up the active admission by bed_id (only one bed can have
      // one active admission at a time)
      const { data: activeAdmission } = await supabase
        .from('admissions')
        .select('id, admission_request_id, patient_id')
        .eq('hospital_id', hospital?.id)
        .eq('bed_id', selectedBed.id)
        .eq('status', 'active')
        .maybeSingle()

      if (activeAdmission) {
        // Update the admission itself
        await supabase
          .from('admissions')
          .update({
            status: 'discharged',
            discharge_date: new Date().toISOString(),
          })
          .eq('id', activeAdmission.id)

        // Update the linked admission_request (this is what
        // PatientProfile.jsx reads to render the "Currently Admitted"
        // card — without this update, the card stays visible)
        if (activeAdmission.admission_request_id) {
          await supabase
            .from('admission_requests')
            .update({
              status: 'discharged',
              reviewed_at: new Date().toISOString(),
            })
            .eq('id', activeAdmission.admission_request_id)
        }

        // Invalidate the offline-table cache for both tables so any
        // mounted PatientProfile / Admissions module re-reads from
        // IndexedDB (which will pick up the change on next sync).
        try {
          invalidateTable('admissions', hospital?.id)
          invalidateTable('admission_requests', hospital?.id)
        } catch (e) {
          console.warn('Could not invalidate table cache after discharge:', e.message)
        }
      }
    } catch (admissionErr) {
      // Non-fatal — the bed is already marked 'cleaning'. The
      // admission record might still show 'active' until the next
      // sync, but the bed is free for re-admission.
      console.warn('Failed to update admission/admission_request on IPD discharge:', admissionErr.message)
    }
    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'ipd.patient_discharged',
      entityType: 'bed', entityId: selectedBed.id,
      patientId: selectedBed.patient_id || null,
      summary: `Discharged ${selectedBed.patient_name || 'patient'} from bed ${selectedBed.bed_number} — bed marked for cleaning`,
      metadata: {
        bed_number: selectedBed.bed_number,
        patient_name: selectedBed.patient_name || null,
        doctor_name: selectedBed.doctor_name || null,
        diagnosis: selectedBed.diagnosis || null,
        admission_date: selectedBed.admission_date || null,
        bed_status_change: 'occupied → cleaning',
      },
    })
    setShowDischarge(false)
    setSelectedBed(null)
    showToast('Discharged — bed marked for cleaning')
  }

  async function markCleaned(bed){
    await updateRecord(bed.id, { status: 'available' })
    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'ipd.bed_cleaned',
      entityType: 'bed', entityId: bed.id,
      summary: `Bed ${bed.bed_number} marked cleaned & available`,
      metadata: { bed_number: bed.bed_number, section: bed.section, bed_status_change: 'cleaning → available' },
    })
    setSelectedBed(null)
    showToast('Bed marked available')
  }

  async function handleDeleteBed(bed){
    if (!confirm(`Remove bed ${bed.bed_number}?`)) return
    await deleteRecord(bed.id)
    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'ipd.bed_removed',
      entityType: 'bed', entityId: bed.id,
      summary: `Removed bed ${bed.bed_number} from ${SECTIONS.find(s => s.key === bed.section)?.label || bed.section}`,
      metadata: { bed_number: bed.bed_number, section: bed.section, last_status: bed.status },
    })
    setSelectedBed(null)
    showToast('Bed removed')
  }

  const allChecked = billingCleared && pharmacyCleared && doctorSigned

  return (
    <>
      {/* ---- Early-warning alerts banner ---- */}
      <VitalsAlertsBanner hospitalId={hospital?.id} />

      <div className="dash-panel" style={{ marginBottom: 16 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Ward &amp; Bed Map</div>
            <div className="dash-panel-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: isOnline ? 'var(--teal)' : 'var(--danger)', display: 'inline-block' }} />
              {isOnline ? 'Online' : 'Offline'}{pendingCount > 0 ? ` · ${pendingCount} syncing` : ''} · Tap a bed for details
            </div>
          </div>
          <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => setShowAddBed(true)}>+ Add Bed</button>
          <ModuleHistoryButton moduleKey="ipd" />
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 4, fontSize: 11.5 }}>
          {Object.entries(STATUS_COLOR).map(([key, s]) => (
            <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: s.bg, border: `1px solid ${s.border}` }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="dash-panel" style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
      ) : (
        SECTIONS.map(section => {
          const sectionBeds = beds.filter(b => b.section === section.key)
          return (
            <div className="dash-panel" key={section.key} style={{ marginBottom: 16 }}>
              <div className="dash-panel-head">
                <div className="dash-panel-title" style={{ fontSize: 15 }}>{section.label}</div>
                <div className="dash-panel-sub" style={{ margin: 0 }}>{sectionBeds.length} bed(s)</div>
              </div>
              {sectionBeds.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '8px 0' }}>No beds set up in this section yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 10 }}>
                  {sectionBeds.map(bed => {
                    const s = STATUS_COLOR[bed.status]
                    return (
                      <div
                        key={bed.id}
                        onClick={() => openBed(bed)}
                        style={{
                          background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10,
                          padding: '12px 8px', textAlign: 'center', cursor: 'pointer', transition: '.15s',
                        }}
                      >
                        <div style={{ fontWeight: 800, fontSize: 13, color: s.text }}>{bed.bed_number}</div>
                        <div style={{ fontSize: 9.5, color: s.text, marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })
      )}

      {/* Available bed: info only — admission now happens through the
          Admissions module (approved request -> bed assignment), not by
          free-typing a name directly onto a bed. */}
      {selectedBed && selectedBed.status === 'available' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}
          onClick={() => setSelectedBed(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 4 }}>Bed {selectedBed.bed_number}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>{SECTIONS.find(s => s.key === selectedBed.section)?.label} · Available</div>
            <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
              This bed is free. To admit a patient into it, approve an admission request in the Admissions module and assign this bed during confirmation.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setSelectedBed(null)}>Close</button>
              {onGoToAdmissions && (
                <button className="btn btn-primary" onClick={() => { setSelectedBed(null); onGoToAdmissions() }}>Go to Admissions</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bed detail panel for occupied beds */}
      {selectedBed && selectedBed.status === 'occupied' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}
          onClick={() => setSelectedBed(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 4 }}>Bed {selectedBed.bed_number}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>{SECTIONS.find(s => s.key === selectedBed.section)?.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20, fontSize: 13.5 }}>
              <div><span style={{ color: 'var(--muted)' }}>Patient: </span><b>{selectedBed.patient_name}</b></div>
              {selectedBed.doctor_name && <div><span style={{ color: 'var(--muted)' }}>Doctor: </span>{selectedBed.doctor_name}</div>}
              {selectedBed.admission_date && <div><span style={{ color: 'var(--muted)' }}>Admitted: </span>{selectedBed.admission_date}</div>}
              {selectedBed.diagnosis && <div><span style={{ color: 'var(--muted)' }}>Diagnosis: </span>{selectedBed.diagnosis}</div>}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setSelectedBed(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => setShowDischarge(true)}>Initiate Discharge Clearance</button>
            </div>
          </div>
        </div>
      )}

      {/* Cleaning-status bed: allow marking as cleaned, or delete */}
      {selectedBed && selectedBed.status === 'cleaning' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}
          onClick={() => setSelectedBed(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 18 }}>Bed {selectedBed.bed_number} — Pending Cleaning</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => handleDeleteBed(selectedBed)}>Remove Bed</button>
              <button className="btn btn-primary" onClick={() => markCleaned(selectedBed)}>Mark Cleaned &amp; Available</button>
            </div>
          </div>
        </div>
      )}

      {/* Discharge clearance checklist modal */}
      {showDischarge && selectedBed && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 55, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 400 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 4 }}>Discharge Clearance</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>{selectedBed.patient_name} — Bed {selectedBed.bed_number}</div>
            {[
              { label: 'Billing cleared', val: billingCleared, set: setBillingCleared },
              { label: 'Pharmacy cleared', val: pharmacyCleared, set: setPharmacyCleared },
              { label: 'Doctor signed off', val: doctorSigned, set: setDoctorSigned },
            ].map((c, i) => (
              <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: i < 2 ? '1px solid var(--line-soft)' : 'none', cursor: 'pointer', fontSize: 13.5 }}>
                <input type="checkbox" checked={c.val} onChange={e => { c.set(e.target.checked); setTimeout(saveChecklist, 0) }} style={{ width: 18, height: 18, accentColor: 'var(--teal)' }} />
                {c.label}
              </label>
            ))}
            <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
              <button className="btn btn-ghost" onClick={() => setShowDischarge(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!allChecked} onClick={confirmDischarge}>
                {allChecked ? 'Confirm Discharge' : 'Complete checklist to continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddBed && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 400 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 18 }}>Add Bed</div>
            <form onSubmit={handleAddBed}>
              <div className="field">
                <label>Section</label>
                <select value={newSection} onChange={e => setNewSection(e.target.value)}>
                  {SECTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Bed Number</label>
                <input value={newBedNumber} onChange={e => setNewBedNumber(e.target.value)} placeholder="e.g. G-14" />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowAddBed(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Add Bed</button>
              </div>
            </form>
          </div>
        </div>
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

// =====================================================================
// VitalsAlertsBanner — shows active early-warning alerts for admitted
// inpatients. Shown at the top of the IPD ward map.
//
// Nurses and doctors can acknowledge alerts. Acknowledgement stores
// who, when, and an optional note. The alert stays in history — it
// is NOT deleted.
// =====================================================================
function VitalsAlertsBanner({ hospitalId }) {
  const { profile } = useAuth()
  const { records: alerts, updateRecord } = useOfflineTable('patient_vitals_alerts', hospitalId)
  const [acknowledgingId, setAcknowledgingId] = useState(null)
  const [ackNote, setAckNote] = useState('')

  // Realtime: refresh when new alerts are created
  useRealtimeAlert('patient_vitals_alerts', hospitalId, () => {})

  const activeAlerts = useMemo(() => {
    return (alerts || [])
      .filter(a => a.status === 'active')
      .sort((a, b) => {
        // Critical first, then warning, then informational
        const rank = { critical: 0, warning: 1, informational: 2 }
        const rankDiff = (rank[a.severity] || 3) - (rank[b.severity] || 3)
        if (rankDiff !== 0) return rankDiff
        return new Date(b.created_at) - new Date(a.created_at)
      })
  }, [alerts])

  const canAcknowledge = profile && ['doctor', 'nurse', 'admin', 'owner'].includes(profile.role)

  async function handleAcknowledge(alert) {
    if (!canAcknowledge) return
    try {
      await updateRecord(alert.id, {
        status: 'acknowledged',
        acknowledged_by: profile.id,
        acknowledged_by_name: profile.full_name,
        acknowledged_at: new Date().toISOString(),
        acknowledgement_note: ackNote.trim() || null,
      })
      writeAudit({
        hospitalId, actor: profile,
        action: 'vitals_alert.acknowledged',
        entityType: 'patient_vitals_alert', entityId: alert.id,
        patientId: alert.patient_id,
        summary: `Acknowledged vitals alert for ${alert.patient_name}: ${alert.reason}${ackNote.trim() ? ` — note: ${ackNote.trim()}` : ''}`,
        metadata: { alert_id: alert.id, vital_name: alert.vital_name, severity: alert.severity, note: ackNote.trim() || null },
      })
      setAcknowledgingId(null)
      setAckNote('')
    } catch (err) {
      // non-fatal
    }
  }

  if (activeAlerts.length === 0) return null

  return (
    <div style={{
      padding: 14, borderRadius: 12, marginBottom: 16,
      background: 'rgba(225,104,94,0.06)',
      border: '1px solid rgba(225,104,94,0.25)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <AppIcon name="alert" size={18} style={{ color: 'var(--danger)' }} />
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)' }}>
          Early-Warning Alerts ({activeAlerts.length})
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {activeAlerts.map(alert => (
          <div key={alert.id} style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'var(--bg-elevated)',
            border: `1px solid ${alert.severity === 'critical' ? 'var(--danger)' : alert.severity === 'warning' ? 'var(--gold)' : 'var(--line)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                    background: alert.severity === 'critical' ? 'rgba(225,104,94,0.20)' : alert.severity === 'warning' ? 'rgba(201,169,97,0.20)' : 'rgba(59,130,246,0.14)',
                    color: alert.severity === 'critical' ? 'var(--danger)' : alert.severity === 'warning' ? 'var(--gold)' : 'var(--blue)',
                    textTransform: 'uppercase', letterSpacing: 0.5,
                  }}>
                    {alert.severity}
                  </span>
                  <strong style={{ fontSize: 13 }}>{alert.patient_name}</strong>
                  {alert.ward_section && (
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>{alert.ward_section}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ivory)', lineHeight: 1.5 }}>
                  {alert.reason}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
                  Recorded by {alert.recorded_by_name || '—'} · {new Date(alert.recorded_at).toLocaleString('en-NG')}
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                {canAcknowledge && acknowledgingId !== alert.id && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: 'auto', padding: '5px 12px', fontSize: 11, color: 'var(--teal)', borderColor: 'var(--teal)' }}
                    onClick={() => { setAcknowledgingId(alert.id); setAckNote('') }}
                  >
                    Acknowledge
                  </button>
                )}
                {acknowledgingId === alert.id && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input
                      value={ackNote}
                      onChange={e => setAckNote(e.target.value)}
                      placeholder="Optional note…"
                      style={{ padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-card)', color: 'var(--ivory)', width: 200 }}
                    />
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button type="button" className="btn btn-primary" style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }} onClick={() => handleAcknowledge(alert)}>Confirm</button>
                      <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }} onClick={() => { setAcknowledgingId(null); setAckNote('') }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
