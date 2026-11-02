import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import PatientProfile from '../../components/PatientProfile'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import { writeAudit } from '../../lib/audit'

// =====================================================================
// GOODIE-MEDHUB — HMO Patients module
//
// A filtered patient list — shows ONLY patients whose category is 'hmo'.
// HMO patients also still appear in the regular Patients module; this
// module exists so the billing team / insurance desk has a focused view.
//
// Layout:
//   1. Summary card: total count, breakdown by provider, total coverage
//   2. Search input (by name, hmo_id_code, hmo_number, phone)
//   3. Paginated table: Name | Provider | ID Code | Plan | Coverage % | Queue | Action
//   4. Click a row → opens the existing PatientProfile overlay
//
// This module uses the existing useOfflineTable('patients') hook — same
// data, same RLS, same offline-first behaviour as every other module.
// No new tables, no schema changes.
// =====================================================================

export default function HmoPatients() {
  const { profile, hospital } = useAuth()
  const { records: patients, loading } = useOfflineTable('patients', hospital?.id)
  const { records: claims } = useOfflineTable('insurance_claims', hospital?.id)

  const [search, setSearch] = useState('')
  const [profilePatientId, setProfilePatientId] = useState(null)

  // ---- Filter to HMO patients only + alphabetical sort by name ----------
  // Section 7: alphabetical A-Z is the system-wide default for patient lists.
  // Secondary sort by patient_id (stable for identical names).
  const hmoPatients = useMemo(() => {
    return patients
      .filter(p => p.category === 'hmo')
      .sort((a, b) => {
        const nameA = (a.full_name || '').trim().toLowerCase()
        const nameB = (b.full_name || '').trim().toLowerCase()
        if (nameA < nameB) return -1
        if (nameA > nameB) return 1
        return (a.id || '').localeCompare(b.id || '')
      })
  }, [patients])

  // ---- Summary card stats --------------------------------------------
  const summary = useMemo(() => {
    const total = hmoPatients.length
    const byProvider = hmoPatients.reduce((acc, p) => {
      const key = p.hmo_provider || 'Unknown'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    const totalCoverage = hmoPatients.reduce((sum, p) => sum + (Number(p.hmo_coverage_percent) || 0), 0)
    const avgCoverage = total > 0 ? Math.round(totalCoverage / total) : 0
    const pendingClaimsTotal = claims
      .filter(c => c.status === 'submitted')
      .reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
    const inQueue = hmoPatients.filter(p => p.queue_status).length

    return {
      total,
      byProviderCount: Object.keys(byProvider).length,
      byProvider,
      avgCoverage,
      pendingClaimsTotal,
      inQueue,
    }
  }, [hmoPatients, claims])

  // ---- Search filter --------------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return hmoPatients
    return hmoPatients.filter(p => {
      return [
        p.full_name,
        p.hmo_provider,
        p.hmo_id_code,
        p.hmo_number,
        p.hmo_plan,
        p.phone,
      ].some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [hmoPatients, search])

  // ---- Pagination -----------------------------------------------------
  const {
    pageItems, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(filtered, { pageSize: 20, resetKey: search })

  function formatMoney(v) {
    return '₦' + Number(v || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  // ---- If the user clicked into a patient profile, render it instead -
  if (profilePatientId) {
    return <PatientProfile
      patientId={profilePatientId}
      patient={patients.find(p => p.id === profilePatientId)}
      onClose={() => setProfilePatientId(null)}
    />
  }

  return (
    <>
      {/* ---- Summary cards ---- */}
      <div className="dash-stats" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <path d="M9 12l2 2 4-4M21 12c0 5-3.5 7.5-7.5 9.5C9.5 19.5 6 17 6 12V6l7.5-3L21 6v6z" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Total HMO Patients</div>
            <div className="dash-stat-value">{summary.total}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <path d="M3 7h18M3 12h18M3 17h18" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Active Providers</div>
            <div className="dash-stat-value">{summary.byProviderCount}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Pending Claims</div>
            <div className="dash-stat-value" style={{ fontSize: 17 }}>{formatMoney(summary.pendingClaimsTotal)}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(76,141,255,0.14)', color: 'var(--blue)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Avg Coverage</div>
            <div className="dash-stat-value">{summary.avgCoverage}%</div>
          </div>
        </div>
      </div>

      {/* ---- Patients table ---- */}
      <div className="dash-panel">
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">HMO Patients</div>
            <div className="dash-panel-sub">{hospital?.name || 'your hospital'} · {summary.inQueue} in queue</div>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, ID code, policy no., phone…" style={{ minWidth: 260, maxWidth: 420 }} />
          <ModuleHistoryButton moduleKey="hmo" />
        </div>

        {loading ? (
          <div className="dash-empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="dash-empty-state">
            {search.trim()
              ? `No HMO patients match "${search}".`
              : 'No HMO patients yet. Register one via Reception with the "HMO Folder" category.'}
          </div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>HMO Provider</th>
                    <th>ID Code</th>
                    <th>Plan</th>
                    <th>Coverage</th>
                    <th>Queue</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(p => (
                    <tr key={p.id}>
                      <td onClick={() => setProfilePatientId(p.id)} style={{ cursor: 'pointer', fontWeight: 700 }}>
                        {p.full_name || 'Unnamed'}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--ivory)' }}>{p.hmo_provider || '—'}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)' }}>{p.hmo_id_code || '—'}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.hmo_plan || '—'}</td>
                      <td>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
                          background: p.hmo_coverage_percent >= 80 ? 'var(--teal-soft)' : p.hmo_coverage_percent >= 50 ? 'rgba(201,169,97,0.14)' : 'rgba(154,170,183,0.14)',
                          color: p.hmo_coverage_percent >= 80 ? 'var(--teal)' : p.hmo_coverage_percent >= 50 ? 'var(--gold)' : 'var(--muted)',
                        }}>
                          {p.hmo_coverage_percent != null ? `${p.hmo_coverage_percent}%` : '—'}
                        </span>
                      </td>
                      <td style={{ fontSize: 11.5 }}>
                        {p.queue_status ? (
                          <span style={{ color: 'var(--gold)', fontWeight: 600 }}>
                            {p.queue_status.replace('_', ' ')}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--muted)' }}>—</span>
                        )}
                      </td>
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
              itemLabel="HMO patients"
            />
          </>
        )}
      </div>
    </>
  )
}
