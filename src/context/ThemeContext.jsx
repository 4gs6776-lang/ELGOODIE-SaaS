import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'

// =====================================================================
// ThemeContext — minimal light/dark mode toggle
// =====================================================================
//
// REDESIGNED to avoid the previous reload loop:
//   - Old version had 8 themes + a MutationObserver in widgets.jsx that
//     watched <html> class changes → setMode → re-render → ThemeProvider
//     useEffect re-applied DOM → MutationObserver fired again →
//     infinite render loop → browser reloaded forever.
//
// This new version:
//   - Only manages light/dark mode (no 8 themes, no custom accents)
//   - Reads mode from React state, NOT from the DOM
//   - widgets.jsx's useThemeMode() reads from this context directly
//     (no MutationObserver) → no feedback loop possible
//   - The DOM is updated via useEffect ONLY when mode actually changes
//   - framer-motion's SpringToggle reads `isDark` from this context,
//     not from the DOM class
//
// Persistence: localStorage('gmedhub-theme-v2') = { mode }
// Default: 'dark' (matches the original midnight theme)
// =====================================================================

const ThemeContext = createContext(null)

const STORAGE_KEY = 'gmedhub-theme-v2'

function readStoredMode() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.mode === 'light' || parsed.mode === 'dark') {
        return parsed.mode
      }
    }
  } catch {}
  return 'dark'  // default
}

function writePrefs(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode }))
    // Backward compat: keep the old key in sync
    localStorage.setItem('gmedhub-theme', mode === 'light' ? 'light' : 'dark')
  } catch {}
}

function applyThemeToDOM(mode) {
  const html = document.documentElement
  html.setAttribute('data-theme', 'midnight')   // always midnight — only mode changes
  html.setAttribute('data-mode', mode)
  html.classList.toggle('light-mode', mode === 'light')
}

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(readStoredMode)

  // Apply theme to DOM whenever mode changes (one-shot, no observer)
  useEffect(() => {
    applyThemeToDOM(mode)
    writePrefs(mode)
  }, [mode])

  const toggleMode = useCallback(() => {
    setMode(current => current === 'dark' ? 'light' : 'dark')
  }, [])

  const resetToDefault = useCallback(() => {
    setMode('dark')
  }, [])

  const value = useMemo(() => ({
    mode,                          // 'light' | 'dark'
    setMode,
    toggleMode,
    resetToDefault,
    isDark: mode === 'dark',
    isLight: mode === 'light',
    // Alias for backward compat with widgets.jsx's useThemeMode() return
    // (widgets.jsx expected 'dark' or 'light' as a string)
    themeMode: mode,
  }), [mode, toggleMode, resetToDefault])

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
      mode: 'dark',
      setMode: () => {},
      toggleMode: () => {},
      resetToDefault: () => {},
      isDark: true,
      isLight: false,
      themeMode: 'dark',
    }
  }
  return ctx
}
