// src/lib/useLazyTable.js
//
// LAZY version of useOfflineTable — only loads data when the component
// is actually visible (not just mounted).
//
// WHY: Settings.jsx imports 10 managers, each calling useOfflineTable.
// That's 18 IndexedDB reads + 18 Supabase pulls on every Settings page
// visit, even if the user only wants to change their theme. The fix is
// to lazy-mount each Settings section: only fetch data when the user
// clicks to expand that section.
//
// USAGE:
//   const { records, loading, addRecord, updateRecord, deleteRecord } =
//     useLazyTable('hospital_bank_accounts', hospitalId, { enabled: isOpen })
//
// When `enabled` is false, the hook returns empty arrays and does
// nothing (no IndexedDB, no Supabase, no timers). When `enabled`
// becomes true, it behaves exactly like useOfflineTable.
//
// All writes (addRecord / updateRecord / deleteRecord) work the same
// way and will trigger the underlying useOfflineTable to pick them up
// via the cache invalidation mechanism.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useOfflineTable,
} from './useOfflineTable';

export function useLazyTable(tableName, hospitalId, options = {}) {
  const { enabled = true, realtime = false } = options;

  // Always call useOfflineTable (Rules of Hooks), but pass a sentinel
  // hospitalId when disabled so it does no work. When hospitalId is
  // null, useOfflineTable returns empty arrays and skips all I/O.
  const effectiveHospitalId = enabled ? hospitalId : null;

  const result = useOfflineTable(tableName, effectiveHospitalId, { realtime });

  // Wrap addRecord / updateRecord / deleteRecord so they no-op when
  // disabled (avoids accidentally writing with a null hospitalId).
  const safeAddRecord = useCallback(
    (...args) => (enabled ? result.addRecord(...args) : Promise.resolve(null)),
    [enabled, result.addRecord]
  );
  const safeUpdateRecord = useCallback(
    (...args) => (enabled ? result.updateRecord(...args) : Promise.resolve(null)),
    [enabled, result.updateRecord]
  );
  const safeDeleteRecord = useCallback(
    (...args) => (enabled ? result.deleteRecord(...args) : Promise.resolve(null)),
    [enabled, result.deleteRecord]
  );
  const safeSyncFromServer = useCallback(
    (...args) => (enabled ? result.syncFromServer?.(...args) : Promise.resolve(null)),
    [enabled, result.syncFromServer]
  );

  return {
    records: enabled ? result.records : [],
    loading: enabled ? result.loading : false,
    isOnline: result.isOnline,
    pendingCount: enabled ? result.pendingCount : 0,
    loadError: enabled ? result.loadError : null,
    addRecord: safeAddRecord,
    updateRecord: safeUpdateRecord,
    deleteRecord: safeDeleteRecord,
    syncFromServer: safeSyncFromServer,
  };
}

// ============================================================
// useLazyMount — gates a child component's mount on a boolean
// ============================================================
// Use this to defer mounting heavy child components until needed.
//
//   const shouldMount = useLazyMount(isOpen, 200);
//   return shouldMount ? <HeavyManager /> : null;
//
// When `isOpen` becomes true, waits 200ms (lets the tab transition
// finish) then mounts. When `isOpen` becomes false, unmounts immediately
// to free memory.

export function useLazyMount(active, delayMs = 0) {
  const [mounted, setMounted] = useState(active);
  const timerRef = useRef(null);

  useEffect(() => {
    if (active) {
      if (delayMs > 0) {
        timerRef.current = setTimeout(() => setMounted(true), delayMs);
      } else {
        setMounted(true);
      }
    } else {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setMounted(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, delayMs]);

  return mounted;
}
