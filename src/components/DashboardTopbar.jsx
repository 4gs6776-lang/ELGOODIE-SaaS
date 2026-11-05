// src/components/DashboardTopbar.jsx
// COMPLETE drop-in component (no patching required).
//
// Wraps your existing topbar contents and adds a SyncStatusIndicator pill
// to the right side. The pill shows: Synced / Syncing N / N conflicts / Offline.
//
// Clicking the pill when there are conflicts opens the ConflictResolverModal.
// Clicking the pill when there are pending records (no conflicts) opens the
// SyncQueueViewer.
//
// USAGE (in your Dashboard.jsx render method):
//
//   import DashboardTopbar from '../components/DashboardTopbar';
//
//   <DashboardTopbar hospitalId={hospital?.id}>
//     {/* your existing topbar contents go here — page title, search, etc. */}
//   </DashboardTopbar>
//
// Or use the components individually if you prefer to place the pill yourself:
//
//   import SyncStatusIndicator from './SyncStatusIndicator';
//   import ConflictResolverModal from './ConflictResolverModal';
//   import SyncQueueViewer from './SyncQueueViewer';

import React, { useState } from 'react';
import SyncStatusIndicator from './SyncStatusIndicator';
import ConflictResolverModal from './ConflictResolverModal';
import SyncQueueViewer from './SyncQueueViewer';

export default function DashboardTopbar({ hospitalId, children }) {
  const [showConflicts, setShowConflicts] = useState(false);
  const [showQueue, setShowQueue] = useState(false);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 16px',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        <div style={{ flexShrink: 0 }}>
          <SyncStatusIndicator
            hospitalId={hospitalId}
            onOpenConflicts={() => setShowConflicts(true)}
            onOpenQueue={() => setShowQueue(true)}
          />
        </div>
      </div>

      <ConflictResolverModal
        open={showConflicts}
        onClose={() => setShowConflicts(false)}
      />
      <SyncQueueViewer
        open={showQueue}
        onClose={() => setShowQueue(false)}
      />
    </>
  );
}
