import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react'

import { supabase } from './supabaseClient'
import { assertWriteAllowed } from './subscriptionLock'
import { assertWithinPlanLimit, getEntitlements } from './planEntitlements'
import { getInstallationId } from './installationId'

// =====================================================================
// OFFLINE SYNCHRONIZATION LAYER
// ---------------------------------------------------------------------
// This file is the only place in the app that talks to IndexedDB for
// hospital records and to Supabase for sync. Every rule below was paid
// for by a real data-loss bug; do not relax them without understanding
// why they exist.
// =====================================================================

const DB_NAME = 'HospitalOfflineDB'
// v3 → v4: adds a compound index (table_name, hospital_id, _synced) so
// hospital-scoped pending counts and per-table pulls do not have to
// scan the whole store. v4 also adds the `sync_cursors` and
// `installations` stores. Existing data is preserved: IndexedDB
// upgrades run only the missing createObjectStore / createIndex calls.
const DB_VERSION = 4

const STORE_NAME = 'offline_records'
const CURSOR_STORE = 'sync_cursors'      // keyed by `${installationId}|${hospitalId}|${tableName}`
const META_STORE = 'installations'        // keyed by installationId

// Tables that must NEVER be hard-deleted (clinical history is referenced
// by child rows: vitals, lab orders, prescriptions, invoices...).
// A delete on these becomes an update that stamps deleted_at.
// (Stage 1 cleanup added lab_orders/lab_tests/radiology_scans to the
// clinical-archive set — see rule 16.)
const SOFT_DELETE_TABLES = new Set([
  'patients',
  'lab_orders',
  'lab_tests',
  'radiology_scans',
])

// Parents must reach the server before the children that reference them,
// otherwise an offline-created child (admission request, MAR entry,
// invoice...) dies with a foreign-key violation when the queue flushes
// in random IndexedDB order.
const TABLE_SYNC_ORDER = [
  'patients',
  'profiles',
  'admission_requests',
  'patient_vitals',
  'encounters',
  'prescriptions',
  'pharmacy_requests',
  'pharmacy_orders',
  'medication_administrations',
  'lab_orders',
  'lab_tests',
  'admission_timeline_events',
  'inventory_items',
  'billable_charges',
  'invoices',
  'invoice_items',
  'payments',
  'audit_events',
  'ai_assessments',
]

function tableSyncRank(tableName) {
  const index = TABLE_SYNC_ORDER.indexOf(tableName)
  return index === -1 ? TABLE_SYNC_ORDER.length : index
}

// =====================================================================
// OPEN INDEXED DB
// =====================================================================

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported by this browser.'))
      return
    }

    let settled = false

    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new Error(
          'Could not open the local database — another open tab of this app may be blocking it. Close other tabs/windows running this app and try again.'
        )
      )
    }, 8000)

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = event.target.result
      const oldVersion = event.oldVersion

      // offline_records store (existed since v1)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('table_name', 'table_name', { unique: false })
        store.createIndex('hospital_id', 'hospital_id', { unique: false })
        store.createIndex('synced', '_synced', { unique: false })
        // v4 compound index — speeds up the hospital-scoped pending
        // count and the hospital-scoped reads (the hot path on every
        // dashboard mount).
        store.createIndex('table_hospital_synced', ['table_name', 'hospital_id', '_synced'], {
          unique: false,
        })
      } else if (oldVersion < 4) {
        // Already exists from an older install; just add the compound
        // index. createIndex is idempotent against the name but throws
        // if the name is taken with a different keyPath, so we probe.
        const store = event.target.transaction.objectStore(STORE_NAME)
        if (!store.indexNames.contains('table_hospital_synced')) {
          store.createIndex('table_hospital_synced', ['table_name', 'hospital_id', '_synced'], {
            unique: false,
          })
        }
      }

      // Per-device cursor store (new in v4). Each device tracks its own
      // position per (hospital, table) — see installationId.js for why
      // we never touch the backend shared cursor.
      if (!db.objectStoreNames.contains(CURSOR_STORE)) {
        db.createObjectStore(CURSOR_STORE, { keyPath: 'key' })
      }

      // Per-installation metadata: when did this device first see this
      // hospital? Has it ever completed a full pull for this table?
      // Used to enforce "no incremental sync before a complete initial
      // pull" (requirement 1).
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'installationId' })
      }
    }

    request.onsuccess = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }

    request.onerror = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      reject(request.error)
    }

    request.onblocked = () => {
      console.warn('IndexedDB upgrade blocked. Close other tabs using the app.')
    }
  })
}

// =====================================================================
// UUID GENERATOR
// =====================================================================

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function nowISO() {
  return new Date().toISOString()
}

// =====================================================================
// CLEAN SUPABASE PAYLOAD
// Strips the offline-only underscore fields so a row pulled from
// IndexedDB can be sent straight back to Supabase.
// =====================================================================

function cleanSupabasePayload(record) {
  const {
    table_name,
    _synced,
    _deleted,
    _syncError,
    _syncErrorMessage,
    _syncErrorKind,
    _discarded,
    _discardedAt,
    _conflict,
    _conflictReason,
    _localUpdatedAt,
    ...payload
  } = record
  return payload
}

// =====================================================================
// SCHEMA-GAP TOLERANCE
//
// Some tables in the hosted database are missing columns the app stamps
// on every write (e.g. `updated_at`). PostgREST answers with PGRST204
// ("Could not find the 'x' column of 'y' in the schema cache") and the
// whole record is rejected, jamming the sync queue.
//
// Instead of failing, we remember which columns a table does not have
// and retry the write without them. The memory is per session, so once
// the schema migration runs everything is sent again.
// =====================================================================

const unknownColumnsByTable = new Map()

function getUnknownColumns(tableName) {
  let set = unknownColumnsByTable.get(tableName)
  if (!set) {
    set = new Set()
    unknownColumnsByTable.set(tableName, set)
  }
  return set
}

function stripUnknownColumns(tableName, payload) {
  const unknown = getUnknownColumns(tableName)
  if (unknown.size === 0) return payload
  const next = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!unknown.has(key)) next[key] = value
  }
  return next
}

// "Could not find the 'updated_at' column of 'lab_tests' in the schema cache"
function missingColumnFromError(error) {
  if (!error) return null
  if (error.code && error.code !== 'PGRST204') return null
  const message = error.message || ''
  const match = message.match(/Could not find the '([^']+)' column/i)
  return match ? match[1] : null
}

function isForeignKeyViolation(error) {
  return error?.code === '23503' || /violates foreign key constraint/i.test(error?.message || '')
}

// fetch() failures surface as TypeError("Failed to fetch") with no
// error code — these are the ONLY failures that reliably mean "the
// network was down", and they must never read like a data problem.
const NETWORK_ERROR_RE =
  /failed to fetch|networkerror|load failed|fetch failed|network request failed|err_internet/i

function isNetworkError(error) {
  return NETWORK_ERROR_RE.test(error?.message || '')
}

// Permanent failures must not be retried on every reconnect — they
// need either a schema change or a decision from the user.
function classifyError(error) {
  if (missingColumnFromError(error)) return 'schema'
  if (isForeignKeyViolation(error)) return 'reference'
  if (error?.code === '23505' || /duplicate key value/i.test(error?.message || '')) return 'conflict'
  if (error?.code === '42501' || /row-level security/i.test(error?.message || '')) return 'permission'
  if (isNetworkError(error)) return 'network'
  return 'transient'
}

// Preserve the original Supabase error object so callers can inspect
// code/message/details/hint. The "friendly" message is what the UI
// shows; the structured payload is what gets stored on the record for
// the queue / debug panel. NEVER replace a real error with a generic
// "fetch returned null" string.
function friendlyErrorMessage(error, tableName, op = 'write') {
  const missing = missingColumnFromError(error)
  if (missing) {
    return `The "${tableName}" table in the database has no "${missing}" column yet. Press Retry — the app will resend this change without it.`
  }
  if (isNetworkError(error)) {
    return 'The server could not be reached (offline or unstable connection). This change is safe on this device and will be sent automatically once the connection is stable.'
  }
  if (isForeignKeyViolation(error)) {
    if (op === 'delete') {
      return 'This record is still linked to other records (e.g. vitals, orders or invoices), so it cannot be removed outright. Archive it instead.'
    }
    return 'This record points to another record (e.g. its patient) that the server does not have yet — it may still be syncing from this or another device. It will keep retrying and will sync once that record exists.'
  }
  if (error?.code === '23505' || /duplicate key value/i.test(error?.message || '')) {
    return 'A record with this unique reference already exists on the server. The duplicate is being reconciled automatically — no action needed.'
  }
  return error?.message || 'Synchronization failed'
}

// Structured error snapshot — keeps code, message, details and hint
// exactly as Supabase returned them. Stamped on the record as
// `_syncErrorInfo` so the queue panel can render the real reason
// instead of a paraphrased one.
function captureErrorInfo(error) {
  if (!error) return null
  return {
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
    name: error.name ?? null,
  }
}

// Runs a Supabase write and, if it fails only because a column does
// not exist, drops that column and tries again (repeatedly, if needed).
async function writeWithSchemaRetry(tableName, run, basePayload = {}) {
  let attempt = 0
  while (attempt < 8) {
    attempt += 1
    const { data, error } = await run(stripUnknownColumns(tableName, basePayload))
    if (!error) return { data, error: null }
    const missing = missingColumnFromError(error)
    if (!missing) return { data, error }
    getUnknownColumns(tableName).add(missing)
    console.warn(`Table "${tableName}" has no "${missing}" column — retrying without it.`)
  }
  return {
    data: null,
    error: new Error(`Could not sync to "${tableName}" after removing unknown columns.`),
  }
}

// =====================================================================
// CONFLICT DETECTION
//
// updated_at-only incremental sync detects "server has a newer row",
// but only the local copy AND the server copy both have updated_at.
// If the backend adds an `_version` integer column later, we will
// prefer that (it is monotonic and immune to clock skew). For now we
// compare updated_at timestamps.
//
// CRITICAL: prescriptions, vitals, diagnoses and billing records must
// NEVER be silently overwritten by either side. When a real conflict
// exists (local newer AND remote newer, both unsynced), the local row
// is preserved with _synced=false, _conflict=true, _conflictReason=
// 'remote_newer' and the remote row is staged under a separate id so
// a human can review it. The queue panel surfaces these.
// =====================================================================

const CONFLICT_SENSITIVE_TABLES = new Set([
  'prescriptions',
  'patient_vitals',
  'encounters',
  'invoices',
  'invoice_items',
  'payments',
  'billable_charges',
  'medication_administrations',
  'lab_orders',
  'lab_tests',
  'radiology_scans',
  'admissions',
  'admission_requests',
])

function parseTimestamp(value) {
  if (!value) return 0
  const ms = typeof value === 'number' ? value : new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

// Returns true if the remote row is strictly newer than the local row.
// If either side has no updated_at, we treat it as "no conflict —
// accept remote" so the first pull does not create false conflicts.
function isRemoteNewer(local, remote) {
  const localMs = parseTimestamp(local?.updated_at)
  const remoteMs = parseTimestamp(remote?.updated_at)
  if (!localMs || !remoteMs) return false
  // If both sides have a _version column, prefer it (monotonic).
  if (local?._version != null && remote?._version != null) {
    return Number(remote._version) > Number(local._version)
  }
  return remoteMs > localMs + 1000 // 1s tolerance for clock skew
}

// =====================================================================
// LOCAL CHANGE BROADCAST
//
// Every useOfflineTable() call keeps its OWN copy of the records in
// React state. When another instance (a modal, a child component,
// another page's hook, the sync queue) wrote to IndexedDB, this
// notifies every mounted instance to re-read.
// =====================================================================

const localChangeListeners = new Set()

function notifyLocalChange() {
  localChangeListeners.forEach((listener) => {
    try {
      listener()
    } catch (err) {
      console.error('Local change listener failed:', err)
    }
  })
}

async function putLocalRecord(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(record)
    tx.oncomplete = () => {
      notifyLocalChange()
      resolve(record)
    }
    tx.onerror = () => reject(tx.error)
  })
}

async function getLocalRecord(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

async function getAllLocalRecords(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

// Hospital-scoped read using the compound index. Falls back to the
// full scan if the index is missing (e.g. an old DB version that
// somehow skipped the upgrade).
async function getLocalRecordsFor(db, tableName, hospitalId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    if (store.indexNames.contains('table_hospital_synced')) {
      const idx = store.index('table_hospital_synced')
      // CRITICAL FIX: the compound index keyPath is
      // ['table_name', 'hospital_id', '_synced']. The _synced
      // field is a BOOLEAN (true/false), NOT a number (0/1).
      // IndexedDB does NOT coerce false to 0 — they are different
      // key values. The previous code used
      //   IDBKeyRange.only([tableName, hospitalId, 0])
      // which matched NOTHING because no row has _synced === 0.
      // Rows have _synced === false or _synced === true.
      //
      // We need ALL records for this table+hospital, regardless of
      // sync state, so we use a bounded range that covers both
      // false (sorted as 0) and true (sorted as 1). IDB sorts
      // booleans as 0 < 1, so the range [t, h, 0] .. [t, h, 2]
      // matches both _synced=false and _synced=true rows.
      const req = idx.getAll(IDBKeyRange.bound(
        [tableName, hospitalId, 0],
        [tableName, hospitalId, 2],
        false,
        false
      ))
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    } else {
      // Fallback: full scan + JS filter.
      const req = store.getAll()
      req.onsuccess = () => {
        const out = (req.result || []).filter(
          (r) => r.table_name === tableName && r.hospital_id === hospitalId
        )
        resolve(out)
      }
      req.onerror = () => reject(req.error)
    }
  })
}

async function deleteLocalRecord(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.delete(id)
    tx.oncomplete = () => {
      notifyLocalChange()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

// =====================================================================
// PER-DEVICE CURSORS
//
// One cursor per (installationId, hospitalId, tableName). The cursor
// is the ISO timestamp captured BEFORE the page fetch started, so a
// long page fetched at T0..T1 with rows updated at T0..T1 is correctly
// covered by the next "since" call.
//
// ADVANCEMENT RULES (requirement 1)
//   * capture syncStart = nowISO() before any fetch.
//   * fetch page, persist rows.
//   * ONLY after the page is fully processed AND we have not hit the
//     PULL_MAX_PAGES safety limit, advance the cursor to syncStart.
//   * on any failure (network, error, max pages): DO NOT advance —
//     leave the cursor at its last value, the next sync will re-pull
//     from the same point and the overlap window prevents gaps.
//   * on the FIRST sync for an installation+hospital+table, there is
//     no cursor. We do a full pull and only THEN stamp a cursor.
// =====================================================================

function cursorKey(hospitalId, tableName) {
  const inst = getInstallationId()
  return `${inst}|${hospitalId}|${tableName}`
}

async function getCursor(db, hospitalId, tableName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, 'readonly')
    const store = tx.objectStore(CURSOR_STORE)
    const req = store.get(cursorKey(hospitalId, tableName))
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function setCursor(db, hospitalId, tableName, sinceIso, fullSyncCompletedAt) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, 'readwrite')
    const store = tx.objectStore(CURSOR_STORE)
    const record = {
      key: cursorKey(hospitalId, tableName),
      installationId: getInstallationId(),
      hospitalId,
      tableName,
      since: sinceIso,
      fullSyncCompletedAt: fullSyncCompletedAt || null,
      updatedAt: nowISO(),
    }
    store.put(record)
    tx.oncomplete = () => resolve(record)
    tx.onerror = () => reject(tx.error)
  })
}

async function clearCursor(db, hospitalId, tableName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, 'readwrite')
    const store = tx.objectStore(CURSOR_STORE)
    store.delete(cursorKey(hospitalId, tableName))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// Clear every cursor for a given (installation, hospital). Called on
// hospital switch and on logout so the next login re-pulls from zero.
async function clearAllCursorsForHospital(db, hospitalId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, 'readwrite')
    const store = tx.objectStore(CURSOR_STORE)
    const req = store.openCursor()
    const toDelete = []
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const v = cursor.value
      if (v && v.hospitalId === hospitalId) toDelete.push(v.key)
      cursor.continue()
    }
    tx.oncomplete = async () => {
      // Delete in a second transaction to avoid mutating while the
      // cursor is still open.
      if (toDelete.length === 0) return resolve()
      try {
        const tx2 = db.transaction(CURSOR_STORE, 'readwrite')
        const store2 = tx2.objectStore(CURSOR_STORE)
        toDelete.forEach((k) => store2.delete(k))
        tx2.oncomplete = () => resolve()
        tx2.onerror = () => reject(tx2.error)
      } catch (err) {
        reject(err)
      }
    }
    tx.onerror = () => reject(tx.error)
  })
}

// =====================================================================
// INSTALLATION META — full-sync gate
//
// A new installation must complete ONE full pull of every table
// before incremental sync is allowed. Until then, every sync attempt
// for that table forces a full pull. This guarantees a device that
// lost its IndexedDB (browser eviction) re-bootstraps instead of
// quietly skipping history.
// =====================================================================

async function getInstallationMeta(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const req = store.get(getInstallationId())
    req.onsuccess = () => resolve(req.result || { installationId: getInstallationId(), fullSync: {} })
    req.onerror = () => reject(req.error)
  })
}

async function markTableBootstrapped(db, hospitalId, tableName) {
  const meta = await getInstallationMeta(db)
  if (!meta.fullSync) meta.fullSync = {}
  const key = `${hospitalId}|${tableName}`
  meta.fullSync[key] = { completedAt: nowISO() }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    store.put(meta)
    tx.oncomplete = () => resolve(meta)
    tx.onerror = () => reject(tx.error)
  })
}

async function isTableBootstrapped(db, hospitalId, tableName) {
  const meta = await getInstallationMeta(db)
  const key = `${hospitalId}|${tableName}`
  return Boolean(meta?.fullSync?.[key]?.completedAt)
}

// =====================================================================
// PAGINATION (DETERMINISTIC)
//
// Supabase (PostgREST) returns AT MOST 1000 rows per request by
// default. We read every table in pages of PULL_PAGE_SIZE ordered by
// id ASC so pages never overlap or skip rows.
//
// OVERLAP WINDOW
//   Incremental pulls ask for rows updated_at >= since. To absorb
//   rows that were committed on the server DURING the previous
//   fetch (clock skew, slow commits, replica lag), we subtract
//   OVERLAP_MS from the stored cursor on the way out. This means a
//   few rows may be re-pulled; they are upserted idempotently so
//   this is safe.
//
//   The overlap is 5 minutes. Updated_at on the server is set by
//   a trigger; if a row was visible to the previous pull but its
//   updated_at falls inside the 5-minute window, we re-pull it —
//   the local copy is preserved if it has unsynced local changes
//   (see pullFromSupabase).
//
// MAX PAGES GUARD
//   PULL_MAX_PAGES is a SAFETY VALVE. If we ever reach it, the table
//   has more rows than we expect; we treat that as INCOMPLETE — the
//   cursor is NOT advanced and `bootstrap` is NOT marked complete.
//   The next sync re-runs the pull from the same starting point.
// =====================================================================

const PULL_PAGE_SIZE = 1000
const PULL_MAX_PAGES = 500
const OVERLAP_MS = 5 * 60 * 1000 // 5 minutes

// FULL PULL — every row for the hospital, ordered by id. Returns
// { rows, complete }. `complete` is false if the safety limit was
// hit (we never mark that as a successful bootstrap).
async function fetchAllRemoteRows(tableName, hospitalId) {
  const rows = []
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const from = page * PULL_PAGE_SIZE
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .eq('hospital_id', hospitalId)
      .order('id', { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1)

    if (error) {
      // Preserve the original error so callers can react to code/details/hint.
      return { rows: null, error, complete: false }
    }
    if (!data) {
      return { rows: null, error: null, complete: false }
    }
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) {
      return { rows, error: null, complete: true }
    }
  }
  console.warn(
    `Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit). Cursor will NOT advance.`
  )
  return { rows, error: null, complete: false }
}

// INCREMENTAL PULL — only rows updated_at >= (cursor - overlap).
// Returns { rows, error, complete }. `complete` is false on any
// failure OR if we hit the page safety limit.
//
// FIX: if the table does not have an `updated_at` column, the
// `.gte('updated_at', ...)` and `.order('updated_at')` calls fail
// with code 42703 (undefined_column). We catch that specific error
// and fall back to `fetchAllRemoteRows` (which orders by `id` and
// does not reference `updated_at`). The table is then marked as
// "no-updated_at" so future incremental pulls skip the
// `updated_at` path entirely and always do a full pull.
const tablesWithoutUpdatedAt = new Set()

async function fetchIncrementalRemoteRows(tableName, hospitalId, sinceIso) {
  // If we already know this table has no updated_at, go straight to
  // the full-pull path.
  if (tablesWithoutUpdatedAt.has(tableName)) {
    return fetchAllRemoteRows(tableName, hospitalId)
  }

  const effectiveSince = sinceIso
    ? new Date(Math.max(0, new Date(sinceIso).getTime() - OVERLAP_MS)).toISOString()
    : null

  const rows = []
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const from = page * PULL_PAGE_SIZE
    let query = supabase
      .from(tableName)
      .select('*')
      .eq('hospital_id', hospitalId)
      .order('updated_at', { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1)

    if (effectiveSince) {
      query = query.gte('updated_at', effectiveSince)
    }

    const { data, error } = await query

    if (error) {
      // 42703 = undefined_column. The table does not have
      // `updated_at`. Fall back to a full pull ordered by id.
      if (error.code === '42703' || /updated_at/.test(error.message || '')) {
        console.warn(
          `[sync] Table "${tableName}" has no updated_at column — falling back to full pull (id-ordered). Future pulls will skip the incremental path.`
        )
        tablesWithoutUpdatedAt.add(tableName)
        return fetchAllRemoteRows(tableName, hospitalId)
      }
      return { rows: null, error, complete: false }
    }
    if (!data) {
      return { rows: null, error: null, complete: false }
    }
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) {
      return { rows, error: null, complete: true }
    }
  }
  console.warn(
    `Incremental pull of ${tableName} hit the safety limit of ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows. Cursor will NOT advance.`
  )
  return { rows, error: null, complete: false }
}

// Apply a batch of remote rows to IndexedDB, honoring local unsynced
// writes and conflict-sensitive rules. Returns the number of rows
// actually upserted.
async function mergeRemoteRows(db, remoteRows, tableName, hospitalId) {
  if (!remoteRows || remoteRows.length === 0) return 0

  // Local copies of these specific rows (by id).
  const remoteIds = remoteRows.map((r) => r.id).filter(Boolean)
  const localById = new Map()
  if (remoteIds.length) {
    // Batched get: open one transaction with N gets.
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      let pending = remoteIds.length
      if (pending === 0) return resolve()
      remoteIds.forEach((id) => {
        const r = store.get(id)
        r.onsuccess = () => {
          if (r.result) localById.set(id, r.result)
          pending -= 1
          if (pending === 0) resolve()
        }
        r.onerror = () => {
          pending -= 1
          if (pending === 0) resolve()
        }
      })
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => resolve()
    })
  }

  let upserted = 0
  for (const remote of remoteRows) {
    const local = localById.get(remote.id)

    // 1. Don't overwrite a record that has local changes waiting to sync.
    if (local && local._synced === false) {
      // 2. CONFLICT: local has unsynced changes AND the server has a
      //    newer row. For clinical tables we never silently pick a
      //    winner. We keep the local row (so the user's work is
      //    preserved), stamp _conflict=true with the reason, and
      //    write the remote row under a sibling key
      //    `${id}__remote_${ts}` so the conflict UI can show both
      //    versions side by side.
      if (CONFLICT_SENSITIVE_TABLES.has(tableName) && isRemoteNewer(local, remote)) {
        await putLocalRecord(db, {
          ...local,
          _conflict: true,
          _conflictReason: 'remote_newer',
          _conflictRemoteUpdatedAt: remote.updated_at || null,
          _conflictDetectedAt: nowISO(),
        })
        // Stage the remote copy for review. We do NOT delete the
        // local one — the user must explicitly resolve.
        await putLocalRecord(db, {
          ...remote,
          id: `${remote.id}__remote_${Date.now()}`,
          _originalId: remote.id,
          table_name: tableName,
          hospital_id: hospitalId,
          _synced: true,
          _deleted: Boolean(remote.deleted_at),
          _syncError: false,
          _syncErrorMessage: null,
          _syncErrorKind: null,
          _isRemoteShadow: true,
        })
        continue
      }
      // Non-sensitive table OR remote is not actually newer — keep
      // local, the queue will push it up and the server reconciles.
      continue
    }

    // 3. Tombstone handling. If the backend supports hard deletes via
    //    tombstones (deleted_at present on the row), the row stays in
    //    IndexedDB but is hidden from lists. We DO NOT issue a local
    //    hard delete — that requires a verified tombstone event from
    //    the backend, which is a coordinated change (see
    //    BACKEND_COORDINATION.md). For SOFT_DELETE_TABLES this is
    //    already correct.
    await putLocalRecord(db, {
      ...remote,
      table_name: tableName,
      hospital_id: hospitalId,
      _synced: true,
      _deleted: Boolean(remote.deleted_at),
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _conflict: false,
      _conflictReason: null,
    })
    upserted += 1
  }
  return upserted
}

// =====================================================================
// FULL PULL + CURSOR MANAGEMENT
//
// On the first call for (installation, hospital, table): full pull,
// and only after a complete pull do we stamp the cursor + mark
// bootstrapped.
// On subsequent calls: incremental pull since (cursor - overlap).
// On any failure: cursor and bootstrap flag are LEFT UNCHANGED so
// the next attempt re-runs from the same point.
// =====================================================================

async function pullFromSupabase(db, tableName, hospitalId) {
  if (typeof navigator === 'undefined' || !navigator.onLine) return
  if (!supabase?.from || !hospitalId) return

  // Capture the start time BEFORE any fetch. This becomes the cursor
  // for the next incremental sync. Any row updated on the server
  // during this pull will have updated_at >= syncStart and will be
  // returned by the next pull — that is exactly what we want.
  const syncStart = nowISO()

  const bootstrapped = await isTableBootstrapped(db, hospitalId, tableName)
  const existingCursor = await getCursor(db, hospitalId, tableName)

  // CRITICAL FIX: a sync cursor must NEVER be treated as proof that
  // local records exist. If local records were purged, deleted, or
  // invalidated (e.g. by clearLocalDataOnLogout, a browser data
  // clear, or an IndexedDB eviction), the cursor is stale and must
  // be ignored — we do a FULL pull instead of an incremental one.
  //
  // We verify the local baseline by checking that at least one row
  // exists in IndexedDB for this table+hospital. If zero rows
  // exist, we treat the table as not-bootstrapped regardless of the
  // cursor's state.
  let localBaselineExists = false
  if (bootstrapped && existingCursor?.since) {
    try {
      const localRows = await getLocalRecordsFor(db, tableName, hospitalId)
      localBaselineExists = localRows.length > 0
    } catch (_err) {
      // If the check itself fails, be safe and do a full pull.
      localBaselineExists = false
    }
    if (!localBaselineExists) {
      console.warn(
        `[sync] ${tableName}: cursor says bootstrapped but 0 local rows found — forcing full pull.`
      )
      // Clear the stale bootstrap flag + cursor so the full pull
      // path is taken and the cursor is re-stamped after success.
      try {
        await clearCursor(db, hospitalId, tableName)
        const meta = await getInstallationMeta(db)
        if (meta?.fullSync) {
          const key = `${hospitalId}|${tableName}`
          delete meta.fullSync[key]
          await new Promise((resolve, reject) => {
            const tx2 = db.transaction(META_STORE, 'readwrite')
            const store2 = tx2.objectStore(META_STORE)
            store2.put(meta)
            tx2.oncomplete = () => resolve()
            tx2.onerror = () => reject(tx2.error)
          })
        }
      } catch (clearErr) {
        console.error('Could not clear stale cursor:', clearErr)
      }
    }
  }

  let result
  if (!bootstrapped || !existingCursor?.since || !localBaselineExists) {
    // FULL SYNC: first sync for this device+hospital+table, OR
    // local baseline is missing despite the cursor claiming
    // bootstrapped. A full pull re-downloads every row.
    result = await fetchAllRemoteRows(tableName, hospitalId)
  } else {
    // Incremental.
    result = await fetchIncrementalRemoteRows(tableName, hospitalId, existingCursor.since)
  }

  const { rows, error, complete } = result

  if (error) {
    // Preserve the original Supabase error object. Do NOT replace it
    // with a generic "fetch returned null" string.
    console.error(`Pull of ${tableName} failed (code=${error.code || 'n/a'}):`, error)
    return
  }

  if (!rows) {
    // No data and no error — treat as incomplete, do NOT advance cursor.
    console.warn(`Pull of ${tableName} returned no rows and no error; treating as incomplete.`)
    return
  }

  try {
    await mergeRemoteRows(db, rows, tableName, hospitalId)
  } catch (mergeErr) {
    console.error(`Merge failed for ${tableName}:`, mergeErr)
    // Do NOT advance the cursor — the next sync will retry.
    return
  }

  // Only advance the cursor if the pull was complete. If we hit
  // PULL_MAX_PAGES the cursor stays where it was so the next run
  // re-pulls from the same starting point and we eventually catch up.
  if (!complete) {
    console.warn(`Pull of ${tableName} was incomplete; cursor will not advance.`)
    return
  }

  // If this was the bootstrap pull, mark it complete FIRST so even
  // if a later step fails we know the full pull succeeded.
  if (!bootstrapped) {
    await markTableBootstrapped(db, hospitalId, tableName)
  }
  await setCursor(db, hospitalId, tableName, syncStart, bootstrapped ? existingCursor?.fullSyncCompletedAt : syncStart)
}

// Force a fresh full pull on the next sync — used by the "Re-sync" UI.
export async function resetTableCursor(tableName, hospitalId) {
  try {
    const db = await openDB()
    await clearCursor(db, hospitalId, tableName)
    // Also clear the bootstrap flag so the next pull is treated as a
    // first-time full pull.
    const meta = await getInstallationMeta(db)
    if (meta?.fullSync) {
      const key = `${hospitalId}|${tableName}`
      delete meta.fullSync[key]
      await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite')
        const store = tx.objectStore(META_STORE)
        store.put(meta)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }
  } catch (err) {
    console.error('Could not reset table cursor:', err)
  }
}

// =====================================================================
// MAIN HOOK
// =====================================================================

export function useOfflineTable(tableName, hospitalId, options = {}) {
  const { realtime = false } = options
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : false)
  const [pendingCount, setPendingCount] = useState(0)
  const [conflictCount, setConflictCount] = useState(0)
  const [loadError, setLoadError] = useState(null)
  // FIX: new state to distinguish "successfully loaded 0 patients"
  // from "still loading" / "error" / "offline". The UI uses this
  // to show the right message instead of always showing "No
  // patients found".
  const [syncState, setSyncState] = useState('idle') // 'idle' | 'loading' | 'success' | 'error' | 'offline' | 'partial'
  // Mirror of pendingCount for use inside timers (state captured in a
  // setInterval closure would be frozen at mount time).
  const pendingCountRef = useRef(0)
  // Guards against an older, slower read finishing AFTER a newer one
  // and overwriting fresh data.
  const loadSeqRef = useRef(0)
  // Latest hospitalId used by the flush timer — if it changes (hospital
  // switch), we cancel pending flushes for the old hospital.
  const hospitalIdRef = useRef(hospitalId)

  const loadLocalRecords = useCallback(async () => {
    if (!hospitalId) {
      // Empty state for null hospital — never leak another hospital's
      // rows into the new context. This is the OWNER-without-hospital
      // case: the UI should prompt the owner to select a hospital,
      // NOT show "No patients found".
      setRecords([])
      setPendingCount(0)
      setConflictCount(0)
      pendingCountRef.current = 0
      setLoading(false)
      setSyncState('idle')
      return
    }

    const seq = ++loadSeqRef.current
    try {
      const db = await openDB()

      // Hospital-scoped read using the compound index when present
      // (DB v4+). Falls back to a full scan otherwise.
      let scopedRows
      try {
        scopedRows = await getLocalRecordsFor(db, tableName, hospitalId)
      } catch (_err) {
        // Index not available — fall back.
        scopedRows = (await getAllLocalRecords(db)).filter(
          (r) => r.table_name === tableName && r.hospital_id === hospitalId
        )
      }

      if (seq !== loadSeqRef.current) return // a newer read superseded this one

      const filtered = scopedRows.filter(
        (record) => !record._deleted && !record.deleted_at && !record._isRemoteShadow
      )
      setRecords(filtered)

      // Pending count is HOSPITAL-SCOPED. We never let another
      // hospital's unsynced rows show up in this counter — that
      // would be a silent cross-tenant leak.
      const pending = scopedRows.filter(
        (record) => record._synced === false && record._discarded !== true && !record._isRemoteShadow
      )
      setPendingCount(pending.length)
      pendingCountRef.current = pending.length

      const conflicts = scopedRows.filter(
        (record) => record._conflict === true && record._discarded !== true
      )
      setConflictCount(conflicts.length)

      setLoadError(null)
      setLoading(false)
      // FIX: set syncState so the UI can distinguish "successfully
      // loaded 0 patients" from "still loading" / "error".
      setSyncState(prev => prev === 'loading' ? 'success' : prev)
    } catch (error) {
      console.error('Error reading offline records:', error)
      setLoadError(error?.message || 'Could not read local data')
      setLoading(false)
      setSyncState('error')
    }
  }, [tableName, hospitalId])

  // Detect hospital switching: if hospitalId changes, clear cursors
  // for the old hospital so the next login re-pulls. This prevents a
  // device that previously cached hospital A from skipping rows added
  // to hospital A while the user was logged into hospital B (e.g. a
  // multi-hospital admin).
  useEffect(() => {
    const previous = hospitalIdRef.current
    hospitalIdRef.current = hospitalId
    if (previous && previous !== hospitalId) {
      ;(async () => {
        try {
          const db = await openDB()
          await clearAllCursorsForHospital(db, previous)
        } catch (err) {
          console.error('Could not clear cursors on hospital switch:', err)
        }
      })()
    }
  }, [hospitalId])

  useEffect(() => {
    let cancelled = false

    async function initialLoad() {
      if (hospitalId) {
        setSyncState('loading')
        setLoading(true)
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
        } catch (err) {
          console.error('Error opening DB for initial pull:', err)
          setLoadError(err?.message || 'Could not sync from server')
          setSyncState('error')
        }
      } else {
        // No hospital context (e.g. owner without a selected hospital).
        // Stay in 'idle' state — the UI should prompt for hospital
        // selection, not show "No patients found".
        setSyncState('idle')
      }
      if (!cancelled) await loadLocalRecords()
    }

    initialLoad().then(() => {
      // Flush on app load. Until now the queue only retried on
      // online/offline events, so reloading the tab while online
      // left transient failures (e.g. "Failed to fetch") stuck in
      // the panel forever with no automatic way out.
      if (typeof navigator !== 'undefined' && navigator.onLine && hospitalId) {
        flushTableQueue(tableName)
      }
    })

    // Safety net: while this table has unsynced records, retry quietly
    // every minute so transient failures self-heal without waiting for
    // a reconnect event.
    const retryTimer = setInterval(() => {
      if (pendingCountRef.current > 0 && typeof navigator !== 'undefined' && navigator.onLine && hospitalId) {
        flushTableQueue(tableName)
      }
    }, 60000)

    const handleOnline = async () => {
      setIsOnline(true)
      if (hospitalId) {
        setSyncState('loading')
        await flushTableQueue(tableName)
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
        } catch (err) {
          console.error('Error opening DB for reconnect pull:', err)
          setLoadError(err?.message || 'Could not sync from server')
          setSyncState('error')
        }
      }
      await loadLocalRecords()
    }

    const handleOffline = () => {
      setIsOnline(false)
      // FIX: set syncState to 'offline' so the UI can show "You are
      // offline — showing cached data" instead of "No patients found".
      setSyncState(prev => (prev === 'success' || prev === 'idle') ? 'offline' : prev)
    }

    // FIX: listen for the 'gmh:session-cleared' event (dispatched by
    // clearLocalDataOnLogout) so the in-memory `records` state resets
    // to [] immediately. Without this, the React state retains the
    // previous user's patient list in memory even after IndexedDB
    // is cleared — the next user would briefly see the previous
    // user's data until the next pull completes.
    const handleSessionCleared = () => {
      setRecords([])
      setPendingCount(0)
      setConflictCount(0)
      pendingCountRef.current = 0
      setLoading(true)
      setLoadError(null)
      setSyncState('idle')
      // Bump the sequence so any in-flight reads are discarded.
      loadSeqRef.current += 1
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('gmh:session-cleared', handleSessionCleared)

    return () => {
      cancelled = true
      clearInterval(retryTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('gmh:session-cleared', handleSessionCleared)
    }
  }, [loadLocalRecords, tableName, hospitalId])

  // Keep this instance in step with writes made by ANY other
  // instance. Debounced so a burst (a pull writing hundreds of rows,
  // a queue flush) causes one re-read instead of hundreds.
  useEffect(() => {
    if (!hospitalId) return

    let timer = null
    let active = true
    const onLocalChange = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (active) loadLocalRecords()
      }, 50)
    }

    localChangeListeners.add(onLocalChange)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      localChangeListeners.delete(onLocalChange)
    }
  }, [hospitalId, loadLocalRecords])

  // Opt-in live sync: when another device/tab inserts, updates or
  // deletes a row in this table for the same hospital, pull it down
  // and merge it into local state — no manual refresh needed. Off
  // by default so every existing caller of this hook keeps its
  // current behavior untouched; pass { realtime: true } as the 3rd
  // argument to turn it on.
  useEffect(() => {
    if (!realtime || !hospitalId) return

    let cancelled = false
    let debounceId = null

    const refreshFromServer = () => {
      if (debounceId) clearTimeout(debounceId)
      debounceId = setTimeout(async () => {
        if (cancelled) return
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
          if (!cancelled) await loadLocalRecords()
        } catch (err) {
          console.error(`Error live-syncing ${tableName}:`, err)
        }
      }, 300)
    }

    const channelName = `live-${tableName}-${hospitalId}-${Math.random().toString(36).slice(2)}`
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: tableName, filter: `hospital_id=eq.${hospitalId}` },
        () => refreshFromServer()
      )
      .subscribe()

    return () => {
      cancelled = true
      if (debounceId) clearTimeout(debounceId)
      supabase.removeChannel(channel)
    }
  }, [realtime, tableName, hospitalId, loadLocalRecords])

  const addRecord = async (data) => {
    // Expired/suspended hospital? Refuse BEFORE anything is saved.
    assertWriteAllowed(tableName, 'add')
    if (!hospitalId) throw new Error('Hospital ID is required.')

    // Plan limit: refuse a NEW patient once the plan's max is reached.
    if (tableName === 'patients') {
      const countDb = await openDB()
      const localRows = await getLocalRecordsFor(countDb, 'patients', hospitalId)
      const localCount = localRows.filter((r) => !r._deleted && !r.deleted_at).length
      const serverCount = getEntitlements().usage?.patients ?? 0
      assertWithinPlanLimit('patients', Math.max(localCount, serverCount))
    }

    const timestamp = nowISO()
    const id = data.id || generateUUID()

    const newRecord = {
      ...data,
      id,
      table_name: tableName,
      hospital_id: hospitalId,
      created_at: data.created_at || timestamp,
      updated_at: timestamp,
      _localUpdatedAt: timestamp,
      _synced: false,
      _deleted: false,
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _syncErrorInfo: null,
      _conflict: false,
      _conflictReason: null,
    }

    const db = await openDB()
    await putLocalRecord(db, newRecord)
    await loadLocalRecords()

    if (typeof navigator !== 'undefined' && navigator.onLine && supabase?.from) {
      const basePayload = cleanSupabasePayload(newRecord)
      try {
        const { data: remoteData, error } = await writeWithSchemaRetry(
          tableName,
          (payload) => supabase.from(tableName).insert([payload]).select().single(),
          basePayload
        )

        if (error) throw error

        if (remoteData) {
          const syncedRecord = {
            ...remoteData,
            table_name: tableName,
            hospital_id: hospitalId,
            _synced: true,
            _deleted: false,
            _syncError: false,
            _syncErrorMessage: null,
            _syncErrorKind: null,
            _syncErrorInfo: null,
            _conflict: false,
            _conflictReason: null,
          }
          await putLocalRecord(db, syncedRecord)
        }
      } catch (error) {
        console.error('Supabase insert failed:', error)
        await putLocalRecord(db, {
          ...newRecord,
          _synced: false,
          _syncError: true,
          _syncErrorKind: classifyError(error),
          _syncErrorMessage: friendlyErrorMessage(error, tableName),
          _syncErrorInfo: captureErrorInfo(error),
        })
        await loadLocalRecords()
        // Re-throw with the original error attached so callers can
        // inspect code/details/hint — never wrap it into a generic
        // "fetch returned null" message.
        const wrapped = new Error(friendlyErrorMessage(error, tableName))
        wrapped.cause = error
        wrapped.code = error?.code
        wrapped.details = error?.details
        wrapped.hint = error?.hint
        throw wrapped
      }
    }

    await loadLocalRecords()
    return newRecord
  }

  const updateRecord = async (id, updates) => {
    assertWriteAllowed(tableName, 'update', updates)
    const db = await openDB()
    const existing = await getLocalRecord(db, id)

    if (!existing) {
      throw new Error('Record was not found locally.')
    }

    const timestamp = nowISO()
    const updatedRecord = {
      ...existing,
      ...updates,
      id,
      table_name: tableName,
      hospital_id: existing.hospital_id || hospitalId,
      updated_at: timestamp,
      _localUpdatedAt: timestamp,
      _synced: false,
      _deleted: Boolean(updates?.deleted_at ?? existing.deleted_at),
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _syncErrorInfo: null,
      _discarded: false,
      _conflict: false,
      _conflictReason: null,
    }

    await putLocalRecord(db, updatedRecord)
    await loadLocalRecords()

    if (typeof navigator !== 'undefined' && navigator.onLine && supabase?.from) {
      const { id: _payloadId, ...updatePayload } = cleanSupabasePayload(updatedRecord)
      try {
        const { data: remoteData, error } = await writeWithSchemaRetry(
          tableName,
          (payload) => supabase.from(tableName).update(payload).eq('id', id).select().single(),
          updatePayload
        )

        // PGRST116 means 0 rows returned: the item is local-only.
        // Keep _synced = false so the queue picks it up later.
        if (error && error.code !== 'PGRST116') {
          throw error
        }

        await putLocalRecord(db, {
          ...(remoteData || updatedRecord),
          table_name: tableName,
          hospital_id: existing.hospital_id || hospitalId,
          _synced: Boolean(remoteData),
          _deleted: Boolean((remoteData || updatedRecord).deleted_at),
          _syncError: false,
          _syncErrorMessage: null,
          _syncErrorKind: null,
          _syncErrorInfo: null,
          _conflict: false,
          _conflictReason: null,
        })
      } catch (error) {
        console.error('Supabase update failed:', error)
        await putLocalRecord(db, {
          ...updatedRecord,
          _synced: false,
          _syncError: true,
          _syncErrorKind: classifyError(error),
          _syncErrorMessage: friendlyErrorMessage(error, tableName),
          _syncErrorInfo: captureErrorInfo(error),
        })
        await loadLocalRecords()
        const wrapped = new Error(friendlyErrorMessage(error, tableName))
        wrapped.cause = error
        wrapped.code = error?.code
        wrapped.details = error?.details
        wrapped.hint = error?.hint
        throw wrapped
      }
    }

    await loadLocalRecords()
    return updatedRecord
  }

  const deleteRecord = async (id) => {
    assertWriteAllowed(tableName, 'delete')
    if (SOFT_DELETE_TABLES.has(tableName)) {
      return updateRecord(id, { deleted_at: nowISO() })
    }

    const db = await openDB()
    const existing = await getLocalRecord(db, id)

    if (!existing) return

    const deletedRecord = {
      ...existing,
      _deleted: true,
      _synced: false,
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _syncErrorInfo: null,
      _discarded: false,
      updated_at: nowISO(),
    }

    await putLocalRecord(db, deletedRecord)
    await loadLocalRecords()

    if (typeof navigator !== 'undefined' && navigator.onLine && supabase?.from) {
      try {
        const { error } = await supabase.from(tableName).delete().eq('id', id)
        if (error) throw error
        await deleteLocalRecord(db, id)
      } catch (error) {
        console.error('Supabase delete failed:', error)
        await putLocalRecord(db, {
          ...deletedRecord,
          _syncError: true,
          _syncErrorKind: classifyError(error),
          _syncErrorMessage: friendlyErrorMessage(error, tableName, 'delete'),
          _syncErrorInfo: captureErrorInfo(error),
        })
        await loadLocalRecords()
        const wrapped = new Error(friendlyErrorMessage(error, tableName, 'delete'))
        wrapped.cause = error
        wrapped.code = error?.code
        wrapped.details = error?.details
        wrapped.hint = error?.hint
        throw wrapped
      }
    }

    await loadLocalRecords()
  }

  const syncFromServer = async () => {
    if (!hospitalId) return
    try {
      const db = await openDB()
      await pullFromSupabase(db, tableName, hospitalId)
      await loadLocalRecords()
    } catch (err) {
      console.error(`Error manually syncing ${tableName} from server:`, err)
    }
  }

  // FIX: retry function — re-runs the full sync + local read. Used
  // by the UI's "Retry" button when a sync error or incomplete sync
  // is shown.
  const retry = useCallback(async () => {
    if (!hospitalId) return
    setSyncState('loading')
    setLoading(true)
    setLoadError(null)
    try {
      const db = await openDB()
      await pullFromSupabase(db, tableName, hospitalId)
    } catch (err) {
      console.error('Retry sync failed:', err)
      setLoadError(err?.message || 'Could not sync from server')
      setSyncState('error')
      setLoading(false)
      return
    }
    await loadLocalRecords()
  }, [tableName, hospitalId, loadLocalRecords])

  return {
    records,
    loading,
    loadError,
    isOnline,
    pendingCount,
    conflictCount,
    // FIX: new state — distinguishes "loading" / "success" / "error" /
    // "offline" / "idle" so the UI can show the right message.
    syncState,
    // FIX: retry function — re-runs the sync + local read.
    retry,
    addRecord,
    updateRecord,
    deleteRecord,
    refreshTable: loadLocalRecords,
    syncFromServer,
  }
}

// =====================================================================
// GET ALL SYNC ERRORS
// Returns the full list for the sync panel. Hospital-scoped via the
// caller (HospitalDashboard passes hospitalId into the filter).
// =====================================================================

export async function getAllSyncErrors(hospitalId = null) {
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    return all.filter((record) => {
      if (record._syncError !== true) return false
      if (record._discarded === true) return false
      if (record._isRemoteShadow === true) return false
      // Hospital scoping: if a hospitalId is provided, never return
      // another hospital's records (cross-tenant leak guard).
      if (hospitalId && record.hospital_id !== hospitalId) return false
      return true
    })
  } catch (error) {
    console.error('Could not get sync errors:', error)
    return []
  }
}

// =====================================================================
// SUBSCRIBE TO SYNC ERRORS
// =====================================================================

export function subscribeSyncErrors(callback, hospitalId = null) {
  const handler = async () => {
    if (typeof callback !== 'function') return
    const errors = await getAllSyncErrors(hospitalId)
    callback(errors)
  }

  handler() // Run immediately

  window.addEventListener('online', handler)
  window.addEventListener('offline', handler)
  localChangeListeners.add(handler)

  return () => {
    window.removeEventListener('online', handler)
    window.removeEventListener('offline', handler)
    localChangeListeners.delete(handler)
  }
}

// =====================================================================
// FLUSH OFFLINE QUEUE
//
// `force` retries items that previously failed with a permanent
// error (missing column, foreign-key conflict). Automatic flushes on
// reconnect skip those so the queue stops hammering the database
// with writes that cannot succeed until the schema is fixed.
// =====================================================================

export async function flushTableQueue(tableName = null, { force = false } = {}) {
  if (typeof navigator === 'undefined' || !navigator.onLine || !supabase?.from) return

  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)

    const pending = all.filter((record) => {
      if (record._synced !== false) return false
      if (record._discarded === true) return false
      if (record._isRemoteShadow === true) return false
      if (tableName && record.table_name !== tableName) return false
      // Never auto-flush conflict-stuck rows — they require explicit
      // resolution by the user. The queue panel offers a "Resolve"
      // button which calls resolveConflict().
      if (record._conflict === true && !force) return false
      // Schema-gap items stay held only until this session has
      // learned the table's missing columns — after that
      // writeWithSchemaRetry heals the write inline, so automatic
      // retries are safe again.
      if (
        !force &&
        record._syncErrorKind === 'schema' &&
        (unknownColumnsByTable.get(record.table_name)?.size || 0) === 0
      ) {
        return false
      }
      return true
    })

    // Parents before children: a patient created offline must reach
    // the server before the admission request / vitals / invoice that
    // points at it, or the child write dies with a foreign-key
    // violation.
    pending.sort((a, b) => {
      const rankGap = tableSyncRank(a.table_name) - tableSyncRank(b.table_name)
      if (rankGap !== 0) return rankGap
      return String(a.created_at || '').localeCompare(String(b.created_at || ''))
    })

    for (const record of pending) {
      let op = 'write'
      try {
        const isSoftDeleteTable = SOFT_DELETE_TABLES.has(record.table_name)

        if (record._deleted && !isSoftDeleteTable && !record.deleted_at) {
          op = 'delete'
          const { error } = await supabase.from(record.table_name).delete().eq('id', record.id)
          if (error) throw error
          await deleteLocalRecord(db, record.id)
          continue
        }

        // Soft-deleted rows sync as a normal upsert carrying deleted_at.
        const payload = cleanSupabasePayload(
          record._deleted && isSoftDeleteTable && !record.deleted_at
            ? { ...record, deleted_at: nowISO() }
            : record
        )

        const { data: remoteData, error } = await writeWithSchemaRetry(
          record.table_name,
          (body) => supabase.from(record.table_name).upsert(body, { onConflict: 'id' }).select().single(),
          payload
        )

        if (error) throw error

        await putLocalRecord(db, {
          ...(remoteData || record),
          table_name: record.table_name,
          hospital_id: record.hospital_id,
          _synced: true,
          _deleted: Boolean((remoteData || record).deleted_at),
          _syncError: false,
          _syncErrorMessage: null,
          _syncErrorKind: null,
          _syncErrorInfo: null,
          _conflict: false,
          _conflictReason: null,
        })
      } catch (error) {
        const kind = classifyError(error)
        console.error(`Failed to sync ${record.id} (${kind}):`, error)

        // Unique-conflict reconciliation: billable_charges carries a
        // second unique key (unique_source_transaction) the id-upsert
        // cannot cover. If the same charge already exists on the
        // server under a different local id, adopt the server row
        // and retire the local one.
        if (
          kind === 'conflict' &&
          record.table_name === 'billable_charges' &&
          record.source_transaction_id
        ) {
          try {
            let twinQuery = supabase
              .from('billable_charges')
              .select('*')
              .eq('source_transaction_id', record.source_transaction_id)
              .limit(1)
            if (record.source_module) twinQuery = twinQuery.eq('source_module', record.source_module)
            const { data: twins } = await twinQuery
            if (Array.isArray(twins) && twins[0]) {
              await putLocalRecord(db, {
                ...twins[0],
                table_name: record.table_name,
                hospital_id: record.hospital_id,
                _synced: true,
                _deleted: Boolean(twins[0].deleted_at),
                _syncError: false,
                _syncErrorMessage: null,
                _syncErrorKind: null,
                _syncErrorInfo: null,
                _discarded: false,
                _conflict: false,
                _conflictReason: null,
              })
              continue
            }
          } catch (reconcileErr) {
            console.error('Conflict reconciliation lookup failed:', reconcileErr)
          }
        }

        await putLocalRecord(db, {
          ...record,
          _synced: false,
          _syncError: true,
          _syncErrorKind: kind,
          _syncErrorMessage: friendlyErrorMessage(error, record.table_name, op),
          _syncErrorInfo: captureErrorInfo(error),
        })
      }
    }
  } catch (error) {
    console.error('Error flushing offline queue:', error)
  }
}

// Explicit "Retry" button: ignores the permanent-error hold.
export async function retryTableQueue(tableName = null) {
  unknownColumnsByTable.clear()
  return flushTableQueue(tableName, { force: true })
}

// =====================================================================
// CONFLICT RESOLUTION — explicit, never automatic for clinical rows.
//
// resolveConflictAcceptLocal  — re-queue the local row for upload,
//   discarding the remote shadow. Use when the clinician confirms the
//   local edit is authoritative.
// resolveConflictAcceptRemote — replace the local row with the remote
//   one, deleting the local copy. The local version is gone for good,
//   so we also stamp an audit entry on the conflict log.
//
// Both functions leave a record in the offline store under id
// `${originalId}__conflict_resolved_${ts}` for auditability — the
// audit_events table itself is synced normally.
// =====================================================================

export async function resolveConflictAcceptLocal(originalId, tableName) {
  try {
    const db = await openDB()
    const local = await getLocalRecord(db, originalId)
    if (!local) return false

    // Remove any remote shadow copies of this id.
    const all = await getAllLocalRecords(db)
    const shadows = all.filter(
      (r) => r._originalId === originalId && r._isRemoteShadow === true
    )
    for (const s of shadows) {
      await deleteLocalRecord(db, s.id)
    }

    // Re-queue the local row for upload.
    await putLocalRecord(db, {
      ...local,
      _conflict: false,
      _conflictReason: null,
      _conflictRemoteUpdatedAt: null,
      _conflictDetectedAt: null,
      _synced: false,
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _syncErrorInfo: null,
      updated_at: nowISO(),
    })
    return true
  } catch (err) {
    console.error('Could not resolve conflict (accept local):', err)
    return false
  }
}

export async function resolveConflictAcceptRemote(originalId, tableName) {
  try {
    const db = await openDB()
    const local = await getLocalRecord(db, originalId)
    if (!local) return false

    // Find the remote shadow.
    const all = await getAllLocalRecords(db)
    const shadow = all.find(
      (r) => r._originalId === originalId && r._isRemoteShadow === true
    )
    if (!shadow) {
      // No remote shadow on file — nothing to accept.
      return false
    }

    // Save an audit copy of the local version so the loss of the
    // local edit is traceable after the fact.
    await putLocalRecord(db, {
      ...cleanSupabasePayload(local),
      id: `${originalId}__conflict_resolved_${Date.now()}`,
      _originalId: originalId,
      _resolution: 'accept_remote',
      _resolvedAt: nowISO(),
      table_name: tableName,
      hospital_id: local.hospital_id,
      _synced: true,
      _isAuditCopy: true,
    })

    // Replace the local row with the remote version.
    await putLocalRecord(db, {
      ...shadow,
      id: originalId,
      _isRemoteShadow: false,
      _conflict: false,
      _conflictReason: null,
      _synced: true,
      _deleted: Boolean(shadow.deleted_at),
    })
    await deleteLocalRecord(db, shadow.id)
    return true
  } catch (err) {
    console.error('Could not resolve conflict (accept remote):', err)
    return false
  }
}

// =====================================================================
// SKIP (DISCARD) A STUCK SYNC ITEM
//
// This used to mark the item as synced, which cleared the warning
// while silently throwing the change away. It is now recorded as
// discarded so the data loss is explicit and auditable. Clinical
// rows can NEVER be discarded — the user must resolve the conflict
// or fix the schema first.
// =====================================================================

export async function skipStuckSyncItem(id) {
  try {
    const db = await openDB()
    const record = await getLocalRecord(db, id)

    if (!record) return false

    // Refuse to discard clinical records. This is the only hard
    // guardrail against silent data loss in the queue UI.
    if (CONFLICT_SENSITIVE_TABLES.has(record.table_name) && record._conflict) {
      throw new Error(
        'Clinical records in conflict cannot be discarded. Resolve the conflict instead — choose "keep local" or "accept remote".'
      )
    }

    await putLocalRecord(db, {
      ...record,
      _synced: true,
      _discarded: true,
      _discardedAt: nowISO(),
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _syncErrorInfo: null,
    })
    return true
  } catch (error) {
    console.error('Could not skip sync item:', error)
    return false
  }
}

// =====================================================================
// CLEAR LOCAL DATA ON LOGOUT / HOSPITAL SWITCH
//
// Called when someone signs out so the next person on a shared
// computer cannot read the previous user's patient records.
// Records still waiting to sync are KEPT (deleting them would lose
// clinical work) — they are uploaded the next time someone logs in.
//
// On hospital switching we DON'T wipe records — we wipe cursors so
// the next pull re-bootstraps. The old hospital's records stay in
// the DB but are filtered out by the hospital_id scope on every
// read (see loadLocalRecords).
// =====================================================================

// =====================================================================
// CLEAR LOCAL DATA ON LOGOUT / HOSPITAL SWITCH
//
// SECURITY: preserves unsynced clinical records. They will be uploaded
// the next time someone with access to the same hospital logs in.
//
// FIX: broadcasts a 'gmh:session-cleared' event so every mounted
// useOfflineTable instance resets its in-memory `records` state to
// []. Without this, the React state retains the previous user's
// patient list in memory even after IndexedDB is cleared — so the
// next user briefly sees the previous user's data until the next
// pull completes.
// =====================================================================

export async function clearLocalDataOnLogout() {
  // 1. Try to upload anything still waiting, while we still have a
  // session. Capped at 6 seconds so a slow network can never trap
  // someone on the logout button.
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      await Promise.race([flushTableQueue(), new Promise((r) => setTimeout(r, 6000))])
    }
  } catch (err) {
    console.error('Flush before logout failed:', err)
  }

  // 2. Delete every record that is safely on the server.
  let keptUnsynced = 0
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    for (const record of all) {
      if (record._synced === false && record._discarded !== true) {
        keptUnsynced += 1
        continue
      }
      await deleteLocalRecord(db, record.id)
    }

    // 3. Clear every cursor — forces a fresh bootstrap on the next
    // login regardless of which hospital it is.
    await new Promise((resolve) => {
      const tx = db.transaction(CURSOR_STORE, 'readwrite')
      tx.objectStore(CURSOR_STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })

    // 4. Clear the per-installation bootstrap meta so the next login
    // does a full pull for every table.
    try {
      const meta = await getInstallationMeta(db)
      if (meta?.fullSync) {
        meta.fullSync = {}
        await new Promise((resolve, reject) => {
          const tx2 = db.transaction(META_STORE, 'readwrite')
          const store2 = tx2.objectStore(META_STORE)
          store2.put(meta)
          tx2.oncomplete = () => resolve()
          tx2.onerror = () => reject(tx2.error)
        })
      }
    } catch (metaErr) {
      console.error('Could not clear bootstrap meta on logout:', metaErr)
    }
  } catch (err) {
    console.error('Could not clear local records on logout:', err)
  }

  // 5. Remove cached API responses saved by the service worker.
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n.includes('supabase')).map((n) => caches.delete(n))
      )
    }
  } catch (err) {
    console.error('Could not clear caches on logout:', err)
  }

  // 6. FIX: broadcast a 'session-cleared' event so every mounted
  // useOfflineTable instance resets its in-memory `records` state
  // to []. Without this, the React state retains the previous
  // user's patient list in memory even after IndexedDB is cleared.
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gmh:session-cleared'))
    }
  } catch (_err) { /* non-fatal */ }

  return { keptUnsynced }
}

// =====================================================================
// HOSPITAL SWITCH — clear cursors only, keep records.
//
// On hospital switch, the new hospital's data needs a fresh pull. We
// wipe cursors for the OLD hospital (so a future login re-bootstraps
// it) and let the new hospital pull start fresh. Records for both
// hospitals stay in IndexedDB but are scoped by hospital_id on read.
// =====================================================================

export async function clearCursorsOnHospitalSwitch(oldHospitalId) {
  if (!oldHospitalId) return
  try {
    const db = await openDB()
    await clearAllCursorsForHospital(db, oldHospitalId)
  } catch (err) {
    console.error('Could not clear cursors on hospital switch:', err)
  }
}

// =====================================================================
// DIAGNOSTICS — used by the queue panel and the audit log
// =====================================================================

export async function getSyncDiagnostics(hospitalId = null) {
  const inst = getInstallationId()
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    const scoped = hospitalId ? all.filter((r) => r.hospital_id === hospitalId) : all

    return {
      installationId: inst,
      totalRecords: scoped.length,
      pending: scoped.filter((r) => r._synced === false && r._discarded !== true && !r._isRemoteShadow).length,
      conflicts: scoped.filter((r) => r._conflict === true && r._discarded !== true).length,
      discarded: scoped.filter((r) => r._discarded === true).length,
      errors: scoped.filter((r) => r._syncError === true && r._discarded !== true).length,
    }
  } catch (err) {
    console.error('Could not get sync diagnostics:', err)
    return { installationId: inst, totalRecords: 0, pending: 0, conflicts: 0, discarded: 0, errors: 0 }
  }
}

// =====================================================================
// GET ALL CONFLICTS (hospital-scoped) — used by ConflictReviewPanel
// =====================================================================
export async function getAllConflicts(hospitalId = null) {
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    const conflicts = []
    for (const r of all) {
      if (r._conflict !== true) continue
      if (r._discarded === true) continue
      if (r._isRemoteShadow === true) continue
      if (hospitalId && r.hospital_id !== hospitalId) continue
      const shadow = all.find(
        (s) => s._originalId === r.id && s._isRemoteShadow === true
      )
      conflicts.push({
        source: 'local',
        id: r.id,
        table_name: r.table_name,
        record_id: r.id,
        local_data: cleanSupabasePayload(r),
        remote_data: shadow ? cleanSupabasePayload(shadow) : null,
        reason: r._conflictReason || 'unknown',
        remote_updated_at: r._conflictRemoteUpdatedAt || null,
        remote_version: r._conflictRemoteVersion || null,
        detected_at: r._conflictDetectedAt || r.updated_at || null,
        blocked: Boolean(r._conflictResolutionBlocked),
        blocked_reason: r._conflictResolutionBlockedReason || null,
      })
    }
    return conflicts
  } catch (err) {
    console.error('Could not get conflicts:', err)
    return []
  }
}

// =====================================================================
// RESOLVE CONFLICT (MERGE) — field-level merge
// Used by ConflictReviewPanel's "Merge" button.
// =====================================================================
export async function resolveConflictMerge(originalId, tableName, mergedRow, fieldDecisions) {
  try {
    const db = await openDB()
    const local = await getLocalRecord(db, originalId)
    if (!local) return false
    const all = await getAllLocalRecords(db)
    const shadow = all.find(
      (r) => r._originalId === originalId && r._isRemoteShadow === true
    )
    if (!shadow) return false
    // Save an audit copy of the local version.
    await putLocalRecord(db, {
      ...cleanSupabasePayload(local),
      id: `${originalId}__conflict_resolved_${Date.now()}`,
      _originalId: originalId,
      _resolution: 'merge',
      _resolvedAt: nowISO(),
      _fieldDecisions: fieldDecisions || {},
      table_name: tableName,
      hospital_id: local.hospital_id,
      _synced: true,
      _isAuditCopy: true,
    })
    // Apply the merged row locally.
    await putLocalRecord(db, {
      ...mergedRow,
      id: originalId,
      table_name: tableName,
      hospital_id: local.hospital_id,
      _synced: false,
      _deleted: Boolean(mergedRow.deleted_at),
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _conflict: false,
      _conflictReason: null,
      _discarded: false,
      updated_at: nowISO(),
    })
    await deleteLocalRecord(db, shadow.id)
    return true
  } catch (err) {
    console.error('Could not resolve conflict (merge):', err)
    return false
  }
}
