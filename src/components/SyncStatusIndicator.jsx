import { useState, useEffect } from 'react'
import { syncStatus } from '../lib/conflictResolver'
import { Wifi, WifiOff, RefreshCw, CheckCircle, Cloud, CloudOff, AlertTriangle } from 'lucide-react'

// =====================================================================
// SyncStatusIndicator — shows sync status in the dashboard header
// =====================================================================
// Shows:
//   - Online/Offline status (wifi icon)
//   - Pending records count (if > 0)
//   - Last sync time (if synced)
//   - Conflict warning (if conflicts exist)
//
// Mount this once in the dashboard layout (next to the LiveClock).
// =====================================================================

export default function SyncStatusIndicator() {
  const [status, setStatus] = useState({
    pendingCount: 0,
    isOnline: navigator.onLine,
    lastSyncAt: null,
    conflicts: [],
  })

  useEffect(() => {
    const unsubscribe = syncStatus.subscribe(setStatus)
    return unsubscribe
  }, [])

  const isSynced = status.isOnline && status.pendingCount === 0 && status.conflicts.length === 0
  const hasPending = status.pendingCount > 0
  const hasConflicts = status.conflicts.length > 0

  // Determine display state
  let icon, color, label, bg
  if (!status.isOnline) {
    icon = <CloudOff size={14} />
    color = 'var(--gold)'
    bg = 'rgba(232,184,46,0.10)'
    label = hasPending ? `Offline · ${status.pendingCount} queued` : 'Offline'
  } else if (hasConflicts) {
    icon = <AlertTriangle size={14} />
    color = 'var(--danger)'
    bg = 'rgba(240,79,95,0.10)'
    label = `${status.conflicts.length} conflict${status.conflicts.length !== 1 ? 's' : ''}`
  } else if (hasPending) {
    icon = <RefreshCw size={14} className="animate-spin" />
    color = 'var(--teal)'
    bg = 'var(--teal-soft)'
    label = `Syncing ${status.pendingCount}…`
  } else if (isSynced) {
    icon = <CheckCircle size={14} />
    color = 'var(--success)'
    bg = 'var(--success-soft)'
    label = status.lastSyncAt ? `Synced ${formatRelative(status.lastSyncAt)}` : 'Synced'
  } else {
    icon = <Cloud size={14} />
    color = 'var(--muted)'
    bg = 'transparent'
    label = '—'
  }

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', borderRadius: 999,
      background: bg, color,
      fontSize: 11, fontWeight: 600,
      transition: 'all .3s ease',
      border: `1px solid ${color}33`,
    }} title={label}>
      {icon}
      <span>{label}</span>
    </div>
  )
}

function formatRelative(isoString) {
  if (!isoString) return ''
  const diff = Date.now() - new Date(isoString).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(isoString).toLocaleDateString()
}
