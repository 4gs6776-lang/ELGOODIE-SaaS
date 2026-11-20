import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'

// =====================================================================
// GOODIE-MEDHUB — Audit Log viewer (front-end for migration 007's
// append-only `audit_events` table, written to by src/lib/audit.js).
//
// Read-only by design: audit_events has no UPDATE/DELETE RLS policy,
// so this page only ever lists and filters existing rows.
// =====================================================================

export default function AuditLog(){
  const { hospital } = useAuth()
  const { records: events, loading } = useOfflineTable('audit_events', hospital?.id)

  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [entityFilter, setEntityFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selected, setSelected] = useState(null)

  const actionOptions = useMemo(() => {
    const set = new Set(events.map(e => e.action).filter(Boolean))
    return ['all', ...Array.from(set).sort()]
  }, [events])

  const entityOptions = useMemo(() => {
    const set = new Set(events.map(e => e.entity_type).filter(Boolean))
    return ['all', ...Array.from(set).sort()]
  }, [events])

  const filtered = useMemo(() => {
    return events
      .filter(e => actionFilter === 'all' || e.action === actionFilter)
      .filter(e => entityFilter === 'all' || e.entity_type === entityFilter)
      .filter(e => {
        if (!dateFrom) return true
        return e.created_at && new Date(e.created_at) >= new Date(dateFrom)
      })
      .filter(e => {
        if (!dateTo) return true
        const end = new Date(dateTo)
        end.setHours(23, 59, 59, 999)
        return e.created_at && new Date(e.created_at) <= end
      })
      .filter(e => {
        if (!search.trim()) return true
        const q = search.trim().toLowerCase()
        return (
          (e.summary || '').toLowerCase().includes(q) ||
          (e.actor_name || '').toLowerCase().includes(q) ||
          (e.action || '').toLowerCase().includes(q) ||
          (e.entity_type || '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [events, actionFilter, entityFilter, dateFrom, dateTo, search])

  // Global Pagination Rule: audit_events grows forever, so page the list.
  // Any filter/search change snaps back to page 1 so the user never lands
  // on an out-of-range page after narrowing the results.
  const {
    pageItems, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(filtered, {
    pageSize: 20,
    resetKey: `${search}|${actionFilter}|${entityFilter}|${dateFrom}|${dateTo}`,
  })

  function formatDate(ts){
    if (!ts) return '—'
    return new Date(ts).toLocaleString('en-NG', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  function resetFilters(){
    setSearch('')
    setActionFilter('all')
    setEntityFilter('all')
    setDateFrom('')
    setDateTo('')
  }

  return (
    <>
      <div className="dash-stats">
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Total Events</div>
            <div className="dash-stat-value" style={{ fontSize: 17 }}>{events.length}</div>
            <div className="dash-stat-delta">{filtered.length} matching filters</div>
          </div>
        </div>
      </div>

      <div className="dash-panel" style={{ marginTop: 20 }}>
        <div className="dash-panel-header">
          <h3>Audit Trail</h3>
          <span style={{ fontSize: 12, opacity: 0.7 }}>Read-only — entries cannot be edited or deleted</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '12px 0' }}>
          <input
            type="text"
            placeholder="Search summary, actor, action..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: '1 1 220px', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}
          />
          <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
            {actionOptions.map(a => <option key={a} value={a}>{a === 'all' ? 'All actions' : a}</option>)}
          </select>
          <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
            {entityOptions.map(t => <option key={t} value={t}>{t === 'all' ? 'All entity types' : t}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
          <button onClick={resetFilters} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent' }}>
            Clear
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 20, opacity: 0.7 }}>Loading audit events…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, opacity: 0.7 }}>No audit events match these filters.</div>
        ) : (
          <>
          <div style={{ overflowX: 'auto' }}>
            <table className="dash-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>When</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Actor</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Action</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Entity</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Summary</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map(e => (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e)}
                    style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
                  >
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{formatDate(e.created_at)}</td>
                    <td style={{ padding: '8px 10px' }}>{e.actor_name || '—'}{e.actor_role ? ` (${e.actor_role})` : ''}</td>
                    <td style={{ padding: '8px 10px' }}>{e.action}</td>
                    <td style={{ padding: '8px 10px' }}>{e.entity_type}</td>
                    <td style={{ padding: '8px 10px' }}>{e.summary || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
              itemLabel="events"
            />
          </>
        )}
      </div>

      {selected && (
        <div
          onClick={() => setSelected(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--surface, #fff)', borderRadius: 12, padding: 24, maxWidth: 520, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}
          >
            <h3 style={{ marginTop: 0 }}>Audit Event</h3>
            <p><strong>When:</strong> {formatDate(selected.created_at)}</p>
            <p><strong>Actor:</strong> {selected.actor_name || '—'} {selected.actor_role ? `(${selected.actor_role})` : ''}</p>
            <p><strong>Action:</strong> {selected.action}</p>
            <p><strong>Entity:</strong> {selected.entity_type} {selected.entity_id ? `#${selected.entity_id}` : ''}</p>
            {selected.patient_id && <p><strong>Patient ID:</strong> {selected.patient_id}</p>}
            <p><strong>Summary:</strong> {selected.summary || '—'}</p>
            {selected.metadata && Object.keys(selected.metadata).length > 0 && (
              <>
                <p><strong>Details:</strong></p>
                <pre style={{ background: 'var(--bg-soft, #f5f5f5)', padding: 12, borderRadius: 8, fontSize: 12, overflowX: 'auto' }}>
                  {JSON.stringify(selected.metadata, null, 2)}
                </pre>
              </>
            )}
            <button onClick={() => setSelected(null)} style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent' }}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
