// src/lib/useLazyTable.js
//
// LAZY version of useOfflineTable — only loads data when `enabled` is true.
// Used to defer loading of tables that aren't needed until the user
// opens a specific tab/section/modal.
//
// USAGE:
//   const [showLabResults, setShowLabResults] = useState(false)
//   const { records: labTests } = useLazyTable('lab_tests', hospital?.id, { enabled: showLabResults })
//
// When `enabled` is false, the hook passes hospitalId=null to
// useOfflineTable, which skips all I/O (no IndexedDB, no Supabase,
// no timers). When `enabled` becomes true, it behaves exactly like
// useOfflineTable.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useOfflineTable } from './useOfflineTable';

export function useLazyTable(tableName, hospitalId, options = {}) {
  const { enabled = true, realtime = false } = options;
  const effectiveHospitalId = enabled ? hospitalId : null;
  const result = useOfflineTable(tableName, effectiveHospitalId, { realtime });

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
// When `isOpen` becomes true, waits `delayMs` (lets the tab transition
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
