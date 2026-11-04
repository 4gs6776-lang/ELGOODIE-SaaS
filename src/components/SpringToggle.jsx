import { motion } from 'framer-motion'
import { useTheme } from '../context/ThemeContext'

// =====================================================================
// SpringToggle — Minimalist dark/light toggle (matches reference image)
// =====================================================================
//
// Visual design:
//   - Pure black/dark pill background (~52×28px)
//   - NO glassmorphism, NO gradients, NO blur
//   - Left side: a white ring (circle outline) — visible when knob
//     is on the right (dark mode ON)
//   - A solid dark gray knob (~22px) that slides left↔right
//   - The knob has a subtle raised 3D shadow (no glow, no teal tint)
//
// When dark mode is ON (knob on right):
//   - Left side shows a white ring (like a moon outline)
//   - Knob is dark gray, sitting on the right
//
// When dark mode is OFF (knob on left):
//   - Right side shows nothing (or a subtle dim circle)
//   - Knob is dark gray, sitting on the left
//
// Animation (framer-motion spring):
//   - Smooth spring slide with mild overshoot
//   - Knob presses down slightly on tap
//
// ARCHITECTURE:
//   - Reads `isDark` + `toggleMode` from React context (useTheme)
//   - No DOM observation, no MutationObserver, no reload loop
// =====================================================================

export default function SpringToggle({ size = 'md' }) {
  const { isDark, toggleMode } = useTheme()

  // Dimensions — slightly smaller than before to match the reference
  const dims = size === 'sm'
    ? { width: 44, height: 24, knob: 18, pad: 3, ring: 10 }
    : { width: 52, height: 28, knob: 22, pad: 3, ring: 12 }

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

  // Spring config — smooth, slight overshoot
  const springConfig = {
    type: 'spring',
    stiffness: 600,
    damping: 32,
    mass: 0.8,
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
      whileTap={{ scale: 0.95 }}
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
        // Pure black/dark background — NO glassmorphism, NO blur
        background: '#000000',
        // Subtle outer border + shadow for the pill shape
        boxShadow: '0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)',
        outline: 'none',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* White ring on the LEFT side — visible when dark mode is ON (knob on right).
          This is the circle outline (like a moon) from the reference image. */}
      <div
        style={{
          position: 'absolute',
          left: dims.pad + (dims.knob - dims.ring) / 2,
          top: '50%',
          transform: 'translateY(-50%)',
          width: dims.ring,
          height: dims.ring,
          borderRadius: '50%',
          // White ring (outline only — transparent center)
          border: `${Math.max(1.5, dims.ring * 0.14)}px solid rgba(255,255,255,0.85)`,
          background: 'transparent',
          // Only visible when the knob has moved to the right (dark mode ON)
          opacity: isDark ? 1 : 0,
          transition: 'opacity 0.3s ease',
          pointerEvents: 'none',
        }}
      />

      {/* The knob — solid dark gray, slides left↔right */}
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
          // Solid dark gray knob — NO gradient, NO glow
          // Slightly lighter than the pill so it stands out
          background: '#3A3A3C',
          // 3D raised shadow — the knob looks like it's sitting on top
          boxShadow: [
            '0 2px 6px rgba(0,0,0,0.4)',           // drop shadow below
            '0 0 0 1px rgba(0,0,0,0.3)',           // thin dark edge
            'inset 0 1px 0 rgba(255,255,255,0.12)', // top highlight (3D raised)
            'inset 0 -1px 0 rgba(0,0,0,0.3)',       // bottom shadow (3D depth)
          ].join(', '),
        }}
      />
    </motion.button>
  )
}
