// src/components/LiquidGlassSVG.jsx
//
// APPLE-GRADE LIQUID GLASS — TRUE REFRACTION (SVG FILTER)
// ============================================================
//
// Mount this component ONCE at the app root (in main.jsx or App.jsx).
// It injects a hidden SVG containing a <filter> definition that
// uses feDisplacementMap to bend pixels at the edges of glass elements.
//
// This creates the "lens" effect Apple's glass has — content behind
// the glass appears to refract (bend) at the edges.
//
// USAGE (in main.jsx or App.jsx):
//
//   import LiquidGlassSVG from './components/LiquidGlassSVG';
//
//   <ThemeProvider>
//     <LiquidGlassSVG />   {/* mount once */}
//     <App />
//   </ThemeProvider>
//
// Then add the class `liquid-glass-refract` to any element you want
// to have true refraction. The CSS in glass.css handles the rest:
//
//   .liquid-glass-refract {
//     backdrop-filter: blur(40px) saturate(180%) brightness(1.05) url(#liquid-refraction);
//   }
//
// BROWSER SUPPORT:
//   • Chrome 100+  ✅ full support
//   • Edge 100+    ✅ full support
//   • Safari 18+   ⚠️ partial (backdrop-filter: url() support varies)
//   • Firefox      ⚠️ partial
//   • Mobile       ❌ disabled (glass.css falls back to plain blur)
//
// If the browser doesn't support backdrop-filter: url(), the filter
// is silently ignored and the element still gets blur + saturate.
// No broken experience.
// ============================================================

import React from 'react';

export default function LiquidGlassSVG() {
  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        {/*
          Displacement map: a radial gradient that goes from neutral
          (no displacement) at the center to maximum displacement at
          the edges. This is what creates the lens refraction effect.

          The displacement map is generated procedurally using SVG
          gradients so we don't need an external image file.

          Channel R = X displacement (horizontal)
          Channel G = Y displacement (vertical)

          scale=12 means up to 12px displacement at the edges.
        */}
        <filter id="liquid-refraction" x="-20%" y="-20%" width="140%" height="140%">
          {/* Generate a radial gradient as the displacement source.
              Center = neutral gray (no displacement).
              Edges = bright/dark (max displacement).

              We use feImage with an inline SVG data URI because
              feFlood + feComposite can't easily produce a smooth
              radial gradient that feDisplacementMap can read. */}
          <feImage
            href="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cdefs%3E%3CradialGradient id='r' cx='50%25' cy='50%25' r='50%25'%3E%3Cstop offset='0%25' stop-color='%23808080'/%3E%3Cstop offset='70%25' stop-color='%23a0a0a0'/%3E%3Cstop offset='100%25' stop-color='%23c0c0c0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='200' height='200' fill='url(%23r)'/%3E%3C/svg%3E"
            result="displacementMap"
          />
          {/* Apply the displacement to the source.
              scale=12 = up to 12px displacement at edges.
              xChannelSelector=R, yChannelSelector=G (standard). */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="displacementMap"
            scale="12"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}
