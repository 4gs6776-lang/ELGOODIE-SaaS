import { Sun, Moon } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'

// =====================================================================
// SpringToggle — neumorphic light/dark switch (sun | moon)
//
// Raised pill holding two round positions. The active mode is shown as a
// pressed well with a glowing ring; the inactive mode is a raised disc with
// an embossed icon. Visuals live in theme/neumorph.css (.neu-toggle).
//
// Behaviour is unchanged: reads isDark + toggleMode from useTheme(),
// role="switch", native button so Space/Enter work, no <html> observers.
// =====================================================================

export default function SpringToggle({ size = 'md' }) {
  const { isDark, toggleMode } = useTheme()

  const handleToggle = (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleMode()
  }

  const iconSize = size === 'sm' ? 14 : 17

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`neu-toggle ${size === 'sm' ? 'sm' : ''}`}
      onClick={handleToggle}
    >
      {isDark ? (
        <span className="neu-toggle-slot raised" aria-hidden="true"><Sun size={iconSize} strokeWidth={1.6} /></span>
      ) : (
        <span className="neu-toggle-slot well" aria-hidden="true"><span className="neu-toggle-ring"><i /></span></span>
      )}
      {isDark ? (
        <span className="neu-toggle-slot well" aria-hidden="true"><span className="neu-toggle-ring"><i /></span></span>
      ) : (
        <span className="neu-toggle-slot raised" aria-hidden="true"><Moon size={iconSize} strokeWidth={1.6} /></span>
      )}
    </button>
  )
}
