import { useState, useMemo, useRef, useEffect } from 'react'
import AppIcon from '../icons'
import { useHmoProviders } from '../../lib/useHmoProviders'

// =====================================================================
// GOODIE-MEDHUB — HmoProviderSelect
//
// A searchable dropdown for picking an HMO provider. Used in:
//   - Reception's patient registration form (when category is 'hmo')
//   - Insurance's claim submission form
//
// Replaces the old plain <select> that only had 7 options + "Other".
// Now there are ~30 Nigerian HMOs, so a search box makes finding the
// right one fast.
//
// Behaviour:
//   - Closed: shows the currently selected provider's name (or placeholder)
//   - Click anywhere on the closed row → opens the dropdown
//   - Open: shows a search input at the top + a filtered list below
//   - Search is case-insensitive, matches any substring
//   - Clicking a provider in the list selects it + closes the dropdown
//   - Clicking outside the dropdown closes it
//   - Keyboard: Esc closes; the search input is auto-focused on open
//
// Props:
//   value         — string (the selected provider's display name)
//   onChange      — (name) => void  (called when a provider is picked)
//   placeholder   — text shown when nothing is selected
//   ariaLabel     — for screen readers
//   disabled      — boolean
//   includeSelfPay — boolean (default true) — whether to show
//                    "Self-Pay (No HMO)" as the first option. Set to
//                    false in the Insurance claim form (claims are
//                    always against an actual HMO, not Self-Pay).
// =====================================================================

export default function HmoProviderSelect({
  value,
  onChange,
  placeholder = 'Search HMO provider…',
  ariaLabel = 'HMO provider',
  disabled = false,
  includeSelfPay = true,
  hospitalId,  // Phase 2: passed from parent for DB-backed provider list
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef(null)
  const searchInputRef = useRef(null)

  // Phase 2: read from the database (with fallback to hardcoded list)
  const { providers: dbProviders } = useHmoProviders(hospitalId)

  // The full provider list, optionally filtering out Self-Pay
  const providers = useMemo(() => {
    return includeSelfPay
      ? dbProviders
      : dbProviders.filter(p => p.slug !== 'self-pay' && p.id !== 'self-pay')
  }, [dbProviders, includeSelfPay])

  // Filter the list by the search query
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providers
    return providers.filter(p => p.name.toLowerCase().includes(q))
  }, [providers, query])

  // Auto-focus the search input when the dropdown opens
  useEffect(() => {
    if (open && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [open])

  // Close on outside click
  useEffect(() => {
    function handleDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleDocClick)
      return () => document.removeEventListener('mousedown', handleDocClick)
    }
  }, [open])

  // Esc closes
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  function pickProvider(name) {
    onChange?.(name)
    setQuery('')
    setOpen(false)
  }

  return (
    <div
      ref={containerRef}
      className={`hmo-select ${open ? 'is-open' : ''}`}
      style={{ position: 'relative' }}
    >
      {/* Closed state: shows the current selection */}
      <button
        type="button"
        className="hmo-select-trigger"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '9px 12px',
          borderRadius: 8,
          border: `1px solid ${disabled ? 'var(--line)' : 'var(--line)'}`,
          background: disabled ? 'var(--bg-card)' : 'var(--bg-elevated)',
          color: 'var(--ivory)',
          fontSize: 13,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {value || <span style={{ color: 'var(--muted)' }}>{placeholder}</span>}
        </span>
        <AppIcon name={open ? 'arrowUp' : 'arrowDown'} size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      </button>

      {/* Open state: search input + filtered list */}
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 50,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            maxHeight: 320,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Search input */}
          <div style={{ padding: 8, borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AppIcon name="search" size={14} style={{ color: 'var(--muted)' }} />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to search…"
              aria-label="Search HMO providers"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--ivory)',
                fontSize: 13,
                padding: '4px 0',
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}
              >
                <AppIcon name="close" size={12} />
              </button>
            )}
          </div>

          {/* Filtered list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12.5, textAlign: 'center' }}>
                No HMO matches "{query}". Try a shorter search or pick "Other".
              </div>
            ) : (
              filtered.map(p => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={value === p.name}
                  onClick={() => pickProvider(p.name)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px 12px',
                    background: value === p.name ? 'var(--teal-soft)' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--line-soft)',
                    color: 'var(--ivory)',
                    fontSize: 12.5,
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (value !== p.name) e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                  onMouseLeave={e => { if (value !== p.name) e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {p.name}
                  </span>
                  {value === p.name && <AppIcon name="check" size={12} style={{ color: 'var(--teal)', flexShrink: 0 }} />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
