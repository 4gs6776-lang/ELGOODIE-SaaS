import { useState, useEffect, useCallback, useRef } from 'react'

// =====================================================================
// useSmartPosition — intelligent placement for the floating calculator.
//
// Requirements from the spec (Section 3):
//   • Inspect available viewport space when the calculator opens.
//   • Identify visible billing elements (invoice tables, payment fields,
//     totals, action buttons, discount controls, modals) and avoid them.
//   • Prefer unused whitespace; if the right side is occupied try the
//     left; if both are occupied try upper/lower areas.
//   • Never extend outside the viewport.
//   • Recalculate on window resize / scroll / layout change.
//   • Remember the position for the session (if still valid).
//
// Approach: when the calculator opens (or the layout changes), sample
// candidate anchor points (top-right, top-left, bottom-right, bottom-left,
// then center fallbacks) and score each by how much it overlaps the
// billing "obstruction" elements (data-calc-avoid attribute) and
// whether it stays in-viewport. Pick the best-scoring position. The
// cashier can still drag it anywhere; we only auto-place when there
// is no valid remembered position.
// =====================================================================

const CALC_W = 300
const CALC_H = 460  // approx full height incl history
const MARGIN = 16

function rectsOverlap(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
}

function getObstructionRects() {
  // Elements tagged data-calc-avoid are the billing regions we must not
  // cover. Also any element with role="dialog" that is a blocking modal
  // (we never auto-place over a modal — but the calculator renders at
  // z-index 9000, below modals at 10000+, so it's fine).
  const els = document.querySelectorAll('[data-calc-avoid]')
  const rects = []
  els.forEach(el => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) rects.push(r)
  })
  return rects
}

function scorePosition(x, y, obstructions, vw, vh) {
  const calcRect = { left: x, top: y, right: x + CALC_W, bottom: y + CALC_H }
  // Hard fail: out of viewport
  if (x < MARGIN || y < MARGIN || x + CALC_W > vw - MARGIN || y + CALC_H > vh - MARGIN) {
    return -1
  }
  // Count overlap area with obstructions (lower is better)
  let overlapArea = 0
  for (const o of obstructions) {
    if (!rectsOverlap(calcRect, o)) continue
    const ix = Math.max(0, Math.min(calcRect.right, o.right) - Math.max(calcRect.left, o.left))
    const iy = Math.max(0, Math.min(calcRect.bottom, o.bottom) - Math.max(calcRect.top, o.top))
    overlapArea += ix * iy
  }
  // Prefer corners (whitespace tends to be in corners). Penalize center.
  const cx = vw / 2, cy = vh / 2
  const calcCx = x + CALC_W / 2, calcCy = y + CALC_H / 2
  const distFromCenter = Math.hypot(calcCx - cx, calcCy - cy)
  // Score: higher is better. -overlapArea (less overlap = higher score)
  // + small bonus for being away from center (corner preference).
  return -overlapArea + distFromCenter * 0.05
}

function findBestPosition(vw, vh) {
  const obstructions = getObstructionRects()
  const candidates = []
  // Candidate anchors (x, y) — corners first, then edges, then center.
  const w = CALC_W, h = CALC_H
  candidates.push({ x: vw - w - MARGIN, y: MARGIN, label: 'top-right' })
  candidates.push({ x: MARGIN, y: MARGIN, label: 'top-left' })
  candidates.push({ x: vw - w - MARGIN, y: vh - h - MARGIN, label: 'bottom-right' })
  candidates.push({ x: MARGIN, y: vh - h - MARGIN, label: 'bottom-left' })
  candidates.push({ x: vw - w - MARGIN, y: (vh - h) / 2, label: 'mid-right' })
  candidates.push({ x: MARGIN, y: (vh - h) / 2, label: 'mid-left' })
  candidates.push({ x: (vw - w) / 2, y: MARGIN, label: 'top-center' })
  candidates.push({ x: (vw - w) / 2, y: vh - h - MARGIN, label: 'bottom-center' })

  let best = null
  let bestScore = -Infinity
  for (const c of candidates) {
    const s = scorePosition(c.x, c.y, obstructions, vw, vh)
    if (s > bestScore) { bestScore = s; best = c }
  }
  // If the best is still heavily overlapping (no whitespace found),
  // fall back to bottom-right so it doesn't cover the top toolbar.
  if (bestScore < -50000) {
    return { x: Math.max(MARGIN, vw - w - MARGIN), y: Math.max(MARGIN, vh - h - MARGIN) }
  }
  return { x: best.x, y: best.y }
}

export function useSmartPosition(enabled, storageKey = 'gmedhub-calc-pos') {
  const [position, setPosition] = useState(null)
  const remembered = useRef(null)
  const lastLayoutHash = useRef('')

  const recompute = useCallback(() => {
    const vw = window.innerWidth, vh = window.innerHeight
    // Mobile / narrow viewport: bottom-right compact so it doesn't
    // cover billing actions. The FloatingCalculator uses responsive
    // width via CSS when viewport < 640.
    if (vw < 640) {
      setPosition({ x: MARGIN, y: Math.max(MARGIN, vh - CALC_H - MARGIN - 80) })
      return
    }
    // If we have a remembered position that is still valid (in-viewport),
    // keep it — the cashier dragged it there this session.
    if (remembered.current) {
      const r = remembered.current
      const w = CALC_W, h = CALC_H
      if (r.x >= MARGIN && r.y >= MARGIN && r.x + w <= vw - MARGIN && r.y + h <= vh - MARGIN) {
        setPosition(r)
        return
      }
    }
    setPosition(findBestPosition(vw, vh))
  }, [])

  // When enabled (calculator opens), compute an initial position.
  useEffect(() => {
    if (!enabled) { setPosition(null); return }
    recompute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Recompute on resize / scroll / layout change. We debounce layout
  // changes by hashing the bounding rects of obstructions so we don't
  // thrash on every animation frame.
  useEffect(() => {
    if (!enabled) return
    const check = () => {
      const obstructions = getObstructionRects()
      const hash = obstructions.map(r => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`).join('|')
      if (hash !== lastLayoutHash.current) {
        lastLayoutHash.current = hash
        // Only auto-move if the current position now overlaps an
        // obstruction significantly — don't yank a manually-placed calc.
        const cur = position || remembered.current
        if (cur) {
          const calcRect = { left: cur.x, top: cur.y, right: cur.x + CALC_W, bottom: cur.y + CALC_H }
          let bigOverlap = false
          for (const o of obstructions) {
            if (rectsOverlap(calcRect, o)) {
              const ix = Math.max(0, Math.min(calcRect.right, o.right) - Math.max(calcRect.left, o.left))
              const iy = Math.max(0, Math.min(calcRect.bottom, o.bottom) - Math.max(calcRect.top, o.top))
              if (ix * iy > 4000) { bigOverlap = true; break }
            }
          }
          if (bigOverlap) recompute()
        } else {
          recompute()
        }
      }
    }
    const debounced = debounce(check, 200)
    window.addEventListener('resize', debounced)
    window.addEventListener('scroll', debounced, true)
    // Observe DOM mutations in the billing area (modals opening etc.)
    const observer = new MutationObserver(debounced)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-calc-avoid'] })
    return () => {
      window.removeEventListener('resize', debounced)
      window.removeEventListener('scroll', debounced, true)
      observer.disconnect()
    }
  }, [enabled, position, recompute])

  // When the cashier drags, remember the new position for the session.
  const handlePositionChange = useCallback((newPos) => {
    remembered.current = newPos
    setPosition(newPos)
    try { sessionStorage.setItem(storageKey, JSON.stringify(newPos)) } catch {}
  }, [storageKey])

  return { position, handlePositionChange, recompute }
}

function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}
