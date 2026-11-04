// =====================================================================
// GOODIE-MEDHUB — Deterministic Clinical Safety Rules Engine
//
// This module runs BEFORE the AI is called. It evaluates the patient's
// clinical context against a set of deterministic, clinically-reviewed
// rules. If any rule fires, the AI call is skipped and the warning is
// returned immediately — we do NOT wait for an external AI provider
// when a known critical condition is detected.
//
// PHASE 1 STATUS: EMPTY. No rules are enabled. The engine is wired up
// and ready, but no clinical thresholds are invented.
//
// Why empty: every clinical rule (critical K+ threshold, sepsis
// screening criteria, shock index, stroke scales, etc.) must be
// reviewed and approved by a qualified clinical lead for the
// hospital's jurisdiction before it can be enabled. Inventing rules
// now would be irresponsible.
//
// The structure is here so that, when clinical rules ARE approved,
// they slot in here without touching any other file.
//
// Per the user's Q4(a) decision in Phase 1: ship the wiring, leave
// the rules OFF, mark them as "draft — pending clinical approval".
// =====================================================================

// ---------------------------------------------------------------------
// RULE DEFINITIONS
//
// Each rule has:
//   id            — stable identifier (never changes once shipped)
//   enabled       — boolean, must be explicitly set to true by an admin
//   status        — 'draft' | 'under_review' | 'approved' | 'retired'
//   description   — human-readable
//   reviewer      — who needs to approve this before it can be enabled
//   evaluate(ctx) — function that takes a clinical context and returns
//                   either null (no finding) or a finding object:
//                   { finding, severity, source_data, recommendation }
// ---------------------------------------------------------------------

export const RULES = [
  // ────────────────────────────────────────────────────────────────
  // DRAFT RULES — DISABLED, PENDING CLINICAL APPROVAL
  // These are implemented but `enabled: false`. A clinical lead must
  // review each threshold + set `enabled: true` before they fire.
  // ────────────────────────────────────────────────────────────────

  {
    id: 'draft-critical-hypertension',
    enabled: false,
    status: 'draft',
    description: 'Critical hypertension — systolic BP ≥ 180 or diastolic BP ≥ 120',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const sys = parseInt(v.blood_pressure?.split('/')[0])
      const dia = parseInt(v.blood_pressure?.split('/')[1])
      if (isNaN(sys) || isNaN(dia)) return null
      if (sys < 180 && dia < 120) return null
      return {
        finding: `Critical hypertension: BP ${sys}/${dia} mmHg`,
        severity: 'critical',
        source_data: { systolic: sys, diastolic: dia, recorded_at: v.recorded_at },
        recommendation: 'Initiate hypertensive emergency protocol. Consider IV antihypertensive. Monitor for end-organ damage.',
      }
    },
  },

  {
    id: 'draft-hypotension-shock',
    enabled: false,
    status: 'draft',
    description: 'Hypotension — systolic BP < 90 mmHg (possible shock)',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const sys = parseInt(v.blood_pressure?.split('/')[0])
      if (isNaN(sys) || sys >= 90) return null
      return {
        finding: `Hypotension: systolic BP ${sys} mmHg`,
        severity: 'critical',
        source_data: { systolic: sys, recorded_at: v.recorded_at },
        recommendation: 'Assess for shock. Consider IV fluids, position change, and urgent physician review.',
      }
    },
  },

  {
    id: 'draft-shock-index',
    enabled: false,
    status: 'draft',
    description: 'Shock index (HR/SBP) > 1.0 — possible hypovolemic or septic shock',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const sys = parseInt(v.blood_pressure?.split('/')[0])
      const hr = parseInt(v.pulse_rate)
      if (isNaN(sys) || isNaN(hr) || sys === 0) return null
      const shockIndex = hr / sys
      if (shockIndex <= 1.0) return null
      return {
        finding: `Elevated shock index: ${shockIndex.toFixed(2)} (HR ${hr} / SBP ${sys})`,
        severity: 'critical',
        source_data: { heart_rate: hr, systolic: sys, shock_index: shockIndex },
        recommendation: 'Shock index > 1.0 suggests significant blood loss or sepsis. Urgent assessment required.',
      }
    },
  },

  {
    id: 'draft-severe-hypoxia',
    enabled: false,
    status: 'draft',
    description: 'Severe hypoxia — SpO2 < 90%',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const spo2 = parseFloat(v.spo2)
      if (isNaN(spo2) || spo2 >= 90) return null
      return {
        finding: `Severe hypoxia: SpO2 ${spo2}%`,
        severity: 'critical',
        source_data: { spo2, recorded_at: v.recorded_at },
        recommendation: 'Immediate oxygen supplementation. Consider non-rebreather mask. Assess for respiratory distress.',
      }
    },
  },

  {
    id: 'draft-severe-tachycardia',
    enabled: false,
    status: 'draft',
    description: 'Severe tachycardia — heart rate > 130 bpm',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const hr = parseInt(v.pulse_rate)
      if (isNaN(hr) || hr <= 130) return null
      return {
        finding: `Severe tachycardia: HR ${hr} bpm`,
        severity: 'urgent',
        source_data: { heart_rate: hr, recorded_at: v.recorded_at },
        recommendation: 'Assess for arrhythmia, dehydration, sepsis, or anxiety. Consider ECG.',
      }
    },
  },

  {
    id: 'draft-severe-bradycardia',
    enabled: false,
    status: 'draft',
    description: 'Severe bradycardia — heart rate < 40 bpm',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const hr = parseInt(v.pulse_rate)
      if (isNaN(hr) || hr >= 40) return null
      return {
        finding: `Severe bradycardia: HR ${hr} bpm`,
        severity: 'critical',
        source_data: { heart_rate: hr, recorded_at: v.recorded_at },
        recommendation: 'Assess for heart block, drug effects, or underlying cardiac condition. Consider atropine per protocol.',
      }
    },
  },

  {
    id: 'draft-high-fever',
    enabled: false,
    status: 'draft',
    description: 'High fever — temperature ≥ 39.5°C (possible sepsis)',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const temp = parseFloat(v.temperature)
      if (isNaN(temp) || temp < 39.5) return null
      return {
        finding: `High fever: ${temp}°C`,
        severity: 'urgent',
        source_data: { temperature: temp, recorded_at: v.recorded_at },
        recommendation: 'Consider sepsis screening (qSOFA). Antipyretics, cooling measures, and blood cultures per protocol.',
      }
    },
  },

  {
    id: 'draft-suspected-sepsis-sirs',
    enabled: false,
    status: 'draft',
    description: 'SIRS criteria — suspected sepsis (2+ of: temp >38 or <36, HR >90, RR >20, WBC abnormal)',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const v = ctx.vitals || {}
      const temp = parseFloat(v.temperature)
      const hr = parseInt(v.pulse_rate)
      const rr = parseInt(v.respiratory_rate)
      let criteria = 0
      const findings = []

      if (!isNaN(temp) && (temp > 38 || temp < 36)) { criteria++; findings.push(`temp ${temp}°C`) }
      if (!isNaN(hr) && hr > 90) { criteria++; findings.push(`HR ${hr}`) }
      if (!isNaN(rr) && rr > 20) { criteria++; findings.push(`RR ${rr}`) }
      // WBC would come from lab results — check for it
      const wbcLab = ctx.lab_results?.find(l => /wbc|white.*blood.*count|leucocyt/i.test(l.test_name || '') && l.status === 'completed' && l.result != null)
      if (wbcLab) {
        const wbc = parseFloat(wbcLab.result)
        if (!isNaN(wbc) && (wbc > 12 || wbc < 4)) { criteria++; findings.push(`WBC ${wbc}`) }
      }

      if (criteria < 2) return null
      return {
        finding: `SIRS criteria positive (${criteria}/4): ${findings.join(', ')}`,
        severity: 'critical',
        source_data: { criteria_count: criteria, findings },
        recommendation: 'Suspected sepsis — initiate sepsis bundle: blood cultures, broad-spectrum antibiotics, lactate, IV fluids. Time-critical.',
      }
    },
  },

  {
    id: 'draft-pediatric-flag',
    enabled: false,
    status: 'draft',
    description: 'Pediatric patient — age < 13 years (AI scope limitation)',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const age = ctx.patient?.age != null ? parseInt(ctx.patient.age) : null
      if (age === null || age >= 13) return null
      return {
        finding: `Pediatric patient: ${age} year(s) old`,
        severity: 'urgent',
        source_data: { age },
        recommendation: 'Pediatric dosing required. AI assessment may not be calibrated for pediatric patients — consult pediatrician.',
      }
    },
  },

  {
    id: 'draft-pregnancy-flag',
    enabled: false,
    status: 'draft',
    description: 'Pregnancy flagged — medication safety review required',
    reviewer: 'pending clinical lead approval',
    evaluate: (ctx) => {
      const pmh = (ctx.past_medical_history || '').toLowerCase()
      const fsh = (ctx.family_social_history || '').toLowerCase()
      const hpc = (ctx.history_presenting_complaint || '').toLowerCase()
      const isPregnant = /pregnan|gravid|antenatal|anc|expected.*date.*delivery|edd|lmp/i.test(pmh + fsh + hpc)
      if (!isPregnant) return null
      return {
        finding: 'Patient flagged as pregnant',
        severity: 'urgent',
        source_data: { source: 'history_text_match' },
        recommendation: 'Pregnancy status detected from history. All medications must be checked for pregnancy category. AI may not adjust dosing for pregnancy.',
      }
    },
  },
]

// ---------------------------------------------------------------------
// RULES VERSION
//
// Stored on every ai_assessments row so a clinician reviewing an old
// assessment knows which ruleset was active when it was generated.
// Bump this whenever a rule is added, removed, or its threshold changed.
// ---------------------------------------------------------------------

export const RULES_VERSION = 'draft-v2-10-rules'

// ---------------------------------------------------------------------
// evaluateCriticalRules
//
// Called by the edge function BEFORE calling the AI provider.
// Returns an object: { warnings: [...], rulesVersion: 'empty-v1' }
//
// In Phase 1, `warnings` is always empty (no rules enabled). The
// engine is wired so that Phase 2 can add rules without touching
// any other file.
// ---------------------------------------------------------------------

export function evaluateCriticalRules(clinicalContext) {
  const warnings = []

  for (const rule of RULES) {
    // Only evaluate enabled rules. Phase 1 ships with ALL rules
    // disabled, so this loop is a no-op.
    if (!rule.enabled) continue

    try {
      const finding = rule.evaluate(clinicalContext)
      if (finding) {
        warnings.push({
          rule_id: rule.id,
          ...finding,
        })
      }
    } catch (err) {
      // A broken rule must NEVER block the AI call. Log and continue.
      console.warn(`[clinicalSafetyRules] Rule ${rule.id} threw:`, err)
    }
  }

  return { warnings, rulesVersion: RULES_VERSION }
}

// ---------------------------------------------------------------------
// getRulesManifest
//
// Returns a human-readable list of all known rules + their approval
// status. The AI Diagnostics UI shows this to clinicians so they can
// see exactly what is and isn't being checked.
//
// In Phase 1 this returns an empty list with `rulesVersion: 'empty-v1'`
// — the UI shows a clear "No deterministic safety rules are currently
// enabled. Phase 1 ships with the rules engine empty pending clinical
// approval." disclosure.
// ---------------------------------------------------------------------

export function getRulesManifest() {
  return {
    rulesVersion: RULES_VERSION,
    rules: RULES.map(r => ({
      id: r.id,
      enabled: r.enabled,
      status: r.status,
      description: r.description,
      reviewer: r.reviewer,
    })),
    // Phase-1 disclosure shown in the UI:
    disclosure:
      'Phase 1 — No deterministic safety rules are currently enabled. ' +
      'The rules engine is wired but empty, pending clinical lead approval. ' +
      'All safety assessment in Phase 1 comes from the AI provider.',
  }
}
