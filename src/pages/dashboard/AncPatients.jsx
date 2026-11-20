import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import PatientProfile from '../../components/PatientProfile'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'

// =====================================================================
// GOODIE-MEDHUB — ANC Patients module
//
// A filtered patient list — shows ONLY patients whose category is 'anc'
// (Antenatal Care). ANC patients also still appear in the regular
// Patients module; this module exists so the midwifery/OBGYN team has
// a focused view.
//
// Layout:
//   1. Summary card: total count, gestational age breakdown, upcoming
//      EDDs in next 30 days, in-queue count
//   2. Search input
//   3. Paginated table: Name | EDD | Gest. Age | Trimester | Husband | Queue
//   4. Click a row → opens the existing PatientProfile overlay
//
// No new tables, no schema changes. Reads the existing anc_* columns
// on the patients table.
// =====================================================================

export default function AncPatients() {
  const { hospital } = useAuth()
  const { records: patients, syncFromServer: syncPatients, loading } = useOfflineTable('patients', hospital?.id)
  const { records: deliveries, syncFromServer: syncDeliveries } = useOfflineTable('deliveries', hospital?.id)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('active') // all | active | pregnant | delivered | miscarried
  const [profilePatientId, setProfilePatientId] = useState(null)

  // Realtime: when a delivery is recorded in the Delivery module, the
  // patient's `anc_delivery_status` flips to 'delivered' and a new row
  // lands in the `deliveries` table. Both fire Realtime events —
  // refresh from server so this list updates live without a manual reload.
  useRealtimeAlert('deliveries', hospital?.id, () => { syncDeliveries(); syncPatients() })
  useRealtimeAlert('patients', hospital?.id, () => { syncPatients() })

  // ---- Filter to ANC patients only + derive delivery status ----------
  // `anc_delivery_status` is written by the Delivery module when a
  // midwife records a delivery. Null/undefined means the patient is
  // still pregnant (the column was added in migration 103; pre-existing
  // ANC patients are backfilled to 'pregnant' on the database side, but
  // we also default here so the UI is never ambiguous for rows synced
  // before that backfill ran).
  //
  // Sort: active (pregnant) patients first, then miscarried, then
  // delivered — so the people who still need attention stay at the top.
  // Within each group, alphabetical A-Z (Section 7 default).
  const ancPatients = useMemo(() => {
    return patients
      .filter(p => p.category === 'anc')
      .map(p => {
        let status = p.anc_delivery_status || 'pregnant'
        // Defensive: if a delivery row exists but the status column
        // wasn't synced yet, infer from anc_delivery_date.
        if (status === 'pregnant' && p.anc_delivery_date) status = 'delivered'
        return { ...p, _deliveryStatus: status }
      })
      .sort((a, b) => {
        const order = { pregnant: 0, miscarried: 1, delivered: 2 }
        const so = order[a._deliveryStatus] ?? 0
        const bo = order[b._deliveryStatus] ?? 0
        if (so !== bo) return so - bo
        const nameA = (a.full_name || '').trim().toLowerCase()
        const nameB = (b.full_name || '').trim().toLowerCase()
        if (nameA < nameB) return -1
        if (nameA > nameB) return 1
        return (a.id || '').localeCompare(b.id || '')
      })
  }, [patients])

  // ---- Compute gestational age + trimester for each ANC patient -------
  const today = new Date()

  const ancWithComputed = useMemo(() => {
    return ancPatients.map(p => {
      // Gestational age from LMP (weeks)
      let gestAgeWeeks = null
      let trimester = null
      if (p.anc_lmp) {
        const lmp = new Date(p.anc_lmp)
        if (!isNaN(lmp.getTime())) {
          const daysDiff = Math.floor((today - lmp) / (1000 * 60 * 60 * 24))
          if (daysDiff >= 0 && daysDiff <= 300) {
            gestAgeWeeks = Math.floor(daysDiff / 7)
            if (gestAgeWeeks < 13) trimester = 1
            else if (gestAgeWeeks < 28) trimester = 2
            else trimester = 3
          }
        }
      }

      // EDD
      let edd = null
      if (p.anc_edd) {
        const e = new Date(p.anc_edd)
        if (!isNaN(e.getTime())) edd = e
      }

      // Days to EDD (negative = past EDD = should have delivered)
      let daysToEdd = null
      if (edd) {
        daysToEdd = Math.floor((edd - today) / (1000 * 60 * 60 * 24))
      }

      return { ...p, _gestAgeWeeks: gestAgeWeeks, _trimester: trimester, _edd: edd, _daysToEdd: daysToEdd }
    })
  }, [ancPatients])

  // ---- Summary card stats --------------------------------------------
  // NOTE: trimester + EDD stats only count ACTIVE (pregnant) patients.
  // Once a patient is delivered or miscarried, their gestational age
  // and EDD are no longer clinically relevant — keeping them in the
  // "overdue EDD" count was misleading (it flagged mothers who had
  // already delivered as "overdue"). Total + queue counts still
  // include everyone so the register stays complete.
  const summary = useMemo(() => {
    const total = ancWithComputed.length
    const pregnant = ancWithComputed.filter(p => p._deliveryStatus === 'pregnant')
    const delivered = ancWithComputed.filter(p => p._deliveryStatus === 'delivered').length
    const miscarried = ancWithComputed.filter(p => p._deliveryStatus === 'miscarried').length
    const active = pregnant
    const t1 = active.filter(p => p._trimester === 1).length
    const t2 = active.filter(p => p._trimester === 2).length
    const t3 = active.filter(p => p._trimester === 3).length
    const upcomingEdd = active.filter(p => p._daysToEdd != null && p._daysToEdd >= 0 && p._daysToEdd <= 30).length
    const overdueEdd = active.filter(p => p._daysToEdd != null && p._daysToEdd < 0).length
    const inQueue = ancWithComputed.filter(p => p.queue_status).length

    return { total, pregnant: pregnant.length, delivered, miscarried, t1, t2, t3, upcomingEdd, overdueEdd, inQueue }
  }, [ancWithComputed])

  // ---- Status + search filter ---------------------------------------
  const filtered = useMemo(() => {
    let list = ancWithComputed
    if (statusFilter !== 'all') {
      if (statusFilter === 'active') {
        list = list.filter(p => p._deliveryStatus === 'pregnant')
      } else {
        list = list.filter(p => p._deliveryStatus === statusFilter)
      }
    }
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(p => {
      return [
        p.full_name,
        p.anc_husband_name,
        p.anc_indication,
        p.phone,
      ].some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [ancWithComputed, search, statusFilter])

  // ---- Pagination -----------------------------------------------------
  const {
    pageItems, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(filtered, { pageSize: 20, resetKey: search })

  function formatEdd(edd, daysToEdd) {
    if (!edd) return '—'
    const dateStr = edd.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })
    if (daysToEdd == null) return dateStr
    if (daysToEdd < 0) return `${dateStr} · ${Math.abs(daysToEdd)}d overdue`
    if (daysToEdd === 0) return `${dateStr} · TODAY`
    return `${dateStr} · in ${daysToEdd}d`
  }

  // ---- If the user clicked into a patient profile, render it instead -
  if (profilePatientId) {
    return <PatientProfile
      patientId={profilePatientId}
      patient={patients.find(p => p.id === profilePatientId)}
      onClose={() => setProfilePatientId(null)}
    />
  }

  const trimesterLabel = (t) => t === 1 ? '1st' : t === 2 ? '2nd' : t === 3 ? '3rd' : '—'
  const trimesterColor = (t) => t === 1 ? 'var(--teal)' : t === 2 ? 'var(--gold)' : t === 3 ? 'var(--danger)' : 'var(--muted)'

  return (
    <>
      {/* ---- Summary cards ---- */}
      <div className="dash-stats" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Total ANC Patients</div>
            <div className="dash-stat-value">{summary.total}</div>
            <div className="dash-stat-delta" style={{ fontSize: 10 }}>
              <span style={{ color: 'var(--teal)' }}>{summary.pregnant} pregnant</span>
              <span style={{ color: 'var(--muted)' }}> · </span>
              <span style={{ color: 'var(--gold)' }}>{summary.delivered} delivered</span>
              {summary.miscarried > 0 && (
                <>
                  <span style={{ color: 'var(--muted)' }}> · </span>
                  <span style={{ color: 'var(--danger)' }}>{summary.miscarried} miscarried</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <path d="M12 2v20M2 12h20" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">Trimester Breakdown</div>
            <div className="dash-stat-value" style={{ fontSize: 14 }}>
              <span style={{ color: 'var(--teal)' }}>{summary.t1}</span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}> · </span>
              <span style={{ color: 'var(--gold)' }}>{summary.t2}</span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}> · </span>
              <span style={{ color: 'var(--danger)' }}>{summary.t3}</span>
            </div>
            <div className="dash-stat-delta" style={{ fontSize: 10 }}>1st · 2nd · 3rd</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">EDD in next 30 days</div>
            <div className="dash-stat-value" style={{ color: summary.upcomingEdd > 0 ? 'var(--gold)' : 'var(--text)' }}>{summary.upcomingEdd}</div>
            <div className="dash-stat-delta" style={{ color: 'var(--danger)' }}>{summary.overdueEdd > 0 ? `${summary.overdueEdd} overdue` : 'no overdue'}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(76,141,255,0.14)', color: 'var(--blue)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 20, height: 20 }}>
              <path d="M3 7h18M3 12h18M3 17h18" />
            </svg>
          </div>
          <div>
            <div className="dash-stat-label">In Queue Now</div>
            <div className="dash-stat-value">{summary.inQueue}</div>
          </div>
        </div>
      </div>

      {/* ---- Patients table ---- */}
      <div className="dash-panel">
        <div className="dash-panel-head dash-panel-head-wrap">
          <div>
            <div className="dash-panel-title">ANC Patients</div>
            <div className="dash-panel-sub">{hospital?.name || 'your hospital'} · antenatal care register</div>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, husband, indication, phone…" style={{ minWidth: 260, maxWidth: 420 }} />
          <ModuleHistoryButton moduleKey="anc" />
        </div>

        {/* ---- Delivery status filter chips ---- */}
        {/* Default to "Active" so the register opens on the patients who
            still need attention. Delivered/miscarried patients stay in
            the system (switch to "All" to see them) but no longer crowd
            the active list. Counts come straight from the summary. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
          {[
            { v: 'active',      label: 'Active (pregnant)',  count: summary.pregnant,   color: 'var(--teal)' },
            { v: 'delivered',   label: 'Delivered',          count: summary.delivered,  color: 'var(--gold)' },
            { v: 'miscarried',  label: 'Miscarried',         count: summary.miscarried, color: 'var(--danger)' },
            { v: 'all',         label: 'All',                count: summary.total,      color: 'var(--muted)' },
          ].map(chip => {
            const active = statusFilter === chip.v
            const disabled = chip.v !== 'all' && chip.count === 0
            return (
              <button
                key={chip.v}
                type="button"
                onClick={() => setStatusFilter(chip.v)}
                disabled={disabled}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', fontSize: 12, fontWeight: 600,
                  borderRadius: 14, cursor: disabled ? 'not-allowed' : 'pointer',
                  border: `1px solid ${active ? chip.color : 'var(--line)'}`,
                  background: active ? `${chip.color}1a` : 'transparent',
                  color: active ? chip.color : disabled ? 'var(--muted)' : 'var(--text)',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                {chip.label}
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                  background: active ? `${chip.color}33` : 'rgba(154,170,183,0.18)',
                }}>{chip.count}</span>
              </button>
            )
          })}
        </div>

        {loading ? (
          <div className="dash-empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="dash-empty-state">
            {search.trim()
              ? `No ANC patients match "${search}".`
              : statusFilter === 'all'
                ? 'No ANC patients yet. Register one via Reception with the "ANC Folder" category.'
                : `No ${statusFilter} ANC patients. Switch filters or record a delivery in the Delivery module.`}
          </div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>EDD</th>
                    <th>Gest. Age</th>
                    <th>Trimester</th>
                    <th>Husband / Partner</th>
                    <th>Queue</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(p => {
                    const statusMeta = {
                      pregnant:   { label: 'Pregnant',   color: 'var(--teal)' },
                      delivered:  { label: 'Delivered',  color: 'var(--gold)' },
                      miscarried: { label: 'Miscarried', color: 'var(--danger)' },
                    }[p._deliveryStatus] || { label: 'Pregnant', color: 'var(--teal)' }
                    return (
                    <tr key={p.id} style={{ opacity: p._deliveryStatus === 'pregnant' ? 1 : 0.72 }}>
                      <td onClick={() => setProfilePatientId(p.id)} style={{ cursor: 'pointer', fontWeight: 700 }}>
                        {p.full_name || 'Unnamed'}
                      </td>
                      <td>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
                          background: `${statusMeta.color}1a`, color: statusMeta.color,
                          whiteSpace: 'nowrap',
                        }}>
                          {statusMeta.label}
                        </span>
                        {p._deliveryStatus !== 'pregnant' && p.anc_delivery_date && (
                          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
                            {new Date(p.anc_delivery_date).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 11.5 }}>
                        <span style={{
                          color: p._daysToEdd != null && p._daysToEdd < 0 ? 'var(--danger)' :
                                 p._daysToEdd != null && p._daysToEdd <= 30 ? 'var(--gold)' :
                                 'var(--muted)',
                          fontWeight: (p._daysToEdd != null && p._daysToEdd <= 30) ? 700 : 400,
                        }}>
                          {p._deliveryStatus === 'pregnant'
                            ? formatEdd(p._edd, p._daysToEdd)
                            : '—'}
                        </span>
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {p._deliveryStatus === 'pregnant' && p._gestAgeWeeks != null ? `${p._gestAgeWeeks}w` : '—'}
                      </td>
                      <td>
                        {p._deliveryStatus === 'pregnant' ? (
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
                            background: p._trimester ? `${trimesterColor(p._trimester)}22` : 'rgba(154,170,183,0.14)',
                            color: p._trimester ? trimesterColor(p._trimester) : 'var(--muted)',
                          }}>
                            {trimesterLabel(p._trimester)}
                          </span>
                        ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.anc_husband_name || '—'}</td>
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
                    )
                  })}
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
              itemLabel="ANC patients"
            />
          </>
        )}
      </div>
    </>
  )
}
