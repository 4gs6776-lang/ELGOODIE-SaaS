// =====================================================================
// GOODIE-MEDHUB — Per-device installation ID
//
// WHY THIS EXISTS
// ----------------
// The backend `sync_cursor` table has a UNIQUE constraint on
// (hospital_id, table_name). That means two devices in the same hospital
// share the same server-side cursor. If device A advances the cursor to
// time T1, then device B comes online and asks "give me rows changed
// since the cursor", the server only returns rows newer than T1 — so
// device B silently misses every change that happened between device
// B's own previous sync and T1.
//
// The fix is to never depend on a shared server cursor. Every browser
// installation gets its OWN UUID, persisted in localStorage. Sync cursors
// are stored locally in IndexedDB keyed by (installationId, hospitalId,
// tableName). Each device tracks where IT left off.
//
// WHY localStorage AND NOT JUST INDEXEDDB
// ----------------------------------------
// IndexedDB cursors live next to the rows they protect, but if the user
// wipes IndexedDB (Clear Site Data, dev tools, the iOS 7-day eviction),
// the cursor MUST also be wiped — otherwise a fresh install would think
// it has already synced and skip the initial pull. Keeping the
// installation ID in a SEPARATE store (localStorage) is intentional:
// the ID can survive an IndexedDB wipe so the device remembers it was
// already bootstrapped, but the cursors (which live in IndexedDB) are
// lost together with the rows, forcing a full re-sync. This is the
// desired behavior.
//
// RECOVERY
// ---------
// If localStorage is also wiped (rare, but possible in private browsing
// or browser-level data clear), we generate a new ID. The next sync
// sees no local cursors and does a full pull. No silent data loss.
// =====================================================================

const STORAGE_KEY = 'gmh.installation.id.v1'
const LEGACY_KEYS = ['gmh.device.id.v1', 'gmh.install.id.v1']

let cached = null

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC4122 v4 fallback for very old browsers / non-secure contexts.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function readFromStorage() {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch (_err) {
    // Safari private mode throws on localStorage access in some cases.
    return null
  }
}

function writeToStorage(id) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch (_err) {
    // Swallow — the in-memory copy still works for this session.
  }
}

function migrateLegacyKeys() {
  if (typeof localStorage === 'undefined') return null
  for (const k of LEGACY_KEYS) {
    try {
      const v = localStorage.getItem(k)
      if (v) {
        // Move to the canonical key and clear the legacy ones so we
        // don't read stale copies next session.
        localStorage.setItem(STORAGE_KEY, v)
        localStorage.removeItem(k)
        return v
      }
    } catch (_err) {
      // ignore — try the next key
    }
  }
  return null
}

export function getInstallationId() {
  if (cached) return cached

  let id = readFromStorage()
  if (!id) id = migrateLegacyKeys()
  if (!id) {
    id = generateId()
    writeToStorage(id)
  }
  cached = id
  return id
}

// Test-only hook: never call from app code.
export function __resetInstallationIdForTests() {
  cached = null
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY)
      LEGACY_KEYS.forEach((k) => {
        try { localStorage.removeItem(k) } catch (_e) { /* noop */ }
      })
    } catch (_err) { /* noop */ }
  }
}
