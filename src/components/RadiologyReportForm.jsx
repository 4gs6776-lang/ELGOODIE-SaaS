import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import { Upload, Save, Send, X, FileText, Printer } from 'lucide-react'

// =====================================================================
// RadiologyReportForm — full radiology report editor
// =====================================================================
// Opens as a modal when the doctor clicks "Report" on a scan.
// Auto-fills patient info from the patients table.
// Doctor writes: examination, modality, contrast, technique, findings,
// impression, recommendation.
// Can upload a scan image.
// Can "Send to Nurse" — changes status to 'ready_for_printing' + sends
// a notification to the nursing dashboard.
// =====================================================================

const MODALITIES = ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Fluoroscopy']

export default function RadiologyReportForm({ scan, onClose, onUpdate }) {
  const { profile, hospital } = useAuth()
  const { records: patients } = useOfflineTable('patients', hospital?.id)
  const { updateRecord } = useOfflineTable('radiology_scans', hospital?.id)

  // Find the patient from the patients table (by name match or patient_id)
  const patient = scan.patient_id
    ? patients.find(p => p.id === scan.patient_id)
    : patients.find(p => p.full_name === scan.patient_name)

  // Form state
  const [referringDoctor, setReferringDoctor] = useState(scan.referring_doctor || '')
  const [modality, setModality] = useState(scan.modality || MODALITIES[0])
  const [contrastUsed, setContrastUsed] = useState(scan.contrast_used || '')
  const [radiationDose, setRadiationDose] = useState(scan.radiation_dose || '')
  const [technique, setTechnique] = useState(scan.technique || '')
  const [findings, setFindings] = useState(scan.findings || scan.report || '')
  const [impression, setImpression] = useState(scan.impression || '')
  const [recommendation, setRecommendation] = useState(scan.recommendation || '')
  const [imageFile, setImageFile] = useState(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState(scan.scan_image_path || null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  // Auto-fill patient info for display (read-only)
  const patientInfo = {
    name: patient?.full_name || scan.patient_name || '—',
    age: patient?.age || (patient?.date_of_birth ? Math.floor((Date.now() - new Date(patient.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000)) : '—'),
    sex: patient?.gender || '—',
    phone: patient?.phone || '—',
    address: patient?.address || patient?.residential_address || '—',
    mrn: patient?.hospital_number || '—',
    hospital: hospital?.name || '—',
  }

  async function handleImageUpload(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Image is too large (max 10MB).')
      return
    }
    setImageFile(file)
    setImagePreviewUrl(URL.createObjectURL(file))
    setError('')
  }

  async function handleSave(sendToNurse = false) {
    setError('')
    setSaving(true)
    try {
      let imagePath = scan.scan_image_path || null

      // Upload image if a new one was selected
      if (imageFile) {
        imagePath = `${hospital.id}/radiology/${scan.id}.webp`
        // Compress to WEBP via canvas (same pattern as hospital background)
        const compressed = await compressImage(imageFile, 1200)
        const { error: uploadErr } = await supabase.storage
          .from('hospital-logos')
          .upload(imagePath, compressed, { upsert: true, contentType: 'image/webp' })
        if (uploadErr) throw uploadErr
      }

      const updateData = {
        status: 'completed',
        referring_doctor: referringDoctor || null,
        modality,
        contrast_used: contrastUsed || null,
        radiation_dose: radiationDose || null,
        technique: technique || null,
        findings: findings || null,
        impression: impression || null,
        recommendation: recommendation || null,
        scan_image_path: imagePath,
        report: findings || null,  // keep the old 'report' field in sync
        reported_by: profile.id,
        reported_by_name: profile.full_name,
        reported_at: new Date().toISOString(),
      }

      if (sendToNurse) {
        updateData.sent_to_nurse = true
        updateData.sent_to_nurse_at = new Date().toISOString()
        updateData.status = 'ready_for_printing'
      }

      await updateRecord(scan.id, updateData)

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: sendToNurse ? 'radiology_report.sent_to_nurse' : 'radiology_report.saved',
        entityType: 'radiology_scan', entityId: scan.id,
        patientId: scan.patient_id || patient?.id || null,
        summary: `${sendToNurse ? 'Sent to nurse for printing' : 'Saved'} radiology report — ${modality} (${scan.body_part}) for ${patientInfo.name}`,
        metadata: {
          modality, has_findings: !!findings, has_impression: !!impression,
          has_image: !!imagePath, sent_to_nurse: sendToNurse,
        },
      })

      setToast(sendToNurse ? 'Report saved + sent to nurse for printing' : 'Report saved')
      setTimeout(() => {
        if (onUpdate) onUpdate()
        onClose()
      }, 1500)
    } catch (err) {
      setError(err.message || 'Could not save the report.')
    } finally {
      setSaving(false)
      setSending(false)
    }
  }

  function compressImage(file, maxWidth) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const img = new Image()
        img.onload = () => {
          let { width, height } = img
          if (width > maxWidth) { height = Math.round(height * maxWidth / width); width = maxWidth }
          const canvas = document.createElement('canvas')
          canvas.width = width; canvas.height = height
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0, width, height)
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('Compression failed')), 'image/webp', 0.85)
        }
        img.onerror = () => reject(new Error('Could not load image'))
        img.src = e.target.result
      }
      reader.onerror = () => reject(new Error('Could not read file'))
      reader.readAsDataURL(file)
    })
  }

  return (
    <div className="dash-modal-backdrop" style={{ zIndex: 80 }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 680, maxHeight: '90vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div className="dash-modal-title" style={{ paddingBottom: 4 }}>Radiology Report</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {scan.modality} — {scan.body_part} · {new Date(scan.requested_at || scan.created_at).toLocaleDateString()}
            </div>
          </div>
          <button onClick={onClose} className="dash-icon-btn" style={{ width: 32, height: 32 }}><X size={18} /></button>
        </div>

        {error && <div className="error-box" style={{ marginBottom: 14 }}>{error}</div>}
        {toast && <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(24,217,155,0.10)', border: '1px solid var(--mint-border)', color: 'var(--mint)', fontSize: 12.5, marginBottom: 14 }}>✅ {toast}</div>}

        {/* ---- Patient Info (auto-filled, read-only) ---- */}
        <div style={{ marginBottom: 20, padding: 14, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
            Patient Information (auto-filled)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 12.5 }}>
            <div><span style={{ color: 'var(--muted)' }}>Name:</span> <strong>{patientInfo.name}</strong></div>
            <div><span style={{ color: 'var(--muted)' }}>Age:</span> <strong>{patientInfo.age}</strong></div>
            <div><span style={{ color: 'var(--muted)' }}>Sex:</span> <strong>{patientInfo.sex}</strong></div>
            <div><span style={{ color: 'var(--muted)' }}>MRN:</span> <strong>{patientInfo.mrn}</strong></div>
            <div><span style={{ color: 'var(--muted)' }}>Phone:</span> <strong>{patientInfo.phone}</strong></div>
            <div><span style={{ color: 'var(--muted)' }}>Hospital:</span> <strong>{patientInfo.hospital}</strong></div>
            <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--muted)' }}>Address:</span> <strong>{patientInfo.address}</strong></div>
          </div>
        </div>

        {/* ---- Scan Details ---- */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div className="field">
            <label>Modality</label>
            <select value={modality} onChange={e => setModality(e.target.value)}>
              {MODALITIES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Referring Doctor</label>
            <input value={referringDoctor} onChange={e => setReferringDoctor(e.target.value)} placeholder="Dr. who requested this scan" />
          </div>
          <div className="field">
            <label>Contrast Used</label>
            <input value={contrastUsed} onChange={e => setContrastUsed(e.target.value)} placeholder="e.g. IV Iohexol 50ml" />
          </div>
          <div className="field">
            <label>Radiation Dose</label>
            <input value={radiationDose} onChange={e => setRadiationDose(e.target.value)} placeholder="e.g. 1.2 mSv" />
          </div>
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>Technique</label>
          <textarea rows={2} value={technique} onChange={e => setTechnique(e.target.value)} placeholder="e.g. AP and lateral views of the chest were obtained" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>Findings</label>
          <textarea rows={4} value={findings} onChange={e => setFindings(e.target.value)} placeholder="Describe what you see on the scan…" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>Impression / Diagnosis</label>
          <textarea rows={2} value={impression} onChange={e => setImpression(e.target.value)} placeholder="Your radiological impression…" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>Recommendation</label>
          <textarea rows={2} value={recommendation} onChange={e => setRecommendation(e.target.value)} placeholder="e.g. Clinical correlation recommended. Follow-up CT in 6 weeks if symptoms persist." style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        {/* ---- Scan Image Upload ---- */}
        <div className="field" style={{ marginBottom: 20 }}>
          <label>Scan Image</label>
          <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = '' }} />
          {imagePreviewUrl && (
            <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)' }}>
              <img src={imagePreviewUrl} alt="Scan" style={{ width: '100%', maxHeight: 200, objectFit: 'contain', background: 'var(--bg-elevated)' }} />
            </div>
          )}
        </div>

        {/* ---- Action buttons ---- */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => handleSave(false)} disabled={saving} className="btn btn-ghost" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Save size={15} /> {saving ? 'Saving…' : 'Save Report'}
          </button>
          <button onClick={() => { setSending(true); handleSave(true) }} disabled={saving} className="btn btn-primary" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--teal)', color: '#000' }}>
            <Send size={15} /> {sending ? 'Sending…' : 'Save & Send to Nurse'}
          </button>
          {scan.status === 'ready_for_printing' && (
            <button onClick={() => window.print()} className="btn btn-ghost" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <Printer size={15} /> Print
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
