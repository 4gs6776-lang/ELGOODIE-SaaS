// src/components/LiquidGlassSVG.jsx
//
// SVG filters that bend whatever sits behind a glass card, used by
// src/theme/liquid-glass.css through backdrop-filter: url(#...).
// Mount once at the app root (main.jsx already does).
//
//   #lg-panel       large cards and panels
//   #lg-tile        KPI tiles and small cards
//   #liquid-refraction   kept so older glass.css rules keep working
//
// Each filter reads a displacement map: neutral grey in the middle of the
// card (nothing moves) and a narrow band along the edges where the
// backdrop is pushed toward the centre. The map is stretched to the size
// of the element, so the same filter works for any card size.
//
// Only Chromium on desktop applies backdrop-filter: url(). main.jsx adds
// the class "lg-refract" to <html> there; every other browser keeps the
// plain blur defined in liquid-glass.css.

import React from 'react'

function edgeMap({ band, blur }) {
  const W = 400
  const H = 300
  const bx = Math.round(W * band)
  const by = Math.round(H * band)
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>` +
    `<defs>` +
    `<linearGradient id='x' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#f00'/><stop offset='1' stop-color='#000'/></linearGradient>` +
    `<linearGradient id='y' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#0f0'/><stop offset='1' stop-color='#000'/></linearGradient>` +
    `</defs>` +
    `<rect width='${W}' height='${H}' fill='#000'/>` +
    `<rect width='${W}' height='${H}' fill='url(#y)' style='mix-blend-mode:screen'/>` +
    `<rect width='${W}' height='${H}' fill='url(#x)' style='mix-blend-mode:screen'/>` +
    `<rect x='${bx}' y='${by}' width='${W - bx * 2}' height='${H - by * 2}' rx='${Math.round(Math.min(bx, by) * 1.4)}' fill='#808080' style='filter:blur(${blur}px)'/>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const PANEL_MAP = edgeMap({ band: 0.05, blur: 12 })
const TILE_MAP = edgeMap({ band: 0.09, blur: 8 })

function GlassFilter({ id, map, scale }) {
  return (
    <filter id={id} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
      <feImage href={map} preserveAspectRatio="none" result="map" />
      <feDisplacementMap in="SourceGraphic" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  )
}

export default function LiquidGlassSVG() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        <GlassFilter id="lg-panel" map={PANEL_MAP} scale={18} />
        <GlassFilter id="lg-tile" map={TILE_MAP} scale={14} />
        <GlassFilter id="liquid-refraction" map={TILE_MAP} scale={14} />
      </defs>
    </svg>
  )
}
