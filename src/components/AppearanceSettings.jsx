import { useState } from 'react'
import { useTheme, THEMES } from '../context/ThemeContext'
import SpringToggle from './SpringToggle'
import AppIcon from './icons'

// =====================================================================
// AppearanceSettings — Premium theme customization panel
// =====================================================================
//
// Shown in Settings → Appearance. Features:
//   - Theme selection grid with preview cards
//   - Light/dark mode toggle (SpringToggle)
//   - System Default option
//   - Custom accent color picker
//   - Reset to defaults button
//   - Live preview (changes apply immediately)
// =====================================================================

const CURATED_ACCENTS = [
  '#00C7C7', '#4169FF', '#7657E8', '#18D99B',
  '#F044B8', '#F4B62A', '#F04F5F', '#FF6B35',
  '#00A6A6', '#6A42D4', '#0FA875', '#D43680',
]

export default function AppearanceSettings() {
  const { theme, mode, accent, setTheme, setMode, setAccent, resetToDefault, isDark, isLight, isSystem } = useTheme()
  const [customColor, setCustomColor] = useState(accent)

  function handleCustomColor(hex) {
    setCustomColor(hex)
    setAccent(hex)
    if (theme !== 'custom') setTheme('custom')
  }

  function handleThemeSelect(themeKey) {
    setTheme(themeKey)
    // If switching to a named theme, update the custom color picker to match
    const t = THEMES.find(t => t.key === themeKey)
    if (t && themeKey !== 'custom') setCustomColor(t.accent)
  }

  return (
    <div>
      {/* ---- Mode Toggle + System Default ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap', marginBottom: 24, padding: '14px 16px',
        borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--line)',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ivory)', marginBottom: 4 }}>
            Appearance Mode
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {isSystem ? 'Following system preference' : isDark ? 'Dark mode' : 'Light mode'}
            {isSystem && ` (currently ${isDark ? 'dark' : 'light'})`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* System Default option */}
          <button
            type="button"
            onClick={() => setMode('system')}
            style={{
              padding: '6px 12px', fontSize: 11.5, fontWeight: 700,
              borderRadius: 8, cursor: 'pointer', border: '1px solid',
              borderColor: isSystem ? 'var(--teal)' : 'var(--line)',
              background: isSystem ? 'var(--teal-soft)' : 'transparent',
              color: isSystem ? 'var(--teal)' : 'var(--muted)',
            }}
          >
            System
          </button>
          {/* Spring Toggle */}
          <SpringToggle />
        </div>
      </div>

      {/* ---- Theme Selection Grid ---- */}
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12 }}>
        Theme
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 12,
        marginBottom: 24,
      }}>
        {THEMES.map(t => {
          const isSelected = theme === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => handleThemeSelect(t.key)}
              style={{
                padding: 0, cursor: 'pointer', border: '2px solid',
                borderColor: isSelected ? t.accent : 'var(--line)',
                borderRadius: 14, overflow: 'hidden',
                background: 'var(--bg-elevated)',
                transition: 'border-color 0.2s ease, transform 0.15s ease',
                transform: isSelected ? 'scale(1.02)' : 'scale(1)',
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = 'var(--teal-border)' }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = 'var(--line)' }}
            >
              {/* Preview swatch */}
              <div style={{
                height: 60,
                background: `linear-gradient(135deg, ${t.accent}22 0%, var(--bg-card) 100%)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderBottom: '1px solid var(--line-soft)',
                position: 'relative',
              }}>
                <div style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: t.accent,
                  boxShadow: `0 0 12px -2px ${t.accent}`,
                }} />
                {isSelected && (
                  <div style={{
                    position: 'absolute', top: 6, right: 6,
                    width: 18, height: 18, borderRadius: '50%',
                    background: t.accent,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <AppIcon name="check" size={10} strokeWidth={3} style={{ color: '#fff' }} />
                  </div>
                )}
              </div>
              {/* Label */}
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ivory)', textAlign: 'left' }}>
                  {t.label}
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, textAlign: 'left' }}>
                  {t.description}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* ---- Custom Accent Color ---- */}
      {theme === 'custom' && (
        <div style={{
          padding: '14px 16px', borderRadius: 12, marginBottom: 24,
          background: 'var(--bg-elevated)', border: '1px solid var(--line)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12 }}>
            Custom Accent Color
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Curated swatches */}
            {CURATED_ACCENTS.map(color => (
              <button
                key={color}
                type="button"
                onClick={() => handleCustomColor(color)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', cursor: 'pointer',
                  border: accent === color ? '3px solid var(--ivory)' : '2px solid transparent',
                  background: color,
                  boxShadow: accent === color ? `0 0 10px -2px ${color}` : 'none',
                  transition: 'transform 0.15s ease',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.15)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              />
            ))}
            {/* Native color picker */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontSize: 11.5, color: 'var(--muted)',
            }}>
              <input
                type="color"
                value={customColor}
                onChange={e => handleCustomColor(e.target.value)}
                style={{ width: 32, height: 32, border: 'none', borderRadius: 8, cursor: 'pointer', background: 'transparent' }}
              />
              Pick
            </label>
          </div>
        </div>
      )}

      {/* ---- Reset ---- */}
      <button
        type="button"
        onClick={resetToDefault}
        style={{
          padding: '8px 16px', fontSize: 12, fontWeight: 600,
          borderRadius: 8, cursor: 'pointer', border: '1px solid var(--line)',
          background: 'transparent', color: 'var(--muted)',
        }}
      >
        Reset to Default
      </button>
    </div>
  )
}
