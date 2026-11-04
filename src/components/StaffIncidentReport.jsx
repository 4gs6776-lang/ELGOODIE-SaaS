import { useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import { AlertTriangle, CheckCircle, X } from 'lucide-react'

// =====================================================================
// StaffIncidentReport — tracks staff incidents + commendations
// =====================================================================

const INCIDENT_TYPES = {
  absenteeism: 'Absenteeism',
  late_arrival: 'Late Arrival',
  protocol_violation: 'Protocol Violation',
  patient_complaint: 'Patient Complaint',
  medication_error: 'Medication Error',
  equipment_damage: 'Equipment Damage',
  commendation: 'Commendation',
  other: 'Other',
}

const SEVERITY_COLORS = {
  minor: { color: 'var(--gold)', bg: 'var(--warning-soft)' },
  moderate: { color: '#FF8C00', bg: 'rgba(255,140,0,0.12)' },
  major: { color: 'var(--danger)', bg: 'var(--danger-soft)' },
}

export default function StaffIncidentReport({ staffMembers }) {
  const { profile, hospital } = useAuth()
  const { records: incidents, addRecord, updateRecord } = useOfflineTable('staff_incidents', hospital?.id, { realtime: true })

  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedStaff, setSelectedStaff] = useState('')
  const [incidentType, setIncidentType] = useState('late_arrival')
  const [severity, setSeverity] = useState('minor')
  const [description, setDescription] = useState('')
  const [incidentDate, setIncidentDate] = useState(new Date().toISOString().slice(0, 10))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner'

  // Group by staff + sort by date desc
  const incidentsByStaff = useMemo(() => {
    const map = {}
    incidents?.forEach(i => {
      if (!map[i.staff_id]) map[i.staff_id] = []
      map[i.staff_id].push(i)
    })
    Object.values(map).forEach(arr => arr.sort((a, b) => new Date(b.incident_date) - new Date(a.incident_date)))
    return map
  }, [incidents])

  async function handleAdd(e) {
    e.preventDefault()
    setError('')
    if (!selectedStaff || !description || !incidentDate) {
      setError('Staff, description, and incident date are required.')
      return
    }
    setSaving(true)
    try {
      await addRecord({
        hospital_id: hospital.id,
        staff_id: selectedStaff,
        incident_type: incidentType,
        severity,
        description,
        incident_date: incidentDate,
        reported_by: profile.id,
        resolved: false,
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_incident.added',
        entityType: 'staff_incidents', entityId: null,
        summary: `Logged ${INCIDENT_TYPES[incidentType]} (${severity}) for a staff member`,
        metadata: { staff_id: selectedStaff, type: incidentType, severity },
      })

      setShowAddModal(false)
      setDescription(''); setSelectedStaff(''); setIncidentType('late_arrival'); setSeverity('minor')
      setToast('Incident logged')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError(err.message || 'Could not log incident.')
    } finally {
      setSaving(false)
    }
  }

  async function handleResolve(id, staffId) {
    const notes = prompt('Resolution notes (optional):') || ''
    try {
      await updateRecord(id, {
        resolved: true,
        resolution_notes: notes,
        resolved_at: new Date().toISOString(),
      })
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_incident.resolved',
        entityType: 'staff_incidents', entityId: id,
        summary: 'Resolved a staff incident',
        metadata: { staff_id: staffId, notes },
      })
      setToast('Incident resolved')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory)' }}>Incidents</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {incidents?.length || 0} incident{(incidents?.length || 0) !== 1 ? 's' : ''} · {incidents?.filter(i => !i.resolved).length || 0} unresolved
          </div>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setShowAddModal(true)}>
            <AlertTriangle size={14} /> Log Incident
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {staffMembers?.map(member => {
          const incs = incidentsByStaff[member.id]
          if (!incs || incs.length === 0) return null
          return (
            <div key={member.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--bg-card)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{member.full_name}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {incs.map(i => {
                  const sev = SEVERITY_COLORS[i.severity] || SEVERITY_COLORS.minor
                  return (
                    <div key={i.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10,
                      padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)', fontSize: 12,
                      opacity: i.resolved ? 0.6 : 1,
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                          <span style={{ fontWeight: 600, color: 'var(--ivory)' }}>{INCIDENT_TYPES[i.incident_type] || i.incident_type}</span>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: sev.bg, color: sev.color, textTransform: 'uppercase' }}>
                            {i.severity}
                          </span>
                          {i.resolved && <span style={{ fontSize: 10, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 3 }}><CheckCircle size={11} /> Resolved</span>}
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{i.description}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--muted-dim)', marginTop: 3 }}>
                          {new Date(i.incident_date).toLocaleDateString()}
                          {i.resolution_notes && ` · Resolution: ${i.resolution_notes}`}
                        </div>
                      </div>
                      {isAdmin && !i.resolved && (
                        <button onClick={() => handleResolve(i.id, member.id)} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--success)', borderColor: 'var(--success)' }}>
                          Resolve
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {Object.keys(incidentsByStaff).length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
            No incidents recorded.
          </div>
        )}
      </div>

      {showAddModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 460 }}>
            <div className="dash-modal-title">Log Incident</div>
            <form onSubmit={handleAdd}>
              <div className="dash-modal-body">
                {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
                <div className="field">
                  <label>Staff Member *</label>
                  <select value={selectedStaff} onChange={e => setSelectedStaff(e.target.value)} required>
                    <option value="">Select staff member</option>
                    {staffMembers?.map(s => <option key={s.id} value={s.id}>{s.full_name} ({s.role})</option>)}
                  </select>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field">
                    <label>Type *</label>
                    <select value={incidentType} onChange={e => setIncidentType(e.target.value)}>
                      {Object.entries(INCIDENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Severity *</label>
                    <select value={severity} onChange={e => setSeverity(e.target.value)}>
                      <option value="minor">Minor</option>
                      <option value="moderate">Moderate</option>
                      <option value="major">Major</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label>Incident Date *</label>
                  <input type="date" value={incidentDate} onChange={e => setIncidentDate(e.target.value)} required />
                </div>
                <div className="field">
                  <label>Description *</label>
                  <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Describe what happened..." required style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Log Incident'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className="dash-toast dash-toast-success">{toast}</div>}
    </div>
  )
}
