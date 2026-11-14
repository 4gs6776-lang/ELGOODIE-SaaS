import '../../theme/liquid-loader.css'

// =====================================================================
// G-MedHub LiquidLoader — the one loading indicator for the whole app.
//
//   <LiquidLoader variant="block" label="Loading patients" />   module/panel
//   <LiquidLoader variant="screen" label="Loading" />           full page
//   <LiquidLoader size="xs" tone="success" decorative />        tiny orb
//
// tone: loading | success | danger | warning | muted
//   loading  → violet into teal   (loading, synchronizing)
//   success  → green              (synced)
//   danger   → red                (sync failed)
//   warning  → gold               (waiting to sync)
//   muted    → grey               (offline)
//
// variant: inline | block | screen
// size: 'xs' (20px) | 'sm' (32px) | 'md' (64px) | 'lg' (112px) | a number
// decorative: no role/aria of its own (use when a parent already announces)
// =====================================================================

const SIZES = { xs: 20, sm: 32, md: 64, lg: 112 }
const DEFAULT_SIZE = { inline: 'sm', block: 'md', screen: 'lg' }

export default function LiquidLoader({
  tone = 'loading',
  variant = 'inline',
  size,
  label,
  sublabel,
  decorative = false,
  className = '',
  style,
}) {
  const chosen = size ?? DEFAULT_SIZE[variant] ?? 'sm'
  const px = typeof chosen === 'number' ? chosen : SIZES[chosen] || SIZES.md
  const classes = ['ll', `ll-${tone}`, `ll-${variant}`, className].filter(Boolean).join(' ')
  const a11y = decorative
    ? { 'aria-hidden': true }
    : { role: 'status', 'aria-live': 'polite', 'aria-label': label || 'Loading' }

  return (
    <span className={classes} style={{ '--ll-size': `${px}px`, ...style }} {...a11y}>
      <span className="ll-stage" aria-hidden="true">
        <span className="ll-ring" />
        <span className="ll-blob" />
      </span>
      {(label || sublabel) && !decorative && (
        <span className="ll-text">
          {label && <span className="ll-label">{label}</span>}
          {sublabel && <span className="ll-sub">{sublabel}</span>}
        </span>
      )}
    </span>
  )
}
