// =====================================================================
// GOODIE-MEDHUB — AI Assist Frontend Client
//
// This module is the ONLY place in the React app that talks to the
// AI feature. It calls our own Supabase Edge Function
// (`/functions/v1/ai-assist`), which is the only thing that talks to
// the AI provider. The browser NEVER calls Google Gemini / OpenAI /
// Anthropic directly — the API key never leaves the server.
//
// Three public functions:
//   1. requestAssessment()  — generate a new AI assessment for a patient
//   2. getAssessmentHistory() — list prior assessments for a patient
//   3. submitReview()       — record the clinician's review decision
//
// All three use the existing supabase client from src/lib/supabaseClient.js,
// which already carries the user's JWT. The edge function verifies
// the JWT server-side and enforces role + tenant + patient access.
// =====================================================================

import { supabase } from './supabaseClient'

// ---------------------------------------------------------------------
// requestAssessment
//
// Triggers a new AI assessment for a patient + encounter.
//
// Inputs:
//   { patientId, encounterId, assessmentType, hospitalId, profile }
//     - patientId:     uuid (required)
//     - encounterId:   uuid of the patient_vitals row (optional —
//                      if omitted, edge function uses the latest vitals)
//     - assessmentType: 'consultation' (doctor) | 'triage' (nurse)
//     - hospitalId:    uuid (from useAuth().hospital.id)
//     - profile:       the auth profile object (from useAuth().profile)
//
// Returns:
//   { success: true, assessment: {...} }  on success
//   { success: false, error: '...' }     on failure
//
// The function never throws — failures are returned as { success: false }
// so the React component can render them cleanly without try/catch noise.
// ---------------------------------------------------------------------

export async function requestAssessment({
  patientId,
  encounterId = null,
  assessmentType = 'consultation',
  hospitalId,
  profile,
}) {
  // ---- Basic validation before even calling the edge function --------
  if (!patientId) {
    return { success: false, error: 'Patient is required.' }
  }
  if (!hospitalId) {
    return { success: false, error: 'Hospital context is still loading. Please try again.' }
  }
  if (!profile) {
    return { success: false, error: 'Your account is still loading. Please try again.' }
  }

  // Role check (matches the edge function's check, but we do it here
  // too so the UI can show a friendly error before the network round-trip)
  const allowedRoles = ['doctor', 'admin', 'nurse', 'owner']
  if (!allowedRoles.includes(profile.role)) {
    return {
      success: false,
      error: `Your role (${profile.role}) is not authorized to request AI assessments.`,
    }
  }

  try {
    // ---- Call our edge function --------------------------------------
    // supabase.functions.invoke automatically attaches the user's JWT
    // in the Authorization header. The edge function verifies it.
    const { data, error } = await supabase.functions.invoke('ai-assist', {
      body: {
        action: 'request_assessment',
        patient_id: patientId,
        encounter_id: encounterId,
        assessment_type: assessmentType,
      },
    })

    if (error) {
      return {
        success: false,
        error: friendlyEdgeError(error),
      }
    }

    if (!data || data.success !== true) {
      return {
        success: false,
        error: data?.error || 'The AI service returned an unexpected response.',
        error_kind: data?.error_kind,
      }
    }

    return {
      success: true,
      assessment: data.assessment,
    }
  } catch (err) {
    // Network errors (edge function not deployed, supabase project
    // unreachable, etc.) surface here.
    return {
      success: false,
      error: 'Could not reach the AI service. Please check your connection and try again.',
      raw: err?.message,
    }
  }
}

// ---------------------------------------------------------------------
// getAssessmentHistory
//
// Returns the list of prior AI assessments for a patient.
// The 90-day retention window is enforced by the RLS SELECT policy
// on ai_assessments (migration 018) — older rows simply don't come back.
//
// Inputs:
//   { patientId, hospitalId }
//     - patientId:  uuid (required)
//     - hospitalId: uuid (used to scope the useOfflineTable hook)
//
// Returns: array of assessment rows, newest first
// ---------------------------------------------------------------------

export async function getAssessmentHistory({ patientId, hospitalId }) {
  if (!patientId) return []
  if (!hospitalId) return []

  try {
    const { data, error } = await supabase
      .from('ai_assessments')
      .select('*')
      .eq('patient_id', patientId)
      .order('requested_at', { ascending: false })
      .limit(50)

    if (error) {
      console.warn('[aiAssist] getAssessmentHistory error:', error)
      return []
    }

    return data || []
  } catch (err) {
    console.warn('[aiAssist] getAssessmentHistory exception:', err)
    return []
  }
}

// ---------------------------------------------------------------------
// submitReview
//
// Records the clinician's review decision on an AI assessment.
// Called when the doctor clicks "Accept", "Modify", or "Reject" in
// the ClinicianReviewPanel.
//
// Inputs:
//   { assessmentId, reviewStatus, reviewNotes, profile }
//     - assessmentId:  uuid (required)
//     - reviewStatus:  'accepted' | 'modified' | 'rejected' (required)
//     - reviewNotes:   optional free-text note from the clinician
//     - profile:       the auth profile object
//
// Returns: { success: true } on success, { success: false, error } on failure
// ---------------------------------------------------------------------

export async function submitReview({
  assessmentId,
  reviewStatus,
  reviewNotes = null,
  profile,
}) {
  if (!assessmentId) {
    return { success: false, error: 'Assessment ID is required.' }
  }
  if (!['accepted', 'modified', 'rejected'].includes(reviewStatus)) {
    return { success: false, error: 'Invalid review status.' }
  }
  if (!profile) {
    return { success: false, error: 'Your account is still loading.' }
  }

  // Only doctors/admins/owners can submit reviews (nurses can request
  // triage assessments but cannot sign off on them — that's the
  // doctor's job)
  const reviewerRoles = ['doctor', 'admin', 'owner']
  if (!reviewerRoles.includes(profile.role)) {
    return {
      success: false,
      error: `Your role (${profile.role}) cannot submit clinician reviews. A doctor must approve this assessment.`,
    }
  }

  try {
    const { data, error } = await supabase
      .from('ai_assessments')
      .update({
        review_status: reviewStatus,
        reviewed_by: profile.id,
        reviewed_by_name: profile.full_name || null,
        reviewed_at: new Date().toISOString(),
        review_notes: reviewNotes,
      })
      .eq('id', assessmentId)
      .select()
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, assessment: data }
  } catch (err) {
    return { success: false, error: err?.message || 'Could not submit review.' }
  }
}

// ---------------------------------------------------------------------
// friendlyEdgeError
//
// Translates raw edge-function errors into friendly messages the UI
// can show directly. Matches the error_kind values the edge function
// (Batch 3) will return.
// ---------------------------------------------------------------------

function friendlyEdgeError(error) {
  const msg = error?.message || String(error || '')
  const kind = error?.context?.error_kind || error?.error_kind

  if (kind === 'ai_assist_disabled') {
    return 'AI Diagnostics is not enabled for this hospital. Please ask your hospital administrator to enable it.'
  }
  if (kind === 'provider_timeout') {
    return 'The AI service took too long to respond. Please try again. Your patient records are unaffected.'
  }
  if (kind === 'rate_limited') {
    return 'The AI service is rate-limited right now. Please wait a minute and try again.'
  }
  if (kind === 'invalid_output') {
    return 'The AI returned a response that could not be validated. Please try again or proceed without AI assistance.'
  }
  if (kind === 'out_of_scope') {
    return 'The AI service does not support this presentation in the current Phase. Please consult a specialist directly.'
  }
  if (kind === 'patient_not_found') {
    return 'The patient could not be found, or you do not have access to their records.'
  }
  if (kind === 'role_unauthorized') {
    return 'Your role is not authorized to request AI assessments.'
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the AI service. Please check your connection and try again.'
  }

  return msg || 'The AI service could not complete the request.'
}

// =====================================================================
// AI CODE SUGGESTION + DISCHARGE SUMMARY (Feature 10)
// =====================================================================
// Two new functions that extend the existing ai-assist Edge Function:
//   4. suggestCodes()          — suggest ICD-10 + procedure codes from notes
//   5. generateDischargeSummary() — draft a structured discharge summary
//
// Both call the same edge function with a different `action` parameter.
// The edge function uses a different Gemini prompt per action.
// =====================================================================

// ---------------------------------------------------------------------
// suggestCodes
//
// Sends consultation notes to the AI and gets back suggested ICD-10
// codes, procedure codes, and a brief rationale.
//
// Inputs:
//   { consultationId, hospitalId, profile, notes }
//     - consultationId: uuid of the patient_vitals row
//     - hospitalId:     uuid (from useAuth().hospital.id)
//     - profile:        the auth profile object
//     - notes:          object with consultation fields (chief_complaints,
//                       diagnosis, clinical_notes, examination_findings, etc.)
//
// Returns:
//   { success: true, suggestions: { icd10: [...], procedures: [...], rationale: '...' } }
//   { success: false, error: '...' }
// ---------------------------------------------------------------------
export async function suggestCodes({
  consultationId,
  hospitalId,
  profile,
  notes,
}) {
  if (!consultationId || !hospitalId || !profile) {
    return { success: false, error: 'Missing required fields.' }
  }

  try {
    const { data, error } = await supabase.functions.invoke('ai-assist', {
      body: {
        action: 'coding',
        patientId: notes.patient_id || null,
        encounterId: consultationId,
        assessmentType: 'coding',
        hospitalId,
        profile: { id: profile.id, full_name: profile.full_name, role: profile.role },
        // Pass the consultation context inline (the edge function will
        // also fetch it from the DB for verification)
        consultation_context: {
          chief_complaints: notes.chief_complaints || '',
          diagnosis: notes.diagnosis || '',
          clinical_notes: notes.clinical_notes || '',
          examination_findings: notes.examination_findings || '',
          treatment_plan: notes.treatment_plan || '',
          history_presenting_complaint: notes.history_presenting_complaint || '',
          past_medical_history: notes.past_medical_history || '',
          drug_history: notes.drug_history || '',
          allergy_history: notes.allergy_history || '',
        },
      },
    })

    if (error) {
      return { success: false, error: friendlyError(error) }
    }

    if (!data || !data.ok) {
      return { success: false, error: data?.error || 'The AI service did not return suggestions.' }
    }

    return {
      success: true,
      suggestions: {
        icd10: data.suggestions?.icd10 || [],
        procedures: data.suggestions?.procedures || [],
        rationale: data.suggestions?.rationale || '',
      },
      assessmentId: data.assessmentId || null,
    }
  } catch (err) {
    return { success: false, error: friendlyError(err) }
  }
}

// ---------------------------------------------------------------------
// generateDischargeSummary
//
// Generates a structured discharge summary from the consultation data.
//
// Inputs:
//   { consultationId, hospitalId, profile, patient, notes }
//
// Returns:
//   { success: true, summary: { admission: '...', diagnosis: '...', treatment: '...', medications: '...', followUp: '...' } }
//   { success: false, error: '...' }
// ---------------------------------------------------------------------
export async function generateDischargeSummary({
  consultationId,
  hospitalId,
  profile,
  patient,
  notes,
}) {
  if (!consultationId || !hospitalId || !profile) {
    return { success: false, error: 'Missing required fields.' }
  }

  try {
    const { data, error } = await supabase.functions.invoke('ai-assist', {
      body: {
        action: 'documentation',
        patientId: patient?.id || notes.patient_id || null,
        encounterId: consultationId,
        assessmentType: 'documentation',
        hospitalId,
        profile: { id: profile.id, full_name: profile.full_name, role: profile.role },
        consultation_context: {
          patient_name: patient?.full_name || '',
          patient_age: patient?.age || '',
          patient_gender: patient?.gender || '',
          chief_complaints: notes.chief_complaints || '',
          diagnosis: notes.diagnosis || '',
          clinical_notes: notes.clinical_notes || '',
          examination_findings: notes.examination_findings || '',
          treatment_plan: notes.treatment_plan || '',
          history_presenting_complaint: notes.history_presenting_complaint || '',
          past_medical_history: notes.past_medical_history || '',
          drug_history: notes.drug_history || '',
          allergy_history: notes.allergy_history || '',
          follow_up_notes: notes.follow_up_notes || '',
        },
      },
    })

    if (error) {
      return { success: false, error: friendlyError(error) }
    }

    if (!data || !data.ok) {
      return { success: false, error: data?.error || 'The AI service did not return a summary.' }
    }

    return {
      success: true,
      summary: {
        admission: data.summary?.admission || '',
        diagnosis: data.summary?.diagnosis || '',
        treatment: data.summary?.treatment || '',
        medications: data.summary?.medications || '',
        followUp: data.summary?.followUp || '',
        full_text: data.summary?.full_text || '',
      },
      assessmentId: data.assessmentId || null,
    }
  } catch (err) {
    return { success: false, error: friendlyError(err) }
  }
}

// ---------------------------------------------------------------------
// saveConsultationCode
//
// Saves an accepted/rejected code suggestion to the consultation_codes
// table. Called when the doctor clicks Accept or Reject on a suggestion.
//
// Inputs:
//   { hospitalId, patientId, consultationId, codeType, code, description, isAiSuggested, isAccepted, profile }
//
// Returns:
//   { success: true } on success
//   { success: false, error: '...' } on failure
// ---------------------------------------------------------------------
export async function saveConsultationCode({
  hospitalId,
  patientId,
  consultationId,
  codeType,
  code,
  description,
  isAiSuggested = false,
  isAccepted = false,
  profile,
}) {
  if (!hospitalId || !patientId || !consultationId || !codeType || !code) {
    return { success: false, error: 'Missing required fields.' }
  }

  try {
    const { error } = await supabase.from('consultation_codes').insert({
      hospital_id: hospitalId,
      patient_id: patientId,
      consultation_id: consultationId,
      code_type: codeType,
      code,
      code_description: description || null,
      is_ai_suggested: isAiSuggested,
      is_accepted: isAccepted,
      accepted_by: isAccepted ? profile.id : null,
      accepted_at: isAccepted ? new Date().toISOString() : null,
    })

    if (error) throw error

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not save the code.' }
  }
}
