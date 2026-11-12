// =====================================================================
// GOODIE-MEDHUB — Dashboard summary RPC client
//
// This module is the ONLY place that calls `get_dashboard_summary()`.
// It exists so that:
//
//  * Every screen reads the SAME JSON shape — no drift between
//    Overview / KPI tiles / mobile cards.
//  * We can defend against the RPC being missing, returning an error,
//    or returning a partial shape, WITHOUT making up numbers.
//  * Zero values stay zero. The previous code did
//      `rpc.lab_pending ?? localCount`
//    which is correct, but several call sites used `||` instead,
//    which converted a legitimate 0 to the (much larger) local
//    fallback — a real bug that hid days where nothing was pending.
//
// RPC SCHEMA CONTRACT
// -------------------
// The backend `get_dashboard_summary(p_hospital_id uuid, p_day date,
// p_tz text)` returns a single JSON row. Verified keys (as of the
// backend coordinator's last confirmation) are:
//
//   total_patients            integer
//   registered_today          integer
//   waiting_list              integer
//   in_consultation           integer
//   discharged_today          integer
//   anc_count                 integer
//   appointments_today        integer
//   appt_scheduled_today      integer
//   appt_completed_today     integer
//   appt_cancelled_today      integer
//   beds_total                integer
//   beds_occupied             integer
//   beds_available            integer
//   beds_cleaning             integer
//   beds_reserved             integer
//   admitted_today            integer
//   discharged_today_ipd      integer
//   pending_admission_requests integer
//   lab_pending               integer
//   lab_completed_today       integer
//   stock_out                 integer
//   stock_low                 integer
//   stock_expired             integer
//   stock_expiring            integer
//   stock_alerts              integer
//   revenue_today             numeric
//   outstanding               numeric
//   outstanding_count         integer
//   invoices_today            integer
//
// Array fields that are NOT provided by the RPC (and which the
// dashboard still computes locally) are listed in LOCAL_ONLY_KEYS.
// We never overwrite these with RPC numbers.
//
// If the backend adds new keys, they pass through unchanged. If it
// omits a key we expect, the caller gets `undefined` and the local
// fallback path computes it. We NEVER fabricate a value here.
// =====================================================================

import { supabase } from './supabaseClient'
import { todayKeyInZone } from './datetime'

// Keys that the dashboard derives from local records. The RPC value
// must NEVER replace these — see useHospitalDashboard.js for which
// array fields are still computed client-side.
export const LOCAL_ONLY_KEYS = new Set([
  'waitingList',
  'consultList',
  'apptUpcoming',
  'admittedList',
  'stockWatch',
  'activity',
  'registrationSeries',
  'growthSeries',
  'triageSeries',
  'apptSeries',
  'admissionSeries',
  'censusSeries',
  'labSeries',
  'revenueSeries',
])

// Keys the RPC is expected to return. If any are absent, the local
// computation fills in. We log the missing keys once per session so
// the backend coordinator can be notified.
const EXPECTED_RPC_KEYS = new Set([
  'total_patients',
  'registered_today',
  'waiting_list',
  'in_consultation',
  'discharged_today',
  'anc_count',
  'appointments_today',
  'appt_scheduled_today',
  'appt_completed_today',
  'appt_cancelled_today',
  'beds_total',
  'beds_occupied',
  'beds_available',
  'beds_cleaning',
  'beds_reserved',
  'admitted_today',
  'pending_admission_requests',
  'lab_pending',
  'lab_completed_today',
  'stock_out',
  'stock_low',
  'stock_expired',
  'stock_expiring',
  'stock_alerts',
  'revenue_today',
  'outstanding',
  'outstanding_count',
  'invoices_today',
])

let missingKeyWarnings = new Set()

// Convert snake_case RPC keys to the camelCase keys the dashboard
// uses internally, so the rest of the code does not need to change.
const KEY_MAP = {
  total_patients: 'totalPatients',
  registered_today: 'registeredToday',
  waiting_list: 'waitingList',
  in_consultation: 'consultList',
  discharged_today: 'queueDischargedToday',
  anc_count: 'ancCount',
  appointments_today: 'apptToday',
  appt_scheduled_today: 'apptScheduledToday',
  appt_completed_today: 'apptCompletedToday',
  appt_cancelled_today: 'apptCancelledToday',
  beds_total: 'bedsTotal',
  beds_occupied: 'bedsOccupied',
  beds_available: 'bedsAvailable',
  beds_cleaning: 'bedsCleaning',
  beds_reserved: 'bedsReserved',
  admitted_today: 'admittedToday',
  pending_admission_requests: 'pendingAdmissionRequests',
  lab_pending: 'labPending',
  lab_completed_today: 'labCompletedToday',
  stock_out: 'stockOut',
  stock_low: 'stockLow',
  stock_expired: 'stockExpired',
  stock_expiring: 'stockExpiring',
  stock_alerts: 'stockAlerts',
  revenue_today: 'revenueToday',
  outstanding: 'outstanding',
  outstanding_count: 'outstandingCount',
  invoices_today: 'invoicesToday',
}

// Convert a row from the RPC into the camelCase dashboard shape.
// We only emit keys that are actually present — `undefined` is the
// signal to the caller that the RPC did not provide this value.
function fromRpcShape(row) {
  if (!row || typeof row !== 'object') return {}
  const out = {}
  for (const [snake, camel] of Object.entries(KEY_MAP)) {
    if (row[snake] !== undefined && row[snake] !== null) {
      out[camel] = row[snake]
    } else if (row[snake] === null && EXPECTED_RPC_KEYS.has(snake)) {
      // Null on a column we expect — convert to 0 only if it's a
      // numeric field; never fabricate strings. Numeric fields are
      // the only ones in EXPECTED_RPC_KEYS so this is safe.
      out[camel] = 0
    } else if (row[snake] === undefined && EXPECTED_RPC_KEYS.has(snake)) {
      // Mark missing — surface a one-time warning so the backend
      // coordinator can add the column.
      if (!missingKeyWarnings.has(snake)) {
        missingKeyWarnings.add(snake)
        console.warn(
          `[dashboardSummary] RPC did not return expected key "${snake}". ` +
          `Falling back to local computation. Coordinate with the backend owner.`
        )
      }
    }
  }
  // Pass through any extra keys the RPC may add later (forward-compat).
  for (const [k, v] of Object.entries(row)) {
    if (!KEY_MAP[k] && !k.startsWith('_')) {
      out[k] = v
    }
  }
  return out
}

// Fetch the dashboard summary for a single hospital on a given day.
// `dayKey` defaults to today in the hospital timezone — never UTC.
//
// Returns { data, error }. On error, `data` is null and `error` is
// the original Supabase error object (code/message/details/hint are
// preserved). The caller decides whether to fall back to local
// computation.
export async function fetchDashboardSummary({ hospitalId, timezone, dayKey } = {}) {
  if (!hospitalId) {
    return { data: null, error: null, reason: 'no_hospital' }
  }
  if (!supabase?.rpc) {
    return { data: null, error: null, reason: 'no_client' }
  }

  const tz = timezone || 'Africa/Lagos'
  const day = dayKey || todayKeyInZone(tz)

  try {
    const { data, error } = await supabase.rpc('get_dashboard_summary', {
      p_hospital_id: hospitalId,
      p_day: day,
      p_tz: tz,
    })

    if (error) {
      // FIX: suppress the 404 (RPC not found) after the first
      // occurrence per session. The RPC may not be deployed on
      // every Supabase project — the frontend falls back to local
      // computation, so the 404 is noisy but harmless. Logging it
      // every 5 minutes (the hourly refresh timer) spams the
      // console. We log once, then silently fall back.
      const code = error.code || ''
      const status = error.status || (error.context?.status) || 0
      const isMissingRpc =
        code === 'PGRST202' ||                     // function not found
        code === '42883' ||                        // undefined_function
        status === 404 ||
        /could not find the function|does not exist|not found/i.test(error.message || '')
      if (isMissingRpc) {
        if (!missingKeyWarnings.has('__rpc_missing__')) {
          missingKeyWarnings.add('__rpc_missing__')
          console.info(
            '[dashboardSummary] get_dashboard_summary RPC is not deployed on this Supabase project. ' +
            'Falling back to local computation. This message will not repeat. ' +
            'Coordinate with the backend owner if you want the RPC speed-up.'
          )
        }
        // Return as a soft "empty" so the caller falls back to local
        // computation without surfacing an error to the UI.
        return { data: null, error: null, reason: 'rpc_missing' }
      }
      // Any other error — preserve the original error object.
      return { data: null, error, reason: 'rpc_error' }
    }

    // The RPC may return either a single object or a single-element
    // array, depending on the return shape. Handle both safely.
    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      return { data: null, error: null, reason: 'empty' }
    }
    return { data: fromRpcShape(row), error: null, reason: 'ok' }
  } catch (err) {
    // Network/TypeError — preserve the original error.
    return { data: null, error: err, reason: 'exception' }
  }
}

// Test hook: clear the missing-key warning cache so tests can verify
// the warning fires again.
export function __resetMissingKeyWarningsForTests() {
  missingKeyWarnings = new Set()
}
