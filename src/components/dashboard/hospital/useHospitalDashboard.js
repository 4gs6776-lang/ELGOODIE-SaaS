import { useMemo, useState, useEffect } from 'react'
import { useOfflineTable } from '../../../lib/useOfflineTable'
import { canAccessModule, FULL_ACCESS_ROLES } from '../../../lib/permissions'
import { getTimezone, dayKeyInZone, todayKeyInZone } from '../../../lib/datetime'
import { labStage } from '../../../lib/lab'
import { fetchDashboardSummary, normalizeSeries } from '../../../lib/dashboardSummary'

// =====================================================================
// GOODIE-MEDHUB — data layer for the hospital overview dashboard.
//
// Rules of this file:
//  * It only READS. It reuses useOfflineTable, so the IndexedDB cache,
//    offline reads and sync keep working exactly as before.
//  * A table is only loaded when the signed-in role may see that area
//    (passing a null hospital id makes useOfflineTable skip the table).
//  * Every number below follows a rule that already exists in the app;
//    the rule's origin is named in a comment next to it.
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
  // PERFORMANCE: Don't block the entire dashboard on the slowest table.
  // The original `loading = all.some(t => t.loading)` was true until
  // ALL 11 tables finished loading — so a slow invoices table (10K rows)
  // blocked the entire dashboard from rendering patient counts.
  //
  // Now: expose `loadingByTable` so each widget can show its own
  // skeleton state independently. The top-level `loading` is kept for
  // backwards compatibility but only blocks the FIRST render (when
  // nothing has loaded yet). After the first table arrives, the
  // dashboard renders with skeleton placeholders for the slow ones.
  const loadingByTable = {
    patients: pts.loading,
    appointments: appts.loading,
    vitals: vitals.loading,
    beds: beds.loading,
    admissions: adms.loading,
    admissionRequests: admReqs.loading,
    labTests: labTests.loading,
    labOrders: labOrders.loading,
    inventory: stock.loading,
    invoices: invoices.loading,
    audit: audit.loading,
  }
  // `loading` is true only when EVERY table is still loading — i.e. we
  // have literally nothing to show yet. As soon as the first table
  // arrives, `loading` becomes false and the dashboard renders with
  // per-widget skeletons for the still-loading tables.
  const loading = all.every((t) => t.loading)
  const isOnline = pts.isOnline
  const pendingSync = pts.pendingCount

  const data = useMemo(() => {
    const now = new Date()
    const today = todayKeyInZone(tz)
    const isToday = (iso) => !!iso && dayKeyInZone(iso, tz) === today
    const m = { today }

    // ---- Patients & queue (patients.queue_status: waiting / in_consultation / discharged)
    const patients = pts.records
    m.totalPatients = patients.length
    m.registeredToday = patients.filter((p) => isToday(p.created_at)).length
    m.waitingList = patients.filter((p) => p.queue_status === 'waiting')
    m.consultList = patients.filter((p) => p.queue_status === 'in_consultation')
    m.queueDischargedToday = patients.filter(
      (p) => p.queue_status === 'discharged' && isToday(p.queue_updated_at)
    )
    m.ancCount = patients.filter((p) => p.category === 'anc').length // same rule as AncPatients.jsx
    m.registrationSeries = dailySeries(patients, (p) => p.created_at, SERIES_DAYS, tz, now)
    // Patient growth = running total of registered patients. Patients registered
    // before the 90-day window form the starting base, so the last point is
    // always the real total shown elsewhere on the dashboard.
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
    m.apptToday = apToday.length
    m.apptScheduledToday = apToday.filter((a) => a.status === 'scheduled').length
    m.apptCompletedToday = apToday.filter((a) => a.status === 'completed').length
    m.apptCancelledToday = apToday.filter((a) => a.status === 'cancelled').length
    m.apptUpcoming = ap
      .filter((a) => a.status === 'scheduled' && new Date(a.appointment_time) >= new Date(now.getTime() - 15 * 60000))
      .sort((a, b) => new Date(a.appointment_time) - new Date(b.appointment_time))
      .slice(0, 6)
    m.apptSeries = dailySeries(ap, (a) => a.appointment_time, SERIES_DAYS, tz, now)

    // ---- Beds & admissions (real beds table; occupancy never guessed from patient counts)
    const bd = beds.records
    m.bedsTotal = bd.length
    m.bedsOccupied = bd.filter((b) => b.status === 'occupied').length
    m.bedsAvailable = bd.filter((b) => b.status === 'available').length
    m.bedsCleaning = bd.filter((b) => b.status === 'cleaning').length
    m.bedsReserved = bd.filter((b) => b.status === 'reserved').length
    m.occupancyPct = m.bedsTotal > 0 ? Math.round((m.bedsOccupied / m.bedsTotal) * 100) : null
    const activeAdm = adms.records.filter((a) => a.status === 'active')
    m.admittedList = activeAdm.map((a) => ({ id: a.id, name: nameById.get(a.patient_id) || 'Patient', ward: a.ward, at: a.admitted_at }))
    m.admittedCount = activeAdm.length
    m.admittedToday = adms.records.filter((a) => isToday(a.admitted_at)).length
    m.dischargedToday = adms.records.filter((a) => a.status === 'discharged' && isToday(a.discharge_date)).length
    m.pendingAdmissionRequests = admReqs.records.filter((r) => r.status === 'pending').length
    m.admissionSeries = dailySeries(adms.records, (a) => a.admitted_at, SERIES_DAYS, tz, now)
    // Patient census = how many admitted patients were still in hospital at the end of each day.
    // A stay counts if it started on/before that day and has not ended by then: it is still 'active',
    // or its discharge_date falls on a later day. Stays that ended without a recorded date are skipped
    // rather than guessed.
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

    // ---- Laboratory (lab_tests + lab_orders, stages from lib/lab.js — same as Laboratory.jsx)
    const labs = [...labTests.records, ...labOrders.records].filter((t) => labStage(t.status) !== 'cancelled')
    const stageCount = { ordered: 0, sample_collected: 0, processing: 0, completed: 0 }
    labs.forEach((t) => { stageCount[labStage(t.status)] += 1 })
    m.lab = stageCount
    m.labPending = stageCount.ordered + stageCount.sample_collected + stageCount.processing
    m.labCompletedToday = labs.filter((t) => labStage(t.status) === 'completed' && isToday(t.resulted_at)).length
    m.labSeries = dailySeries(labs, (t) => t.requested_at || t.created_at, SERIES_DAYS, tz, now)

    // ---- Pharmacy (inventory_items — the table Pharmacy.jsx / Inventory.jsx use)
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const daysToExpiry = (it) => {
      if (!it.expiry_date) return null
      const e = new Date(it.expiry_date); e.setHours(0, 0, 0, 0)
      return (e.getTime() - startOfToday.getTime()) / DAY
    }
    const items = stock.records
    m.stockOut = items.filter((i) => Number(i.quantity || 0) <= 0).length
    m.stockLow = items.filter((i) => Number(i.quantity || 0) > 0 && Number(i.quantity || 0) <= Number(i.reorder_level || 0)).length
    m.stockExpired = items.filter((i) => { const d = daysToExpiry(i); return d !== null && d < 0 }).length
    m.stockExpiring = items.filter((i) => { const d = daysToExpiry(i); return d !== null && d >= 0 && d <= 30 }).length
    m.stockAlerts = m.stockOut + m.stockLow
    m.stockTotal = items.length
    m.stockWatch = items
      .filter((i) => Number(i.quantity || 0) <= Number(i.reorder_level || 0))
      .sort((a, b) => Number(a.quantity || 0) - Number(b.quantity || 0))
      .slice(0, 4)
      .map((i) => ({ id: i.id, name: i.name, qty: Number(i.quantity || 0), reorder: Number(i.reorder_level || 0), unit: i.unit }))

    // ---- Finance (same rules as Billing.jsx: revenue = amount_paid on invoices created today;
    //      outstanding = balance of invoices not paid / cancelled)
    const inv = invoices.records
    m.revenueToday = inv.filter((i) => isToday(i.created_at)).reduce((s, i) => s + Number(i.amount_paid || 0), 0)
    m.outstanding = inv.filter((i) => i.status !== 'paid' && i.status !== 'cancelled').reduce((s, i) => s + Number(i.balance || 0), 0)
    m.outstandingCount = inv.filter((i) => i.status !== 'paid' && i.status !== 'cancelled' && Number(i.balance || 0) > 0).length
    m.invoicesToday = inv.filter((i) => isToday(i.created_at)).length
    m.revenueSeries = dailySum(inv, (i) => i.created_at, (i) => i.amount_paid, SERIES_DAYS, tz, now)

    // ---- Recent activity (audit_events; only exists for events the app already audits)
    m.activity = [...audit.records]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 8)

    return m
  }, [pts.records, appts.records, vitals.records, beds.records, adms.records, admReqs.records,
      labTests.records, labOrders.records, stock.records, invoices.records, audit.records, tz])

  // PERFORMANCE: Server-side aggregation RPC.
  // If the get_dashboard_summary RPC exists (migration 100 applied),
  // fetch all counts/sums in ONE query. This replaces the need to
  // download 11 tables and compute in JS.
  //
  // The RPC data is MERGED with the client-computed data — RPC values
  // take priority when available. If the RPC fails (migration not
  // applied), the client-computed values are used (graceful fallback).
  const [rpcData, setRpcData] = useState(null)
  useEffect(() => {
    if (!hid) return
    let cancelled = false
    fetchDashboardSummary(hid, SERIES_DAYS).then(summary => {
      if (!cancelled && summary) {
        setRpcData(summary)
      }
    })
    return () => { cancelled = true }
  }, [hid])

  // Merge RPC data into the client-computed data.
  // RPC values override client values when available (RPC is more
  // accurate — it queries the DB directly instead of relying on the
  // offline cache which might be stale).
  const mergedData = useMemo(() => {
    if (!rpcData) return data
    return {
      ...data,
      // Counts from RPC (more accurate than client-side filtering)
      totalPatients: rpcData.totalPatients ?? data.totalPatients,
      registeredToday: rpcData.registeredToday ?? data.registeredToday,
      waitingList: data.waitingList,  // keep client-side list (has patient objects)
      consultList: data.consultList,  // keep client-side list (has patient objects)
      queueDischargedToday: rpcData.queueDischargedToday ?? data.queueDischargedToday,
      ancCount: rpcData.ancCount ?? data.ancCount,
      triageToday: rpcData.triageToday ?? data.triageToday,
      apptToday: rpcData.apptToday ?? data.apptToday,
      apptScheduledToday: rpcData.apptScheduledToday ?? data.apptScheduledToday,
      apptCompletedToday: rpcData.apptCompletedToday ?? data.apptCompletedToday,
      apptCancelledToday: rpcData.apptCancelledToday ?? data.apptCancelledToday,
      bedsTotal: rpcData.bedsTotal ?? data.bedsTotal,
      bedsOccupied: rpcData.bedsOccupied ?? data.bedsOccupied,
      bedsAvailable: rpcData.bedsAvailable ?? data.bedsAvailable,
      bedsCleaning: rpcData.bedsCleaning ?? data.bedsCleaning,
      bedsReserved: rpcData.bedsReserved ?? data.bedsReserved,
      admittedCount: rpcData.admittedCount ?? data.admittedCount,
      admittedToday: rpcData.admittedToday ?? data.admittedToday,
      dischargedToday: rpcData.dischargedToday ?? data.dischargedToday,
      pendingAdmissionRequests: rpcData.pendingAdmissionRequests ?? data.pendingAdmissionRequests,
      labPending: (rpcData.labOrdered + rpcData.labSampleCollected + rpcData.labProcessing) || data.labPending,
      labCompletedToday: rpcData.labCompletedToday ?? data.labCompletedToday,
      stockOut: rpcData.stockOut ?? data.stockOut,
      stockLow: rpcData.stockLow ?? data.stockLow,
      stockExpired: rpcData.stockExpired ?? data.stockExpired,
      stockExpiring: rpcData.stockExpiring ?? data.stockExpiring,
      stockTotal: rpcData.stockTotal ?? data.stockTotal,
      stockAlerts: (rpcData.stockOut + rpcData.stockLow) || data.stockAlerts,
      revenueToday: rpcData.revenueToday ?? data.revenueToday,
      outstanding: rpcData.outstanding ?? data.outstanding,
      outstandingCount: rpcData.outstandingCount ?? data.outstandingCount,
      invoicesToday: rpcData.invoicesToday ?? data.invoicesToday,
      // Series from RPC (normalized to [{key, value}] shape)
      registrationSeries: rpcData.registrationSeries ? normalizeSeries(rpcData.registrationSeries) : data.registrationSeries,
      triageSeries: rpcData.triageSeries ? normalizeSeries(rpcData.triageSeries) : data.triageSeries,
      apptSeries: rpcData.apptSeries ? normalizeSeries(rpcData.apptSeries) : data.apptSeries,
      revenueSeries: rpcData.revenueSeries ? normalizeSeries(rpcData.revenueSeries) : data.revenueSeries,
    }
  }, [data, rpcData])

  return { access, data: mergedData, loading, loadingByTable, isOnline, pendingSync, tz }
}
