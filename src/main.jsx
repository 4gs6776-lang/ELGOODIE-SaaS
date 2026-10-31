import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
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
// themes.css MUST be imported AFTER globals.css so the data-theme
// rules override the :root defaults.
import './theme/themes.css'
// mobile.css MUST be imported last (its own header demands it).
import './theme/mobile.css'

// Apply the saved theme immediately, before any page renders. This
// prevents a flash of the wrong theme during initialization. The
// ThemeProvider in React will re-apply + manage it from here.
try {
  const raw = localStorage.getItem('gmedhub-theme-v2')
  if (raw) {
    const prefs = JSON.parse(raw)
    const html = document.documentElement
    html.setAttribute('data-theme', prefs.theme || 'midnight')
    // Determine effective mode
    let mode = prefs.mode || 'dark'
    if (mode === 'system' && window.matchMedia) {
      mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    html.setAttribute('data-mode', mode)
    html.classList.toggle('light-mode', mode === 'light')
    if (prefs.theme === 'custom' && prefs.accent) {
      html.setAttribute('data-accent', prefs.accent)
      html.style.setProperty('--custom-accent', prefs.accent)
    }
  } else {
    // Backward compat: check old key
    const oldTheme = localStorage.getItem('gmedhub-theme')
    const mode = oldTheme === 'light' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', 'midnight')
    document.documentElement.setAttribute('data-mode', mode)
    document.documentElement.classList.toggle('light-mode', mode === 'light')
  }
} catch {}

registerSW({ immediate: true })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
