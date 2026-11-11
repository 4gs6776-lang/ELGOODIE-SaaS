// src/lib/dashboardSummary.js
// Client wrapper for the existing get_dashboard_summary() Supabase RPC.
// Returns null on failure — caller falls back to client-side computation.

import { supabase } from './supabaseClient'

export async function fetchDashboardSummary(hospitalId, days = 90) {
  if (!hospitalId) return null
  try {
    const { data, error } = await supabase.rpc('get_dashboard_summary', {
      p_hospital_id: hospitalId,
      p_days: days,
    })
    if (error) {
      console.warn('[dashboardSummary] RPC failed:', error.message)
      return null
    }
    return data
  } catch (e) {
    console.warn('[dashboardSummary] RPC error:', e.message)
    return null
  }
}
