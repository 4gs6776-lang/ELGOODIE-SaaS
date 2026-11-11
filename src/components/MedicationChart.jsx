import { useEffect, useMemo, useState } from 'react'
import { canEditPatientDetails } from '../lib/permissions'
import '../theme/marChart.css'
import AppIcon from './icons'
import TrashIcon from './icons/TrashIcon'
import { formatDate, calculateAge } from '../lib/datetime'
// Drug Chart workflow integration — the classifier tells us whether
// each row is Pending, Given, Missed or Discontinued, so we can badge
// the row and (when status !== 'given') separate it from the
// administered rows in the display.
import { classifyDrugChartEntry } from '../lib/drugChartWorkflow'

// ============================================================
// PREMIUM MEDICATION ADMINISTRATION CHART (MAR)
// ------------------------------------------------------------
// A clinical, print-ready document — always white/navy regardless
// of the app's dark theme, exactly 8 columns, exactly 15 rows per
// page, with dynamic pagination that never loses or duplicates a
// record across pages. Data lives in the same 'patient_drug_charts'
// offline table every other tab already reads/writes; this file
// only adds two optional fields to that table: next_dose and sign.
// ============================================================

const ROUTE_CODES = ['PO', 'IV', 'IM', 'SC', 'PR', 'SL', 'Top', 'Inh', 'Other']
const FREQUENCY_CODES = ['STAT', 'OD', 'BD', 'TDS', 'QID', 'QDS', 'PRN', 'Nocte', 'Weekly']
const ROWS_PER_PAGE = 15

function emptyMedForm(profile){
  const now = new Date()
  return {
    id: null,
    entry_date: now.toISOString().slice(0, 10),
    entry_time: now.toTimeString().slice(0, 5),
    drug_name: '',
    dosage: '',
    next_dose: '',
    route: '',
    frequency: '',
    sign: deriveSign(profile),
    prescription_id: null,
  }
}

function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Times are stored as 24-hour "HH:MM" (native <input type="time"> value,
// and what isOverdue()'s Date math relies on) but always DISPLAYED as
// 12-hour with AM/PM — nurses read a paper chart in 12-hour time.
function formatTime12h(t){
  if (!t) return ''
  const [hStr, mStr] = t.slice(0, 5).split(':')
  let h = parseInt(hStr, 10)
  if (Number.isNaN(h)) return t
  const period = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${mStr} ${period}`
}

const ROLE_SIGN_PREFIX = {
  doctor: 'DR', nurse: 'RN', pharmacist: 'PH', lab: 'LAB',
  front_desk: 'FD', billing: 'BIL', admin: 'ADM', owner: 'OWN', staff: 'STF',
}

// Turns a logged-in staff profile into a short "ROLE-INITIALS" tag, e.g.
// a nurse named Grace Adeyemi becomes "RN-GA" — matches the paper-chart
// convention nurses already sign with, but fills it in automatically.
function deriveSign(profile){
  if (!profile?.full_name) return ''
  const initials = profile.full_name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
  const prefix = ROLE_SIGN_PREFIX[profile.role] || 'STF'
  return `${prefix}-${initials}`
}

export default function MedicationChart({ patient, entries, admissionRequest, latestConsultation, profile, hospitalName, addEntry, updateEntry, deleteEntry, updatePatient, showToast, prescriptions = [], medicationAdministrations = [] }){
  // Ward, bed, diagnosis, allergies... are saved on the patient record, so only
  // Front Desk, Nurse and Admin may change them; other roles see them read-only.
  const canEditPatient = canEditPatientDetails(profile?.role)

  // Build a lookup of prescriptions by id so we can pass the linked
  // prescription to classifyDrugChartEntry() for each row.
  const prescriptionById = useMemo(() => {
    const m = new Map()
    for (const rx of prescriptions) m.set(rx.id, rx)
    return m
  }, [prescriptions])

  // Classify each entry as 'pending' | 'given' | 'missed' | 'discontinued'.
  // We compute this once per render (memoized) so the badge and the
  // pending/administered split stay consistent.
  const classified = useMemo(() => {
    const now = new Date()
    return entries.map(e => ({
      entry: e,
      status: classifyDrugChartEntry(
        e,
        prescriptionById.get(e.prescription_id),
        medicationAdministrations,
        now
      ),
    }))
  }, [entries, prescriptionById, medicationAdministrations])

  // Chart order is chronological — oldest entry first, like a real paper MAR sheet.
  const sorted = useMemo(
    () => [...classified].sort((a, b) => new Date(a.entry.created_at) - new Date(b.entry.created_at)),
    [classified]
  )

  // Split into "Pending / Missed / Discontinued" (scheduled, not yet given)
  // and "Given" (administered). Both groups preserve chronological order.
  // The "Given" group is shown first because that is what the nurse has
  // already done; the pending group follows with the status badge so the
  // nurse sees at a glance what is still owed.
  const givenRows = useMemo(() => sorted.filter(r => r.status === 'given'), [sorted])
  const pendingRows = useMemo(
    () => sorted.filter(r => r.status !== 'given'),
    [sorted]
  )
  const displayRows = useMemo(
    () => [...givenRows, ...pendingRows],
    [givenRows, pendingRows]
  )

  const pageCount = Math.max(1, Math.ceil(displayRows.length / ROWS_PER_PAGE))
  const [page, setPage] = useState(1)

  // If records are added/removed elsewhere and the current page no
  // longer exists, snap back to the last real page instead of showing blank.
  useEffect(() => {
    setPage(p => Math.min(Math.max(p, 1), pageCount))
  }, [pageCount])

  const pageEntries = displayRows.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE)
  const emptyRowCount = Math.max(0, ROWS_PER_PAGE - pageEntries.length)

  // A dose is "overdue" when its next_dose time has passed and no later
  // entry for that same drug has been logged since — i.e. nobody has
  // recorded giving the next dose yet. This is the single most useful
  // safety signal a MAR chart can surface at a glance.
  const now = new Date()
  const latestEntryPerDrug = useMemo(() => {
    const map = new Map()
    for (const r of sorted) {
      const e = r.entry
      const key = e.drug_name?.trim().toLowerCase()
      if (!key) continue
      const existing = map.get(key)
      const ts = new Date(`${e.entry_date}T${e.entry_time || '00:00'}`)
      if (!existing || ts > existing.ts) map.set(key, { id: e.id, ts })
    }
    return map
  }, [sorted])

  function isOverdue(e){
    if (!e.next_dose || !e.entry_date) return false
    const latest = latestEntryPerDrug.get(e.drug_name?.trim().toLowerCase())
    if (!latest || latest.id !== e.id) return false // a later dose was already given
    const due = new Date(`${e.entry_date}T${e.next_dose}`)
    return due < now
  }

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(() => emptyMedForm(profile))
  const [saving, setSaving] = useState(false)

  const activePrescriptions = useMemo(
    () => prescriptions.filter(rx => rx.status === 'active'),
    [prescriptions]
  )

  const derivedDiagnosis = admissionRequest?.diagnosis
    || (latestConsultation?.diagnoses || []).map(d => d.label).join(', ')
    || ''
  const derivedConsultant = admissionRequest?.doctor_name || ''

  // Editable header fields — seeded from whatever the app already knows,
  // but a nurse can override/fill them in directly on the chart. Saved
  // back onto the patient record so they persist next time this opens.
  const [header, setHeader] = useState({
    ward: patient.ward || admissionRequest?.requested_ward || '',
    bed: patient.bed || '',
    diagnosis: patient.diagnosis || derivedDiagnosis,
    consultant: patient.consultant || derivedConsultant,
    allergies: patient.allergies || '',
  })

  function set(key, value){ setForm(f => ({ ...f, [key]: value })) }

  function openAddForm(){
    setForm(emptyMedForm(profile))
    setShowForm(true)
  }

  function openEditForm(entry){
    setForm({
      id: entry.id,
      entry_date: entry.entry_date || '',
      entry_time: entry.entry_time ? entry.entry_time.slice(0, 5) : '',
      drug_name: entry.drug_name || '',
      dosage: entry.dosage || '',
      next_dose: entry.next_dose ? entry.next_dose.slice(0, 5) : '',
      route: entry.route || '',
      frequency: entry.frequency || '',
      sign: entry.sign || deriveSign(profile),
      prescription_id: entry.prescription_id || null,
    })
    setShowForm(true)
  }

  // Picking a prescription pre-fills the drug's details from what the
  // doctor actually ordered, instead of the nurse retyping it by hand.
  // Route/Frequency only autofill when they match one of this chart's
  // fixed codes — otherwise they're left for the nurse to pick manually.
  function applyPrescription(rxId){
    if (!rxId) { set('prescription_id', null); return }
    const rx = activePrescriptions.find(r => r.id === rxId)
    if (!rx) return
    setForm(f => ({
      ...f,
      prescription_id: rx.id,
      drug_name: rx.drug_name || f.drug_name,
      dosage: rx.dosage || f.dosage,
      route: ROUTE_CODES.includes(rx.route) ? rx.route : f.route,
      frequency: FREQUENCY_CODES.includes(rx.frequency) ? rx.frequency : f.frequency,
    }))
  }

  async function handleSubmit(e){
    e.preventDefault()
    if (!form.drug_name.trim()) { showToast('Medication name is required'); return }
    setSaving(true)
    try {
      const payload = {
        patient_id: patient.id,
        entry_date: form.entry_date || null,
        entry_time: form.entry_time || null,
        drug_name: form.drug_name,
        dosage: form.dosage || null,
        next_dose: form.next_dose || null,
        route: form.route || null,
        frequency: form.frequency || null,
        sign: form.sign || null,
        prescription_id: form.prescription_id || null,
        created_by: profile?.id || null,
      }
      if (form.id) {
        await updateEntry(form.id, payload)
        showToast('Medication record updated')
      } else {
        await addEntry(payload)
        showToast('Medication added to chart')
        // Jump to whichever page the new record will land on.
        setPage(Math.ceil((displayRows.length + 1) / ROWS_PER_PAGE))
      }
      setShowForm(false)
    } catch (err) {
      showToast(err.message || 'Could not save medication')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(entry){
    if (!confirm(`Remove ${entry.drug_name} from this chart?`)) return
    await deleteEntry(entry.id)
    showToast('Entry removed')
  }

  function setHeaderField(key, value){
    setHeader(h => ({ ...h, [key]: value }))
  }

  async function commitHeaderField(key, value){
    if (!updatePatient || !canEditPatientDetails(profile?.role)) return
    try { await updatePatient(patient.id, { [key]: value || null }) } catch { /* best-effort */ }
  }

  const age = patient.age ?? (
    patient.date_of_birth ? calculateAge(patient.date_of_birth) : null
  )

  // Date-only display through the central formatter. MedicationChart does
  // not receive the hospital object, so the app default timezone applies
  // (identical wall clock to the previous device-locale behaviour for all
  // current hospitals); pass getTimezone(hospital) here when hospital is
  // threaded through as a prop.
  const dateAdmitted = admissionRequest?.created_at
    ? formatDate(admissionRequest.created_at)
    : (patient.created_at ? formatDate(patient.created_at) : '')

  // ---------------------------------------------------------
  // PRINT — builds a standalone document covering EVERY chart
  // page (not just the one on screen), 15 rows per physical
  // page, A4 landscape, and opens the browser print dialog on
  // it in a separate window so nothing from the dark dashboard
  // shell ever bleeds into the printout.
  // ---------------------------------------------------------
  function handlePrint(){
    const totalPages = pageCount
    const printHospitalName = hospitalName || 'HOSPITAL MEDICATION CHART'
    const allergyHtml = header.allergies
      ? `<div class="mar-allergy-banner mar-allergy-danger"><b>Allergies:</b> ${escapeHtml(header.allergies)}</div>`
      : `<div class="mar-allergy-banner mar-allergy-nkda">No known drug allergies recorded (NKDA)</div>`
    const patientInfoHtml = `
      <div class="p-grid">
        ${marInfoCellHtml('Patient Name', patient.full_name)}
        ${marInfoCellHtml('Hospital Number', patient.hospital_number)}
        ${marInfoCellHtml('Age', age != null ? `${age} yrs` : '')}
        ${marInfoCellHtml('Sex', patient.gender)}
        ${marInfoCellHtml('Ward', header.ward)}
        ${marInfoCellHtml('Bed', header.bed)}
        ${marInfoCellHtml('Diagnosis', header.diagnosis, true)}
        ${marInfoCellHtml('Consultant/Doctor', header.consultant)}
        ${marInfoCellHtml('Date Admitted', dateAdmitted)}
      </div>`

    const pagesHtml = Array.from({ length: totalPages }).map((_, pIdx) => {
      const rows = displayRows.slice(pIdx * ROWS_PER_PAGE, (pIdx + 1) * ROWS_PER_PAGE)
      const filledRowsHtml = rows.map((r, i) => {
        const e = r.entry
        const overdue = isOverdue(e)
        const statusBadge = r.status && r.status !== 'given'
          ? `<span class="mar-status-badge mar-status-${r.status}">${r.status.toUpperCase()}</span> `
          : ''
        return `
        <tr class="${overdue ? 'mar-row-overdue' : ''}">
          <td>${pIdx * ROWS_PER_PAGE + i + 1}</td>
          <td>${escapeHtml(e.entry_date || '')}</td>
          <td>${escapeHtml(formatTime12h(e.entry_time))}</td>
          <td class="med-cell">${statusBadge}${escapeHtml(e.drug_name)}</td>
          <td>${escapeHtml(e.dosage || '')}</td>
          <td>${escapeHtml(e.route || '')}</td>
          <td>${escapeHtml(e.frequency || '')}</td>
          <td class="${overdue ? 'mar-cell-overdue' : ''}">${escapeHtml(formatTime12h(e.next_dose))}${overdue ? ' (OVERDUE)' : ''}</td>
          <td>${escapeHtml(e.sign || '')}</td>
        </tr>`
      }).join('')
      const emptyRows = Math.max(0, ROWS_PER_PAGE - rows.length)
      const emptyRowsHtml = Array.from({ length: emptyRows }).map((_, i) => `
        <tr class="empty-row"><td>${rows.length + i + 1}</td><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('')

      return `
        <section class="mar-page">
          <div class="mar-header-row">
            <div class="mar-brand">
              <div class="mar-hospital-name">${escapeHtml(printHospitalName)}</div>
              <div class="mar-brand-sub">Medication Administration Record</div>
            </div>
            <div class="mar-chartno-box">
              <div><b>Hospital No.</b><span>${escapeHtml(patient.hospital_number || '')}</span></div>
              <div><b>Page</b><span>${pIdx + 1} of ${totalPages}</span></div>
            </div>
          </div>
          ${allergyHtml}
          ${patientInfoHtml}
          <table>
            <thead>
              <tr>
                <th style="width:4%"></th>
                <th style="width:8%">Date</th>
                <th style="width:9%">Time</th>
                <th style="width:20%">Medication Given</th>
                <th style="width:11%">Dose</th>
                <th style="width:7%">Route</th>
                <th style="width:7%">FrQ</th>
                <th style="width:11%">Next Dose</th>
                <th style="width:12%">Sign</th>
              </tr>
            </thead>
            <tbody>${filledRowsHtml}${emptyRowsHtml}</tbody>
          </table>
          <div class="mar-footer-bar">
            <div class="mar-legend">
              <div><b>Route:</b> PO Oral · IV Intravenous · IM Intramuscular · SC Subcutaneous · PR Rectal · SL Sublingual · Top Topical · Inh Inhaled</div>
              <div><b>FrQ:</b> STAT Immediately · OD Once daily · BD Twice daily · TDS 3× daily · QID/QDS 4× daily · PRN As needed · Nocte At night · Weekly</div>
            </div>
            <div class="mar-prepared">
              <div>Prepared by: <b>${escapeHtml(profile?.full_name || '')}</b></div>
              <div>${formatDate(new Date())}</div>
            </div>
          </div>
          <div class="mar-footer">Page ${pIdx + 1} of ${totalPages} · This is a computer-generated record</div>
        </section>`
    }).join('')

    const html = `
      <html>
      <head>
        <title>MAR — ${escapeHtml(patient.full_name)}</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; color: #14202B; background: #fff; }
          @page { size: A4 landscape; margin: 10mm; }
          .mar-page { page-break-after: always; padding: 4mm 2mm; }
          .mar-page:last-child { page-break-after: auto; }
          .mar-header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
          .mar-hospital-name { font-size: 16px; font-weight: 800; letter-spacing: 0.5px; color: #0C2E4E; }
          .mar-brand-sub { font-size: 9px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: #64798C; }
          .mar-chartno-box { border: 1px solid #DCE4EB; border-radius: 6px; padding: 5px 10px; font-size: 9.5px; min-width: 130px; }
          .mar-chartno-box div { display: flex; justify-content: space-between; gap: 6px; }
          .mar-chartno-box b { font-weight: 700; color: #0C2E4E; }
          .mar-allergy-banner { padding: 6px 10px; border-radius: 5px; font-size: 10px; font-weight: 600; margin-bottom: 8px; }
          .mar-allergy-danger { background: #FBEAEA; color: #B3261E; border: 1px solid rgba(179,38,30,0.3); }
          .mar-allergy-nkda { background: #EEF2F6; color: #64798C; border: 1px solid #DCE4EB; }
          .p-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px 16px; padding: 8px 10px; margin-bottom: 10px; background: #F4F7FA; border: 1px solid #DCE4EB; border-radius: 4px; }
          .p-cell { font-size: 10.5px; }
          .p-cell b { display: block; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px; color: #64798C; font-weight: 700; }
          .p-cell span { font-weight: 700; color: #14202B; }
          .p-cell.wide { grid-column: span 2; }
          table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          th, td { border: 1px solid #0C2E4E; padding: 6px 7px; text-align: left; font-size: 10.5px; word-wrap: break-word; }
          th { background: #0C2E4E; color: #fff; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
          td { height: 24px; }
          td:first-child, th:first-child { text-align: center; }
          tbody tr:nth-child(even) { background: #EEF2F6; }
          .mar-row-overdue td { background: #FBEAEA !important; }
          .mar-cell-overdue { color: #B3261E; font-weight: 700; }
          .med-cell { font-weight: 600; }
          .empty-row td { color: transparent; }
          .mar-footer-bar { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 8px; padding-top: 6px; border-top: 1px solid #DCE4EB; font-size: 8.5px; color: #64798C; }
          .mar-legend { display: flex; flex-direction: column; gap: 3px; max-width: 70%; }
          .mar-legend b { color: #14202B; }
          .mar-prepared { display: flex; flex-direction: column; gap: 3px; align-items: flex-end; white-space: nowrap; font-weight: 600; }
          .mar-prepared b { color: #14202B; }
          .mar-footer { text-align: right; font-size: 9px; color: #64798C; margin-top: 6px; }
        </style>
      </head>
      <body>${pagesHtml}</body>
      </html>`

    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(html)
    win.document.close()
    win.focus()
    win.print()
  }

  return (
    <div className="mar-chart">
      <div className="mar-toolbar">
        <button type="button" className="mar-btn mar-btn-primary" onClick={openAddForm}><AppIcon name="plus" size={14} /> Add Medication</button>
        <button type="button" className="mar-btn mar-btn-ghost" onClick={handlePrint}><AppIcon name="print" size={14} /> Print Chart</button>
      </div>

      <div className="mar-document">
        <div className="mar-header">
          <div className="mar-brand">
            <div className="mar-logo-mark">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-6.7-4.3-9.3-8.5C.8 9.1 2 5.5 5.3 4.4c2-.7 4 .1 5 1.8.9-1.7 3-2.5 5-1.8 3.3 1.1 4.5 4.7 2.6 8.1C18.7 16.7 12 21 12 21z"/></svg>
            </div>
            <div>
              <div className="mar-hospital-name">{hospitalName || 'Hospital Medication Chart'}</div>
              <div className="mar-doc-title">Medication Administration Record</div>
            </div>
          </div>
          <div className="mar-chartno-box">
            <div><b>Hospital No.</b><span>{patient.hospital_number || '—'}</span></div>
            <div><b>Page</b><span>{page} of {pageCount}</span></div>
          </div>
        </div>

        {header.allergies ? (
          <div className="mar-allergy-banner mar-allergy-danger">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <span><b>Allergies:</b> {header.allergies}</span>
          </div>
        ) : (
          <div className="mar-allergy-banner mar-allergy-nkda">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span>No known drug allergies recorded (NKDA)</span>
          </div>
        )}

        <div className="mar-patient-grid">
          <MarField label="Patient Name" value={patient.full_name} wide />
          <MarField label="Hospital Number" value={patient.hospital_number} />
          <MarField label="Age" value={age != null ? `${age} yrs` : ''} />
          <MarField label="Sex" value={patient.gender} />
          <MarField label="Ward" value={header.ward} editable={canEditPatient} onChange={v => setHeaderField('ward', v)} onBlurCommit={v => commitHeaderField('ward', v)} />
          <MarField label="Bed" value={header.bed} editable={canEditPatient} onChange={v => setHeaderField('bed', v)} onBlurCommit={v => commitHeaderField('bed', v)} />
          <MarField label="Consultant / Doctor" value={header.consultant} editable={canEditPatient} onChange={v => setHeaderField('consultant', v)} onBlurCommit={v => commitHeaderField('consultant', v)} />
          <MarField label="Date Admitted" value={dateAdmitted} />
          <MarField label="Diagnosis" value={header.diagnosis} editable={canEditPatient} wide onChange={v => setHeaderField('diagnosis', v)} onBlurCommit={v => commitHeaderField('diagnosis', v)} />
          <MarField label="Allergies (edit)" value={header.allergies} editable={canEditPatient} wide danger={!!header.allergies} onChange={v => setHeaderField('allergies', v)} onBlurCommit={v => commitHeaderField('allergies', v)} />
        </div>

        <div className="mar-table-scroll">
          <table className="mar-table">
            <thead>
              <tr>
                <th className="mar-col-num"></th>
                <th style={{ width: '8%' }}>Date</th>
                <th style={{ width: '9%' }}>Time</th>
                <th style={{ width: '19%' }}>Medication Given</th>
                <th style={{ width: '10%' }}>Dose</th>
                <th style={{ width: '7%' }}>Route</th>
                <th style={{ width: '7%' }}>FrQ</th>
                <th style={{ width: '11%' }}>Next Dose</th>
                <th style={{ width: '12%' }}>Sign</th>
                <th style={{ width: '8%' }}></th>
              </tr>
            </thead>
            <tbody>
              {pageEntries.map((row, i) => {
                const e = row.entry
                const overdue = isOverdue(e)
                const status = row.status
                return (
                  <tr
                    key={e.id}
                    className={`mar-row-filled mar-row-status-${status}${overdue ? ' mar-row-overdue' : ''}`}
                    onClick={() => openEditForm(e)}
                    tabIndex={0}
                    role="button"
                    aria-label={`Edit medication entry ${e.drug_name} (${status})`}
                    onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEditForm(e) } }}
                  >
                    <td className="mar-col-num">{(page - 1) * ROWS_PER_PAGE + i + 1}</td>
                    <td>{e.entry_date || ''}</td>
                    <td>{e.entry_time ? formatTime12h(e.entry_time) : ''}</td>
                    <td className="mar-med-cell">
                      <span className={`mar-status-badge mar-status-${status}`} title={`Status: ${status}`}>
                        {status === 'given' ? '✓' : status === 'missed' ? '!' : status === 'discontinued' ? '×' : '○'}
                      </span>
                      {e.drug_name}
                      {e.prescription_id && (() => {
                        const rx = prescriptions.find(r => r.id === e.prescription_id)
                        return rx?.doctor_name ? <div className="mar-rx-tag">Rx · Dr. {rx.doctor_name}</div> : null
                      })()}
                    </td>
                    <td>{e.dosage || ''}</td>
                    <td>{e.route || ''}</td>
                    <td>{e.frequency || ''}</td>
                    <td className={overdue ? 'mar-cell-overdue' : ''}>
                      {e.next_dose ? formatTime12h(e.next_dose) : ''}
                      {overdue && <div className="mar-overdue-tag">Overdue</div>}
                    </td>
                    <td>{e.sign || ''}</td>
                    <td>
                      <button
                        type="button"
                        className="mar-row-delete"
                        onClick={ev => { ev.stopPropagation(); handleDelete(e) }}
                        title="Remove entry"
                      ><TrashIcon size={14}/></button>
                    </td>
                  </tr>
                )
              })}
              {Array.from({ length: emptyRowCount }).map((_, i) => (
                <tr key={`empty-${i}`} className="mar-row-empty">
                  <td className="mar-col-num">{pageEntries.length + i + 1}</td>
                  <td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mar-footer-bar">
          <div className="mar-legend">
            <div><b>Route:</b> PO Oral · IV Intravenous · IM Intramuscular · SC Subcutaneous · PR Rectal · SL Sublingual · Top Topical · Inh Inhaled</div>
            <div><b>FrQ:</b> STAT Immediately · OD Once daily · BD Twice daily · TDS 3× daily · QID/QDS 4× daily · PRN As needed · Nocte At night · Weekly</div>
          </div>
          <div className="mar-prepared">
            <span>Prepared by: <b>{profile?.full_name || '—'}</b></span>
            <span>{formatDate(new Date())}</span>
          </div>
        </div>

        <div className="mar-doc-footer">Page {page} of {pageCount}</div>
      </div>

      <div className="mar-pagination">
        <button type="button" className="mar-page-btn" disabled={page === 1} onClick={() => setPage(1)} aria-label="Go to first page"><AppIcon name="chevronsLeft" size={14} /> First</button>
        <button type="button" className="mar-page-btn" disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))} aria-label="Previous page"><AppIcon name="chevronLeft" size={14} /> Previous</button>
        <span className="mar-page-indicator">Page {page} of {pageCount}</span>
        <button type="button" className="mar-page-btn" disabled={page === pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))} aria-label="Next page">Next <AppIcon name="chevron" size={14} /></button>
        <button type="button" className="mar-page-btn" disabled={page === pageCount} onClick={() => setPage(pageCount)} aria-label="Go to last page">Last <AppIcon name="chevronsRight" size={14} /></button>
      </div>

      {showForm && (
        <div className="mar-modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowForm(false) }}>
          <form className="mar-modal" onSubmit={handleSubmit}>
            <div className="mar-modal-title">{form.id ? 'Edit Medication' : 'Add Medication'}</div>
            {activePrescriptions.length > 0 && (
              <div className="mar-field mar-field-wide" style={{ marginBottom: 12 }}>
                <label>Fill from doctor's prescription (optional)</label>
                <select value={form.prescription_id || ''} onChange={e => applyPrescription(e.target.value)}>
                  <option value="">— Type manually —</option>
                  {activePrescriptions.map(rx => (
                    <option key={rx.id} value={rx.id}>
                      {rx.drug_name}{rx.dosage ? ` · ${rx.dosage}` : ''}{rx.doctor_name ? ` — Dr. ${rx.doctor_name}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="mar-modal-grid">
              <div className="mar-field"><label>Date</label><input type="date" value={form.entry_date} onChange={e => set('entry_date', e.target.value)} required /></div>
              <div className="mar-field"><label>Time</label><input type="time" value={form.entry_time} onChange={e => set('entry_time', e.target.value)} required /></div>
              <div className="mar-field mar-field-wide"><label>Medication Given</label><input value={form.drug_name} onChange={e => set('drug_name', e.target.value)} placeholder="e.g. Paracetamol 1g" autoFocus /></div>
              <div className="mar-field"><label>Dosage</label><input value={form.dosage} onChange={e => set('dosage', e.target.value)} placeholder="e.g. 500mg" /></div>
              <div className="mar-field"><label>Next Dose</label><input type="time" value={form.next_dose} onChange={e => set('next_dose', e.target.value)} /></div>
              <div className="mar-field">
                <label>Route</label>
                <select value={form.route} onChange={e => set('route', e.target.value)}>
                  <option value="">—</option>
                  {ROUTE_CODES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="mar-field">
                <label>Frequency</label>
                <select value={form.frequency} onChange={e => set('frequency', e.target.value)}>
                  <option value="">—</option>
                  {FREQUENCY_CODES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="mar-field"><label>Sign / Initials</label><input value={form.sign} onChange={e => set('sign', e.target.value.toUpperCase())} placeholder="e.g. RN-GA" maxLength={12} /></div>
            </div>
            <div className="mar-modal-actions">
              <button type="button" className="mar-btn mar-btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="mar-btn mar-btn-primary" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Update' : 'Add Medication'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function marInfoCellHtml(label, value, wide){
  return `<div class="p-cell${wide ? ' wide' : ''}"><b>${escapeHtml(label)}</b><span>${escapeHtml(value) || '—'}</span></div>`
}

function MarField({ label, value, editable, onChange, onBlurCommit, wide, danger }){
  return (
    <div className={`mar-info-field${wide ? ' mar-info-wide' : ''}`}>
      <div className="mar-info-label">{label}</div>
      {editable ? (
        <input
          className={`mar-info-input${danger ? ' mar-info-danger' : ''}`}
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          onBlur={e => onBlurCommit && onBlurCommit(e.target.value)}
          placeholder="—"
        />
      ) : (
        <div className="mar-info-value">{value || '—'}</div>
      )}
    </div>
  )
}
