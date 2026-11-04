import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { suggestCodes, saveConsultationCode, generateDischargeSummary } from '../../lib/aiAssist'
import { writeAudit } from '../../lib/audit'
import { Loader2, Check, X, Code, FileText, Copy } from 'lucide-react'

// =====================================================================
// CodeSuggestionPanel — shows AI-suggested ICD-10 + procedure codes
// =====================================================================
// Mounts as a side panel in the DoctorWorkbench. The doctor clicks
// "AI Suggest Codes" → the panel loads → shows suggestions → the
// doctor accepts or rejects each one.
//
// Also includes a "Generate Discharge Summary" button that drafts a
// structured summary the doctor can copy to the consultation notes.
// =====================================================================

export default function CodeSuggestionPanel({ activeVitals, activePatient, onClose }) {
  const { profile, hospital } = useAuth()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [suggestions, setSuggestions] = useState(null)
  const [acceptedCodes, setAcceptedCodes] = useState(new Set())
  const [rejectedCodes, setRejectedCodes] = useState(new Set())

  // Discharge summary state
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summary, setSummary] = useState(null)
  const [summaryError, setSummaryError] = useState('')

  const consultationNotes = activeVitals || {}

  async function handleSuggestCodes() {
    if (!activeVitals || !activePatient) {
      setError('Select a patient with an active consultation first.')
      return
    }
    setLoading(true)
    setError('')
    setSuggestions(null)
    setAcceptedCodes(new Set())
    setRejectedCodes(new Set())

    const result = await suggestCodes({
      consultationId: activeVitals.id,
      hospitalId: hospital.id,
      profile,
      notes: {
        patient_id: activePatient.id,
        chief_complaints: consultationNotes.chief_complaints,
        diagnosis: consultationNotes.diagnosis,
        clinical_notes: consultationNotes.clinical_notes,
        examination_findings: consultationNotes.examination_findings,
        treatment_plan: consultationNotes.treatment_plan,
        history_presenting_complaint: consultationNotes.history_presenting_complaint,
        past_medical_history: consultationNotes.past_medical_history,
        drug_history: consultationNotes.drug_history,
        allergy_history: consultationNotes.allergy_history,
      },
    })

    setLoading(false)

    if (!result.success) {
      setError(result.error)
      return
    }

    setSuggestions(result.suggestions)

    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'ai.codes_requested',
      entityType: 'patient_vitals', entityId: activeVitals.id,
      patientId: activePatient.id,
      summary: `AI code suggestions requested for ${activePatient.full_name}`,
      metadata: { consultation_id: activeVitals.id },
    })
  }

  async function handleAcceptCode(code, description, type) {
    const key = `${type}:${code}`
    setAcceptedCodes(prev => new Set([...prev, key]))
    setRejectedCodes(prev => { const n = new Set(prev); n.delete(key); return n })

    await saveConsultationCode({
      hospitalId: hospital.id,
      patientId: activePatient.id,
      consultationId: activeVitals.id,
      codeType: type,
      code,
      description,
      isAiSuggested: true,
      isAccepted: true,
      profile,
    })

    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'ai.code_accepted',
      entityType: 'consultation_codes',
      patientId: activePatient.id,
      summary: `Accepted AI-suggested ${type.toUpperCase()} code: ${code}`,
      metadata: { code, description, consultation_id: activeVitals.id },
    })
  }

  async function handleRejectCode(code, description, type) {
    const key = `${type}:${code}`
    setRejectedCodes(prev => new Set([...prev, key]))
    setAcceptedCodes(prev => { const n = new Set(prev); n.delete(key); return n })

    await saveConsultationCode({
      hospitalId: hospital.id,
      patientId: activePatient.id,
      consultationId: activeVitals.id,
      codeType: type,
      code,
      description,
      isAiSuggested: true,
      isAccepted: false,
      profile,
    })

    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'ai.code_rejected',
      entityType: 'consultation_codes',
      patientId: activePatient.id,
      summary: `Rejected AI-suggested ${type.toUpperCase()} code: ${code}`,
      metadata: { code, consultation_id: activeVitals.id },
    })
  }

  async function handleGenerateSummary() {
    if (!activeVitals || !activePatient) return
    setSummaryLoading(true)
    setSummaryError('')
    setSummary(null)

    const result = await generateDischargeSummary({
      consultationId: activeVitals.id,
      hospitalId: hospital.id,
      profile,
      patient: activePatient,
      notes: {
        patient_id: activePatient.id,
        chief_complaints: consultationNotes.chief_complaints,
        diagnosis: consultationNotes.diagnosis,
        clinical_notes: consultationNotes.clinical_notes,
        examination_findings: consultationNotes.examination_findings,
        treatment_plan: consultationNotes.treatment_plan,
        history_presenting_complaint: consultationNotes.history_presenting_complaint,
        past_medical_history: consultationNotes.past_medical_history,
        drug_history: consultationNotes.drug_history,
        allergy_history: consultationNotes.allergy_history,
        follow_up_notes: consultationNotes.follow_up_notes,
      },
    })

    setSummaryLoading(false)

    if (!result.success) {
      setSummaryError(result.error)
      return
    }

    setSummary(result.summary)

    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'ai.discharge_summary_generated',
      entityType: 'patient_vitals', entityId: activeVitals.id,
      patientId: activePatient.id,
      summary: `AI discharge summary generated for ${activePatient.full_name}`,
      metadata: { consultation_id: activeVitals.id },
    })
  }

  function handleCopySummary() {
    if (!summary) return
    const text = summary.full_text || [
      `Admission: ${summary.admission}`,
      `Diagnosis: ${summary.diagnosis}`,
      `Treatment: ${summary.treatment}`,
      `Medications: ${summary.medications}`,
      `Follow-up: ${summary.followUp}`,
    ].join('\n')

    navigator.clipboard.writeText(text)
    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'ai.discharge_summary_copied',
      entityType: 'patient_vitals', entityId: activeVitals.id,
      patientId: activePatient.id,
      summary: `Discharge summary copied to clipboard for ${activePatient.full_name}`,
    })
  }

  return (
    <div style={{
      border: '1px solid var(--line)', borderRadius: 12, padding: 16,
      background: 'var(--bg-card)', marginBottom: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Code size={18} style={{ color: 'var(--violet)' }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory)' }}>AI Coding & Documentation</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11 }}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          onClick={handleSuggestCodes}
          disabled={loading || !activeVitals}
          className="btn btn-primary"
          style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--violet)' }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Code size={14} />}
          {loading ? 'Analyzing…' : 'Suggest ICD-10 Codes'}
        </button>
        <button
          onClick={handleGenerateSummary}
          disabled={summaryLoading || !activeVitals}
          className="btn btn-ghost"
          style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {summaryLoading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
          {summaryLoading ? 'Drafting…' : 'Discharge Summary'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--danger-soft)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Code suggestions */}
      {suggestions && (
        <div style={{ marginBottom: 16 }}>
          {suggestions.icd10.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                ICD-10 Codes
              </div>
              {suggestions.icd10.map((c, i) => {
                const key = `icd10:${c.code}`
                const accepted = acceptedCodes.has(key)
                const rejected = rejectedCodes.has(key)
                return (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
                    marginBottom: 4, fontSize: 12.5,
                    opacity: rejected ? 0.4 : 1,
                    border: accepted ? '1px solid var(--success)' : '1px solid transparent',
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, color: 'var(--violet)', fontSize: 12 }}>{c.code}</span>
                        <span style={{ color: 'var(--ivory)' }}>{c.description}</span>
                        {accepted && <span style={{ fontSize: 10, color: 'var(--success)', fontWeight: 700 }}>✓ Accepted</span>}
                      </div>
                      {c.rationale && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{c.rationale}</div>}
                    </div>
                    {!accepted && !rejected && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => handleAcceptCode(c.code, c.description, 'icd10')} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--success)', borderColor: 'var(--success)' }}>
                          <Check size={12} />
                        </button>
                        <button onClick={() => handleRejectCode(c.code, c.description, 'icd10')} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--danger)', opacity: 0.7 }}>
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {suggestions.procedures.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                Procedure Codes
              </div>
              {suggestions.procedures.map((p, i) => {
                const key = `procedure:${p.code}`
                const accepted = acceptedCodes.has(key)
                const rejected = rejectedCodes.has(key)
                return (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
                    marginBottom: 4, fontSize: 12.5,
                    opacity: rejected ? 0.4 : 1,
                    border: accepted ? '1px solid var(--success)' : '1px solid transparent',
                  }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 700, color: 'var(--teal)', fontSize: 12 }}>{p.code}</span>
                      <span style={{ color: 'var(--ivory)', marginLeft: 8 }}>{p.description}</span>
                      {accepted && <span style={{ fontSize: 10, color: 'var(--success)', fontWeight: 700, marginLeft: 8 }}>✓ Accepted</span>}
                    </div>
                    {!accepted && !rejected && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => handleAcceptCode(p.code, p.description, 'procedure')} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--success)', borderColor: 'var(--success)' }}>
                          <Check size={12} />
                        </button>
                        <button onClick={() => handleRejectCode(p.code, p.description, 'procedure')} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, color: 'var(--danger)', opacity: 0.7 }}>
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {suggestions.rationale && (
            <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 8, background: 'rgba(118,87,232,0.08)', border: '1px solid rgba(118,87,232,0.2)', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
              {suggestions.rationale}
            </div>
          )}

          {suggestions.icd10.length === 0 && suggestions.procedures.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>
              No code suggestions returned. The AI may need more clinical detail in the consultation notes.
            </div>
          )}
        </div>
      )}

      {/* Discharge summary */}
      {summaryError && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--danger-soft)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>
          {summaryError}
        </div>
      )}

      {summary && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Discharge Summary Draft
            </div>
            <button onClick={handleCopySummary} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--teal)', borderColor: 'var(--teal-border)' }}>
              <Copy size={12} /> Copy
            </button>
          </div>
          <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line)', fontSize: 12.5, color: 'var(--ivory)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {summary.full_text || [
              summary.admission && `**Admission:** ${summary.admission}`,
              summary.diagnosis && `**Diagnosis:** ${summary.diagnosis}`,
              summary.treatment && `**Treatment Given:** ${summary.treatment}`,
              summary.medications && `**Medications on Discharge:** ${summary.medications}`,
              summary.followUp && `**Follow-up:** ${summary.followUp}`,
            ].filter(Boolean).join('\n\n')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted-dim)', marginTop: 6, fontStyle: 'italic' }}>
            AI-generated draft. Review and edit before finalizing.
          </div>
        </div>
      )}
    </div>
  )
}
