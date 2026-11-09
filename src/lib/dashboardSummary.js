// src/lib/dashboardSummary.js
//
// Client wrapper for the get_dashboard_summary() Supabase RPC.
// Returns all dashboard counts/sums in ONE query instead of
// downloading 11 tables and computing in JavaScript.
//
// Created by migration 100_performance_infrastructure.sql.
// Falls back gracefully if the RPC doesn't exist (e.g. migration
// not yet applied) — returns null and the caller uses the old
// useOfflineTable-based computation.

import { supabase } from './supabaseClient'

export async function fetchDashboardSummary(hospitalId, days = 90) {
  if (!hospitalId) return null
  try {
    const { data, error } = await supabase.rpc('get_dashboard_summary', {
      p_hospital_id: hospitalId,
      p_days: days,
    })
    if (error) {
      console.warn('get_dashboard_summary RPC failed, falling back to client-side computation:', error.message)
      return null
    }
    return data
  } catch (e) {
    console.warn('get_dashboard_summary RPC error:', e.message)
    return null
  }
}

// Helper: convert the RPC's series arrays ([[date, count], ...]) into
// the [{ key, value }, ...] shape that useHospitalDashboard uses.
export function normalizeSeries(rpcSeries) {
  if (!Array.isArray(rpcSeries)) return []
  return rpcSeries.map(([key, value]) => ({ key, value: Number(value) || 0 }))
}
