import React, { useState, useEffect } from 'react';
import { useSyncHealth } from '../lib/useOfflineTable.syncPatch';
import './OfflineFirst.css';

export default function SyncStatusIndicator({ hospitalId, onOpenQueue, onOpenConflicts }) {
  const { pendingCount, conflictCount, lastSyncedAt, isOnline } = useSyncHealth(hospitalId);
  const [now, setNow] = useState(Date.now());

  // Re-render every 30s so the "synced Xs ago" label stays fresh
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const status = !isOnline
    ? { kind: 'offline', label: 'Offline', pulse: true }
    : conflictCount > 0
    ? { kind: 'conflict', label: `${conflictCount} conflict${conflictCount > 1 ? 's' : ''}`, pulse: true }
    : pendingCount > 0
    ? { kind: 'syncing', label: `Syncing ${pendingCount}…`, pulse: true }
    : { kind: 'synced', label: 'Synced', pulse: false };

  const lastSyncLabel = formatLastSync(lastSyncedAt, now);

  return (
    <div className="sync-status-wrap" onClick={() => {
      if (conflictCount > 0 && onOpenConflicts) onOpenConflicts();
      else if (pendingCount > 0 && onOpenQueue) onOpenQueue();
    }}>
      <div className={`sync-pill sync-pill-${status.kind}`}>
        <span className={`sync-dot ${status.pulse ? 'sync-dot-pulse' : ''}`} />
        <span className="sync-label">{status.label}</span>
      </div>
      {lastSyncLabel && (
        <span className="sync-meta">{lastSyncLabel}</span>
      )}
    </div>
  );
}

function formatLastSync(iso, nowMs) {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (isNaN(ts)) return null;
  const sec = Math.floor((nowMs - ts) / 1000);
  if (sec < 60) return `just now`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
