// src/lib/useHospitalBranding.js (PERFORMANCE-OPTIMIZED)
//
// FIX: Replaced useOfflineTable with direct Supabase query + image
// preload + session cache. The original used the full offline sync
// machinery (IndexedDB read, pagination, retry timers, realtime
// websocket) for a 1-row table that changes monthly.

import { useEffect, useState, useRef } from 'react'
import { supabase } from './supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'

// In-memory session cache — branding rarely changes
let brandingCache = null
let brandingCacheHospitalId = null
let brandingFetchPromise = null

export function useHospitalBranding() {
  const { hospital } = useAuth()
  const { isLight } = useTheme()
  const [branding, setBranding] = useState(
    brandingCacheHospitalId === hospital?.id ? brandingCache : null
  )
  const overlayRef = useRef(null)

  useEffect(() => {
    if (!hospital?.id) return

    if (brandingCacheHospitalId === hospital.id && brandingCache) {
      setBranding(brandingCache)
      return
    }

    if (brandingFetchPromise) {
      brandingFetchPromise.then(data => { if (data) setBranding(data) })
      return
    }

    brandingFetchPromise = (async () => {
      try {
        const { data, error } = await supabase
          .from('hospital_branding')
          .select('*')
          .eq('hospital_id', hospital.id)
          .maybeSingle()
        if (error) { console.warn('Branding fetch error (non-fatal):', error.message); return null }
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

    brandingFetchPromise.then(data => { if (data) setBranding(data) })
  }, [hospital?.id])

  useEffect(() => {
    try {
      const overlay = document.getElementById('hospital-bg-overlay')
      if (!overlay) return
      overlayRef.current = overlay

      if (!branding || !branding.background_enabled || !branding.background_image_path) {
        overlay.style.backgroundImage = 'none'
        overlay.style.opacity = '0'
        overlay.style.display = 'none'
        document.querySelector('.dash-shell')?.classList.remove('has-custom-bg')
        return
      }

      const { data: urlData } = supabase.storage
        .from('hospital-logos')
        .getPublicUrl(branding.background_image_path)

      const cacheBust = branding.updated_at ? `?t=${new Date(branding.updated_at).getTime()}` : ''
      const imageUrl = `${urlData.publicUrl}${cacheBust}`

      // Preload the image before showing it
      const img = new Image()
      img.onload = () => {
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
        overlay.style.display = 'none'
        overlay.style.opacity = '0'
      }
      img.src = imageUrl
    } catch (e) {
      console.warn('useHospitalBranding effect failed (non-fatal):', e.message)
    }
  }, [branding, isLight])

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
