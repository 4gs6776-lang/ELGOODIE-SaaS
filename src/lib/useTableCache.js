// =====================================================================
// GOODIE-MEDHUB — src/lib/useTableCache.js
//
// Global in-memory cache for useOfflineTable data.
// Prevents 23 components from each loading 'patients' separately.
//
// When the first useOfflineTable('patients', hospitalId) mounts,
// it pulls from Supabase + IndexedDB. When the 22nd component
// mounts with the same table, it gets the cached data instantly
// and subscribes to the same cross-instance change listener.
//
// Cache invalidation:
//   - Any local write (addRecord/updateRecord/deleteRecord) calls
//     notifyLocalChange() which triggers all listeners to re-read
//     from IndexedDB (which is always up-to-date because writes go
//     there first).
//   - Realtime subscriptions (when enabled) call syncFromServer()
//     which updates IndexedDB, then notifies listeners.
//   - The cache is per (tableName, hospitalId) pair.
// =====================================================================

// In-memory cache: { [`${tableName}|${hospitalId}`]: { records, loading, error, timestamp } }
const tableCache = new Map()

// In-flight request tracking: prevents duplicate Supabase fetches
// when multiple components mount simultaneously
const inFlightRequests = new Map()

// Listeners: when a table's data changes, all subscribed components re-read
// Key: `${tableName}|${hospitalId}`, Value: Set of callback functions
const tableListeners = new Map()

// Cache TTL: 30 minutes. After this, the next mount triggers a fresh pull.
// PERFORMANCE: Was 5 minutes, which caused unnecessary re-pulls every
// 5 minutes during a shift — 8-12 full re-pulls per table per shift.
// 30 minutes reduces that to 1-2 re-pulls per table per shift, while
// still keeping data reasonably fresh. Realtime subscriptions still
// push updates immediately, so this only affects the periodic full
// re-pull (which is mostly a safety net for missed realtime events).
const CACHE_TTL_MS = 30 * 60 * 1000

export function getCachedTable(tableName, hospitalId) {
  const key = `${tableName}|${hospitalId}`
  const cached = tableCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    tableCache.delete(key)
    return null
  }
  return cached
}

export function setCachedTable(tableName, hospitalId, records) {
  const key = `${tableName}|${hospitalId}`
  tableCache.set(key, { records, loading: false, error: null, timestamp: Date.now() })
  notifyTableListeners(tableName, hospitalId)
}

export function getCachedLoading(tableName, hospitalId) {
  const key = `${tableName}|${hospitalId}`
  return inFlightRequests.has(key)
}

export async function getOrFetchTable(tableName, hospitalId, fetchFn) {
  const key = `${tableName}|${hospitalId}`

  // Check cache first
  const cached = getCachedTable(tableName, hospitalId)
  if (cached) return cached.records

  // Check if a fetch is already in-flight
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key)  // returns the same promise
  }

  // Start a new fetch
  const promise = fetchFn().then(records => {
    setCachedTable(tableName, hospitalId, records)
    inFlightRequests.delete(key)
    return records
  }).catch(err => {
    inFlightRequests.delete(key)
    throw err
  })

  inFlightRequests.set(key, promise)
  return promise
}

export function invalidateTable(tableName, hospitalId) {
  const key = `${tableName}|${hospitalId}`
  tableCache.delete(key)
  notifyTableListeners(tableName, hospitalId)
}

export function subscribeToTable(tableName, hospitalId, callback) {
  const key = `${tableName}|${hospitalId}`
  if (!tableListeners.has(key)) {
    tableListeners.set(key, new Set())
  }
  tableListeners.get(key).add(callback)
  return () => {
    const listeners = tableListeners.get(key)
    if (listeners) {
      listeners.delete(callback)
      if (listeners.size === 0) tableListeners.delete(key)
    }
  }
}

function notifyTableListeners(tableName, hospitalId) {
  const key = `${tableName}|${hospitalId}`
  const listeners = tableListeners.get(key)
  if (listeners) {
    listeners.forEach(cb => {
      try { cb() } catch (e) { /* non-fatal */ }
    })
  }
}

// Clear all cache (used on logout)
export function clearAllCache() {
  tableCache.clear()
  inFlightRequests.clear()
  tableListeners.clear()
}
