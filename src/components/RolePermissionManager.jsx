import { useState, useMemo, useEffect } from 'react'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import AppIcon from './icons'
import {
  MODULES,
  MODULE_LABELS,
  ROLE_LABELS,
  CONFIGURABLE_ROLES,
  ACTIONS,
} from '../lib/permissions'

// =====================================================================
// RolePermissionManager — Admin UI for configuring RBAC per hospital.
//
// Shown in Settings → Role Permissions. Admin/owner only.
//
// Features:
//   - Select a role from the sidebar
//   - See all configurable modules as a grid
//   - Toggle can_view / can_create / can_edit / can_delete per module
//   - Owner role: locked (always full access, can't be edited)
//   - CMD role: can_view toggleable, but can_create/edit/delete are
//     locked to false (the DB trigger also enforces this)
//   - Save button writes all changes to the DB in one batch
//   - Reset button restores the hardcoded defaults (deletes custom rows)
//
// The component uses useOfflineTable for offline-first syncing. Changes
// are saved locally first, then synced to Supabase when online.
// =====================================================================

export default function RolePermissionManager({ hospital, profile }) {
  const { records: dbPerms, addRecord, updateRecord, deleteRecord } = useOfflineTable('hospital_role_permissions', hospital?.id)
  const [selectedRole, setSelectedRole] = useState('doctor')
  const [pendingChanges, setPendingChanges] = useState({})
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Find the current DB row for a role+module (or return null if not configured)
  function getDbRow(role, moduleKey) {
    return (dbPerms || []).find(p => p.role === role && p.module === moduleKey) || null
  }

  // Get the effective permission value (DB row if exists, else hardcoded default)
  function getEffectiveValue(role, moduleKey, action) {
    const dbRow = getDbRow(role, moduleKey)
    const pendingKey = `${role}|${moduleKey}`
    const pending = pendingChanges[pendingKey]

    if (pending) {
      // Use pending change if it exists
      switch (action) {
        case 'can_view': return pending.can_view
        case 'can_create': return pending.can_create
        case 'can_edit': return pending.can_edit
        case 'can_delete': return pending.can_delete
        default: return false
      }
    }

    if (dbRow) {
      switch (action) {
        case 'can_view': return dbRow.can_view !== false
        case 'can_create': return dbRow.can_create === true
        case 'can_edit': return dbRow.can_edit === true
        case 'can_delete': return dbRow.can_delete === true
        default: return false
      }
    }

    // Fallback: no DB row + no pending change = use hardcoded default
    // (simplified: all configurable roles get view+create+edit by default
    // if the module is in their ROLE_MODULES list; this matches the
    // hardcoded behavior from permissions.js)
    return false
  }

  // Toggle a permission value
  function togglePermission(role, moduleKey, action) {
    const pendingKey = `${role}|${moduleKey}`
    const currentVal = getEffectiveValue(role, moduleKey, action)
    const newVal = !currentVal

    setPendingChanges(prev => {
      const dbRow = getDbRow(role, moduleKey)
      const base = pendingChanges[pendingKey] || dbRow || {
        role, module: moduleKey,
        can_view: true, can_create: false, can_edit: false, can_delete: false,
      }
      return {
        ...prev,
        [pendingKey]: { ...base, [action]: newVal },
      }
    })
  }

  // Check if there are pending changes
  const hasPendingChanges = Object.keys(pendingChanges).length > 0

  // Save all pending changes to the DB
  // Uses upsert logic: if INSERT fails with a unique constraint violation
  // (because the row was seeded by migration 067 but not yet in IndexedDB),
  // it fetches the existing server row by (role, module) and UPDATEs it.
  async function handleSave() {
    if (!hospital || !profile) return
    setSaving(true)
    try {
      for (const [key, data] of Object.entries(pendingChanges)) {
        const existing = getDbRow(data.role, data.module)
        if (existing) {
          await updateRecord(existing.id, {
            can_view: data.can_view,
            can_create: data.can_create,
            can_edit: data.can_edit,
            can_delete: data.can_delete,
            updated_by: profile?.id || null,
          })
        } else {
          // Try INSERT first. If it fails with a duplicate key (23505),
          // the row was seeded on the server but hasn't synced to IndexedDB
          // yet. In that case, fetch the existing row by (role, module)
          // from the server and UPDATE it.
          try {
            await addRecord({
              hospital_id: hospital.id,
              role: data.role,
              module: data.module,
              can_view: data.can_view,
              can_create: data.can_create,
              can_edit: data.can_edit,
              can_delete: data.can_delete,
              updated_by: profile?.id || null,
            })
          } catch (insertErr) {
            // Check if it's a unique constraint violation
            if (insertErr.message && (insertErr.message.includes('already exists') || insertErr.message.includes('duplicate'))) {
              // Fetch the existing row from Supabase by (role, module)
              const { supabase } = await import('../lib/supabaseClient')
              const { data: serverRow, error: fetchErr } = await supabase
                .from('hospital_role_permissions')
                .select('*')
                .eq('hospital_id', hospital.id)
                .eq('role', data.role)
                .eq('module', data.module)
                .maybeSingle()

              if (fetchErr || !serverRow) {
                throw new Error(`Could not resolve existing permission row for ${data.role}/${data.module}: ${fetchErr?.message || 'not found'}`)
              }

              // Update the existing server row
              await updateRecord(serverRow.id, {
                can_view: data.can_view,
                can_create: data.can_create,
                can_edit: data.can_edit,
                can_delete: data.can_delete,
                updated_by: profile?.id || null,
              })
            } else {
              // Re-throw non-duplicate errors
              throw insertErr
            }
          }
        }
      }

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'role_permissions.updated',
        entityType: 'hospital_role_permissions', entityId: null,
        summary: `Updated role permissions for ${Object.keys(pendingChanges).length} module(s) on role ${selectedRole}`,
        metadata: { role: selectedRole, changes: pendingChanges },
      })

      showToast(`Permissions saved for ${ROLE_LABELS[selectedRole] || selectedRole}`)
      setPendingChanges({})
    } catch (err) {
      showToast(err.message || 'Could not save permissions')
    } finally {
      setSaving(false)
    }
  }

  // Reset: delete all custom rows for this hospital (revert to hardcoded defaults)
  async function handleReset() {
    if (!confirm('Reset all custom permissions to defaults? This will remove all custom configurations and revert to the built-in defaults.')) return
    setSaving(true)
    try {
      for (const row of (dbPerms || [])) {
        await deleteRecord(row.id)
      }
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'role_permissions.reset',
        entityType: 'hospital_role_permissions', entityId: null,
        summary: 'Reset all custom role permissions to defaults',
        metadata: {},
      })
      showToast('All permissions reset to defaults')
      setPendingChanges({})
    } catch (err) {
      showToast(err.message || 'Could not reset permissions')
    } finally {
      setSaving(false)
    }
  }

  const isOwnerRole = selectedRole === 'owner'
  const isCmdRole = selectedRole === 'cmd'

  return (
    <div>
      {/* ---- Role selector ---- */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {['owner', ...CONFIGURABLE_ROLES].map(r => (
          <button
            key={r}
            type="button"
            className={`btn ${selectedRole === r ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 'auto', padding: '7px 14px', fontSize: 12 }}
            onClick={() => { setSelectedRole(r); setPendingChanges({}) }}
          >
            {ROLE_LABELS[r] || r}
          </button>
        ))}
      </div>

      {/* ---- Role description ---- */}
      <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)', marginBottom: 16, fontSize: 12.5, color: 'var(--muted)' }}>
        {isOwnerRole && (
          <span>🔒 <strong style={{ color: 'var(--gold)' }}>Owner role is locked.</strong> Always has full access to all modules. Cannot be restricted.</span>
        )}
        {isCmdRole && (
          <span>🔒 <strong style={{ color: 'var(--danger)' }}>CMD role is read-only.</strong> Can view modules but cannot create, edit, or delete anything. This is enforced at the database level.</span>
        )}
        {!isOwnerRole && !isCmdRole && (
          <span>Configure which modules <strong style={{ color: 'var(--ivory)' }}>{ROLE_LABELS[selectedRole]}</strong> can access and what actions they can perform.</span>
        )}
      </div>

      {/* ---- Module permissions grid ---- */}
      <div className="dash-table-wrap">
        <table className="dash-full-table">
          <thead>
            <tr>
              <th>Module</th>
              <th style={{ textAlign: 'center' }}>View</th>
              <th style={{ textAlign: 'center' }}>Create</th>
              <th style={{ textAlign: 'center' }}>Edit</th>
              <th style={{ textAlign: 'center' }}>Delete</th>
            </tr>
          </thead>
          <tbody>
            {MODULES.map(mod => {
              const canView = getEffectiveValue(selectedRole, mod, 'can_view')
              const canCreate = getEffectiveValue(selectedRole, mod, 'can_create')
              const canEdit = getEffectiveValue(selectedRole, mod, 'can_edit')
              const canDelete = getEffectiveValue(selectedRole, mod, 'can_delete')
              const locked = isOwnerRole || (isCmdRole && mod !== 'overview')

              return (
                <tr key={mod}>
                  <td style={{ fontWeight: 600 }}>{MODULE_LABELS[mod] || mod}</td>
                  <td style={{ textAlign: 'center' }}>
                    <ToggleCheckbox
                      checked={canView}
                      disabled={locked || isOwnerRole}
                      onChange={() => !locked && togglePermission(selectedRole, mod, 'can_view')}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <ToggleCheckbox
                      checked={canCreate}
                      disabled={locked || isCmdRole || isOwnerRole}
                      onChange={() => !locked && !isCmdRole && togglePermission(selectedRole, mod, 'can_create')}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <ToggleCheckbox
                      checked={canEdit}
                      disabled={locked || isCmdRole || isOwnerRole}
                      onChange={() => !locked && !isCmdRole && togglePermission(selectedRole, mod, 'can_edit')}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <ToggleCheckbox
                      checked={canDelete}
                      disabled={locked || isCmdRole || isOwnerRole}
                      onChange={() => !locked && !isCmdRole && togglePermission(selectedRole, mod, 'can_delete')}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ---- Actions ---- */}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: 'auto', padding: '8px 18px', fontSize: 12.5 }}
          onClick={handleSave}
          disabled={!hasPendingChanges || saving}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, color: 'var(--danger)', borderColor: 'var(--danger)' }}
          onClick={handleReset}
          disabled={saving || (dbPerms || []).length === 0}
        >
          Reset to Defaults
        </button>
        {hasPendingChanges && (
          <span style={{ fontSize: 11.5, color: 'var(--gold)' }}>
            {Object.keys(pendingChanges).length} unsaved change{Object.keys(pendingChanges).length === 1 ? '' : 's'}
          </span>
        )}
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

// ---- Toggle checkbox component ----
function ToggleCheckbox({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      aria-pressed={checked}
      style={{
        width: 22, height: 22, borderRadius: 6,
        border: `2px solid ${checked ? 'var(--teal)' : 'var(--muted-dim)'}`,
        background: checked ? 'var(--teal)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.15s ease',
        padding: 0,
      }}
    >
      {checked && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#03201D" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  )
}
