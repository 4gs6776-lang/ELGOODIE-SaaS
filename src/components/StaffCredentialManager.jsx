import { useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import AppIcon from './icons'
import { Upload, Check, X, ShieldCheck, AlertTriangle, Calendar } from 'lucide-react'

// =====================================================================
// StaffCredentialManager — manages staff professional licenses + certs
// =====================================================================
// Shows a table of credentials with color-coded expiry badges:
//   - Green: >60 days to expiry
//   - Yellow: 30-60 days to expiry
//   - Red: <30 days or expired
//
// Admin can: add credentials, upload license documents, verify credentials.
// All staff can view. Only admin/owner can edit.
// =====================================================================

const CREDENTIAL_TYPES = {
  medical_license: 'Medical License (MDCN)',
  nursing_license: 'Nursing License',
  pharmacy_license: 'Pharmacy License',
  lab_scientist_license: 'Lab Scientist License',
  specialist_registration: 'Specialist Registration',
  cpr_certification: 'CPR / BLS Certification',
  other: 'Other',
}

function daysUntilExpiry(expiryDate) {
  if (!expiryDate) return null
  const now = new Date()
  const expiry = new Date(expiryDate)
  const diff = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
  return diff
}

function expiryBadge(expiryDate) {
  const days = daysUntilExpiry(expiryDate)
  if (days === null) return { color: 'var(--muted)', label: '—', bg: 'rgba(150,150,150,0.15)' }
  if (days < 0) return { color: 'var(--danger)', label: 'EXPIRED', bg: 'var(--danger-soft)' }
  if (days <= 30) return { color: 'var(--danger)', label: `${days}d left`, bg: 'var(--danger-soft)' }
  if (days <= 60) return { color: 'var(--gold)', label: `${days}d left`, bg: 'var(--warning-soft)' }
  return { color: 'var(--success)', label: `${days}d left`, bg: 'var(--success-soft)' }
}

export default function StaffCredentialManager({ staffMembers }) {
  const { profile, hospital } = useAuth()
  const { records: credentials, addRecord, updateRecord, deleteRecord } = useOfflineTable('staff_credentials', hospital?.id, { realtime: true })

  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedStaff, setSelectedStaff] = useState('')
  const [credType, setCredType] = useState('medical_license')
  const [credNumber, setCredNumber] = useState('')
  const [issuingBody, setIssuingBody] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [docFile, setDocFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner'

  // Group credentials by staff member
  const credentialsByStaff = useMemo(() => {
    const map = {}
    credentials?.forEach(c => {
      if (!map[c.staff_id]) map[c.staff_id] = []
      map[c.staff_id].push(c)
    })
    return map
  }, [credentials])

  // Overall credential status per staff member
  const staffStatus = useMemo(() => {
    const statusMap = {}
    staffMembers?.forEach(s => {
      const creds = credentialsByStaff[s.id] || []
      if (creds.length === 0) {
        statusMap[s.id] = { status: 'none', label: 'No credentials', color: 'var(--muted)' }
      } else {
        const hasExpired = creds.some(c => daysUntilExpiry(c.expiry_date) < 0)
        const hasExpiringSoon = creds.some(c => { const d = daysUntilExpiry(c.expiry_date); return d >= 0 && d <= 60 })
        const allVerified = creds.every(c => c.is_verified)
        if (hasExpired) {
          statusMap[s.id] = { status: 'expired', label: 'Expired', color: 'var(--danger)' }
        } else if (hasExpiringSoon) {
          statusMap[s.id] = { status: 'expiring', label: 'Expiring soon', color: 'var(--gold)' }
        } else if (allVerified) {
          statusMap[s.id] = { status: 'valid', label: 'All valid', color: 'var(--success)' }
        } else {
          statusMap[s.id] = { status: 'unverified', label: 'Unverified', color: 'var(--gold)' }
        }
      }
    })
    return statusMap
  }, [staffMembers, credentialsByStaff])

  async function handleAddCredential(e) {
    e.preventDefault()
    setError('')
    if (!selectedStaff || !credNumber || !expiryDate) {
      setError('Staff member, credential number, and expiry date are required.')
      return
    }
    setUploading(true)
    try {
      let docPath = null
      if (docFile) {
        docPath = `${hospital.id}/${selectedStaff}/cred-${Date.now()}.pdf`
        const { error: uploadErr } = await supabase.storage
          .from('hospital-logos')
          .upload(docPath, docFile, { upsert: true, contentType: docFile.type })
        if (uploadErr) throw uploadErr
      }

      await addRecord({
        hospital_id: hospital.id,
        staff_id: selectedStaff,
        credential_type: credType,
        credential_number: credNumber,
        issuing_body: issuingBody || null,
        issue_date: issueDate || null,
        expiry_date: expiryDate,
        document_path: docPath,
        is_verified: false,
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_credential.added',
        entityType: 'staff_credentials', entityId: null,
        summary: `Added ${CREDENTIAL_TYPES[credType]} for staff member`,
        metadata: { staff_id: selectedStaff, credential_type: credType, expiry_date: expiryDate },
      })

      setShowAddModal(false)
      setToast('Credential added')
      // Reset form
      setCredNumber(''); setIssuingBody(''); setIssueDate(''); setExpiryDate(''); setDocFile(null)
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError(err.message || 'Could not add credential.')
    } finally {
      setUploading(false)
    }
  }

  async function handleVerify(credId, staffId) {
    try {
      await updateRecord(credId, {
        is_verified: true,
        verified_by: profile.id,
        verified_at: new Date().toISOString(),
      })
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_credential.verified',
        entityType: 'staff_credentials', entityId: credId,
        summary: `Verified a credential for a staff member`,
        metadata: { staff_id: staffId },
      })
      setToast('Credential verified')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }

  async function handleDelete(credId, staffId) {
    if (!confirm('Delete this credential? This cannot be undone.')) return
    try {
      await deleteRecord(credId)
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'staff_credential.deleted',
        entityType: 'staff_credentials', entityId: credId,
        summary: `Deleted a credential for a staff member`,
        metadata: { staff_id: staffId },
      })
      setToast('Credential deleted')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory)' }}>Credentialing</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {credentials?.length || 0} credential{(credentials?.length || 0) !== 1 ? 's' : ''} on file
          </div>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setShowAddModal(true)}>
            <Upload size={14} /> Add Credential
          </button>
        )}
      </div>

      {/* Staff credential cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {staffMembers?.map(member => {
          const creds = credentialsByStaff[member.id] || []
          const status = staffStatus[member.id] || { status: 'none', label: 'No credentials', color: 'var(--muted)' }
          return (
            <div key={member.id} style={{
              border: '1px solid var(--line)', borderRadius: 12, padding: 14,
              background: 'var(--bg-card)', overflow: 'hidden',
            }}>
              {/* Staff header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: creds.length > 0 ? 12 : 0, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(150deg,var(--blue),#2a5cc9)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#fff' }}>
                    {(member.full_name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{member.full_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{member.role}</div>
                  </div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                  background: status.color === 'var(--danger)' ? 'var(--danger-soft)' :
                             status.color === 'var(--gold)' ? 'var(--warning-soft)' :
                             status.color === 'var(--success)' ? 'var(--success-soft)' : 'rgba(150,150,150,0.15)',
                  color: status.color, textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  {status.label}
                </span>
              </div>

              {/* Credentials list */}
              {creds.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {creds.map(c => {
                    const badge = expiryBadge(c.expiry_date)
                    return (
                      <div key={c.id} style={{
                        display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 10, alignItems: 'center',
                        padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
                        fontSize: 12,
                      }}>
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--ivory)' }}>{CREDENTIAL_TYPES[c.credential_type] || c.credential_type}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {c.credential_number}
                            {c.issuing_body && ` · ${c.issuing_body}`}
                          </div>
                        </div>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                          background: badge.bg, color: badge.color,
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                          <Calendar size={10} /> {badge.label}
                        </span>
                        {c.is_verified ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 3 }}>
                            <ShieldCheck size={12} /> Verified
                          </span>
                        ) : (
                          isAdmin && (
                            <button onClick={() => handleVerify(c.id, member.id)} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--teal)', borderColor: 'var(--teal-border)' }}>
                              <Check size={12} /> Verify
                            </button>
                          )
                        )}
                        {isAdmin && (
                          <button onClick={() => handleDelete(c.id, member.id)} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--danger)', opacity: 0.7 }}>
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {creds.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>
                  No credentials on file for this staff member.
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Add Credential Modal */}
      {showAddModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 480 }}>
            <div className="dash-modal-title">Add Credential</div>
            <form onSubmit={handleAddCredential}>
              <div className="dash-modal-body">
                {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
                <div className="field">
                  <label>Staff Member *</label>
                  <select value={selectedStaff} onChange={e => setSelectedStaff(e.target.value)} required>
                    <option value="">Select staff member</option>
                    {staffMembers?.map(s => (
                      <option key={s.id} value={s.id}>{s.full_name} ({s.role})</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Credential Type *</label>
                  <select value={credType} onChange={e => setCredType(e.target.value)}>
                    {Object.entries(CREDENTIAL_TYPES).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Credential / License Number *</label>
                  <input value={credNumber} onChange={e => setCredNumber(e.target.value)} placeholder="e.g. MDCN/REG/12345" required />
                </div>
                <div className="field">
                  <label>Issuing Body</label>
                  <input value={issuingBody} onChange={e => setIssuingBody(e.target.value)} placeholder="e.g. Medical and Dental Council of Nigeria" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field">
                    <label>Issue Date</label>
                    <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Expiry Date *</label>
                    <input type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} required />
                  </div>
                </div>
                <div className="field">
                  <label>License Document (PDF)</label>
                  <input type="file" accept=".pdf,image/*" onChange={e => setDocFile(e.target.files?.[0] || null)} />
                  <div className="field-hint">Upload a scan of the license/certificate (optional)</div>
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={uploading}>{uploading ? 'Saving…' : 'Add Credential'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className="dash-toast dash-toast-success">{toast}</div>}
    </div>
  )
}
