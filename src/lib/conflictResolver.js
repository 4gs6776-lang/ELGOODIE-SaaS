// src/lib/conflictResolver.js
// Field-level conflict resolution helpers.
// Used by the ConflictResolverModal to display side-by-side diffs and
// build the merged payload that gets written back to the server.

// Imports MUST be at the top of the file. ES modules hoist them so
// the previous bottom-of-file import worked, but Vite's
// build-import-analysis plugin + most linters prefer the
// conventional position.
import { supabase } from './supabaseClient';

// ============================================================
// FIELD CATEGISATION
// Different fields need different merge strategies by default.
// ============================================================
export const FIELD_STRATEGIES = {
  // Clinical narrative fields — never auto-resolve, always require human pick.
  clinical: ['diagnosis', 'diagnosis_codes', 'presenting_complaints',
             'assessment', 'plan', 'notes', 'summary', 'follow_up',
             'medication', 'dosage', 'frequency', 'route',
             'allergies', 'vital_signs', 'temperature', 'bp_systolic',
             'bp_diastolic', 'pulse', 'respiratory_rate', 'spo2',
             'weight', 'height', 'bmi'],

  // Status fields — latest writer wins by default (someone closed the visit).
  status: ['status', 'admission_status', 'payment_status', 'fulfillment_status'],

  // Money fields — require human pick (rare; usually only cashier edits).
  money: ['amount', 'amount_paid', 'amount_due', 'unit_price',
          'total_amount', 'discount_amount'],

  // Reference fields — usually stable; pick whichever is non-null.
  reference: ['patient_id', 'doctor_id', 'hospital_id', 'encounter_id',
              'invoice_id', 'admission_id', 'lab_test_id'],

  // Metadata fields — always take server (trigger manages these).
  meta: ['_version', '_last_editor', '_last_synced_at',
         'created_at', 'updated_at', 'created_by', 'deleted_at'],
};

// Reverse lookup: field -> strategy
const FIELD_TO_STRATEGY = (() => {
  const m = new Map();
  for (const [strategy, fields] of Object.entries(FIELD_STRATEGIES)) {
    for (const f of fields) m.set(f, strategy);
  }
  return m;
})();

export function getStrategy(field) {
  return FIELD_TO_STRATEGY.get(field) || 'other';
}

// ============================================================
// DIFF
// Returns the list of fields that differ between client and server rows.
// Excludes metadata + computed columns.
// ============================================================
export function diffRows(clientRow, serverRow) {
  if (!clientRow || !serverRow) return [];
  const allKeys = new Set([
    ...Object.keys(clientRow),
    ...Object.keys(serverRow),
  ]);
  const diffs = [];
  for (const k of allKeys) {
    if (k.startsWith('_')) continue;
    if (['created_at', 'updated_at', 'created_by'].includes(k)) continue;
    const c = clientRow[k];
    const s = serverRow[k];
    // Normalise: arrays vs strings, null vs undefined
    const cN = normalise(c);
    const sN = normalise(s);
    if (JSON.stringify(cN) !== JSON.stringify(sN)) {
      diffs.push({
        field: k,
        strategy: getStrategy(k),
        client: c,
        server: s,
      });
    }
  }
  return diffs;
}

function normalise(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return v;
  return String(v);
}

// ============================================================
// SUGGEST RESOLUTION
// Auto-suggests a per-field choice based on strategy.
// Returns { [field]: 'client' | 'server' | null }
// (null means "user must decide")
// ============================================================
export function suggestResolution(diffs) {
  const decisions = {};
  for (const d of diffs) {
    switch (d.strategy) {
      case 'meta':
        decisions[d.field] = 'server'; // never overwrite server metadata
        break;
      case 'status':
        decisions[d.field] = 'server'; // latest writer wins
        break;
      case 'reference':
        // Pick whichever is non-null
        if (d.client && !d.server) decisions[d.field] = 'client';
        else if (d.server && !d.client) decisions[d.field] = 'server';
        else decisions[d.field] = null; // both have value — user picks
        break;
      case 'money':
        decisions[d.field] = null; // always user-pick
        break;
      case 'clinical':
        decisions[d.field] = null; // always user-pick
        break;
      default:
        // For other fields, default to server (last-write-wins)
        decisions[d.field] = 'server';
    }
  }
  return decisions;
}

// ============================================================
// BUILD MERGED ROW
// Combines client + server using per-field decisions.
// ============================================================
export function buildMergedRow(clientRow, serverRow, decisions) {
  const merged = { ...serverRow }; // start with server as base
  for (const [field, choice] of Object.entries(decisions)) {
    if (choice === 'client') {
      merged[field] = clientRow[field];
    } else if (choice === 'server') {
      merged[field] = serverRow[field];
    } else if (choice === null) {
      // Unresolved — leave server value
      merged[field] = serverRow[field];
    }
    // 'custom' choices are written directly by the modal
  }
  return merged;
}

// ============================================================
// CLASSIFY CONFLICT SEVERITY
// Quick label for the badge in the queue.
// ============================================================
export function classifyConflict(diffs) {
  const clinical = diffs.filter(d => d.strategy === 'clinical').length;
  const money = diffs.filter(d => d.strategy === 'money').length;
  if (clinical > 0) return { level: 'critical', label: 'Clinical conflict' };
  if (money > 0) return { level: 'warning', label: 'Financial conflict' };
  return { level: 'info', label: 'Minor conflict' };
}

// ============================================================
// FORMAT FIELD VALUE FOR DISPLAY
// ---------------------------------------------------------------------
// Returns a PLAIN STRING (never a JSX element) so this file can be
// parsed as plain JavaScript (.js) by Vite / esbuild without a JSX
// loader. The previous version returned `<em>empty</em>` which broke
// the Vite PWA build (vite:build-import-analysis failed at line
// 159:96 because the file is .js, not .jsx). Callers that want
// special styling for the empty placeholder can detect the string
// and wrap it in their own JSX.
// ============================================================
export function formatValue(value) {
  if (value === null || value === undefined) return '— empty —';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (typeof value === 'boolean') return value ? '✓ true' : '✗ false';
  return String(value);
}

// ============================================================
// SUPABASE RPC WRAPPERS
// ============================================================

export async function fetchConflicts(hospitalId, limit = 50) {
  const { data, error } = await supabase.rpc('fetch_pending_conflicts', {
    p_hospital_id: hospitalId,
    p_limit: limit,
  });
  if (error) throw error;
  return data || [];
}

export async function resolveConflict(conflictId, resolution, fieldDecisions, finalData, resolvedBy) {
  const { data, error } = await supabase.rpc('record_conflict_resolution', {
    p_conflict_id: conflictId,
    p_resolution: resolution,
    p_field_decisions: fieldDecisions,
    p_final_data: finalData,
    p_resolved_by: resolvedBy,
  });
  if (error) throw error;
  return data;
}

// ============================================================
// VERSION CHECK HELPER
// Used by the patched useOfflineTable to detect optimistic-lock failures
// BEFORE writing to the queue, so it can pre-record a conflict.
// ============================================================
export function isOptimisticLockError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('version') ||
    msg.includes('concurrent') ||
    msg.includes('conflict') ||
    msg.includes('409') ||
    (error.code && ['409', '23505'].includes(String(error.code)))
  );
}

// ============================================================
// COMPARE VERSIONS
// ============================================================
export function isNewer(clientVersion, serverVersion) {
  return Number(serverVersion || 0) > Number(clientVersion || 0);
}
