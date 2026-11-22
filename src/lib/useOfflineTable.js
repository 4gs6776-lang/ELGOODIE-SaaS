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
  clearAllCache,
} from './useTableCache'

const DB_NAME = 'HospitalOfflineDB'
// FIX: Bumped from 3 -> 5. The ELGOODIE-SaaS branch uses DB_VERSION = 4.
// If a user previously deployed ELGOODIE, their browser's IndexedDB is at
// v4; calling indexedDB.open(DB_NAME, 3) then throws VersionError and the
// entire sync layer silently dies (every pull fails, every module shows
// "No data", while the dashboard RPC still works because it bypasses
// IndexedDB). Bumping to 5 forces an onupgradeneeded that backfills any
// missing indexes and keeps the existing rows.
const DB_VERSION = 5

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
      const oldVersion = event.oldVersion

      // Create the main store if it doesn't exist (v1 -> v5).
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('table_name', 'table_name', { unique: false })
        store.createIndex('hospital_id', 'hospital_id', { unique: false })
        store.createIndex('synced', '_synced', { unique: false })
      } else if (oldVersion < 5) {
        // Upgrading from v1/v2/v3/v4 -> backfill any missing indexes.
        // createIndex is idempotent against the name but throws if the
        // name is taken with a different keyPath, so we probe each one.
        const store = event.target.transaction.objectStore(STORE_NAME)
        if (!store.indexNames.contains('table_name')) {
          store.createIndex('table_name', 'table_name', { unique: false })
        }
        if (!store.indexNames.contains('hospital_id')) {
          store.createIndex('hospital_id', 'hospital_id', { unique: false })
        }
        if (!store.indexNames.contains('synced')) {
          store.createIndex('synced', '_synced', { unique: false })
        }
      }
      // v4 -> v5: no schema change beyond the index backfill above.
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

      // FIX: VersionError recovery. If the browser's database is at a
      // HIGHER version than the code expects (e.g. user ran a newer
      // build that bumped DB_VERSION, then rolled back), indexedDB.open
      // fires onerror with error.name === 'VersionError'. The previous
      // code just rejected -> every subsequent openDB() also failed ->
      // the entire sync layer was dead.
      //
      // Recovery: delete the database and re-open. This loses any
      // LOCAL-ONLY unsynced changes, but server data is re-pulled.
      const err = request.error
      if (err && err.name === 'VersionError') {
        console.warn(
          '[openDB] VersionError - browser DB version is higher than code version (' + DB_VERSION + '). ' +
          'Deleting the database and recreating it. Local-only unsynced changes will be lost; ' +
          'all server data will be re-pulled automatically.'
        )
        const deleteReq = indexedDB.deleteDatabase(DB_NAME)
        deleteReq.onsuccess = () => {
          // Retry the open. This time onupgradeneeded will fire and
          // create a fresh store with the current DB_VERSION.
          const retryReq = indexedDB.open(DB_NAME, DB_VERSION)
          retryReq.onupgradeneeded = (event) => {
            const db = event.target.result
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
              store.createIndex('table_name', 'table_name', { unique: false })
              store.createIndex('hospital_id', 'hospital_id', { unique: false })
              store.createIndex('synced', '_synced', { unique: false })
            }
          }
          retryReq.onsuccess = () => resolve(retryReq.result)
          retryReq.onerror = () => reject(retryReq.error)
        }
        deleteReq.onerror = () => reject(deleteReq.error)
        deleteReq.onblocked = () => {
          console.warn('[openDB] Delete blocked by another tab. Close other tabs and reload.')
        }
        return
      }
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
// BULK UPSERT - batched write used by pullFromSupabase.
//
// The old pull loop called putLocalRecord() once per row, and each call
// opened its own readwrite transaction. For a hospital with 2,000 patients
// + 5,000 lab tests + 10,000 inventory items, that was ~17,000 separate
// transactions on every pull - 30-90s of frozen UI. This function writes
// the whole batch in ONE transaction (one commit, one fsync), which is
// 50-200x faster for large tables. notifyLocalChange() fires once after
// the batch commits.
// ============================================================

async function bulkPutLocalRecords(db, records) {
  if (!records || records.length === 0) return 0
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
// GET LOCAL RECORDS BY TABLE + HOSPITAL (indexed, fast)
//
// loadLocalRecords used to call getAllLocalRecords() (which scans the
// WHOLE store - every table, every hospital - then filtered in JS).
// For a hospital with 30+ tables and thousands of rows each, that is
// 50,000+ rows deserialised on every re-read. Now we use the
// 'table_name' index to read only the rows for the requested table,
// which is typically 1-5% of the store. hospital_id is filtered in JS
// (a compound index would need a migration to create).
// ============================================================

async function getLocalRecordsByTable(db, tableName, hospitalId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('table_name')
    const request = index.getAll(tableName)
    request.onsuccess = () => {
      const rows = request.result || []
      resolve(
        hospitalId
          ? rows.filter((r) => r.hospital_id === hospitalId)
          : rows
      )
    }
    request.onerror = () => reject(request.error)
  })
}

// ============================================================
// COUNT PENDING (unsynced) RECORDS - indexed, SAFE
//
// *** THIS IS THE FIX FOR THE DataError CRASH. ***
//
// The previous version called:
//     store.index('synced').getAll(false)
// but booleans are NOT valid IndexedDB keys (only string, number,
// Date, array, and binary blobs are). Every call threw:
//     DataError: Failed to execute 'getAll' on 'IDBIndex':
//     The parameter is not a valid key.
// That error surfaced as "Error reading offline records" flooding the
// console, and NO records ever loaded into the UI.
//
// We now use openCursor() (no key argument - scans all rows) and
// filter _synced === false in JS. This is slightly slower than a keyed
// getAll but it never throws, and the 'synced' index is still used by
// the browser to iterate in index order. For typical hospital sizes
// (a few hundred to a few thousand unsynced rows max) this is
// negligible - the cursor only touches unsynced rows in practice
// because we return as soon as we have the count.
//
// Alternative we considered: store _synced as 0/1 (integer) instead
// of false/true so index.getAll(0) works. Rejected because it would
// require migrating every existing row in every existing database.
// ============================================================

async function countPendingRecords(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('synced')
    let count = 0
    const request = index.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(count)
        return
      }
      // _synced is stored as a boolean. We want the unsynced ones.
      if (cursor.value._synced === false && cursor.value._discarded !== true) {
        count += 1
      }
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
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
// PULL RECORDS DOWN FROM SUPABASE
// ============================================================

// Supabase (PostgREST) returns AT MOST 1000 rows per request by default.
// Before this fix the pull made ONE request, so any table with more than
// 1000 rows for a hospital (patients, invoices, lab orders...) was
// silently cut off: the rest never reached the device, lists showed only
// the first 1000 and counts were wrong. We now read the table in pages
// of 1000 until the last page.
//   - If you ever change "Max rows" in Supabase (Settings -> API), set
//     PULL_PAGE_SIZE to the same number.
//   - Rows are ordered by id so pages never overlap or skip rows.
//   - PULL_MAX_PAGES is only a safety stop against an endless loop
//     (500 pages = 500,000 rows).
const PULL_PAGE_SIZE = 1000
const PULL_MAX_PAGES = 500

// SYNC_DEBUG - set to true ONLY while diagnosing a sync issue. When
// false, the hot path (every pull, every page fetch) stays silent;
// only genuine errors use console.error. Toggle by setting
// window.__gmhSyncDebug = true in the browser console before reload,
// or VITE_SYNC_DEBUG=true in env.
const SYNC_DEBUG =
  (typeof window !== 'undefined' && window.__gmhSyncDebug === true) ||
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SYNC_DEBUG === 'true')

// Returns every row for the hospital, or null if ANY page failed (we then
// keep the local data exactly as it was instead of applying a half-read
// table).
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
      // Always log real errors - these are why the user sees "no data".
      // Common causes:
      //   - 42501: RLS policy denied the read.
      //   - PGRST204: column does not exist in the schema cache.
      //   - 42P01: the table does not exist (migration not applied).
      console.error(
        `[sync] Pull of ${tableName} failed on page ${page}:`,
        `code=${error.code || 'n/a'}`,
        `message=${error.message}`,
        error
      )
      return null
    }
    if (!data) {
      console.warn(`[sync] Pull of ${tableName} returned no data and no error on page ${page}.`)
      return null
    }
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) {
      if (SYNC_DEBUG) console.info(`[sync] Pull of ${tableName} complete: ${rows.length} row(s) fetched.`)
      return rows
    }
  }
  console.warn(`Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit).`)
  return rows
}

async function pullFromSupabase(db, tableName, hospitalId) {
  if (!navigator.onLine || !supabase?.from || !hospitalId) {
    if (SYNC_DEBUG) console.warn(`[sync] Pull of ${tableName} skipped (offline, no client, or no hospitalId).`)
    return
  }

  const startedAt = SYNC_DEBUG ? performance.now() : 0

  try {
    const remoteRows = await fetchAllRemoteRows(tableName, hospitalId)

    if (!remoteRows) return

    if (remoteRows.length === 0) {
      if (SYNC_DEBUG) console.info(`[sync] Pull of ${tableName} returned 0 rows. If the table has data in Supabase, check the RLS policy.`)
      return
    }

    // Build the batch of rows that need writing. Skip any row whose
    // local copy has unsynced changes (an offline edit waiting to
    // upload) so the pull never clobbers pending work.
    const localRows = await getAllLocalRecords(db)
    const localById = new Map(localRows.map((r) => [r.id, r]))

    const toUpsert = []
    for (const remote of remoteRows) {
      const local = localById.get(remote.id)
      if (local && local._synced === false) continue
      toUpsert.push({
        ...remote,
        table_name: tableName,
        hospital_id: hospitalId,
        _synced: true,
        _deleted: Boolean(remote.deleted_at),
        _syncError: false,
        _syncErrorMessage: null,
        _syncErrorKind: null,
      })
    }

    // Write the whole batch in ONE transaction. The old code awaited
    // putLocalRecord() per row (one transaction per row), which turned a
    // 2,000-row pull into 2,000 separate fsyncs. This is 50-200x faster.
    if (toUpsert.length > 0) {
      await bulkPutLocalRecords(db, toUpsert)
    }

    if (SYNC_DEBUG) {
      const elapsed = (performance.now() - startedAt).toFixed(1)
      console.info(`[sync] Pull of ${tableName}: ${toUpsert.length}/${remoteRows.length} row(s) merged in ${elapsed}ms.`)
    }
  } catch (err) {
    console.error(`[sync] Error pulling ${tableName} from Supabase:`, err)
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
      // Indexed read - fetches only rows for THIS table (via the
      // 'table_name' index), not the whole store. For a hospital with
      // 50k rows across 30 tables, this turns a 50k-row scan into a
      // 1-2k-row scan per hook instance.
      const rows = await getLocalRecordsByTable(db, tableName, hospitalId)
      if (seq !== loadSeqRef.current) return // a newer read superseded this one

      const filtered = rows.filter(
        (record) => !record._deleted && !record.deleted_at
      )

      setRecords(filtered)

      // Pending count via the SAFE cursor-based countPendingRecords()
      // (NOT index.getAll(false) - booleans are not valid IDB keys and
      // would throw DataError on every call).
      const pending = await countPendingRecords(db)
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
    // Track the last time we pulled from Supabase for this table. Used
    // by the cache-hit background pull and the visibilitychange handler
    // below so we never hammer the server (min 5s between pulls).
    let lastPullAt = 0
    const MIN_PULL_INTERVAL_MS = 5000

    async function pullFromServer() {
      const now = Date.now()
      if (now - lastPullAt < MIN_PULL_INTERVAL_MS) return
      lastPullAt = now
      try {
        const db = await openDB()
        await pullFromSupabase(db, tableName, hospitalId)
        // Mark cached so concurrent mounts skip the pull (the background
        // pull above just refreshed IndexedDB; they will read it).
        setCachedTable(tableName, hospitalId, [])
      } catch (err) {
        console.error('Error opening DB for pull:', err)
      }
    }

    async function initialLoad() {
      // ---- Check global cache first ----
      // If another component already loaded this table, use the cached
      // IndexedDB data instead of fetching from Supabase again.
      // The cache is invalidated on any local write or realtime update.
      const cached = getCachedTable(tableName, hospitalId)
      if (cached) {
        // Cache hit — read from IndexedDB immediately so the UI shows
        // data without waiting for a network round-trip.
        await loadLocalRecords()

        // FIX (option C): a cache hit used to `return` here, meaning
        // the hook NEVER re-pulled from Supabase until the 30-minute
        // cache TTL expired. If realtime silently failed (table not in
        // the supabase_realtime publication, network blip, cold start),
        // the user only ever saw stale data — F5 was the only way out.
        //
        // Now we kick off a background pull. The user sees the cached
        // data instantly, and any new rows arrive a second later via
        // notifyLocalChange() -> loadLocalRecords(). Throttled to once
        // per 5s so concurrent mounts of the same table don't stack.
        if (hospitalId && navigator.onLine) {
          pullFromServer()
        }
        return
      }

      if (hospitalId) {
        // Cache miss — this is the first mount for this table. Pull
        // from Supabase, then mark cached so later mounts skip the
        // pull and just read IndexedDB.
        await pullFromServer()
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

    // FIX (option B): when the user tabs away from the browser, the OS
    // throttles setInterval to ~once/min (and hard-pauses it on mobile).
    // When they come back, there was no "you're back, re-pull now"
    // handler — they had to wait for the next 30s poll tick or hit F5.
    // Now: the moment the tab becomes visible again, we re-pull this
    // table from Supabase (throttled by MIN_PULL_INTERVAL_MS so rapid
    // tab-switching doesn't stack requests). This is the single most
    // impactful fix for "I have to refresh to see the doctor's changes"
    // because most clinical workflows involve tab-switching.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hospitalId && navigator.onLine) {
        // Reuse the throttled pull helper defined above in this effect.
        pullFromServer().then(() => loadLocalRecords())
      }
    }

    // FIX (option B): same idea for window focus — covers the case
    // where the tab is visible but the user was in another app
    // (e.g. an email client) and just clicked back into the browser.
    const handleFocus = () => {
      if (hospitalId && navigator.onLine) {
        pullFromServer().then(() => loadLocalRecords())
      }
    }

    // FIX: listen for 'gmh:session-cleared' and 'gmh:force-resync' so
    // the hook resets its React state when forceResync() is called or
    // the user logs out. Without this, React keeps stale records in
    // memory even after IndexedDB has been cleared.
    const handleSessionCleared = () => {
      setRecords([])
      setPendingCount(0)
      pendingCountRef.current = 0
      setLoading(true)
      loadSeqRef.current += 1 // invalidate any in-flight read
    }

    const handleForceResync = async () => {
      // IndexedDB was just deleted - re-open it and re-pull.
      handleSessionCleared()
      if (hospitalId) {
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
        } catch (err) {
          console.error(`[force-resync] Re-pull of ${tableName} failed:`, err)
        }
      }
      await loadLocalRecords()
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('gmh:session-cleared', handleSessionCleared)
    window.addEventListener('gmh:force-resync', handleForceResync)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)

    return () => {
      clearInterval(retryTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('gmh:session-cleared', handleSessionCleared)
      window.removeEventListener('gmh:force-resync', handleForceResync)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
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
      _syncAttempts: 0,
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
            _syncAttempts: 0,
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
      await pullFromSupabase(db, tableName, hospitalId)
      await loadLocalRecords()
      // Re-populate the cache
      setCachedTable(tableName, hospitalId, [])
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
          _syncAttempts: 0,
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

        // Permission (RLS 42501) errors will NEVER succeed by retrying —
        // the row is rejected by a database policy, and no amount of
        // re-sending changes that. Previously these retried on every
        // flush and jammed the sync queue forever (the user saw a
        // permanent "Sync queue · N items waiting" banner with only
        // Retry/Skip, and Retry always failed again).
        //
        // Cap permission-error retries: after PERM_MAX_ATTEMPTS failed
        // attempts, auto-discard the row (same as the explicit "Skip"
        // button — _synced=true, _discarded=true) so the queue drains
        // and the user is not permanently blocked. The data loss is
        // explicit and auditable via _discardedAt, and the original
        // error message is preserved in _syncErrorMessage.
        const PERM_MAX_ATTEMPTS = 3
        const attempts = (record._syncAttempts || 0) + 1

        if (kind === 'permission' && attempts >= PERM_MAX_ATTEMPTS) {
          console.warn(
            `Auto-discarding ${record.table_name} row ${record.id}: ` +
            `permission error persisted ${attempts}× (RLS policy denies this row). ` +
            `Original error: ${error?.message || error}`
          )
          await putLocalRecord(db, {
            ...record,
            _synced: true,
            _discarded: true,
            _discardedAt: nowISO(),
            _syncError: false,
            _syncErrorMessage: friendlyErrorMessage(error, record.table_name, op),
            _syncErrorKind: null,
            _syncAttempts: attempts,
          })
          continue
        }

        await putLocalRecord(db, {
          ...record,
          _synced: false,
          _syncError: true,
          _syncErrorKind: kind,
          _syncErrorMessage: friendlyErrorMessage(error, record.table_name, op),
          _syncAttempts: attempts,
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


// =====================================================================
// FORCE RESYNC - nuclear option for when IndexedDB is broken or stale.
//
// Deletes the ENTIRE IndexedDB database, clears the in-memory cache,
// and signals every mounted useOfflineTable instance to re-pull from
// Supabase. Use this when:
//   - The dashboard RPC shows data (e.g. "47 patients") but the
//     Patients tab shows "No patients yet".
//   - The browser console shows VersionError on openDB().
//   - Data added directly in Supabase is not appearing in the app.
//   - The app was offline for a long time and you want a fresh pull.
//
// WARNING: any LOCAL-ONLY unsynced changes will be LOST. The function
// first attempts to flush the queue, but if IndexedDB itself is broken,
// the flush will fail and those changes are gone.
//
// After calling this, every useOfflineTable hook re-mounts, opens the
// fresh database, and pulls from Supabase automatically.
// =====================================================================

export async function forceResync() {
  console.warn('[forceResync] Starting full resync - deleting IndexedDB and clearing all caches.')

  // 1. Try to flush any unsynced changes (may fail if DB is broken).
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      await flushTableQueue(null, { force: true })
    }
  } catch (err) {
    console.error('[forceResync] Flush before wipe failed (continuing):', err)
  }

  // 2. Clear the in-memory table cache so the next mount re-pulls.
  try {
    clearAllCache()
  } catch (err) {
    console.error('[forceResync] clearAllCache failed:', err)
  }

  // 3. Delete the entire IndexedDB database.
  try {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve() // ignore - we still want to continue
      req.onblocked = () => {
        console.warn('[forceResync] Delete blocked by another tab. Close other tabs and reload.')
        resolve()
      }
    })
  } catch (err) {
    console.error('[forceResync] deleteDatabase failed:', err)
  }

  // 4. Signal every mounted hook to reset state and re-pull.
  window.dispatchEvent(new CustomEvent('gmh:session-cleared'))
  // Small delay so the session-cleared handlers reset state BEFORE the
  // force-resync handlers try to re-pull (otherwise openDB can race).
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('gmh:force-resync'))
  }, 50)

  console.warn('[forceResync] Done. Every table will re-pull from Supabase automatically.')
}

// Browser-console helpers (attached once on module load).
if (typeof window !== 'undefined') {
  if (!window.__gmhForceResync) {
    window.__gmhForceResync = () => forceResync()
  }
  if (!window.__gmhDiagnoseSync) {
    window.__gmhDiagnoseSync = async function diagnoseSync() {
      const out = { timestamp: new Date().toISOString() }
      // Browser + IndexedDB support
      out.indexedDBSupported = typeof indexedDB !== 'undefined'
      out.navigatorOnLine = typeof navigator !== 'undefined' ? navigator.onLine : 'unknown'
      // Existing databases
      try {
        if (indexedDB.databases) {
          out.databases = (await indexedDB.databases()).map((d) => ({
            name: d.name,
            version: d.version,
          }))
        } else {
          out.databases = 'indexedDB.databases() not supported in this browser'
        }
      } catch (e) {
        out.databases = 'error: ' + e.message
      }
      // Try opening our DB and counting rows
      try {
        const db = await openDB()
        const all = await getAllLocalRecords(db)
        const byTable = {}
        for (const r of all) {
          byTable[r.table_name] = (byTable[r.table_name] || 0) + 1
        }
        out.totalLocalRecords = all.length
        out.recordsByTable = byTable
        out.pending = all.filter((r) => r._synced === false && r._discarded !== true).length
      } catch (e) {
        out.openDBError = { name: e.name, message: e.message }
      }
      // Supabase session
      try {
        const { data } = await supabase.auth.getSession()
        out.session = data.session
          ? { user_id: data.session.user.id, email: data.session.user.email }
          : null
      } catch (e) {
        out.sessionError = e.message
      }
      // Profile + hospital
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, role, hospital_id')
          .maybeSingle()
        out.profile = profile
        if (profile && profile.hospital_id) {
          const { data: h, error } = await supabase
            .from('hospitals')
            .select('id, name')
            .eq('id', profile.hospital_id)
            .maybeSingle()
          out.hospital = h
          if (error) out.hospitalError = { code: error.code, message: error.message }
          // Try a direct read on patients to see if RLS allows it
          const { data: pts, error: ptsErr, count } = await supabase
            .from('patients')
            .select('id', { count: 'exact', head: true })
            .eq('hospital_id', profile.hospital_id)
          out.patientsRLS = ptsErr
            ? { error: ptsErr.message, code: ptsErr.code }
            : { count }
        }
      } catch (e) {
        out.profileError = e.message
      }
      console.log('%c[G-MedHub Sync Diagnostic]', 'color:#c9a961;font-weight:bold', out)
      return out
    }
  }
}

// =====================================================================
// ELGOODIE-COMPATIBILITY STUBS
//
// The ELGOODIE-SaaS branch exports several functions that the V2 branch
// does not have (cursor tracking, conflict resolution, sync
// diagnostics). If the user deploys the V2 useOfflineTable.js but keeps
// the ELGOODIE AuthContext.jsx (or any other ELGOODIE component that
// imports these functions), the Vite build fails with:
//   "clearCursorsOnHospitalSwitch" is not exported by "src/lib/useOfflineTable.js"
// These no-op stubs make the build succeed regardless. Each logs a
// one-time warning; none affect the V2 data flow.
// =====================================================================

const _stubWarned = new Set()
function _stubWarn(name) {
  if (_stubWarned.has(name)) return
  _stubWarned.add(name)
  console.warn(
    `[useOfflineTable] "${name}" is a no-op stub in the V2 branch. ` +
    `It exists only so ELGOODIE-SaaS components can import it without breaking the build. ` +
    `This message will not repeat.`
  )
}

export async function clearCursorsOnHospitalSwitch(oldHospitalId) {
  _stubWarn('clearCursorsOnHospitalSwitch')
  // V2 does full pulls every time, so there are no cursors to clear.
  // Returning void matches the ELGOODIE signature.
  return undefined
}

export async function resetTableCursor(tableName, hospitalId) {
  _stubWarn('resetTableCursor')
  return undefined
}

export async function getSyncDiagnostics(hospitalId = null) {
  _stubWarn('getSyncDiagnostics')
  return {
    installationId: 'v2-stub',
    totalRecords: 0,
    pending: 0,
    conflicts: 0,
    discarded: 0,
    errors: 0,
  }
}

export async function getAllConflicts(hospitalId = null) {
  _stubWarn('getAllConflicts')
  return []
}

export async function resolveConflictAcceptLocal(originalId, tableName) {
  _stubWarn('resolveConflictAcceptLocal')
  return { ok: false, reason: 'conflict resolution is not supported in the V2 branch' }
}

export async function resolveConflictAcceptRemote(originalId, tableName) {
  _stubWarn('resolveConflictAcceptRemote')
  return { ok: false, reason: 'conflict resolution is not supported in the V2 branch' }
}

export async function resolveConflictMerge(originalId, tableName, mergedRow, fieldDecisions) {
  _stubWarn('resolveConflictMerge')
  return { ok: false, reason: 'conflict resolution is not supported in the V2 branch' }
}

export function setActiveSession(session) {
  _stubWarn('setActiveSession')
  return undefined
}
