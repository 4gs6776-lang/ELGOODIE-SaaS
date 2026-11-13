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
// FIX: Bumped from 3 → 5 to match the ELGOODIE-SaaS branch (which used 4).
// If the user previously deployed ELGOODIE (v4) and now deploys V2 (was v3),
// IndexedDB.open(DB_NAME, 3) throws VersionError because the browser's
// database is already at v4. This silently broke the ENTIRE sync layer —
// every pull failed, IndexedDB stayed empty, and every module showed
// "No patients yet" / "No data" while the dashboard RPC (which bypasses
// IndexedDB) still showed real counts. Bumping to 5 forces an
// onupgradeneeded that creates any missing stores/indexes and keeps
// the existing data.
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

      // Create the main store if it doesn't exist (v1 → v5)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('table_name', 'table_name', { unique: false })
        store.createIndex('hospital_id', 'hospital_id', { unique: false })
        store.createIndex('synced', '_synced', { unique: false })
      } else if (oldVersion < 4) {
        // Upgrading from v1/v2/v3 → add any missing indexes that the
        // ELGOODIE branch may have created. createIndex is idempotent
        // against the name but throws if the name is taken with a
        // different keyPath, so we probe.
        const store = event.target.transaction.objectStore(STORE_NAME)
        if (!store.indexNames.contains('synced')) {
          store.createIndex('synced', '_synced', { unique: false })
        }
      }
      // v4 → v5: no schema change needed, just bumping the version
      // so future V2 deployments don't collide with ELGOODIE's v4.
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
      // HIGHER version than the code expects (e.g. user previously ran
      // ELGOODIE v4, now runs V2 v5 — or vice versa), indexedDB.open
      // fires onerror with error.name === 'VersionError'. The previous
      // code just rejected the promise, which meant EVERY subsequent
      // openDB() call also failed, and the entire sync layer was dead.
      //
      // Recovery: delete the database entirely and re-open. This
      // loses any LOCAL-ONLY records (unsynced changes), but since the
      // data is also in Supabase, the pull will re-download everything.
      // The alternative — leaving the user with a permanently broken
      // app — is worse.
      const err = request.error
      if (err && err.name === 'VersionError') {
        console.warn(
          `[openDB] VersionError — browser DB version is higher than code version (${DB_VERSION}). ` +
          `Deleting the database and recreating it. Local-only unsynced changes will be lost; ` +
          `all server data will be re-pulled automatically.`
        )
        // Delete the database, then retry openDB.
        const deleteReq = indexedDB.deleteDatabase(DB_NAME)
        deleteReq.onsuccess = () => {
          // Retry the open — this time there's no existing database, so
          // onupgradeneeded will fire and create everything fresh.
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
        deleteReq.onerror = () => reject(err) // give up with the original error
        deleteReq.onblocked = () => {
          console.warn('[openDB] Delete blocked by another tab. Close other tabs and reload.')
          reject(new Error('Could not upgrade the local database — another tab is blocking it. Close all tabs of this app and reload the page.'))
        }
        return
      }

      reject(err)
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

    if (error) {
      // FIX: log the actual error so the user can see WHY the pull
      // failed. Previously this silently returned null, and the user
      // had no idea the pull was broken. Common causes:
      //   - 42501: RLS policy denied the read (the user's profile
      //     may not have hospital_id set, or the table has no RLS
      //     policy that matches).
      //   - PGRST204: a column in select('*') does not exist in the
      //     schema cache (the table was altered but PostgREST has
      //     not refreshed).
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
      console.info(`[sync] Pull of ${tableName} complete: ${rows.length} row(s) fetched.`)
      return rows
    }
  }
  console.warn(`Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit).`)
  return rows
}

async function pullFromSupabase(db, tableName, hospitalId) {
  if (!navigator.onLine) {
    console.warn(`[sync] Pull of ${tableName} skipped — browser is offline.`)
    return
  }
  if (!supabase?.from) {
    console.error(`[sync] Pull of ${tableName} skipped — Supabase client is not initialised. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars.`)
    return
  }
  if (!hospitalId) {
    console.warn(`[sync] Pull of ${tableName} skipped — no hospitalId provided.`)
    return
  }

  try {
    const remoteRows = await fetchAllRemoteRows(tableName, hospitalId)

    if (!remoteRows) {
      // fetchAllRemoteRows already logged the error.
      return
    }

    if (remoteRows.length === 0) {
      console.info(`[sync] Pull of ${tableName} returned 0 rows. If the table has data in Supabase, check the RLS policy (hospital_id = current_hospital_id() or is_owner()).`)
      return
    }

    const localRows = await getAllLocalRecords(db)
    const localById = new Map(localRows.map((r) => [r.id, r]))

    let upserted = 0
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
        // Soft-deleted rows stay in the local store but are hidden from lists.
        _deleted: Boolean(remote.deleted_at),
        _syncError: false,
        _syncErrorMessage: null,
        _syncErrorKind: null,
      })
      upserted += 1
    }
    console.info(`[sync] Pull of ${tableName} merged ${upserted}/${remoteRows.length} row(s) into IndexedDB.`)
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
      const all = await getAllLocalRecords(db)
      if (seq !== loadSeqRef.current) return // a newer read superseded this one

      const filtered = all.filter(
        (record) =>
          record.table_name === tableName &&
          record.hospital_id === hospitalId &&
          !record._deleted &&
          !record.deleted_at
      )

      setRecords(filtered)

      const pending = all.filter(
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

    // FIX: listen for the 'gmh:session-cleared' and 'gmh:force-resync'
    // events so the hook resets its state when forceResync() is called
    // or when the user logs out. Without this, the React state retains
    // stale records in memory even after IndexedDB is cleared.
    const handleSessionCleared = () => {
      setRecords([])
      setPendingCount(0)
      pendingCountRef.current = 0
      setLoading(true)
      loadSeqRef.current += 1 // invalidate any in-flight read
    }

    const handleForceResync = async () => {
      // IndexedDB was just deleted — re-open it and re-pull.
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

    return () => {
      clearInterval(retryTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('gmh:session-cleared', handleSessionCleared)
      window.removeEventListener('gmh:force-resync', handleForceResync)
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
// ELGOODIE-COMPATIBILITY STUBS
//
// The ELGOODIE-SaaS branch of this codebase exports several functions
// that the V2 branch does not have (cursor tracking, conflict resolution,
// sync diagnostics). If the user deploys the V2 useOfflineTable.js but
// keeps the ELGOODIE AuthContext.jsx (or any other ELGOODIE component
// that imports these functions), the Vite build fails with:
//
//   "clearCursorsOnHospitalSwitch" is not exported by "src/lib/useOfflineTable.js"
//
// To make the V2 patch build regardless of which sibling files are
// present, we export no-op stubs for every ELGOODIE-only function.
// Each stub logs a one-time warning so the user knows it's a stub,
// then returns a safe empty value. None of these affect the V2 data
// flow — they only exist so the import statements resolve.
// =====================================================================

const _stubWarned = new Set()
function stubWarn(name) {
  if (_stubWarned.has(name)) return
  _stubWarned.add(name)
  console.warn(
    `[useOfflineTable] "${name}" is a no-op stub in the V2 branch. ` +
    `It exists only so ELGOODIE-SaaS components can import it without breaking the build. ` +
    `This message will not repeat.`
  )
}

// ELGOODIE tracks per-table sync cursors so incremental pulls can resume
// from where the last pull left off. V2 does a full pull every time, so
// there are no cursors to clear. The stub is a safe no-op.
export async function clearCursorsOnHospitalSwitch(oldHospitalId) {
  if (!oldHospitalId) return
  stubWarn('clearCursorsOnHospitalSwitch')
  // V2 has no cursor store — nothing to clear. The next pull will
  // re-download everything for the new hospital anyway.
  return
}

// ELGOODIE: resets the cursor for a single table so the next sync is a
// full pull. V2 always does a full pull, so this is a no-op.
export async function resetTableCursor(tableName, hospitalId) {
  stubWarn('resetTableCursor')
  return
}

// ELGOODIE: returns diagnostics for the sync queue panel. V2's queue
// panel uses getAllSyncErrors() instead. This stub returns zeros so
// the panel renders without crashing.
export async function getSyncDiagnostics(hospitalId = null) {
  stubWarn('getSyncDiagnostics')
  return {
    installationId: 'v2-stub',
    totalRecords: 0,
    pending: 0,
    conflicts: 0,
    discarded: 0,
    errors: 0,
  }
}

// ELGOODIE: returns conflict-stuck records for the ConflictReviewPanel.
// V2 does not have conflict detection (no _conflict field), so this
// returns an empty array.
export async function getAllConflicts(hospitalId = null) {
  stubWarn('getAllConflicts')
  return []
}

// ELGOODIE: conflict resolution actions. V2 has no conflicts to resolve.
export async function resolveConflictAcceptLocal(originalId, tableName) {
  stubWarn('resolveConflictAcceptLocal')
  return { ok: false, reason: 'no-conflict-feature-in-v2' }
}

export async function resolveConflictAcceptRemote(originalId, tableName) {
  stubWarn('resolveConflictAcceptRemote')
  return { ok: false, reason: 'no-conflict-feature-in-v2' }
}

export async function resolveConflictMerge(originalId, tableName, mergedRow, fieldDecisions) {
  stubWarn('resolveConflictMerge')
  return { ok: false, reason: 'no-conflict-feature-in-v2' }
}

// ELGOODIE's AuthContext calls setActiveSession() to stamp the current
// user on the sync layer. V2 doesn't need this — the Supabase client
// manages the session internally. Stub so the import resolves.
export function setActiveSession(session) {
  stubWarn('setActiveSession')
  return
}

// =====================================================================
// FORCE RESYNC — nuclear option for when IndexedDB is broken or stale.
//
// Deletes the ENTIRE IndexedDB database, clears the in-memory cache,
// and signals every mounted useOfflineTable instance to re-pull from
// Supabase. Use this when:
//
//   - The dashboard RPC shows data (e.g. "47 patients") but the
//     Patients tab shows "No patients yet".
//   - The browser console shows VersionError on openDB().
//   - Data added directly in Supabase (e.g. via the SQL editor) is
//     not appearing in the app.
//   - The app was offline for a long time and you want a fresh pull.
//
// WARNING: any LOCAL-ONLY unsynced changes (records created while
// offline that have not yet been pushed to Supabase) will be LOST.
// The function first attempts to flush the queue, but if IndexedDB
// itself is broken, the flush will fail and those changes are gone.
//
// After calling this, reload the page — every useOfflineTable hook
// will re-mount, open the fresh database, and pull from Supabase.
// =====================================================================

export async function forceResync() {
  console.warn('[forceResync] Starting full resync — deleting IndexedDB and clearing all caches.')

  // 1. Try to flush any unsynced changes (may fail if DB is broken).
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      await flushTableQueue(null, { force: true })
    }
  } catch (err) {
    console.warn('[forceResync] Flush before resync failed (expected if DB is broken):', err)
  }

  // 2. Clear the in-memory table cache so every component re-pulls.
  try {
    clearAllCache()
  } catch (err) {
    console.warn('[forceResync] Could not clear in-memory cache:', err)
  }

  // 3. Delete the entire IndexedDB database.
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => {
        console.warn('[forceResync] Delete blocked by another tab. Close other tabs and try again.')
        // Resolve anyway so the page reload can proceed.
        resolve()
      }
    })
    console.info('[forceResync] IndexedDB deleted successfully.')
  } catch (err) {
    console.error('[forceResync] Could not delete IndexedDB:', err)
  }

  // 4. Clear service worker caches.
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys()
      await Promise.all(names.map((n) => caches.delete(n)))
    }
  } catch (err) {
    console.warn('[forceResync] Could not clear service worker caches:', err)
  }

  // 5. Dispatch a custom event so any mounted useOfflineTable instances
  //    can reset their state. The 'gmh:session-cleared' event is already
  //    handled by the hook to reset records to [].
  try {
    window.dispatchEvent(new CustomEvent('gmh:session-cleared'))
    window.dispatchEvent(new CustomEvent('gmh:force-resync'))
  } catch (err) {
    // Non-fatal
  }

  console.info('[forceResync] Done. Reload the page to re-pull all data from Supabase.')
  return { ok: true }
}

// Expose forceResync on window so the user can call it from the
// browser console:  window.__gmhForceResync()
// This is intentionally global — it's a recovery tool, not part of
// the normal API.
if (typeof window !== 'undefined') {
  window.__gmhForceResync = forceResync
  window.__gmhDiagnoseSync = async function () {
    console.group('=== G-MedHub Sync Diagnostic ===')
    try {
      // 1. Check IndexedDB
      console.log('1. IndexedDB databases:')
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases()
        console.table(dbs)
      } else {
        console.log('   (indexedDB.databases() not supported by this browser)')
      }

      // 2. Try to open the database
      console.log('2. Opening database...')
      try {
        const db = await openDB()
        const all = await getAllLocalRecords(db)
        const byTable = {}
        for (const r of all) {
          if (!byTable[r.table_name]) byTable[r.table_name] = 0
          byTable[r.table_name]++
        }
        console.log('   IndexedDB opened OK. Total records:', all.length)
        console.table(byTable)
      } catch (err) {
        console.error('   FAILED to open IndexedDB:', err.name, err.message)
      }

      // 3. Check Supabase session
      console.log('3. Supabase session:')
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
      if (sessionErr) {
        console.error('   No session:', sessionErr)
      } else if (sessionData?.session) {
        console.log('   User:', sessionData.session.user.email)
        console.log('   User ID:', sessionData.session.user.id)
      } else {
        console.warn('   No active session — user is not logged in.')
      }

      // 4. Try a direct read of patients
      console.log('4. Direct Supabase read of patients (first 5):')
      const { data: patients, error: patientsErr } = await supabase
        .from('patients')
        .select('id, full_name, hospital_id, created_at, deleted_at')
        .limit(5)
      if (patientsErr) {
        console.error('   FAILED:', patientsErr.code, patientsErr.message)
        console.log('   This means RLS is blocking the read, or the table does not exist.')
      } else {
        console.log(`   OK — ${patients.length} patient(s) returned.`)
        console.table(patients)
      }

      // 5. Try the dashboard RPC
      console.log('5. Dashboard RPC (get_dashboard_summary):')
      const { data: rpcData, error: rpcErr } = await supabase.rpc('get_dashboard_summary', {
        p_hospital_id: patients?.[0]?.hospital_id || '00000000-0000-0000-0000-000000000000',
        p_days: 7,
      })
      if (rpcErr) {
        console.error('   FAILED:', rpcErr.code, rpcErr.message)
      } else {
        console.log('   OK — RPC returned:')
        console.table(rpcData)
      }

      // 6. Check the user's profile
      if (sessionData?.session?.user?.id) {
        console.log('6. User profile:')
        const { data: profile, error: profileErr } = await supabase
          .from('profiles')
          .select('id, hospital_id, role, full_name')
          .eq('id', sessionData.session.user.id)
          .maybeSingle()
        if (profileErr) {
          console.error('   FAILED:', profileErr)
        } else if (profile) {
          console.log('   Profile:', profile)
          // 7. Check current_hospital_id() vs profile.hospital_id
          console.log('7. RLS check — reading patients with hospital_id = profile.hospital_id:')
          if (profile.hospital_id) {
            const { data: scoped, error: scopedErr } = await supabase
              .from('patients')
              .select('id', { count: 'exact', head: true })
              .eq('hospital_id', profile.hospital_id)
            if (scopedErr) {
              console.error('   FAILED:', scopedErr)
            } else {
              console.log(`   OK — ${scoped?.length || 0} patient(s) visible via RLS (count: ${scoped?.count || 'n/a'}).`)
            }
          } else {
            console.warn('   Profile has no hospital_id — this is likely the cause.')
          }
        } else {
          console.warn('   No profile row found for this user — this is the problem!')
          console.log('   The RLS helper current_hospital_id() returns NULL, so the policy')
          console.log('   `hospital_id = current_hospital_id()` evaluates to NULL (not TRUE),')
          console.log('   and RLS silently filters out ALL rows.')
        }
      }

      console.log('8. To force a full re-sync, run: window.__gmhForceResync()')
    } catch (err) {
      console.error('Diagnostic failed:', err)
    }
    console.groupEnd()
  }
}
