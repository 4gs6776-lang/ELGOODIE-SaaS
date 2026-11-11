import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  getAllConflicts,
  resolveConflictAcceptLocal,
  resolveConflictAcceptRemote,
  resolveConflictMerge,
} from '../lib/useOfflineTable'
import {
  diffRows,
  classifyConflict,
  formatValue,
  FIELD_STRATEGIES,
} from '../lib/conflictResolver'
import { useAuth } from '../context/AuthContext'

// =====================================================================
// ConflictReviewPanel
//
// CORRECTION (requirement 6):
//   * Surfaces conflicts staged locally AND on the backend
//     (sync_conflicts table).
//   * Shows: record type, patient reference, local values, server
//     values, timestamps, reason, and resolution actions.
//   * Requires EXPLICIT confirmation for every resolution (a second
//     click on a confirm button — no "double-click to resolve").
//   * ROLE-BASED PII PROTECTION: clinical narrative fields (diagnosis,
//     notes, presenting complaints, allergies, vitals) are MASKED
//     for roles that lack clinical access (front_desk, billing,
//     pharmacist, lab). They see "PII protected — contact a clinician"
//     instead of the value. The masked fields are still listed so the
//     reviewer can see WHICH fields are conflicting.
//   * When backend atomic resolution is unavailable, the conflict is
//     marked "awaiting backend support" and the resolution buttons
//     are DISABLED except "Keep local" (which only re-queues the
//     local row — it does NOT overwrite the server).
// =====================================================================

// Roles that may see clinical narrative fields in the conflict UI.
// Matches the existing permission model in src/lib/permissions.js.
const CLINICAL_VIEW_ROLES = new Set([
  'admin',
  'owner',
  'doctor',
  'nurse',
  'cmd',          // Chief Medical Director — read-only, but sees everything
  'midwife',      // ANC context
])

// Fields whose values must be masked for non-clinical roles.
// Drawn from conflictResolver.js FIELD_STRATEGIES.clinical plus a
// few extras that are obviously PII (full_name, phone, address).
const PII_PROTECTED_FIELDS = new Set([
  // Clinical narrative
  'diagnosis',
  'diagnosis_codes',
  'presenting_complaints',
  'assessment',
  'plan',
  'notes',
  'summary',
  'follow_up',
  'medication',
  'dosage',
  'frequency',
  'route',
  'allergies',
  'vital_signs',
  'temperature',
  'bp_systolic',
  'bp_diastolic',
  'pulse',
  'respiratory_rate',
  'spo2',
  'weight',
  'height',
  'bmi',
  // Direct PII
  'full_name',
  'surname',
  'other_names',
  'phone',
  'email',
  'address',
  'date_of_birth',
  'next_of_kin',
  'next_of_kin_phone',
])

function maskValue() {
  return '— PII protected — contact a clinician —'
}

// Decide whether the current viewer may see this field's value.
function canViewField(fieldName, role) {
  if (!PII_PROTECTED_FIELDS.has(fieldName)) return true
  return CLINICAL_VIEW_ROLES.has(role)
}

// Patient reference for the conflict card — derives a friendly
// label from the local row without exposing PII for non-clinical
// roles.
function patientReference(conflict, role) {
  const data = conflict.local_data || conflict.remote_data || {}
  if (canViewField('full_name', role) && data.full_name) {
    return data.full_name
  }
  if (canViewField('full_name', role) && (data.surname || data.other_names)) {
    return [data.surname, data.other_names].filter(Boolean).join(' ')
  }
  if (data.mrn) return `MRN ${data.mrn}`
  if (data.patient_id) return `Patient ${String(data.patient_id).slice(0, 8)}…`
  if (data.id) return `Record ${String(data.id).slice(0, 8)}…`
  return 'Unknown record'
}

const REASON_LABELS = {
  both_changed: 'Both sides changed',
  version_mismatch: 'Server version advanced during edit',
  remote_newer: 'Server has a newer version',
  backend_staged: 'Staged by backend',
  unknown: 'Conflict',
}

export default function ConflictReviewPanel({ open, onClose }) {
  const { profile, hospital, getCurrentUserId } = useAuth()
  const role = profile?.role || 'staff'
  const hospitalId = hospital?.id
  const userId = getCurrentUserId ? getCurrentUserId() : null

  const [conflicts, setConflicts] = useState([])
  const [loading, setLoading] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [confirming, setConfirming] = useState(null) // { conflictId, action }
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)

  const load = useCallback(async () => {
    if (!hospitalId) return
    setLoading(true)
    try {
      const data = await getAllConflicts(hospitalId)
      setConflicts(data || [])
      if (data && data.length > 0 && !activeId) {
        setActiveId(data[0].id)
      }
    } catch (e) {
      setToast({ type: 'error', msg: e.message })
    } finally {
      setLoading(false)
    }
  }, [hospitalId, activeId])

  useEffect(() => {
    if (open && hospitalId) load()
  }, [open, hospitalId, load])

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000)
      return () => clearTimeout(t)
    }
  }, [toast])

  const activeConflict = useMemo(
    () => conflicts.find((c) => c.id === activeId),
    [conflicts, activeId]
  )

  const diffs = useMemo(() => {
    if (!activeConflict) return []
    return diffRows(activeConflict.local_data || {}, activeConflict.remote_data || {})
  }, [activeConflict])

  const severity = useMemo(() => classifyConflict(diffs), [diffs])

  const blocked = Boolean(activeConflict?.blocked)
  const mergeAvailable = !blocked && Boolean(activeConflict?._backendConflictId) && !!userId

  async function handleResolve(action, mergedRow, fieldDecisions) {
    if (!activeConflict) return
    setBusy(true)
    try {
      let ok = false
      if (action === 'mine') {
        ok = await resolveConflictAcceptLocal(activeConflict.record_id, activeConflict.table_name)
      } else if (action === 'theirs') {
        ok = await resolveConflictAcceptRemote(activeConflict.record_id, activeConflict.table_name)
      } else if (action === 'merge') {
        if (!mergeAvailable) {
          setToast({
            type: 'error',
            msg: 'Merge requires backend atomic resolution. Use "Keep local" or "Accept server" instead.',
          })
          return
        }
        ok = await resolveConflictMerge(
          activeConflict.record_id,
          activeConflict.table_name,
          mergedRow,
          fieldDecisions
        )
      }
      if (ok) {
        setToast({ type: 'success', msg: 'Conflict resolved' })
        setConfirming(null)
        await load()
      } else {
        setToast({ type: 'error', msg: 'Resolution failed — see console for details.' })
      }
    } catch (e) {
      setToast({ type: 'error', msg: e.message })
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="cr-overlay" onClick={onClose}>
      <div className="cr-modal cr-modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="cr-modal-header">
          <h2>
            Conflict Review
            <span className="cr-count-badge">{conflicts.length} pending</span>
          </h2>
          <button className="cr-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {toast && <div className={`cr-toast cr-toast-${toast.type}`}>{toast.msg}</div>}

        <div className="cr-body">
          {loading ? (
            <div className="cr-loading">Loading conflicts…</div>
          ) : conflicts.length === 0 ? (
            <div className="cr-empty">
              <div className="cr-empty-icon">✓</div>
              <p>No conflicts.</p>
              <p className="cr-empty-sub">All synchronized records are consistent.</p>
            </div>
          ) : (
            <div className="cr-split">
              {/* LEFT: conflict list */}
              <div className="cr-list">
                {conflicts.map((c) => {
                  const sev = classifyConflict(
                    diffRows(c.local_data || {}, c.remote_data || {})
                  )
                  const isBlocked = Boolean(c.blocked)
                  return (
                    <button
                      key={c.id}
                      className={`cr-list-item ${c.id === activeId ? 'active' : ''}`}
                      onClick={() => setActiveId(c.id)}
                    >
                      <div className="cr-list-item-top">
                        <span className={`cr-sev cr-sev-${sev.level}`}>{sev.label}</span>
                        <span className="cr-list-table">{c.table_name.replace(/_/g, ' ')}</span>
                      </div>
                      <div className="cr-list-patient">{patientReference(c, role)}</div>
                      <div className="cr-list-meta">
                        <span className="cr-list-reason">
                          {REASON_LABELS[c.reason] || c.reason}
                        </span>
                        {isBlocked && (
                          <span className="cr-list-blocked">awaiting backend</span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* RIGHT: detail */}
              <div className="cr-detail">
                {activeConflict && (
                  <>
                    <div className="cr-detail-header">
                      <div>
                        <div className="cr-detail-table">
                          {activeConflict.table_name.replace(/_/g, ' ')}
                        </div>
                        <div className="cr-detail-patient">
                          {patientReference(activeConflict, role)}
                        </div>
                      </div>
                      <div className="cr-detail-meta">
                        <div>
                          <span className="cr-meta-label">Reason:</span>{' '}
                          {REASON_LABELS[activeConflict.reason] || activeConflict.reason}
                        </div>
                        <div>
                          <span className="cr-meta-label">Detected:</span>{' '}
                          {activeConflict.detected_at
                            ? new Date(activeConflict.detected_at).toLocaleString()
                            : '—'}
                        </div>
                        {activeConflict.remote_updated_at && (
                          <div>
                            <span className="cr-meta-label">Server updated:</span>{' '}
                            {new Date(activeConflict.remote_updated_at).toLocaleString()}
                          </div>
                        )}
                        {activeConflict.remote_version != null && (
                          <div>
                            <span className="cr-meta-label">Server version:</span>{' '}
                            {activeConflict.remote_version}
                          </div>
                        )}
                      </div>
                    </div>

                    {blocked && (
                      <div className="cr-blocked-banner">
                        <strong>Awaiting backend support.</strong>{' '}
                        {activeConflict.blocked_reason ||
                          'Backend atomic resolution is unavailable. You may still "Keep local" (re-queue your edit) but you cannot overwrite the server version until the backend catches up.'}
                      </div>
                    )}

                    <div className="cr-diff-section">
                      <h4>Field differences</h4>
                      {diffs.length === 0 ? (
                        <p className="cr-muted">No field-level differences detected.</p>
                      ) : (
                        <table className="cr-diff-table">
                          <thead>
                            <tr>
                              <th>Field</th>
                              <th>Local value</th>
                              <th>Server value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {diffs.map((d) => {
                              const canView = canViewField(d.field, role)
                              return (
                                <tr key={d.field}>
                                  <td className="cr-diff-field">
                                    {d.field}
                                    <span className={`cr-strat cr-strat-${d.strategy}`}>
                                      {d.strategy}
                                    </span>
                                  </td>
                                  <td className="cr-diff-local">
                                    {canView
                                      ? formatValue(d.client)
                                      : maskValue()}
                                  </td>
                                  <td className="cr-diff-server">
                                    {canView
                                      ? formatValue(d.server)
                                      : maskValue()}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>

                    <div className="cr-actions">
                      {/* Two-step confirmation for every resolution. */}
                      {!confirming ? (
                        <>
                          <button
                            className="cr-btn cr-btn-secondary"
                            disabled={busy}
                            onClick={() => setConfirming({ action: 'mine' })}
                          >
                            Keep local
                          </button>
                          <button
                            className="cr-btn cr-btn-secondary"
                            disabled={busy || blocked}
                            onClick={() => setConfirming({ action: 'theirs' })}
                            title={blocked ? 'Disabled: backend atomic resolution unavailable' : ''}
                          >
                            Accept server
                          </button>
                          <button
                            className="cr-btn cr-btn-secondary"
                            disabled={busy || !mergeAvailable}
                            onClick={() => setConfirming({ action: 'merge' })}
                            title={
                              !mergeAvailable
                                ? 'Disabled: backend record_conflict_resolution RPC required'
                                : ''
                            }
                          >
                            Merge…
                          </button>
                        </>
                      ) : (
                        <div className="cr-confirm">
                          <span>
                            {confirming.action === 'mine' &&
                              'Re-queue your local edit for upload? The server version will be ignored locally.'}
                            {confirming.action === 'theirs' &&
                              'Replace your local edit with the server version? Your local changes will be archived (audit copy retained).'}
                            {confirming.action === 'merge' &&
                              'Apply the merged row to the server via the atomic resolution RPC?'}
                          </span>
                          <div className="cr-confirm-actions">
                            <button
                              className="cr-btn cr-btn-primary"
                              disabled={busy}
                              onClick={() =>
                                handleResolve(confirming.action, activeConflict.local_data, {})
                              }
                            >
                              {busy ? 'Resolving…' : 'Confirm'}
                            </button>
                            <button
                              className="cr-btn cr-btn-secondary"
                              disabled={busy}
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="cr-audit-note">
                      Every resolution is recorded in <code>sync_resolution_log</code>{' '}
                      (migration 098) for auditability.
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
