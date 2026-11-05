// =====================================================================
// GOODIE-MEDHUB — conflictResolver.js
// =====================================================================
// Handles field-level merge when two users edit the same record offline.
//
// Strategy:
//   1. Compare _version numbers — if server version > local version,
//      the server has newer data → server wins (client's data is stale)
//   2. If both versions are the same → field-level merge:
//      - Clinical fields (diagnosis, treatment_plan, chief_complaints):
//        merge — take whichever field is non-empty (prefer the one that
//        changed since the last sync)
//      - Administrative fields (name, phone, email):
//        last-write-wins (whoever synced last)
//   3. If conflict can't be resolved automatically → log it for manual review
//
// Usage:
//   const result = resolveConflict({ localRecord, remoteRecord, table })
//   if (result.resolved) { /* use result.merged */ }
//   else { /* log result.conflict for manual review */ }
// =====================================================================

// Fields that should be merged (not overwritten) during conflict resolution
const MERGE_FIELDS = {
  patients: ['full_name', 'phone', 'email', 'address', 'hmo_provider', 'hmo_id_code', 'category'],
  patient_vitals: ['chief_complaints', 'history_presenting_complaint', 'past_medical_history',
    'past_surgical_history', 'drug_history', 'allergy_history', 'family_social_history',
    'examination_findings', 'clinical_notes', 'treatment_plan', 'follow_up_notes',
    'diagnosis', 'symptoms', 'diagnoses'],
  prescriptions: ['drug_name', 'dosage', 'route', 'frequency', 'duration', 'quantity', 'instructions'],
  invoices: ['balance', 'amount_paid', 'status', 'payment_method'],
  admission_requests: ['status', 'diagnosis', 'reason'],
}

// Fields that use last-write-wins (whichever was updated most recently)
const LAST_WRITE_FIELDS = {
  patients: ['queue_status', 'queue_updated_at'],
  patient_vitals: ['status', 'completed_at', 'assigned_doctor'],
  prescriptions: ['status', 'cancelled_at'],
  invoices: ['draft_status', 'updated_at'],
}

export function resolveConflict({ localRecord, remoteRecord, table }) {
  if (!localRecord || !remoteRecord) {
    return { resolved: true, merged: remoteRecord || localRecord, strategy: 'fallback' }
  }

  const localVersion = localRecord._version || 1
  const remoteVersion = remoteRecord._version || 1

  // ---- Strategy 1: Server version is higher → server wins ----
  if (remoteVersion > localVersion) {
    return {
      resolved: true,
      merged: remoteRecord,
      strategy: 'server_wins',
      reason: `Server version (${remoteVersion}) > local version (${localVersion})`,
    }
  }

  // ---- Strategy 2: Local version is higher → local wins ----
  if (localVersion > remoteVersion) {
    return {
      resolved: true,
      merged: localRecord,
      strategy: 'local_wins',
      reason: `Local version (${localVersion}) > server version (${remoteVersion})`,
    }
  }

  // ---- Strategy 3: Same version → field-level merge ----
  const merged = { ...remoteRecord } // start with remote as base
  const mergeFields = MERGE_FIELDS[table] || []
  const lastWriteFields = LAST_WRITE_FIELDS[table] || []
  const conflicts = []

  for (const field of mergeFields) {
    const localVal = localRecord[field]
    const remoteVal = remoteRecord[field]

    if (localVal === remoteVal) continue // no conflict

    // If only one has a value, use that one
    if (!localVal && remoteVal) { merged[field] = remoteVal; continue }
    if (localVal && !remoteVal) { merged[field] = localVal; continue }

    // Both have different values → prefer the local one (the current user's edit)
    // and log the conflict for review
    merged[field] = localVal
    conflicts.push({
      field,
      localValue: localVal,
      remoteValue: remoteVal,
      resolution: 'kept_local',
    })
  }

  // Last-write fields: use whichever has the more recent updated_at
  for (const field of lastWriteFields) {
    const localVal = localRecord[field]
    const remoteVal = remoteRecord[field]
    if (localVal === remoteVal) continue

    const localUpdated = localRecord.updated_at || localRecord.queue_updated_at || ''
    const remoteUpdated = remoteRecord.updated_at || remoteRecord.queue_updated_at || ''

    if (new Date(localUpdated) >= new Date(remoteUpdated)) {
      merged[field] = localVal
    } else {
      merged[field] = remoteVal
    }
  }

  return {
    resolved: true,
    merged,
    strategy: 'field_merge',
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  }
}

// =====================================================================
// SyncStatusTracker — tracks sync status for the UI
// =====================================================================
// A simple singleton that tracks how many records are pending sync.
// The SyncStatusIndicator component reads from this.
// =====================================================================

class SyncStatusTracker {
  constructor() {
    this.listeners = new Set()
    this.pendingCount = 0
    this.isOnline = navigator.onLine
    this.lastSyncAt = null
    this.conflicts = []

    // Listen to online/offline events
    window.addEventListener('online', () => {
      this.isOnline = true
      this.notify()
    })
    window.addEventListener('offline', () => {
      this.isOnline = false
      this.notify()
    })
  }

  setPendingCount(count) {
    this.pendingCount = count
    this.notify()
  }

  markSynced() {
    this.pendingCount = 0
    this.lastSyncAt = new Date().toISOString()
    this.notify()
  }

  addConflict(conflict) {
    this.conflicts.push(conflict)
    this.notify()
  }

  clearConflicts() {
    this.conflicts = []
    this.notify()
  }

  subscribe(callback) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  notify() {
    this.listeners.forEach(cb => cb({
      pendingCount: this.pendingCount,
      isOnline: this.isOnline,
      lastSyncAt: this.lastSyncAt,
      conflicts: this.conflicts,
    }))
  }
}

export const syncStatus = new SyncStatusTracker()
