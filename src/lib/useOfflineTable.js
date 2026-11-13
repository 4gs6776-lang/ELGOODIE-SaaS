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
// v3 → v5: adds compound index ['table_name','hospital_id'] for fast
// scoped reads without the boolean-_synced problem. Also adds the
// 'bootstrap_meta' store for tracking remote row counts per table.
// Existing records are preserved — the upgrade only adds indexes.
const DB_VERSION = 5

const STORE_NAME = 'offline_records'
const META_STORE = 'bootstrap_meta'

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

      // Create the offline_records store if it doesn't exist (fresh DB)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('table_name', 'table_name', { unique: false })
        store.createIndex('hospital_id', 'hospital_id', { unique: false })
        store.createIndex('synced', '_synced', { unique: false })
        // v5: compound index using ONLY string/UUID keys — never boolean.
        // This allows IDBKeyRange.only([tableName, hospitalId]) which is
        // O(log n) instead of O(n) full-scan + JS filter.
        store.createIndex('table_hospital', ['table_name', 'hospital_id'], { unique: false })
      } else if (oldVersion < 5) {
        // Upgrade from v3/v4 — add the compound index to the existing store.
        const store = event.target.transaction.objectStore(STORE_NAME)
        if (!store.indexNames.contains('table_hospital')) {
          store.createIndex('table_hospital', ['table_name', 'hospital_id'], { unique: false })
        }
      }

      // v5: bootstrap_meta store — tracks remote row counts so we can
      // distinguish a legitimately empty table from lost local data.
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
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
// GET ALL LOCAL RECORDS (full scan — use sparingly)
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
// GET LOCAL RECORDS FOR A SPECIFIC TABLE + HOSPITAL (indexed)
//
// Uses the compound index ['table_name', 'hospital_id'] with
// IDBKeyRange.only([tableName, hospitalId]). This is O(log n)
// instead of the previous O(n) full-scan + JS filter.
//
// IMPORTANT: the compound index uses ONLY string/UUID keys — never
// the boolean _synced field. Boolean values in IndexedDB compound
// indexes are unreliable (true/false sort as 0/1 but IDBKeyRange
// queries with numeric literals don't match boolean values).
// ============================================================

async function getLocalRecordsFor(db, tableName, hospitalId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    if (store.indexNames.contains('table_hospital')) {
      const idx = store.index('table_hospital')
      const req = idx.getAll(IDBKeyRange.only([tableName, hospitalId]))
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    } else {
      // Fallback for old DB versions that haven't upgraded yet
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

// ============================================================
// BOOTSTRAP METADATA
//
// Tracks the remote row count after a successful full pull. This
// lets us distinguish a legitimately empty table (remoteRowCount=0,
// localCount=0 — correct) from lost local data (remoteRowCount=47,
// localCount=0 — needs recovery pull).
//
// Also stores the bootstrap timestamp so we know when the last
// successful full pull happened.
// ============================================================

function bootstrapKey(hospitalId, tableName) {
  return `${hospitalId}|${tableName}`
}

async function getBootstrapMeta(db, hospitalId, tableName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const req = store.get(bootstrapKey(hospitalId, tableName))
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function setBootstrapMeta(db, hospitalId, tableName, remoteRowCount) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    const record = {
      key: bootstrapKey(hospitalId, tableName),
      hospitalId,
      tableName,
      remoteRowCount,
      bootstrappedAt: nowISO(),
      updatedAt: nowISO(),
    }
    store.put(record)
    tx.oncomplete = () => resolve(record)
    tx.onerror = () => reject(tx.error)
  })
}

async function isTableBootstrapped(db, hospitalId, tableName) {
  const meta = await getBootstrapMeta(db, hospitalId, tableName)
  return Boolean(meta?.bootstrappedAt)
}

// ============================================================
// SINGLE-FLIGHT GUARD
//
// Prevents duplicate full pulls when multiple useOfflineTable
// instances mount simultaneously for the same (hospitalId, tableName).
// The first caller does the pull; subsequent callers await the same
// promise and get the same result.
// ============================================================

const inflightPulls = new Map()

function getPullKey(hospitalId, tableName) {
  return `${hospitalId}|${tableName}`
}

function getOrCreatePull(hospitalId, tableName, pullFn) {
  const key = getPullKey(hospitalId, tableName)
  if (inflightPulls.has(key)) {
    return inflightPulls.get(key)
  }
  const promise = pullFn().finally(() => {
    inflightPulls.delete(key)
  })
  inflightPulls.set(key, promise)
  return promise
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

    if (error || !data) return null
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) return rows
  }
  console.warn(`Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit).`)
  return rows
}

async function pullFromSupabase(db, tableName, hospitalId) {
  if (!navigator.onLine || !supabase?.from || !hospitalId) return

  // Single-flight guard: if another component already started a pull
  // for this (hospitalId, tableName), await the same promise instead
  // of duplicating the network request.
  await getOrCreatePull(hospitalId, tableName, async () => {
    try {
      const remoteRows = await fetchAllRemoteRows(tableName, hospitalId)

      if (!remoteRows) return

      const localRows = await getLocalRecordsFor(db, tableName, hospitalId)
      const localById = new Map(localRows.map((r) => [r.id, r]))

      for (const remote of remoteRows) {
        const local = localById.get(remote.id)

        // Don't overwrite a record that has local changes waiting to sync
        // (e.g. an edit or delete made offline that hasn't gone up yet).
        if (local && local._synced === false) continue

        await putLocalRecord(db, {
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

      // Store bootstrap metadata: remote row count + timestamp.
      // This lets us distinguish a legitimately empty table
      // (remoteRowCount=0) from lost local data (remoteRowCount>0
      // but localCount=0 after a purge).
      await setBootstrapMeta(db, hospitalId, tableName, remoteRows.length)
    } catch (err) {
      console.error(`Error pulling ${tableName} from Supabase:`, err)
    }
  })
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
      // Use the compound index for O(log n) scoped reads instead of
      // O(n) full-scan + JS filter.
      const scoped = await getLocalRecordsFor(db, tableName, hospitalId)
      if (seq !== loadSeqRef.current) return // a newer read superseded this one

      const filtered = scoped.filter(
        (record) => !record._deleted && !record.deleted_at
      )

      setRecords(filtered)

      // Pending count is scoped to this table + hospital
      const pending = scoped.filter(
        (record) => record._synced === false && record._discarded !== true
      )
      setPendingCount(pending.length)
      pendingCountRef.current = pending.length
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
      // If another component already loaded this table, use the cached
      // IndexedDB data instead of fetching from Supabase again.
      // The cache is invalidated on any local write or realtime update.
      const cached = getCachedTable(tableName, hospitalId)
      if (cached) {
        // Cache hit — just read from IndexedDB (which is already populated)
        await loadLocalRecords()
        // Subscribe to cache invalidation so we re-read when other
        // components write to the same table
        return
      }

      if (hospitalId) {
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
          // Mark this table as cached so other components skip the pull
          setCachedTable(tableName, hospitalId, [])
        } catch (err) {
          console.error('Error opening DB for initial pull:', err)
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

    // Reset in-memory state when the session is cleared (logout).
    // Without this, the React `records` state retains the previous
    // user's patient list even after IndexedDB is cleared.
    const handleSessionCleared = () => {
      setRecords([])
      setPendingCount(0)
      pendingCountRef.current = 0
      setLoading(true)
      setLoadError(null)
      loadSeqRef.current += 1  // invalidate any in-flight reads
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('gmh:session-cleared', handleSessionCleared)

    return () => {
      clearInterval(retryTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('gmh:session-cleared', handleSessionCleared)
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
      const localRows = await getLocalRecordsFor(countDb, 'patients', hospitalId)
      const localCount = localRows.filter(
        (r) => !r._deleted && !r.deleted_at
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
  // PRESERVE unsynced records (they will sync on next login).
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

    // Clear bootstrap metadata so next login does a fresh full pull.
    try {
      const tx = db.transaction(META_STORE, 'readwrite')
      tx.objectStore(META_STORE).clear()
      await new Promise((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve() })
    } catch (_e) { /* non-fatal */ }
  } catch (err) {
    console.error('Could not clear local records on logout:', err)
  }

  // 3. Clear the in-memory table cache so the next user does not see
  // the previous user's cached data. This was previously dead code —
  // clearAllCache was imported but never called.
  try {
    clearAllCache()
  } catch (_e) { /* non-fatal */ }

  // 4. Broadcast session-cleared so mounted useOfflineTable hooks
  // reset their React state.
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gmh:session-cleared'))
    }
  } catch (_e) { /* non-fatal */ }

  // 5. Remove cached API responses saved by the service worker.
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

// ============================================================
// CLEAR CURSORS ON HOSPITAL SWITCH
//
// This version does not have per-device cursors (no sync_cursors
// store). The function exists as a no-op so AuthContext.jsx
// (which imports it) resolves at build time. If per-device
// cursors are added later, implement the actual cursor clearing
// here.
// ============================================================
export async function clearCursorsOnHospitalSwitch(_oldHospitalId) {
  // No-op in this version — no cursors to clear.
  // The useTableCache TTL (5 min) handles cache invalidation.
  return
}

// ============================================================
// CONFLICT RESOLUTION STUBS
//
// The ELGOODIE-SaaS version of AuthContext.jsx and Dashboard.jsx
// import these functions. This version (1c38d27a) does not have
// per-device cursors, _version columns, or sync_conflicts table,
// so conflict detection/resolution is not active. These stubs
// exist so the imports resolve at build time. They return empty
// results — no conflicts can exist without the conflict
// infrastructure.
// ============================================================
export async function getAllConflicts(_hospitalId) {
  return []
}

export async function resolveConflictAcceptLocal(_originalId, _tableName) {
  return false
}

export async function resolveConflictAcceptRemote(_originalId, _tableName) {
  return false
}

export async function resolveConflictMerge(_originalId, _tableName, _mergedRow, _fieldDecisions) {
  return false
}
