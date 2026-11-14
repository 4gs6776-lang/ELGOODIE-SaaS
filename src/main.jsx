import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import LiquidGlassSVG from './components/LiquidGlassSVG'
import './theme/globals.css'
import './theme/components.css'
import './theme/dashboard.css'
import './theme/owner.css'
import './theme/billing.css'
import './theme/premium-global.css'
import './theme/login-neo.css'
import './theme/handover.css'
import './theme/hospital-dash.css'
import './theme/glass.css'
import './theme/pagination.css'
// mobile.css MUST be imported last (its own header demands it).
import './theme/mobile.css'

// ---------------------------------------------------------------
// THEME SYSTEM — RE-ADDED (redesigned, no reload loop)
// ---------------------------------------------------------------
// The previous removal was needed because the OLD theme system had:
//   - 8 different theme color schemes (Midnight, Ocean, Emerald, etc.)
//   - Custom accent color picker
//   - A MutationObserver in widgets.jsx that watched <html> class
//     changes → caused an infinite render loop → browser reloaded
//     forever.
//
// This NEW version is much simpler:
//   - Only light/dark mode (no 8 themes, no custom accents)
//   - Reads mode from React state (useTheme() context)
//   - widgets.jsx's useThemeMode() reads from the same context
//     (no MutationObserver) → no feedback loop possible
//   - The DOM is updated via useEffect ONLY when mode actually changes
//
// Apply the saved theme immediately, before React renders, to prevent
// a flash of the wrong theme during initialization. The ThemeProvider
// will re-apply + manage it from here.
// ---------------------------------------------------------------
try {
  const raw = localStorage.getItem('gmedhub-theme-v2')
  let mode = 'dark'   // default
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.mode === 'light' || parsed.mode === 'dark') {
        mode = parsed.mode
      }
    } catch {}
  } else {
    // Backward compat: check old key
    const oldTheme = localStorage.getItem('gmedhub-theme')
    if (oldTheme === 'light') mode = 'light'
  }
  const html = document.documentElement
  html.setAttribute('data-theme', 'midnight')
  html.setAttribute('data-mode', mode)
  html.classList.toggle('light-mode', mode === 'light')
} catch {}

registerSW({ immediate: true })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      {/* LiquidGlassSVG injects the SVG feDisplacementMap filter once at
          app root. It's invisible (0x0 size) and only provides the
          `#liquid-refraction` filter that glass.css references via
          `backdrop-filter: url(#liquid-refraction)`. */}
      <LiquidGlassSVG />
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
