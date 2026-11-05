import { useState } from 'react'
import { AlertTriangle, ShieldAlert, Check, X, Info } from 'lucide-react'

// =====================================================================
// MedicationSafetyAlert — renders drug interaction warnings
// =====================================================================
// Shows when the drug interaction engine finds alerts.
// Each alert has a severity:
//   'soft' (yellow) — doctor can override with a reason
//   'hard' (red) — doctor MUST type a justification to proceed
//
// Props:
//   alerts      — array of alert objects from checkMedicationSafety()
//   onOverride   — (alerts, reason) => void — called when doctor overrides
//   onAbort      — () => void — called when doctor cancels (doesn't add the drug)
// =====================================================================

export default function MedicationSafetyAlert({ alerts, onOverride, onAbort }) {
  const [overrideReason, setOverrideReason] = useState('')
  const [confirmedRisk, setConfirmedRisk] = useState(false)

  if (!alerts || alerts.length === 0) return null

  const hasHard = alerts.some(a => a.severity === 'hard')
  const hasSoft = alerts.some(a => a.severity === 'soft')

  // Group by severity
  const hardAlerts = alerts.filter(a => a.severity === 'hard')
  const softAlerts = alerts.filter(a => a.severity === 'soft')

  return (
    <div style={{
      marginTop: 12, marginBottom: 12, borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${hasHard ? 'var(--danger)' : 'var(--gold)'}`,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        background: hasHard ? 'rgba(240,79,95,0.10)' : 'rgba(232,184,46,0.10)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {hasHard ? <ShieldAlert size={18} style={{ color: 'var(--danger)' }} /> : <AlertTriangle size={18} style={{ color: 'var(--gold)' }} />}
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 13, fontWeight: 700,
            color: hasHard ? 'var(--danger)' : 'var(--gold)',
          }}>
            {hasHard ? 'CRITICAL SAFETY ALERT' : 'Medication Safety Warning'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {alerts.length} alert{alerts.length !== 1 ? 's' : ''} detected for this medication
            {hasHard && ' — hard block requires justification to override'}
          </div>
        </div>
      </div>

      {/* Alert list */}
      <div style={{ padding: '8px 14px', background: 'var(--bg-elevated)' }}>
        {hardAlerts.map((alert, i) => (
          <AlertItem key={`hard-${i}`} alert={alert} />
        ))}
        {softAlerts.map((alert, i) => (
          <AlertItem key={`soft-${i}`} alert={alert} />
        ))}
      </div>

      {/* Override section (only if hard alerts) */}
      {hasHard && (
        <div style={{ padding: '12px 14px', background: 'rgba(240,79,95,0.05)', borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={confirmedRisk}
              onChange={e => setConfirmedRisk(e.target.checked)}
              id="risk-confirm"
            />
            <label htmlFor="risk-confirm" style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600, cursor: 'pointer' }}>
              I understand the risks and accept full clinical responsibility
            </label>
          </div>
          <input
            type="text"
            value={overrideReason}
            onChange={e => setOverrideReason(e.target.value)}
            placeholder="Type your clinical justification for overriding these alerts…"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--line)', background: 'var(--bg-card)',
              color: 'var(--ivory)', fontSize: 12.5, outline: 'none',
            }}
          />
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
        <button
          onClick={onAbort}
          className="btn btn-ghost"
          style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
        >
          <X size={14} /> Cancel
        </button>
        {hasHard ? (
          <button
            onClick={() => onOverride(alerts, overrideReason)}
            disabled={!confirmedRisk || !overrideReason.trim()}
            className="btn btn-primary"
            style={{
              width: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
              background: 'var(--danger)', color: '#fff',
              opacity: (!confirmedRisk || !overrideReason.trim()) ? 0.5 : 1,
              cursor: (!confirmedRisk || !overrideReason.trim()) ? 'not-allowed' : 'pointer',
            }}
          >
            <Check size={14} /> Override (High Risk)
          </button>
        ) : (
          <button
            onClick={() => onOverride(alerts, overrideReason || 'Acknowledged')}
            className="btn btn-primary"
            style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--gold)', color: '#000' }}
          >
            <Check size={14} /> Acknowledge & Continue
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// AlertItem — renders a single alert
// ---------------------------------------------------------------------
function AlertItem({ alert }) {
  const isHard = alert.severity === 'hard'
  const bgColor = isHard ? 'rgba(240,79,95,0.06)' : 'rgba(232,184,46,0.06)'
  const borderColor = isHard ? 'var(--danger)' : 'var(--gold)'

  return (
    <div style={{
      padding: '8px 12px', marginBottom: 6, borderRadius: 8,
      background: bgColor, border: `1px solid ${borderColor}33`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {isHard ?
          <ShieldAlert size={14} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} /> :
          <AlertTriangle size={14} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 2 }} />
        }
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 700,
            color: isHard ? 'var(--danger)' : 'var(--gold)',
            textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2,
          }}>
            {alertTypeLabel(alert.type)} · {alert.interactingWith}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ivory)', marginBottom: 2 }}>
            {alert.mechanism || alert.clinicalEffect}
          </div>
          {alert.recommendation && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic' }}>
              → {alert.recommendation}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function alertTypeLabel(type) {
  const labels = {
    drug_drug: 'Drug-Drug Interaction',
    drug_allergy: 'Drug-Allergy',
    drug_condition: 'Drug-Condition',
    drug_lab: 'Drug-Lab',
    pregnancy: 'Pregnancy Warning',
    pediatric: 'Pediatric Warning',
    renal_dose: 'Renal Dose Adjustment',
  }
  return labels[type] || type
}
