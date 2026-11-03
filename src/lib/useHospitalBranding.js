import { useEffect, useRef } from 'react'
import { supabase } from './supabaseClient'
import { useOfflineTable } from './useOfflineTable'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'

// =====================================================================
// useHospitalBranding — reads the current hospital's branding config
// and applies the dashboard background via a fixed overlay div.
//
// Architecture:
//   - Reads from `hospital_branding` table via useOfflineTable (5-min
//     cache, IndexedDB-backed, realtime-enabled)
//   - Applies background to a <div id="hospital-bg-overlay"> that
//     gets mounted in Dashboard.jsx
//   - Brightness applied via CSS filter:brightness() on the overlay
//     div ONLY — never affects dashboard content
//   - Opacity applied via the overlay div's opacity property
//   - Light/dark mode overlay: when isLight, adds a white tint;
//     when isDark, adds a dark tint — for readability
//   - Cleans up on unmount (removes the overlay's styles)
//
// Multi-tenant isolation:
//   - useOfflineTable filters by hospital_id — only the current
//     hospital's branding row is loaded
//   - RLS policies enforce hospital_id = current_hospital_id() at
//     the database level
// =====================================================================

export function useHospitalBranding() {
  const { hospital } = useAuth()
  const { isLight } = useTheme()
  const { records, syncFromServer } = useOfflineTable('hospital_branding', hospital?.id, { realtime: true })
  const overlayRef = useRef(null)

  // Get the branding row (singleton per hospital — take the first one)
  const branding = records?.[0] || null

  // Listen for realtime updates so cross-device changes propagate
  useEffect(() => {
    if (!hospital?.id) return
    // Initial sync
    syncFromServer()
  }, [hospital?.id, syncFromServer])

  // Apply the background to the overlay div
  useEffect(() => {
    const overlay = document.getElementById('hospital-bg-overlay')
    if (!overlay) return

    overlayRef.current = overlay

    if (!branding || !branding.background_enabled || !branding.background_image_path) {
      // No background — clear everything
      overlay.style.backgroundImage = 'none'
      overlay.style.opacity = '0'
      overlay.style.display = 'none'
      // Remove the "has custom bg" class from the shell
      document.querySelector('.dash-shell')?.classList.remove('has-custom-bg')
      return
    }

    // Build the public URL for the stored image
    const { data: urlData } = supabase.storage
      .from('hospital-logos')
      .getPublicUrl(branding.background_image_path)

    // Cache-buster: append the updated_at timestamp so the browser
    // fetches the new image when it changes
    const cacheBust = branding.updated_at ? `?t=${new Date(branding.updated_at).getTime()}` : ''
    const imageUrl = `${urlData.publicUrl}${cacheBust}`

    // Apply the background image
    overlay.style.display = 'block'
    overlay.style.backgroundImage = `url("${imageUrl}")`
    overlay.style.backgroundSize = branding.background_size || 'cover'
    overlay.style.backgroundRepeat = 'no-repeat'
    overlay.style.backgroundPosition = branding.background_position || 'center'

    // Brightness via CSS filter — applies to the overlay div ONLY,
    // never to the dashboard content
    const brightness = Number(branding.background_brightness) || 1.0
    overlay.style.filter = `brightness(${brightness})`

    // Opacity — the overlay div's opacity controls how visible the
    // image is. This is on the overlay only, not the content.
    const opacity = Number(branding.background_opacity) || 0.6
    overlay.style.opacity = String(opacity)

    // Light/dark mode overlay tint — add a semi-transparent layer
    // on top of the image for readability
    if (isLight) {
      // Light mode: add a white tint so dark images don't make
      // light-mode text hard to read
      overlay.style.boxShadow = 'inset 0 0 0 9999px rgba(243, 246, 248, 0.35)'
    } else {
      // Dark mode: add a dark tint so bright images don't wash out
      // the dashboard
      overlay.style.boxShadow = 'inset 0 0 0 9999px rgba(7, 15, 20, 0.45)'
    }

    // Mark the shell as having a custom background so CSS can make
    // .dash-main transparent
    document.querySelector('.dash-shell')?.classList.add('has-custom-bg')
  }, [branding, isLight])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const overlay = overlayRef.current
      if (overlay) {
        overlay.style.backgroundImage = 'none'
        overlay.style.opacity = '0'
        overlay.style.display = 'none'
      }
      document.querySelector('.dash-shell')?.classList.remove('has-custom-bg')
    }
  }, [])

  return { branding, syncFromServer }
}
