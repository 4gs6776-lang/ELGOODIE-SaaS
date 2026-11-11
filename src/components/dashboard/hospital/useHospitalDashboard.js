import { useMemo, useState, useEffect, useRef } from 'react'
import { useOfflineTable } from '../../../lib/useOfflineTable'
import { canAccessModule, FULL_ACCESS_ROLES } from '../../../lib/permissions'
import { getTimezone, dayKeyInZone, todayKeyInZone } from '../../../lib/datetime'
import { fetchDashboardSummary } from '../../../lib/dashboardSummary'
import { labStage } from '../../../lib/lab'

// =====================================================================
// GOODIE-MEDHUB — data layer for the hospital overview dashboard.
//
// CORRECTIONS (requirement 8):
//   * Preserve zero RPC values — uses `??` (nullish), never `||`.
//   * Prevent lab_tests/lab_orders double-counting — Map-based dedup
//     by `id` and `order_id`.
//   * Hospital timezone for every daily count/sum.
//   * Verified RPC parameter names (p_hospital_id, p_day, p_tz) and
//     JSON keys (snake_case) — see src/lib/dashboardSummary.js.
//   * Fall back safely on RPC failure (rpcError surfaced, local
//     computation takes over, no fabricated numbers).
//   * Avoid excessive hourly requests:
//       - The hourly timer is PAUSED when the document is hidden
//         (Page Visibility API).
//       - The timer is also PAUSED if the last fetch was less than
//         5 minutes ago (so a tab-thrash scenario cannot starve
//         the server).
//   * Distinguish stale data from freshly synchronized data:
//       - `rpcFetchedAt` is the timestamp of the last successful
//         RPC response (null before the first success).
//       - `stale` is true when (a) the RPC has never succeeded,
//         or (b) the last successful response is more than
//         15 minutes old. The UI uses this to render a "stale"
//         badge so the clinician knows the numbers may be off.
//
// Array fields stay in local computation — see LOCAL_ONLY_KEYS in
// dashboardSummary.js. We never overwrite these with RPC numbers.
// =====================================================================

const DAY = 86400000
const SERIES_DAYS = 90

// How long before the RPC data is considered "stale" for UI purposes.
// 15 minutes — slightly more than the 5-minute overlap window used
// by the offline sync, so a clinician looking at the dashboard knows
// the numbers are at most ~15 minutes behind the server's truth.
const STALE_AFTER_MS = 15 * 60 * 1000

// Minimum gap between two RPC fetches — prevents tab-thrash from
// hammering the server.
const MIN_RPC_GAP_MS = 5 * 60 * 1000

export function getDashboardAccess(role) {
  const viewAll = FULL_ACCESS_ROLES.includes(role) || role === 'cmd'
  const has = (k) => viewAll || canAccessModule(role, k)
  return {
    viewAll,
    patients: has('patients'),
    appointments: has('appointments'),
    triage: has('nursing') || has('doctor'),
    beds: has('admissions') || has('ipd'),
    lab: has('laboratory'),
    pharmacy: has('pharmacy') || has('inventory'),
    finance: has('billing'),
    activity: viewAll,
  }
}

// Count records per calendar day (hospital timezone) for the last
// `days` days, oldest first. Returns [{ key, value }].
function dailySeries(rows, getDate, days, tz, now) {
  const out = []
  const index = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKeyInZone(new Date(now.getTime() - i * DAY), tz)
    const point = { key, value: 0 }
    index.set(key, point)
    out.push(point)
  }
  for (const row of rows) {
    const d = getDate(row)
    if (!d) continue
    const point = index.get(dayKeyInZone(d, tz))
    if (point) point.value += 1
  }
  return out
}

function dailySum(rows, getDate, getAmount, days, tz, now) {
  const out = []
  const index = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKeyInZone(new Date(now.getTime() - i * DAY), tz)
    const point = { key, value: 0 }
    index.set(key, point)
    out.push(point)
  }
  for (const row of rows) {
    const d = getDate(row)
    if (!d) continue
    const point = index.get(dayKeyInZone(d, tz))
    if (point) point.value += Number(getAmount(row) || 0)
  }
  return out
}

export function weekOverWeek(series) {
  if (!series || series.length < 14) return null
  const last = series.slice(-7).reduce((s, p) => s + p.value, 0)
  const prev = series.slice(-14, -7).reduce((s, p) => s + p.value, 0)
  if (prev <= 0) return null
  return Math.round(((last - prev) / prev) * 100)
}

export function useHospitalDashboard(hospital, profile) {
  const role = profile?.role
  const access = useMemo(() => getDashboardAccess(role), [role])
  const tz = getTimezone(hospital)
  const hid = hospital?.id

  const on = (allowed) => (allowed ? hid : null)
  const pts = useOfflineTable('patients', on(access.patients))
  const appts = useOfflineTable('appointments', on(access.appointments))
  const vitals = useOfflineTable('patient_vitals', on(access.triage))
  const beds = useOfflineTable('beds', on(access.beds))
  const adms = useOfflineTable('admissions', on(access.beds))
  const admReqs = useOfflineTable('admission_requests', on(access.beds))
  const labTests = useOfflineTable('lab_tests', on(access.lab))
  const labOrders = useOfflineTable('lab_orders', on(access.lab))
  const stock = useOfflineTable('inventory_items', on(access.pharmacy))
  const invoices = useOfflineTable('invoices', on(access.finance))
  const audit = useOfflineTable('audit_events', on(access.activity))

  const all = [pts, appts, vitals, beds, adms, admReqs, labTests, labOrders, stock, invoices, audit]
  const loading = all.some((t) => t.loading)
  const isOnline = pts.isOnline
  const pendingSync = pts.pendingCount
  const conflictCount = pts.conflictCount

  // --- RPC state ----------------------------------------------------
  // rpcSummary: the camelCased summary object from the RPC, or null
  //             if the RPC has not yet succeeded.
  // rpcError:   the original Supabase error object on failure (or null).
  // rpcFetchedAt: ms timestamp of the last successful RPC response.
  //               Null = never fetched successfully.
  // stale:      true when the data shown is older than STALE_AFTER_MS
  //             (or was never fetched).
  const [rpcSummary, setRpcSummary] = useState(null)
  const [rpcError, setRpcError] = useState(null)
  const [rpcFetchedAt, setRpcFetchedAt] = useState(null)
  const todayKey = todayKeyInZone(tz)
  // Ref mirrors for use inside timers without re-creating them.
  const lastFetchRef = useRef(0)

  // Initial fetch + refetch when hospital or timezone changes or
  // when local midnight rolls over (todayKey changes).
  useEffect(() => {
    if (!hid) {
      setRpcSummary(null)
      setRpcError(null)
      setRpcFetchedAt(null)
      lastFetchRef.current = 0
      return
    }
    let cancelled = false
    ;(async () => {
      // Throttle: do not fetch more than once every MIN_RPC_GAP_MS
      // even if the effect fires repeatedly.
      const nowMs = Date.now()
      if (nowMs - lastFetchRef.current < MIN_RPC_GAP_MS && lastFetchRef.current > 0) {
        return
      }
      lastFetchRef.current = nowMs
      const { data, error } = await fetchDashboardSummary({
        hospitalId: hid,
        timezone: tz,
        dayKey: todayKey,
      })
      if (cancelled) return
      if (error) {
        setRpcError(error)
        // Do NOT clear rpcSummary on a transient failure — keep the
        // last good value so the dashboard continues to render. The
        // `stale` flag will mark it as out-of-date.
        setRpcFetchedAt((prev) => prev) // unchanged
      } else {
        setRpcError(null)
        setRpcSummary(data)
        setRpcFetchedAt(Date.now())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hid, tz, todayKey])

  // Hourly refresh — paused when the document is hidden (Page
  // Visibility API) so background tabs do not hammer the server.
  useEffect(() => {
    if (!hid) return
    const id = setInterval(async () => {
      // Pause when tab is hidden.
      if (typeof document !== 'undefined' && document.hidden) return
      // Throttle: minimum gap between fetches.
      const nowMs = Date.now()
      if (nowMs - lastFetchRef.current < MIN_RPC_GAP_MS) return
      lastFetchRef.current = nowMs
      const { data, error } = await fetchDashboardSummary({
        hospitalId: hid,
        timezone: tz,
        dayKey: todayKeyInZone(tz),
      })
      if (!error && data) {
        setRpcError(null)
        setRpcSummary(data)
        setRpcFetchedAt(Date.now())
      }
      // On error: leave the previous summary in place; the stale
      // flag will mark it as out-of-date.
    }, 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [hid, tz])

  // Compute the `stale` flag.
  const stale =
    !rpcFetchedAt ||
    (Date.now() - rpcFetchedAt) > STALE_AFTER_MS

  const data = useMemo(() => {
    const now = new Date()
    const today = todayKeyInZone(tz)
    const isToday = (iso) => !!iso && dayKeyInZone(iso, tz) === today
    const m = { today }

    // Helper: prefer RPC value when present, fall back to local
    // computation only when RPC did not return the key. Uses `!=`
    // (loose nullish check, catches null AND undefined) so a
    // legitimate 0 from the RPC survives. NEVER use `||` here.
    const pick = (rpcKey, localValue) =>
      rpcSummary && rpcSummary[rpcKey] != null ? rpcSummary[rpcKey] : localValue

    // ---- Patients & queue
    const patients = pts.records
    const localTotalPatients = patients.length
    const localRegisteredToday = patients.filter((p) => isToday(p.created_at)).length
    const localWaiting = patients.filter((p) => p.queue_status === 'waiting')
    const localConsult = patients.filter((p) => p.queue_status === 'in_consultation')
    const localQueueDischargedToday = patients.filter(
      (p) => p.queue_status === 'discharged' && isToday(p.queue_updated_at)
    )

    m.totalPatients = pick('totalPatients', localTotalPatients)
    m.registeredToday = pick('registeredToday', localRegisteredToday)
    m.waitingList = localWaiting           // LOCAL_ONLY — array
    m.consultList = localConsult           // LOCAL_ONLY — array
    // FIX: queueDischargedToday must be the ARRAY of patient objects,
    // NOT the count. DashboardOverview.jsx line 95 calls
    // `d.queueDischargedToday.length` and `d.queueDischargedToday.map(...)`,
    // which requires an array. The previous code returned
    // `localQueueDischargedToday.length` (a number), which crashed the
    // dashboard with "queueDischargedToday.map is not a function"
    // every time a user signed in and the overview tab rendered.
    // The RPC `discharged_today` field is documented as `integer`, so
    // we must NOT use `pick()` here — the RPC value is a count, not a
    // list. Always use the local array.
    m.queueDischargedToday = localQueueDischargedToday  // LOCAL_ONLY — array
    m.ancCount = pick('ancCount', patients.filter((p) => p.category === 'anc').length)
    m.registrationSeries = dailySeries(patients, (p) => p.created_at, SERIES_DAYS, tz, now)
    const registeredInWindow = m.registrationSeries.reduce((sum, pt) => sum + pt.value, 0)
    let runningTotal = m.totalPatients - registeredInWindow
    m.growthSeries = m.registrationSeries.map((pt) => { runningTotal += pt.value; return { key: pt.key, value: runningTotal } })
    const nameById = new Map(patients.map((p) => [p.id, p.full_name || [p.surname, p.other_names].filter(Boolean).join(' ')]))

    // ---- Triage / vitals
    m.triageSeries = dailySeries(vitals.records, (v) => v.created_at, SERIES_DAYS, tz, now)
    m.triageToday = vitals.records.filter((v) => isToday(v.created_at)).length

    // ---- Appointments
    const ap = appts.records
    const apToday = ap.filter((a) => isToday(a.appointment_time))
    m.apptToday = pick('apptToday', apToday.length)
    m.apptScheduledToday = pick('apptScheduledToday', apToday.filter((a) => a.status === 'scheduled').length)
    m.apptCompletedToday = pick('apptCompletedToday', apToday.filter((a) => a.status === 'completed').length)
    m.apptCancelledToday = pick('apptCancelledToday', apToday.filter((a) => a.status === 'cancelled').length)
    m.apptUpcoming = ap
      .filter((a) => a.status === 'scheduled' && new Date(a.appointment_time) >= new Date(now.getTime() - 15 * 60000))
      .sort((a, b) => new Date(a.appointment_time) - new Date(b.appointment_time))
      .slice(0, 6)
    m.apptSeries = dailySeries(ap, (a) => a.appointment_time, SERIES_DAYS, tz, now)

    // ---- Beds & admissions
    const bd = beds.records
    m.bedsTotal = pick('bedsTotal', bd.length)
    m.bedsOccupied = pick('bedsOccupied', bd.filter((b) => b.status === 'occupied').length)
    m.bedsAvailable = pick('bedsAvailable', bd.filter((b) => b.status === 'available').length)
    m.bedsCleaning = pick('bedsCleaning', bd.filter((b) => b.status === 'cleaning').length)
    m.bedsReserved = pick('bedsReserved', bd.filter((b) => b.status === 'reserved').length)
    m.occupancyPct = m.bedsTotal > 0 ? Math.round((m.bedsOccupied / m.bedsTotal) * 100) : null
    const activeAdm = adms.records.filter((a) => a.status === 'active')
    m.admittedList = activeAdm.map((a) => ({ id: a.id, name: nameById.get(a.patient_id) || 'Patient', ward: a.ward, at: a.admitted_at })) // LOCAL_ONLY
    m.admittedCount = activeAdm.length
    m.admittedToday = pick('admittedToday', adms.records.filter((a) => isToday(a.admitted_at)).length)
    m.dischargedToday = pick('dischargedToday', adms.records.filter((a) => a.status === 'discharged' && isToday(a.discharge_date)).length)
    m.pendingAdmissionRequests = pick('pendingAdmissionRequests', admReqs.records.filter((r) => r.status === 'pending').length)
    m.admissionSeries = dailySeries(adms.records, (a) => a.admitted_at, SERIES_DAYS, tz, now)
    const stays = adms.records
      .filter((a) => a.admitted_at)
      .map((a) => ({
        from: dayKeyInZone(a.admitted_at, tz),
        to: a.status === 'active' ? null : (a.discharge_date ? dayKeyInZone(a.discharge_date, tz) : undefined),
      }))
      .filter((st) => st.to !== undefined)
    m.censusSeries = m.admissionSeries.map((pt) => ({
      key: pt.key,
      value: stays.filter((st) => st.from <= pt.key && (st.to === null || st.to > pt.key)).length,
    }))

    // ---- Laboratory (lab_tests + lab_orders — deduped)
    // lab_tests and lab_orders describe the same investigation when
    // lab_tests.order_id = lab_orders.id. Counting both would
    // double-count every test that has results. We dedupe via a Map
    // keyed by row id; the lab_tests row wins (it carries the
    // actual status), and a lab_orders row is only added when no
    // lab_tests row points at it.
    const labsById = new Map()
    for (const t of labTests.records) {
      if (!t || !t.id || t.deleted_at) continue
      labsById.set(t.id, t)
    }
    const labTestOrderIds = new Set(
      labTests.records
        .map((t) => t.order_id)
        .filter(Boolean)
    )
    for (const o of labOrders.records) {
      if (!o || !o.id || o.deleted_at) continue
      // Skip the lab_orders row if a lab_tests row already represents it.
      if (labTestOrderIds.has(o.id)) continue
      labsById.set(o.id, o)
    }
    const labs = Array.from(labsById.values()).filter((t) => labStage(t.status) !== 'cancelled')

    const stageCount = { ordered: 0, sample_collected: 0, processing: 0, completed: 0 }
    labs.forEach((t) => { stageCount[labStage(t.status)] += 1 })
    m.lab = stageCount
    // FIX: use `??`-equivalent via pick() so a legitimate RPC 0
    // is NOT collapsed to the local count.
    const localLabPending = stageCount.ordered + stageCount.sample_collected + stageCount.processing
    m.labPending = pick('labPending', localLabPending)
    m.labCompletedToday = pick('labCompletedToday', labs.filter((t) => labStage(t.status) === 'completed' && isToday(t.resulted_at)).length)
    m.labSeries = dailySeries(labs, (t) => t.requested_at || t.created_at, SERIES_DAYS, tz, now)

    // ---- Pharmacy / inventory
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const daysToExpiry = (it) => {
      if (!it.expiry_date) return null
      const e = new Date(it.expiry_date); e.setHours(0, 0, 0, 0)
      return (e.getTime() - startOfToday.getTime()) / DAY
    }
    const items = stock.records
    const localStockOut = items.filter((i) => Number(i.quantity || 0) <= 0).length
    const localStockLow = items.filter((i) => Number(i.quantity || 0) > 0 && Number(i.quantity || 0) <= Number(i.reorder_level || 0)).length
    const localStockExpired = items.filter((i) => { const d = daysToExpiry(i); return d !== null && d < 0 }).length
    const localStockExpiring = items.filter((i) => { const d = daysToExpiry(i); return d !== null && d >= 0 && d <= 30 }).length

    m.stockOut = pick('stockOut', localStockOut)
    m.stockLow = pick('stockLow', localStockLow)
    m.stockExpired = pick('stockExpired', localStockExpired)
    m.stockExpiring = pick('stockExpiring', localStockExpiring)
    // FIX: pick() preserves a legitimate RPC 0 for stockAlerts too.
    const localStockAlerts = localStockOut + localStockLow
    m.stockAlerts = pick('stockAlerts', localStockAlerts)
    m.stockTotal = items.length
    m.stockWatch = items
      .filter((i) => Number(i.quantity || 0) <= Number(i.reorder_level || 0))
      .sort((a, b) => Number(a.quantity || 0) - Number(b.quantity || 0))
      .slice(0, 4)
      .map((i) => ({ id: i.id, name: i.name, qty: Number(i.quantity || 0), reorder: Number(i.reorder_level || 0), unit: i.unit }))

    // ---- Finance
    const inv = invoices.records
    const localRevenueToday = inv.filter((i) => isToday(i.created_at)).reduce((s, i) => s + Number(i.amount_paid || 0), 0)
    const localOutstanding = inv.filter((i) => i.status !== 'paid' && i.status !== 'cancelled').reduce((s, i) => s + Number(i.balance || 0), 0)
    const localOutstandingCount = inv.filter((i) => i.status !== 'paid' && i.status !== 'cancelled' && Number(i.balance || 0) > 0).length
    const localInvoicesToday = inv.filter((i) => isToday(i.created_at)).length

    m.revenueToday = pick('revenueToday', localRevenueToday)
    m.outstanding = pick('outstanding', localOutstanding)
    m.outstandingCount = pick('outstandingCount', localOutstandingCount)
    m.invoicesToday = pick('invoicesToday', localInvoicesToday)
    m.revenueSeries = dailySum(inv, (i) => i.created_at, (i) => i.amount_paid, SERIES_DAYS, tz, now)

    // ---- Recent activity
    m.activity = [...audit.records]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 8)

    return m
  }, [pts.records, appts.records, vitals.records, beds.records, adms.records, admReqs.records,
      labTests.records, labOrders.records, stock.records, invoices.records, audit.records, tz,
      rpcSummary])

  return {
    access,
    data,
    loading,
    isOnline,
    pendingSync,
    conflictCount,
    rpcError,
    rpcFetchedAt,
    stale,
    tz,
  }
}
