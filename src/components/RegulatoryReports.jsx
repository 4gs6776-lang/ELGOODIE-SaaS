import { useState, useMemo, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from '../lib/useOfflineTable'
import { supabase } from '../lib/supabaseClient'
import { writeAudit } from '../lib/audit'
import { Loader2, Download, FileText, Activity, Baby, HeartPulse, Syringe, AlertTriangle } from 'lucide-react'

// =====================================================================
// RegulatoryReports — Public health / regulatory reporting module
// =====================================================================
// Generates reports required by Nigerian health authorities:
//   - Disease surveillance (notifiable diseases cross-referenced with
//     consultation diagnoses)
//   - Maternal mortality
//   - Immunization tracking
//   - Inpatient/outpatient statistics
//
// Each report generation is logged in `regulatory_reports` (audit trail).
// Reports can be exported to Excel (CSV format that opens in Excel).
// =====================================================================

const REPORT_TYPES = [
  { key: 'disease_surveillance', label: 'Disease Surveillance', icon: <AlertTriangle size={16} />, description: 'Notifiable disease cases — for FMoH IDSR weekly/monthly reporting' },
  { key: 'maternal_mortality', label: 'Maternal Mortality', icon: <HeartPulse size={16} />, description: 'Maternal deaths + delivery complications' },
  { key: 'notifiable_diseases', label: 'Notifiable Diseases', icon: <Activity size={16} />, description: 'Full breakdown of all notifiable disease cases by age/sex' },
  { key: 'immunization', label: 'Immunization', icon: <Syringe size={16} />, description: 'Immunization / vaccination records' },
  { key: 'birth_registration', label: 'Birth Registration', icon: <Baby size={16} />, description: 'Live births + stillbirths' },
  { key: 'inpatient_statistics', label: 'Inpatient Statistics', icon: <FileText size={16} />, description: 'Admissions, discharges, bed days, deaths' },
  { key: 'outpatient_statistics', label: 'Outpatient Statistics', icon: <FileText size={16} />, description: 'OPD visits by department, new vs follow-up' },
]

export default function RegulatoryReports({ periodFrom, periodTo }) {
  const { profile, hospital } = useAuth()
  const { records: patients } = useOfflineTable('patients', hospital?.id)
  const { records: vitals } = useOfflineTable('patient_vitals', hospital?.id)
  const { records: admissions } = useOfflineTable('admission_requests', hospital?.id)
  const { records: consultationCodes } = useOfflineTable('consultation_codes', hospital?.id)
  const { records: notifiableDiseases } = useOfflineTable('notifiable_diseases', hospital?.id)
  const { records: reportLog, addRecord: logReport } = useOfflineTable('regulatory_reports', hospital?.id)

  const [selectedReport, setSelectedReport] = useState('disease_surveillance')
  const [generating, setGenerating] = useState(false)
  const [reportData, setReportData] = useState(null)
  const [toast, setToast] = useState('')

  // Filter by date range
  const filterByPeriod = useCallback((arr, dateField = 'created_at') => {
    if (!periodFrom && !periodTo) return arr
    const fromMs = periodFrom ? new Date(periodFrom).getTime() : 0
    const toMs = periodTo ? new Date(periodTo + 'T23:59:59').getTime() : Date.now()
    return arr.filter(x => {
      const ms = new Date(x[dateField] || x.created_at).getTime()
      return ms >= fromMs && ms <= toMs
    })
  }, [periodFrom, periodTo])

  // Generate the selected report
  const generateReport = useCallback(async () => {
    setGenerating(true)
    setReportData(null)

    try {
      let data = []
      let rowCount = 0

      if (selectedReport === 'disease_surveillance' || selectedReport === 'notifiable_diseases') {
        // Cross-reference consultation codes with notifiable diseases
        const codesInPeriod = filterByPeriod(consultationCodes || [], 'created_at')
        const notifiableMap = {}
        ;(notifiableDiseases || []).forEach(d => { notifiableMap[d.disease_name.toLowerCase()] = d })

        data = (notifiableDiseases || []).map(disease => {
          const matchingCodes = codesInPeriod.filter(c =>
            c.code === disease.icd10_code ||
            (disease.icd10_code && c.code_description && c.code_description.toLowerCase().includes(disease.disease_name.toLowerCase()))
          )
          return {
            disease: disease.disease_name,
            icd10_code: disease.icd10_code || '—',
            reporting_timeline: disease.reporting_timeline,
            cases: matchingCodes.length,
            unique_patients: new Set(matchingCodes.map(c => c.patient_id)).size,
          }
        }).filter(r => r.cases > 0 || selectedReport === 'notifiable_diseases')

        rowCount = data.length
      }
      else if (selectedReport === 'maternal_mortality') {
        const maternalPatients = (patients || []).filter(p =>
          p.category === 'anc' || (p.gender === 'female' && p.age >= 15 && p.age <= 49)
        )
        const maternalAdmissions = filterByPeriod(admissions || [], 'created_at').filter(a =>
          maternalPatients.some(p => p.id === a.patient_id)
        )
        data = [
          { metric: 'Total ANC patients', value: maternalPatients.length },
          { metric: 'Maternal admissions in period', value: maternalAdmissions.length },
          { metric: 'Deliveries (O80 code)', value: consultationCodes?.filter(c => c.code === 'O80').length || 0 },
          { metric: 'Stillbirths (Z37.1)', value: consultationCodes?.filter(c => c.code === 'Z37.1').length || 0 },
          { metric: 'Maternal deaths (O75)', value: consultationCodes?.filter(c => c.code === 'O75').length || 0 },
        ]
        rowCount = data.length
      }
      else if (selectedReport === 'birth_registration') {
        const births = (consultationCodes || []).filter(c => c.code === 'Z37.0' || c.code === 'Z37.1')
        const birthsInPeriod = filterByPeriod(births, 'created_at')
        data = birthsInPeriod.map(b => {
          const patient = (patients || []).find(p => p.id === b.patient_id)
          return {
            date: new Date(b.created_at).toLocaleDateString(),
            patient_name: patient?.full_name || '—',
            type: b.code === 'Z37.0' ? 'Live Birth' : 'Stillbirth',
            gender: patient?.gender || '—',
          }
        })
        rowCount = data.length
      }
      else if (selectedReport === 'inpatient_statistics') {
        const admits = filterByPeriod(admissions || [], 'created_at')
        data = [
          { metric: 'Total admissions', value: admits.length },
          { metric: 'Approved', value: admits.filter(a => a.status === 'approved' || a.status === 'converted').length },
          { metric: 'Pending', value: admits.filter(a => a.status === 'pending').length },
          { metric: 'Cancelled', value: admits.filter(a => a.status === 'cancelled').length },
          { metric: 'Discharged', value: admits.filter(a => a.status === 'discharged').length },
        ]
        rowCount = data.length
      }
      else if (selectedReport === 'outpatient_statistics') {
        const consults = filterByPeriod(vitals || [], 'recorded_at')
        const newPatients = consults.filter(v => {
          const p = (patients || []).find(pt => pt.id === v.patient_id)
          return p && new Date(p.created_at).toDateString() === new Date(v.recorded_at).toDateString()
        })
        data = [
          { metric: 'Total OPD consultations', value: consults.length },
          { metric: 'New patients (first visit)', value: newPatients.length },
          { metric: 'Follow-up visits', value: consults.length - newPatients.length },
          { metric: 'Unique patients seen', value: new Set(consults.map(v => v.patient_id)).size },
        ]
        rowCount = data.length
      }
      else if (selectedReport === 'immunization') {
        const immunizationCodes = (consultationCodes || []).filter(c =>
          c.code_description && c.code_description.toLowerCase().includes('immuniz')
        )
        const immunInPeriod = filterByPeriod(immunizationCodes, 'created_at')
        data = immunInPeriod.map(c => {
          const patient = (patients || []).find(p => p.id === c.patient_id)
          return {
            date: new Date(c.created_at).toLocaleDateString(),
            patient_name: patient?.full_name || '—',
            vaccine: c.code_description || c.code,
            age: patient?.age || '—',
          }
        })
        rowCount = data.length
      }

      setReportData(data)

      // Log the report generation
      await logReport({
        hospital_id: hospital.id,
        report_type: selectedReport,
        date_from: periodFrom,
        date_to: periodTo,
        filters: {},
        generated_by: profile.id,
        generated_by_name: profile.full_name,
        file_format: 'preview',
        row_count: rowCount,
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'regulatory_report.generated',
        entityType: 'regulatory_reports', entityId: null,
        summary: `Generated ${selectedReport.replace(/_/g, ' ')} report (${rowCount} rows, ${periodFrom} to ${periodTo})`,
        metadata: { report_type: selectedReport, date_from: periodFrom, date_to: periodTo, row_count: rowCount },
      })

      setToast(`Report generated — ${rowCount} rows`)
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    } finally {
      setGenerating(false)
    }
  }, [selectedReport, periodFrom, periodTo, patients, vitals, admissions, consultationCodes, notifiableDiseases, filterByPeriod, hospital, profile, logReport])

  // Export to CSV (opens in Excel)
  function exportCSV() {
    if (!reportData || reportData.length === 0) return

    const headers = Object.keys(reportData[0])
    const csvRows = [
      headers.join(','),
      ...reportData.map(row => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','))
    ]
    const csv = csvRows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const fileName = `${selectedReport}_${periodFrom}_to_${periodTo}.csv`
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)

    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'regulatory_report.exported',
      entityType: 'regulatory_reports',
      summary: `Exported ${selectedReport.replace(/_/g, ' ')} to CSV (${fileName})`,
      metadata: { report_type: selectedReport, file_name: fileName, format: 'csv' },
    })

    setToast('Exported to CSV')
    setTimeout(() => setToast(''), 3000)
  }

  const selectedReportMeta = REPORT_TYPES.find(r => r.key === selectedReport)

  return (
    <div>
      {/* Report type selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {REPORT_TYPES.map(r => (
          <button
            key={r.key}
            type="button"
            className={`btn ${selectedReport === r.key ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => { setSelectedReport(r.key); setReportData(null) }}
            title={r.description}
          >
            {r.icon} {r.label}
          </button>
        ))}
      </div>

      {/* Generate button */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <button
          onClick={generateReport}
          disabled={generating}
          className="btn btn-primary"
          style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
          {generating ? 'Generating…' : 'Generate Report'}
        </button>
        {reportData && reportData.length > 0 && (
          <button
            onClick={exportCSV}
            className="btn btn-ghost"
            style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--teal)', borderColor: 'var(--teal-border)' }}
          >
            <Download size={14} /> Export CSV
          </button>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Period: {periodFrom || '—'} to {periodTo || '—'}
        </div>
      </div>

      {/* Report description */}
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, fontStyle: 'italic' }}>
        {selectedReportMeta?.description}
      </div>

      {/* Report data table */}
      {reportData && reportData.length > 0 ? (
        <div className="dash-panel" style={{ overflow: 'auto' }}>
          <table className="dash-full-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                {Object.keys(reportData[0]).map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '9px 8px', fontSize: 10, color: 'var(--muted-dim)', textTransform: 'uppercase', fontWeight: 600, borderBottom: '1px solid var(--line)' }}>
                    {h.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reportData.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                  {Object.values(row).map((v, j) => (
                    <td key={j} style={{ padding: '10px 8px', fontSize: 11.5, color: 'var(--ivory)' }}>
                      {v ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : reportData && reportData.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
          No data found for the selected period. Try a wider date range.
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
          Click "Generate Report" to produce the {selectedReportMeta?.label} report.
        </div>
      )}

      {/* Report generation history */}
      {(reportLog?.length || 0) > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Report Generation History (audit trail)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {reportLog.slice(0, 5).map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 8, background: 'var(--bg-elevated)', fontSize: 11.5 }}>
                <span style={{ color: 'var(--ivory)' }}>{r.report_type.replace(/_/g, ' ')}</span>
                <span style={{ color: 'var(--muted)' }}>{r.date_from} to {r.date_to}</span>
                <span style={{ color: 'var(--muted)' }}>{r.row_count} rows</span>
                <span style={{ color: 'var(--muted-dim)' }}>{new Date(r.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <div className="dash-toast dash-toast-success">{toast}</div>}
    </div>
  )
}
