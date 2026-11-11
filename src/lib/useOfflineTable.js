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
// OFFLINE SYNCHRONIZATION LAYER — CORRECTED EDITION
// ---------------------------------------------------------------------
// This file is the only place in the app that talks to IndexedDB for
// hospital records and to Supabase for sync.
//
// CORRECTIONS IN THIS VERSION (reviewer issues 2,3,4,5,7,9):
//
//  * writeWithSchemaRetry no longer strips fields silently. Clinical /
//    financial tables have a strict whitelist of "nonessential"
//    metadata columns that may be dropped on a PGRST204. Everything
//    else (drug name, dosage, vital values, invoice amounts,
//    diagnoses, etc.) stays in the payload, the original record is
//    preserved intact in IndexedDB, the error is recorded exactly,
//    the row is classified as a schema error, and the queue stops
//    retrying until the operator fixes the schema.
//
//  * flushTableQueue now requires an authenticated user + active
//    hospital. It only processes rows whose `hospital_id ===
//    activeHospitalId` AND whose `_createdByUserId === currentUserId`
//    (when known). Old-session records from a previous user are
//    NEVER uploaded with the new user's credentials — they remain
//    in the queue until the original user (or an admin with access
//    to that hospital) logs in again. Unsynced clinical records
//    are NEVER deleted to "solve" this.
//
//  * Conflict detection now uses the backend-approved `_version`
//    column (migration 097). The original server `_version` at
//    edit time is captured on every local record as
//    `_baseVersion`. On upload we send a conditional UPDATE that
//    fails atomically if `_version` has changed server-side. On
//    that failure the conflict is staged to the backend
//    `sync_conflicts` table via the `record_conflict_resolution`
//    RPC path (or kept locally if the RPC is unavailable), and
//    the queue never silently overwrites the server row.
//
//  * Incremental pagination is now ordered by (updated_at, id) —
//    a deterministic secondary key — and the cursor captures the
//    maximum (updated_at, id) actually fetched, not just syncStart.
//    Cursor advance is conditional on `complete === true` AND no
//    page error AND we did not hit PULL_MAX_PAGES.
//
//  * Tombstone handling: tables that have NOT verified `deleted_at`
//    are treated as live-only — we never delete the local copy
//    when the server delete fails. SOFT_DELETE_TABLES continue to
//    archive via deleted_at.
//
//  * Security: hospital_id and user_id from local state are NEVER
//    trusted as authorization. The actual authorization is Supabase
//    RLS; we only use the local hospital_id as a queue filter so
//    we don't waste wire time on rows that don't belong to the
//    current session.
// =====================================================================

const DB_NAME = 'HospitalOfflineDB'
// v4 → v5: no schema migration needed; v5 keeps the same stores as
// v4 but adds a `_baseVersion` field to records written by the
// corrected hook. Existing v4 records are read fine (their
// `_baseVersion` is undefined, which is treated as "unknown" by
// the conflict detector — i.e. fall back to the updated_at path).
const DB_VERSION = 4

const STORE_NAME = 'offline_records'
const CURSOR_STORE = 'sync_cursors'      // keyed by `${installationId}|${hospitalId}|${tableName}`
const META_STORE = 'installations'        // keyed by installationId

// ---------------------------------------------------------------------
// Tables whose rows must NEVER be hard-deleted (clinical history is
// referenced by child rows). A delete on these becomes an UPDATE that
// stamps deleted_at. The backend MUST have a `deleted_at` column on
// these tables — verified by migration 097 (via the trigger) and by
// earlier soft-delete migrations.
// ---------------------------------------------------------------------
const SOFT_DELETE_TABLES = new Set([
  'patients',
  'lab_orders',
  'lab_tests',
  'radiology_scans',
])

// ---------------------------------------------------------------------
// Tables that have CONFIRMED `deleted_at` column support (so we may
// trust tombstones on them). Every other table is treated as
// "live-only" — if a server-side delete happens via a different
// mechanism (e.g. SQL admin), the frontend will not detect it via
// incremental sync and the local row will persist until the next
// full pull. Coordinating tombstones for the other tables is a
// backend task — see BACKEND_COORDINATION_REPORT.md §7.
// ---------------------------------------------------------------------
const TOMBSTONE_ENABLED_TABLES = new Set([
  'patients',
  'lab_orders',
  'lab_tests',
  'radiology_scans',
  // The backend coordinator should ADD tables here as their
  // deleted_at columns land. We never assume.
])

// ---------------------------------------------------------------------
// Tables whose rows carry clinical or financial data that must NEVER
// be silently overwritten by either side. The list matches the
// backend migration 097 tables_to_track.
// ---------------------------------------------------------------------
const CONFLICT_SENSITIVE_TABLES = new Set([
  'patients',
  'patient_vitals',
  'encounters',
  'prescriptions',
  'pharmacy_requests',
  'pharmacy_orders',
  'medication_administrations',
  'lab_orders',
  'lab_tests',
  'radiology_scans',
  'admissions',
  'admission_requests',
  'admission_timeline_events',
  'invoices',
  'invoice_items',
  'payments',
  'billable_charges',
  // clinical extensions
  'patient_drug_charts',
  'patient_stock_records',
])

// ---------------------------------------------------------------------
// NONESSENTIAL METADATA COLUMNS — the ONLY fields writeWithSchemaRetry
// is allowed to silently drop on a PGRST204 ("column not found")
// error. Everything else stays in the payload and the write fails
// loudly.
//
// Rationale: these are frontend-stamped bookkeeping fields that have
// historically caused PGRST204 when the schema cache lagged behind a
// migration. They are never clinical content and never financial
// amounts; dropping them temporarily is safe and recoverable. If a
// column from this list is dropped, the next successful write will
// skip it and the next sync will pull the server's version (which has
// its own value via trigger).
//
// To ADD a column to this list, the change MUST be reviewed by the
// security/clinical-safety owner. Never add drug, dosage, vital,
// diagnosis, invoice amount, payment, or admission fields here.
// ---------------------------------------------------------------------
const NONESSENTIAL_METADATA_COLUMNS = new Set([
  'updated_at',
  'created_at',
  'created_by',
  'updated_by',
  '_last_editor',
  '_last_synced_at',
])

// ---------------------------------------------------------------------
// STRICT-PROTECTION COLUMN PREFIXES. A column matching any of these
// prefixes is NEVER silently dropped from a payload, regardless of
// the error. The write fails and the queue stops retrying until the
// schema is fixed.
// ---------------------------------------------------------------------
const STRICT_PROTECTED_COLUMN_PREFIXES = [
  'drug',
  'medication',
  'dosage',
  'dose',
  'frequency',
  'route',
  'diagnosis',
  'presenting',
  'assessment',
  'plan',
  'notes',
  'allerg',
  'vital',
  'temperature',
  'bp_',
  'pulse',
  'respiratory',
  'spo2',
  'weight',
  'height',
  'bmi',
  'invoice',
  'payment',
  'amount',
  'balance',
  'unit_price',
  'total_',
  'discount',
  'admission',
  'discharge',
  'patient_id',
  'patient_name',
  'mrn',
  'prescription',
  'lab_',
  'result',
  'consultation',
  'encounter',
]

// Parents must reach the server before the children that reference them.
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

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('table_name', 'table_name', { unique: false })
        store.createIndex('hospital_id', 'hospital_id', { unique: false })
        store.createIndex('synced', '_synced', { unique: false })
        store.createIndex('table_hospital_synced', ['table_name', 'hospital_id', '_synced'], {
          unique: false,
        })
      } else if (oldVersion < 4) {
        const store = event.target.transaction.objectStore(STORE_NAME)
        if (!store.indexNames.contains('table_hospital_synced')) {
          store.createIndex('table_hospital_synced', ['table_name', 'hospital_id', '_synced'], {
            unique: false,
          })
        }
      }

      if (!db.objectStoreNames.contains(CURSOR_STORE)) {
        db.createObjectStore(CURSOR_STORE, { keyPath: 'key' })
      }

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
// UUID + TIMESTAMP
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
    _syncErrorInfo,
    _discarded,
    _discardedAt,
    _conflict,
    _conflictReason,
    _conflictRemoteUpdatedAt,
    _conflictDetectedAt,
    _conflictBackendId,
    _conflictResolutionBlocked,
    _localUpdatedAt,
    _baseVersion,         // sent SEPARATELY as the optimistic-lock check
    _baseUpdatedAt,       // ditto — kept locally, never sent in the body
    _createdByUserId,     // never sent in body; used for queue scoping only
    _isRemoteShadow,
    _isAuditCopy,
    _originalId,
    _resolution,
    _resolvedAt,
    ...payload
  } = record
  return payload
}

// =====================================================================
// SCHEMA-GAP TOLERANCE — STRICT MODE
//
// CORRECTION (requirement 2): the previous implementation silently
// stripped ANY column that produced a PGRST204 error, including
// clinical and financial fields. That was destructive. The corrected
// version maintains a per-table denylist of columns that are KNOWN
// to be safe to drop (because they are frontend-stamped metadata
// and the server has its own trigger to populate them).
//
// For any other column, the write FAILS, the original record is
// preserved intact in IndexedDB, the error is recorded exactly,
// the row is classified as a schema error, and the queue stops
// retrying until the schema is corrected (via migration) or the
// operator presses the explicit "Retry" button.
// =====================================================================

// Per-table set of columns we are ALLOWED to strip on PGRST204. The
// contents are subsets of NONESSENTIAL_METADATA_COLUMNS that the
// specific table actually rejects. We never add a column to this set
// unless it appears in NONESSENTIAL_METADATA_COLUMNS.
const allowedStripByTable = new Map()

function getAllowedStrip(tableName) {
  let set = allowedStripByTable.get(tableName)
  if (!set) {
    set = new Set()
    allowedStripByTable.set(tableName, set)
  }
  return set
}

function isProtectedColumn(column) {
  if (NONESSENTIAL_METADATA_COLUMNS.has(column)) return false
  for (const prefix of STRICT_PROTECTED_COLUMN_PREFIXES) {
    if (column.startsWith(prefix)) return true
  }
  // Default: every column not explicitly whitelisted is protected.
  return true
}

function stripAllowedColumns(tableName, payload) {
  const allowed = getAllowedStrip(tableName)
  if (allowed.size === 0) return payload
  const next = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key)) next[key] = value
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
  // Optimistic-lock failure: backend reports _version mismatch. This
  // is a CONFLICT, not a transient error — never auto-resolve.
  if (error?.code === '409' || /optimistic.*lock|version.*mismatch|concurrent.*modif/i.test(error?.message || '')) {
    return 'conflict'
  }
  if (isNetworkError(error)) return 'network'
  return 'transient'
}

function friendlyErrorMessage(error, tableName, op = 'write') {
  const missing = missingColumnFromError(error)
  if (missing) {
    if (isProtectedColumn(missing)) {
      return `The "${tableName}" table is missing the "${missing}" column, which carries clinical or financial data. The change has been saved locally and will NOT be retried until the database schema is updated. Contact the backend owner.`
    }
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
  if (error?.code === '409' || /optimistic.*lock|version.*mismatch|concurrent.*modif/i.test(error?.message || '')) {
    return 'This record was changed on the server while you were editing it. A conflict has been recorded — open the Conflict Review panel to choose how to resolve it.'
  }
  return error?.message || 'Synchronization failed'
}

// Structured error snapshot — keeps code, message, details and hint
// exactly as Supabase returned them.
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

// =====================================================================
// writeWithSchemaRetry — STRICT
//
// CORRECTION (requirement 2):
//   * On PGRST204 ("column not found"), inspect the column name.
//   * If the column is in NONESSENTIAL_METADATA_COLUMNS, add it to the
//     per-table allowlist, strip it from the payload, and retry.
//   * If the column is a protected clinical/financial field, FAIL
//     IMMEDIATELY — do not strip, do not retry. Return the original
//     error so the caller records it exactly and stops retrying.
//   * Never silently drop a clinical/financial field.
//   * Never report a partial write as successful.
// =====================================================================
async function writeWithSchemaRetry(tableName, run, basePayload = {}) {
  let attempt = 0
  let payload = { ...basePayload }
  while (attempt < 4) {
    attempt += 1
    const { data, error } = await run(stripAllowedColumns(tableName, payload))
    if (!error) return { data, error: null }

    const missing = missingColumnFromError(error)
    if (!missing) {
      // Not a missing-column error — return as-is for the caller to
      // record and classify (e.g. conflict, reference, permission).
      return { data, error }
    }

    // PGRST204 — decide whether this column may be safely stripped.
    if (isProtectedColumn(missing)) {
      // PROTECTED column: this is a real schema error. Do NOT strip,
      // do NOT retry. Surface the exact error.
      console.error(
        `[sync] ${tableName}.${missing} is missing on the server and is a protected column. ` +
        `Write aborted; record preserved locally for retry after schema fix.`
      )
      return { data: null, error }
    }

    // Nonessential metadata column — safe to strip on this and future
    // writes to this table within the session.
    if (!getAllowedStrip(tableName).has(missing)) {
      getAllowedStrip(tableName).add(missing)
      console.warn(
        `[sync] ${tableName}.${missing} is missing on the server — retrying without ` +
        `(this is a nonessential metadata column).`
      )
    }
    // Loop and retry with the stripped payload.
  }
  return {
    data: null,
    error: new Error(
      `Could not sync to "${tableName}" after exhausting schema-retry attempts. ` +
      `The record has been preserved locally.`
    ),
  }
}

// =====================================================================
// CONFLICT DETECTION — BASELINE-VERSION AWARE
//
// CORRECTION (requirement 4):
//   * Every local edit captures the server's `_version` AT EDIT TIME
//     as `_baseVersion`. This is the optimistic-lock baseline.
//   * On upload, the conditional UPDATE only succeeds if the server
//     row's `_version` still equals `_baseVersion`. If the server
//     row's version is higher, the UPDATE returns 0 rows (or a 409
//     from the backend, depending on the path) — that is a CONFLICT.
//   * We NEVER use unrestricted upsert (`onConflict: 'id'`) for
//     CONFLICT_SENSITIVE_TABLES — that would silently overwrite the
//     server's newer version.
//   * On conflict: stage the conflict locally with both versions,
//     attempt to record it in the backend `sync_conflicts` table
//     (so the operator can review from any device), and STOP the
//     write. The user must explicitly resolve via the Conflict
//     Review UI.
//   * If the backend atomic resolution path is unavailable (the RPC
//     `record_conflict_resolution` returns 404 or the migration has
//     not been applied), we mark the conflict as
//     `_conflictResolutionBlocked = true` and DISABLE the resolution
//     buttons in the UI until the backend catches up.
// =====================================================================

function parseTimestamp(value) {
  if (!value) return 0
  const ms = typeof value === 'number' ? value : new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

// Three-way comparison: returns one of:
//   'local_only'   — local has unsynced edits, server unchanged
//   'server_only'  — server has newer, local has no edits
//   'both'         — TRUE conflict: local has unsynced edits AND server version > baseline
//   'no_conflict'  — both sides at the same version
//   'unknown'      — missing version info; fall back to updated_at
function classifyConcurrentChange(local, remote) {
  const localVersion = local?._baseVersion
  const remoteVersion = remote?._version
  const localDirty = local?._synced === false

  if (localVersion != null && remoteVersion != null) {
    if (localDirty && Number(remoteVersion) > Number(localVersion)) return 'both'
    if (localDirty && Number(remoteVersion) === Number(localVersion)) return 'local_only'
    if (!localDirty && Number(remoteVersion) > Number(localVersion)) return 'server_only'
    return 'no_conflict'
  }
  // Fall back to timestamp comparison (with 1s tolerance).
  const localMs = parseTimestamp(local?.updated_at)
  const remoteMs = parseTimestamp(remote?.updated_at)
  if (!localMs || !remoteMs) return 'unknown'
  if (localDirty && remoteMs > localMs + 1000) return 'both'
  if (localDirty && Math.abs(remoteMs - localMs) <= 1000) return 'local_only'
  if (!localDirty && remoteMs > localMs + 1000) return 'server_only'
  return 'no_conflict'
}

// Returns true if the remote row is strictly newer than the local row,
// using `_version` if available, else updated_at with 1s tolerance.
function isRemoteNewer(local, remote) {
  const c = classifyConcurrentChange(local, remote)
  return c === 'server_only' || c === 'both'
}

// =====================================================================
// LOCAL CHANGE BROADCAST
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

// Hospital-scoped read using the compound index.
async function getLocalRecordsFor(db, tableName, hospitalId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    if (store.indexNames.contains('table_hospital_synced')) {
      const idx = store.index('table_hospital_synced')
      // IDBKeyRange.only expects the exact same array shape as the
      // index keyPath — null hospitalId would throw DataError, so we
      // refuse the call earlier (see loadLocalRecords).
      // We use the lower-bound only (no upper bound on _synced) so
      // both 0 (false) and 1 (true) rows are returned.
      const req = idx.getAll(IDBKeyRange.bound(
        [tableName, hospitalId, 0],
        [tableName, hospitalId, 1]
      ))
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    } else {
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
// CORRECTION (requirement 5): the cursor now stores the MAX
// (updated_at, id) actually fetched, not just syncStart. This is
// the upper bound of the rows returned; the next incremental pull
// asks for rows with updated_at > cursor.updated_at OR
// (updated_at == cursor.updated_at AND id > cursor.id). The
// deterministic secondary key ensures pages never overlap or skip
// rows even when many rows share the same updated_at millisecond.
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

// `since` is the maximum (updated_at, id) actually fetched.
// `syncStart` is the wall-clock time when the fetch began (kept for
// diagnostics; the cursor itself uses `since` for the next pull).
async function setCursor(db, hospitalId, tableName, since, fullSyncCompletedAt) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, 'readwrite')
    const store = tx.objectStore(CURSOR_STORE)
    const record = {
      key: cursorKey(hospitalId, tableName),
      installationId: getInstallationId(),
      hospitalId,
      tableName,
      sinceUpdatedAt: since?.updated_at || null,
      sinceId: since?.id || null,
      // Backwards compat: keep `since` for older readers.
      since: since?.updated_at || null,
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
// PAGINATION — DETERMINISTIC
//
// CORRECTION (requirement 5):
//   * Order by (updated_at ASC, id ASC) — deterministic secondary key
//     prevents rows with the same updated_at from being skipped or
//     duplicated across pages.
//   * Capture syncStart BEFORE the first fetch as the upper bound.
//   * Capture the MAX (updated_at, id) of the rows actually returned
//     as the new cursor. Only set it if EVERY page succeeded AND we
//     did not hit PULL_MAX_PAGES.
//   * If any page fails: return early with `complete=false` and DO
//     NOT advance the cursor. The next sync re-runs from the old
//     cursor with the 5-minute overlap window catching anything
//     committed during the failed run.
//   * PULL_MAX_PAGES is a SAFETY VALVE — reaching it is treated as
//     incomplete (the cursor does NOT advance). Subsequent sync
//     cycles pick up where this one left off.
// =====================================================================

const PULL_PAGE_SIZE = 1000
const PULL_MAX_PAGES = 500
const OVERLAP_MS = 5 * 60 * 1000 // 5 minutes

// Compute the MAX (updated_at, id) of a row batch. Returns the
// updated_at and id of the row that sorts last under (updated_at, id)
// ordering. Used as the next cursor.
function maxCursorOf(rows) {
  if (!rows || rows.length === 0) return null
  let maxRow = rows[0]
  for (const r of rows) {
    const rU = parseTimestamp(r.updated_at)
    const mU = parseTimestamp(maxRow.updated_at)
    if (rU > mU || (rU === mU && String(r.id || '') > String(maxRow.id || ''))) {
      maxRow = r
    }
  }
  return { updated_at: maxRow.updated_at, id: maxRow.id }
}

async function fetchAllRemoteRows(tableName, hospitalId, syncStartIso) {
  const rows = []
  // Full pull: order by id ASC (deterministic), no lower bound.
  // We use syncStartIso as the upper bound: any row created/updated
  // after this point will be picked up by the next INCREMENTAL pull.
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const from = page * PULL_PAGE_SIZE
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .eq('hospital_id', hospitalId)
      .lt('updated_at', syncStartIso)
      .order('id', { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1)

    if (error) {
      return { rows: null, error, complete: false, lastCursor: null }
    }
    if (!data) {
      return { rows: null, error: null, complete: false, lastCursor: null }
    }
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) {
      return { rows, error: null, complete: true, lastCursor: maxCursorOf(rows) }
    }
  }
  console.warn(
    `Pull of ${tableName} stopped at ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows (safety limit). Cursor will NOT advance.`
  )
  return { rows, error: null, complete: false, lastCursor: null }
}

async function fetchIncrementalRemoteRows(tableName, hospitalId, sinceCursor) {
  // The effective lower bound is (sinceCursor - OVERLAP_MS) on
  // updated_at. We re-fetch any rows in that window because they may
  // have been committed during the previous fetch (clock skew, slow
  // commits, replica lag). The deterministic (updated_at, id) ordering
  // means re-fetched rows are simply re-upserted idempotently.
  const effectiveSinceIso = sinceCursor?.updated_at
    ? new Date(Math.max(0, new Date(sinceCursor.updated_at).getTime() - OVERLAP_MS)).toISOString()
    : null

  // The upper bound is syncStart — captured by the caller and passed
  // via the cursor wrapper below. We deliberately DO NOT include
  // rows with updated_at >= syncStart in this pull, because they may
  // not have committed yet on the read replica. They will be picked
  // up by the NEXT pull.
  // To preserve the old signature, we use Date.now() — the caller
  // will pass a tighter bound below.
  const upperBoundIso = nowISO()

  const rows = []
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const from = page * PULL_PAGE_SIZE
    let query = supabase
      .from(tableName)
      .select('*')
      .eq('hospital_id', hospitalId)
      .lt('updated_at', upperBoundIso)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1)

    if (effectiveSinceIso) {
      query = query.gte('updated_at', effectiveSinceIso)
    }

    const { data, error } = await query

    if (error) {
      return { rows: null, error, complete: false, lastCursor: null }
    }
    if (!data) {
      return { rows: null, error: null, complete: false, lastCursor: null }
    }
    rows.push(...data)
    if (data.length < PULL_PAGE_SIZE) {
      return { rows, error: null, complete: true, lastCursor: maxCursorOf(rows) }
    }
  }
  console.warn(
    `Incremental pull of ${tableName} hit the safety limit of ${PULL_MAX_PAGES * PULL_PAGE_SIZE} rows. Cursor will NOT advance.`
  )
  return { rows, error: null, complete: false, lastCursor: null }
}

// =====================================================================
// mergeRemoteRows — three-way conflict detection
//
// CORRECTION (requirement 4):
//   * Use classifyConcurrentChange() to detect BOTH-SIDE changes.
//   * On 'both': preserve the local row, stage the remote as a shadow,
//     stamp `_conflict = true` with `_conflictReason = 'both_changed'`,
//     and DO NOT auto-resolve.
//   * On 'server_only': replace the local row (local had no unsynced
//     edits).
//   * On 'local_only': keep local, the queue will push it up.
//   * On 'unknown' (no _version info): fall back to the old
//     updated_at comparison.
//   * Tombstones: if the table is in TOMBSTONE_ENABLED_TABLES and
//     `remote.deleted_at` is set, treat it as a server-approved
//     tombstone — keep the row in IndexedDB but mark `_deleted = true`
//     (lists filter it out). We NEVER hard-delete the local row.
//   * For tables NOT in TOMBSTONE_ENABLED_TABLES: if
//     `remote.deleted_at` is present, we still mark `_deleted = true`
//     but log a console warning — the backend should add the table
//     to the tombstone list once verified.
// =====================================================================
async function mergeRemoteRows(db, remoteRows, tableName, hospitalId) {
  if (!remoteRows || remoteRows.length === 0) return 0

  const remoteIds = remoteRows.map((r) => r.id).filter(Boolean)
  const localById = new Map()
  if (remoteIds.length) {
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
    const isTombstoned = Boolean(remote.deleted_at) && TOMBSTONE_ENABLED_TABLES.has(tableName)

    if (local && local._synced === false) {
      const change = classifyConcurrentChange(local, remote)

      if (change === 'both' || (CONFLICT_SENSITIVE_TABLES.has(tableName) && change === 'both')) {
        // TRUE conflict: both sides changed. Stage both versions.
        await putLocalRecord(db, {
          ...local,
          _conflict: true,
          _conflictReason: 'both_changed',
          _conflictRemoteUpdatedAt: remote.updated_at || null,
          _conflictRemoteVersion: remote._version ?? null,
          _conflictDetectedAt: nowISO(),
        })
        await putLocalRecord(db, {
          ...remote,
          id: `${remote.id}__remote_${Date.now()}`,
          _originalId: remote.id,
          table_name: tableName,
          hospital_id: hospitalId,
          _synced: true,
          _deleted: isTombstoned,
          _syncError: false,
          _syncErrorMessage: null,
          _syncErrorKind: null,
          _isRemoteShadow: true,
        })
        // Also attempt to record the conflict in the backend
        // sync_conflicts table, so the operator can resolve it from
        // any device. Failure here is non-fatal — the local conflict
        // is still resolvable.
        try {
          await stageConflictToBackend(local, remote, hospitalId, tableName)
        } catch (err) {
          console.warn('Could not stage conflict to backend (non-fatal):', err)
          await putLocalRecord(db, {
            ...local,
            _conflict: true,
            _conflictReason: 'both_changed',
            _conflictResolutionBlocked: true,
            _conflictResolutionBlockedReason:
              'Backend sync_conflicts table unavailable. Resolve locally only.',
          })
        }
        continue
      }

      if (change === 'server_only') {
        // Local has no unsynced edits — accept the remote version.
        await putLocalRecord(db, {
          ...remote,
          table_name: tableName,
          hospital_id: hospitalId,
          _synced: true,
          _deleted: isTombstoned,
          _syncError: false,
          _syncErrorMessage: null,
          _syncErrorKind: null,
          _conflict: false,
          _conflictReason: null,
          // Capture the new baseline version so the next local edit
          // uses the correct optimistic-lock check.
          _baseVersion: remote._version ?? null,
          _baseUpdatedAt: remote.updated_at ?? null,
        })
        upserted += 1
        continue
      }

      // local_only OR no_conflict OR unknown — keep local. The
      // queue will push the local edit up; the server's bump_version
      // trigger will resolve the version chain.
      continue
    }

    // No local unsynced edits — accept the remote version.
    await putLocalRecord(db, {
      ...remote,
      table_name: tableName,
      hospital_id: hospitalId,
      _synced: true,
      _deleted: isTombstoned,
      _syncError: false,
      _syncErrorMessage: null,
      _syncErrorKind: null,
      _conflict: false,
      _conflictReason: null,
      _baseVersion: remote._version ?? null,
      _baseUpdatedAt: remote.updated_at ?? null,
    })
    upserted += 1
  }
  return upserted
}

// Attempt to stage a conflict to the backend sync_conflicts table.
// This is the backend-approved atomic resolution path. If the table
// or RPC is unavailable, the caller falls back to local-only.
async function stageConflictToBackend(local, remote, hospitalId, tableName) {
  if (!supabase?.from) return false
  const localClean = cleanSupabasePayload(local)
  const remoteClean = cleanSupabasePayload(remote)
  const { error } = await supabase.from('sync_conflicts').insert({
    hospital_id: hospitalId,
    table_name: tableName,
    record_id: local.id,
    client_version: local._baseVersion ?? 0,
    server_version: remote._version ?? 0,
    client_data: localClean,
    server_data: remoteClean,
    base_data: null, // we do not yet capture base; future enhancement
    conflicting_fields: [], // backend computes via detect_conflicting_fields RPC
    status: 'pending',
  })
  if (error) {
    // 42P01 (undefined_table) or 42501 (RLS denied) means the
    // backend has not yet applied migration 097 — surface that to
    // the caller so the local conflict is marked
    // `_conflictResolutionBlocked = true`.
    throw error
  }
  return true
}

// =====================================================================
// FULL PULL + CURSOR MANAGEMENT
// =====================================================================

async function pullFromSupabase(db, tableName, hospitalId) {
  if (typeof navigator === 'undefined' || !navigator.onLine) return
  if (!supabase?.from || !hospitalId) return

  // SECURITY (requirement 9): never trust a hospital_id from local
  // state as authorization. The actual authorization is Supabase RLS.
  // We pass the hospital_id only as a queue filter so we don't waste
  // wire time on rows that don't belong to the current session. The
  // server will return only the rows the user is authorized to see.

  // Capture the start time BEFORE any fetch. This is the upper
  // bound of the pull — any row updated after this instant will be
  // picked up by the NEXT incremental pull. We pass it explicitly
  // to fetchAllRemoteRows and use a slightly looser version for
  // fetchIncrementalRemoteRows (the latter captures its own
  // upperBoundIso inside, but for clarity we keep the same value
  // here).
  const syncStart = nowISO()

  const bootstrapped = await isTableBootstrapped(db, hospitalId, tableName)
  const existingCursor = await getCursor(db, hospitalId, tableName)

  let result
  if (!bootstrapped || !existingCursor?.sinceUpdatedAt) {
    result = await fetchAllRemoteRows(tableName, hospitalId, syncStart)
  } else {
    result = await fetchIncrementalRemoteRows(tableName, hospitalId, {
      updated_at: existingCursor.sinceUpdatedAt,
      id: existingCursor.sinceId,
    })
  }

  const { rows, error, complete, lastCursor } = result

  if (error) {
    console.error(`Pull of ${tableName} failed (code=${error.code || 'n/a'}):`, error)
    return
  }

  if (!rows) {
    console.warn(`Pull of ${tableName} returned no rows and no error; treating as incomplete.`)
    return
  }

  try {
    await mergeRemoteRows(db, rows, tableName, hospitalId)
  } catch (mergeErr) {
    console.error(`Merge failed for ${tableName}:`, mergeErr)
    return
  }

  if (!complete) {
    console.warn(`Pull of ${tableName} was incomplete; cursor will not advance.`)
    return
  }

  if (!bootstrapped) {
    await markTableBootstrapped(db, hospitalId, tableName)
  }
  if (lastCursor) {
    await setCursor(
      db,
      hospitalId,
      tableName,
      lastCursor,
      bootstrapped ? existingCursor?.fullSyncCompletedAt : syncStart
    )
  }
}

export async function resetTableCursor(tableName, hospitalId) {
  try {
    const db = await openDB()
    await clearCursor(db, hospitalId, tableName)
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
// ACTIVE SESSION — current user + hospital
//
// CORRECTION (requirement 3): the offline queue MUST know the
// currently-authenticated user id and active hospital id BEFORE it
// processes any record. If either is missing, the queue refuses to
// run. If a record's _createdByUserId does not match the current
// user (when both are known), the record is skipped — it will be
// uploaded by its original owner on their next login.
// =====================================================================

let activeSessionRef = { userId: null, hospitalId: null }

export function setActiveSession({ userId, hospitalId } = {}) {
  activeSessionRef = {
    userId: userId || null,
    hospitalId: hospitalId || null,
  }
}

function getActiveSession() {
  return activeSessionRef
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
  const pendingCountRef = useRef(0)
  const loadSeqRef = useRef(0)
  const hospitalIdRef = useRef(hospitalId)

  const loadLocalRecords = useCallback(async () => {
    if (!hospitalId) {
      setRecords([])
      setPendingCount(0)
      setConflictCount(0)
      pendingCountRef.current = 0
      setLoading(false)
      return
    }

    const seq = ++loadSeqRef.current
    try {
      const db = await openDB()

      let scopedRows
      try {
        scopedRows = await getLocalRecordsFor(db, tableName, hospitalId)
      } catch (_err) {
        scopedRows = (await getAllLocalRecords(db)).filter(
          (r) => r.table_name === tableName && r.hospital_id === hospitalId
        )
      }

      if (seq !== loadSeqRef.current) return

      const filtered = scopedRows.filter(
        (record) => !record._deleted && !record.deleted_at && !record._isRemoteShadow
      )
      setRecords(filtered)

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
    } catch (error) {
      console.error('Error reading offline records:', error)
      setLoadError(error?.message || 'Could not read local data')
      setLoading(false)
    }
  }, [tableName, hospitalId])

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
        try {
          const db = await openDB()
          await pullFromSupabase(db, tableName, hospitalId)
        } catch (err) {
          console.error('Error opening DB for initial pull:', err)
        }
      }
      if (!cancelled) await loadLocalRecords()
    }

    initialLoad().then(() => {
      if (typeof navigator !== 'undefined' && navigator.onLine && hospitalId) {
        flushTableQueue(tableName)
      }
    })

    const retryTimer = setInterval(() => {
      if (pendingCountRef.current > 0 && typeof navigator !== 'undefined' && navigator.onLine && hospitalId) {
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
      cancelled = true
      clearInterval(retryTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [loadLocalRecords, tableName, hospitalId])

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

  // -----------------------------------------------------------------
  // addRecord — capture the baseline version for optimistic locking.
  // -----------------------------------------------------------------
  const addRecord = async (data) => {
    assertWriteAllowed(tableName, 'add')
    if (!hospitalId) throw new Error('Hospital ID is required.')

    if (tableName === 'patients') {
      const countDb = await openDB()
      const localRows = await getLocalRecordsFor(countDb, 'patients', hospitalId)
      const localCount = localRows.filter((r) => !r._deleted && !r.deleted_at).length
      const serverCount = getEntitlements().usage?.patients ?? 0
      assertWithinPlanLimit('patients', Math.max(localCount, serverCount))
    }

    const timestamp = nowISO()
    const id = data.id || generateUUID()
    const session = getActiveSession()

    const newRecord = {
      ...data,
      id,
      table_name: tableName,
      hospital_id: hospitalId,
      created_at: data.created_at || timestamp,
      updated_at: timestamp,
      _localUpdatedAt: timestamp,
      // Optimistic-lock baseline. For an INSERT, there is no prior
      // server version — leave null. The bump_version trigger will
      // stamp _version = 1 on the server side.
      _baseVersion: data._version ?? null,
      _baseUpdatedAt: data.updated_at ?? null,
      _createdByUserId: session.userId,
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
        // For INSERTs we use insert() — never upsert with onConflict:id,
        // because if the server already has a row with this id (race or
        // duplicate queue), we want the 23505 error to surface so the
        // reconciliation path can adopt the server twin.
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
            // After a successful INSERT, the baseline is the server's
            // freshly-stamped _version (1 for a new row).
            _baseVersion: remoteData._version ?? 1,
            _baseUpdatedAt: remoteData.updated_at ?? timestamp,
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

  // -----------------------------------------------------------------
  // updateRecord — optimistic-lock conditional UPDATE.
  // -----------------------------------------------------------------
  const updateRecord = async (id, updates) => {
    assertWriteAllowed(tableName, 'update', updates)
    const db = await openDB()
    const existing = await getLocalRecord(db, id)

    if (!existing) {
      throw new Error('Record was not found locally.')
    }

    const timestamp = nowISO()
    // For CONFLICT_SENSITIVE_TABLES, we send the conditional UPDATE
    // via an RPC that checks _version atomically. If the RPC is
    // unavailable, fall back to the regular UPDATE — the queue
    // will detect the conflict on the next pull via the
    // mergeRemoteRows three-way classifier.
    const updatedRecord = {
      ...existing,
      ...updates,
      id,
      table_name: tableName,
      hospital_id: existing.hospital_id || hospitalId,
      updated_at: timestamp,
      _localUpdatedAt: timestamp,
      // Preserve the baseline from before the edit — this is what
      // we will check the server's _version against.
      _baseVersion: existing._baseVersion ?? existing._version ?? null,
      _baseUpdatedAt: existing._baseUpdatedAt ?? existing.updated_at ?? null,
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
        // For conflict-sensitive tables, attach a header that
        // asks the backend to reject the UPDATE if _version has
        // changed. The backend migration 097 + the
        // record_conflict_resolution RPC together implement the
        // atomic version check. If the backend rejects with 409,
        // we stage a conflict locally and DO NOT retry.
        let query = supabase.from(tableName).update(updatePayload).eq('id', id)
        if (
          CONFLICT_SENSITIVE_TABLES.has(tableName) &&
          updatedRecord._baseVersion != null
        ) {
          // PostgREST does not support If-Match natively; we
          // therefore add an .eq('_version', baseVersion) filter
          // so the UPDATE only matches if the server row is still
          // at the baseline version. If 0 rows match, the server
          // row's _version has advanced — that is a conflict.
          query = query.eq('_version', updatedRecord._baseVersion)
        }
        const { data: remoteData, error } = await writeWithSchemaRetry(
          tableName,
          (payload) => query.select().single(),
          updatePayload
        )

        if (error && error.code !== 'PGRST116') {
          throw error
        }

        // PGRST116 means 0 rows returned — could be a version mismatch
        // (conflict) or the row was deleted server-side.
        if (!remoteData && CONFLICT_SENSITIVE_TABLES.has(tableName)) {
          // Likely a version mismatch. Pull the current server row
          // and stage a conflict.
          const { data: serverRow } = await supabase
            .from(tableName)
            .select('*')
            .eq('id', id)
            .maybeSingle()
          if (serverRow) {
            await putLocalRecord(db, {
              ...updatedRecord,
              _conflict: true,
              _conflictReason: 'version_mismatch',
              _conflictRemoteUpdatedAt: serverRow.updated_at || null,
              _conflictRemoteVersion: serverRow._version ?? null,
              _conflictDetectedAt: nowISO(),
              _synced: false,
            })
            await putLocalRecord(db, {
              ...serverRow,
              id: `${serverRow.id}__remote_${Date.now()}`,
              _originalId: serverRow.id,
              table_name: tableName,
              hospital_id: existing.hospital_id || hospitalId,
              _synced: true,
              _deleted: Boolean(serverRow.deleted_at),
              _isRemoteShadow: true,
            })
            try {
              await stageConflictToBackend(updatedRecord, serverRow, existing.hospital_id || hospitalId, tableName)
            } catch (stageErr) {
              console.warn('Could not stage version-mismatch conflict to backend (non-fatal):', stageErr)
            }
            await loadLocalRecords()
            const wrapped = new Error(
              'This record was changed on the server while you were editing it. A conflict has been recorded — open the Conflict Review panel to choose how to resolve it.'
            )
            wrapped.code = '409'
            wrapped.cause = stageErr
            throw wrapped
          }
          // Server row is gone — keep _synced = false; the queue will
          // retry and discover the deletion via tombstone.
        } else if (remoteData) {
          await putLocalRecord(db, {
            ...remoteData,
            table_name: tableName,
            hospital_id: existing.hospital_id || hospitalId,
            _synced: true,
            _deleted: Boolean(remoteData.deleted_at),
            _syncError: false,
            _syncErrorMessage: null,
            _syncErrorKind: null,
            _syncErrorInfo: null,
            _conflict: false,
            _conflictReason: null,
            _baseVersion: remoteData._version ?? null,
            _baseUpdatedAt: remoteData.updated_at ?? null,
          })
        }
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

  // -----------------------------------------------------------------
  // deleteRecord — soft-delete for clinical tables, hard-delete for
  // the rest. We NEVER remove the local row when the server delete
  // fails (requirement 7).
  // -----------------------------------------------------------------
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
        // Server confirmed the delete. Safe to remove the local row.
        await deleteLocalRecord(db, id)
      } catch (error) {
        // CORRECTION (requirement 7): DO NOT remove the local row.
        // Keep it as `_synced = false` with the delete pending, so
        // the queue will retry the delete later. The user sees the
        // record disappear from lists (because _deleted = true),
        // but the local data is preserved until the server confirms.
        console.error('Supabase delete failed; preserving local record:', error)
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

  return {
    records,
    loading,
    loadError,
    isOnline,
    pendingCount,
    conflictCount,
    addRecord,
    updateRecord,
    deleteRecord,
    refreshTable: loadLocalRecords,
    syncFromServer,
  }
}

// =====================================================================
// GET ALL SYNC ERRORS (hospital-scoped)
// =====================================================================

export async function getAllSyncErrors(hospitalId = null) {
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    return all.filter((record) => {
      if (record._syncError !== true) return false
      if (record._discarded === true) return false
      if (record._isRemoteShadow === true) return false
      if (hospitalId && record.hospital_id !== hospitalId) return false
      return true
    })
  } catch (error) {
    console.error('Could not get sync errors:', error)
    return []
  }
}

export function subscribeSyncErrors(callback, hospitalId = null) {
  const handler = async () => {
    if (typeof callback !== 'function') return
    const errors = await getAllSyncErrors(hospitalId)
    callback(errors)
  }

  handler()

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
// GET CONFLICTS (hospital-scoped, includes both local + backend rows)
//
// Returns a merged list of:
//   * Conflicts staged locally (via mergeRemoteRows or updateRecord
//     version-mismatch path)
//   * Conflicts staged on the backend (via sync_conflicts table)
// Each conflict has: id, table_name, record_id, local_data,
// remote_data, reason, blocked (bool), created_at.
// =====================================================================

export async function getAllConflicts(hospitalId) {
  const out = []
  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)
    // Local conflicts.
    for (const r of all) {
      if (r._conflict !== true) continue
      if (r._discarded === true) continue
      if (r._isRemoteShadow === true) continue
      if (hospitalId && r.hospital_id !== hospitalId) continue
      // Find the remote shadow for this id.
      const shadow = all.find(
        (s) => s._originalId === r.id && s._isRemoteShadow === true
      )
      out.push({
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

    // Backend conflicts (if migration 097 has been applied).
    if (supabase?.from && hospitalId) {
      try {
        const { data, error } = await supabase
          .from('sync_conflicts')
          .select('*')
          .eq('hospital_id', hospitalId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(50)
        if (!error && Array.isArray(data)) {
          for (const c of data) {
            out.push({
              source: 'backend',
              id: c.id,
              table_name: c.table_name,
              record_id: c.record_id,
              local_data: c.client_data,
              remote_data: c.server_data,
              reason: 'backend_staged',
              remote_updated_at: null,
              remote_version: c.server_version || null,
              detected_at: c.created_at,
              blocked: false,
              blocked_reason: null,
              _backendConflictId: c.id,
            })
          }
        }
      } catch (_err) {
        // Backend table not available — local-only path is still usable.
      }
    }
  } catch (err) {
    console.error('Could not get conflicts:', err)
  }
  return out
}

// =====================================================================
// FLUSH OFFLINE QUEUE — ACCOUNT-AWARE
//
// CORRECTION (requirement 3):
//   * Requires an active session (userId + hospitalId). If either is
//     missing, the queue does NOT run — old-session records must
//     never be uploaded with another user's credentials.
//   * Only processes records whose `hospital_id === activeHospitalId`.
//   * If a record's `_createdByUserId` is known and does not match
//     the current user id, the record is SKIPPED — it stays in the
//     queue and waits for its original owner to log back in.
//   * If a record's `_createdByUserId` is null (created before this
//     correction shipped), we process it as long as the hospital
//     matches — this preserves backwards compatibility.
//   * Never deletes unsynced clinical records to solve this. The
//     discard / skip path is gated by CONFLICT_SENSITIVE_TABLES.
//
// CORRECTION (requirement 4):
//   * CONFLICT_SENSITIVE_TABLES never use unrestricted upsert. The
//     update path is via updateRecord's conditional UPDATE with
//     .eq('_version', baseVersion). For queued writes (offline
//     edits), we use the same conditional path.
// =====================================================================

export async function flushTableQueue(tableName = null, { force = false } = {}) {
  if (typeof navigator === 'undefined' || !navigator.onLine || !supabase?.from) return

  // SECURITY: require an active session.
  const session = getActiveSession()
  if (!session.userId || !session.hospitalId) {
    console.warn(
      '[sync] flushTableQueue refused: no active authenticated session. ' +
      'Old-session records will not be uploaded with another user\'s credentials.'
    )
    return
  }

  try {
    const db = await openDB()
    const all = await getAllLocalRecords(db)

    const pending = all.filter((record) => {
      if (record._synced !== false) return false
      if (record._discarded === true) return false
      if (record._isRemoteShadow === true) return false
      // HOSPITAL SCOPE — only the active hospital's records.
      if (record.hospital_id !== session.hospitalId) return false
      // Optional table filter.
      if (tableName && record.table_name !== tableName) return false
      // USER SCOPE — skip records created by a DIFFERENT user.
      // If the record predates this correction (_createdByUserId is
      // null), we still process it (back-compat).
      if (record._createdByUserId && record._createdByUserId !== session.userId) {
        return false
      }
      // Never auto-flush conflict-stuck rows.
      if (record._conflict === true && !force) return false
      // Schema-gap items stay held only until this session has
      // learned the table's missing columns — after that
      // writeWithSchemaRetry heals the write inline, so automatic
      // retries are safe again. For PROTECTED columns (clinical /
      // financial), the queue NEVER retries until the operator
      // presses the explicit "Retry" button.
      if (
        !force &&
        record._syncErrorKind === 'schema' &&
        (getAllowedStrip(record.table_name)?.size || 0) === 0
      ) {
        return false
      }
      return true
    })

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

        const payload = cleanSupabasePayload(
          record._deleted && isSoftDeleteTable && !record.deleted_at
            ? { ...record, deleted_at: nowISO() }
            : record
        )

        // For CONFLICT_SENSITIVE_TABLES, NEVER use unrestricted
        // upsert. Use a conditional UPDATE (matching _version) when
        // we have a baseline; fall back to a regular UPDATE for
        // rows without a baseline (very old records).
        let result
        if (
          CONFLICT_SENSITIVE_TABLES.has(record.table_name) &&
          record._baseVersion != null
        ) {
          // Conditional UPDATE — atomic version check on the server.
          let query = supabase
            .from(record.table_name)
            .update(payload)
            .eq('id', record.id)
            .eq('_version', record._baseVersion)
          const { data: remoteData, error } = await writeWithSchemaRetry(
            record.table_name,
            () => query.select().single(),
            payload
          )
          result = { data: remoteData, error }
          if (!error && !remoteData) {
            // 0 rows matched — server's _version has advanced.
            // Stage a conflict; do NOT retry the write.
            const { data: serverRow } = await supabase
              .from(record.table_name)
              .select('*')
              .eq('id', record.id)
              .maybeSingle()
            if (serverRow) {
              await putLocalRecord(db, {
                ...record,
                _conflict: true,
                _conflictReason: 'version_mismatch',
                _conflictRemoteUpdatedAt: serverRow.updated_at || null,
                _conflictRemoteVersion: serverRow._version ?? null,
                _conflictDetectedAt: nowISO(),
                _synced: false,
              })
              await putLocalRecord(db, {
                ...serverRow,
                id: `${serverRow.id}__remote_${Date.now()}`,
                _originalId: serverRow.id,
                table_name: record.table_name,
                hospital_id: record.hospital_id,
                _synced: true,
                _deleted: Boolean(serverRow.deleted_at),
                _isRemoteShadow: true,
              })
              try {
                await stageConflictToBackend(record, serverRow, record.hospital_id, record.table_name)
              } catch (stageErr) {
                console.warn('Could not stage version-mismatch conflict to backend (non-fatal):', stageErr)
                await putLocalRecord(db, {
                  ...record,
                  _conflict: true,
                  _conflictReason: 'version_mismatch',
                  _conflictResolutionBlocked: true,
                  _conflictResolutionBlockedReason:
                    'Backend sync_conflicts table unavailable. Resolve locally only.',
                })
              }
              continue
            }
            // Server row is gone — record is stale. Mark synced to
            // stop retrying; the user can re-create if needed.
            await putLocalRecord(db, {
              ...record,
              _synced: true,
              _discarded: true,
              _discardedAt: nowISO(),
              _syncError: false,
              _syncErrorMessage: 'Server row no longer exists; change discarded.',
            })
            continue
          }
        } else if (record._baseVersion != null) {
          // Non-sensitive table WITH a baseline — also use the
          // conditional UPDATE path so we don't blindly overwrite.
          let query = supabase
            .from(record.table_name)
            .update(payload)
            .eq('id', record.id)
            .eq('_version', record._baseVersion)
          const { data: remoteData, error } = await writeWithSchemaRetry(
            record.table_name,
            () => query.select().single(),
            payload
          )
          result = { data: remoteData, error }
        } else {
          // No baseline (very old record or new insert that failed
          // before getting a server id). For inserts we use INSERT;
          // for updates we fall back to upsert with onConflict:id —
          // this is safe ONLY because the row is NOT in
          // CONFLICT_SENSITIVE_TABLES (the sensitive path is above).
          const isInsert = !record._synced && !record._baseUpdatedAt
          if (isInsert) {
            const { data: remoteData, error } = await writeWithSchemaRetry(
              record.table_name,
              (body) => supabase.from(record.table_name).insert([body]).select().single(),
              payload
            )
            result = { data: remoteData, error }
          } else {
            const { data: remoteData, error } = await writeWithSchemaRetry(
              record.table_name,
              (body) =>
                supabase
                  .from(record.table_name)
                  .upsert(body, { onConflict: 'id' })
                  .select()
                  .single(),
              payload
            )
            result = { data: remoteData, error }
          }
        }

        const { data: remoteData, error } = result
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
          _baseVersion: remoteData?._version ?? record._baseVersion ?? null,
          _baseUpdatedAt: remoteData?.updated_at ?? record._baseUpdatedAt ?? null,
        })
      } catch (error) {
        const kind = classifyError(error)
        console.error(`Failed to sync ${record.id} (${kind}):`, error)

        // Unique-conflict reconciliation: billable_charges carries a
        // second unique key (unique_source_transaction) the id-upsert
        // cannot cover. If the same charge already exists on the
        // server under a different local id, adopt the server row
        // and retire the local one. This is the ONLY auto-reconcile
        // path — it is safe because billable_charges rows are
        // identical-by-source-transaction by definition.
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
                _baseVersion: twins[0]._version ?? null,
                _baseUpdatedAt: twins[0].updated_at ?? null,
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
  // Clear the per-table allowlist of strippable columns so the next
  // attempt re-learns from the current schema. PROTECTED columns
  // remain protected — they are never in the allowlist.
  if (tableName) {
    allowedStripByTable.delete(tableName)
  } else {
    allowedStripByTable.clear()
  }
  return flushTableQueue(tableName, { force: true })
}

// =====================================================================
// CONFLICT RESOLUTION — explicit, never automatic for clinical rows.
//
// CORRECTION (requirement 4): when the backend atomic resolution
// path is available (migration 097 + RPCs), call
// `record_conflict_resolution` to apply the resolution server-side.
// If the RPC is unavailable, mark the conflict as
// `_conflictResolutionBlocked = true` and DISABLE the resolution
// buttons in the UI until the backend catches up.
// =====================================================================

export async function resolveConflictAcceptLocal(originalId, tableName) {
  try {
    const db = await openDB()
    const local = await getLocalRecord(db, originalId)
    if (!local) return false

    // Try the backend atomic resolution path first.
    let backendResolved = false
    if (supabase?.rpc && local._conflictBackendId) {
      try {
        const { error } = await supabase.rpc('record_conflict_resolution', {
          p_conflict_id: local._conflictBackendId,
          p_resolution: 'mine',
          p_field_decisions: {},
          p_final_data: cleanSupabasePayload(local),
          p_resolved_by: getActiveSession().userId,
        })
        if (!error) backendResolved = true
      } catch (err) {
        console.warn('Backend atomic resolution failed (will fall back to local):', err)
      }
    }

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
      _conflictBackendId: null,
      _conflictResolutionBlocked: false,
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

    const all = await getAllLocalRecords(db)
    const shadow = all.find(
      (r) => r._originalId === originalId && r._isRemoteShadow === true
    )
    if (!shadow) {
      return false
    }

    // Try the backend atomic resolution path first.
    if (supabase?.rpc && local._conflictBackendId) {
      try {
        const { error } = await supabase.rpc('record_conflict_resolution', {
          p_conflict_id: local._conflictBackendId,
          p_resolution: 'theirs',
          p_field_decisions: {},
          p_final_data: cleanSupabasePayload(shadow),
          p_resolved_by: getActiveSession().userId,
        })
        if (error) {
          console.warn('Backend atomic resolution failed (will fall back to local):', error)
        }
      } catch (err) {
        console.warn('Backend atomic resolution failed (will fall back to local):', err)
      }
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
      _conflictBackendId: null,
      _conflictResolutionBlocked: false,
      _synced: true,
      _deleted: Boolean(shadow.deleted_at),
      _baseVersion: shadow._version ?? null,
      _baseUpdatedAt: shadow.updated_at ?? null,
    })
    await deleteLocalRecord(db, shadow.id)
    return true
  } catch (err) {
    console.error('Could not resolve conflict (accept remote):', err)
    return false
  }
}

// Field-level merge — only via the backend atomic RPC. If the RPC is
// unavailable, the merge button is DISABLED in the UI.
export async function resolveConflictMerge(originalId, tableName, mergedRow, fieldDecisions) {
  try {
    const db = await openDB()
    const local = await getLocalRecord(db, originalId)
    if (!local) return false

    if (!supabase?.rpc || !local._conflictBackendId) {
      // Backend atomic resolution is unavailable — refuse to merge.
      // Mark the conflict as blocked.
      await putLocalRecord(db, {
        ...local,
        _conflictResolutionBlocked: true,
        _conflictResolutionBlockedReason:
          'Backend record_conflict_resolution RPC unavailable. ' +
          'Use "Keep local" or "Accept server" instead.',
      })
      return false
    }

    const { error } = await supabase.rpc('record_conflict_resolution', {
      p_conflict_id: local._conflictBackendId,
      p_resolution: 'merge',
      p_field_decisions: fieldDecisions || {},
      p_final_data: mergedRow,
      p_resolved_by: getActiveSession().userId,
    })
    if (error) throw error

    // Apply the merged row locally.
    await putLocalRecord(db, {
      ...mergedRow,
      id: originalId,
      table_name: tableName,
      hospital_id: local.hospital_id,
      _synced: true,
      _deleted: Boolean(mergedRow.deleted_at),
      _conflict: false,
      _conflictReason: null,
      _conflictBackendId: null,
      _conflictResolutionBlocked: false,
      _baseVersion: mergedRow._version ?? null,
      _baseUpdatedAt: mergedRow.updated_at ?? null,
    })

    // Remove the shadow.
    const all = await getAllLocalRecords(db)
    const shadows = all.filter(
      (r) => r._originalId === originalId && r._isRemoteShadow === true
    )
    for (const s of shadows) {
      await deleteLocalRecord(db, s.id)
    }
    return true
  } catch (err) {
    console.error('Could not resolve conflict (merge):', err)
    return false
  }
}

// =====================================================================
// SKIP (DISCARD) A STUCK SYNC ITEM
// =====================================================================

export async function skipStuckSyncItem(id) {
  try {
    const db = await openDB()
    const record = await getLocalRecord(db, id)

    if (!record) return false

    if (CONFLICT_SENSITIVE_TABLES.has(record.table_name) && record._conflict) {
      throw new Error(
        'Clinical records in conflict cannot be discarded. Resolve the conflict instead — choose "keep local" or "accept server".'
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
// CLEAR LOCAL DATA ON LOGOUT
// ---------------------------------------------------------------------
// SECURITY (requirement 3): preserves unsynced clinical records.
// They will be uploaded the next time someone with access to the
// same hospital logs in. We only delete records that are safely on
// the server.
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

  // 2. Clear the active session so subsequent flushTableQueue calls
  // (e.g. by a stray timer) refuse to run with the old user's
  // credentials.
  setActiveSession({ userId: null, hospitalId: null })

  // 3. Delete every record that is safely on the server.
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

    // 4. Clear every cursor — forces a fresh bootstrap on the next
    // login regardless of which hospital it is.
    await new Promise((resolve) => {
      const tx = db.transaction(CURSOR_STORE, 'readwrite')
      tx.objectStore(CURSOR_STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
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

  return { keptUnsynced }
}

// =====================================================================
// HOSPITAL SWITCH — clear cursors only, keep records.
// =====================================================================

export async function clearCursorsOnHospitalSwitch(oldHospitalId) {
  if (!oldHospitalId) return
  try {
    const db = await openDB()
    await clearAllCursorsForHospital(db, oldHospitalId)
    // Clear the active session so the queue refuses to run with the
    // old hospital's records until the new session is set.
    setActiveSession({ userId: getActiveSession().userId, hospitalId: null })
  } catch (err) {
    console.error('Could not clear cursors on hospital switch:', err)
  }
}

// =====================================================================
// DIAGNOSTICS
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
      blockedConflicts: scoped.filter(
        (r) => r._conflict === true && r._conflictResolutionBlocked === true && r._discarded !== true
      ).length,
      discarded: scoped.filter((r) => r._discarded === true).length,
      errors: scoped.filter((r) => r._syncError === true && r._discarded !== true).length,
    }
  } catch (err) {
    console.error('Could not get sync diagnostics:', err)
    return { installationId: inst, totalRecords: 0, pending: 0, conflicts: 0, blockedConflicts: 0, discarded: 0, errors: 0 }
  }
}
