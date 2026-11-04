import { useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import { Upload, Award, Clock, X } from 'lucide-react'

// =====================================================================
// StaffCMEManager — tracks Continuing Medical Education hours + certs
// =====================================================================

export default function StaffCMEManager({ staffMembers }) {
  const { profile, hospital } = useAuth()
  const { records: cmeRecords, addRecord, deleteRecord } = useOfflineTable('staff_cme_records', hospital?.id, { realtime: true })

  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedStaff, setSelectedStaff] = useState('')
  const [courseTitle, setCourseTitle] = useState('')
  const [provider, setProvider] = useState('')
  const [cmeHours, setCmeHours] = useState('')
  const [completionDate, setCompletionDate] = useState('')
  const [certFile, setCertFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner'

  // CME hours per staff member
  const cmeByStaff = useMemo(() => {
    const map = {}
    cmeRecords?.forEach(r => {
      if (!map[r.staff_id]) map[r.staff_id] = { records: [], totalHours: 0 }
      map[r.staff_id].records.push(r)
      map[r.staff_id].totalHours += Number(r.cme_hours) || 0
    })
    return map
  }, [cmeRecords])

  async function handleAdd(e) {
    e.preventDefault()
    setError('')
    if (!selectedStaff || !courseTitle || !cmeHours || !completionDate) {
      setError('Staff, course title, hours, and completion date are required.')
      return
    }
    setUploading(true)
    try {
      let certPath = null
      if (certFile) {
        certPath = `${hospital.id}/${selectedStaff}/cme-${Date.now()}.pdf`
        const { error: uploadErr } = await supabase.storage
          .from('hospital-logos')
          .upload(certPath, certFile, { upsert: true, contentType: certFile.type })
        if (uploadErr) throw uploadErr
      }

      await addRecord({
        hospital_id: hospital.id,
        staff_id: selectedStaff,
        course_title: courseTitle,
        provider: provider || null,
        cme_hours: parseFloat(cmeHours),
        completion_date: completionDate,
        certificate_path: certPath,
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_cme.added',
        entityType: 'staff_cme_records', entityId: null,
        summary: `Added CME record: ${courseTitle} (${cmeHours}h)`,
        metadata: { staff_id: selectedStaff, hours: cmeHours },
      })

      setShowAddModal(false)
      setCourseTitle(''); setProvider(''); setCmeHours(''); setCompletionDate(''); setCertFile(null)
      setToast('CME record added')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError(err.message || 'Could not add CME record.')
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(id, staffId) {
    if (!confirm('Delete this CME record?')) return
    try {
      await deleteRecord(id)
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_cme.deleted',
        entityType: 'staff_cme_records', entityId: id,
        summary: `Deleted a CME record`,
        metadata: { staff_id: staffId },
      })
      setToast('CME record deleted')
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
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory)' }}>CME Records</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {cmeRecords?.length || 0} record{(cmeRecords?.length || 0) !== 1 ? 's' : ''} · Total: {Object.values(cmeByStaff).reduce((s, v) => s + v.totalHours, 0).toFixed(1)}h
          </div>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setShowAddModal(true)}>
            <Upload size={14} /> Add CME
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {staffMembers?.map(member => {
          const data = cmeByStaff[member.id]
          if (!data || data.records.length === 0) return null
          return (
            <div key={member.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{member.full_name}</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={12} /> {data.totalHours.toFixed(1)}h total
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.records.map(r => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderRadius: 8, background: 'var(--bg-elevated)', fontSize: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--ivory)' }}>{r.course_title}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {r.provider && `${r.provider} · `}
                        {new Date(r.completion_date).toLocaleDateString()} · {r.cme_hours}h
                      </div>
                    </div>
                    {isAdmin && (
                      <button onClick={() => handleDelete(r.id, member.id)} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--danger)', opacity: 0.7 }}>
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
        {Object.keys(cmeByStaff).length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
            No CME records yet. Click "Add CME" to record the first one.
          </div>
        )}
      </div>

      {showAddModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 460 }}>
            <div className="dash-modal-title">Add CME Record</div>
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
                <div className="field">
                  <label>Course Title *</label>
                  <input value={courseTitle} onChange={e => setCourseTitle(e.target.value)} placeholder="e.g. Advanced Cardiac Life Support" required />
                </div>
                <div className="field">
                  <label>Provider</label>
                  <input value={provider} onChange={e => setProvider(e.target.value)} placeholder="e.g. Nigerian Medical Association" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field">
                    <label>CME Hours *</label>
                    <input type="number" step="0.5" value={cmeHours} onChange={e => setCmeHours(e.target.value)} placeholder="e.g. 8" required />
                  </div>
                  <div className="field">
                    <label>Completion Date *</label>
                    <input type="date" value={completionDate} onChange={e => setCompletionDate(e.target.value)} required />
                  </div>
                </div>
                <div className="field">
                  <label>Certificate (PDF)</label>
                  <input type="file" accept=".pdf,image/*" onChange={e => setCertFile(e.target.files?.[0] || null)} />
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={uploading}>{uploading ? 'Saving…' : 'Add CME Record'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className="dash-toast dash-toast-success">{toast}</div>}
    </div>
  )
}
