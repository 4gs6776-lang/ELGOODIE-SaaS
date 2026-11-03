import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import AppIcon from './icons'
import { Upload, Image as ImageIcon, X, Check, RotateCcw, Sun, Layers, Maximize, Minimize } from 'lucide-react'

// =====================================================================
// HospitalBackgroundSettings — admin-only panel for uploading + managing
// the hospital's dashboard background image.
//
// Features:
//   - Drag-and-drop upload area + Browse Files button
//   - File validation (JPG/PNG/WEBP, max 5MB)
//   - Image compression to WEBP (max 1920px width)
//   - Upload progress bar
//   - Live preview (mini dashboard mockup with sample KPI cards)
//   - Brightness slider (50-150%, default 100%)
//   - Opacity slider (0-100%, default 60%)
//   - Position selector (Center/Top/Bottom)
//   - Size selector (Cover/Contain)
//   - Apply Background button (saves to DB)
//   - Cancel Changes button (reverts to saved state)
//   - Remove Background / Restore Default button (with confirmation)
//
// Multi-tenant isolation:
//   - Reads/writes only the current hospital's branding row
//   - RLS enforces hospital_id = current_hospital_id()
//   - Storage path: ${hospital.id}/dashboard-bg (isolated per hospital)
// =====================================================================

// Compress + convert image to WEBP via canvas
// Reuses the same pattern as Settings.jsx's compressLogo()
async function compressToWebP(file, maxWidth = 1920) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please select an image file (JPG, PNG, or WEBP).'))
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        // Calculate dimensions — never upscale
        let { width, height } = img
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width)
          width = maxWidth
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Could not compress the image. Try a different file.'))
              return
            }
            resolve(blob)
          },
          'image/webp',
          0.85  // quality — 85% is a good balance for photos
        )
      }
      img.onerror = () => reject(new Error('Could not load the image.'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.readAsDataURL(file)
  })
}

const DEFAULTS = {
  background_enabled: false,
  background_image_path: null,
  background_position: 'center',
  background_brightness: 1.0,
  background_opacity: 0.6,
  background_size: 'cover',
}

export default function HospitalBackgroundSettings() {
  const { profile, hospital, reload } = useAuth()
  const { records, addRecord, updateRecord, syncFromServer } = useOfflineTable('hospital_branding', hospital?.id, { realtime: true })

  // Get the existing branding row (singleton per hospital)
  const existing = records?.[0] || null

  // Draft state — holds the user's in-progress changes before "Apply"
  const [draft, setDraft] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [pendingImageUrl, setPendingImageUrl] = useState(null)  // for preview before upload
  const [confirmRemove, setConfirmRemove] = useState(false)
  const fileInputRef = useRef(null)

  // The "working" state — either the draft (if editing) or the saved branding
  const current = draft || existing || DEFAULTS

  // Initialize draft from existing when component mounts or existing changes
  useEffect(() => {
    if (!draft && existing) {
      // draft is null until the user makes a change — show the saved state
    }
  }, [existing, draft])

  // Clear success/error messages after 4 seconds
  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(''), 4000)
      return () => clearTimeout(t)
    }
  }, [success])

  // Handle file selection (from drag-drop or browse)
  const handleFile = useCallback(async (file) => {
    setError('')

    // Validate file type
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (!validTypes.includes(file.type)) {
      setError('Please select a JPG, PNG, or WEBP image file.')
      return
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image is too large (max 5MB). Please choose a smaller image.')
      return
    }

    // Show preview immediately (before compression)
    const previewUrl = URL.createObjectURL(file)
    setPendingImageUrl(previewUrl)

    // Initialize draft with the new image + defaults for new uploads
    setDraft({
      ...DEFAULTS,
      ...existing,
      background_enabled: true,
      background_image_path: `${hospital.id}/dashboard-bg`,  // will be set on apply
      _pendingFile: file,
      _pendingPreviewUrl: previewUrl,
    })
  }, [existing, hospital?.id])

  // Drag and drop handlers
  const handleDragOver = (e) => {
    e.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = (e) => {
    e.preventDefault()
    setDragOver(false)
  }
  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  // Update draft field
  const updateDraft = (field, value) => {
    setDraft(prev => ({ ...prev, [field]: value }))
  }

  // Apply — upload the image + save the branding row
  const handleApply = async () => {
    if (!draft) return
    setError('')
    setUploading(true)
    setUploadProgress(0)

    try {
      let imagePath = draft.background_image_path

      // If there's a pending file, compress + upload it
      if (draft._pendingFile) {
        setUploadProgress(10)
        const compressed = await compressToWebP(draft._pendingFile, 1920)
        setUploadProgress(40)

        imagePath = `${hospital.id}/dashboard-bg`
        const { error: uploadErr } = await supabase.storage
          .from('hospital-logos')
          .upload(imagePath, compressed, {
            upsert: true,
            contentType: 'image/webp',
          })
        if (uploadErr) throw uploadErr
        setUploadProgress(70)
      }

      // Save the branding row (upsert — singleton per hospital)
      const payload = {
        hospital_id: hospital.id,
        background_image_path: imagePath,
        background_enabled: draft.background_enabled,
        background_position: draft.background_position,
        background_brightness: Number(draft.background_brightness),
        background_opacity: Number(draft.background_opacity),
        background_size: draft.background_size,
        updated_by: profile.id,
      }

      setUploadProgress(85)

      if (existing) {
        // Update existing row
        const { error: updateErr } = await supabase
          .from('hospital_branding')
          .update(payload)
          .eq('id', existing.id)
        if (updateErr) throw updateErr
      } else {
        // Insert new row
        const { error: insertErr } = await supabase
          .from('hospital_branding')
          .insert(payload)
        if (insertErr) throw insertErr
      }

      setUploadProgress(100)

      // Audit trail
      writeAudit({
        hospitalId: hospital.id,
        actor: profile,
        action: 'hospital_branding.updated',
        entityType: 'hospital_branding',
        entityId: existing?.id || null,
        summary: `Dashboard background ${draft._pendingFile ? 'uploaded' : 'updated'} — position: ${draft.background_position}, brightness: ${draft.background_brightness}, opacity: ${draft.background_opacity}, size: ${draft.background_size}`,
        metadata: {
          background_enabled: draft.background_enabled,
          background_position: draft.background_position,
          background_brightness: draft.background_brightness,
          background_opacity: draft.background_opacity,
          background_size: draft.background_size,
        },
      })

      // Refresh the branding data
      await syncFromServer()

      // Clean up pending state
      if (draft._pendingPreviewUrl) {
        URL.revokeObjectURL(draft._pendingPreviewUrl)
      }
      setPendingImageUrl(null)
      setDraft(null)
      setSuccess('Background applied successfully! All staff in your hospital will see this background.')
    } catch (err) {
      setError(err.message || 'Could not apply the background.')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  // Cancel — revert draft to existing
  const handleCancel = () => {
    if (draft?._pendingPreviewUrl) {
      URL.revokeObjectURL(draft._pendingPreviewUrl)
    }
    setPendingImageUrl(null)
    setDraft(null)
    setError('')
  }

  // Remove — delete the image + reset branding to defaults
  const handleRemove = async () => {
    setError('')
    setUploading(true)
    try {
      // Delete the image from storage
      if (existing?.background_image_path) {
        const { error: deleteErr } = await supabase.storage
          .from('hospital-logos')
          .remove([existing.background_image_path])
        if (deleteErr) {
          console.warn('Could not delete image from storage:', deleteErr.message)
          // Non-fatal — the DB row will still be reset
        }
      }

      // Update the branding row to disabled
      if (existing) {
        const { error: updateErr } = await supabase
          .from('hospital_branding')
          .update({
            background_enabled: false,
            background_image_path: null,
            updated_by: profile.id,
          })
          .eq('id', existing.id)
        if (updateErr) throw updateErr
      }

      writeAudit({
        hospitalId: hospital.id,
        actor: profile,
        action: 'hospital_branding.removed',
        entityType: 'hospital_branding',
        entityId: existing?.id || null,
        summary: 'Dashboard background removed — restored to default',
      })

      await syncFromServer()
      setDraft(null)
      setConfirmRemove(false)
      setSuccess('Background removed. Dashboard restored to default.')
    } catch (err) {
      setError(err.message || 'Could not remove the background.')
    } finally {
      setUploading(false)
    }
  }

  // The image URL for the preview
  const previewImageUrl = pendingImageUrl || (existing?.background_image_path
    ? supabase.storage.from('hospital-logos').getPublicUrl(existing.background_image_path).publicUrl
    : null)

  const hasBackground = !!(draft?.background_image_path || existing?.background_image_path)
  const isDirty = draft !== null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ---- Upload area ---- */}
      {!hasBackground && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? 'var(--teal)' : 'var(--line)'}`,
            borderRadius: 12,
            padding: '32px 20px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragOver ? 'rgba(0,199,199,0.05)' : 'var(--bg-elevated)',
            transition: 'all .2s ease',
          }}
        >
          <Upload size={32} style={{ color: 'var(--teal)', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ivory)', marginBottom: 4 }}>
            Drag & drop an image here
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            or click to browse — JPG, PNG, or WEBP (max 5MB)
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted-dim)' }}>
            Images are automatically compressed to WEBP for faster loading
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
              e.target.value = ''  // reset so same file can be re-selected
            }}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {/* ---- Error / Success messages ---- */}
      {error && (
        <div style={{
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(240,79,95,0.10)',
          border: '1px solid var(--danger-soft)',
          color: 'var(--danger)',
          fontSize: 12.5,
        }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(24,217,155,0.10)',
          border: '1px solid var(--mint-border)',
          color: 'var(--mint)',
          fontSize: 12.5,
        }}>
          ✅ {success}
        </div>
      )}

      {/* ---- Upload progress ---- */}
      {uploading && uploadProgress > 0 && (
        <div style={{
          height: 6,
          background: 'var(--line)',
          borderRadius: 3,
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${uploadProgress}%`,
            background: 'linear-gradient(90deg, var(--teal), var(--teal-bright))',
            transition: 'width .3s ease',
          }} />
        </div>
      )}

      {/* ---- Preview + controls ---- */}
      {hasBackground && (
        <>
          {/* Mini dashboard mockup preview */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px', minWidth: 280 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 8,
              }}>
                Live Preview
              </div>
              <div style={{
                position: 'relative',
                width: '100%',
                height: 200,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid var(--line)',
                background: 'var(--bg)',
              }}>
                {/* Background image layer */}
                {previewImageUrl && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundImage: `url("${previewImageUrl}")`,
                    backgroundSize: current.background_size,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: current.background_position,
                    filter: `brightness(${current.background_brightness})`,
                    opacity: current.background_opacity,
                  }} />
                )}
                {/* Dark overlay for readability (simulates auto overlay) */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(7,15,20,0.45)',
                }} />
                {/* Sample KPI cards */}
                <div style={{
                  position: 'relative',
                  zIndex: 1,
                  padding: 12,
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 8,
                  height: '100%',
                }}>
                  <div style={{
                    background: 'rgba(11,11,15,0.85)',
                    backdropFilter: 'blur(8px)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase' }}>Patients</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--teal)' }}>39</div>
                  </div>
                  <div style={{
                    background: 'rgba(11,11,15,0.85)',
                    backdropFilter: 'blur(8px)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase' }}>Revenue</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--mint)' }}>₦42k</div>
                  </div>
                  <div style={{
                    gridColumn: '1 / -1',
                    background: 'rgba(11,11,15,0.85)',
                    backdropFilter: 'blur(8px)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase' }}>Hospital Activity</div>
                    <div style={{
                      height: 24,
                      marginTop: 4,
                      background: 'linear-gradient(90deg, var(--teal-soft), transparent)',
                      borderRadius: 4,
                    }} />
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted-dim)', marginTop: 6, textAlign: 'center' }}>
                Preview shows how cards will appear over the background
              </div>
            </div>

            {/* Controls */}
            <div style={{ flex: '1 1 280px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Position */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>
                  Position
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['center', 'top', 'bottom'].map(pos => (
                    <button
                      key={pos}
                      onClick={() => updateDraft('background_position', pos)}
                      style={{
                        flex: 1,
                        padding: '8px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: `1px solid ${current.background_position === pos ? 'var(--teal)' : 'var(--line)'}`,
                        background: current.background_position === pos ? 'var(--teal-soft)' : 'transparent',
                        color: current.background_position === pos ? 'var(--teal)' : 'var(--muted)',
                        cursor: 'pointer',
                        textTransform: 'capitalize',
                      }}
                    >
                      {pos}
                    </button>
                  ))}
                </div>
              </div>

              {/* Size */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>
                  Size
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => updateDraft('background_size', 'cover')}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      fontSize: 12,
                      fontWeight: 600,
                      borderRadius: 8,
                      border: `1px solid ${current.background_size === 'cover' ? 'var(--teal)' : 'var(--line)'}`,
                      background: current.background_size === 'cover' ? 'var(--teal-soft)' : 'transparent',
                      color: current.background_size === 'cover' ? 'var(--teal)' : 'var(--muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    <Maximize size={13} /> Cover
                  </button>
                  <button
                    onClick={() => updateDraft('background_size', 'contain')}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      fontSize: 12,
                      fontWeight: 600,
                      borderRadius: 8,
                      border: `1px solid ${current.background_size === 'contain' ? 'var(--teal)' : 'var(--line)'}`,
                      background: current.background_size === 'contain' ? 'var(--teal-soft)' : 'transparent',
                      color: current.background_size === 'contain' ? 'var(--teal)' : 'var(--muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    <Minimize size={13} /> Contain
                  </button>
                </div>
              </div>

              {/* Brightness slider */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>Brightness</span>
                  <span style={{ color: 'var(--teal)' }}>{Math.round(current.background_brightness * 100)}%</span>
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={current.background_brightness}
                  onChange={(e) => updateDraft('background_brightness', parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--teal)' }}
                />
              </div>

              {/* Opacity slider */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>Opacity</span>
                  <span style={{ color: 'var(--teal)' }}>{Math.round(current.background_opacity * 100)}%</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={current.background_opacity}
                  onChange={(e) => updateDraft('background_opacity', parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--teal)' }}
                />
              </div>

              {/* Enabled toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: 8,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--line)',
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ivory)' }}>Background enabled</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>Toggle off to hide without deleting</div>
                </div>
                <button
                  onClick={() => updateDraft('background_enabled', !current.background_enabled)}
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 12,
                    border: 'none',
                    background: current.background_enabled ? 'var(--teal)' : 'var(--line)',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'background .2s ease',
                  }}
                >
                  <div style={{
                    position: 'absolute',
                    top: 3,
                    left: current.background_enabled ? 23 : 3,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: 'white',
                    transition: 'left .2s ease',
                  }} />
                </button>
              </div>
            </div>
          </div>

          {/* ---- Action buttons ---- */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            {isDirty && (
              <>
                <button
                  onClick={handleApply}
                  disabled={uploading}
                  style={{
                    padding: '10px 20px',
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 8,
                    border: 'none',
                    background: 'var(--teal)',
                    color: 'white',
                    cursor: uploading ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {uploading ? 'Applying…' : (<><Check size={15} /> Apply Background</>)}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={uploading}
                  style={{
                    padding: '10px 20px',
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    background: 'transparent',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <X size={15} /> Cancel Changes
                </button>
              </>
            )}

            {/* Replace image button (when background exists) */}
            {hasBackground && !isDirty && (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                style={{
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  border: '1px solid var(--teal-border)',
                  background: 'var(--teal-soft)',
                  color: 'var(--teal)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Upload size={15} /> Replace Image
              </button>
            )}

            {/* Remove button */}
            {hasBackground && !confirmRemove && (
              <button
                onClick={() => setConfirmRemove(true)}
                disabled={uploading}
                style={{
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  border: '1px solid var(--danger-soft)',
                  background: 'transparent',
                  color: 'var(--danger)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginLeft: 'auto',
                }}
              >
                <RotateCcw size={15} /> Remove / Restore Default
              </button>
            )}

            {/* Confirm remove */}
            {confirmRemove && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(240,79,95,0.08)',
                border: '1px solid var(--danger-soft)',
                marginLeft: 'auto',
              }}>
                <span style={{ fontSize: 12, color: 'var(--danger)' }}>Permanently remove?</span>
                <button
                  onClick={handleRemove}
                  disabled={uploading}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: 'none',
                    background: 'var(--danger)',
                    color: 'white',
                    cursor: 'pointer',
                  }}
                >
                  Yes, remove
                </button>
                <button
                  onClick={() => setConfirmRemove(false)}
                  disabled={uploading}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: '1px solid var(--line)',
                    background: 'transparent',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Hidden file input for "Replace Image" */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
        style={{ display: 'none' }}
      />
    </div>
  )
}
