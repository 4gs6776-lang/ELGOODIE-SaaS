import AppIcon from './icons'

// =====================================================================
// AppearanceSettings — Theme system removed
// =====================================================================
//
// The previous version of this panel offered 8 different theme color
// schemes + light/dark mode toggle + custom accent picker. That system
// caused a reload loop + app misbehavior when themes were changed:
//
//   - ThemeProvider's useEffect wrote to <html>'s class attribute
//   - A MutationObserver in widgets.jsx's useThemeMode fired on every
//     class change → setMode → re-render
//   - The ThemeProvider's own useEffect re-ran on every state change
//   - Combined with framer-motion, this created an infinite render
//     loop that the browser would not recover from without a hard reload
//
// FIX: The theme system has been removed entirely. The app now uses a
// single fixed dark theme (the default 'midnight' look that was already
// the default before).
//
// This panel now just shows a brief explanation. If you want to
// re-enable theming later, you'd need to bring back ThemeContext.jsx +
// SpringToggle.jsx + theme/themes.css + theme/tokens.js + the
// ThemeProvider wrap in main.jsx.
// =====================================================================

export default function AppearanceSettings() {
  return (
    <div style={{
      padding: '24px 20px',
      borderRadius: 12,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--line)',
      textAlign: 'center',
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12,
        background: 'rgba(0,199,199,0.10)',
        border: '1px solid var(--teal-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 16px',
      }}>
        <AppIcon name="settings" size={22} />
      </div>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--ivory)',
        marginBottom: 8,
      }}>
        Theme customization is currently disabled
      </div>
      <div style={{
        fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6,
        maxWidth: 480, margin: '0 auto',
      }}>
        The app uses a single fixed dark theme to avoid stability issues
        that were caused by runtime theme switching.
        <br />
        If you need to customize colors again, contact your administrator
        to re-enable the theme system.
      </div>
    </div>
  )
}
