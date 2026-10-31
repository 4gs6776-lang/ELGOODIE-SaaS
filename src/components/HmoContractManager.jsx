import { useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import AppIcon from './icons'
import { PAYER_TYPES } from '../lib/billingService'

// =====================================================================
// HmoContractManager — CRUD UI for hmo_contracts.
// Shown in Settings → HMO Contracts. Admin/owner/billing only.
// =====================================================================

export default function HmoContractManager() {
  const { profile, hospital } = useAuth()
  const { records: contracts, addRecord, updateRecord, deleteRecord } = useOfflineTable('hmo_contracts', hospital?.id)
  const { records: priceLists } = useOfflineTable('price_lists', hospital?.id)

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const [form, setForm] = useState({
    payer_name: '', payer_type: 'hmo', contract_code: '',
    contact_name: '', contact_phone: '', contact_email: '', address: '',
    policy_prefix: '', default_coverage_percent: '100',
    requires_pre_auth: false, pre_auth_phone: '', pre_auth_email: '',
    price_list_id: '', effective_from: '', effective_to: '',
    is_active: true, notes: '',
  })

  function resetForm() {
    setForm({
      payer_name: '', payer_type: 'hmo', contract_code: '',
      contact_name: '', contact_phone: '', contact_email: '', address: '',
      policy_prefix: '', default_coverage_percent: '100',
      requires_pre_auth: false, pre_auth_phone: '', pre_auth_email: '',
      price_list_id: '', effective_from: '', effective_to: '',
      is_active: true, notes: '',
    })
    setEditingId(null); setError('')
  }

  function openModal(c = null) {
    if (c) {
      setEditingId(c.id)
      setForm({
        payer_name: c.payer_name || '',
        payer_type: c.payer_type || 'hmo',
        contract_code: c.contract_code || '',
        contact_name: c.contact_name || '',
        contact_phone: c.contact_phone || '',
        contact_email: c.contact_email || '',
        address: c.address || '',
        policy_prefix: c.policy_prefix || '',
        default_coverage_percent: String(c.default_coverage_percent ?? '100'),
        requires_pre_auth: !!c.requires_pre_auth,
        pre_auth_phone: c.pre_auth_phone || '',
        pre_auth_email: c.pre_auth_email || '',
        price_list_id: c.price_list_id || '',
        effective_from: c.effective_from || '',
        effective_to: c.effective_to || '',
        is_active: c.is_active !== false,
        notes: c.notes || '',
      })
    } else { resetForm() }
    setShowModal(true)
  }

  const filtered = useMemo(() => {
    let arr = [...(contracts || [])]
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(c =>
        (c.payer_name || '').toLowerCase().includes(q) ||
        (c.contract_code || '').toLowerCase().includes(q) ||
        (c.contact_name || '').toLowerCase().includes(q)
      )
    }
    return arr.sort((a, b) => (a.is_active === b.is_active ? 0 : a.is_active ? -1 : 1) || (a.payer_name || '').localeCompare(b.payer_name || ''))
  }, [contracts, search])

  async function handleSave(e) {
    e.preventDefault()
    setError('')
    if (!form.payer_name.trim()) { setError('Payer name is required.'); return }
    if (!form.contract_code.trim()) { setError('Contract code is required.'); return }
    const dupe = (contracts || []).find(c => c.contract_code === form.contract_code.trim().toUpperCase() && c.id !== editingId)
    if (dupe) { setError(`Contract code "${form.contract_code.trim().toUpperCase()}" is already in use.`); return }

    const cov = parseFloat(form.default_coverage_percent)
    if (isNaN(cov) || cov < 0 || cov > 100) { setError('Default coverage % must be between 0 and 100.'); return }

    setSaving(true)
    try {
      const payload = {
        hospital_id: hospital.id,
        payer_name: form.payer_name.trim(),
        payer_type: form.payer_type,
        contract_code: form.contract_code.trim().toUpperCase(),
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        contact_email: form.contact_email.trim() || null,
        address: form.address.trim() || null,
        policy_prefix: form.policy_prefix.trim() || null,
        default_coverage_percent: cov,
        requires_pre_auth: !!form.requires_pre_auth,
        pre_auth_phone: form.pre_auth_phone.trim() || null,
        pre_auth_email: form.pre_auth_email.trim() || null,
        price_list_id: form.price_list_id || null,
        effective_from: form.effective_from || null,
        effective_to: form.effective_to || null,
        is_active: form.is_active !== false,
        notes: form.notes.trim() || null,
      }
      if (editingId) {
        await updateRecord(editingId, payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hmo_contract.updated',
          entityType: 'hmo_contracts', entityId: editingId,
          summary: `Updated HMO contract "${payload.payer_name}" (${payload.contract_code})`,
          metadata: payload,
        })
      } else {
        const saved = await addRecord(payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hmo_contract.created',
          entityType: 'hmo_contracts', entityId: saved?.id || null,
          summary: `Created HMO contract "${payload.payer_name}" (${payload.contract_code})`,
          metadata: payload,
        })
      }
      setShowModal(false); resetForm()
    } catch (err) {
      setError(err.message || 'Could not save the contract.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(c) {
    if (!confirm(`Delete contract for "${c.payer_name}"?\n\nThis cannot be undone.`)) return
    await deleteRecord(c.id)
    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'hmo_contract.deleted',
      entityType: 'hmo_contracts', entityId: c.id,
      summary: `Deleted HMO contract "${c.payer_name}" (${c.contract_code})`,
      metadata: { code: c.contract_code },
    })
  }

  const payerTypeLabel = (t) => PAYER_TYPES.find(p => p.value === t)?.label || t

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search payer name, code, contact…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 220, padding: '8px 10px', fontSize: 12.5, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)' }}
        />
        <button type="button" className="btn btn-primary" style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => openModal(null)}>
          <AppIcon name="plus" size={14} /> Add Contract
        </button>
      </div>

      <div className="dash-table-wrap">
        <table className="dash-full-table">
          <thead>
            <tr>
              <th>Payer</th>
              <th>Type</th>
              <th>Code</th>
              <th>Coverage</th>
              <th>Pre-Auth</th>
              <th>Price List</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                {contracts?.length === 0 ? 'No HMO contracts yet. Add one to start billing HMO patients with proper tariffs.' : 'No contracts match these filters.'}
              </td></tr>
            ) : filtered.map(c => {
              const pl = priceLists?.find(p => p.id === c.price_list_id)
              return (
                <tr key={c.id} style={{ opacity: c.is_active === false ? 0.5 : 1 }}>
                  <td style={{ fontWeight: 600 }}>
                    {c.payer_name}
                    {c.contact_name && <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{c.contact_name}</div>}
                  </td>
                  <td>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(118,87,232,0.14)', color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{payerTypeLabel(c.payer_type)}</span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{c.contract_code}</td>
                  <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--teal)' }}>{c.default_coverage_percent}%</td>
                  <td style={{ fontSize: 11.5, color: c.requires_pre_auth ? 'var(--gold)' : 'var(--muted)' }}>{c.requires_pre_auth ? 'Required' : '—'}</td>
                  <td style={{ fontSize: 11.5, color: pl ? 'var(--ivory)' : 'var(--muted)' }}>{pl?.name || '—'}</td>
                  <td>
                    {c.is_active === false ? (
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(154,170,183,0.14)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Inactive</span>
                    ) : (
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(0,199,199,0.14)', color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Active</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }} onClick={() => openModal(c)}>Edit</button>
                      <button className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => handleDelete(c)}>Delete</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setShowModal(false); resetForm() } }}>
          <div className="card dash-modal" style={{ maxWidth: 680, width: '100%' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
              <div className="dash-modal-title" style={{ paddingBottom: 0 }}>{editingId ? 'Edit HMO Contract' : 'Add HMO Contract'}</div>
              <button className="dash-icon-btn" onClick={() => { setShowModal(false); resetForm() }} aria-label="Close"><AppIcon name="close" size={18} /></button>
            </div>
            <div className="dash-modal-body">
              <form id="contract-form" onSubmit={handleSave}>
                {error && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{error}</div>}

                {/* Section: Payer Identity */}
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Payer Name *</label>
                    <input value={form.payer_name} onChange={e => setField('payer_name', e.target.value)} placeholder="e.g. NHIS, Reliance HMO" autoFocus required />
                  </div>
                  <div className="field">
                    <label>Payer Type</label>
                    <select value={form.payer_type} onChange={e => setField('payer_type', e.target.value)}>
                      {PAYER_TYPES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                </div>

                <div className="dash-field-grid">
                  <div className="field">
                    <label>Contract Code *</label>
                    <input value={form.contract_code} onChange={e => setField('contract_code', e.target.value.toUpperCase())} placeholder="e.g. REL-2026" required style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }} disabled={!!editingId} />
                  </div>
                  <div className="field">
                    <label>Policy Prefix</label>
                    <input value={form.policy_prefix} onChange={e => setField('policy_prefix', e.target.value)} placeholder="e.g. REL-" />
                  </div>
                </div>

                {/* Section: Contact Details — all paired for balance */}
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Contact Name</label>
                    <input value={form.contact_name} onChange={e => setField('contact_name', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Contact Phone</label>
                    <input value={form.contact_phone} onChange={e => setField('contact_phone', e.target.value)} />
                  </div>
                </div>

                <div className="dash-field-grid">
                  <div className="field">
                    <label>Contact Email</label>
                    <input value={form.contact_email} onChange={e => setField('contact_email', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Address</label>
                    <input value={form.address} onChange={e => setField('address', e.target.value)} />
                  </div>
                </div>

                {/* Section: Billing Configuration */}
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Default Coverage %</label>
                    <input type="number" min="0" max="100" step="5" value={form.default_coverage_percent} onChange={e => setField('default_coverage_percent', e.target.value)} required style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }} />
                  </div>
                  <div className="field">
                    <label>Linked Price List</label>
                    <select value={form.price_list_id} onChange={e => setField('price_list_id', e.target.value)}>
                      <option value="">— (use default)</option>
                      {(priceLists || []).filter(p => p.is_active !== false).map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                    </select>
                  </div>
                </div>

                {/* Pre-auth checkbox — wrapped in dash-field-grid for consistent spacing */}
                <div className="dash-field-grid" style={{ gridTemplateColumns: '1fr' }}>
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={form.requires_pre_auth} onChange={e => setField('requires_pre_auth', e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--gold)' }} />
                      Requires Pre-Authorization (capture auth code before billing)
                    </label>
                  </div>
                </div>

                {form.requires_pre_auth && (
                  <div className="dash-field-grid">
                    <div className="field">
                      <label>Pre-Auth Phone</label>
                      <input value={form.pre_auth_phone} onChange={e => setField('pre_auth_phone', e.target.value)} />
                    </div>
                    <div className="field">
                      <label>Pre-Auth Email</label>
                      <input value={form.pre_auth_email} onChange={e => setField('pre_auth_email', e.target.value)} />
                    </div>
                  </div>
                )}

                {/* Section: Agreement Period */}
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Effective From</label>
                    <input type="date" value={form.effective_from} onChange={e => setField('effective_from', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Effective To</label>
                    <input type="date" value={form.effective_to} onChange={e => setField('effective_to', e.target.value)} />
                  </div>
                </div>

                {/* Notes — full width, wrapped for consistent spacing */}
                <div className="dash-field-grid" style={{ gridTemplateColumns: '1fr' }}>
                  <div className="field">
                    <label>Notes</label>
                    <textarea value={form.notes} onChange={e => setField('notes', e.target.value)} rows={2} style={{ width: '100%', padding: '8px 10px', fontSize: 12.5, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', resize: 'vertical' }} />
                  </div>
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setShowModal(false); resetForm() }} disabled={saving}>Cancel</button>
              <button type="submit" form="contract-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (editingId ? 'Save Changes' : 'Add Contract')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  function setField(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }
}
