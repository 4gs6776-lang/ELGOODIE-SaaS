import { useMemo, useState, useEffect } from 'react'
import { useOfflineTable } from '../../../lib/useOfflineTable'
import { canAccessModule, FULL_ACCESS_ROLES } from '../../../lib/permissions'
import { getTimezone, dayKeyInZone, todayKeyInZone } from '../../../lib/datetime'
import { fetchDashboardSummary, LOCAL_ONLY_KEYS } from '../../../lib/dashboardSummary'
import { labStage } from '../../../lib/lab'

// =====================================================================
// GOODIE-MEDHUB — data layer for the hospital overview dashboard.
//
// Rules of this file:
//  * It mostly READS. It reuses useOfflineTable, so the IndexedDB
//    cache, offline reads and sync keep working exactly as before.
//  * A table is only loaded when the signed-in role may see that
//    area (passing a null hospital id makes useOfflineTable skip the
//    table).
//  * Every number below follows a rule that already exists in the
//    app; the rule's origin is named in a comment next to it.
//
// RPC + LOCAL HYBRID
// ------------------
// get_dashboard_summary() returns scalar counts and totals. The
// dashboard also needs list-shaped fields (waitingList, apptUpcoming,
// admittedList, stockWatch, activity) and the time series used by
// the sparklines — those stay in local computation.
//
// The RPC numbers are MERGED in via the `??` operator (nullish
// coalescing), NOT `||`. A legitimate RPC zero must survive — using
// `||` here was the bug that hid "no pending labs today" behind the
// local count.
//
// Array fields listed in LOCAL_ONLY_KEYS are NEVER overwritten by
// RPC numbers.
// =====================================================================

const DAY = 86400000
const SERIES_DAYS = 90 // history kept for sparklines, week-over-week and the chart ranges

// What may this role see on the overview? Built from the existing
// permissions.js so there is no second permission system.
// 'cmd' (Chief Medical Director) is documented as "view every module,
// read-only", so it gets the full read view here.
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
    activity: viewAll, // audit events can name patients: admins / owner / CMD only
  }
}

// Count records per calendar day (hospital timezone) for the last `days`
// days, oldest first. Returns [{ key, label, value }].
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

// % change of the last 7 days vs the 7 days before. Returns null when
// there is no earlier history to compare with (we never invent a figure).
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

  // Only the tables this role may see are loaded.
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
  // Pending count is hospital-scoped (see useOfflineTable.loadLocalRecords):
  // the hook already filters to the current hospital.
  const pendingSync = pts.pendingCount
  const conflictCount = pts.conflictCount

  // --- RPC fetch ----------------------------------------------------
  // Pull scalar counts/totals from get_dashboard_summary() once per
  // hospital/day. Re-fetch when the hospital changes or when local
  // midnight rolls over (todayKeyInZone changes). We never refetch on
  // every state change — the RPC reflects server truth, which only
  // changes when data is written; the realtime subscription on each
  // table already triggers a local re-read.
  const [rpcSummary, setRpcSummary] = useState(null)
  const [rpcError, setRpcError] = useState(null)
  const todayKey = todayKeyInZone(tz)

  useEffect(() => {
    if (!hid) {
      setRpcSummary(null)
      setRpcError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await fetchDashboardSummary({
        hospitalId: hid,
        timezone: tz,
        dayKey: todayKey,
      })
      if (cancelled) return
      if (error) {
        setRpcError(error)
        setRpcSummary(null)
      } else {
        setRpcError(null)
        setRpcSummary(data)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hid, tz, todayKey])

  // Refresh the RPC once an hour so the dashboard catches up to
  // server-side changes that arrived through other devices while
  // this tab is idle. Local realtime subscriptions keep the in-memory
  // tables fresh; this is a belt-and-suspenders for when they lapse.
  useEffect(() => {
    if (!hid) return
    const id = setInterval(async () => {
      const { data, error } = await fetchDashboardSummary({
        hospitalId: hid,
        timezone: tz,
        dayKey: todayKeyInZone(tz),
      })
      if (!error) setRpcSummary(data)
    }, 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [hid, tz])

  const data = useMemo(() => {
    const now = new Date()
    const today = todayKeyInZone(tz)
    const isToday = (iso) => !!iso && dayKeyInZone(iso, tz) === today
    const m = { today }

    // Helper: prefer RPC value when present, fall back to local
    // computation only when RPC did not return the key. Uses `??`
    // (nullish) so a legitimate 0 from the RPC survives.
    const pick = (rpcKey, localValue) =>
      rpcSummary && rpcSummary[rpcKey] != null ? rpcSummary[rpcKey] : localValue

    // ---- Patients & queue (patients.queue_status: waiting / in_consultation / discharged)
    const patients = pts.records
    const localTotalPatients = patients.length
    const localRegisteredToday = patients.filter((p) => isToday(p.created_at)).length
    const localWaiting = patients.filter((p) => p.queue_status === 'waiting')
    const localConsult = patients.filter((p) => p.queue_status === 'in_consultation')
    const localQueueDischargedToday = patients.filter(
      (p) => p.queue_status === 'discharged' && isToday(p.queue_updated_at)
    )

    // Scalars: RPC wins when present. Arrays: ALWAYS local — the RPC
    // does not return list-shaped data.
    m.totalPatients = pick('totalPatients', localTotalPatients)
    m.registeredToday = pick('registeredToday', localRegisteredToday)
    m.waitingList = localWaiting // list — LOCAL_ONLY_KEY
    m.consultList = localConsult // list — LOCAL_ONLY_KEY
    m.queueDischargedToday = pick('queueDischargedToday', localQueueDischargedToday.length)
    m.ancCount = pick('ancCount', patients.filter((p) => p.category === 'anc').length)
    m.registrationSeries = dailySeries(patients, (p) => p.created_at, SERIES_DAYS, tz, now)
    // Patient growth = running total of registered patients.
    const registeredInWindow = m.registrationSeries.reduce((sum, pt) => sum + pt.value, 0)
    let runningTotal = m.totalPatients - registeredInWindow
    m.growthSeries = m.registrationSeries.map((pt) => { runningTotal += pt.value; return { key: pt.key, value: runningTotal } })
    const nameById = new Map(patients.map((p) => [p.id, p.full_name || [p.surname, p.other_names].filter(Boolean).join(' ')]))

    // ---- Triage / consultation records (patient_vitals rows are the encounter record)
    m.triageSeries = dailySeries(vitals.records, (v) => v.created_at, SERIES_DAYS, tz, now)
    m.triageToday = vitals.records.filter((v) => isToday(v.created_at)).length

    // ---- Appointments (statuses that exist: scheduled / completed / cancelled)
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

    // ---- Beds & admissions (real beds table; occupancy never guessed from patient counts)
    const bd = beds.records
    m.bedsTotal = pick('bedsTotal', bd.length)
    m.bedsOccupied = pick('bedsOccupied', bd.filter((b) => b.status === 'occupied').length)
    m.bedsAvailable = pick('bedsAvailable', bd.filter((b) => b.status === 'available').length)
    m.bedsCleaning = pick('bedsCleaning', bd.filter((b) => b.status === 'cleaning').length)
    m.bedsReserved = pick('bedsReserved', bd.filter((b) => b.status === 'reserved').length)
    m.occupancyPct = m.bedsTotal > 0 ? Math.round((m.bedsOccupied / m.bedsTotal) * 100) : null
    const activeAdm = adms.records.filter((a) => a.status === 'active')
    m.admittedList = activeAdm.map((a) => ({ id: a.id, name: nameById.get(a.patient_id) || 'Patient', ward: a.ward, at: a.admitted_at })) // list — LOCAL_ONLY_KEY
    m.admittedCount = activeAdm.length
    m.admittedToday = pick('admittedToday', adms.records.filter((a) => isToday(a.admitted_at)).length)
    m.dischargedToday = pick('dischargedToday', adms.records.filter((a) => a.status === 'discharged' && isToday(a.discharge_date)).length)
    m.pendingAdmissionRequests = pick('pendingAdmissionRequests', admReqs.records.filter((r) => r.status === 'pending').length)
    m.admissionSeries = dailySeries(adms.records, (a) => a.admitted_at, SERIES_DAYS, tz, now)
    // Patient census = how many admitted patients were still in hospital at the end of each day.
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

    // ---- Laboratory
    // lab_tests and lab_orders are joined into one stage view. The
    // dashboard must AVOID double-counting: when a lab_tests row and
    // a lab_orders row describe the same investigation (linked by
    // lab_tests.order_id = lab_orders.id), we count the lab_tests row
    // (it carries the actual status). We deduplicate by id; both
    // tables use distinct UUIDs so a simple id-based Map is enough.
    const labsById = new Map()
    for (const t of labTests.records) if (t && t.id && !t.deleted_at) labsById.set(t.id, t)
    for (const o of labOrders.records) {
      if (!o || !o.id || o.deleted_at) continue
      // Only add the lab_orders row if it is not already represented
      // by a lab_tests row pointing at it.
      const hasChild = labTests.records.some((t) => t.order_id === o.id)
      if (!hasChild) labsById.set(o.id, o)
    }
    const labs = Array.from(labsById.values()).filter((t) => labStage(t.status) !== 'cancelled')

    const stageCount = { ordered: 0, sample_collected: 0, processing: 0, completed: 0 }
    labs.forEach((t) => { stageCount[labStage(t.status)] += 1 })
    m.lab = stageCount
    // CRITICAL FIX: was `stageCount.ordered + ... || localFallback` —
    // the `||` collapsed a legitimate 0 to whatever the local
    // fallback computed, hiding "no pending labs today" behind the
    // local count. `??` preserves the RPC zero.
    const localLabPending = stageCount.ordered + stageCount.sample_collected + stageCount.processing
    m.labPending = pick('labPending', localLabPending)
    // Belt-and-suspenders: if the RPC returned 0 but local also
    // computed 0, that's the truth — DO NOT swap in a fallback.
    m.labCompletedToday = pick('labCompletedToday', labs.filter((t) => labStage(t.status) === 'completed' && isToday(t.resulted_at)).length)
    m.labSeries = dailySeries(labs, (t) => t.requested_at || t.created_at, SERIES_DAYS, tz, now)

    // ---- Pharmacy (inventory_items — the table Pharmacy.jsx / Inventory.jsx use)
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
    // CRITICAL FIX: `localStockOut + localStockLow || 0` collapsed
    // a legitimate 0 to 0 (which happened to be right) but on the
    // RPC path the same `||` collapsed a real 0 to the local
    // computation, hiding days with zero alerts. Use `??` so the
    // RPC value always wins.
    const localStockAlerts = localStockOut + localStockLow
    m.stockAlerts = pick('stockAlerts', localStockAlerts)
    m.stockTotal = items.length
    m.stockWatch = items
      .filter((i) => Number(i.quantity || 0) <= Number(i.reorder_level || 0))
      .sort((a, b) => Number(a.quantity || 0) - Number(b.quantity || 0))
      .slice(0, 4)
      .map((i) => ({ id: i.id, name: i.name, qty: Number(i.quantity || 0), reorder: Number(i.reorder_level || 0), unit: i.unit }))

    // ---- Finance (same rules as Billing.jsx: revenue = amount_paid on invoices created today;
    //      outstanding = balance of invoices not paid / cancelled)
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

    // ---- Recent activity (audit_events; only exists for events the app already audits)
    m.activity = [...audit.records]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 8)

    return m
  }, [pts.records, appts.records, vitals.records, beds.records, adms.records, admReqs.records,
      labTests.records, labOrders.records, stock.records, invoices.records, audit.records, tz,
      rpcSummary])

  return { access, data, loading, isOnline, pendingSync, conflictCount, rpcError, tz }
}
