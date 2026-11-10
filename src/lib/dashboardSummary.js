// src/lib/dashboardSummary.js
//
// Client wrapper for the existing get_dashboard_summary() Supabase RPC.
// Returns all dashboard counts/sums in ONE query instead of downloading
// 11 tables and computing in JavaScript.
//
// The RPC exists in production (migration 100, confirmed by the backend owner).
// It returns a JSON object with ~30 scalar fields (counts, sums).
//
// Fallback: if the RPC fails (network error, function not found, schema
// mismatch), returns null — the caller falls back to client-side computation.

import { supabase } from './supabaseClient'

export async function fetchDashboardSummary(hospitalId, days = 90) {
  if (!hospitalId) return null
  try {
    const { data, error } = await supabase.rpc('get_dashboard_summary', {
      p_hospital_id: hospitalId,
      p_days: days,
    })
    if (error) {
      console.warn('[dashboardSummary] RPC failed, falling back to client-side:', error.message)
      return null
    }
    return data
  } catch (e) {
    console.warn('[dashboardSummary] RPC error:', e.message)
    return null
  }
}
