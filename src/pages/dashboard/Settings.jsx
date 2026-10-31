import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabaseClient'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { writeAudit } from '../../lib/audit'
import AppIcon from '../../components/icons'
import ServiceCatalogManager from '../../components/ServiceCatalogManager'
import PriceListManager from '../../components/PriceListManager'
import HmoContractManager from '../../components/HmoContractManager'
import PaymentMethodManager from '../../components/PaymentMethodManager'
import ExpenseVendorManager from '../../components/ExpenseVendorManager'
import RecurringExpenseManager from '../../components/RecurringExpenseManager'
import CreditControlRulesManager from '../../components/CreditControlRulesManager'
import RolePermissionManager from '../../components/RolePermissionManager'
import AppearanceSettings from '../../components/AppearanceSettings'
import FolderCategoryManager from '../../components/FolderCategoryManager'
import HmoProviderManager from '../../components/HmoProviderManager'
import {
  DEFAULT_REGISTRATION_FEES,
  FOLDER_CATEGORY_LABELS,
  FOLDER_CATEGORY_ORDER,
  formatFee,
} from '../../lib/registrationFees'

// Compress the image before uploading to storage. Same pattern as the
// patient photo compression in Reception.jsx — uses a canvas to resize
// the image to maxLogoWidth and returns a JPEG blob.
function compressLogo(file, maxWidth = 400) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        let w = img.width, h = img.height
        if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob(blob => {
          if (blob) resolve(blob)
          else reject(new Error('Could not compress the image.'))
        }, 'image/png', 0.92)
      }
      img.onerror = () => reject(new Error('Could not load the image.'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.readAsDataURL(file)
  })
}

export default function Settings(){
  const { profile, hospital, session, signOut } = useAuth()
  const [toast, setToast] = useState(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // ---- Bank accounts (admin / owner only) ---------------------------
  // The hospital's bank accounts shown on the printed bill. Uses the
  // existing offline-first hook — same pattern as every other table.
  const { records: bankAccounts, addRecord: addBankAccount, updateRecord: updateBankAccount, deleteRecord: deleteBankAccount } = useOfflineTable('hospital_bank_accounts', hospital?.id)

  const canManageBank = profile?.role === 'admin' || profile?.role === 'owner'

  // ---- Registration fees (admin / owner only) -----------------------
  // Per-hospital, per-folder-category fees charged when a patient is
  // registered. Defaults: personal 5k, family 10k, emergency 8k,
  // anc 30k, hmo free. Stored in hospital_registration_fees.
  const { records: feeRecords, addRecord: addFeeRecord, updateRecord: updateFeeRecord } = useOfflineTable('hospital_registration_fees', hospital?.id)
  const canManageFees = profile?.role === 'admin' || profile?.role === 'owner'
  const [feeDraft, setFeeDraft] = useState({})      // category → string amount being edited
  const [feeSaving, setFeeSaving] = useState(false)
  const [feeError, setFeeError] = useState('')

  // ---- Hospital logo (admin / owner only) ---------------------------
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState('')
  const { reload: reloadProfile } = useAuth()

  async function handleLogoUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so the same file can be selected again

    if (!file.type.startsWith('image/')) {
      setLogoError('Please select an image file (PNG, JPG, etc.).')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError('Image is too large (max 5MB). Please use a smaller image.')
      return
    }

    setLogoUploading(true)
    setLogoError('')
    try {
      const compressed = await compressLogo(file, 400)
      const filePath = `${hospital.id}/logo`

      // Upload (upsert = replace if exists)
      const { error: uploadErr } = await supabase.storage
        .from('hospital-logos')
        .upload(filePath, compressed, { upsert: true, contentType: 'image/png' })

      if (uploadErr) throw uploadErr

      // Get the public URL
      const { data: urlData } = supabase.storage
        .from('hospital-logos')
        .getPublicUrl(filePath)

      const logoUrl = `${urlData.publicUrl}?t=${Date.now()}` // cache-buster

      // Save to hospitals table
      const { error: updateErr } = await supabase
        .from('hospitals')
        .update({ logo_url: logoUrl })
        .eq('id', hospital.id)

      if (updateErr) throw updateErr

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'hospital.logo_updated',
        entityType: 'hospital', entityId: hospital.id,
        summary: `Updated hospital logo for ${hospital.name}`,
        metadata: { file_name: file.name, file_size: file.size, logo_url: logoUrl },
      })

      showToast('Logo updated')
      reloadProfile() // refresh hospital data so the sidebar picks up the new logo
    } catch (err) {
      setLogoError(err.message || 'Could not upload the logo.')
    } finally {
      setLogoUploading(false)
    }
  }

  const [showBankModal, setShowBankModal] = useState(false)
  const [bankEditingId, setBankEditingId] = useState(null)
  const [bankName, setBankName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [sortCode, setSortCode] = useState('')
  const [bankNotes, setBankNotes] = useState('')
  const [bankActive, setBankActive] = useState(true)
  const [bankSaving, setBankSaving] = useState(false)
  const [bankError, setBankError] = useState('')

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  function resetBankForm() {
    setBankEditingId(null)
    setBankName('')
    setAccountName('')
    setAccountNumber('')
    setSortCode('')
    setBankNotes('')
    setBankActive(true)
    setBankError('')
  }

  function openBankAdd() {
    resetBankForm()
    setShowBankModal(true)
  }

  function openBankEdit(account) {
    setBankEditingId(account.id)
    setBankName(account.bank_name || '')
    setAccountName(account.account_name || '')
    setAccountNumber(account.account_number || '')
    setSortCode(account.sort_code || '')
    setBankNotes(account.notes || '')
    setBankActive(account.active !== false)
    setBankError('')
    setShowBankModal(true)
  }

  async function handleBankSubmit(e) {
    e.preventDefault()
    setBankError('')

    if (!bankName.trim() || !accountName.trim() || !accountNumber.trim()) {
      setBankError('Bank name, account name, and account number are required.')
      return
    }
    if (!hospital?.id) {
      setBankError('Hospital is still loading.')
      return
    }
    if (!profile?.id) {
      setBankError('Your account is still loading.')
      return
    }

    setBankSaving(true)
    try {
      const payload = {
        bank_name: bankName.trim(),
        account_name: accountName.trim(),
        account_number: accountNumber.trim(),
        sort_code: sortCode.trim() || null,
        notes: bankNotes.trim() || null,
        active: bankActive,
      }

      if (bankEditingId) {
        await updateBankAccount(bankEditingId, payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hospital_bank_account.updated',
          entityType: 'hospital_bank_account', entityId: bankEditingId,
          summary: `Updated bank account ${bankName} (${accountNumber})`,
          metadata: payload,
        })
        showToast('Bank account updated')
      } else {
        payload.hospital_id = hospital.id
        payload.sort_order = (bankAccounts || []).length
        const saved = await addBankAccount(payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hospital_bank_account.created',
          entityType: 'hospital_bank_account', entityId: saved?.id || null,
          summary: `Added bank account ${bankName} (${accountNumber})`,
          metadata: payload,
        })
        showToast('Bank account added')
      }
      setShowBankModal(false)
      resetBankForm()
    } catch (err) {
      setBankError(err.message || 'Could not save the bank account.')
    } finally {
      setBankSaving(false)
    }
  }

  async function handleBankDelete(account) {
    if (!confirm(`Remove ${account.bank_name} account ${account.account_number}? It will no longer appear on printed bills.`)) return
    try {
      await deleteBankAccount(account.id)
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'hospital_bank_account.deleted',
        entityType: 'hospital_bank_account', entityId: account.id,
        summary: `Deleted bank account ${account.bank_name} (${account.account_number})`,
        metadata: { bank_name: account.bank_name, account_number: account.account_number },
      })
      showToast('Bank account removed')
    } catch (err) {
      showToast(err.message)
    }
  }

  async function handleBankToggleActive(account) {
    const next = account.active === false
    try {
      await updateBankAccount(account.id, { active: next })
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: next ? 'hospital_bank_account.activated' : 'hospital_bank_account.deactivated',
        entityType: 'hospital_bank_account', entityId: account.id,
        summary: `${next ? 'Activated' : 'Deactivated'} bank account ${account.bank_name} (${account.account_number})`,
        metadata: { active: next },
      })
      showToast(`${account.bank_name} ${next ? 'activated' : 'deactivated'}`)
    } catch (err) {
      showToast(err.message)
    }
  }

  // ---- Registration fee handlers ------------------------------------
  // Reads the current draft value for a category (or falls back to the
  // saved amount). Used to pre-fill the input as the user types.
  function getFeeDraftValue(category) {
    if (feeDraft[category] != null) return feeDraft[category]
    const row = feeRecords.find(f => f.category === category)
    if (row) return String(row.amount)
    return String(DEFAULT_REGISTRATION_FEES[category] || 0)
  }

  function setFeeDraftValue(category, value) {
    setFeeDraft(prev => ({ ...prev, [category]: value }))
  }

  // Save ALL edited fees in one go. For each category we either INSERT
  // a new row or UPDATE the existing row.
  async function handleSaveFees(e) {
    e?.preventDefault?.()
    setFeeError('')
    setFeeSaving(true)
    try {
      const changes = []
      for (const category of FOLDER_CATEGORY_ORDER) {
        const raw = feeDraft[category]
        if (raw == null) continue  // not edited
        const num = Number(raw)
        if (isNaN(num) || num < 0) {
          setFeeError(`Invalid amount for ${FOLDER_CATEGORY_LABELS[category]}.`)
          setFeeSaving(false)
          return
        }
        const row = feeRecords.find(f => f.category === category)
        if (row) {
          if (Number(row.amount) !== num) {
            await updateFeeRecord(row.id, {
              amount: num,
              is_active: true,
              updated_by: profile?.id || null,
            })
            changes.push({ category, amount: num, op: 'updated' })
          }
        } else {
          await addFeeRecord({
            hospital_id: hospital.id,
            category,
            amount: num,
            is_active: true,
            updated_by: profile?.id || null,
          })
          changes.push({ category, amount: num, op: 'created' })
        }
      }
      if (changes.length > 0) {
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hospital_registration_fees.updated',
          entityType: 'hospital_registration_fees', entityId: null,
          summary: `Updated ${changes.length} registration fee${changes.length === 1 ? '' : 's'}`,
          metadata: { changes },
        })
        showToast(`Saved ${changes.length} fee change${changes.length === 1 ? '' : 's'}`)
        setFeeDraft({})
      } else {
        showToast('No changes to save')
      }
    } catch (err) {
      setFeeError(err.message || 'Could not save the fees.')
    } finally {
      setFeeSaving(false)
    }
  }

  async function handleResetFee(category) {
    // Reset to the migration default
    const defaultValue = DEFAULT_REGISTRATION_FEES[category] || 0
    setFeeDraft(prev => ({ ...prev, [category]: String(defaultValue) }))
    showToast(`${FOLDER_CATEGORY_LABELS[category]} reset to default (${formatFee(defaultValue)})`)
  }

  async function handlePasswordChange(e){
    e.preventDefault()
    setFormError('')

    if (!newPassword || !confirmPassword) {
      setFormError('Please fill in the new password fields.')
      return
    }
    if (newPassword.length < 6) {
      setFormError('New password must be at least 6 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setFormError('New password and confirmation do not match.')
      return
    }

    setSaving(true)
    try {
      // Re-authenticate with the current password before changing it, if the
      // user's email is available — protects against a hijacked open session.
      if (session?.user?.email && currentPassword) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: session.user.email,
          password: currentPassword,
        })
        if (signInError) {
          setFormError('Current password is incorrect.')
          setSaving(false)
          return
        }
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) {
        setFormError(error.message || 'Could not update password.')
        setSaving(false)
        return
      }

      // Audit trail — password was changed. Records only the FACT that
      // it happened and who did it; never records the password itself,
      // the password length, or any derived value. Re-authentication
      // step is noted when it was performed.
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'user.password_changed',
        entityType: 'profile', entityId: profile?.id || null,
        summary: `${profile?.full_name || 'User'} changed their password${currentPassword ? ' (re-authenticated)' : ''}`,
        metadata: {
          user_id: profile?.id || null,
          re_authenticated: Boolean(currentPassword && session?.user?.email),
        },
      })

      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
      showToast('Password updated')
    } catch (err) {
      setFormError(err.message || 'Could not update password.')
    } finally {
      setSaving(false)
    }
  }

  function roleLabel(role){
    if (!role) return 'Staff'
    return role.charAt(0).toUpperCase() + role.slice(1)
  }

  return (
    <>
      <div className="dash-row dash-row-2">
        <div className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title">Your Profile</div>
              <div className="dash-panel-sub">Account details</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Full Name</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{profile?.full_name || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Email</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{session?.user?.email || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Role</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{roleLabel(profile?.role)}</div>
            </div>
          </div>
        </div>

      {/* ---- Appearance (available to all users — individual preference) ---- */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Appearance</div>
            <div className="dash-panel-sub">Customize your theme, mode, and accent color — saved per user</div>
          </div>
        </div>
        <div style={{ padding: 14 }}>
          <AppearanceSettings />
        </div>
      </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title">Hospital</div>
              <div className="dash-panel-sub">Organization details</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Hospital Name</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{hospital?.name || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Account Status</div>
              <div style={{
                display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20,
                background: hospital?.status === 'active' ? 'var(--teal-soft)' : 'rgba(201,169,97,0.14)',
                color: hospital?.status === 'active' ? 'var(--teal)' : 'var(--gold)',
              }}>
                {hospital?.status ? hospital.status.charAt(0).toUpperCase() + hospital.status.slice(1) : 'Unknown'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Hospital Logo (admin / owner only) ---- */}
      <div className="dash-panel" style={{ marginTop: 20, maxWidth: 460 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Hospital Logo</div>
            <div className="dash-panel-sub">Shown in sidebar, printed bills, and login page</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 0' }}>
          {/* Logo preview */}
          <div style={{
            width: 80, height: 80, borderRadius: 12,
            background: 'var(--bg-elevated)', border: '1px solid var(--line)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', flexShrink: 0,
          }}>
            {hospital?.logo_url ? (
              <img src={hospital.logo_url} alt="Hospital logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--teal)' }}>
                {(hospital?.name || 'H').charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <div style={{ flex: 1 }}>
            {logoError && <div className="error-box" style={{ marginBottom: 8, fontSize: 12 }}>{logoError}</div>}
            {canManageBank ? (
              <>
                <label htmlFor="logo-upload" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', borderRadius: 8,
                  background: 'var(--teal)', color: '#00251F',
                  fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                  opacity: logoUploading ? 0.6 : 1,
                }}>
                  <AppIcon name={logoUploading ? 'loading' : 'camera'} size={14} spin={logoUploading} />
                  {logoUploading ? 'Uploading…' : (hospital?.logo_url ? 'Replace Logo' : 'Upload Logo')}
                </label>
                <input
                  id="logo-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  disabled={logoUploading}
                  style={{ display: 'none' }}
                />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  PNG or JPG. Max 5MB. Recommended: square or wide logo, transparent background.
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Only hospital administrators can change the logo.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="dash-panel" style={{ marginTop: 20, maxWidth: 460 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Change Password</div>
            <div className="dash-panel-sub">Update your account password</div>
          </div>
        </div>

        {formError && <div className="error-box">{formError}</div>}

        <form onSubmit={handlePasswordChange}>
          <div className="field">
            <label>Current Password</label>
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <div className="field">
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 6 characters" />
          </div>
          <div className="field">
            <label>Confirm New Password</label>
            <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ marginTop: 10 }}>
            {saving ? 'Updating…' : 'Update Password'}
          </button>
        </form>
      </div>

      {/* ---- Bank Account Details (admin / owner only) ---------------
          These accounts show on every printed bill so patients can pay
          by bank transfer. Multiple accounts allowed. */}
      <div className="dash-panel" style={{ marginTop: 20, maxWidth: 720 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Bank Account Details</div>
            <div className="dash-panel-sub">Shown on every printed bill so patients can pay by bank transfer</div>
          </div>
          {canManageBank && (
            <button className="btn btn-primary" style={{ width: 'auto' }} onClick={openBankAdd}>+ Add Account</button>
          )}
        </div>

        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can add or edit bank account details. Ask your admin to set them up.
          </div>
        ) : (bankAccounts || []).length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No bank accounts yet. Add one so patients can pay by bank transfer.
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary" style={{ width: 'auto' }} onClick={openBankAdd}>
                <AppIcon name="plus" size={14} /> Add your first account
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {(bankAccounts || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(a => (
              <div
                key={a.id}
                style={{
                  padding: 14, borderRadius: 10,
                  background: a.active === false ? 'var(--bg-card)' : 'var(--bg-elevated)',
                  border: `1px solid ${a.active === false ? 'var(--line)' : 'var(--line-soft)'}`,
                  opacity: a.active === false ? 0.6 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13.5 }}>{a.bank_name}</strong>
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                    background: a.active === false ? 'rgba(154,170,183,0.14)' : 'rgba(0,199,199,0.14)',
                    color: a.active === false ? 'var(--muted)' : 'var(--teal)',
                    textTransform: 'uppercase', letterSpacing: 0.5,
                  }}>
                    {a.active === false ? 'Hidden' : 'Active'}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ivory)', lineHeight: 1.5 }}>
                  <div>{a.account_name}</div>
                  <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--blue)', fontSize: 13.5 }}>
                    {a.account_number}
                  </div>
                  {a.sort_code && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Sort: {a.sort_code}</div>}
                  {a.notes && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, fontStyle: 'italic' }}>{a.notes}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '5px 10px', fontSize: 11 }} onClick={() => openBankEdit(a)}>
                    Edit
                  </button>
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '5px 10px', fontSize: 11 }} onClick={() => handleBankToggleActive(a)}>
                    {a.active === false ? 'Activate' : 'Hide'}
                  </button>
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '5px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => handleBankDelete(a)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Inline note for admins without accounts yet */}
        {canManageBank && (bankAccounts || []).length === 0 && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 6, background: 'rgba(232,184,46,0.06)', border: '1px solid rgba(232,184,46,0.25)', fontSize: 12, color: 'var(--gold)', lineHeight: 1.5 }}>
            <strong>Heads up:</strong> Until you add a bank account, the printed bill will not include any bank transfer details — only the standard totals.
          </div>
        )}
      </div>

      {/* ---- Registration Fees (admin / owner only) ------------------------
          Per-hospital fees charged when a patient is registered.
          Default amounts are seeded by migration 031. Admins can edit
          them here; the new amounts take effect immediately for every
          new patient registered at Reception or via the Dashboard
          quick-add form. */}
      <div className="dash-panel" style={{ marginTop: 20, maxWidth: 720 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Registration Fees</div>
            <div className="dash-panel-sub">Folder fees auto-charged when a patient is registered at Reception</div>
          </div>
        </div>

        {!canManageFees ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can edit registration fees. Ask your admin to set them up.
          </div>
        ) : (
          <form onSubmit={handleSaveFees}>
            {feeError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{feeError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              {FOLDER_CATEGORY_ORDER.map(category => {
                const row = feeRecords.find(f => f.category === category)
                const savedAmount = row ? Number(row.amount) : Number(DEFAULT_REGISTRATION_FEES[category] || 0)
                const draftValue = getFeeDraftValue(category)
                const isEdited = feeDraft[category] != null && Number(feeDraft[category]) !== savedAmount
                return (
                  <div
                    key={category}
                    style={{
                      padding: 14, borderRadius: 10,
                      background: 'var(--bg-elevated)',
                      border: `1px solid ${isEdited ? 'var(--teal-border)' : 'var(--line-soft)'}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <strong style={{ fontSize: 13.5 }}>{FOLDER_CATEGORY_LABELS[category]}</strong>
                      {isEdited && (
                        <span style={{
                          fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                          background: 'rgba(0,199,199,0.14)', color: 'var(--teal)',
                          textTransform: 'uppercase', letterSpacing: 0.5,
                        }}>
                          edited
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 700 }}>₦</span>
                      <input
                        type="number"
                        min="0"
                        step="100"
                        value={draftValue}
                        onChange={e => setFeeDraftValue(category, e.target.value)}
                        placeholder="0"
                        style={{ flex: 1, fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ width: 'auto', padding: '6px 10px', fontSize: 11, color: 'var(--muted)' }}
                        onClick={() => handleResetFee(category)}
                        title="Reset to default"
                      >
                        Reset
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                      Default: {formatFee(DEFAULT_REGISTRATION_FEES[category])}
                      {Number(draftValue) === 0 ? ' · Free (no charge)' : ''}
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="submit" className="btn btn-primary" disabled={feeSaving}>
                {feeSaving ? 'Saving…' : 'Save Fee Changes'}
              </button>
            </div>

            <div style={{
              marginTop: 14, padding: '10px 12px', borderRadius: 6,
              background: 'rgba(0,199,199,0.06)', border: '1px solid var(--line-soft)',
              fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6,
            }}>
              <strong style={{ color: 'var(--teal)' }}>How it works:</strong> When a patient is registered at
              Reception (or via the Dashboard quick-add), a pending charge for the folder fee is automatically
              sent to the cashier's queue. The cashier can then collect it (with wallet auto-deduction if the
              patient has a wallet balance) or the receptionist can waive it with a reason.
            </div>
          </form>
        )}
      </div>

      {/* ---- Folder Categories (admin / owner only) ----------------------
          Admin can enable/disable which folder categories appear at patient
          registration. Also controls the registration fee per category. */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Folder Categories</div>
            <div className="dash-panel-sub">Enable or disable patient folder categories + set registration fees</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can configure folder categories.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <FolderCategoryManager hospital={hospital} profile={profile} />
          </div>
        )}
      </div>

      {/* ---- Service Catalog (admin / owner / billing only) ---------------
          Master list of billable services. Every charge created downstream
          (in Pharmacy, Lab, Reception, CashierWorkspace) references a
          catalog row by code, so prices are always sourced from a price
          list — never typed ad-hoc. Migration 040 seeds ~30 common services. */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Service Catalog</div>
            <div className="dash-panel-sub">Master list of billable services & items — consultations, labs, procedures, drugs, bed charges, ANC packages</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can edit the catalog.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <ServiceCatalogManager />
          </div>
        )}
      </div>

      {/* ---- Price Lists / Tariffs (admin / owner / billing only) -------- */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Price Lists / Tariffs</div>
            <div className="dash-panel-sub">Multiple tariffs for walk-in, HMO, staff, corporate patients — each with custom pricing & coverage rules</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can edit price lists.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <PriceListManager />
          </div>
        )}
      </div>

      {/* ---- HMO Contracts (admin / owner / billing only) ---------------- */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">HMO / Payer Contracts</div>
            <div className="dash-panel-sub">Payer contracts with coverage %, pre-auth rules, and linked price lists</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can edit contracts.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <HmoContractManager />
          </div>
        )}
      </div>

      {/* ---- HMO Providers (admin / owner only) ---------------------------
          Admin manages which HMOs appear in the folder-opening dropdown
          when a patient is registered as 'HMO Folder'. Adds custom HMOs
          + shows/hides the default system HMOs. */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">HMO Providers</div>
            <div className="dash-panel-sub">Manage which HMOs appear in the registration dropdown when opening an HMO folder</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can configure HMO providers.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <HmoProviderManager hospital={hospital} profile={profile} />
          </div>
        )}
      </div>

      {/* ---- Payment Methods (admin / owner / billing only) -------------- */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Payment Methods</div>
            <div className="dash-panel-sub">Configure which payment methods appear in dropdowns — cash, POS, transfer, cheque, etc.</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can edit payment methods.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <PaymentMethodManager />
          </div>
        )}
      </div>

      {/* ---- Expense Vendors (admin / owner / billing only) --------------- */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Expense Vendors</div>
            <div className="dash-panel-sub">Suppliers, utility companies, contractors — link expenses to vendors for tracking</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can edit vendors.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <ExpenseVendorManager />
          </div>
        )}
      </div>

      {/* ---- Recurring Expenses (admin / owner / billing only) -----------
          Templates for expenses that should be auto-posted on a schedule
          (weekly, monthly, quarterly, yearly). e.g.:
            - Staff salaries, monthly, on the 1st
            - Rent, monthly, on the 1st
            - NEPA bill, monthly, on the 5th
            - Annual insurance, yearly, Jan 1st */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Recurring Expenses</div>
            <div className="dash-panel-sub">Auto-post templates for salaries, rent, utilities, etc. — set up once, posts monthly/quarterly/yearly</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can manage recurring expenses.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <RecurringExpenseManager />
          </div>
        )}
      </div>

      {/* ---- Credit Control Rules (admin / owner only) --------------------
          Configure rules that block or warn on new services when a patient
          has an outstanding balance above a threshold for too long. */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Credit Control Rules</div>
            <div className="dash-panel-sub">Block services for patients with overdue balances — configurable thresholds + actions</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can configure credit control rules.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <CreditControlRulesManager />
          </div>
        )}
      </div>

      {/* ---- Role Permissions (admin / owner only) -------------------------
          Hospital admins can customize which modules each role can access
          and what actions (view/create/edit/delete) they can perform.
          Owner is always locked to full access. CMD is always read-only.
          Falls back to hardcoded defaults when no custom config exists. */}
      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">Role Permissions</div>
            <div className="dash-panel-sub">Customize which modules each role can access and what actions they can perform</div>
          </div>
        </div>
        {!canManageBank ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', background: 'var(--bg-elevated)', borderRadius: 8 }}>
            Only hospital administrators can configure role permissions.
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <RolePermissionManager hospital={hospital} profile={profile} />
          </div>
        )}
      </div>

      {/* ---- Bank account modal ---- */}
      {showBankModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowBankModal(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">{bankEditingId ? 'Edit Bank Account' : 'Add Bank Account'}</div>
            <div className="dash-modal-body">
              {bankError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{bankError}</div>}
              <form id="bank-account-form" onSubmit={handleBankSubmit}>
                <div className="field">
                  <label>Bank Name *</label>
                  <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="e.g. First Bank of Nigeria" autoFocus required />
                </div>
                <div className="field">
                  <label>Account Name *</label>
                  <input value={accountName} onChange={e => setAccountName(e.target.value)} placeholder="e.g. GOODIE MED HUB Ltd" required />
                </div>
                <div className="field">
                  <label>Account Number *</label>
                  <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="e.g. 0123456789" required />
                </div>
                <div className="field">
                  <label>Sort Code (optional)</label>
                  <input value={sortCode} onChange={e => setSortCode(e.target.value)} placeholder="e.g. 011" />
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <input value={bankNotes} onChange={e => setBankNotes(e.target.value)} placeholder="e.g. Use patient name as narration" />
                </div>
                <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="checkbox"
                    id="bank-active"
                    checked={bankActive}
                    onChange={e => setBankActive(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: 'var(--teal)' }}
                  />
                  <label htmlFor="bank-active" style={{ margin: 0, fontSize: 13, color: 'var(--ivory)' }}>
                    Show on printed bill
                  </label>
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setShowBankModal(false); resetBankForm() }}>Cancel</button>
              <button type="submit" form="bank-account-form" className="btn btn-primary" disabled={bankSaving}>
                {bankSaving ? 'Saving…' : (bankEditingId ? 'Save Changes' : 'Add Account')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="dash-panel" style={{ marginTop: 20, maxWidth: 460 }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title">Session</div>
            <div className="dash-panel-sub">Sign out of this device</div>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={signOut}>Sign Out</button>
      </div>

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
