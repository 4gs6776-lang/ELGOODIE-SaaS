import { useState, useMemo } from 'react'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import AppIcon from './icons'

// =====================================================================
// FolderCategoryManager — Admin UI for enabling/disabling folder
// categories at patient registration.
//
// Shown in Settings → Folder Categories. Admin/owner only.
//
// The hospital_registration_fees table already stores per-hospital
// registration fees per category (personal, family, emergency, anc, hmo).
// We reuse the is_active column on that table to control which
// categories appear in the Reception folder dropdown.
//
// When is_active=false for a category, it's hidden from the dropdown.
// When is_active=true (or no row exists), the category is shown.
//
// This means NO new database table is needed — we're just toggling
// the is_active flag on existing rows.
// =====================================================================

const ALL_CATEGORIES = [
  { value: 'personal',  label: 'Personal Folder',  description: 'Individual patient registration' },
  { value: 'family',    label: 'Family Folder',    description: 'Family health records' },
  { value: 'emergency', label: 'Emergency Folder', description: 'Emergency cases, no folder fee upfront' },
  { value: 'anc',       label: 'ANC Folder',       description: 'Antenatal care registration' },
  { value: 'hmo',       label: 'HMO Folder',       description: 'HMO/insurance patients' },
]

export default function FolderCategoryManager({ hospital, profile }) {
  const { records: feeRecords, addRecord, updateRecord } = useOfflineTable('hospital_registration_fees', hospital?.id)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Get the effective is_active for a category
  // If no row exists, default to true (category is shown)
  function getCategoryActive(cat) {
    const row = (feeRecords || []).find(f => f.category === cat)
    return row ? row.is_active !== false : true
  }

  // Get the fee amount for a category
  function getCategoryFee(cat) {
    const row = (feeRecords || []).find(f => f.category === cat)
    return row ? Number(row.amount || 0) : 0
  }

  // Toggle a category on/off
  async function toggleCategory(cat) {
    const row = (feeRecords || []).find(f => f.category === cat)
    const newValue = !getCategoryActive(cat)
    setSaving(true)
    try {
      if (row) {
        await updateRecord(row.id, { is_active: newValue, updated_by: profile?.id || null })
      } else {
        // Create a row with default fee + the new is_active state
        await addRecord({
          hospital_id: hospital.id,
          category: cat,
          amount: 0,
          is_active: newValue,
          updated_by: profile?.id || null,
        })
      }
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'folder_category.toggled',
        entityType: 'hospital_registration_fees', entityId: row?.id || null,
        summary: `${newValue ? 'Enabled' : 'Disabled'} folder category "${cat}"`,
        metadata: { category: cat, is_active: newValue },
      })
      showToast(`${ALL_CATEGORIES.find(c => c.value === cat)?.label || cat} ${newValue ? 'enabled' : 'disabled'}`)
    } catch (err) {
      showToast(err.message || 'Could not update category')
    } finally {
      setSaving(false)
    }
  }

  // Update the fee amount for a category
  async function updateFee(cat, amount) {
    const row = (feeRecords || []).find(f => f.category === cat)
    setSaving(true)
    try {
      if (row) {
        await updateRecord(row.id, { amount: Number(amount) || 0, updated_by: profile?.id || null })
      } else {
        await addRecord({
          hospital_id: hospital.id,
          category: cat,
          amount: Number(amount) || 0,
          is_active: true,
          updated_by: profile?.id || null,
        })
      }
    } catch (err) {
      showToast(err.message || 'Could not update fee')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16 }}>
        Control which patient folder categories appear at registration. Disabled categories are hidden from the dropdown but existing patient records are preserved.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ALL_CATEGORIES.map(cat => {
          const isActive = getCategoryActive(cat.value)
          const fee = getCategoryFee(cat.value)
          return (
            <div key={cat.value} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, padding: '12px 14px', borderRadius: 10,
              background: 'var(--bg-elevated)', border: `1px solid ${isActive ? 'var(--line-soft)' : 'var(--line)'}`,
              opacity: isActive ? 1 : 0.6,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ivory)' }}>
                  {cat.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {cat.description}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                {/* Fee input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>₦</span>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    value={fee || ''}
                    onChange={e => updateFee(cat.value, e.target.value)}
                    placeholder="0"
                    disabled={!isActive || saving}
                    style={{
                      width: 80, padding: '5px 8px', fontSize: 12,
                      borderRadius: 6, border: '1px solid var(--line)',
                      background: isActive ? 'var(--bg-card)' : 'var(--bg-elevated)',
                      color: 'var(--ivory)', fontFamily: 'var(--font-mono, monospace)',
                      opacity: isActive ? 1 : 0.5,
                    }}
                  />
                </div>
                {/* Toggle */}
                <button
                  type="button"
                  onClick={() => toggleCategory(cat.value)}
                  disabled={saving}
                  style={{
                    width: 44, height: 24, borderRadius: 12,
                    border: 'none', cursor: saving ? 'wait' : 'pointer',
                    background: isActive ? 'var(--teal)' : 'var(--line)',
                    position: 'relative', transition: 'background 0.2s ease',
                    flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 2, left: isActive ? 22 : 2,
                    width: 20, height: 20, borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.2s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
          padding: '10px 18px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, zIndex: 100,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
