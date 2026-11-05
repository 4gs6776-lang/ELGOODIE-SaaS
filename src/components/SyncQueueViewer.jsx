import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useCurrentHospital } from '../lib/useCurrentHospital';
import {
  getQueueStats,
  retryRecord,
  discardPendingRecord,
} from '../lib/useOfflineTable.syncPatch';
import { flushTableQueue } from '../lib/useOfflineTable';
import './OfflineFirst.css';

export default function SyncQueueViewer({ open, onClose }) {
  const { hospitalId } = useCurrentHospital();
  const [stats, setStats] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [tableRecords, setTableRecords] = useState([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && hospitalId) refresh();
  }, [open, hospitalId]);

  async function refresh() {
    const s = await getQueueStats(hospitalId);
    setStats(s);
  }

  async function expandTable(tableName) {
    if (expanded === tableName) {
      setExpanded(null);
      setTableRecords([]);
      return;
    }
    setExpanded(tableName);
    setLoadingRecords(true);
    try {
      // Open IndexedDB directly to fetch pending records for this table
      const req = indexedDB.open('HospitalOfflineDB', 3);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('offline_records', 'readonly');
        const store = tx.objectStore('offline_records');
        const allReq = store.getAll();
        allReq.onsuccess = () => {
          const filtered = (allReq.result || []).filter(
            r => r.table_name === tableName &&
                 r.hospital_id === hospitalId &&
                 r._synced === false &&
                 r._discarded !== true
          );
          setTableRecords(filtered);
          setLoadingRecords(false);
        };
      };
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
      setLoadingRecords(false);
    }
  }

  async function retryOne(record) {
    setBusy(true);
    try {
      await retryRecord(record.id);
      // Trigger flush for this table
      await flushTableQueue(record.table_name);
      setToast({ type: 'success', msg: 'Record retried' });
      await expandTable(record.table_name);
      await refresh();
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function discardOne(record) {
    if (!confirm('Discard this pending change? It will be lost.')) return;
    setBusy(true);
    try {
      await discardPendingRecord(record.id);
      setToast({ type: 'info', msg: 'Record discarded' });
      await expandTable(record.table_name);
      await refresh();
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function retryAll() {
    setBusy(true);
    try {
      // Flush all tables in order
      for (const tableName of Object.keys(stats)) {
        await flushTableQueue(tableName);
      }
      setToast({ type: 'success', msg: 'All records retried' });
      await refresh();
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  if (!open) return null;

  const tableNames = Object.keys(stats).sort();
  const totalPending = Object.values(stats).reduce((s, t) => s + t.pending, 0);
  const totalErrors = Object.values(stats).reduce((s, t) => s + t.errors, 0);

  return (
    <div className="cr-overlay" onClick={onClose}>
      <div className="cr-modal" onClick={e => e.stopPropagation()}>
        <header className="cr-modal-header">
          <h2>
            Sync Queue
            <span className="cr-count-badge">{totalPending} pending</span>
            {totalErrors > 0 && (
              <span className="cr-count-badge cr-count-danger">{totalErrors} errors</span>
            )}
          </h2>
          <button className="cr-close" onClick={onClose}>×</button>
        </header>

        {toast && <div className={`cr-toast cr-toast-${toast.type}`}>{toast.msg}</div>}

        <div className="cr-body">
          <div className="sq-actions-bar">
            <button className="cr-btn cr-btn-primary" disabled={busy} onClick={retryAll}>
              {busy ? 'Retrying…' : '↻ Retry all'}
            </button>
            <button className="cr-btn cr-btn-secondary" onClick={refresh}>
              ↻ Refresh
            </button>
          </div>

          {tableNames.length === 0 ? (
            <div className="cr-empty">
              <div className="cr-empty-icon">✓</div>
              <p>Queue is empty.</p>
              <p className="cr-empty-sub">All local changes have been synced.</p>
            </div>
          ) : (
            <div className="sq-tables">
              {tableNames.map(name => {
                const s = stats[name];
                return (
                  <div key={name} className="sq-table-card">
                    <button
                      className="sq-table-header"
                      onClick={() => expandTable(name)}
                    >
                      <div className="sq-table-name">
                        {name.replace(/_/g, ' ')}
                      </div>
                      <div className="sq-table-stats">
                        <span className="sq-stat-pending">{s.pending} pending</span>
                        {s.errors > 0 && (
                          <span className="sq-stat-errors">{s.errors} errors</span>
                        )}
                        {s.oldest && (
                          <span className="sq-stat-oldest">
                            oldest: {new Date(s.oldest).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </button>

                    {expanded === name && (
                      <div className="sq-table-records">
                        {loadingRecords ? (
                          <div className="cr-loading">Loading records…</div>
                        ) : tableRecords.length === 0 ? (
                          <div className="sq-empty-mini">No records</div>
                        ) : (
                          <table className="cr-diff-table">
                            <thead>
                              <tr>
                                <th>ID</th>
                                <th>Created</th>
                                <th>Error</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tableRecords.map(r => (
                                <tr key={r.id}>
                                  <td><code>{r.id.slice(0, 8)}…</code></td>
                                  <td>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                  <td className="sq-error-cell">
                                    {r._syncErrorMessage || (r._syncError ? 'Unknown error' : '—')}
                                  </td>
                                  <td>
                                    <div className="cr-action-row">
                                      <button
                                        className="cr-btn-mini"
                                        disabled={busy}
                                        onClick={() => retryOne(r)}
                                      >
                                        Retry
                                      </button>
                                      <button
                                        className="cr-btn-mini cr-btn-danger"
                                        disabled={busy}
                                        onClick={() => discardOne(r)}
                                      >
                                        Discard
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
