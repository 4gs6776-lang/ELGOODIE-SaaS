import { motion } from 'framer-motion'
import { useTheme } from '../context/ThemeContext'

// =====================================================================
// SpringToggle — Premium neumorphic spring toggle for light/dark mode
// =====================================================================
//
// Visual design (based on the reference image):
//   - Horizontal pill-shaped outer housing (~60×32px)
//   - Fully rounded ends
//   - Layered, concentric edges (outer ring + inner track)
//   - Softly recessed inner track (inset shadow)
//   - Large circular toggle knob (~24px)
//   - Subtle raised knob (box-shadow + highlight)
//   - Small circular active indicator (dot on the track)
//   - Theme-aware colors via CSS variables
//
// Animation (Framer Motion spring):
//   - Smooth acceleration → fast horizontal movement
//   - Small controlled overshoot → spring-back settling
//   - Slight press compression (scale 0.92 on tap)
//   - Shadow change during movement
//   - Indicator fade in/out
//
// Accessibility:
//   - role="switch", aria-checked
//   - Keyboard: Space/Enter to toggle
//   - Touch: tap anywhere on the toggle
//   - Reduced motion: instant switch (no animation)
// =====================================================================

export default function SpringToggle({ size = 'md' }) {
  const { isDark, toggleMode, reducedMotion } = useTheme()

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

  // Spring config — tuned for premium tactile feel
  const springConfig = reducedMotion
    ? { type: 'tween', duration: 0 }
    : {
        type: 'spring',
        stiffness: 700,
        damping: 30,
        mass: 0.8,
        restDelta: 0.001,
      }

  // Press animation
  const pressScale = reducedMotion ? 1 : 0.92

  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      tabIndex={0}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      whileTap={{ scale: pressScale }}
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
        // Outer housing — neumorphic raised surface
        background: 'var(--bg-elevated)',
        boxShadow: isDark
          ? '2px 2px 6px rgba(0,0,0,0.4), -2px -2px 6px rgba(255,255,255,0.04), inset 0 0 0 1px var(--line)'
          : '2px 2px 5px rgba(0,0,0,0.12), -2px -2px 5px rgba(255,255,255,0.9), inset 0 0 0 1px var(--line)',
        outline: 'none',
        flexShrink: 0,
      }}
    >
      {/* Inner recessed track */}
      <div
        style={{
          position: 'absolute',
          top: dims.pad,
          left: dims.pad,
          right: dims.pad,
          bottom: dims.pad,
          borderRadius: '50%',
          // Recessed inner track
          background: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.04)',
          boxShadow: isDark
            ? 'inset 2px 2px 4px rgba(0,0,0,0.5), inset -1px -1px 3px rgba(255,255,255,0.03)'
            : 'inset 1px 1px 3px rgba(0,0,0,0.10), inset -1px -1px 2px rgba(255,255,255,0.6)',
        }}
      >
        {/* Active indicator dot (visible when ON) */}
        <motion.div
          initial={false}
          animate={{
            opacity: isDark ? 1 : 0,
            scale: isDark ? 1 : 0.5,
          }}
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 25 }}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: dims.knob * 0.3,
            height: dims.knob * 0.3,
            borderRadius: '50%',
            background: 'var(--teal)',
            boxShadow: `0 0 8px var(--teal)`,
          }}
        />
      </div>

      {/* Toggle knob */}
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
          // Knob surface — raised with highlight
          background: isDark
            ? 'linear-gradient(145deg, var(--bg-card-hover), var(--bg-card))'
            : 'linear-gradient(145deg, #FFFFFF, #F0F2F5)',
          boxShadow: isDark
            ? '2px 2px 5px rgba(0,0,0,0.5), -1px -1px 3px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)'
            : '2px 2px 4px rgba(0,0,0,0.15), -1px -1px 3px rgba(255,255,255,0.9), inset 0 1px 0 rgba(255,255,255,0.5)',
        }}
      >
        {/* Subtle inner highlight on knob */}
        <div
          style={{
            position: 'absolute',
            top: '15%',
            left: '20%',
            width: '40%',
            height: '30%',
            borderRadius: '50%',
            background: isDark
              ? 'rgba(255,255,255,0.04)'
              : 'rgba(255,255,255,0.6)',
            filter: 'blur(2px)',
          }}
        />
      </motion.div>
    </motion.button>
  )
}
