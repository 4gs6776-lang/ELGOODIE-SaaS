import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './theme/globals.css'
import './theme/components.css'
import './theme/dashboard.css'
import './theme/owner.css'
import './theme/billing.css'
import './theme/premium-global.css'
import './theme/login-neo.css'
import './theme/handover.css'
import './theme/hospital-dash.css'
import './theme/pagination.css'
// mobile.css MUST be imported last (its own header demands it).
import './theme/mobile.css'

// ---------------------------------------------------------------
// THEME SYSTEM REMOVED
// ---------------------------------------------------------------
// The previous version imported `./theme/themes.css` + wrapped <App />
// in <ThemeProvider>, which managed 8 different theme color schemes
// + light/dark mode + custom accent colors. That system caused two
// problems:
//
//   1. "Reload forever" — when the user clicked a theme button, the
//      ThemeProvider's useEffect wrote to <html>'s class + data-*
//      attributes. A MutationObserver in widgets.jsx's useThemeMode
//      fired on every class change, calling setMode → re-render. The
//      ThemeProvider also re-ran its own useEffect on every state
//      change. Combined with framer-motion's animations, this created
//      an infinite render loop that the browser would not recover
//      from without a hard reload.
//
//   2. "App misbehaves when themes change" — different theme buttons
//      applied different `data-theme` attributes, which could cascade
//      across the entire app and breakage in unexpected places (e.g.,
//      the doctor's queue, charts in DashboardOverview, etc.).
//
// FIX: The theme system has been removed entirely. The app now uses
// a single fixed dark theme (the default 'midnight' look that was
// already the default). Users can no longer change themes — the
// SpringToggle has been removed from Dashboard.jsx, and the
// AppearanceSettings panel no longer shows theme controls.
//
// This file now applies the default dark theme attributes ONCE at
// startup, then renders <App /> directly. No React context, no
// MutationObserver, no localStorage writes — no reload loop.
// ---------------------------------------------------------------

try {
  const html = document.documentElement
  html.setAttribute('data-theme', 'midnight')
  html.setAttribute('data-mode', 'dark')
  html.classList.remove('light-mode')   // force dark mode
  html.removeAttribute('data-accent')
  // Clear any leftover theme state from localStorage so a future
  // re-enable of the theme system doesn't pick up stale values.
  localStorage.removeItem('gmedhub-theme-v2')
  localStorage.removeItem('gmedhub-theme')
} catch {}

registerSW({ immediate: true })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
