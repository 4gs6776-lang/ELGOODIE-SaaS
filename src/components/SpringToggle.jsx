import { motion } from 'framer-motion'
import { useTheme } from '../context/ThemeContext'

// =====================================================================
// SpringToggle — Glassmorphic light/dark mode toggle
// =====================================================================
//
// Visual design (glassmorphism):
//   - Pill-shaped glass surface (~60×32px) with backdrop-filter blur
//   - Semi-transparent gradient background
//   - Soft outer glow that matches the current mode (teal for dark,
//     warm gold for light)
//   - Inner highlight on top edge (frosted glass effect)
//   - Subtle inner shadow on bottom edge (depth)
//   - Large circular knob (~24px) with gradient + glow
//   - Icon (sun/moon) inside the knob that cross-fades on toggle
//
// Animation (framer-motion spring):
//   - Smooth spring slide with mild overshoot (~30% damping)
//   - Knob scales to 0.85 on press, springs back on release
//   - Outer glow expands slightly during transition
//   - Background tint cross-fades (no flicker)
//
// ARCHITECTURE FIX (vs the old SpringToggle that caused reload loops):
//   - Reads `isDark` + `toggleMode` from React context (useTheme)
//   - Does NOT read from <html> class attributes
//   - Does NOT trigger any MutationObserver
//   - The toggle is a pure React state change → framer-motion animates
//     → no feedback loop possible
//
// Accessibility:
//   - role="switch", aria-checked
//   - Keyboard: Space/Enter to toggle
//   - Touch: tap anywhere on the toggle
// =====================================================================

export default function SpringToggle({ size = 'md' }) {
  const { isDark, toggleMode } = useTheme()

  // Dimensions based on size prop
  const dims = size === 'sm'
    ? { width: 48, height: 26, knob: 20, pad: 3 }
    : { width: 60, height: 32, knob: 24, pad: 4 }

  const handleToggle = (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleMode()
  }

  const handleKeyDown = (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      toggleMode()
    }
  }

  // Spring config — tuned for premium tactile feel with mild overshoot
  const springConfig = {
    type: 'spring',
    stiffness: 500,
    damping: 30,
    mass: 1,
    restDelta: 0.001,
  }

  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      tabIndex={0}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      whileTap={{ scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 600, damping: 25 }}
      style={{
        width: dims.width,
        height: dims.height,
        borderRadius: dims.height,
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        // Glassmorphism: semi-transparent gradient + backdrop blur
        background: isDark
          ? 'linear-gradient(145deg, rgba(10,19,26,0.65), rgba(7,15,20,0.85))'
          : 'linear-gradient(145deg, rgba(255,255,255,0.55), rgba(232,236,241,0.75))',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        // Outer glow that matches the mode
        boxShadow: isDark
          ? `0 0 0 1px rgba(0,199,199,0.20), 0 4px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.30)`
          : `0 0 0 1px rgba(244,182,42,0.25), 0 4px 12px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.70), inset 0 -1px 0 rgba(0,0,0,0.06)`,
        outline: 'none',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Inner frosted track (the visible track behind the knob) */}
      <div
        style={{
          position: 'absolute',
          top: dims.pad,
          left: dims.pad,
          right: dims.pad,
          bottom: dims.pad,
          borderRadius: '50%',
          // Frosted inner surface — different tint per mode
          background: isDark
            ? 'rgba(0,0,0,0.25)'
            : 'rgba(255,255,255,0.45)',
          boxShadow: isDark
            ? 'inset 1px 1px 3px rgba(0,0,0,0.40), inset -1px -1px 2px rgba(255,255,255,0.04)'
            : 'inset 1px 1px 3px rgba(0,0,0,0.06), inset -1px -1px 2px rgba(255,255,255,0.50)',
        }}
      >
        {/* Sun/Moon glyph that cross-fades */}
        <motion.div
          initial={false}
          animate={{
            opacity: isDark ? 0 : 1,
            scale: isDark ? 0.5 : 1,
            rotate: isDark ? -90 : 0,
          }}
          transition={springConfig}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: dims.knob * 0.35,
            height: dims.knob * 0.35,
            borderRadius: '50%',
            // Sun (visible in light mode)
            background: 'radial-gradient(circle, #F4B62A 0%, #E89B0E 100%)',
            boxShadow: '0 0 6px rgba(244,182,42,0.60)',
          }}
        />
        <motion.div
          initial={false}
          animate={{
            opacity: isDark ? 1 : 0,
            scale: isDark ? 1 : 0.5,
            rotate: isDark ? 0 : 90,
          }}
          transition={springConfig}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: dims.knob * 0.35,
            height: dims.knob * 0.35,
            borderRadius: '50%',
            // Moon (visible in dark mode) — crescent via box-shadow trick
            background: '#F1F6FA',
            boxShadow: `inset -${dims.knob * 0.12}px -${dims.knob * 0.04}px 0 0 #0A131A, 0 0 6px rgba(0,199,199,0.60)`,
          }}
        />
      </div>

      {/* The glassy knob — slides between left (light) and right (dark) */}
      <motion.div
        initial={false}
        animate={{
          x: isDark ? dims.width - dims.knob - dims.pad * 2 : 0,
        }}
        transition={springConfig}
        style={{
          width: dims.knob,
          height: dims.knob,
          borderRadius: '50%',
          position: 'relative',
          zIndex: 2,
          marginLeft: dims.pad,
          // Glass knob: gradient + highlight + outer glow
          background: isDark
            ? 'linear-gradient(145deg, rgba(16,29,38,0.95), rgba(7,15,20,1))'
            : 'linear-gradient(145deg, rgba(255,255,255,0.95), rgba(232,236,241,1))',
          boxShadow: isDark
            ? `0 2px 6px rgba(0,0,0,0.50), 0 0 12px rgba(0,199,199,0.30), inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(0,0,0,0.30), 0 0 0 1px rgba(0,199,199,0.15)`
            : `0 2px 6px rgba(0,0,0,0.15), 0 0 12px rgba(244,182,42,0.30), inset 0 1px 0 rgba(255,255,255,0.70), inset 0 -1px 0 rgba(0,0,0,0.05), 0 0 0 1px rgba(244,182,42,0.20)`,
        }}
      >
        {/* Inner highlight on the knob (top-left specular) */}
        <div
          style={{
            position: 'absolute',
            top: '15%',
            left: '20%',
            width: '40%',
            height: '30%',
            borderRadius: '50%',
            background: isDark
              ? 'rgba(255,255,255,0.06)'
              : 'rgba(255,255,255,0.85)',
            filter: 'blur(2px)',
          }}
        />
      </motion.div>
    </motion.button>
  )
}
