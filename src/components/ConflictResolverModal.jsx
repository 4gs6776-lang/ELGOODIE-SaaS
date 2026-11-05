import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useCurrentHospital } from '../lib/useCurrentHospital';
import {
  diffRows,
  suggestResolution,
  buildMergedRow,
  classifyConflict,
  formatValue,
  fetchConflicts,
  resolveConflict,
} from '../lib/conflictResolver';
import './OfflineFirst.css';

export default function ConflictResolverModal({ open, onClose }) {
  const { hospitalId, userId } = useCurrentHospital();
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [customValues, setCustomValues] = useState({});
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (open && hospitalId) load();
  }, [open, hospitalId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchConflicts(hospitalId, 100);
      setConflicts(data || []);
      if (data && data.length > 0) setActiveId(data[0].id);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const activeConflict = useMemo(
    () => conflicts.find(c => c.id === activeId),
    [conflicts, activeId]
  );

  const diffs = useMemo(() => {
    if (!activeConflict) return [];
    return diffRows(activeConflict.client_data, activeConflict.server_data);
  }, [activeConflict]);

  // Initialise decisions whenever the active conflict changes
  useEffect(() => {
    if (diffs.length > 0) {
      setDecisions(suggestResolution(diffs));
      setCustomValues({});
    } else {
      setDecisions({});
      setCustomValues({});
    }
  }, [activeId]);

  const severity = useMemo(() => classifyConflict(diffs), [diffs]);

  function pickField(field, choice) {
    setDecisions({ ...decisions, [field]: choice });
    // Clear any custom override
    const next = { ...customValues };
    delete next[field];
    setCustomValues(next);
  }

  function setCustom(field, value) {
    setCustomValues({ ...customValues, [field]: value });
    setDecisions({ ...decisions, [field]: 'custom' });
  }

  async function handleResolve(resolutionType) {
    if (!activeConflict) return;
    setResolving(true);
    setError(null);
    try {
      // Build the final merged row
      let finalData;
      if (resolutionType === 'mine') {
        finalData = activeConflict.client_data;
      } else if (resolutionType === 'theirs') {
        finalData = activeConflict.server_data;
      } else if (resolutionType === 'merge') {
        finalData = buildMergedRow(
          activeConflict.client_data,
          activeConflict.server_data,
          decisions
        );
        // Apply custom overrides
        for (const [field, value] of Object.entries(customValues)) {
          finalData[field] = value;
        }
      } else if (resolutionType === 'discard') {
        finalData = activeConflict.server_data; // no change
      }

      const ok = await resolveConflict(
        activeConflict.id,
        resolutionType,
        { decisions, customValues },
        finalData,
        userId
      );

      if (ok) {
        setToast({ type: 'success', msg: 'Conflict resolved' });
        // Remove resolved conflict from local list
        const remaining = conflicts.filter(c => c.id !== activeConflict.id);
        setConflicts(remaining);
        setActiveId(remaining[0]?.id || null);
        // Auto-close if no more conflicts
        if (remaining.length === 0) {
          setTimeout(() => onClose(), 1500);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setResolving(false);
    }
  }

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  if (!open) return null;

  return (
    <div className="cr-overlay" onClick={onClose}>
      <div className="cr-modal" onClick={e => e.stopPropagation()}>
        <header className="cr-modal-header">
          <h2>
            Conflict Resolution
            {conflicts.length > 0 && (
              <span className="cr-count-badge">{conflicts.length} pending</span>
            )}
          </h2>
          <button className="cr-close" onClick={onClose}>×</button>
        </header>

        {error && <div className="cr-error">{error}</div>}
        {toast && <div className={`cr-toast cr-toast-${toast.type}`}>{toast.msg}</div>}

        <div className="cr-body">
          {loading ? (
            <div className="cr-loading">Loading conflicts…</div>
          ) : conflicts.length === 0 ? (
            <div className="cr-empty">
              <div className="cr-empty-icon">✓</div>
              <p>No pending conflicts.</p>
              <p className="cr-empty-sub">All synced records are clean.</p>
            </div>
          ) : (
            <>
              {/* Sidebar list of conflicts */}
              <aside className="cr-sidebar">
                {conflicts.map(c => {
                  const cDiffs = diffRows(c.client_data, c.server_data);
                  const sev = classifyConflict(cDiffs);
                  return (
                    <button
                      key={c.id}
                      className={`cr-list-item ${activeId === c.id ? 'cr-list-active' : ''}`}
                      onClick={() => setActiveId(c.id)}
                    >
                      <div className="cr-list-title">
                        {c.table_name.replace(/_/g, ' ')}
                      </div>
                      <div className="cr-list-meta">
                        <span className={`cr-sev cr-sev-${sev.level}`}>{sev.label}</span>
                        <span className="cr-list-date">
                          {new Date(c.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </aside>

              {/* Active conflict diff */}
              {activeConflict && (
                <section className="cr-detail">
                  <header className="cr-detail-header">
                    <div>
                      <h3>{activeConflict.table_name}</h3>
                      <p className="cr-detail-meta">
                        Record <code>{activeConflict.record_id.slice(0, 8)}…</code> ·
                        Client v{activeConflict.client_version} vs Server v{activeConflict.server_version}
                      </p>
                    </div>
                    <span className={`cr-sev-badge cr-sev-${severity.level}`}>
                      {severity.label}
                    </span>
                  </header>

                  {diffs.length === 0 ? (
                    <div className="cr-no-diff">
                      No field-level differences detected. The conflict was caused by
                      a version mismatch — choose how to proceed below.
                    </div>
                  ) : (
                    <table className="cr-diff-table">
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th>Your change</th>
                          <th>Server value</th>
                          <th>Decision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diffs.map(d => (
                          <DiffRow
                            key={d.field}
                            diff={d}
                            decision={decisions[d.field]}
                            customValue={customValues[d.field]}
                            onPick={(choice) => pickField(d.field, choice)}
                            onCustom={(value) => setCustom(d.field, value)}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}

                  <footer className="cr-actions">
                    <button
                      className="cr-btn cr-btn-secondary"
                      disabled={resolving}
                      onClick={() => handleResolve('discard')}
                    >
                      Discard my edit
                    </button>
                    <button
                      className="cr-btn cr-btn-secondary"
                      disabled={resolving}
                      onClick={() => handleResolve('theirs')}
                    >
                      Take server
                    </button>
                    <button
                      className="cr-btn cr-btn-secondary"
                      disabled={resolving}
                      onClick={() => handleResolve('mine')}
                    >
                      Force my edit
                    </button>
                    <button
                      className="cr-btn cr-btn-primary"
                      disabled={resolving || Object.values(decisions).some(v => v === null)}
                      onClick={() => handleResolve('merge')}
                    >
                      {resolving ? 'Saving…' : 'Apply merge'}
                    </button>
                  </footer>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffRow({ diff, decision, customValue, onPick, onCustom }) {
  const [showCustom, setShowCustom] = useState(false);

  const needsDecision = decision === null;

  return (
    <tr className={`cr-diff-row cr-strategy-${diff.strategy}`}>
      <td className="cr-field-name">
        <strong>{diff.field}</strong>
        <span className="cr-strategy-tag">{diff.strategy}</span>
      </td>
      <td className="cr-cell-client">
        <span className="cr-value">{formatValue(diff.client)}</span>
      </td>
      <td className="cr-cell-server">
        <span className="cr-value">{formatValue(diff.server)}</span>
      </td>
      <td className="cr-cell-decision">
        <div className="cr-radio-group">
          <button
            className={`cr-radio ${decision === 'client' ? 'cr-radio-active' : ''}`}
            onClick={() => onPick('client')}
            title="Use your value"
          >
            Mine
          </button>
          <button
            className={`cr-radio ${decision === 'server' ? 'cr-radio-active' : ''}`}
            onClick={() => onPick('server')}
            title="Use server value"
          >
            Theirs
          </button>
          <button
            className={`cr-radio ${decision === 'custom' ? 'cr-radio-active' : ''}`}
            onClick={() => setShowCustom(s => !s)}
            title="Enter custom value"
          >
            Custom
          </button>
        </div>
        {showCustom && (
          <input
            className="cr-custom-input"
            type="text"
            value={customValue ?? ''}
            placeholder="Custom value"
            onChange={e => onCustom(e.target.value)}
            autoFocus
          />
        )}
        {needsDecision && (
          <span className="cr-needs-decision">⚠ Pick</span>
        )}
      </td>
    </tr>
  );
}
