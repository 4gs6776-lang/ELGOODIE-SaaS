import { useMemo } from 'react'
import { useOfflineTable } from './useOfflineTable'
import { HMO_PROVIDERS as FALLBACK_PROVIDERS } from './hmoProviders'

// =====================================================================
// useHmoProviders — DB-backed HMO provider list with hardcoded fallback
// =====================================================================
//
// Phase 2: replaces the direct import of HMO_PROVIDERS from hmoProviders.js
// with a hook that reads from the `hmo_providers` database table. This
// lets hospitals manage their own HMO list via Settings (future work).
//
// Behaviour:
//   1. Reads from `hmo_providers` table via useOfflineTable (offline-first).
//   2. Includes system entries (hospital_id IS NULL) + the current
//      hospital's custom entries.
//   3. Falls back to the hardcoded FALLBACK_PROVIDERS constant when:
//      - The DB hasn't loaded yet (loading=true)
//      - The DB returned 0 rows (migration 065 not run yet)
//   4. Merges: DB entries + any hardcoded entries that aren't in the DB
//      (backward compat for hospitals that haven't run migration 065).
//   5. Sorts by sort_order, then by name.
//   6. "Self-Pay (No HMO)" is always first (sort_order=0).
//   7. "Other" is always last (sort_order=999).
//
// Returns:
//   {
//     providers: [{ id, slug, name, type, is_system, is_active, sort_order }],
//     loading: boolean,
//     isFromDb: boolean,  // true if the DB list was used, false if fallback
//   }
//
// Usage:
//   const { providers } = useHmoProviders(hospital?.id)
//   // providers is always an array, even during loading
// =====================================================================

export function useHmoProviders(hospitalId) {
  const { records: dbProviders, loading } = useOfflineTable('hmo_providers', hospitalId)

  return useMemo(() => {
    // Filter to active entries only
    const activeDb = (dbProviders || []).filter(p => p.is_active !== false)

    // If the DB has entries, merge them with the fallback (in case the
    // DB is missing some hardcoded providers — e.g. migration 065 wasn't
    // run, or a hospital deactivated a system entry and has a custom one)
    if (activeDb.length > 0) {
      // Build a set of DB provider names (lowercase) for dedup
      const dbNames = new Set(activeDb.map(p => (p.name || '').toLowerCase().trim()))

      // Add any fallback providers that aren't in the DB (backward compat)
      const extras = FALLBACK_PROVIDERS.filter(fp =>
        !dbNames.has(fp.name.toLowerCase().trim())
      ).map(fp => ({
        id: fp.id,
        slug: fp.id,
        name: fp.name,
        type: fp.type,
        is_system: true,
        is_active: true,
        sort_order: fp.id === 'self-pay' ? 0 : fp.id === 'other' ? 999 : 500,
      }))

      const merged = [...activeDb, ...extras].sort((a, b) => {
        const sa = a.sort_order ?? 500
        const sb = b.sort_order ?? 500
        if (sa !== sb) return sa - sb
        return (a.name || '').localeCompare(b.name || '')
      })

      return { providers: merged, loading, isFromDb: true }
    }

    // Fallback: use the hardcoded list (DB not loaded yet or migration not run)
    const fallback = FALLBACK_PROVIDERS.map(p => ({
      id: p.id,
      slug: p.id,
      name: p.name,
      type: p.type,
      is_system: true,
      is_active: true,
      sort_order: p.id === 'self-pay' ? 0 : p.id === 'other' ? 999 : 500,
    }))

    return { providers: fallback, loading, isFromDb: false }
  }, [dbProviders, loading])
}

// Convenience: returns just the provider names (for backward compat with
// code that expects a plain string array like the old HMO_PROVIDER_NAMES)
export function useHmoProviderNames(hospitalId) {
  const { providers } = useHmoProviders(hospitalId)
  return useMemo(() => providers.map(p => p.name), [providers])
}
