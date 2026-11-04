import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabaseClient'
import SearchInput from '../../components/common/SearchInput'
import AppIcon from '../../components/icons'
import Timestamp from '../../components/common/Timestamp'
import { buildPermissions, ROLE_LABELS } from '../../lib/permissions'
import { writeAudit } from '../../lib/audit'
import { assertWriteAllowed } from '../../lib/subscriptionLock'
import { assertWithinPlanLimit } from '../../lib/planEntitlements'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import StaffCredentialManager from '../../components/StaffCredentialManager'
import StaffCMEManager from '../../components/StaffCMEManager'
import StaffIncidentReport from '../../components/StaffIncidentReport'
import StaffPerformanceDashboard from '../../components/StaffPerformanceDashboard'

const FN_CREATE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-staff`
const FN_UPDATE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/update-staff-login`

function initials(name) {
  if (!name) return '?'
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

export default function Staff(){
  const { profile, hospital, session } = useAuth()
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeTab, setActiveTab] = useState('directory')

  const [showAddModal, setShowAddModal] = useState(false)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('nurse')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')

  const [editTarget, setEditTarget] = useState(null)
  const [editEmail, setEditEmail] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState('')

  async function loadStaff(){
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false })
    if (!error) setStaff(data || [])
    setLoading(false)
  }

  useEffect(() => { loadStaff() }, [])

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleCreate(e){
    e.preventDefault()
    setFormError('')
    if (!fullName || !email || !password) {
      setFormError('Please fill in every field.')
      return
    }
    if (password.length < 6) {
      setFormError('Password must be at least 6 characters.')
      return
    }
    setCreating(true)
    try {
      // Expired/suspended hospital, or plan staff limit reached? Stop here,
      // before anything is sent to the server.
      assertWriteAllowed('profiles', 'add')
      assertWithinPlanLimit('staff', staff.filter(m => m.active !== false).length)
      const res = await fetch(FN_CREATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ fullName, email, password, role }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Could not add staff member')

      setShowAddModal(false)
      setFullName(''); setEmail(''); setPassword(''); setRole('nurse')
      showToast(`${fullName} added`)
      loadStaff()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setCreating(false)
    }
  }

  function openEdit(member){
    setEditTarget(member)
    setEditEmail('')
    setEditPassword('')
    setEditError('')
  }

  async function handleEditSubmit(e){
    e.preventDefault()
    setEditError('')
    if (!editEmail && !editPassword) {
      setEditError('Enter a new email and/or new password.')
      return
    }
    if (editPassword && editPassword.length < 6) {
      setEditError('Password must be at least 6 characters.')
      return
    }
    setEditing(true)
    try {
      const res = await fetch(FN_UPDATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ staffId: editTarget.id, newEmail: editEmail || undefined, newPassword: editPassword || undefined }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Could not update login')

      showToast(`${editTarget.full_name}'s login updated`)
      setEditTarget(null)
    } catch (err) {
      setEditError(err.message)
    } finally {
      setEditing(false)
    }
  }

  async function handleToggleActive(member){
    const goingActive = member.active === false
    if (!goingActive && !confirm(`Deactivate ${member.full_name}? They'll immediately lose access to log in, but their name stays on any records they've created.`)) return
    // Reactivating uses up a staff slot, so it is checked like adding.
    // Deactivating is a security action and is ALWAYS allowed.
    if (goingActive) {
      try {
        assertWriteAllowed('profiles', 'update')
        assertWithinPlanLimit('staff', staff.filter(m => m.active !== false).length)
      } catch (err) {
        showToast(err.message)
        return
      }
    }
    const { error } = await supabase.from('profiles').update({ active: goingActive }).eq('id', member.id)
    if (!error) {
      // Sensitive security action → audit trail (Stage 1 req. #16).
      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: goingActive ? 'staff.reactivate' : 'staff.deactivate',
        entityType: 'staff',
        entityId: member.id,
        summary: `${goingActive ? 'Reactivated' : 'Deactivated'} staff login for ${member.full_name} (${member.role})`,
        metadata: { staff_email: member.email, staff_role: member.role },
      })
      showToast(`${member.full_name} ${goingActive ? 'reactivated' : 'deactivated'}`)
      loadStaff()
    } else {
      showToast(error.message)
    }
  }

  const staffSearch = searchTerm.trim().toLowerCase()
  const visibleStaff = staffSearch ? staff.filter(m => [m.full_name, m.email, m.role, m.id].some(v => String(v || '').toLowerCase().includes(staffSearch))) : staff

  // Global Pagination Rule — the staff list can grow into the dozens
  // for larger hospitals, so only the current page's rows are rendered.
  // Page size 20 to match Inventory/Pharmacy (staff cards are compact).
  const {
    pageItems: pagedStaff, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(visibleStaff, { pageSize: 20, resetKey: staffSearch })

  // Stage 1: permission check now flows through the central permissions
  // module. `staff.manage` is granted to admin (as before); owner sees
  // the module but cannot add/edit staff logins — same as today.
  const perm = buildPermissions(profile?.role)
  const canManageStaff = perm.isAdmin

  return (
    <>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        {[
          { key: 'overview', label: 'Overview', adminOnly: true },
          { key: 'directory', label: 'Directory' },
          { key: 'credentials', label: 'Credentials' },
          { key: 'cme', label: 'CME' },
          { key: 'incidents', label: 'Incidents' },
        ].filter(t => !t.adminOnly || canManageStaff).map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '10px 18px', fontSize: 13, fontWeight: 600,
              border: 'none', borderBottom: activeTab === t.key ? '2px solid var(--teal)' : '2px solid transparent',
              background: 'transparent', color: activeTab === t.key ? 'var(--teal)' : 'var(--muted)',
              cursor: 'pointer', transition: 'color .2s ease', marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview tab — admin only */}
      {activeTab === 'overview' && canManageStaff && (
        <div className="dash-panel" style={{ marginBottom: 16 }}>
          <StaffPerformanceDashboard staffMembers={staff} />
        </div>
      )}

      {/* Credentials tab */}
      {activeTab === 'credentials' && (
        <div className="dash-panel" style={{ marginBottom: 16 }}>
          <StaffCredentialManager staffMembers={staff} />
        </div>
      )}

      {/* CME tab */}
      {activeTab === 'cme' && (
        <div className="dash-panel" style={{ marginBottom: 16 }}>
          <StaffCMEManager staffMembers={staff} />
        </div>
      )}

      {/* Incidents tab */}
      {activeTab === 'incidents' && (
        <div className="dash-panel" style={{ marginBottom: 16 }}>
          <StaffIncidentReport staffMembers={staff} />
        </div>
      )}

      {/* Directory tab (original staff list) */}
      {activeTab === 'directory' && (
      <div className="dash-panel">
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Staff</div>
            <div className="dash-panel-sub">{staff.length} member{staff.length !== 1 ? 's' : ''} at {hospital?.name || 'your hospital'}</div>
          </div>
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search staff name, email or role" style={{ minWidth: 260, maxWidth: 420 }} />
          {canManageStaff && (
            <button className="btn btn-primary" style={{ width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setShowAddModal(true)}>
              <AppIcon name="plus" size={14} /> Add Staff
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
        ) : visibleStaff.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No staff yet.</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pagedStaff.map(member => (
                <div key={member.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, opacity: member.active === false ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'linear-gradient(150deg,var(--blue),#2a5cc9)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#fff', letterSpacing: 0.5 }}>
                      {initials(member.full_name)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                        {member.full_name} {member.id === profile?.id && <span style={{ color: 'var(--muted)', fontWeight: 500 }}>(you)</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {ROLE_LABELS[member.role] || member.role}
                        {' · joined '}
                        <Timestamp iso={member.created_at} hospital={hospital} />
                        {member.active === false && <span style={{ color: 'var(--danger)', fontWeight: 700 }}> · Deactivated</span>}
                      </div>
                    </div>
                  </div>
                  {canManageStaff && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => openEdit(member)}
                        className="btn btn-ghost"
                        style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }}
                      >
                        Edit Login
                      </button>
                      {member.id !== profile?.id && (
                        <button
                          onClick={() => handleToggleActive(member)}
                          className="btn btn-ghost"
                          style={{
                            width: 'auto', padding: '6px 12px', fontSize: 12,
                            background: member.active === false ? 'var(--teal-soft)' : 'var(--danger-soft)',
                            border: member.active === false ? '1px solid var(--teal)' : '1px solid rgba(225,104,94,0.35)',
                            color: member.active === false ? 'var(--teal)' : 'var(--danger)',
                          }}
                        >
                          {member.active === false ? 'Reactivate' : 'Deactivate'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
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
              itemLabel="staff members"
            />
          </>
        )}
      </div>
      )}

      {showAddModal && (
        /* Shared modal chrome → bottom sheet with pinned actions on phones */
        <div className="dash-modal-backdrop">
          <div className="card dash-modal">
            <div className="dash-modal-title">Add Staff Member</div>
            <form onSubmit={handleCreate}>
              <div className="dash-modal-body">
                {formError && <div className="error-box">{formError}</div>}
                <div className="field">
                  <label htmlFor="staff-name">Full Name</label>
                  <input id="staff-name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. Nurse Adaeze" />
                </div>
                <div className="field">
                  <label htmlFor="staff-email">Email</label>
                  <input id="staff-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="staff@hospital.com" />
                </div>
                <div className="field">
                  <label htmlFor="staff-password">Password</label>
                  <input id="staff-password" type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="Set a password for them" />
                  <div className="field-hint">Share this with them — they can change it later.</div>
                </div>
                <div className="field">
                  <label htmlFor="staff-role">Role</label>
                  <select id="staff-role" value={role} onChange={e => setRole(e.target.value)}>
                    <option value="cmd">CMD (Chief Medical Director — read-only)</option>
                    <option value="doctor">Doctor</option>
                    <option value="nurse">Nurse</option>
                    <option value="front_desk">Front Desk / Reception</option>
                    <option value="pharmacist">Pharmacist</option>
                    <option value="lab">Laboratory</option>
                    <option value="billing">Billing</option>
                  </select>
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creating…' : 'Add Staff'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="dash-modal-backdrop">
          <div className="card dash-modal">
            <div className="dash-modal-title">Edit Login</div>
            <form onSubmit={handleEditSubmit}>
              <div className="dash-modal-body">
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{editTarget.full_name}</div>
                {editError && <div className="error-box">{editError}</div>}
                <div className="field">
                  <label htmlFor="edit-email">New Email (optional)</label>
                  <input id="edit-email" type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="Leave blank to keep current email" />
                </div>
                <div className="field">
                  <label htmlFor="edit-password">New Password (optional)</label>
                  <input id="edit-password" type="text" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="Leave blank to keep current password" />
                  <div className="field-hint">Useful if they forgot it — set a new one and share it with them.</div>
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setEditTarget(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={editing}>{editing ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div className="dash-toast dash-toast-success">{toast}</div>
      )}
    </>
  )
}
