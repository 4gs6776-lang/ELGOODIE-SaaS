import { useState, useMemo } from 'react'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import AppIcon from './icons'

// =====================================================================
// HmoProviderManager — Admin UI for managing the hospital's HMO list.
//
// Shown in Settings → HMO Providers. Admin/owner only.
//
// Lets the admin:
//   - Add a custom HMO provider (name + type)
//   - Edit an existing provider's name
//   - Activate/deactivate a provider (deactivated = hidden from dropdown)
//   - Delete custom providers (system providers can only be deactivated)
//
// The providers are stored in the `hmo_providers` table (migration 065).
// System entries (hospital_id IS NULL, is_system=true) are seeded from
// the hardcoded list — they're visible to all hospitals. Hospital-specific
// entries (hospital_id = current hospital) are custom additions.
//
// The HmoProviderSelect component (used in Reception when category='hmo')
// reads from this table via the useHmoProviders hook — so changes here
// appear in the folder-opening dropdown immediately.
// =====================================================================

export default function HmoProviderManager({ hospital, profile }) {
  const { records: allProviders, addRecord, updateRecord, deleteRecord } = useOfflineTable('hmo_providers', hospital?.id)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const [form, setForm] = useState({
    name: '',
    type: 'private',
    is_active: true,
  })

  function resetForm() {
    setForm({ name: '', type: 'private', is_active: true })
    setEditingId(null)
    setError('')
  }

  function openModal(provider = null) {
    if (provider) {
      setEditingId(provider.id)
      setForm({
        name: provider.name || '',
        type: provider.type || 'private',
        is_active: provider.is_active !== false,
      })
    } else {
      resetForm()
    }
    setShowModal(true)
  }

  // Split into system + custom
  const { systemProviders, customProviders } = useMemo(() => {
    const sys = []
    const custom = []
    let arr = [...(allProviders || [])]
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.slug || '').toLowerCase().includes(q)
      )
    }
    arr.forEach(p => {
      if (p.hospital_id === hospital?.id || (p.is_system && !p.hospital_id)) {
        if (p.is_system && !p.hospital_id) sys.push(p)
        else custom.push(p)
      } else if (p.is_system) {
        sys.push(p)
      }
    })
    sys.sort((a, b) => (a.sort_order || 100) - (b.sort_order || 100))
    custom.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    return { systemProviders: sys, customProviders: custom }
  }, [allProviders, search, hospital?.id])

  async function handleSave(e) {
    e?.preventDefault?.()
    setError('')
    if (!form.name.trim()) { setError('HMO name is required.'); return }
    setSaving(true)
    try {
      const slug = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      if (editingId) {
        await updateRecord(editingId, {
          name: form.name.trim(),
          type: form.type,
          is_active: form.is_active,
          updated_at: new Date().toISOString(),
        })
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hmo_provider.updated',
          entityType: 'hmo_providers', entityId: editingId,
          summary: `Updated HMO provider "${form.name.trim()}"`,
          metadata: { name: form.name.trim(), type: form.type },
        })
      } else {
        // Check for slug uniqueness within this hospital
        const existing = (allProviders || []).find(p =>
          p.slug === slug && (p.hospital_id === hospital.id || (!p.hospital_id && p.is_system))
        )
        if (existing) {
          setError(`An HMO with slug "${slug}" already exists. Use a different name.`)
          setSaving(false)
          return
        }
        await addRecord({
          hospital_id: hospital.id,
          slug: slug,
          name: form.name.trim(),
          type: form.type,
          is_system: false,
          is_active: true,
          sort_order: 500,
        })
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hmo_provider.created',
          entityType: 'hmo_providers', entityId: null,
          summary: `Added HMO provider "${form.name.trim()}"`,
          metadata: { name: form.name.trim(), slug, type: form.type },
        })
      }
      setShowModal(false)
      resetForm()
    } catch (err) {
      setError(err.message || 'Could not save the HMO provider.')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleActive(provider) {
    const newValue = !(provider.is_active !== false)
    try {
      await updateRecord(provider.id, { is_active: newValue })
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'hmo_provider.toggled',
        entityType: 'hmo_providers', entityId: provider.id,
        summary: `${newValue ? 'Activated' : 'Deactivated'} HMO provider "${provider.name}"`,
        metadata: { provider_id: provider.id, is_active: newValue },
      })
    } catch (err) {
      console.error('Toggle failed:', err)
    }
  }

  async function handleDelete(provider) {
    if (!confirm(`Delete "${provider.name}"?\n\nThis removes it from the HMO dropdown at registration. Existing patient records are NOT affected.`)) return
    try {
      await deleteRecord(provider.id)
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'hmo_provider.deleted',
        entityType: 'hmo_providers', entityId: provider.id,
        summary: `Deleted HMO provider "${provider.name}"`,
        metadata: { provider_id: provider.id, name: provider.name },
      })
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  const providerTypeLabel = (t) => t === 'public' ? 'Public' : 'Private'
  const providerTypeColor = (t) => t === 'public' ? 'var(--teal)' : 'var(--violet)'
  const providerTypeBg = (t) => t === 'public' ? 'rgba(0,199,199,0.10)' : 'rgba(118,87,232,0.10)'

  function renderProviderRow(p) {
    const isActive = p.is_active !== false
    const isSystem = p.is_system && !p.hospital_id
    return (
      <div key={p.id} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, padding: '10px 12px', borderRadius: 8,
        background: 'var(--bg-elevated)', border: `1px solid ${isActive ? 'var(--line-soft)' : 'var(--line)'}`,
        opacity: isActive ? 1 : 0.5, marginBottom: 6,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ivory)' }}>{p.name}</span>
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: providerTypeBg(p.type), color: providerTypeColor(p.type),
              textTransform: 'uppercase', letterSpacing: 0.5,
            }}>{providerTypeLabel(p.type)}</span>
            {isSystem && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                background: 'rgba(154,170,183,0.14)', color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: 0.5,
              }}>System</span>
            )}
            {!isActive && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                background: 'rgba(225,104,94,0.14)', color: 'var(--danger)',
                textTransform: 'uppercase', letterSpacing: 0.5,
              }}>Hidden</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            className="btn btn-ghost"
            style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }}
            onClick={() => handleToggleActive(p)}
            title={isActive ? 'Hide from dropdown' : 'Show in dropdown'}
          >
            {isActive ? 'Hide' : 'Show'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }}
            onClick={() => openModal(p)}
            title="Edit"
          >
            Edit
          </button>
          {!isSystem && (
            <button
              className="btn btn-ghost"
              style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
              onClick={() => handleDelete(p)}
              title="Delete"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Search + Add */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search HMO providers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: '8px 10px', fontSize: 12.5, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)' }}
        />
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => openModal(null)}
        >
          <AppIcon name="plus" size={14} /> Add HMO
        </button>
      </div>

      {/* Custom providers */}
      {customProviders.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
            Your Hospital's HMOs ({customProviders.length})
          </div>
          {customProviders.map(renderProviderRow)}
        </div>
      )}

      {/* System providers (defaults — can be hidden but not deleted) */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
          Default HMOs ({systemProviders.length})
        </div>
        {systemProviders.map(renderProviderRow)}
      </div>

      {/* Add/Edit modal */}
      {showModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setShowModal(false); resetForm() } }}>
          <div className="card dash-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
              <div className="dash-modal-title" style={{ paddingBottom: 0 }}>{editingId ? 'Edit HMO Provider' : 'Add HMO Provider'}</div>
              <button className="dash-icon-btn" onClick={() => { setShowModal(false); resetForm() }} aria-label="Close"><AppIcon name="close" size={18} /></button>
            </div>
            <div className="dash-modal-body">
              <form id="hmo-form" onSubmit={handleSave}>
                {error && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
                <div className="field">
                  <label>HMO Name *</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Reliance HMO, NHIS Lagos" autoFocus required />
                </div>
                <div className="field">
                  <label>Type</label>
                  <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    <option value="private">Private</option>
                    <option value="public">Public (Government)</option>
                  </select>
                </div>
                {editingId && (
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} style={{ width: 16, height: 16, accentColor: 'var(--teal)' }} />
                      Show in HMO dropdown
                    </label>
                  </div>
                )}
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setShowModal(false); resetForm() }} disabled={saving}>Cancel</button>
              <button type="submit" form="hmo-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (editingId ? 'Save Changes' : 'Add HMO')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
