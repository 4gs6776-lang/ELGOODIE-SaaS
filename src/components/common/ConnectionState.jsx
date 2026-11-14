import LiquidLoader from './LiquidLoader'

// =====================================================================
// GOODIE-MEDHUB — ConnectionState (Stage 1, requirement #14)
//
// The sync button in the dashboard topbar. Same props and same state
// logic as before; the dot + icon is replaced by the liquid orb, which
// changes colour with the state:
//
//   connecting / syncing → violet-teal, fast morph   "Syncing…"
//   synced               → green, calm               "Synced"
//   failed               → red, restless             "Sync failed (n)"
//   pending (offline)    → gold                      "Pending sync (n)"
//   offline              → grey                      "Offline"
//
// It never claims something is synchronized when it is not: any pending
// or failed item forces the state away from "Synced".
//
// Optional onRetry() makes the chip a real <button> when items are stuck.
// =====================================================================

function deriveState({ isOnline, pendingCount, failedCount, connecting }) {
  if (connecting) return { key: 'connecting', label: 'Connecting…', cls: 'is-syncing', tone: 'loading' }
  if (!isOnline) {
    return pendingCount > 0
      ? { key: 'pending', label: `Pending sync (${pendingCount})`, cls: 'is-pending', tone: 'warning' }
      : { key: 'offline', label: 'Offline', cls: 'is-offline', tone: 'muted' }
  }
  if (failedCount > 0) {
    return { key: 'failed', label: `Sync failed (${failedCount})`, cls: 'is-failed', tone: 'danger' }
  }
  if (pendingCount > 0) {
    return { key: 'syncing', label: 'Syncing…', cls: 'is-syncing', tone: 'loading' }
  }
  return { key: 'synced', label: 'Synced', cls: 'is-synced', tone: 'success' }
}

const STATE_TITLES = {
  connecting: 'Reaching the server…',
  syncing: 'Saving local changes to the server…',
  pending: "You're offline. Unsent changes are safe on this device and will upload when reconnected — they are NOT on the server yet.",
  offline: "You're offline. The app keeps working from local data.",
  failed: 'Some changes were refused by the server and need attention. Click to review.',
  synced: 'Everything on this screen matches the server.',
}

export default function ConnectionState({
  isOnline,
  pendingCount = 0,
  failedCount = 0,
  connecting = false,
  onRetry,
  style,
}) {
  const state = deriveState({ isOnline, pendingCount, failedCount, connecting })
  const clickable = typeof onRetry === 'function' && (state.key === 'failed' || state.key === 'pending')
  const Tag = clickable ? 'button' : 'span'
  const tagProps = clickable
    ? { type: 'button', onClick: onRetry, 'aria-label': `${state.label}. ${STATE_TITLES[state.key]}` }
    : { role: 'status', 'aria-live': 'polite' }

  return (
    <Tag
      className={`conn-state conn-liquid ${state.cls}${clickable ? ' clickable' : ''}`}
      title={STATE_TITLES[state.key]}
      style={style}
      {...tagProps}
    >
      <LiquidLoader tone={state.tone} size="xs" decorative />
      {/* .conn-label lets the phone topbar compress the harmless
          "Synced" text to the orb only (see theme/components.css). */}
      <span className="conn-label">{state.label}</span>
    </Tag>
  )
}
