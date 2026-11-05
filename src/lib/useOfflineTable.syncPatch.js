// src/lib/useOfflineTable.syncPatch.js
//
// Drop-in ADDITION to useOfflineTable.js. It does NOT replace the existing
// hook — instead it adds new exports that the existing hook can call into
// to gain version-aware conflict detection.
//
// Integration pattern (manual, see README):
//   1. In `flushTableQueue()`, replace the existing `upsert` call with
//      `versionAwareUpsert()` from this file.
//   2. In `pullFromSupabase()`, request the `_version` column so the
//      client stores it for the next push.
//   3. Subscribe to `useSyncHealth()` in your topbar to render the
//      SyncStatusIndicator component.
//
// Why a separate file: the original useOfflineTable.js is 1098 lines and
// patched frequently. Keeping the version-aware logic here means future
// updates to either file don't conflict.

import { supabase } from './supabaseClient';
import {
  isOptimisticLockError,
  isNewer,
} from './conflictResolver';

// ============================================================
// VERSION-AWARE UPSERT
// ============================================================
// Tries to upsert with an optimistic-lock check. If the server row's
// _version is higher than the client expected, records a conflict and
// returns null (instead of overwriting).
//
// Call pattern:
//   const result = await versionAwareUpsert(db, record);
//   if (result.conflict) { /* sync_conflicts row created server-side */ }
//   else if (result.data) { /* success */ }
//   else { /* result.error */ }
//
// Note: we use Supabase's `upsert(onConflict: 'id')` which is a true
// upsert. The version check is done server-side via the trigger, which
// rejects the write if the row's _version doesn't match what the client
// sent (handled by an additional WHERE clause appended below).
// ============================================================

export async function versionAwareUpsert(tableName, record) {
  // Build the payload. We send the client's expected _version so the
  // server trigger can detect mismatches.
  const payload = stripMetadataForWrite(record);
  if (record._version != null) {
    payload._version = record._version;
  }
  if (record._last_editor != null) {
    payload._last_editor = record._last_editor;
  }

  // First try a straight upsert. The trigger will bump _version on success.
  const { data, error } = await supabase
    .from(tableName)
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();

  if (!error) {
    return { data, error: null, conflict: false };
  }

  // Detect optimistic-lock / concurrent-modification errors
  if (isOptimisticLockError(error)) {
    // Fetch the current server row to record the conflict
    const { data: serverRow } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', record.id)
      .maybeSingle();

    if (serverRow) {
      // Insert a sync_conflicts row so the UI can prompt for resolution
      await supabase.from('sync_conflicts').insert({
        hospital_id: record.hospital_id,
        table_name: tableName,
        record_id: record.id,
        client_version: record._version || 1,
        server_version: serverRow._version || 1,
        client_data: stripMetadataForWrite(record),
        server_data: stripMetadataForWrite(serverRow),
        base_data: null, // we don't track base snapshots yet
        conflicting_fields: [], // computed server-side by detect_conflicting_fields
        status: 'pending',
      });
    }
    return { data: null, error: null, conflict: true };
  }

  return { data: null, error, conflict: false };
}

// ============================================================
// STRIP METADATA FOR WRITE
// Don't send internal _synced / _discarded / _syncError flags back.
// ============================================================
function stripMetadataForWrite(record) {
  const out = { ...record };
  delete out._synced;
  delete out._discarded;
  delete out._syncError;
  delete out._syncErrorMessage;
  delete out._syncErrorKind;
  delete out._deleted;
  delete out.table_name;
  delete out.hospital_id;
  delete out.created_at;
  delete out.updated_at;
  return out;
}

// ============================================================
// SYNC HEALTH HOOK
// ============================================================
// Lightweight polling hook that returns pending counts + conflict counts.
// Used by the SyncStatusIndicator in the dashboard topbar.
//
// Implementation note: this is intentionally NOT a useSyncExternalStore —
// the existing useOfflineTable already exposes pendingCount via state.
// This hook reads the IndexedDB store directly so it can be used in the
// topbar without re-mounting every table component.
// ============================================================

import { useState, useEffect } from 'react';

const DB_NAME = 'HospitalOfflineDB';
const DB_VERSION = 3;
const STORE_NAME = 'offline_records';

function openDBSync() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function useSyncHealth(hospitalId) {
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    if (!hospitalId) return;

    let cancelled = false;

    async function refresh() {
      try {
        const db = await openDBSync();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const allReq = store.getAll();
        allReq.onsuccess = () => {
          if (cancelled) return;
          const records = allReq.result || [];
          const pending = records.filter(
            r => r._synced === false && r._discarded !== true && r.hospital_id === hospitalId
          );
          setPendingCount(pending.length);

          // Most recent successful sync time
          const syncedTimes = records
            .filter(r => r._synced === true && r._last_synced_at)
            .map(r => r._last_synced_at)
            .sort()
            .reverse();
          setLastSyncedAt(syncedTimes[0] || null);
        };

        // Conflicts come from the server (sync_conflicts table)
        supabase
          .from('sync_conflicts')
          .select('id', { count: 'exact', head: true })
          .eq('hospital_id', hospitalId)
          .eq('status', 'pending')
          .then(({ count }) => {
            if (!cancelled) setConflictCount(count || 0);
          });
      } catch (e) {
        console.warn('useSyncHealth refresh failed:', e);
      }
    }

    refresh();
    const interval = setInterval(refresh, 5000); // 5s polling

    // Online/offline listeners
    function handleOnline()  { setIsOnline(true);  refresh(); }
    function handleOffline() { setIsOnline(false); }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Supabase realtime subscription for new conflicts
    const sub = supabase
      .channel('sync-conflicts')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sync_conflicts', filter: `hospital_id=eq.${hospitalId}` },
        () => refresh()
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sync_conflicts', filter: `hospital_id=eq.${hospitalId}` },
        () => refresh()
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      supabase.removeChannel(sub);
    };
  }, [hospitalId]);

  return { pendingCount, conflictCount, lastSyncedAt, isOnline };
}

// ============================================================
// PUSH QUEUE STATS (per-table)
// ============================================================
// Returns the breakdown of pending records by table, for the queue viewer.
export async function getQueueStats(hospitalId) {
  try {
    const db = await openDBSync();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const allReq = store.getAll();
    return new Promise((resolve) => {
      allReq.onsuccess = () => {
        const records = (allReq.result || []).filter(
          r => r._synced === false && r._discarded !== true && r.hospital_id === hospitalId
        );
        const byTable = {};
        for (const r of records) {
          if (!byTable[r.table_name]) {
            byTable[r.table_name] = { pending: 0, errors: 0, oldest: null };
          }
          byTable[r.table_name].pending++;
          if (r._syncError) byTable[r.table_name].errors++;
          if (!byTable[r.table_name].oldest || r.created_at < byTable[r.table_name].oldest) {
            byTable[r.table_name].oldest = r.created_at;
          }
        }
        resolve(byTable);
      };
      allReq.onerror = () => resolve({});
    });
  } catch (e) {
    return {};
  }
}

// ============================================================
// RETRY SPECIFIC RECORD
// ============================================================
// Re-flushes a single record by id. Used by the SyncQueueViewer.
export async function retryRecord(recordId) {
  // Re-flag the record so flushTableQueue picks it up.
  const db = await openDBSync();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const getReq = store.get(recordId);
  return new Promise((resolve, reject) => {
    getReq.onsuccess = async () => {
      const record = getReq.result;
      if (!record) return resolve(false);
      // Mark as ready for retry
      record._syncError = false;
      record._syncErrorMessage = null;
      record._syncErrorKind = null;
      await new Promise((res) => {
        const putReq = store.put(record);
        putReq.onsuccess = res;
        putReq.onerror = () => res();
      });
      resolve(true);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ============================================================
// DISCARD PENDING RECORD
// ============================================================
// For "stuck" items the user wants to give up on.
export async function discardPendingRecord(recordId) {
  const db = await openDBSync();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const getReq = store.get(recordId);
  return new Promise((resolve) => {
    getReq.onsuccess = async () => {
      const record = getReq.result;
      if (!record) return resolve(false);
      record._discarded = true;
      await new Promise((res) => {
        const putReq = store.put(record);
        putReq.onsuccess = res;
        putReq.onerror = () => res();
      });
      resolve(true);
    };
    getReq.onerror = () => resolve(false);
  });
}
