import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'

// =====================================================================
// ThemeContext — Premium multi-theme customization system
// =====================================================================
//
// Manages 3 independent settings:
//   1. theme:    the accent color scheme ('midnight', 'clinical', 'ocean', 'emerald', 'royal', 'rose', 'sunset', 'custom')
//   2. mode:     light or dark ('light', 'dark', 'system')
//   3. accent:   custom hex color (only used when theme='custom')
//
// Backward compatibility with the old system:
//   - Old: localStorage('gmedhub-theme') = 'light' | 'dark'
//   - New: localStorage('gmedhub-theme-v2') = { theme, mode, accent }
//   - On first load: if gmedhub-theme-v2 doesn't exist but gmedhub-theme
//     does, we migrate: theme='midnight', mode = old value.
//
// Persistence:
//   - All preferences saved to localStorage('gmedhub-theme-v2')
//   - Applied to <html> via data-theme + data-mode attributes
//   - The old html.light-mode class is also set for backward compat
//   - System default mode listens to matchMedia('(prefers-color-scheme: dark)')
//
// User isolation:
//   - Preferences are per-browser (localStorage). When the user logs in
//     on a different device, they get the defaults (or the hospital default
//     if one is set in the future).
//   - No database writes — purely client-side preferences.
// =====================================================================

const ThemeContext = createContext(null)

export const THEMES = [
  { key: 'midnight',  label: 'Midnight Dark',  accent: '#00C7C7', description: 'Deep blue-black backgrounds with teal accents' },
  { key: 'clinical',  label: 'Clinical Light', accent: '#00A6A6', description: 'Clean white surfaces, excellent readability' },
  { key: 'ocean',     label: 'Ocean Blue',     accent: '#00C7E7', description: 'Blue-tinted surfaces with cyan accents' },
  { key: 'emerald',   label: 'Emerald',        accent: '#18D99B', description: 'Neutral surfaces with emerald accents' },
  { key: 'royal',     label: 'Royal Purple',   accent: '#9B7EE8', description: 'Restrained purple accents, professional contrast' },
  { key: 'rose',      label: 'Rose Pink',       accent: '#F06AA8', description: 'Muted rose accents, sophisticated appearance' },
  { key: 'sunset',    label: 'Sunset',          accent: '#F4B62A', description: 'Amber and gold accents, warm professional feel' },
  { key: 'custom',    label: 'Custom',          accent: '#00C7C7', description: 'Choose your own accent color' },
]

const STORAGE_KEY = 'gmedhub-theme-v2'
const OLD_STORAGE_KEY = 'gmedhub-theme'

function readStoredPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        theme: parsed.theme || 'midnight',
        mode: parsed.mode || 'dark',
        accent: parsed.accent || '#00C7C7',
      }
    }
    // Migrate from old system
    const oldMode = localStorage.getItem(OLD_STORAGE_KEY)
    if (oldMode) {
      return { theme: 'midnight', mode: oldMode, accent: '#00C7C7' }
    }
  } catch {}
  return { theme: 'midnight', mode: 'dark', accent: '#00C7C7' }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    // Keep old key in sync for backward compat
    localStorage.setItem(OLD_STORAGE_KEY, prefs.mode === 'light' ? 'light' : 'dark')
  } catch {}
}

function getEffectiveMode(mode) {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'dark'
  }
  return mode
}

function applyThemeToDOM(theme, effectiveMode, accent) {
  const html = document.documentElement
  // Add transitioning class for smooth animation
  html.classList.add('transitioning')
  // Set data attributes
  html.setAttribute('data-theme', theme)
  html.setAttribute('data-mode', effectiveMode)
  // Backward compat: set light-mode class
  html.classList.toggle('light-mode', effectiveMode === 'light')
  // Custom accent
  if (theme === 'custom' && accent) {
    html.setAttribute('data-accent', accent)
    html.style.setProperty('--custom-accent', accent)
    // Derive a brighter version for hover states
    html.style.setProperty('--custom-accent-bright', lightenColor(accent, 15))
  } else {
    html.removeAttribute('data-accent')
    html.style.removeProperty('--custom-accent')
    html.style.removeProperty('--custom-accent-bright')
  }
  // Remove transitioning class after animation completes
  setTimeout(() => html.classList.remove('transitioning'), 350)
}

// Simple color lightening — shifts the hex color toward white by a percentage
function lightenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, (num >> 16) + Math.round(255 * percent / 100))
  const g = Math.min(255, ((num >> 8) & 0xFF) + Math.round(255 * percent / 100))
  const b = Math.min(255, (num & 0xFF) + Math.round(255 * percent / 100))
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

// Check if user prefers reduced motion
function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function ThemeProvider({ children }) {
  const initial = readStoredPrefs()
  const [theme, setTheme] = useState(initial.theme)
  const [mode, setMode] = useState(initial.mode)
  const [accent, setAccent] = useState(initial.accent)

  const effectiveMode = useMemo(() => getEffectiveMode(mode), [mode])

  // Apply theme to DOM whenever settings change
  useEffect(() => {
    applyThemeToDOM(theme, effectiveMode, accent)
    writePrefs({ theme, mode, accent })
  }, [theme, effectiveMode, accent])

  // Listen for OS theme changes when in system mode
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      const newMode = mq.matches ? 'dark' : 'light'
      applyThemeToDOM(theme, newMode, accent)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode, theme, accent])

  const toggleMode = useCallback(() => {
    setMode(current => {
      const eff = getEffectiveMode(current)
      return eff === 'dark' ? 'light' : 'dark'
    })
  }, [])

  const resetToDefault = useCallback(() => {
    setTheme('midnight')
    setMode('dark')
    setAccent('#00C7C7')
  }, [])

  const value = useMemo(() => ({
    theme, mode, accent, effectiveMode,
    setTheme, setMode, setAccent,
    toggleMode, resetToDefault,
    isDark: effectiveMode === 'dark',
    isLight: effectiveMode === 'light',
    isSystem: mode === 'system',
    reducedMotion: prefersReducedMotion(),
  }), [theme, mode, accent, effectiveMode, toggleMode, resetToDefault])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    // Fallback for components rendered outside the provider
    return {
      theme: 'midnight', mode: 'dark', accent: '#00C7C7', effectiveMode: 'dark',
      setTheme: () => {}, setMode: () => {}, setAccent: () => {},
      toggleMode: () => {}, resetToDefault: () => {},
      isDark: true, isLight: false, isSystem: false, reducedMotion: false,
    }
  }
  return ctx
}
