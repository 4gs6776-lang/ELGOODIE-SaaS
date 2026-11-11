import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { useOfflineTable } from '../lib/useOfflineTable'
import { useRealtimeAlert } from '../lib/useRealtimeAlert'
import MedicationChart from './MedicationChart'
import AppIcon from './icons'
import PatientWallet from './PatientWallet'
import { writeAudit } from '../lib/audit'
import { formatDateTime, getTimezone } from '../lib/datetime'
import { computePatientStatement } from '../lib/billingService'
import { canWithDb } from '../lib/permissions'

const TABS = ['Overview', 'Vitals', 'Wallet', 'History', 'Items Given', 'Prescriptions', 'Drug Chart', 'Pharmacy', 'Billing', 'Statement', 'Edit Info']
// Full-screen patient dashboard, opened by clicking a patient anywhere in
// the app. Reuses the same offline-first tables every other module reads —
// nothing new is stored here except through those existing hooks.
export default function PatientProfile({ patientId, patient: initialPatient, onClose }){
  const { profile, hospital } = useAuth()
  const timezone = getTimezone(hospital)
  const { records: patients, addRecord: addPatient, updateRecord: updatePatient, loadError: patientsLoadError } = useOfflineTable('patients', hospital?.id)
  const { records: vitals, addRecord: addVitals, updateRecord: updateVitals } = useOfflineTable('patient_vitals', hospital?.id)
  const { records: prescriptions, addRecord: addPrescription, updateRecord: updatePrescription } = useOfflineTable('prescriptions', hospital?.id)
  const { records: pharmacyItems, updateRecord: updatePharmacyItem } = useOfflineTable('pharmacy_items', hospital?.id)
  const { records: invoices, addRecord: addInvoice, updateRecord: updateInvoice } = useOfflineTable('invoices', hospital?.id)
  // admission_requests — also expose syncFromServer so the realtime
  // listener can refresh this table when a discharge happens elsewhere
  // in the app (e.g., from the Admissions module). Without this, the
  // PatientProfile would keep showing the stale "Currently Admitted"
  // card until the user closes + reopens it.
  const { records: admissionRequests, syncFromServer: syncAdmissionRequests } = useOfflineTable('admission_requests', hospital?.id)
  const { records: drugChartEntries, addRecord: addDrugChartEntry, updateRecord: updateDrugChartEntry, deleteRecord: deleteDrugChartEntry } = useOfflineTable('patient_drug_charts', hospital?.id)
  // Medication administrations — needed so MedicationChart can
  // classify each row as 'pending' / 'given' / 'missed' /
  // 'discontinued'. Without this, the chart cannot tell whether a
  // dose has actually been administered.
  const { records: medicationAdministrations } = useOfflineTable('medication_administrations', hospital?.id)

  // ---- DB-backed role permissions (RBAC) ----
  // FIX: Load the hospital_role_permissions table so we can check
  // can_edit for the patients module. Before this fix, the "Edit Info"
  // tab was only hidden from doctors — every other role (billing, lab,
  // pharmacist, etc.) could edit patient details even if the admin set
  // can_edit=false in Settings → Role Permissions.
  const { records: dbRolePerms } = useOfflineTable('hospital_role_permissions', hospital?.id)
  const canEditPatient = canWithDb(profile?.role, 'edit', 'patients', dbRolePerms)

  // ---- Pharmacy requests (free-text med requests to pharmacy) ----
  const { addRecord: addPharmacyRequest } = useOfflineTable('pharmacy_requests', hospital?.id)
  
  // NEW: Fetch the stock records (Items Given)
  const { records: stockRecords } = useOfflineTable('patient_stock_records', hospital?.id)

  // Phase 2: payments + credit notes for the Account Statement tab
  const { records: allPayments } = useOfflineTable('payments', hospital?.id)
  const { records: creditNotes } = useOfflineTable('credit_notes', hospital?.id)
  const { records: deposits } = useOfflineTable('deposits', hospital?.id)

  // Phase 5: lab orders for the unified clinical History tab
  const { records: labOrders } = useOfflineTable('lab_orders', hospital?.id)
  // Phase 5: radiology scans + appointments for the "Everything" history
  const { records: radiologyScans } = useOfflineTable('radiology_scans', hospital?.id)
  const { records: appointments } = useOfflineTable('appointments', hospital?.id)

  // FIX: The "Edit Info" tab is now gated by DB-backed permissions.
  // - Admin/owner: always can edit (FULL_ACCESS_ROLES)
  // - Doctors: never can edit (hardcoded — doctors only view)
  // - All other roles: check canWithDb(role, 'edit', 'patients', dbRolePerms)
  //   If the admin set can_edit=false for this role+module in Settings →
  //   Role Permissions, the tab is hidden and patient details are read-only.
  const isDoctor = profile?.role === 'doctor'
  const visibleTabs = (isDoctor || !canEditPatient)
    ? TABS.filter(t => t !== 'Edit Info')
    : TABS

  const [tab, setTab] = useState('Overview')
  const [toast, setToast] = useState(null)
  // Send to Pharmacy modal state — free-text request + priority
  const [showPharmModal, setShowPharmModal] = useState(false)
  const [pharmRequestText, setPharmRequestText] = useState('')
  const [pharmPriority, setPharmPriority] = useState('routine')
  const [pharmSaving, setPharmSaving] = useState(false)
  const [pharmError, setPharmError] = useState('')

  // ---- Patient Portal Account modal state ----
  // Lets staff create a portal login account for this patient.
  const [showPortalModal, setShowPortalModal] = useState(false)
  const [portalEmail, setPortalEmail] = useState('')
  const [portalPassword, setPortalPassword] = useState('')
  const [portalSaving, setPortalSaving] = useState(false)
  const [portalError, setPortalError] = useState('')
  const [portalSuccess, setPortalSuccess] = useState('')

  // Use the patient passed in as a prop if available — eliminates the
  // first-render race where useOfflineTable returns [] and the lookup
  // fails for 6 seconds until "Couldn't load this patient" fires.
  // The parent (Dashboard, Nursing, HmoPatients, etc.) already has the
  // patient record in scope — pass it through so we don't have to
  // re-fetch it.
  const patient = initialPatient || patients.find(p => p.id === patientId)

  // ---- Phase 5: Folder expiry computation (category-based) ----
  // Personal + Emergency: 3 years
  // Family: 10 years
  // ANC + HMO: never (NULL)
  // folder_expires_at is set by migration 055 based on category.
  const folderExpiry = useMemo(() => {
    if (!patient) return null
    // ANC + HMO never expire
    if (!patient.folder_expires_at) return null
    const expiresAt = new Date(patient.folder_expires_at)
    const now = new Date()
    const isExpired = expiresAt < now
    const daysUntilExpiry = Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24))
    const isExpiringSoon = !isExpired && daysUntilExpiry <= 30
    // Duration depends on category (for renewal)
    const renewalDuration = patient.category === 'family' ? 10 : 3  // years
    return { expiresAt, isExpired, daysUntilExpiry, isExpiringSoon, renewalDuration }
  }, [patient])

  const canRenewFolder = profile && ['admin', 'owner'].includes(profile.role)
  const canReRegister = profile && ['admin', 'owner', 'front_desk'].includes(profile.role)

  async function handleRenewFolder() {
    if (!patient || !canRenewFolder) return
    const newExpiry = new Date()
    newExpiry.setFullYear(newExpiry.getFullYear() + folderExpiry.renewalDuration)
    try {
      await updatePatient(patient.id, {
        folder_expires_at: newExpiry.toISOString(),
        folder_renewed_at: new Date().toISOString(),
        folder_renewed_by: profile?.id || null,
        folder_renewed_by_name: profile?.full_name || null,
        folder_renewal_count: (patient.folder_renewal_count || 0) + 1,
      })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'patient.folder_renewed',
        entityType: 'patient', entityId: patient.id,
        patientId: patient.id,
        summary: `Renewed ${patient.category || 'patient'} folder for ${patient.full_name} — new expiry ${newExpiry.toLocaleDateString('en-NG')} (+${folderExpiry.renewalDuration} years, renewal #${(patient.folder_renewal_count || 0) + 1})`,
        metadata: {
          patient_id: patient.id,
          category: patient.category,
          previous_expiry: patient.folder_expires_at,
          new_expiry: newExpiry.toISOString(),
          renewal_count: (patient.folder_renewal_count || 0) + 1,
          renewal_duration_years: folderExpiry.renewalDuration,
        },
      })
      showToast(`Folder renewed — expires ${newExpiry.toLocaleDateString('en-NG')}`)
    } catch (err) {
      showToast(err.message || 'Could not renew folder')
    }
  }

  // Re-register: creates a NEW patient record linked to the old one
  // via previous_folder_id. Old folder stays for historical lookup.
  async function handleReRegister() {
    if (!patient || !canReRegister) return
    if (!confirm(`Register a NEW folder for ${patient.full_name}?\n\nThe old folder (expired) will remain in the system for historical lookup. The new folder will be linked to it so staff can navigate between them.\n\nNew folder category: ${patient.category || 'personal'}\nNew registration fee may apply.`)) return
    try {
      const newExpiry = new Date()
      const years = patient.category === 'family' ? 10 : 3
      newExpiry.setFullYear(newExpiry.getFullYear() + years)

      const newPatient = await addPatient({
        hospital_id: hospital.id,
        full_name: patient.full_name,
        surname: patient.surname || null,
        other_names: patient.other_names || null,
        age: patient.age || null,
        gender: patient.gender || null,
        phone: patient.phone || null,
        email: patient.email || null,
        date_of_birth: patient.date_of_birth || null,
        blood_group: patient.blood_group || null,
        genotype: patient.genotype || null,
        nationality: patient.nationality || null,
        state_of_origin: patient.state_of_origin || null,
        occupation: patient.occupation || null,
        religion: patient.religion || null,
        category: patient.category || 'personal',
        address: patient.address || null,
        emergency_contact_name: patient.emergency_contact_name || null,
        emergency_contact_phone: patient.emergency_contact_phone || null,
        next_of_kin_relationship: patient.next_of_kin_relationship || null,
        next_of_kin_address: patient.next_of_kin_address || null,
        status: 'stable',
        queue_status: 'waiting',
        queue_updated_at: new Date().toISOString(),
        created_by: profile?.id,
        // Phase 5: link to old folder + set new expiry
        previous_folder_id: patient.id,
        folder_expires_at: newExpiry.toISOString(),
        folder_renewal_count: 0,
      })

      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'patient.folder_re_registered',
        entityType: 'patient', entityId: newPatient?.id || null,
        patientId: newPatient?.id || null,
        summary: `Re-registered new folder for ${patient.full_name} — old folder ${patient.id.slice(0,8)} linked via previous_folder_id. New expiry ${newExpiry.toLocaleDateString('en-NG')}.`,
        metadata: {
          old_patient_id: patient.id,
          new_patient_id: newPatient?.id,
          category: patient.category,
          new_expiry: newExpiry.toISOString(),
        },
      })

      showToast(`New folder created for ${patient.full_name} — linked to old folder`)
      onClose()  // close the old profile — user can open the new one
    } catch (err) {
      showToast(err.message || 'Could not re-register')
    }
  }

  const [loadTimedOut, setLoadTimedOut] = useState(false)
  useEffect(() => {
    setLoadTimedOut(false)
    const timer = setTimeout(() => setLoadTimedOut(true), 6000)
    return () => clearTimeout(timer)
  }, [patientId])

  // ---------------------------------------------------------------
  // CRITICAL FIX (Bug: PatientProfile still shows "admitted" after
  // discharge) — listen for UPDATEs on admission_requests so the open
  // profile refreshes automatically when a discharge happens elsewhere
  // (e.g., from the Admissions module).
  //
  // Without this listener, the user would have to close + reopen the
  // profile to see the discharge reflected. With it, the "Currently
  // Admitted" card disappears within ~1 second of the discharge.
  //
  // Listens for UPDATE events specifically (not INSERT) because
  // discharge is an UPDATE on the admission_requests.status field.
  // ---------------------------------------------------------------
  useRealtimeAlert('admission_requests', hospital?.id, () => {
    // Pull fresh rows from Supabase → IndexedDB → React state.
    // This refreshes the admissionRequests array, which re-runs the
    // activeAdmissionRequest filter (now excluding 'discharged'), and
    // the AdmissionStatusCard disappears.
    if (syncAdmissionRequests) syncAdmissionRequests()
  }, { event: 'UPDATE' })

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  if (!patient) {
    return (
      <div style={overlayStyle}>
        <div style={{ ...panelStyle, textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
          {loadTimedOut ? (
            <>
              <div style={{ color: 'var(--danger)', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
                Couldn't load this patient
              </div>
              {patientsLoadError ? (
                <div style={{ fontSize: 12.5, marginBottom: 14, fontFamily: 'monospace', color: 'var(--danger)', wordBreak: 'break-word' }}>
                  {patientsLoadError}
                </div>
              ) : (
                <div style={{ fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
                  No local error was reported, but the record for this patient wasn't found in local data.
                </div>
              )}
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 18, fontFamily: 'monospace', opacity: 0.7 }}>
                patient_id: {patientId || '—'}<br />
                hospital_id: {hospital?.id || '—'}<br />
                records loaded: {patients.length}
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button className="btn btn-ghost" onClick={() => window.location.reload()}>Reload App</button>
                <button className="btn btn-ghost" onClick={onClose}>Close</button>
              </div>
            </>
          ) : (
            <>
              Loading patient…
              <div style={{ marginTop: 16 }}>
                <button className="btn btn-ghost" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const history = vitals
    .filter(v => v.patient_id === patient.id && v.status === 'completed')
    .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))

  const patientPrescriptions = prescriptions
    .filter(rx => rx.patient_name === patient.full_name)
    .sort((a, b) => new Date(b.prescribed_at || b.created_at) - new Date(a.prescribed_at || a.created_at))

  const activePrescriptions = patientPrescriptions.filter(rx => rx.status === 'active')

  const patientInvoices = invoices
    .filter(inv => inv.patient_id === patient.id || inv.patient_name === patient.full_name)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const outstandingBalance = patientInvoices.filter(inv => inv.status === 'unpaid').reduce((sum, inv) => sum + Number(inv.amount), 0)

  const patientDrugChart = drugChartEntries
    .filter(e => e.patient_id === patient.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // Patient-scoped medication administrations — used by MedicationChart
  // to classify each chart row as 'pending' / 'given' / 'missed' /
  // 'discontinued'. Filtered by patient_id so a different patient's
  // administrations never bleed into this chart.
  const patientMedicationAdministrations = (medicationAdministrations || [])
    .filter(a => a.patient_id === patient.id)

  // NEW: Filter stock records for this patient
  const patientStockRecords = stockRecords
    .filter(r => r.patient_id === patient.id || r.patient_name === patient.full_name)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // CRITICAL FIX (Bug: PatientProfile still shows "admitted" after discharge)
  // -----------------------------------------------------------------
  // Previously this filter excluded only 'cancelled' and 'rejected' —
  // but NOT 'discharged'. So once a patient was admitted (status set
  // to 'converted' on the admission_request), the card kept showing
  // "CURRENTLY ADMITTED" forever, even after the patient was
  // discharged.
  //
  // Now we also exclude 'discharged' so the card disappears when the
  // patient is discharged.
  const activeAdmissionRequest = admissionRequests
    .filter(r => r.patient_id === patient.id && r.status !== 'cancelled' && r.status !== 'rejected' && r.status !== 'discharged')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null

  // Also expose the most recent discharge (if any) so the UI can show
  // a "Recently Discharged" notice instead of just hiding the card.
  const recentDischarge = admissionRequests
    .filter(r => r.patient_id === patient.id && r.status === 'discharged')
    .sort((a, b) => new Date(b.reviewed_at || b.created_at) - new Date(a.reviewed_at || a.created_at))[0] || null

  function findPharmacyMatch(drugName){
    if (!drugName) return null
    const q = drugName.toLowerCase()
    return pharmacyItems.find(item => {
      const n = item.name.toLowerCase()
      return n.includes(q) || q.includes(n)
    }) || null
  }

  async function handleDispense(rx){
    const match = findPharmacyMatch(rx.drug_name)
    if (match && Number(match.quantity) > 0) {
      await updatePharmacyItem(match.id, { quantity: Number(match.quantity) - 1 })
    }
    await updatePrescription(rx.id, { status: 'dispensed' })
    showToast(match ? `Dispensed ${rx.drug_name} — ${Math.max(Number(match.quantity) - 1, 0)} left in stock` : `Dispensed ${rx.drug_name}`)
  }

  return (
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 20px', borderBottom: '1px solid var(--line-soft)' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              {patient.full_name}
              {folderExpiry?.isExpired && (
                <span style={{
                  fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                  background: 'rgba(225,104,94,0.20)', color: 'var(--danger)',
                  textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  Expired
                </span>
              )}
              {folderExpiry?.isExpiringSoon && (
                <span style={{
                  fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                  background: 'rgba(201,169,97,0.20)', color: 'var(--gold)',
                  textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  Expires in {folderExpiry.daysUntilExpiry}d
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {patient.hospital_number ? `MRN: ${patient.hospital_number}` : ''}{patient.hospital_number && (patient.age || patient.gender) ? ' · ' : ''}{patient.age ? `${patient.age} yrs` : ''}{patient.gender ? ` · ${patient.gender}` : ''}
              {folderExpiry && ` · Registered ${new Date(patient.created_at).toLocaleDateString('en-NG')}`}
              {folderExpiry && ` · Expires ${folderExpiry.expiresAt.toLocaleDateString('en-NG')}`}
              {patient.folder_renewal_count > 0 && ` · Renewed ${patient.folder_renewal_count}×`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, background: 'var(--violet)', color: '#fff' }}
              onClick={() => { setPharmError(''); setShowPharmModal(true) }}
              title="Send a medication request to Pharmacy"
            >
              Send to Pharmacy
            </button>
            <button
              className="btn btn-primary"
              style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, background: 'var(--blue)', color: '#fff' }}
              onClick={() => {
                setPortalError('')
                setPortalSuccess('')
                setPortalEmail(patient?.email || '')
                setPortalPassword('')
                setShowPortalModal(true)
              }}
              title="Create a Patient Portal account for this patient"
            >
              Create Portal Account
            </button>
            <button
              onClick={onClose}
              style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--muted)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', flexShrink: 0 }}
            >✕</button>
          </div>
        </div>

        {/* ---- Phase 5: Folder expiry warning banner ---- */}
        {folderExpiry?.isExpired && (
          <div style={{
            margin: '0 20px', padding: '10px 14px', borderRadius: 8,
            background: 'rgba(225,104,94,0.10)', border: '1px solid rgba(225,104,94,0.30)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12.5, color: 'var(--danger)', flex: 1, minWidth: 200 }}>
              <strong>This {patient.category || 'patient'} folder has expired.</strong> Expired on {folderExpiry.expiresAt.toLocaleDateString('en-NG')}.
              The folder is still accessible but should be renewed or re-registered.
              {patient.folder_renewal_count > 0 && ` Previously renewed ${patient.folder_renewal_count} time(s).`}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {canRenewFolder && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: 'auto', padding: '6px 14px', fontSize: 11.5, background: 'var(--teal)' }}
                  onClick={handleRenewFolder}
                >
                  Renew (+{folderExpiry.renewalDuration} years)
                </button>
              )}
              {canReRegister && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: 'auto', padding: '6px 14px', fontSize: 11.5, color: 'var(--violet)', borderColor: 'var(--violet)' }}
                  onClick={handleReRegister}
                  title="Create a new folder for this patient, linked to the old one"
                >
                  Register New Folder
                </button>
              )}
            </div>
          </div>
        )}
        {folderExpiry?.isExpiringSoon && (
          <div style={{
            margin: '0 20px', padding: '8px 14px', borderRadius: 8,
            background: 'rgba(201,169,97,0.08)', border: '1px solid rgba(201,169,97,0.25)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12, color: 'var(--gold)' }}>
              <strong>Folder expiring soon.</strong> Expires in {folderExpiry.daysUntilExpiry} day(s) — on {folderExpiry.expiresAt.toLocaleDateString('en-NG')}.
            </div>
            {canRenewFolder && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: 'auto', padding: '5px 12px', fontSize: 11, color: 'var(--gold)', borderColor: 'var(--gold)' }}
                onClick={handleRenewFolder}
              >
                Renew Now
              </button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '12px 20px 10px' }}>
          {visibleTabs.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flexShrink: 0, padding: '7px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                border: tab === t ? '1px solid var(--teal)' : '1px solid var(--line)',
                background: tab === t ? 'var(--teal-soft)' : 'transparent',
                color: tab === t ? 'var(--teal)' : 'var(--muted)',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="thin-scroll" style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {tab === 'Overview' && (
            <OverviewTab patient={patient} latestConsultation={history[0]} activePrescriptions={activePrescriptions} outstandingBalance={outstandingBalance} admissionRequest={activeAdmissionRequest} />
          )}
          {tab === 'Vitals' && (
            <VitalsTab
              patient={patient}
              allVitals={vitals}
              history={history}
              profile={profile}
              hospital={hospital}
              addVitals={addVitals}
              showToast={showToast}
            />
          )}
          {tab === 'Wallet' && <PatientWallet patient={patient} />}
          {tab === 'History' && (
            <HistoryTab
              history={history}
              prescriptions={patientPrescriptions}
              labOrders={labOrders.filter(lo => lo.patient_id === patient?.id || lo.patient_name === patient?.full_name)}
              patientId={patient?.id}
              patient={patient}
              invoices={invoices.filter(inv => inv.patient_id === patient?.id || inv.patient_name === patient?.full_name)}
              payments={allPayments.filter(p => p.patient_id === patient?.id)}
              radiologyScans={radiologyScans.filter(rs => rs.patient_id === patient?.id || rs.patient_name === patient?.full_name)}
              appointments={appointments.filter(a => a.patient_id === patient?.id)}
              stockRecords={stockRecords.filter(r => r.patient_id === patient?.id || r.patient_name === patient?.full_name)}
              creditNotes={creditNotes.filter(cn => {
                const inv = invoices.find(i => i.id === cn.original_invoice_id)
                return inv?.patient_id === patient?.id
              })}
              timezone={timezone}
            />
          )}
          {tab === 'Items Given' && <ItemsGivenTab records={patientStockRecords} />}
          {tab === 'Prescriptions' && <PrescriptionsTab prescriptions={patientPrescriptions} />}
          {tab === 'Drug Chart' && (
            <MedicationChart
              patient={patient}
              entries={patientDrugChart}
              admissionRequest={activeAdmissionRequest}
              latestConsultation={history[0]}
              profile={profile}
              hospitalName={hospital?.name}
              addEntry={addDrugChartEntry}
              updateEntry={updateDrugChartEntry}
              deleteEntry={deleteDrugChartEntry}
              updatePatient={updatePatient}
              showToast={showToast}
              prescriptions={patientPrescriptions}
              medicationAdministrations={patientMedicationAdministrations}
            />
          )}
          {tab === 'Pharmacy' && (
            <PharmacyTab activePrescriptions={activePrescriptions} findPharmacyMatch={findPharmacyMatch} onDispense={handleDispense} />
          )}
          {tab === 'Billing' && (
            <BillingTab
              patient={patient} invoices={patientInvoices} outstandingBalance={outstandingBalance}
              profile={profile} addInvoice={addInvoice} updateInvoice={updateInvoice} showToast={showToast}
            />
          )}
          {tab === 'Statement' && (
            <StatementTab
              patient={patient}
              invoices={invoices}
              payments={allPayments}
              creditNotes={creditNotes}
              deposits={deposits}
              hospital={hospital}
              profile={profile}
            />
          )}
          {tab === 'Edit Info' && (
            <EditInfoTab patient={patient} updatePatient={updatePatient} showToast={showToast} />
          )}
        </div>

        {toast && (
          <div style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
            padding: '10px 18px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, maxWidth: '85%', textAlign: 'center',
          }}>
            {toast}
          </div>
        )}

        {/* ---- Send to Pharmacy modal — free-text request + priority ---- */}
        {showPharmModal && patient && (
          <div className="dash-modal-backdrop" style={{ zIndex: 80 }} onClick={e => { if (e.target === e.currentTarget) setShowPharmModal(false) }}>
            <div className="card dash-modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
                <div>
                  <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Send to Pharmacy</div>
                  <div style={{ fontSize: 12, color: 'var(--teal)', fontWeight: 700, marginTop: 2 }}>For {patient.full_name}</div>
                </div>
                <button className="dash-icon-btn" onClick={() => setShowPharmModal(false)} aria-label="Close"><AppIcon name="close" size={18} /></button>
              </div>
              <div className="dash-modal-body">
                {pharmError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{pharmError}</div>}
                <form id="pharm-form" onSubmit={async (e) => {
                  e.preventDefault()
                  setPharmError('')
                  if (!pharmRequestText.trim()) { setPharmError('Please type your medication request.'); return }
                  setPharmSaving(true)
                  try {
                    await addPharmacyRequest({
                      hospital_id: hospital.id,
                      patient_id: patient.id,
                      patient_name: patient.full_name,
                      request_text: pharmRequestText.trim(),
                      priority: pharmPriority,
                      status: 'pending',
                      requested_by: profile?.id || null,
                      requested_by_name: profile?.full_name || null,
                    })
                    writeAudit({
                      hospitalId: hospital?.id, actor: profile,
                      action: 'pharmacy_request.sent',
                      entityType: 'pharmacy_request', entityId: null,
                      patientId: patient.id,
                      summary: `Sent pharmacy request "${pharmRequestText.trim().slice(0, 60)}${pharmRequestText.trim().length > 60 ? '…' : ''}" for ${patient.full_name} (${pharmPriority})`,
                      metadata: { patient_id: patient.id, patient_name: patient.full_name, request_text: pharmRequestText.trim(), priority: pharmPriority },
                    })
                    showToast(`Pharmacy request sent for ${patient.full_name}`)
                    setShowPharmModal(false)
                    setPharmRequestText(''); setPharmPriority('routine')
                  } catch (err) {
                    setPharmError(err.message || 'Could not send to pharmacy.')
                  } finally {
                    setPharmSaving(false)
                  }
                }}>
                  <div className="field">
                    <label>Medication Request *</label>
                    <textarea
                      rows={3}
                      value={pharmRequestText}
                      onChange={e => setPharmRequestText(e.target.value)}
                      placeholder="e.g. I need 1 tab metronidazole 200mg for Amari"
                      autoFocus
                      required
                      style={{ width: '100%', padding: '10px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', resize: 'vertical' }}
                    />
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Patient <strong style={{ color: 'var(--teal)' }}>{patient.full_name}</strong> is auto-attached. The pharmacist will see this as plain text with your name, time, and date.
                    </div>
                  </div>
                  <div className="field">
                    <label>Priority</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {[
                        { value: 'routine', label: 'Routine', color: 'var(--teal)' },
                        { value: 'urgent', label: 'Urgent', color: 'var(--gold)' },
                        { value: 'stat', label: 'STAT', color: 'var(--danger)' },
                      ].map(p => (
                        <button
                          key={p.value}
                          type="button"
                          className={`btn ${pharmPriority === p.value ? 'btn-primary' : 'btn-ghost'}`}
                          style={{
                            width: 'auto', flex: 1, padding: '8px 12px', fontSize: 12,
                            background: pharmPriority === p.value ? p.color : 'rgba(255,255,255,0.015)',
                            color: pharmPriority === p.value ? '#fff' : 'var(--muted)',
                            borderColor: pharmPriority === p.value ? p.color : 'var(--line)',
                          }}
                          onClick={() => setPharmPriority(p.value)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </form>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowPharmModal(false)} disabled={pharmSaving}>Cancel</button>
                <button type="submit" form="pharm-form" className="btn btn-primary" disabled={pharmSaving}>{pharmSaving ? 'Sending…' : 'Send to Pharmacy'}</button>
              </div>
            </div>
          </div>
        )}

        {/* ---- Create Portal Account modal ---- */}
        {showPortalModal && patient && (
          <div className="dash-modal-backdrop" style={{ zIndex: 80 }} onClick={e => { if (e.target === e.currentTarget) setShowPortalModal(false) }}>
            <div className="card dash-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
                <div>
                  <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Create Portal Account</div>
                  <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 700, marginTop: 2 }}>For {patient.full_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>MRN: {patient.hospital_number || '—'}</div>
                </div>
                <button className="dash-icon-btn" onClick={() => setShowPortalModal(false)} aria-label="Close"><AppIcon name="close" size={18} /></button>
              </div>
              <div className="dash-modal-body">
                {portalError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{portalError}</div>}
                {portalSuccess && (
                  <div style={{ marginBottom: 12, padding: '12px 14px', borderRadius: 8, background: 'rgba(24,217,155,0.08)', border: '1px solid var(--mint-border)', fontSize: 12.5, color: 'var(--mint)' }}>
                    ✅ {portalSuccess}
                  </div>
                )}
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
                  This creates a login account the patient can use on the Patient Portal app.
                  The patient logs in with their <b>Full Name</b>, <b>Hospital</b>, <b>Hospital Number (MRN)</b>, and the password you set below — they do NOT need to remember the email.
                </p>
                <form id="portal-form" onSubmit={async (e) => {
                  e.preventDefault()
                  setPortalError(''); setPortalSuccess('')
                  if (!portalEmail.trim()) { setPortalError('Email is required.'); return }
                  if (!portalPassword || portalPassword.length < 6) { setPortalError('Password must be at least 6 characters.'); return }
                  setPortalSaving(true)
                  try {
                    // ---------------------------------------------------------------
                    // Create the portal account via the create-portal-account
                    // Edge Function (server-side).
                    //
                    // WHY NOT supabase.auth.signUp()?
                    //   signUp() creates the user AND replaces the current
                    //   browser session with the new user's session — so the
                    //   staff member gets logged out (their profiles row is
                    //   no longer found for the new auth.uid).
                    //
                    //   The Edge Function uses the SERVICE ROLE KEY (server-
                    //   side only, never exposed to the browser) to call
                    //   supabase.auth.admin.createUser(), which creates the
                    //   user WITHOUT touching the caller's session.
                    //
                    // The Edge Function also:
                    //   - Verifies the caller's JWT (only authenticated staff
                    //     can call it)
                    //   - Verifies the caller's role is in the allowed list
                    //   - Verifies the patient belongs to the caller's
                    //     hospital (multi-tenant isolation)
                    //   - Checks for an existing patient_users link
                    //   - Checks for an existing auth user with the same email
                    //   - Creates the auth user with email_confirm: true
                    //     (skips email-confirmation flow)
                    //   - Inserts the patient_users row with patient_name +
                    //     mrn so lookup_portal_email can resolve them later
                    //   - Rolls back the auth user if the link insert fails
                    // ---------------------------------------------------------------
                    const { data: fnData, error: fnError } = await supabase.functions.invoke(
                      'create-portal-account',
                      {
                        body: {
                          email: portalEmail.trim(),
                          password: portalPassword,
                          patient_id: patient.id,
                          hospital_id: patient.hospital_id,
                          patient_name: patient.full_name,
                          mrn: patient.hospital_number || null,
                        },
                      }
                    )

                    if (fnError) {
                      setPortalError(fnError.message || 'Edge Function call failed.')
                      setPortalSaving(false)
                      return
                    }

                    if (fnData?.error) {
                      setPortalError(fnData.error || 'Could not create portal account.')
                      setPortalSaving(false)
                      return
                    }

                    if (!fnData?.user_id) {
                      setPortalError('Account creation returned no user ID. Please try again.')
                      setPortalSaving(false)
                      return
                    }

                    // Step 2: Audit
                    writeAudit({
                      hospitalId: hospital?.id, actor: profile,
                      action: 'patient.portal_account_created',
                      entityType: 'patient', entityId: patient.id,
                      patientId: patient.id,
                      summary: `Created portal account for ${patient.full_name} (${patient.hospital_number || 'no MRN'}) — email: ${portalEmail.trim()}`,
                      metadata: {
                        patient_id: patient.id,
                        hospital_number: patient.hospital_number,
                        portal_email: portalEmail.trim(),
                        auth_user_id: fnData.user_id,
                        created_via: 'edge-function',
                      },
                    })

                    setPortalSuccess(`Portal account created! Patient should log in with their Full Name, Hospital, Hospital Number (${patient.hospital_number || '—'}), and the password you set. They do NOT need their email to log in.`)
                    setPortalEmail(''); setPortalPassword('')
                  } catch (err) {
                    setPortalError(err.message || 'Could not create portal account.')
                  } finally {
                    setPortalSaving(false)
                  }
                }}>
                  <div className="field">
                    <label>Email Address *</label>
                    <input
                      type="email"
                      value={portalEmail}
                      onChange={e => setPortalEmail(e.target.value)}
                      placeholder="patient@email.com"
                      autoFocus
                      required
                      style={{ width: '100%' }}
                    />
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Pre-filled from patient record. Change if needed.
                    </div>
                  </div>
                  <div className="field">
                    <label>Temporary Password *</label>
                    <input
                      type="text"
                      value={portalPassword}
                      onChange={e => setPortalPassword(e.target.value)}
                      placeholder="e.g. patient123"
                      required
                      style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
                    />
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Minimum 6 characters. Patient can change this after logging in.
                    </div>
                  </div>
                </form>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowPortalModal(false)} disabled={portalSaving}>Close</button>
                <button type="submit" form="portal-form" className="btn btn-primary" disabled={portalSaving}>{portalSaving ? 'Creating…' : 'Create Account'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 100,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
}

const panelStyle = {
  position: 'relative', width: '100%', maxWidth: 640, maxHeight: '88vh',
  background: 'var(--bg-card)', border: '1px solid var(--line)', borderRadius: 16,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
}

function detailRow(label, value){
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{value || '—'}</div>
    </div>
  )
}

const ADMISSION_STATUS_MAP = {
  pending: { heading: 'ADMISSION RECOMMENDED', label: 'Awaiting Admission', color: 'var(--gold)' },
  approved: { heading: 'ADMISSION APPROVED', label: 'Admission Approved', color: 'var(--teal)' },
  converted: { heading: 'CURRENTLY ADMITTED', label: 'Currently Admitted', color: 'var(--teal)' },
  // NEW: when the patient has been discharged, the activeAdmissionRequest
  // filter will exclude this row, so the AdmissionStatusCard returns null
  // and the card disappears. The map entry is here for safety in case
  // any code path passes a 'discharged' request to AdmissionStatusCard.
  discharged: { heading: 'RECENTLY DISCHARGED', label: 'Discharged', color: 'var(--muted)' },
}

function AdmissionStatusCard({ request }){
  if (!request) return null
  const meta = ADMISSION_STATUS_MAP[request.status] || { heading: 'ADMISSION REQUEST', label: request.status, color: 'var(--muted)' }

  return (
    <div style={{
      marginBottom: 20, padding: 16, borderRadius: 10,
      background: 'var(--bg-elevated)', border: `1px solid ${meta.color}`,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: meta.color, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <AppIcon name="bed" size={15} /> {meta.heading}
      </div>
      <div style={{ fontSize: 13, marginBottom: 10 }}>
        {request.doctor_name ? `Dr. ${request.doctor_name}` : 'A doctor'} has recommended admission.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        {request.diagnosis && detailRow('Diagnosis', request.diagnosis)}
        {request.priority && detailRow('Priority', request.priority)}
        {request.requested_ward && detailRow('Requested Ward', request.requested_ward)}
        {request.requested_bed_type && detailRow('Requested Bed Type', request.requested_bed_type)}
      </div>
      {request.reason && (<div style={{ marginBottom: 10 }}>{detailRow('Reason', request.reason)}</div>)}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: meta.color }}>{meta.label}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Requested: {new Date(request.created_at).toLocaleString()}</span>
      </div>
    </div>
  )
}

function OverviewTab({ patient, latestConsultation, activePrescriptions, outstandingBalance, admissionRequest }){
  return (
    <div>
      <AdmissionStatusCard request={admissionRequest} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
        {detailRow('Hospital No. (MRN)', patient.hospital_number)}
        {detailRow('Registered', patient.created_at ? new Date(patient.created_at).toLocaleString() : null)}
        {detailRow('Gender', patient.gender)}
        {detailRow('Date of Birth', patient.date_of_birth ? new Date(patient.date_of_birth).toLocaleDateString() : null)}
        {detailRow('Marital Status', patient.marital_status)}
        {detailRow('Phone', patient.phone)}
        {detailRow('Email', patient.email)}
        {detailRow('Blood Group / Genotype', [patient.blood_group, patient.genotype].filter(Boolean).join(' · '))}
        {detailRow('Nationality', patient.nationality)}
        {detailRow('State of Origin', patient.state_of_origin)}
        {detailRow('Occupation', patient.occupation)}
        {detailRow('Religion', patient.religion)}
        {detailRow('Category / Folder', patient.category)}
        {detailRow('HMO Provider', patient.hmo_provider || 'Self-Pay')}
        {patient.hmo_provider && detailRow('HMO Plan', patient.hmo_plan)}
        {patient.hmo_provider && detailRow('Enrollee / Policy No.', patient.hmo_number)}
        {patient.hmo_provider && detailRow('HMO Covers', patient.hmo_coverage_percent != null ? `${patient.hmo_coverage_percent}%` : null)}
        {detailRow('Address', patient.address)}
        {detailRow('Next of Kin', patient.emergency_contact_name ? `${patient.emergency_contact_name}${patient.emergency_contact_phone ? ` — ${patient.emergency_contact_phone}` : ''}` : null)}
        {detailRow('Next of Kin Relationship', patient.next_of_kin_relationship)}
        {detailRow('Next of Kin Address', patient.next_of_kin_address)}
        {patient.category === 'anc' && detailRow('ANC — LMP', patient.anc_lmp ? new Date(patient.anc_lmp).toLocaleDateString() : null)}
        {patient.category === 'anc' && detailRow('ANC — EDD', patient.anc_edd ? new Date(patient.anc_edd).toLocaleDateString() : null)}
        {patient.category === 'anc' && detailRow('ANC — Indication', patient.anc_indication)}
        {patient.category === 'anc' && detailRow('ANC — Husband', patient.anc_husband_name)}
        {detailRow('Queue Status', patient.queue_status ? patient.queue_status.replace('_', ' ') : 'Not in queue')}
        {detailRow('Patient Status', patient.status === 'stable' ? 'Stable' : 'In Review')}
      </div>
      <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div>
            <div className="dash-stat-label">Active Prescriptions</div>
            <div className="dash-stat-value">{activePrescriptions.length}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div>
            <div className="dash-stat-label">Outstanding Balance</div>
            <div className="dash-stat-value" style={{ color: outstandingBalance > 0 ? 'var(--gold)' : undefined }}>₦{outstandingBalance.toLocaleString()}</div>
          </div>
        </div>
      </div>
      {latestConsultation ? (
        <div style={{ padding: 14, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Latest Consultation</div>
          {latestConsultation.diagnoses?.length > 0 && (
            <div style={{ fontSize: 13, marginBottom: 4 }}><strong>Diagnosis:</strong> {latestConsultation.diagnoses.map(d => d.code ? `${d.label} (${d.code})` : d.label).join(', ')}</div>
          )}
          {latestConsultation.treatment_plan && <div style={{ fontSize: 13 }}><strong>Treatment Plan:</strong> {latestConsultation.treatment_plan}</div>}
        </div>
      ) : (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>No completed consultations yet.</div>
      )}
    </div>
  )
}

function HistoryTab({ history, prescriptions = [], labOrders = [], patientId, patient, invoices = [], payments = [], radiologyScans = [], appointments = [], stockRecords = [], creditNotes = [], timezone }){
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)

  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })

  // Build a UNIFIED timeline from ALL data sources
  const timeline = useMemo(() => {
    const events = []

    // 1. Clinical consultations (patient_vitals with status=completed)
    history.forEach(v => {
      const encounterRx = prescriptions.filter(rx => rx.patient_vitals_id === v.id)
      const encounterLabs = labOrders.filter(lo => lo.patient_vitals_id === v.id)
      events.push({
        id: `enc-${v.id}`,
        date: v.completed_at || v.created_at,
        type: 'consultation',
        typeLabel: 'Consultation',
        color: 'var(--teal)',
        bg: 'rgba(0,199,199,0.10)',
        title: v.chief_complaints || 'Consultation',
        summary: [
          v.diagnoses?.length > 0 ? `Dx: ${v.diagnoses.slice(0, 3).map(d => d.label).join(', ')}${v.diagnoses.length > 3 ? ` +${v.diagnoses.length - 3}` : ''}` : null,
          encounterRx.length > 0 ? `${encounterRx.length} prescription(s)` : null,
          encounterLabs.length > 0 ? `${encounterLabs.length} lab order(s)` : null,
          v.blood_pressure ? `BP ${v.blood_pressure}` : null,
        ].filter(Boolean).join(' · '),
        details: {
          encounter: v,
          prescriptions: encounterRx,
          labOrders: encounterLabs,
        },
      })
    })

    // 2. Prescriptions (standalone — not linked to an encounter)
    prescriptions.forEach(rx => {
      if (rx.patient_vitals_id && history.some(v => v.id === rx.patient_vitals_id)) return  // already shown in encounter
      events.push({
        id: `rx-${rx.id}`,
        date: rx.prescribed_at || rx.created_at,
        type: 'prescription',
        typeLabel: 'Prescription',
        color: 'var(--blue)',
        bg: 'rgba(59,130,246,0.10)',
        title: rx.drug_name,
        summary: `${rx.dosage || ''} · ${rx.frequency || ''} · Qty ${rx.quantity || 1} · ${rx.status || 'active'}${rx.doctor_name ? ` · Dr. ${rx.doctor_name.replace(/^Dr\.?\s*/i, '')}` : ''}`,
        details: { prescription: rx },
      })
    })

    // 3. Lab orders (standalone)
    labOrders.forEach(lo => {
      if (lo.patient_vitals_id && history.some(v => v.id === lo.patient_vitals_id)) return
      events.push({
        id: `lab-${lo.id}`,
        date: lo.created_at,
        type: 'lab',
        typeLabel: 'Lab Order',
        color: 'var(--violet)',
        bg: 'rgba(118,87,232,0.10)',
        title: lo.test_name || lo.test_type || 'Lab test',
        summary: `Status: ${lo.status || 'pending'}${lo.urgency ? ` · ${lo.urgency}` : ''}${lo.result_value ? ` · Result: ${lo.result_value}` : ''}`,
        details: { labOrder: lo },
      })
    })

    // 4. Radiology scans
    radiologyScans.forEach(rs => {
      events.push({
        id: `rad-${rs.id}`,
        date: rs.created_at,
        type: 'radiology',
        typeLabel: 'Radiology',
        color: 'var(--violet)',
        bg: 'rgba(118,87,232,0.10)',
        title: `${rs.modality || 'Scan'} — ${rs.body_part || rs.indication || 'Imaging'}`,
        summary: `Status: ${rs.status || 'pending'}${rs.radiologist_report ? ` · Report available` : ''}`,
        details: { scan: rs },
      })
    })

    // 5. Invoices
    invoices.forEach(inv => {
      events.push({
        id: `inv-${inv.id}`,
        date: inv.created_at,
        type: 'invoice',
        typeLabel: 'Invoice',
        color: 'var(--gold)',
        bg: 'rgba(201,169,97,0.10)',
        title: `${inv.invoice_number || 'Invoice'} — ${formatMoney(inv.grand_total || inv.amount)}`,
        summary: `Status: ${inv.status || 'unpaid'} · Paid: ${formatMoney(inv.amount_paid)} · Balance: ${formatMoney(inv.balance)}${inv.draft_status === 'draft' ? ' · DRAFT' : ''}${inv.draft_status === 'written_off' ? ' · WRITTEN OFF' : ''}`,
        details: { invoice: inv },
      })
    })

    // 6. Payments
    payments.forEach(p => {
      events.push({
        id: `pay-${p.id}`,
        date: p.created_at,
        type: 'payment',
        typeLabel: 'Payment',
        color: 'var(--mint)',
        bg: 'rgba(16,185,129,0.10)',
        title: `Payment — ${formatMoney(p.amount)}`,
        summary: `${p.method || 'Cash'}${p.reference_number ? ` · Ref: ${p.reference_number}` : ''}${p.status === 'reversed' ? ' · REVERSED' : ''}`,
        details: { payment: p },
      })
    })

    // 7. Pharmacy dispenses (patient_stock_records)
    stockRecords.forEach(r => {
      events.push({
        id: `disp-${r.id}`,
        date: r.created_at,
        type: 'dispense',
        typeLabel: 'Pharmacy',
        color: 'var(--teal)',
        bg: 'rgba(0,199,199,0.10)',
        title: `${r.item_name} × ${r.quantity_used || 1}`,
        summary: `${formatMoney(r.total_price)}${r.created_by_name ? ` · by ${r.created_by_name}` : ''}`,
        details: { record: r },
      })
    })

    // 8. Appointments
    appointments.forEach(a => {
      events.push({
        id: `appt-${a.id}`,
        date: a.appointment_time || a.created_at,
        type: 'appointment',
        typeLabel: 'Appointment',
        color: 'var(--blue)',
        bg: 'rgba(59,130,246,0.10)',
        title: a.reason || a.appointment_type || 'Appointment',
        summary: `Status: ${a.status || 'scheduled'}${a.doctor_name ? ` · ${a.doctor_name}` : ''}`,
        details: { appointment: a },
      })
    })

    // 9. Credit notes
    creditNotes.forEach(cn => {
      events.push({
        id: `cn-${cn.id}`,
        date: cn.created_at,
        type: 'credit_note',
        typeLabel: 'Credit Note',
        color: 'var(--violet)',
        bg: 'rgba(118,87,232,0.10)',
        title: `${cn.credit_note_number || 'CN'} — ${formatMoney(cn.amount)}`,
        summary: `${cn.reason_code || ''} — ${cn.reason_text || ''}${cn.refund_method ? ` · ${cn.refund_method}` : ''}`,
        details: { creditNote: cn },
      })
    })

    // Sort by date descending (newest first)
    return events.sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [history, prescriptions, labOrders, radiologyScans, invoices, payments, stockRecords, appointments, creditNotes])

  // Filter by type + search
  const filtered = useMemo(() => {
    let arr = timeline
    if (typeFilter !== 'all') {
      arr = arr.filter(e => e.type === typeFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      arr = arr.filter(e =>
        (e.title || '').toLowerCase().includes(q) ||
        (e.summary || '').toLowerCase().includes(q) ||
        (e.typeLabel || '').toLowerCase().includes(q)
      )
    }
    return arr
  }, [timeline, typeFilter, searchQuery])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(currentPage, totalPages)
  const startIndex = (safePage - 1) * pageSize
  const endIndex = Math.min(startIndex + pageSize, filtered.length)
  const pageItems = filtered.slice(startIndex, endIndex)

  useEffect(() => { setCurrentPage(1) }, [searchQuery, typeFilter])

  const typeOptions = [
    { value: 'all',           label: 'All' },
    { value: 'consultation',   label: 'Consultations' },
    { value: 'prescription',   label: 'Prescriptions' },
    { value: 'lab',            label: 'Lab' },
    { value: 'radiology',      label: 'Radiology' },
    { value: 'invoice',        label: 'Invoices' },
    { value: 'payment',        label: 'Payments' },
    { value: 'dispense',       label: 'Pharmacy' },
    { value: 'appointment',    label: 'Appointments' },
    { value: 'credit_note',    label: 'Credit Notes' },
  ]

  if (timeline.length === 0) {
    return <div style={{ color: 'var(--muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>No history recorded for this patient yet.</div>
  }

  return (
    <div>
      {/* Filter + search */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>
          <strong>{filtered.length}</strong> event{filtered.length === 1 ? '' : 's'}
          {filtered.length !== timeline.length && ` (filtered from ${timeline.length})`}
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ padding: '5px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)' }}>
          {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          type="text"
          placeholder="Search…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ flex: 1, minWidth: 180, maxWidth: 280, padding: '5px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)' }}
        />
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pageItems.map(e => {
          const isExpanded = expandedId === e.id
          const dateStr = new Date(e.date).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
          return (
            <div
              key={e.id}
              style={{
                padding: '10px 12px', borderRadius: 8,
                background: 'var(--bg-elevated)',
                border: `1px solid ${isExpanded ? e.color + '55' : 'var(--line-soft)'}`,
                cursor: 'pointer',
              }}
              onClick={() => setExpandedId(isExpanded ? null : e.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: e.bg, color: e.color, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
                      {e.typeLabel}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{dateStr}</span>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{e.title}</div>
                  {e.summary && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.summary}</div>}

                  {/* Expanded details */}
                  {isExpanded && e.details && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)', fontSize: 12 }}>
                      {e.type === 'consultation' && <ConsultationDetails encounter={e.details.encounter} prescriptions={e.details.prescriptions} labOrders={e.details.labOrders} />}
                      {e.type === 'prescription' && (
                        <div>
                          <div><strong>Drug:</strong> {e.details.prescription.drug_name}</div>
                          <div><strong>Dosage:</strong> {e.details.prescription.dosage}</div>
                          <div><strong>Frequency:</strong> {e.details.prescription.frequency}</div>
                          <div><strong>Quantity:</strong> {e.details.prescription.quantity}</div>
                          <div><strong>Status:</strong> {e.details.prescription.status}</div>
                          {e.details.prescription.doctor_name && <div><strong>Doctor:</strong> {e.details.prescription.doctor_name}</div>}
                          {e.details.prescription.notes && <div><strong>Notes:</strong> {e.details.prescription.notes}</div>}
                        </div>
                      )}
                      {e.type === 'lab' && (
                        <div>
                          <div><strong>Test:</strong> {e.details.labOrder.test_name || e.details.labOrder.test_type}</div>
                          <div><strong>Status:</strong> {e.details.labOrder.status}</div>
                          {e.details.labOrder.result_value && <div><strong>Result:</strong> {e.details.labOrder.result_value}</div>}
                          {e.details.labOrder.result_notes && <div><strong>Notes:</strong> {e.details.labOrder.result_notes}</div>}
                        </div>
                      )}
                      {e.type === 'radiology' && (
                        <div>
                          <div><strong>Modality:</strong> {e.details.scan.modality}</div>
                          <div><strong>Body Part:</strong> {e.details.scan.body_part || '—'}</div>
                          <div><strong>Status:</strong> {e.details.scan.status}</div>
                          {e.details.scan.radiologist_report && <div><strong>Report:</strong> {e.details.scan.radiologist_report}</div>}
                        </div>
                      )}
                      {e.type === 'invoice' && (
                        <div>
                          <div><strong>Invoice #:</strong> {e.details.invoice.invoice_number}</div>
                          <div><strong>Total:</strong> {formatMoney(e.details.invoice.grand_total || e.details.invoice.amount)}</div>
                          <div><strong>Paid:</strong> {formatMoney(e.details.invoice.amount_paid)}</div>
                          <div><strong>Balance:</strong> {formatMoney(e.details.invoice.balance)}</div>
                          <div><strong>Status:</strong> {e.details.invoice.status} · {e.details.invoice.draft_status || 'finalized'}</div>
                          {e.details.invoice.payment_method && <div><strong>Method:</strong> {e.details.invoice.payment_method}</div>}
                        </div>
                      )}
                      {e.type === 'payment' && (
                        <div>
                          <div><strong>Amount:</strong> {formatMoney(e.details.payment.amount)}</div>
                          <div><strong>Method:</strong> {e.details.payment.method}</div>
                          {e.details.payment.reference_number && <div><strong>Reference:</strong> {e.details.payment.reference_number}</div>}
                          <div><strong>Status:</strong> {e.details.payment.status || 'completed'}</div>
                        </div>
                      )}
                      {e.type === 'dispense' && (
                        <div>
                          <div><strong>Item:</strong> {e.details.record.item_name}</div>
                          <div><strong>Quantity:</strong> {e.details.record.quantity_used}</div>
                          <div><strong>Unit Price:</strong> {formatMoney(e.details.record.unit_price)}</div>
                          <div><strong>Total:</strong> {formatMoney(e.details.record.total_price)}</div>
                        </div>
                      )}
                      {e.type === 'appointment' && (
                        <div>
                          <div><strong>Time:</strong> {new Date(e.details.appointment.appointment_time).toLocaleString('en-NG')}</div>
                          <div><strong>Status:</strong> {e.details.appointment.status}</div>
                          {e.details.appointment.doctor_name && <div><strong>Doctor:</strong> {e.details.appointment.doctor_name}</div>}
                          {e.details.appointment.reason && <div><strong>Reason:</strong> {e.details.appointment.reason}</div>}
                        </div>
                      )}
                      {e.type === 'credit_note' && (
                        <div>
                          <div><strong>CN #:</strong> {e.details.creditNote.credit_note_number}</div>
                          <div><strong>Amount:</strong> {formatMoney(e.details.creditNote.amount)}</div>
                          <div><strong>Reason:</strong> {e.details.creditNote.reason_code} — {e.details.creditNote.reason_text}</div>
                          <div><strong>Refund:</strong> {e.details.creditNote.refund_method || 'none'}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ flexShrink: 0, color: 'var(--muted)', fontSize: 10 }}>
                  {isExpanded ? '▲' : '▼'}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} disabled={safePage === 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))}>← Prev</button>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Page {safePage} of {totalPages} · {startIndex + 1}–{endIndex} of {filtered.length}</span>
          <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }} disabled={safePage === totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}>Next →</button>
        </div>
      )}
    </div>
  )
}

function ConsultationDetails({ encounter, prescriptions, labOrders }) {
  // Field renderer — only shows fields that were actually recorded.
  // "Not recorded" is shown only for required fields like chief complaint
  // when the encounter somehow has no value (rare; happens for legacy
  // rows that predate the consultation form).
  const field = (label, value, opts = {}) => {
    if (!value || (Array.isArray(value) && value.length === 0)) return null
    return (
      <div style={{ marginBottom: 6, ...opts.style }}>
        <strong style={{ color: 'var(--teal)', fontSize: 11.5, letterSpacing: '.02em' }}>{label}:</strong>{' '}
        <span style={{ fontSize: 13, color: 'var(--ivory)', whiteSpace: 'pre-wrap' }}>{value}</span>
      </div>
    )
  }

  // Diagnoses array (each item is { label, code } from ClinicalAutocomplete)
  const diagnosesText = encounter.diagnoses?.length > 0
    ? encounter.diagnoses.map(d => d.code ? `${d.label} (${d.code})` : d.label).join(', ')
    : (encounter.diagnosis ? encounter.diagnosis : null)

  // Symptoms array (each item is { label, code })
  const symptomsText = encounter.symptoms?.length > 0
    ? encounter.symptoms.map(s => s.code ? `${s.label} (${s.code})` : s.label).join(', ')
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {field('Chief Complaint', encounter.chief_complaints)}
      {field('History of Presenting Illness', encounter.history_presenting_complaint)}
      {field('Past Medical History', encounter.past_medical_history)}
      {field('Past Surgical History', encounter.past_surgical_history)}
      {field('Drug History', encounter.drug_history)}
      {field('Allergy History', encounter.allergy_history, { style: { color: 'var(--danger)' } })}
      {field('Family / Social History', encounter.family_social_history)}
      {field('Examination Findings', encounter.examination_findings)}
      {field('Clinical Notes', encounter.clinical_notes)}
      {field('Diagnosis', diagnosesText)}
      {field('Symptoms', symptomsText)}
      {field('Treatment Plan', encounter.treatment_plan)}
      {field('Follow-up', encounter.follow_up_notes)}
      {encounter.blood_pressure && (
        <div style={{ marginBottom: 6 }}>
          <strong style={{ color: 'var(--teal)', fontSize: 11.5, letterSpacing: '.02em' }}>Vitals:</strong>{' '}
          <span style={{ fontSize: 13, color: 'var(--ivory)' }}>
            BP {encounter.blood_pressure} · Pulse {encounter.pulse_rate || '—'} · Temp {encounter.temperature || '—'}°C
            {encounter.spo2 ? ` · SpO₂ ${encounter.spo2}%` : ''}
            {encounter.respiratory_rate ? ` · RR ${encounter.respiratory_rate}` : ''}
            {encounter.weight ? ` · Wt ${encounter.weight}kg` : ''}
            {encounter.height ? ` · Ht ${encounter.height}cm` : ''}
          </span>
        </div>
      )}
      {prescriptions.length > 0 && (
        <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'rgba(0,199,199,0.06)', border: '1px solid var(--line-soft)' }}>
          <strong style={{ color: 'var(--teal)', fontSize: 11.5, letterSpacing: '.02em' }}>Prescriptions:</strong>
          <div style={{ fontSize: 12.5, color: 'var(--ivory)', marginTop: 4 }}>
            {prescriptions.map((rx, i) => (
              <div key={i} style={{ marginBottom: 2 }}>
                • {rx.drug_name} — {rx.dosage}{rx.frequency ? ` · ${rx.frequency}` : ''}{rx.duration ? ` · ${rx.duration}` : ''}
              </div>
            ))}
          </div>
        </div>
      )}
      {labOrders.length > 0 && (
        <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'rgba(232,184,46,0.06)', border: '1px solid var(--line-soft)' }}>
          <strong style={{ color: 'var(--gold)', fontSize: 11.5, letterSpacing: '.02em' }}>Lab Orders:</strong>
          <div style={{ fontSize: 12.5, color: 'var(--ivory)', marginTop: 4 }}>
            {labOrders.map((lo, i) => (
              <div key={i}>• {lo.test_name || lo.test_type}{lo.priority ? ` (${lo.priority})` : ''}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// NEW COMPONENT: Items Given Tab
function ItemsGivenTab({ records }){
  if (records.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>No items or drugs have been dispensed to this patient yet.</div>
  
  const totalCost = records.reduce((sum, r) => sum + Number(r.total_price || 0), 0)

  return (
    <div>
      <div style={{ marginBottom: 18, padding: 14, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Total Value of Items Given</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--teal)' }}>₦{totalCost.toLocaleString()}</div>
      </div>

      <ul className="dash-legend">
        {records.map(r => (
          <li key={r.id} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <strong>{r.item_name}</strong>
              <span style={{ fontWeight: 700, color: 'var(--gold)' }}>₦{Number(r.total_price || 0).toLocaleString()}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <span>Qty: {r.quantity_used}</span>
              <span>{new Date(r.created_at).toLocaleString()}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PrescriptionsTab({ prescriptions }){
  if (prescriptions.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>No prescriptions on record.</div>
  return (
    <ul className="dash-legend">
      {prescriptions.map(rx => (
        <li key={rx.id} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '12px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
            <strong>{rx.drug_name}</strong>
            <span style={{
              fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
              background: rx.status === 'active' ? 'var(--teal-soft)' : rx.status === 'draft' ? 'rgba(201,169,97,0.14)' : 'rgba(255,255,255,0.06)',
              color: rx.status === 'active' ? 'var(--teal)' : rx.status === 'draft' ? 'var(--gold)' : 'var(--muted)',
            }}>
              {rx.status}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {rx.dosage}{rx.route ? ` · ${rx.route}` : ''}{rx.frequency ? ` · ${rx.frequency}` : ''}{rx.duration ? ` · ${rx.duration}` : ''}
          </div>
          {rx.instructions && <div style={{ fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic' }}>{rx.instructions}</div>}
        </li>
      ))}
    </ul>
  )
}

function PharmacyTab({ activePrescriptions, findPharmacyMatch, onDispense }){
  if (activePrescriptions.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>No medications awaiting dispensing.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {activePrescriptions.map(rx => {
        const match = findPharmacyMatch(rx.drug_name)
        return (
          <div key={rx.id} style={{ padding: 14, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{rx.drug_name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{rx.dosage}{rx.frequency ? ` · ${rx.frequency}` : ''}</div>
                <div style={{ fontSize: 11.5, marginTop: 4, color: match ? (Number(match.quantity) > 0 ? 'var(--teal)' : 'var(--danger)') : 'var(--muted)' }}>
                  {match ? `${match.quantity} ${match.unit || 'units'} in stock` : 'Not tracked in pharmacy inventory'}
                </div>
              </div>
              <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }} onClick={() => onDispense(rx)}>Dispense</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function BillingTab({ patient, invoices, outstandingBalance, profile, addInvoice, updateInvoice, showToast }){
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleAddCharge(e){
    e.preventDefault()
    const parsedAmount = parseFloat(amount)
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) return
    setSaving(true)
    try {
      await addInvoice({
        patient_id: patient.id, // FIX: ensure manual charges link to patient_id
        patient_name: patient.full_name,
        description: description || 'Charge',
        amount: parsedAmount,
        status: 'unpaid',
        created_by: profile?.id || null,
      })
      setDescription(''); setAmount('')
      showToast('Charge added')
    } catch (err) {
      showToast(err.message || 'Could not add charge')
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(inv){
    const newStatus = inv.status === 'paid' ? 'unpaid' : 'paid'
    await updateInvoice(inv.id, { status: newStatus })
    showToast(`Marked ${newStatus}`)
  }

  return (
    <div>
      <div style={{ marginBottom: 18, padding: 14, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Outstanding Balance</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: outstandingBalance > 0 ? 'var(--gold)' : 'var(--teal)' }}>₦{outstandingBalance.toLocaleString()}</div>
      </div>

      <form onSubmit={handleAddCharge} style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" style={{ flex: 2 }} />
        <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount" type="number" style={{ flex: 1 }} />
        <button type="submit" className="btn btn-primary" style={{ width: 'auto', padding: '0 16px' }} disabled={saving}>Add</button>
      </form>

      {invoices.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>No charges on record.</div>
      ) : (
        <ul className="dash-legend">
          {invoices.map(inv => (
            <li key={inv.id}>
              <span className="dash-legend-name">
                <span className="dash-legend-dot" style={{ background: inv.status === 'paid' ? 'var(--teal)' : 'var(--gold)' }} />
                {inv.description || 'Charge'}
              </span>
              <span
                onClick={() => toggleStatus(inv)}
                className="dash-legend-val"
                style={{ cursor: 'pointer', color: inv.status === 'paid' ? 'var(--teal)' : 'var(--gold)', fontWeight: 700 }}
                title="Tap to toggle paid/unpaid"
              >
                ₦{Number(inv.amount).toLocaleString()} · {inv.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// =====================================================================
// Phase 2: Account Statement tab — running ledger of all financial
// activity for this patient. Filterable by date range. Printable.
// =====================================================================
function StatementTab({ patient, invoices, payments, creditNotes, deposits, hospital, profile }) {
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const [generating, setGenerating] = useState(false)

  // Default period: last 90 days
  useEffect(() => {
    if (!periodTo) {
      const today = new Date()
      const ninetyAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000)
      setPeriodTo(today.toISOString().slice(0, 10))
      setPeriodFrom(ninetyAgo.toISOString().slice(0, 10))
    }
  }, [])

  const statement = useMemo(() => {
    return computePatientStatement({
      invoices, payments, creditNotes, deposits,
      patientId: patient?.id,
      periodFrom, periodTo,
    })
  }, [invoices, payments, creditNotes, deposits, patient?.id, periodFrom, periodTo])

  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  function handlePrint() {
    setGenerating(true)
    const win = window.open('', '_blank')
    if (!win) {
      alert('Please allow popups to print the statement.')
      setGenerating(false)
      return
    }
    const rows = statement.ledger.map(entry => {
      const debit = entry.debit ? `<td style="text-align:right">₦${entry.debit.toFixed(2)}</td><td></td>` : `<td></td><td style="text-align:right">₦${entry.credit.toFixed(2)}</td>`
      return `<tr>
        <td>${new Date(entry.date).toLocaleDateString('en-NG')}</td>
        <td>${entry.type}</td>
        <td>${entry.number || ''}</td>
        <td>${entry.description}</td>
        ${debit}
      </tr>`
    }).join('')

    const html = `
      <html><head><title>Statement — ${patient.full_name}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #111; max-width: 800px; margin: auto; }
        .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 20px; margin-bottom: 30px; }
        .h-name { font-size: 24px; font-weight: bold; text-transform: uppercase; }
        .h-meta { font-size: 14px; color: #555; margin-top: 5px; }
        .patient-box, .period-box { background: #f8f9fa; padding: 15px; border-radius: 8px; }
        .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 20px 0; }
        .summary div { padding: 12px; background: #f8f9fa; border-radius: 8px; text-align: center; }
        .summary .label { font-size: 11px; color: #888; text-transform: uppercase; }
        .summary .value { font-size: 18px; font-weight: bold; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background: #f8f9fa; }
        .totals { margin-top: 20px; padding: 15px; background: #f0f9ff; border-radius: 8px; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #888; }
      </style></head><body>
        <div class="header">
          ${hospital?.logo_url ? `<img src="${hospital.logo_url}" alt="logo" style="max-width: 120px; max-height: 80px; margin: 0 auto 10px; display: block;" />` : ''}
          <div class="h-name">${hospital?.name || 'Hospital'}</div>
          ${hospital?.address ? `<div class="h-meta">${hospital.address}</div>` : ''}
          ${hospital?.phone ? `<div class="h-meta">Tel: ${hospital.phone}</div>` : ''}
        </div>
        <h2 style="text-align:center; margin-bottom: 20px;">PATIENT ACCOUNT STATEMENT</h2>
        <div style="display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px;">
          <div class="patient-box" style="flex:1">
            <strong>Patient:</strong> ${patient.full_name}<br/>
            <strong>MRN:</strong> ${patient.patient_id || patient.hospital_number || '—'}<br/>
            <strong>Phone:</strong> ${patient.phone || '—'}
          </div>
          <div class="period-box" style="flex:1">
            <strong>Statement Period:</strong><br/>
            ${periodFrom || 'Beginning'} to ${periodTo || 'Today'}<br/>
            <strong>Generated:</strong> ${new Date().toLocaleString('en-NG')}<br/>
            <strong>By:</strong> ${profile?.full_name || '—'}
          </div>
        </div>
        <div class="summary">
          <div><div class="label">Opening Balance</div><div class="value">₦${statement.openingBalance.toFixed(2)}</div></div>
          <div><div class="label">Closing Balance</div><div class="value" style="color: ${statement.closingBalance > 0 ? '#dc2626' : '#16a34a'}">₦${statement.closingBalance.toFixed(2)}</div></div>
          <div><div class="label">Invoices in Period</div><div class="value">${statement.invoiceCount}</div></div>
        </div>
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">No transactions in this period</td></tr>'}</tbody>
        </table>
        <div class="totals">
          <div><strong>Total Invoiced:</strong> ₦${statement.totalInvoiced.toFixed(2)}</div>
          <div><strong>Total Paid:</strong> ₦${statement.totalPaid.toFixed(2)}</div>
          <div><strong>Total Refunded (cash):</strong> ₦${statement.totalRefunded.toFixed(2)}</div>
          <div><strong>Total Adjusted (credits):</strong> ₦${statement.totalAdjusted.toFixed(2)}</div>
          <div style="margin-top: 8px; font-size: 16px;"><strong>Closing Balance:</strong> ₦${statement.closingBalance.toFixed(2)}</div>
        </div>
        <div class="footer">
          This statement was generated by ${hospital?.name || 'our hospital'} on ${new Date().toLocaleString('en-NG')}.<br/>
          Please contact our billing office if you have any questions about this statement.
        </div>
      </body></html>`
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); setGenerating(false) }, 500)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: 11 }}>From</label>
          <input type="date" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6 }} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label style={{ fontSize: 11 }}>To</label>
          <input type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)} style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6 }} />
        </div>
        <button className="btn btn-primary" style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5 }} onClick={handlePrint} disabled={generating}>
          {generating ? 'Generating…' : '🖨 Print Statement'}
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Opening Balance</div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 18, fontWeight: 700, marginTop: 4, color: statement.openingBalance > 0 ? 'var(--danger)' : 'var(--teal)' }}>{formatMoney(statement.openingBalance)}</div>
        </div>
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Invoiced</div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 18, fontWeight: 700, marginTop: 4, color: 'var(--ivory)' }}>{formatMoney(statement.totalInvoiced)}</div>
        </div>
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Paid</div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 18, fontWeight: 700, marginTop: 4, color: 'var(--teal)' }}>{formatMoney(statement.totalPaid)}</div>
        </div>
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Closing Balance</div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 18, fontWeight: 700, marginTop: 4, color: statement.closingBalance > 0 ? 'var(--danger)' : 'var(--teal)' }}>{formatMoney(statement.closingBalance)}</div>
        </div>
      </div>

      {/* Ledger table */}
      <div className="dash-panel" style={{ padding: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="dash-panel-title" style={{ fontSize: 14 }}>Transaction Ledger</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{statement.ledger.length} entries · {statement.invoiceCount} invoices, {statement.paymentCount} payments, {statement.creditNoteCount} credit notes</div>
        </div>
        {statement.ledger.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>No transactions in this period.</div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-full-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Number</th>
                  <th>Description</th>
                  <th>Debit</th>
                  <th>Credit</th>
                </tr>
              </thead>
              <tbody>
                {statement.ledger.map((entry, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{new Date(entry.date).toLocaleDateString('en-NG')}</td>
                    <td>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                        background: entry.type === 'invoice' ? 'rgba(225,104,94,0.14)' :
                                    entry.type === 'payment' ? 'rgba(0,199,199,0.14)' :
                                    'rgba(118,87,232,0.14)',
                        color: entry.type === 'invoice' ? 'var(--danger)' :
                               entry.type === 'payment' ? 'var(--teal)' :
                               'var(--violet)',
                        textTransform: 'uppercase', letterSpacing: 0.5,
                      }}>
                        {entry.type}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{entry.number || '—'}</td>
                    <td style={{ fontSize: 12 }}>{entry.description}</td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--danger)', fontWeight: 700 }}>{entry.debit ? formatMoney(entry.debit) : '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--teal)', fontWeight: 700 }}>{entry.credit ? formatMoney(entry.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function EditInfoTab({ patient, updatePatient, showToast }){
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm({
      full_name: patient.full_name || '',
      age: patient.age ?? '',
      gender: patient.gender || '',
      phone: patient.phone || '',
      blood_group: patient.blood_group || '',
      genotype: patient.genotype || '',
      emergency_contact_name: patient.emergency_contact_name || '',
      emergency_contact_phone: patient.emergency_contact_phone || '',
      address: patient.address || '',
      status: patient.status || 'stable',
    })
  }, [patient.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) return null

  async function handleSave(e){
    e.preventDefault()
    setSaving(true)
    try {
      await updatePatient(patient.id, {
        full_name: form.full_name,
        age: form.age === '' ? null : parseInt(form.age, 10),
        gender: form.gender || null,
        phone: form.phone || null,
        blood_group: form.blood_group || null,
        genotype: form.genotype || null,
        emergency_contact_name: form.emergency_contact_name || null,
        emergency_contact_phone: form.emergency_contact_phone || null,
        address: form.address || null,
        status: form.status,
      })
      showToast('Patient details updated')
    } catch (err) {
      showToast(err.message || 'Could not save changes')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave}>
      <div className="field">
        <label>Full Name</label>
        <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="field"><label>Age</label><input type="number" value={form.age} onChange={e => setForm(f => ({ ...f, age: e.target.value }))} /></div>
        <div className="field"><label>Gender</label><select value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))}><option value="">—</option><option value="Male">Male</option><option value="Female">Female</option></select></div>
        <div className="field"><label>Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
        <div className="field"><label>Patient Status</label><select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}><option value="stable">Stable</option><option value="review">In Review</option></select></div>
        <div className="field"><label>Blood Group</label><input value={form.blood_group} onChange={e => setForm(f => ({ ...f, blood_group: e.target.value }))} placeholder="e.g. O+" /></div>
        <div className="field"><label>Genotype</label><input value={form.genotype} onChange={e => setForm(f => ({ ...f, genotype: e.target.value }))} placeholder="e.g. AA" /></div>
        <div className="field"><label>Emergency Contact Name</label><input value={form.emergency_contact_name} onChange={e => setForm(f => ({ ...f, emergency_contact_name: e.target.value }))} /></div>
        <div className="field"><label>Emergency Contact Phone</label><input value={form.emergency_contact_phone} onChange={e => setForm(f => ({ ...f, emergency_contact_phone: e.target.value }))} /></div>
      </div>
      <div className="field"><label>Address</label><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
      <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
    </form>
  )
}

// =====================================================================
// VitalsTab — shows all recorded vitals for this patient in a table,
// newest first. Each row shows: date/time, vitals readings, nurse notes,
// chief complaint, diagnosis, assigned doctor. Clickable to expand.
//
// Also has an "Add Vitals" button that opens a modal for recording new
// vitals (same fields as the Nursing triage form).
// =====================================================================

function VitalsTab({ patient, allVitals, history, profile, hospital, addVitals, showToast }) {
  const [showAddModal, setShowAddModal] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // New vitals form state
  const [newVitals, setNewVitals] = useState({
    temperature: '', blood_pressure: '', pulse_rate: '', respiratory_rate: '',
    spo2: '', weight: '', height: '', nurse_notes: '', urgency: 'Routine',
  })

  // Filter vitals for this patient, newest first
  const patientVitals = (allVitals || [])
    .filter(v => v.patient_id === patient?.id)
    .sort((a, b) => new Date(b.recorded_at || b.created_at) - new Date(a.recorded_at || a.created_at))

  function formatVal(v) {
    if (v == null || v === '') return '—'
    return String(v)
  }

  async function handleSaveVitals(e) {
    e.preventDefault()
    setFormError('')
    if (!patient?.id) { setFormError('Patient not loaded.'); return }
    if (!profile?.id) { setFormError('Account still loading.'); return }

    setSaving(true)
    try {
      // CRITICAL: status 'waiting' would auto-send this patient to the
      // DoctorWorkbench queue (DoctorWorkbench.jsx:233 filters on
      // v.status === 'waiting'). Recording vitals from the Patient
      // Profile is a HISTORY append, not a triage action — use
      // 'recorded' so the vitals save to the patient's history
      // WITHOUT appearing in the doctor's queue.
      //
      // If staff wants to send the patient to the doctor, they should
      // click the "Send to Doctor" button below the vitals table,
      // which calls handleSendToDoctor() and explicitly sets
      // status='waiting' + assigned_doctor.
      await addVitals({
        patient_id: patient.id,
        patient_name: patient.full_name,
        ...newVitals,
        status: 'recorded',
        recorded_at: new Date().toISOString(),
        created_by: profile.id,
      })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'vitals.recorded_from_profile',
        entityType: 'patient_vitals', entityId: null,
        patientId: patient.id,
        summary: `Vitals recorded for ${patient.full_name} from patient profile (history only — not sent to doctor queue)`,
        metadata: { ...newVitals, source: 'patient_profile', status: 'recorded' },
      })
      showToast('Vitals recorded — saved to history only')
      setShowAddModal(false)
      setNewVitals({ temperature: '', blood_pressure: '', pulse_rate: '', respiratory_rate: '', spo2: '', weight: '', height: '', nurse_notes: '', urgency: 'Routine' })
    } catch (err) {
      setFormError(err.message || 'Could not save vitals.')
    } finally {
      setSaving(false)
    }
  }

  // ---------------------------------------------------------------
  // Send to Doctor Queue — explicit action.
  // Only called when staff clicks the "Send to Doctor" button below
  // the vitals table. Sets status='waiting' so DoctorWorkbench picks
  // it up.
  // ---------------------------------------------------------------
  async function handleSendToDoctor(vitalsId) {
    if (!vitalsId) return
    if (!patient?.id) { showToast('Patient not loaded.'); return }
    if (!profile?.id) { showToast('Account still loading.'); return }
    try {
      await updateVitals(vitalsId, {
        status: 'waiting',
        queue_status: 'sent_to_doctor',
      })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'vitals.sent_to_doctor_from_profile',
        entityType: 'patient_vitals', entityId: vitalsId,
        patientId: patient.id,
        summary: `Vitals for ${patient.full_name} explicitly sent to doctor queue from patient profile`,
        metadata: { vitals_id: vitalsId, action: 'send_to_doctor' },
      })
      showToast(`Sent to doctor queue`)
    } catch (err) {
      showToast(err.message || 'Could not send to doctor queue.')
    }
  }

  return (
    <div>
      {/* Header + Add button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory)' }}>
          Vitals History ({patientVitals.length})
        </div>
        <button className="btn btn-primary" style={{ width: 'auto', padding: '7px 14px', fontSize: 12 }} onClick={() => { setFormError(''); setShowAddModal(true) }}>
          <AppIcon name="plus" size={14} /> Add Vitals
        </button>
      </div>

      {patientVitals.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13, background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--line)' }}>
          No vitals recorded yet. Click "Add Vitals" to record the first set.
        </div>
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-full-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Date / Time</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Temp</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>BP</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Pulse</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>RR</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>SpO₂</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Wt</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Urgency</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Doctor</th>
                <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Status</th>
                <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {patientVitals.map(v => {
                const expanded = expandedId === v.id
                const urgencyColor = v.urgency === 'Emergency' ? 'var(--danger)' : v.urgency === 'Urgent' ? 'var(--gold)' : 'var(--teal)'
                return (
                  <>
                    <tr key={v.id} style={{ borderTop: '1px solid var(--line-soft)', cursor: 'pointer' }} onClick={() => setExpandedId(expanded ? null : v.id)}>
                      <td style={{ padding: 12, fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {v.recorded_at ? formatDateTime(v.recorded_at, hospital?.timezone || 'Africa/Lagos') : '—'}
                      </td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{formatVal(v.temperature)}{v.temperature ? '°C' : ''}</td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{formatVal(v.blood_pressure)}</td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{formatVal(v.pulse_rate)}</td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{formatVal(v.respiratory_rate)}</td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{formatVal(v.spo2)}{v.spo2 ? '%' : ''}</td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{formatVal(v.weight)}{v.weight ? 'kg' : ''}</td>
                      <td style={{ padding: 12 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: `${urgencyColor}22`, color: urgencyColor, textTransform: 'uppercase' }}>
                          {v.urgency || 'Routine'}
                        </span>
                      </td>
                      <td style={{ padding: 12, fontSize: 11.5, color: 'var(--muted)' }}>{v.assigned_doctor || '—'}</td>
                      <td style={{ padding: 12 }}>
                        {v.status === 'waiting' ? (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(24,217,155,0.18)', color: 'var(--mint)', textTransform: 'uppercase' }}>In Doctor Queue</span>
                        ) : v.status === 'completed' ? (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(0,168,255,0.18)', color: 'var(--blue)', textTransform: 'uppercase' }}>Completed</span>
                        ) : (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(150,150,150,0.18)', color: 'var(--muted)', textTransform: 'uppercase' }}>Recorded</span>
                        )}
                      </td>
                      <td style={{ padding: 12, textAlign: 'right' }}>
                        {v.status !== 'waiting' && v.status !== 'completed' && (
                          <button
                            className="btn btn-ghost"
                            style={{ width: 'auto', padding: '5px 10px', fontSize: 11, color: 'var(--mint)', borderColor: 'var(--mint-border)' }}
                            onClick={(e) => { e.stopPropagation(); handleSendToDoctor(v.id) }}
                            title="Send this vitals record to the doctor's queue"
                          >
                            <AppIcon name="send" size={12} /> Send to Doctor
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={v.id + '-expanded'} style={{ background: 'var(--bg-elevated)' }}>
                        <td colSpan={11} style={{ padding: 14 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                            {v.chief_complaints && (
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Chief Complaint</div>
                                <div style={{ fontSize: 12.5, color: 'var(--ivory)' }}>{v.chief_complaints}</div>
                              </div>
                            )}
                            {v.allergy_history && (
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Allergies</div>
                                <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{v.allergy_history}</div>
                              </div>
                            )}
                            {v.nurse_notes && (
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Nurse Notes</div>
                                <div style={{ fontSize: 12.5, color: 'var(--ivory)', fontStyle: 'italic' }}>{v.nurse_notes}</div>
                              </div>
                            )}
                            {v.height && (
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Height</div>
                                <div style={{ fontSize: 12.5, color: 'var(--ivory)' }}>{v.height} cm</div>
                              </div>
                            )}
                            {Array.isArray(v.diagnoses) && v.diagnoses.length > 0 && (
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Diagnoses</div>
                                <div style={{ fontSize: 12.5, color: 'var(--ivory)' }}>{v.diagnoses.map(d => d.label || d.name).join(', ')}</div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Add Vitals Modal ---- */}
      {showAddModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">Record New Vitals</div>
            <div className="dash-modal-body">
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
                For <strong style={{ color: 'var(--teal)' }}>{patient?.full_name}</strong>
              </div>
              {formError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{formError}</div>}
              <form id="vitals-form" onSubmit={handleSaveVitals}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="field"><label>Temperature (°C)</label><input type="number" step="0.1" value={newVitals.temperature} onChange={e => setNewVitals(v => ({ ...v, temperature: e.target.value }))} placeholder="36.8" /></div>
                  <div className="field"><label>Blood Pressure</label><input value={newVitals.blood_pressure} onChange={e => setNewVitals(v => ({ ...v, blood_pressure: e.target.value }))} placeholder="120/80" /></div>
                  <div className="field"><label>Pulse Rate (bpm)</label><input type="number" value={newVitals.pulse_rate} onChange={e => setNewVitals(v => ({ ...v, pulse_rate: e.target.value }))} placeholder="75" /></div>
                  <div className="field"><label>Resp. Rate (bpm)</label><input type="number" value={newVitals.respiratory_rate} onChange={e => setNewVitals(v => ({ ...v, respiratory_rate: e.target.value }))} placeholder="18" /></div>
                  <div className="field"><label>SpO₂ (%)</label><input type="number" value={newVitals.spo2} onChange={e => setNewVitals(v => ({ ...v, spo2: e.target.value }))} placeholder="98" /></div>
                  <div className="field"><label>Weight (kg)</label><input type="number" step="0.1" value={newVitals.weight} onChange={e => setNewVitals(v => ({ ...v, weight: e.target.value }))} placeholder="68" /></div>
                  <div className="field"><label>Height (cm)</label><input type="number" value={newVitals.height} onChange={e => setNewVitals(v => ({ ...v, height: e.target.value }))} placeholder="175" /></div>
                  <div className="field">
                    <label>Urgency</label>
                    <select value={newVitals.urgency} onChange={e => setNewVitals(v => ({ ...v, urgency: e.target.value }))}>
                      <option value="Routine">Routine</option>
                      <option value="Urgent">Urgent</option>
                      <option value="Emergency">Emergency</option>
                    </select>
                  </div>
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Nurse Observations / Notes</label>
                  <input value={newVitals.nurse_notes} onChange={e => setNewVitals(v => ({ ...v, nurse_notes: e.target.value }))} placeholder="e.g. Patient complains of headache" />
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowAddModal(false)} disabled={saving}>Cancel</button>
              <button type="submit" form="vitals-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Vitals'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
