// src/lib/useHospitalBranding.js (PERFORMANCE-OPTIMIZED v2)
//
// FIX: The original used useOfflineTable('hospital_branding', ...)
// which is overkill for a 1-row table. It opened IndexedDB, read ALL
// records, filtered in JS, set up realtime subscriptions, retry timers,
// and online/offline listeners — all for a single row that changes
// maybe once a month.
//
// This version uses a direct Supabase query (1 request, no IndexedDB)
// and preloads the image before applying it (no flash of broken bg).
// No realtime subscription — admin changes are picked up on next refresh.

import { useEffect, useState, useRef } from 'react'
import { supabase } from './supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'

// Simple in-memory cache — branding rarely changes, so we cache it
// for the session. A page refresh picks up any admin changes.
let brandingCache = null
let brandingCacheHospitalId = null
let brandingFetchPromise = null

export function useHospitalBranding() {
  const { hospital } = useAuth()
  const { isLight } = useTheme()
  const [branding, setBranding] = useState(brandingCacheHospitalId === hospital?.id ? brandingCache : null)
  const overlayRef = useRef(null)

  // Fetch branding via direct query (1 request, no IndexedDB)
  useEffect(() => {
    if (!hospital?.id) return

    // Return cached value if available
    if (brandingCacheHospitalId === hospital.id && brandingCache) {
      setBranding(brandingCache)
      return
    }

    // De-dupe concurrent fetches
    if (brandingFetchPromise) {
      brandingFetchPromise.then(data => {
        if (data) setBranding(data)
      })
      return
    }

    brandingFetchPromise = (async () => {
      try {
        const { data, error } = await supabase
          .from('hospital_branding')
          .select('*')
          .eq('hospital_id', hospital.id)
          .maybeSingle()

        if (error) {
          console.warn('Branding fetch error (non-fatal):', error.message)
          return null
        }

        brandingCache = data
        brandingCacheHospitalId = hospital.id
        brandingFetchPromise = null
        return data
      } catch (e) {
        console.warn('Branding fetch failed (non-fatal):', e.message)
        brandingFetchPromise = null
        return null
      }
    })()

    brandingFetchPromise.then(data => {
      if (data) setBranding(data)
    })
  }, [hospital?.id])

  // Apply the background to the overlay div
  useEffect(() => {
    // Defensive: wrap in try/catch so branding can never crash the dashboard
    try {
      const overlay = document.getElementById('hospital-bg-overlay')
      if (!overlay) return

      overlayRef.current = overlay

      if (!branding || !branding.background_enabled || !branding.background_image_path) {
        // No background — clear everything
        overlay.style.backgroundImage = 'none'
        overlay.style.opacity = '0'
        overlay.style.display = 'none'
        document.querySelector('.dash-shell')?.classList.remove('has-custom-bg')
        return
      }

      // Build the public URL for the stored image
      const { data: urlData } = supabase.storage
        .from('hospital-logos')
        .getPublicUrl(branding.background_image_path)

      // Cache-buster: append the updated_at timestamp
      const cacheBust = branding.updated_at ? `?t=${new Date(branding.updated_at).getTime()}` : ''
      const imageUrl = `${urlData.publicUrl}${cacheBust}`

      // PRELOAD the image before showing it — prevents flash of broken bg
      const img = new Image()
      img.onload = () => {
        // Image loaded — apply it
        overlay.style.display = 'block'
        overlay.style.backgroundImage = `url("${imageUrl}")`
        overlay.style.backgroundSize = branding.background_size || 'cover'
        overlay.style.backgroundRepeat = 'no-repeat'
        overlay.style.backgroundPosition = branding.background_position || 'center'

        const brightness = Number(branding.background_brightness) || 1.0
        overlay.style.filter = `brightness(${brightness})`

        const opacity = Number(branding.background_opacity) || 0.6
        overlay.style.opacity = String(opacity)

        if (isLight) {
          overlay.style.boxShadow = 'inset 0 0 0 9999px rgba(243, 246, 248, 0.35)'
        } else {
          overlay.style.boxShadow = 'inset 0 0 0 9999px rgba(7, 15, 20, 0.45)'
        }

        document.querySelector('.dash-shell')?.classList.add('has-custom-bg')
      }
      img.onerror = () => {
        // Image failed to load — just don't show it
        overlay.style.display = 'none'
        overlay.style.opacity = '0'
      }
      // Start preloading
      img.src = imageUrl
    } catch (e) {
      console.warn('useHospitalBranding effect failed (non-fatal):', e.message)
    }
  }, [branding, isLight])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        const overlay = overlayRef.current
        if (overlay) {
          overlay.style.backgroundImage = 'none'
          overlay.style.opacity = '0'
          overlay.style.display = 'none'
        }
        document.querySelector('.dash-shell')?.classList.remove('has-custom-bg')
      } catch {}
    }
  }, [])

  return { branding }
}
