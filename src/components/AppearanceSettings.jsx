import { useState } from 'react'
import SpringToggle from './SpringToggle'
import AppIcon from './icons'

// =====================================================================
// AppearanceSettings — Light/dark mode toggle (glassmorphic SpringToggle)
// =====================================================================
//
// This is a much simpler panel than the previous version (which had
// 8 themes + custom accent picker + system mode + reset button). That
// version caused the reload loop because of a MutationObserver in
// widgets.jsx.
//
// This version just shows the SpringToggle + a brief explanation.
// Users can toggle between light and dark mode. No 8 themes, no
// custom accents — those features were the source of the bugs.
// =====================================================================

const GLASS_STYLES = [
  { id: 'iridescent', label: 'Iridescent Rainbow Glass', hint: 'Pearly rainbow edge' },
  { id: 'rainbow', label: 'Rainbow Glass', hint: 'Saturated colour tint' },
  { id: 'aero', label: 'Classic Aero Glass', hint: 'Sky-blue, glossy' },
]

export default function AppearanceSettings() {
  const [glass, setGlass] = useState(() => document.documentElement.getAttribute('data-glass') || 'iridescent')
  const pickGlass = (id) => {
    setGlass(id)
    document.documentElement.setAttribute('data-glass', id)
    try { localStorage.setItem('medhub-glass', id) } catch {}
  }
  return (
    <div style={{
      padding: '20px',
      borderRadius: 12,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--line)',
    }}>
      <div style={{
        fontSize: 13, fontWeight: 700, color: 'var(--ivory)',
        marginBottom: 4,
      }}>
        Appearance
      </div>
      <div style={{
        fontSize: 11.5, color: 'var(--muted)',
        marginBottom: 18,
      }}>
        Toggle between dark and light mode. The toggle uses a
        glassmorphic design with a spring animation.
      </div>

      {/* Mode toggle row */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, padding: '14px 16px',
        borderRadius: 10,
        background: 'var(--bg-card)',
        border: '1px solid var(--line-soft)',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ivory)', marginBottom: 4 }}>
            Mode
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            Switch between dark and light themes
          </div>
        </div>
        <SpringToggle />
      </div>

      <div style={{ marginTop: 14 }} role="radiogroup" aria-label="Glass style">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ivory)', marginBottom: 8 }}>Glass style</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {GLASS_STYLES.map((g) => (
            <button
              key={g.id}
              type="button"
              role="radio"
              aria-checked={glass === g.id}
              onClick={() => pickGlass(g.id)}
              style={{
                textAlign: 'left', cursor: 'pointer', padding: '10px 14px', borderRadius: 10,
                background: glass === g.id ? 'var(--teal-soft)' : 'var(--bg-card)',
                border: `1px solid ${glass === g.id ? 'var(--teal)' : 'var(--line-soft)'}`,
                color: 'var(--ivory)', font: 'inherit',
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 650 }}>{g.label}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{g.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{
        marginTop: 14, padding: '12px 14px',
        borderRadius: 8,
        background: 'rgba(0,199,199,0.06)',
        border: '1px solid var(--teal-border)',
        fontSize: 11.5, color: 'var(--teal)', lineHeight: 1.5,
      }}>
        <AppIcon name="info" size={13} />{' '}
        Glass style applies to the dashboard cards, notification panel and
        chart tooltips. Dark and light mode both work with every style.
      </div>
    </div>
  )
}
