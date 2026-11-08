// src/lib/useLiquidGlass.js
//
// APPLE-GRADE LIQUID GLASS — DYNAMIC SPECULAR TRACKING
// ============================================================
//
// Apple's Liquid Glass sheen moves based on scroll velocity:
//   • Slow scroll → calm, centered sheen
//   • Fast scroll down → sheen stretches downward
//   • Fast scroll up → sheen stretches upward
//   • Idle → sheen returns to neutral position
//
// This hook tracks scroll velocity and updates two CSS variables:
//   • --specular-offset  (px)  — sheen band Y position
//   • --specular-stretch (1.0-1.5) — vertical stretch factor
//
// These variables are read by glass.css:
//   .liquid-glass::before {
//     transform: translateY(var(--specular-offset)) scaleY(var(--specular-stretch));
//   }
//
// PERFORMANCE:
//   • Uses passive scroll listener (no main-thread blocking)
//   • Updates CSS variables directly on document.documentElement
//     (zero React re-renders)
//   • Throttled to ~60fps via requestAnimationFrame
//   • Self-cleans the velocity decay (sheen returns to neutral when idle)
//
// USAGE:
//   import { useLiquidGlass } from '../lib/useLiquidGlass';
//
//   function Dashboard() {
//     const scrollRef = useRef(null);
//     useLiquidGlass(scrollRef);  // pass a ref to the scroll container
//     return <div ref={scrollRef}>...</div>;
//   }
//
//   // Or call without a ref to track window scroll:
//   useLiquidGlass();

import { useEffect } from 'react';

export function useLiquidGlass(scrollRef) {
  useEffect(() => {
    // Determine the scroll container: the passed ref, or window.
    const container = scrollRef?.current || window;

    let lastY = container.scrollTop ?? window.scrollY;
    let lastT = performance.now();
    let velocity = 0;
    let rafId = null;
    let decayId = null;

    const update = () => {
      // Normalize velocity to a reasonable range (-100 to +100)
      const clamped = Math.max(-100, Math.min(100, velocity));

      // Map velocity to CSS variable values:
      //   offset = velocity * 0.3  (max ±30px movement)
      //   stretch = 1 + |velocity| / 100  (max 1.5x stretch)
      const offset = clamped * 0.3;
      const stretch = 1 + Math.abs(clamped) / 100;

      document.documentElement.style.setProperty('--specular-offset', `${offset}px`);
      document.documentElement.style.setProperty('--specular-stretch', stretch.toFixed(3));

      rafId = null;
    };

    const onScroll = () => {
      const y = container.scrollTop ?? window.scrollY;
      const t = performance.now();
      const dy = y - lastY;
      const dt = Math.max(1, t - lastT);

      // Exponential moving average — smooths the velocity signal
      const instant = (dy / dt) * 16;  // normalise to 60fps
      velocity = velocity * 0.7 + instant * 0.3;

      lastY = y;
      lastT = t;

      // Throttle to animation frames
      if (rafId === null) {
        rafId = requestAnimationFrame(update);
      }

      // Schedule velocity decay (sheen returns to neutral when idle)
      if (decayId) clearTimeout(decayId);
      decayId = setTimeout(() => {
        velocity = 0;
        if (rafId === null) {
          rafId = requestAnimationFrame(update);
        }
      }, 120);
    };

    container.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
      if (decayId) clearTimeout(decayId);
      // Reset CSS variables on unmount
      document.documentElement.style.removeProperty('--specular-offset');
      document.documentElement.style.removeProperty('--specular-stretch');
    };
  }, [scrollRef]);
}
