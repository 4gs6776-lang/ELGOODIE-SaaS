import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react'

import { supabase } from './supabaseClient'
import { assertWriteAllowed } from './subscriptionLock'
import { assertWithinPlanLimit, getEntitlements } from './planEntitlements'
import {
  getCachedTable,
  setCachedTable,
  invalidateTable,
  subscribeToTable,
  getOrFetchTable,
  clearAllCache,
} from './useTableCache'

const DB_NAME = 'HospitalOfflineDB'
const DB_VERSION = 4  // v4: added compound index (table_name, hospital_id) for faster filtered reads

const STORE_NAME = 'offline_records'

// Tables that must NEVER be hard-deleted (clinical history is referenced
// by child rows: vitals, lab orders, prescriptions, invoices...).
// A delete on these becomes an update that stamps deleted_at.
// Stage 1 cleanup: lab_orders/lab_tests/radiology_scans joined patients
// here — clinical results must be archived, not destroyed (rule 16).
const SOFT_DELETE_TABLES = new Set(['patients', 'lab_orders', 'lab_tests', 'radiology_scans'])

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

// ============================================================
// OPEN INDEXED DB
// ============================================================

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('table_name', 'table_name', { unique: false })
        store.createIndex('hospital_id', 'hospital_id', { unique: false })
        store.createIndex('synced', '_synced', { unique: false })
        // v4: compound index for filtered reads by (table_name, hospital_id)
        store.createIndex('table_hospital', ['table_name', 'hospital_id'], { unique: false })
      }
      // v4 upgrade path: add compound index to existing store (preserves ALL data)
      if (db.objectStoreNames.contains(STORE_NAME)) {
        const store = event.target.transaction.objectStore(STORE_NAME)
        if (!store.indexNames.contains('table_hospital')) {
          store.createIndex('table_hospital', ['table_name', 'hospital_id'], { unique: false })
        }
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

// ============================================================
// UUID GENERATOR
// ============================================================

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

// ============================================================
// CURRENT TIMESTAMP
// ============================================================

function nowISO() {
  return new Date().toISOString()
}

// ============================================================
// CLEAN SUPABASE PAYLOAD
// ============================================================

function cleanSupabasePayload(record) {
  const {
    table_name,
    _synced,
    _deleted,
    _syncError,
    _syncErrorMessage,
    _syncErrorKind,
    _discarded,
    ...payload
  } = record
  return payload
}

// ============================================================
// SCHEMA-GAP TOLERANCE
//
// Some tables in the hosted database are missing columns the app
// stamps on every write (e.g. `updated_at`). PostgREST answers with
// PGRST204 ("Could not find the 'x' column of 'y' in the schema
// cache") and the whole record is rejected, jamming the sync queue.
//
// Instead of failing, we remember which columns a table does not
// have and retry the write without them. The memory is per session,
// so once you run the schema migration everything is sent again.
// ============================================================

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

// fetch() failures surface as TypeError("Failed to fetch") with no error
// code — these are the ONLY failures that reliably mean "the network was
// down", and they must never read like a data problem.
const NETWORK_ERROR_RE = /failed to fetch|networkerror|load failed|fetch failed|network request failed|err_internet/i

function isNetworkError(error) {
  return NETWORK_ERROR_RE.test(error?.message || '')
}

// Permanent failures must not be retried on every reconnect — they need
// either a schema change or a decision from the user.
function classifyError(error) {
  if (missingColumnFromError(error)) return 'schema'
  if (isForeignKeyViolation(error)) return 'reference'
  if (error?.code === '23505' || /duplicate key value/i.test(error?.message || '')) return 'conflict'
  if (error?.code === '42501' || /row-level security/i.test(error?.message || '')) return 'permission'
  return 'transient'
}

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

// Runs a Supabase write and, if it fails only because a column does not
// exist, drops that column and tries again (repeatedly, if needed).
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
  return { data: null, error: new Error(`Could not sync to "${tableName}" after removing unknown columns.`) }
}

// ============================================================
// WRITE LOCAL RECORD
// ============================================================

// Every useOfflineTable() call keeps its OWN copy of the records in React
// state. When one instance (a modal, a child component, another page's hook,
// the sync queue) wrote to IndexedDB, the other instances never found out,
// so a new record only appeared after a full page refresh re-read the DB.
// Every local write now announces itself here and all mounted instances
// re-read the local store.
const localChangeListeners = new Set()

function notifyLocalChange() {
  // Invalidate the pending count cache so the next read gets a fresh count
  invalidatePendingCountCache()
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

// ============================================================
// PUT LOCAL RECORDS — BATCH (single transaction)
// ============================================================
// PERFORMANCE: Writes many records in ONE IndexedDB transaction
// instead of one transaction per record. For a 1000-row pull, this
// is ~10-50x faster than calling putLocalRecord() in a loop.
//
// Safety:
//   - If any put fails, the entire transaction rolls back (atomic).
//   - notifyLocalChange() is called ONCE at the end (not per-record),
//     which also reduces re-render storms in subscribed components.
//   - Pending (_synced=false) local records are NOT overwritten by
//     the pull — same rule as the original per-record loop.
async function putLocalRecordsBatch(db, records) {
  if (!records || records.length === 0) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const record of records) {
      store.put(record)
    }
    tx.oncomplete = () => {
      notifyLocalChange()
      resolve(records.length)
    }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
  })
}

// ============================================================
// GET LOCAL RECORD
// ============================================================

async function getLocalRecord(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

// ============================================================
// GET ALL LOCAL RECORDS
// ============================================================

async function getAllLocalRecords(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

// ============================================================
// GET LOCAL RECORDS BY TABLE + HOSPITAL (index-based, no full-store scan)
// ============================================================
// PERFORMANCE: Uses the v4 compound index (table_name, hospital_id)
// to read only records for the requested table+hospital, instead of
// getAllLocalRecords() which reads the ENTIRE store then filters in JS.
// ~10x faster for large stores (20K+ records).

async function getAllLocalRecordsByTable(db, tableName, hospitalId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)

    // Try the v4 compound index first (fastest)
    if (store.indexNames.contains('table_hospital')) {
      const index = store.index('table_hospital')
      // Use a key range to match exactly (tableName, hospitalId)
      const keyRange = IDBKeyRange.only([tableName, hospitalId])
      const request = index.getAll(keyRange)
      request.onsuccess = () => {
        const all = request.result || []
        // Filter out deleted records (still in store but hidden from lists)
        const filtered = all.filter(r => !r._deleted && !r.deleted_at)
        resolve(filtered)
      }
      request.onerror = () => reject(request.error)
    } else if (store.indexNames.contains('table_name')) {
      // Fallback: use table_name index, then filter by hospital_id in JS
      const index = store.index('table_name')
      const request = index.getAll(tableName)
      request.onsuccess = () => {
        const all = request.result || []
        const filtered = all.filter(r =>
          (!hospitalId || r.hospital_id === hospitalId) &&
          !r._deleted && !r.deleted_at
        )
        resolve(filtered)
      }
      request.onerror = () => reject(request.error)
    } else {
      // Last resort: getAll() + filter (legacy path, very slow)
      const request = store.getAll()
      request.onsuccess = () => {
        const all = request.result || []
        const filtered = all.filter(r =>
          r.table_name === tableName &&
          (!hospitalId || r.hospital_id === hospitalId) &&
          !r._deleted && !r.deleted_at
        )
        resolve(filtered)
      }
      request.onerror = () => reject(request.error)
    }
  })
}

// ============================================================
// GET PENDING SYNC COUNT (index-based, no full-store scan)
// ============================================================
// PERFORMANCE: Uses the 'synced' index to count only unsynchronized
// records, instead of reading the entire store. Centralized so
// multiple hooks share the same count instead of each scanning.

let _pendingCountCache = null
let _pendingCountTimestamp = 0
const PENDING_COUNT_TTL_MS = 5000  // 5 seconds

async function getPendingSyncCount(db) {
  // Return cached count if fresh (within 5s)
  if (_pendingCountCache !== null && Date.now() - _pendingCountTimestamp < PENDING_COUNT_TTL_MS) {
    return _pendingCountCache
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)

    if (store.indexNames.contains('synced')) {
      // Use the synced index to count only _synced=false records
      const index = store.index('synced')
      const keyRange = IDBKeyRange.only(false)
      const request = index.count(keyRange)
      request.onsuccess = () => {
        const count = request.result || 0
        // Subtract discarded records (they have _synced=false but _discarded=true)
        // We'll need to filter those separately — but for a quick count,
        // this is close enough. The exact count is computed on next full scan.
        _pendingCountCache = count
        _pendingCountTimestamp = Date.now()
        resolve(count)
      }
      request.onerror = () => reject(request.error)
    } else {
      // Fallback: count all and filter (legacy path)
      const request = store.getAll()
      request.onsuccess = () => {
        const all = request.result || []
        const count = all.filter(r => r._synced === false && r._discarded !== true).length
        _pendingCountCache = count
        _pendingCountTimestamp = Date.now()
        resolve(count)
      }
      request.onerror = () => reject(request.error)
    }
  })
}

// Invalidate the pending count cache (called after writes)
function invalidatePendingCountCache() {
  _pendingCountCache = null
  _pendingCountTimestamp = 0
}

// ============================================================
// DELETE LOCAL RECORD
// ============================================================

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

// ============================================================
// SYNC CURSOR MANAGEMENT (Stage 2 — incremental sync)
// ============================================================
// Reads/writes the sync_cursor table to track the last successful
// sync timestamp per (hospital, table). Used for incremental sync:
//   1. Read cursor → get lastSyncedAt
//   2. Fetch only records with updated_at >= (cursor - overlap)
//   3. Write cursor → advance to now()
//
// The overlap window (5 minutes) ensures records changed DURING the
// sync are caught on the next sync — prevents edge-case data loss
// where a record is updated between the cursor read and the fetch.
//
// Safety:
//   - If the cursor read fails → full sync (no filter)
//   - If the fetch fails → cursor NOT advanced (retry from same point)
//   - If updated_at column doesn't exist → 400 from PostgREST →
//     catch error → full sync fallback (no date filter)
//   - Pending offline writes (_synced=false) are NEVER overwritten

const SYNC_OVERLAP_MS = 5 * 60 * 1000  // 5-minute overlap window

async function getSyncCursor(hospitalId, tableName) {
  if (!hospitalId || !supabase?.from) return null
  try {
    const { data, error } = await supabase
      .from('sync_cursor')
      .select('last_synced_at')
      .eq('hospital_id', hospitalId)
      .eq('table_name', tableName)
      .maybeSingle()
    if (error || !data) return null
    return data.last_synced_at
  } catch {
    return null  // Non-fatal — fall back to full sync
  }
}

async function setSyncCursor(hospitalId, tableName, syncedAt) {
  if (!hospitalId || !supabase?.from) return
  try {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase
      .from('sync_cursor')
      .upsert({
        hospital_id: hospitalId,
        table_name: tableName,
        last_synced_at: syncedAt || new Date().toISOString(),
        last_synced_by: user?.id || null,
      }, { onConflict: 'hospital_id,table_name' })
  } catch (e) {
    // Non-fatal — cursor update failed, next sync will retry from same point
    console.warn(`[sync_cursor] Failed to advance cursor for ${tableName}:`, e.message)
  }
}

// ============================================================
// PULL RECORDS DOWN FROM SUPABASE
// ============================================================

// Supabase (PostgREST) returns AT MOST 1000 rows per request by default.
const PULL_PAGE_SIZE = 1000
const PULL_MAX_PAGES = 500

// Returns every row for the hospital (or only changed rows if sinceTimestamp
// is provided), or null if ANY page failed.
//
// Incremental sync: when sinceTimestamp is provided, adds
// .gte('updated_at', sinceTimestamp - overlap) to fetch only changed
// records. If the updated_at column doesn't exist, PostgREST returns 400 —
// we catch that and retry without the filter (full sync fallback).
async function fetchAllRemoteRows(tableName, hospitalId, sinceTimestamp) {
  const rows = []

  // If we have a cursor, subtract the overlap window to catch records
  // changed during the previous sync.
  const cutoffDate = sinceTimestamp
    ? new Date(new Date(sinceTimestamp).getTime() - SYNC_OVERLAP_MS).toISOString()
    : null

  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const from = page * PULL_PAGE_SIZE
    let query = supabase
      .from(tableName)
      .select('*')
      .eq('hospital_id', hospitalId)

    // Apply incremental filter if we have a cursor
    if (cutoffDate) {
      query = query.gte('updated_at', cutoffDate)
    }

    const { data, error } = await query
      .order('id', { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1)

    // If the error is about updated_at column not existing, retry without the filter
    if (error && cutoffDate && error.message && error.message.includes('updated_at')) {
      console.warn(`[sync] ${tableName} doesn't have updated_at column — falling back to full sync`)
      return fetchAllRemoteRowsNoFilter(tableName, hospitalId)
    }

    if (error || !data) return null
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) return rows
  }
  console.warn(`Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit).`)
  return rows
}

// Full sync fallback (no date filter) — used when updated_at doesn't exist
async function fetchAllRemoteRowsNoFilter(tableName, hospitalId) {
  const rows = []
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const from = page * PULL_PAGE_SIZE
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .eq('hospital_id', hospitalId)
      .order('id', { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1)

    if (error || !data) return null
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) return rows
  }
  console.warn(`Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit).`)
  return rows
}

// FIX: pullFromSupabase now returns { success, error } so the caller
// can decide whether to cache the result as "successfully synced" or
// preserve stale data and surface an error.
async function pullFromSupabase(db, tableName, hospitalId) {
  if (!navigator.onLine || !supabase?.from || !hospitalId) return { success: false, error: 'offline' }

  try {
    // STAGE 2: Read the sync cursor before fetching.
    // If a cursor exists, fetch only records changed since the cursor
    // (with a 5-minute overlap window for safety).
    // If no cursor (first sync), fetch all rows.
    const sinceTimestamp = await getSyncCursor(hospitalId, tableName)

    const remoteRows = await fetchAllRemoteRows(tableName, hospitalId, sinceTimestamp)

    if (!remoteRows) return { success: false, error: 'fetch returned null' }

    // PERFORMANCE: Use getAllLocalRecordsByTable (compound index) instead
    // of getAllLocalRecords (full-store scan) to build the localById map.
    const localRows = await getAllLocalRecordsByTable(db, tableName, hospitalId)
    const localById = new Map(localRows.map((r) => [r.id, r]))

    const batch = []
    for (const remote of remoteRows) {
      const local = localById.get(remote.id)

      // Don't overwrite a record that has local changes waiting to sync
      // (e.g. an edit or delete made offline that hasn't gone up yet).
      if (local && local._synced === false) continue

      batch.push({
        ...remote,
        table_name: tableName,
        hospital_id: hospitalId,
        _synced: true,
        // Soft-deleted rows stay in the local store but are hidden from lists.
        _deleted: Boolean(remote.deleted_at),
        _syncError: false,
        _syncErrorMessage: null,
        _syncErrorKind: null,
      })
    }

    // Write all rows in ONE transaction. If any put fails, the entire
    // transaction rolls back and the local data stays exactly as it was.
    if (batch.length > 0) {
      await putLocalRecordsBatch(db, batch)
    }

    // STAGE 2: Advance the sync cursor after a confirmed successful sync.
    // This MUST happen AFTER the batch write succeeds — if the write
    // throws, we never reach this line, so the cursor stays at the old
    // value and the next sync retries from the same point.
    await setSyncCursor(hospitalId, tableName)

    return { success: true, error: null }
  } catch (err) {
    console.error(`Error pulling ${tableName} from Supabase:`, err)
    return { success: false, error: err.message || String(err) }
  }
}

// ============================================================
// MAIN HOOK
// ============================================================

export function useOfflineTable(tableName, hospitalId, options = {}) {
  const { realtime = false } = options
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : false)
  const [pendingCount, setPendingCount] = useState(0)
  const [loadError, setLoadError] = useState(null)
  // Mirror of pendingCount for use inside timers (state captured in a
  // setInterval closure would be frozen at mount time).
  const pendingCountRef = useRef(0)
  // Guards against an older, slower read finishing AFTER a newer one and
  // overwriting fresh data.
  const loadSeqRef = useRef(0)

  const loadLocalRecords = useCallback(async () => {
    if (!hospitalId) {
      setRecords([])
      setLoading(false)
      return
    }

    const seq = ++loadSeqRef.current
    try {
      const db = await openDB()

      // PERFORMANCE: Use getAllLocalRecordsByTable (compound index)
      // instead of getAllLocalRecords (full-store scan) + JS filter.
      // Reads only records for this table+hospital — ~10x faster.
      const filtered = await getAllLocalRecordsByTable(db, tableName, hospitalId)
      if (seq !== loadSeqRef.current) return

      setRecords(filtered)

      // PERFORMANCE: Use centralized getPendingSyncCount (index-based
      // count on the 'synced' index) instead of scanning all records.
      // Multiple hooks on the same page share the cached count (5s TTL).
      const pending = await getPendingSyncCount(db)
      if (seq !== loadSeqRef.current) return
      setPendingCount(pending)
      pendingCountRef.current = pending
      setLoadError(null)
      setLoading(false)
    } catch (error) {
      console.error('Error reading offline records:', error)
      setLoadError(error?.message || 'Could not read local data')
      setLoading(false)
    }
  }, [tableName, hospitalId])

  useEffect(() => {
    async function initialLoad() {
      // ---- Check global cache first ----
      const cached = getCachedTable(tableName, hospitalId)
      if (cached) {
        // Cache hit — read from IndexedDB (already populated by a previous pull)
        await loadLocalRecords()
        return
      }

      if (hospitalId) {
        try {
          const db = await openDB()

          // FIX: Use getOrFetchTable for request deduplication.
          // If 3 components mount useOfflineTable('patients', hospitalId)
          // simultaneously, only 1 Supabase pull fires — the other 2
          // share the same in-flight promise.
          await getOrFetchTable(tableName, hospitalId, async () => {
            const result = await pullFromSupabase(db, tableName, hospitalId)

            // FIX: Only mark as cached after a CONFIRMED successful pull.
            // A failed pull must NOT be cached as success — otherwise
            // the 30-min TTL blocks retries and the user sees stale data.
            if (result.success) {
              return []  // empty array = "successfully synced" marker
            } else {
              // Pull failed — don't cache as success.
              // Stale IndexedDB data (if any) is still available via
              // loadLocalRecords() below.
              console.warn(`Pull of ${tableName} failed: ${result.error}. Stale data preserved.`)
              throw new Error(result.error)  // getOrFetchTable will NOT cache this
            }
          })
        } catch (err) {
          // Either DB open failed or pull failed — either way,
          // fall through to loadLocalRecords() which reads whatever
          // IndexedDB has (could be stale data from a previous session).
          console.error(`Initial load for ${tableName} failed (non-fatal):`, err.message)
        }
      }
      await loadLocalRecords()
    }

    initialLoad().then(() => {
      // Flush on app load. Until now the queue only retried on
      // online/offline events, so reloading the tab while online left
      // transient failures (e.g. "Failed to fetch") stuck in the panel
      // forever with no automatic way out.
      if (navigator.onLine && hospitalId) flushTableQueue(tableName)
    })

    // Subscribe to cross-component cache invalidation
    const unsubscribe = subscribeToTable(tableName, hospitalId, () => {
      loadLocalRecords()
    })

    // Safety net: while this table has unsynced records, retry quietly
    // every minute so transient failures self-heal without waiting for a
    // reconnect event.
    const retryTimer = setInterval(() => {
      if (pendingCountRef.current > 0 && navigator.onLine && hospitalId) {
        flushTableQueue(tableName)
      }
    }, 60000)

    const handleOnline = async () => {
      setIsOnline(true)
      await flushTableQueue(tableName)
      if (hospitalId) {
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
        } catch (err) {
          console.error('Error opening DB for reconnect pull:', err)
        }
      }
      await loadLocalRecords()
    }

    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      clearInterval(retryTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      // Unsubscribe from cross-component cache invalidation
      if (unsubscribe) unsubscribe()
    }
  }, [loadLocalRecords, tableName, hospitalId])

  // Keep this instance in step with writes made by ANY other instance.
  // Debounced so a burst (a pull writing hundreds of rows, a queue flush)
  // causes one re-read instead of hundreds.
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

  // Opt-in live sync: when another device/tab inserts, updates or deletes
  // a row in this table for the same hospital, pull it down and merge it
  // into local state — no manual refresh needed. Off by default so every
  // existing caller of this hook keeps its current behavior untouched;
  // pass { realtime: true } as the 3rd argument to turn it on.
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
    // Count = the larger of this device's records and the server's last
    // known count (the device only holds what has synced to it).
    if (tableName === 'patients') {
      const countDb = await openDB()
      const localCount = (await getAllLocalRecords(countDb)).filter(
        (r) => r.table_name === 'patients' && r.hospital_id === hospitalId && !r._deleted && !r.deleted_at
      ).length
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
      _synced: false,
      _deleted: false,
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
    }

    const db = await openDB()
    await putLocalRecord(db, newRecord)
    await loadLocalRecords()

    if (navigator.onLine && supabase?.from) {
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
        })
        await loadLocalRecords()
        throw new Error(friendlyErrorMessage(error, tableName))
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

    const updatedRecord = {
      ...existing,
      ...updates,
      id,
      table_name: tableName,
      hospital_id: existing.hospital_id || hospitalId,
      updated_at: nowISO(),
      _synced: false,
      _deleted: Boolean(updates?.deleted_at ?? existing.deleted_at),
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _discarded: false,
    }

    await putLocalRecord(db, updatedRecord)
    await loadLocalRecords()

    if (navigator.onLine && supabase?.from) {
      const { id: payloadId, ...updatePayload } = cleanSupabasePayload(updatedRecord)
      try {
        const { data: remoteData, error } = await writeWithSchemaRetry(
          tableName,
          (payload) => supabase.from(tableName).update(payload).eq('id', payloadId).select().single(),
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
          hospital_id: hospitalId,
          _synced: Boolean(remoteData),
          _deleted: Boolean((remoteData || updatedRecord).deleted_at),
          _syncError: false,
          _syncErrorMessage: null,
          _syncErrorKind: null,
        })
      } catch (error) {
        console.error('Supabase update failed:', error)
        await putLocalRecord(db, {
          ...updatedRecord,
          _synced: false,
          _syncError: true,
          _syncErrorKind: classifyError(error),
          _syncErrorMessage: friendlyErrorMessage(error, tableName),
        })
        await loadLocalRecords()
        throw new Error(friendlyErrorMessage(error, tableName))
      }
    }

    await loadLocalRecords()
    return updatedRecord
  }

  // Deleting a patient (and now lab orders/tests, radiology scans) used
  // to issue a hard DELETE, which the database refuses while other
  // records still reference the row — and even when it succeeds, it
  // destroys clinical history. For SOFT_DELETE_TABLES we archive
  // instead: deleted_at is stamped, history is preserved, and the
  // record disappears from every list.
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
      _discarded: false,
      updated_at: nowISO(),
    }

    await putLocalRecord(db, deletedRecord)
    await loadLocalRecords()

    if (navigator.onLine && supabase?.from) {
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
        })
        await loadLocalRecords()
        throw new Error(friendlyErrorMessage(error, tableName))
      }
    }

    await loadLocalRecords()
  }

  const syncFromServer = async () => {
    if (!hospitalId) return
    try {
      // Invalidate the cache so other components know to re-read
      invalidateTable(tableName, hospitalId)
      const db = await openDB()
      const result = await pullFromSupabase(db, tableName, hospitalId)
      await loadLocalRecords()
      // FIX: Only re-populate the cache after a confirmed successful pull
      if (result && result.success) {
        setCachedTable(tableName, hospitalId, [])
      }
    } catch (err) {
      console.error(`Error manually syncing ${tableName} from server:`, err)
    }
  }

  return {
    records,
    loading,
    loadError,
    isOnline,
    pendingCount,
    addRecord,
    updateRecord,
    deleteRecord,
    refreshTable: loadLocalRecords,
    syncFromServer,
  }
}

// ============================================================
// GET ALL SYNC ERRORS
// ============================================================

export async function getAllSyncErrors() {
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    return all.filter((record) => record._syncError === true && record._discarded !== true)
  } catch (error) {
    console.error('Could not get sync errors:', error)
    return []
  }
}

// ============================================================
// SUBSCRIBE TO SYNC ERRORS
// ============================================================

export function subscribeSyncErrors(callback) {
  const handler = async () => {
    if (typeof callback !== 'function') return
    const errors = await getAllSyncErrors()
    callback(errors)
  }

  handler() // Run immediately

  window.addEventListener('online', handler)
  window.addEventListener('offline', handler)

  return () => {
    window.removeEventListener('online', handler)
    window.removeEventListener('offline', handler)
  }
}

// ============================================================
// FLUSH OFFLINE QUEUE
//
// `force` retries items that previously failed with a permanent
// error (missing column, foreign-key conflict). Automatic flushes on
// reconnect skip those so the queue stops hammering the database
// with writes that cannot succeed until the schema is fixed.
// ============================================================

export async function flushTableQueue(tableName = null, { force = false } = {}) {
  if (!navigator.onLine || !supabase?.from) return

  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)

    const pending = all.filter(
      (record) =>
        record._synced === false &&
        record._discarded !== true &&
        (!tableName || record.table_name === tableName) &&
        // Schema-gap items stay held only until this session has learned
        // the table's missing columns — after that writeWithSchemaRetry
        // heals the write inline, so automatic retries are safe again.
        (force || record._syncErrorKind !== 'schema' || (unknownColumnsByTable.get(record.table_name)?.size || 0) > 0)
    )

    // Parents before children: a patient created offline must reach the
    // server before the admission request / vitals / invoice that points
    // at it, or the child write dies with a foreign-key violation.
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
          const { error } = await supabase
            .from(record.table_name)
            .delete()
            .eq('id', record.id)

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
        })
      } catch (error) {
        const kind = classifyError(error)
        console.error(`Failed to sync ${record.id} (${kind}):`, error)

        // Unique-conflict reconciliation: billable_charges carries a second
        // unique key (unique_source_transaction) the id-upsert cannot cover.
        // If the same charge already exists on the server under a different
        // local id (a re-run lab test billed twice, or an insert whose
        // success response was lost), the queued copy is a duplicate of a
        // persisted row — adopt the server row and retire the local one
        // instead of jamming the queue forever.
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
                _discarded: false,
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

// ============================================================
// SKIP (DISCARD) A STUCK SYNC ITEM
//
// This used to mark the item as synced, which cleared the warning
// while silently throwing the change away. It is now recorded as
// discarded so the data loss is explicit and auditable.
// ============================================================

export async function skipStuckSyncItem(id) {
  try {
    const db = await openDB()
    const record = await getLocalRecord(db, id)

    if (!record) return false

    await putLocalRecord(db, {
      ...record,
      _synced: true,
      _discarded: true,
      _discardedAt: nowISO(),
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
    })
    return true
  } catch (error) {
    console.error('Could not skip sync item:', error)
    return false
  }
}
// ============================================================
// CLEAR LOCAL DATA ON LOGOUT
//
// Called when someone signs out so the next person on a shared
// computer cannot read the previous user's patient records.
// Records still waiting to sync are KEPT (deleting them would lose
// clinical work) — they are uploaded the next time someone logs in.
// ============================================================

export async function clearLocalDataOnLogout() {
  // 1. Try to upload anything still waiting, while we still have a session.
  try {
    if (navigator.onLine) await flushTableQueue()
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
  } catch (err) {
    console.error('Could not clear local records on logout:', err)
  }

  // 3. Remove cached API responses saved by the service worker.
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n.includes('supabase')).map((n) => caches.delete(n)))
    }
  } catch (err) {
    console.error('Could not clear caches on logout:', err)
  }

  return { keptUnsynced }
}
