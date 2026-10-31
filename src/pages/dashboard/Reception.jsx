import { useRef, useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import SearchInput from '../../components/common/SearchInput'
import AppIcon from '../../components/icons'
import ConnectionState from '../../components/common/ConnectionState'
import HmoProviderSelect from '../../components/common/HmoProviderSelect'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import { writeAudit } from '../../lib/audit'
import {
  getTimezone,
  formatTime,
  formatDateTimeSec,
  relativeShort,
  calculateAge,
} from '../../lib/datetime'
import {
  DEFAULT_REGISTRATION_FEES,
  FOLDER_CATEGORY_LABELS,
  FOLDER_CATEGORY_ORDER,
  getFeeForCategory,
  formatFee,
} from '../../lib/registrationFees'

const BLOOD_GROUPS = ['A+','A-','B+','B-','AB+','AB-','O+','O-','Unknown']
const GENOTYPES = ['AA','AS','SS','AC']
const MARITAL_STATUSES = ['Single','Married','Widow','Widower','Divorced']
const RELIGIONS = ['Christianity','Islam','Traditional','Other']

const CATEGORIES = [
  { value: 'personal',  label: 'Personal Folder',  defaultPrice: DEFAULT_REGISTRATION_FEES.personal },
  { value: 'family',    label: 'Family Folder',    defaultPrice: DEFAULT_REGISTRATION_FEES.family },
  { value: 'emergency', label: 'Emergency Folder',  defaultPrice: DEFAULT_REGISTRATION_FEES.emergency },
  { value: 'anc',       label: 'ANC Folder',       defaultPrice: DEFAULT_REGISTRATION_FEES.anc },
  { value: 'hmo',       label: 'HMO Folder',        defaultPrice: DEFAULT_REGISTRATION_FEES.hmo },
]

// Helper: filters CATEGORIES to only show those the hospital admin has enabled.
// Uses the hospital_registration_fees table's is_active column.
// If no feeRecords exist for a category, it defaults to shown (backward compat).
function getActiveCategories(feeRecords) {
  return CATEGORIES.filter(cat => {
    const row = (feeRecords || []).find(f => f.category === cat.value)
    // Default to active if no row exists (backward compat)
    return row ? row.is_active !== false : true
  })
}

const NIGERIAN_STATES = [
  'Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno',
  'Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT (Abuja)',
  'Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara',
  'Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers',
  'Sokoto','Taraba','Yobe','Zamfara',
]

const AFRICAN_COUNTRIES = [
  'Algeria','Angola','Benin','Botswana','Burkina Faso','Burundi','Cabo Verde',
  'Cameroon','Central African Republic','Chad','Comoros','Congo (Republic)',
  'Congo (DRC)','Djibouti','Egypt','Equatorial Guinea','Eritrea','Eswatini',
  'Ethiopia','Gabon','Gambia','Ghana','Guinea','Guinea-Bissau','Ivory Coast',
  'Kenya','Lesotho','Liberia','Libya','Madagascar','Malawi','Mali',
  'Mauritania','Mauritius','Morocco','Mozambique','Namibia','Niger',
  'Nigeria','Rwanda','Sao Tome and Principe','Senegal','Seychelles',
  'Sierra Leone','Somalia','South Africa','South Sudan','Sudan','Tanzania',
  'Togo','Tunisia','Uganda','Zambia','Zimbabwe',
]

const QUEUE_STAGES = [
  {
    key: 'waiting',
    label: 'Waiting',
    color: 'var(--gold)',
    bg: 'rgba(201,169,97,0.14)',
  },
  {
    key: 'in_consultation',
    label: 'In Consultation',
    color: 'var(--blue)',
    bg: 'rgba(76,141,255,0.14)',
  },
  {
    key: 'in_lab',
    label: 'In Lab',
    color: 'var(--violet)',
    bg: 'rgba(139,124,246,0.14)',
  },
  {
    key: 'discharged',
    label: 'Discharged',
    color: 'var(--teal)',
    bg: 'var(--teal-soft)',
  },
]

const EMPTY_FORM = {
  surname: '',
  otherNames: '',
  phone: '',
  email: '',
  gender: '',
  maritalStatus: '',
  dateOfBirth: '',
  age: '',
  bloodGroup: '',
  nationality: '',
  stateOfOrigin: '',
  occupation: '',
  religion: '',
  category: '',
  homeAddress: '',

  ancSpecialPoint: '',
  ancDateOfBooking: '',
  ancIndication: '',
  ancLmp: '',
  ancEdd: '',
  ancHusbandName: '',
  ancHusbandOccupation: '',
  ancEmployer: '',

  nokName: '',
  nokRelationship: '',
  nokPhone: '',
  nokAddress: '',

  genotype: '',

  // ---- Registration fee waiver ---------------------------------------
  // When `waiveRegistrationFee` is true, no billable_charge is created
  // for the folder fee at patient registration time. A reason is required
  // so the audit trail explains WHY the fee was waived (e.g. "staff family",
  // "charity case", "VIP").
  waiveRegistrationFee: false,
  waiveReason: '',

  hmoProvider: 'Self-Pay (No HMO)',
  hmoIdCode: '',
  hmoAuthorizationCode: '',         // Phase 3 — pre-auth code from HMO
  hmoAuthorizationDate: '',          // Phase 3 — when pre-auth was issued
  hmoAuthorizationExpires: '',      // Phase 3 — when pre-auth expires (some HMOs require this)
  hmoPlan: '',
  hmoNumber: '',
  hmoCoveragePercent: '',
}

function compressImage(file, maxWidth = 240) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      const img = new Image()

      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width)

        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)

        const ctx = canvas.getContext('2d')

        if (!ctx) {
          reject(new Error('Could not create image canvas'))
          return
        }

        ctx.drawImage(
          img,
          0,
          0,
          canvas.width,
          canvas.height
        )

        resolve(
          canvas.toDataURL('image/jpeg', 0.6)
        )
      }

      img.onerror = () => {
        reject(new Error('Could not read image'))
      }

      img.src = reader.result
    }

    reader.onerror = () => {
      reject(new Error('Could not read selected file'))
    }

    reader.readAsDataURL(file)
  })
}

// Local date helpers were removed in Stage 2 QA (pair 1): calculateAge now
// comes from src/lib/datetime.js (single source of date logic, req. #11),
// and the unused timeSince wrapper was deleted. calculateEdd stays local —
// it is pure UTC calendar arithmetic (LMP + 280 days), timezone-safe by
// construction.

function calculateEdd(lmpStr) {
  if (!lmpStr) return ''

  const lmp = new Date(lmpStr)

  if (Number.isNaN(lmp.getTime())) {
    return ''
  }

  lmp.setDate(lmp.getDate() + 280)

  return lmp.toISOString().slice(0, 10)
}

export default function Reception() {
  const { profile, hospital } = useAuth()

  // Hospital-configured timezone for every displayed timestamp (req. #11).
  const timezone = getTimezone(hospital)

  const {
    records: patients,
    loading,
    isOnline,
    pendingCount,
    addRecord,
    updateRecord,
  } = useOfflineTable(
    'patients',
    hospital?.id
  )

  const [showModal, setShowModal] = useState(false)
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const [photoData, setPhotoData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const fileInputRef = useRef(null)

  function set(key, value) {
    setForm(current => ({
      ...current,
      [key]: value,
    }))
  }

  function handleDobChange(value) {
    const age = calculateAge(value)
    setForm(current => ({
      ...current,
      dateOfBirth: value,
      // Guard: a future DOB must never display a negative age.
      age: age !== '' && Number(age) < 0 ? '' : age,
    }))
  }

  function handleLmpChange(value) {
    setForm(current => ({
      ...current,
      ancLmp: value,
      ancEdd: calculateEdd(value),
    }))
  }

  // ---- Wallet hooks (patient wallet feature) ------------------------
  // Used by the inline "+ Deposit" button on the queue. Lets reception
  // record a deposit without leaving the Reception page.
  const { records: walletRecords, addRecord: addWalletRow, updateRecord: updateWalletRow, syncFromServer: syncWallets } = useOfflineTable('patient_wallets', hospital?.id)
  const { addRecord: addWalletTxn } = useOfflineTable('patient_wallet_transactions', hospital?.id)

  // ---- Registration fee hooks ---------------------------------------
  // Fetches this hospital's per-folder-category registration fees (set
  // in Settings → Registration Fees). Falls back to DEFAULT_REGISTRATION_FEES
  // (in src/lib/registrationFees.js) when no row exists.
  // `billableCharges.addRecord` is used to push the fee to the cashier's
  // queue (Billing → Patient Queue) so it flows through the normal
  // invoice + wallet-deduction pipeline.
  const { records: feeRecords } = useOfflineTable('hospital_registration_fees', hospital?.id)
  const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id)

  // Resolve the fee for the currently-selected folder category — used
  // to display the price next to the dropdown and to show/hide the
  // waiver checkbox.
  const selectedCategoryFee = getFeeForCategory(form.category, feeRecords)
  const hasRegistrationFee = selectedCategoryFee > 0
  const [depositTargetPatient, setDepositTargetPatient] = useState(null)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositMethod, setDepositMethod] = useState('Cash')
  const [depositRef, setDepositRef] = useState('')
  const [depositNotes, setDepositNotes] = useState('')
  const [depositSaving, setDepositSaving] = useState(false)
  const [depositError, setDepositError] = useState('')

  function openDepositModal(patient) {
    setDepositTargetPatient(patient)
    setDepositAmount(''); setDepositMethod('Cash'); setDepositRef(''); setDepositNotes('')
    setDepositError('')
  }

  async function handleDepositSubmit(e) {
    e.preventDefault()
    setDepositError('')
    const amount = parseFloat(depositAmount)
    if (isNaN(amount) || amount <= 0) { setDepositError('Enter a valid amount.'); return }
    if (!depositTargetPatient) { setDepositError('No patient selected.'); return }

    setDepositSaving(true)
    try {
      // Find or create the wallet row for this patient
      let wallet = walletRecords.find(w => w.patient_id === depositTargetPatient.id)
      if (!wallet) {
        wallet = await addWalletRow({
          hospital_id: hospital.id,
          patient_id: depositTargetPatient.id,
          balance: 0,
          currency: 'NGN',
        })
      }
      const balanceAfter = Number(wallet.balance || 0) + amount
            await addWalletTxn({
        hospital_id: hospital.id,
        patient_id: depositTargetPatient.id,
        wallet_id: wallet.id,
        type: 'deposit',
        amount,
        balance_after: balanceAfter,
        method: depositMethod,
        reference: depositRef.trim() || null,
        performed_by: profile?.id,
        performed_by_name: profile?.full_name || null,
        notes: depositNotes.trim() || null,
      })
      // Keep local IndexedDB balance in sync so Billing / CashierWorkspace
      // see the deposit immediately without a full page refresh.
      try {
        await updateWalletRow(wallet.id, { balance: balanceAfter })
      } catch (e) {
        console.warn('Local wallet balance update failed:', e)
      }
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'wallet.deposit',
        entityType: 'patient_wallet', entityId: wallet.id,
        patientId: depositTargetPatient.id,
        summary: `Deposit of ₦${amount.toFixed(2)} (${depositMethod}) for ${depositTargetPatient.full_name}`,
        metadata: { amount, method: depositMethod, reference: depositRef || null, balance_after: balanceAfter, source: 'reception' },
      })
      showToast(`Deposit of ₦${amount.toFixed(2)} recorded for ${depositTargetPatient.full_name}`)
      setDepositTargetPatient(null)
    } catch (err) {
      setDepositError(err.message || 'Could not record the deposit.')
    } finally {
      setDepositSaving(false)
    }
  }

  function showToast(message) {
    setToast(message)
    setTimeout(() => {
      setToast(null)
    }, 3000)
  }

  // ---- Realtime: refresh when patients are created/updated anywhere ----
  // Previously Reception required a manual refresh to see new patients
  // registered from the Dashboard quick-add or from another device.
  const { syncFromServer: syncPatients } = useOfflineTable('patients', hospital?.id)
  useRealtimeAlert('patients', hospital?.id, () => {
    syncPatients()
  })
    useRealtimeAlert('patients', hospital?.id, () => {
    syncPatients()
  }, { event: 'UPDATE' })

  // Wallet balance updates (trigger on server + other devices/tabs)
  useRealtimeAlert('patient_wallets', hospital?.id, () => {
    syncWallets()
  }, { event: 'UPDATE' })
  useRealtimeAlert('patient_wallets', hospital?.id, () => {
    syncWallets()
  })

  // ---- Polling safety net (every 30s) ----
  // If realtime fails (network, cold start), the poll catches up.
  useEffect(() => {
    if (!hospital?.id) return
    const id = setInterval(() => { syncPatients() }, 30000)
    return () => clearInterval(id)
  }, [hospital?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePhotoSelect(event) {
    const file = event.target.files?.[0]

    if (!file) return

    try {
      const compressed = await compressImage(file)

      setPhotoData(compressed)
    } catch (error) {
      console.error(error)
      showToast('Could not process photo')
    }
  }

  async function handleRegister(event) {
    event.preventDefault()

    setFormError('')

    /*
     * IMPORTANT:
     * Build the patient's name here explicitly.
     */
    const surname = String(
      form.surname || ''
    ).trim()

    const otherNames = String(
      form.otherNames || ''
    ).trim()

    const fullName = `${surname} ${otherNames}`.trim()

    /*
     * Validate the actual value that will be
     * sent to Supabase.
     */
    if (!surname) {
      setFormError('Surname is required.')
      return
    }

    if (!otherNames) {
      setFormError('Other names are required.')
      return
    }

    if (!fullName) {
      setFormError('Patient full name could not be created.')
      return
    }

    if (!hospital?.id) {
      setFormError(
        'Hospital information is not ready. Please wait a moment and try again.'
      )
      return
    }

    if (!profile?.id) {
      setFormError(
        'Your account information is not ready. Please wait a moment and try again.'
      )
      return
    }

    setSaving(true)

    try {
      const isAnc =
        form.category === 'anc'

      /*
       * This is the exact patient object.
       *
       * full_name is deliberately created
       * immediately before addRecord().
       */
      const patientData = {
        full_name: fullName,

        /*
         * Keep these too if the database contains
         * the columns.
         */
        surname: surname,
        other_names: otherNames,

        age: form.age
          ? parseInt(form.age, 10)
          : null,

        gender:
          form.gender || null,

        phone:
          form.phone?.trim() || null,

        email:
          form.email?.trim() || null,

        marital_status:
          form.maritalStatus || null,

        date_of_birth:
          form.dateOfBirth || null,

        blood_group:
          form.bloodGroup || null,

        genotype:
          form.genotype || null,

        nationality:
          form.nationality?.trim() || null,

        state_of_origin:
          form.stateOfOrigin || null,

        occupation:
          form.occupation?.trim() || null,

        religion:
          form.religion || null,

        category:
          form.category || null,

        address:
          form.homeAddress?.trim() || null,

        /*
         * ANC
         */
        anc_special_point:
          isAnc
            ? form.ancSpecialPoint?.trim() || null
            : null,

        anc_date_of_booking:
          isAnc
            ? form.ancDateOfBooking || null
            : null,

        anc_indication:
          isAnc
            ? form.ancIndication?.trim() || null
            : null,

        anc_lmp:
          isAnc
            ? form.ancLmp || null
            : null,

        anc_edd:
          isAnc
            ? form.ancEdd || null
            : null,

        anc_husband_name:
          isAnc
            ? form.ancHusbandName?.trim() || null
            : null,

        anc_husband_occupation:
          isAnc
            ? form.ancHusbandOccupation?.trim() || null
            : null,

        anc_employer:
          isAnc
            ? form.ancEmployer?.trim() || null
            : null,

        /*
         * Next of kin
         */
        emergency_contact_name:
          form.nokName?.trim() || null,

        emergency_contact_phone:
          form.nokPhone?.trim() || null,

        next_of_kin_relationship:
          form.nokRelationship?.trim() || null,

        next_of_kin_address:
          form.nokAddress?.trim() || null,

        hmo_provider:
          form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)' ? form.hmoProvider : null,

        hmo_id_code:
          form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)'
            ? (form.hmoIdCode?.trim() || null)
            : null,

        hmo_plan:
          form.hmoPlan?.trim() || null,

        hmo_number:
          form.hmoNumber?.trim() || null,

        hmo_coverage_percent:
          form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)' ? (parseFloat(form.hmoCoveragePercent) || 0) : null,

        // Phase 3 — pre-authorization code captured at registration.
        // Copied onto every invoice generated for this patient, and onto
        // every HMO claim auto-filed against those invoices.
        hmo_authorization_code:
          form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)'
            ? (form.hmoAuthorizationCode?.trim() || null)
            : null,
        hmo_authorization_date:
          form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)' && form.hmoAuthorizationDate
            ? new Date(form.hmoAuthorizationDate + 'T12:00:00').toISOString()
            : null,
        hmo_authorization_expires:
          form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)' && form.hmoAuthorizationExpires
            ? form.hmoAuthorizationExpires
            : null,
        hmo_authorization_captured_by: profile?.id || null,
        hmo_authorization_captured_at: new Date().toISOString(),

        photo_data:
          photoData || null,

        status: 'stable',

        queue_status: 'waiting',

        queue_updated_at:
          new Date().toISOString(),

        created_by:
          profile.id,
      }

      /*
       * Final safety check.
       * (Never console.log the payload — it contains patient PII.)
       */
      if (
        !patientData.full_name ||
        patientData.full_name === 'null'
      ) {
        throw new Error(
          'Patient full name is empty. Registration was stopped.'
        )
      }

      const savedPatient = await addRecord(patientData)

      // ---- Registration fee → billable_charge ----------------------
      // Per the folder-prices feature: when a patient is registered,
      // automatically push a pending charge for the folder fee to the
      // cashier's queue. The cashier then either collects it (with
      // wallet auto-deduction if the patient has a wallet balance) or
      // the receptionist can waive it (handled below).
      //
      // Skip when:
      //   - Waived (with a reason) — audit the waiver but don't charge.
      //   - No fee for this category (e.g., HMO = ₦0) — nothing to charge.
      //   - No category selected — nothing to charge.
      const folderFee = getFeeForCategory(form.category, feeRecords)
      if (form.category && folderFee > 0) {
        if (form.waiveRegistrationFee) {
          // Waived — record the reason in the audit trail only.
          // No billable_charge is created.
          writeAudit({
            hospitalId: hospital?.id,
            actor: profile,
            action: 'patient.registration_fee_waived',
            entityType: 'patient',
            entityId: savedPatient?.id || null,
            patientId: savedPatient?.id || null,
            summary: `Waived ${FOLDER_CATEGORY_LABELS[form.category] || form.category} registration fee (${formatFee(folderFee)}) for ${fullName} — reason: ${form.waiveReason || '(none given)'}`,
            metadata: {
              category: form.category,
              fee_amount: folderFee,
              reason: form.waiveReason || null,
            },
          })
        } else {
          // Charge the fee — push it as a pending billable_charge.
          await addBillableCharge({
            hospital_id: hospital.id,
            patient_id: savedPatient?.id || null,
            patient_name: fullName,
            source_module: 'Reception',
            source_transaction_id: `REGFEE-${Date.now()}`,
            item_name: `${FOLDER_CATEGORY_LABELS[form.category] || form.category} Registration Fee`,
            category: 'Registration',
            quantity: 1,
            unit_price: folderFee,
            total: folderFee,
            status: 'pending',
            created_by: profile?.id || null,
          })
          writeAudit({
            hospitalId: hospital?.id,
            actor: profile,
            action: 'patient.registration_fee_charged',
            entityType: 'patient',
            entityId: savedPatient?.id || null,
            patientId: savedPatient?.id || null,
            summary: `Charged ${FOLDER_CATEGORY_LABELS[form.category] || form.category} registration fee (${formatFee(folderFee)}) for ${fullName}`,
            metadata: {
              category: form.category,
              fee_amount: folderFee,
              billable_charge_item: `${FOLDER_CATEGORY_LABELS[form.category] || form.category} Registration Fee`,
            },
          })
        }
      }

      // Audit trail: who registered this patient and when (req. #16).
      writeAudit({
        hospitalId: hospital?.id,
        actor: profile,
        action: 'patient.create',
        entityType: 'patient',
        entityId: savedPatient?.id || null,
        summary: `Registered patient ${fullName}${form.category ? ` (${form.category} folder)` : ''} and checked in`,
        metadata: { category: form.category || null, hmo_provider: patientData.hmo_provider },
      })

      setShowModal(false)

      resetForm()

      showToast(
        isOnline
          ? `${fullName} registered and checked in`
          : `${fullName} registered — will sync when back online`
      )
    } catch (error) {
      console.error(
        'PATIENT REGISTRATION ERROR:',
        error
      )

      setFormError(
        error?.message ||
        'Could not register patient'
      )
    } finally {
      setSaving(false)
    }
  }

  function resetForm() {
    setForm({
      ...EMPTY_FORM,
    })

    setPhotoData(null)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  async function moveStage(
    patient,
    newStage
  ) {
    // Moving to the stage the patient is already in must not fire a
    // pointless write to the sync queue.
    if (patient.queue_status === newStage) return

    try {
      await updateRecord(
        patient.id,
        {
          queue_status: newStage,
          queue_updated_at:
            new Date().toISOString(),
        }
      )
    } catch (error) {
      showToast(
        error?.message ||
        'Could not update queue'
      )
    }
  }

  async function removeFromQueue(patient) {
    try {
      await updateRecord(
        patient.id,
        {
          queue_status: null,
        }
      )

      showToast(
        `${patient.full_name} removed from queue`
      )
    } catch (error) {
      showToast(
        error?.message ||
        'Could not remove patient'
      )
    }
  }

  const inQueue = patients.filter(
    patient => patient.queue_status
  )

  const queueSearch =
    searchTerm.trim().toLowerCase()

  const visibleQueue =
    queueSearch
      ? inQueue.filter(patient =>
          [
            patient.full_name,
            patient.patient_id,
            patient.phone,
          ].some(value =>
            String(value || '')
              .toLowerCase()
              .includes(queueSearch)
          )
        )
      : inQueue

  return (
    <>
      {/* ================= HEADER ================= */}

      <div
        className="dash-panel"
        style={{
          marginBottom: 16,
        }}
      >
        <div className="dash-panel-head">

          <div>
            <div className="dash-panel-title">
              Reception
            </div>

            <div
              className="dash-panel-sub"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              {/* Shared sync-state chip (Stage 1 #14) — same vocabulary as
                  every other module, replaces the hand-rolled dot. */}
              <ConnectionState isOnline={isOnline} pendingCount={pendingCount} />
            </div>
          </div>

          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search patients by name, ID or phone"
            style={{
              minWidth: 220,
              maxWidth: 420,
            }}
          />

          <ModuleHistoryButton moduleKey="reception" />

          <button
            className="btn btn-primary"
            style={{
              width: 'auto',
            }}
            onClick={() => {
              setFormError('')
              setShowModal(true)
            }}
          >
            + Register &amp; Check In
          </button>

        </div>

        <div
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
          }}
        >
          {inQueue.length} patient(s)
          currently in the queue
        </div>
      </div>

      {/* ================= QUEUE ================= */}

      {loading ? (
        <div className="dash-panel">
          <div className="dash-empty-state">Loading…</div>
        </div>
      ) : (
        <div className="dash-row dash-row-2b">

          {QUEUE_STAGES.map(stage => {

            const stagePatients =
              visibleQueue.filter(
                patient =>
                  patient.queue_status ===
                  stage.key
              )

            return (
              <div
                className="dash-panel"
                key={stage.key}
              >

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 14,
                  }}
                >

                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background:
                        stage.color,
                    }}
                  />

                  <div
                    style={{
                      fontFamily:
                        'var(--font-display)',
                      fontSize: 15,
                    }}
                  >
                    {stage.label}
                  </div>

                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: 'var(--muted)',
                      fontFamily:
                        'var(--font-mono)',
                    }}
                  >
                    {stagePatients.length}
                  </span>

                </div>

                {stagePatients.length === 0 ? (

                  <div
                    style={{
                      color: 'var(--muted)',
                      fontSize: 12,
                      padding: '6px 0',
                    }}
                  >
                    No patients here
                  </div>

                ) : (

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >

                    {stagePatients.map(patient => (

                      <div
                        key={patient.id}
                        className="rx-queue-card"
                      >

                        {patient.photo_data ? (

                          <img
                            src={patient.photo_data}
                            alt=""
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: '50%',
                              objectFit: 'cover',
                              flexShrink: 0,
                            }}
                          />

                        ) : (

                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: '50%',
                              background:
                                stage.bg,
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent:
                                'center',
                              fontSize: 12,
                              fontWeight: 700,
                              color:
                                stage.color,
                            }}
                          >
                            {patient.full_name
                              ?.charAt(0)
                              ?.toUpperCase()}
                          </div>

                        )}

                        <div className="rx-queue-info">

                          <div className="rx-queue-name">
                            {patient.full_name}
                          </div>

                          <div
                            className="rx-queue-time"
                            title={
                              patient.queue_updated_at
                                ? `${formatDateTimeSec(patient.queue_updated_at, timezone)} (${timezone}) — checked in / last queue change`
                                : undefined
                            }
                          >
                            {/* Exact check-in time is always shown alongside the
                                relative label — never relative-only (req. #11). */}
                            {patient.queue_updated_at
                              ? `${relativeShort(patient.queue_updated_at)} · ${formatTime(patient.queue_updated_at, timezone)}`
                              : '—'}
                          </div>

                        </div>

                        <select
                          className="rx-queue-select"
                          value={stage.key}
                          onChange={event =>
                            moveStage(
                              patient,
                              event.target.value
                            )
                          }
                          aria-label={`Move ${patient.full_name} to another queue stage`}
                        >
                          {QUEUE_STAGES.map(
                            queueStage => (
                              <option
                                key={
                                  queueStage.key
                                }
                                value={
                                  queueStage.key
                                }
                              >
                                {
                                  queueStage.label
                                }
                              </option>
                            )
                          )}
                        </select>

                        <button
                          type="button"
                          className="rx-queue-remove"
                          onClick={() =>
                            removeFromQueue(
                              patient
                            )
                          }
                          title="Remove from queue"
                          aria-label={`Remove ${patient.full_name} from queue`}
                        >
                          <AppIcon name="close" size={15} />
                        </button>

                        {/* Record Deposit — opens the patient wallet modal inline */}
                        <button
                          type="button"
                          className="rx-queue-deposit"
                          onClick={() => openDepositModal(patient)}
                          title="Record a deposit for this patient"
                          aria-label={`Record deposit for ${patient.full_name}`}
                          style={{
                            marginLeft: 6, padding: '6px 10px', borderRadius: 8,
                            border: '1px solid var(--teal-border)',
                            background: 'var(--teal-soft)', color: 'var(--teal)',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          + Deposit
                        </button>

                      </div>

                    ))}

                  </div>

                )}

              </div>
            )
          })}

        </div>
      )}

      {/* ================= REGISTER MODAL ================= */}

      {showModal && (

        /* Shared modal chrome (same as Dashboard's Register Patient
           modal): on phones this automatically becomes a bottom
           sheet with a scrollable body and pinned action row. */
        <div className="dash-modal-backdrop">

          <div className="card dash-modal dash-modal-lg">

            <div className="dash-modal-title">
              Register &amp; Check In
            </div>

            {/* dash-modal-form keeps the body scrollable and the action row
                pinned on short phone viewports (shared pattern, pair 1). */}
            <form onSubmit={handleRegister} className="dash-modal-form">

              <div className="dash-modal-body">

              {formError && (

                <div className="error-box">
                  {formError}
                </div>

              )}

              {/* PHOTO */}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  marginBottom: 16,
                }}
              >

                <div
                  role="button"
                  tabIndex={0}
                  aria-label={photoData ? 'Patient photo added — tap to change' : 'Add patient photo'}
                  onClick={() =>
                    fileInputRef.current?.click()
                  }
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      fileInputRef.current?.click()
                    }
                  }}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: '50%',
                    border:
                      '1px dashed var(--line)',
                    display: 'flex',
                    alignItems:
                      'center',
                    justifyContent:
                      'center',
                    cursor: 'pointer',
                    flexShrink: 0,
                    background:
                      'rgba(255,255,255,0.02)',
                    overflow: 'hidden',
                  }}
                >

                  {photoData ? (

                    <img
                      src={photoData}
                      alt=""
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />

                  ) : (

                    <AppIcon name="camera" size={22} style={{ color: 'var(--muted)' }} />

                  )}

                </div>

                <div>

                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color:
                        'var(--ivory)',
                    }}
                  >
                    {photoData
                      ? 'Photo captured'
                      : 'Add photo ID'}
                  </div>

                  <div
                    style={{
                      fontSize: 11,
                      color:
                        'var(--muted)',
                    }}
                  >
                    Tap the circle to use your camera
                  </div>

                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={
                    handlePhotoSelect
                  }
                  style={{
                    display: 'none',
                  }}
                />

              </div>

              {/* BIODATA */}

              <div
                style={{
                  fontSize: 11,
                  color: 'var(--teal)',
                  textTransform:
                    'uppercase',
                  letterSpacing: 1,
                  fontWeight: 800,
                  marginBottom: 10,
                  paddingBottom: 6,
                  borderBottom:
                    '1px solid var(--line-soft)',
                }}
              >
                Patient Biodata
              </div>

              <div className="dash-field-grid">

                <div className="field">
                  <label>
                    Surname
                  </label>

                  <input
                    value={form.surname}
                    onChange={event =>
                      set(
                        'surname',
                        event.target.value
                      )
                    }
                    placeholder="e.g. Okafor"
                    required
                  />
                </div>

                <div className="field">
                  <label>
                    Other Names
                  </label>

                  <input
                    value={
                      form.otherNames
                    }
                    onChange={event =>
                      set(
                        'otherNames',
                        event.target.value
                      )
                    }
                    placeholder="e.g. Chinedu"
                    required
                  />
                </div>

                <div className="field">
                  <label>
                    Tel
                  </label>

                  <input
                    value={form.phone}
                    onChange={event =>
                      set(
                        'phone',
                        event.target.value
                      )
                    }
                    placeholder="e.g. 0803 000 0000"
                  />
                </div>

                <div className="field">
                  <label>
                    Email
                  </label>

                  <input
                    type="email"
                    value={form.email}
                    onChange={event =>
                      set(
                        'email',
                        event.target.value
                      )
                    }
                    placeholder="e.g. name@email.com"
                  />
                </div>

                <div className="field">
                  <label>
                    Gender
                  </label>

                  <select
                    value={form.gender}
                    onChange={event =>
                      set(
                        'gender',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    <option value="Male">
                      Male
                    </option>

                    <option value="Female">
                      Female
                    </option>
                  </select>
                </div>

                <div className="field">
                  <label>
                    Marital Status
                  </label>

                  <select
                    value={
                      form.maritalStatus
                    }
                    onChange={event =>
                      set(
                        'maritalStatus',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    {MARITAL_STATUSES.map(
                      status => (
                        <option
                          key={status}
                          value={status}
                        >
                          {status}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div className="field">
                  <label>
                    Date of Birth
                  </label>

                  <input
                    type="date"
                    value={
                      form.dateOfBirth
                    }
                    onChange={event =>
                      handleDobChange(
                        event.target.value
                      )
                    }
                  />
                </div>

                <div className="field">
                  <label>
                    Age
                  </label>

                  <input
                    value={form.age}
                    readOnly
                    placeholder="Auto-calculated"
                    style={{
                      opacity: 0.75,
                    }}
                  />
                </div>

                <div className="field">
                  <label>
                    Blood Group
                  </label>

                  <select
                    value={
                      form.bloodGroup
                    }
                    onChange={event =>
                      set(
                        'bloodGroup',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    {BLOOD_GROUPS.map(
                      group => (
                        <option
                          key={group}
                          value={group}
                        >
                          {group}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div className="field">
                  <label>
                    Genotype
                  </label>

                  <select
                    value={form.genotype}
                    onChange={event =>
                      set(
                        'genotype',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    {GENOTYPES.map(
                      genotype => (
                        <option
                          key={genotype}
                          value={
                            genotype
                          }
                        >
                          {genotype}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div className="field">
                  <label>
                    Nationality
                  </label>

                  <input
                    list="african-countries"
                    value={
                      form.nationality
                    }
                    onChange={event =>
                      set(
                        'nationality',
                        event.target.value
                      )
                    }
                    placeholder="Start typing…"
                  />

                  <datalist id="african-countries">
                    {AFRICAN_COUNTRIES.map(
                      country => (
                        <option
                          key={country}
                          value={country}
                        />
                      )
                    )}
                  </datalist>
                </div>

                <div className="field">
                  <label>
                    State of Origin
                  </label>

                  <select
                    value={
                      form.stateOfOrigin
                    }
                    onChange={event =>
                      set(
                        'stateOfOrigin',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    {NIGERIAN_STATES.map(
                      state => (
                        <option
                          key={state}
                          value={state}
                        >
                          {state}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div className="field">
                  <label>
                    Occupation
                  </label>

                  <input
                    value={
                      form.occupation
                    }
                    onChange={event =>
                      set(
                        'occupation',
                        event.target.value
                      )
                    }
                    placeholder="e.g. Trader"
                  />
                </div>

                <div className="field">
                  <label>
                    Religion
                  </label>

                  <select
                    value={form.religion}
                    onChange={event =>
                      set(
                        'religion',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    {RELIGIONS.map(
                      religion => (
                        <option
                          key={religion}
                          value={religion}
                        >
                          {religion}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div className="field">
                  <label>
                    Category / Folder
                  </label>

                  <select
                    value={form.category}
                    onChange={event =>
                      set(
                        'category',
                        event.target.value
                      )
                    }
                  >
                    <option value="">
                      —
                    </option>

                    {getActiveCategories(feeRecords).map(
                      category => {
                        const fee = getFeeForCategory(category.value, feeRecords)
                        return (
                          <option
                            key={
                              category.value
                            }
                            value={
                              category.value
                            }
                          >
                            {category.label} — {formatFee(fee)}
                          </option>
                        )
                      }
                    )}
                  </select>

                  {/* ---- Registration fee banner -----------------------
                      Shows the fee that will be auto-charged to the
                      cashier's queue when this patient is saved. */}
                  {hasRegistrationFee && !form.waiveRegistrationFee && (
                    <div style={{
                      marginTop: 8, padding: '8px 10px', borderRadius: 6,
                      background: 'rgba(0,199,199,0.06)', border: '1px solid var(--line-soft)',
                      fontSize: 11.5, color: 'var(--ivory)', lineHeight: 1.5,
                    }}>
                      <strong style={{ color: 'var(--teal)' }}>Registration fee:</strong>{' '}
                      {formatFee(selectedCategoryFee)} will be auto-charged to the cashier's queue
                      when this patient is saved.
                    </div>
                  )}
                  {form.category && !hasRegistrationFee && (
                    <div style={{
                      marginTop: 8, padding: '8px 10px', borderRadius: 6,
                      background: 'rgba(0,199,199,0.04)', border: '1px solid var(--line-soft)',
                      fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5,
                    }}>
                      No registration fee for this folder category.
                    </div>
                  )}

                  {/* ---- Waiver checkbox + reason ---------------------- */}
                  {hasRegistrationFee && (
                    <div style={{ marginTop: 10 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ivory)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={form.waiveRegistrationFee}
                          onChange={e => set('waiveRegistrationFee', e.target.checked)}
                          style={{ width: 16, height: 16, accentColor: 'var(--teal)' }}
                        />
                        Waive registration fee
                      </label>
                      {form.waiveRegistrationFee && (
                        <input
                          value={form.waiveReason}
                          onChange={e => set('waiveReason', e.target.value)}
                          placeholder="Reason for waiver (required) — e.g. staff family, charity case"
                          style={{ marginTop: 8, fontSize: 12.5 }}
                          required
                        />
                      )}
                    </div>
                  )}
                </div>

              </div>

              <div className="field">

                <label>
                  Home Address
                </label>

                <input
                  value={
                    form.homeAddress
                  }
                  onChange={event =>
                    set(
                      'homeAddress',
                      event.target.value
                    )
                  }
                  placeholder="e.g. 12 Ada George Road, Port Harcourt"
                />

              </div>

              {/* ANC */}

              {form.category === 'anc' && (

                <>

                  <div
                    style={{
                      fontSize: 11,
                      color:
                        'var(--violet)',
                      textTransform:
                        'uppercase',
                      letterSpacing: 1,
                      fontWeight: 800,
                      marginTop: 18,
                      marginBottom: 10,
                      paddingBottom: 6,
                      borderBottom:
                        '1px solid var(--line-soft)',
                    }}
                  >
                    ANC Specific Details
                  </div>

                  <div className="field">

                    <label>
                      Special Point
                    </label>

                    <input
                      value={
                        form.ancSpecialPoint
                      }
                      onChange={event =>
                        set(
                          'ancSpecialPoint',
                          event.target.value
                        )
                      }
                      placeholder="e.g. First pregnancy"
                    />

                  </div>

                  <div className="dash-field-grid">

                    <div className="field">

                      <label>
                        Date of Booking
                      </label>

                      <input
                        type="date"
                        value={
                          form.ancDateOfBooking
                        }
                        onChange={event =>
                          set(
                            'ancDateOfBooking',
                            event.target.value
                          )
                        }
                      />

                    </div>

                    <div className="field">

                      <label>
                        Indication for Booking
                      </label>

                      <input
                        value={
                          form.ancIndication
                        }
                        onChange={event =>
                          set(
                            'ancIndication',
                            event.target.value
                          )
                        }
                        placeholder="e.g. Routine ANC"
                      />

                    </div>

                    <div className="field">

                      <label>
                        Last Menstrual Period (LMP) <span style={{ color: 'var(--danger)' }}>*</span>
                      </label>

                      <input
                        type="date"
                        value={form.ancLmp}
                        onChange={event =>
                          handleLmpChange(event.target.value)
                        }
                        max={new Date().toISOString().slice(0, 10)}
                        required={form.category === 'anc'}
                        style={!form.ancLmp && form.category === 'anc' ? { borderColor: 'var(--danger)' } : {}}
                      />

                      {/* Future LMP validation — Section 4 spec: "Do not silently accept a future LMP without warning and confirmation." */}
                      {form.ancLmp && (() => {
                        const lmpDate = new Date(form.ancLmp + 'T12:00:00')
                        const today = new Date()
                        today.setHours(0, 0, 0, 0)
                        if (lmpDate > today) {
                          return (
                            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, padding: '4px 8px', background: 'var(--danger-soft)', borderRadius: 6 }}>
                              ⚠ LMP is in the future. Please verify the date.
                            </div>
                          )
                        }
                        // Pregnancy > 42 weeks = implausible
                        const weeksPregnant = Math.floor((today - lmpDate) / (7 * 24 * 60 * 60 * 1000))
                        if (weeksPregnant > 42) {
                          return (
                            <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 4, padding: '4px 8px', background: 'var(--warning-soft)', borderRadius: 6 }}>
                              ⚠ LMP suggests {weeksPregnant} weeks pregnant — beyond typical 42-week gestation. Please verify.
                            </div>
                          )
                        }
                        return null
                      })()}

                    </div>

                    <div className="field">

                      <label>
                        Estimated Date of Delivery (EDD)
                      </label>

                      <input
                        type="date"
                        value={
                          form.ancEdd
                        }
                        readOnly
                        style={{
                          opacity: 0.75,
                        }}
                      />

                    </div>

                    <div className="field">

                      <label>
                        Husband's Name
                      </label>

                      <input
                        value={
                          form.ancHusbandName
                        }
                        onChange={event =>
                          set(
                            'ancHusbandName',
                            event.target.value
                          )
                        }
                      />

                    </div>

                    <div className="field">

                      <label>
                        Husband's Occupation
                      </label>

                      <input
                        value={
                          form.ancHusbandOccupation
                        }
                        onChange={event =>
                          set(
                            'ancHusbandOccupation',
                            event.target.value
                          )
                        }
                      />

                    </div>

                  </div>

                  <div className="field">

                    <label>
                      Employer
                    </label>

                    <input
                      value={
                        form.ancEmployer
                      }
                      onChange={event =>
                        set(
                          'ancEmployer',
                          event.target.value
                        )
                      }
                    />

                  </div>

                </>

              )}

              {/* HMO / INSURANCE */}

              <div
                style={{
                  fontSize: 11,
                  color: 'var(--gold)',
                  textTransform:
                    'uppercase',
                  letterSpacing: 1,
                  fontWeight: 800,
                  marginTop: 18,
                  marginBottom: 10,
                  paddingBottom: 6,
                  borderBottom:
                    '1px solid var(--line-soft)',
                }}
              >
                HMO / Insurance
              </div>

              {/* HMO FIELDS — only shown when category is 'hmo'.
                  Same conditional pattern as the ANC fields above. */}
              {form.category === 'hmo' && (
                <div className="dash-field-grid">

                  <div
                    className="field"
                    style={
                      form.hmoProvider === 'Self-Pay (No HMO)'
                        ? { gridColumn: '1 / -1' }
                        : undefined
                    }
                  >
                    <label>HMO Provider</label>
                    <HmoProviderSelect
                      value={form.hmoProvider}
                      onChange={name => set('hmoProvider', name || 'Self-Pay (No HMO)')}
                      placeholder="Search HMO provider…"
                      ariaLabel="HMO provider"
                      hospitalId={hospital?.id}
                    />
                  </div>

                  {form.hmoProvider !== 'Self-Pay (No HMO)' && (
                    <>
                      <div className="field">
                        <label>HMO ID Code</label>
                        <input
                          value={form.hmoIdCode}
                          onChange={event => set('hmoIdCode', event.target.value)}
                          placeholder="Patient's HMO membership ID (on the card)"
                        />
                      </div>
                      <div className="field">
                        <label>Plan / Tier</label>
                        <input
                          value={form.hmoPlan}
                          onChange={event => set('hmoPlan', event.target.value)}
                          placeholder="e.g. Silver Plan"
                        />
                      </div>
                      <div className="field">
                        <label>Enrollee / Policy No.</label>
                        <input
                          value={form.hmoNumber}
                          onChange={event => set('hmoNumber', event.target.value)}
                          placeholder="e.g. NHIS-2024-00123"
                        />
                      </div>
                      <div className="field">
                        <label>HMO Covers (%)</label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={form.hmoCoveragePercent}
                          onChange={event => set('hmoCoveragePercent', event.target.value)}
                          placeholder="e.g. 80"
                        />
                      </div>
                      {/* Phase 3 — Pre-Authorization Code Capture
                          Some HMOs require this before certain services can be billed.
                          The code is copied onto every invoice + claim for this patient. */}
                      <div className="field">
                        <label>Pre-Authorization Code {form.hmoProvider && form.hmoProvider !== 'Self-Pay (No HMO)' && (
                          <span style={{ color: 'var(--gold)', fontSize: 10, marginLeft: 6 }}>(if required by HMO)</span>
                        )}</label>
                        <input
                          value={form.hmoAuthorizationCode}
                          onChange={event => set('hmoAuthorizationCode', event.target.value)}
                          placeholder="e.g. AUTH-2024-12345 (from HMO call center)"
                        />
                      </div>
                      <div className="dash-field-grid">
                        <div className="field">
                          <label>Auth Issue Date</label>
                          <input
                            type="date"
                            value={form.hmoAuthorizationDate}
                            onChange={event => set('hmoAuthorizationDate', event.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label>Auth Expires (if applicable)</label>
                          <input
                            type="date"
                            value={form.hmoAuthorizationExpires}
                            onChange={event => set('hmoAuthorizationExpires', event.target.value)}
                          />
                        </div>
                      </div>
                    </>
                  )}

                </div>
              )}

              {/* NEXT OF KIN */}

              <div
                style={{
                  fontSize: 11,
                  color: 'var(--gold)',
                  textTransform:
                    'uppercase',
                  letterSpacing: 1,
                  fontWeight: 800,
                  marginTop: 18,
                  marginBottom: 10,
                  paddingBottom: 6,
                  borderBottom:
                    '1px solid var(--line-soft)',
                }}
              >
                Next of Kin
              </div>

              <div className="dash-field-grid">

                <div className="field">

                  <label>
                    Name
                  </label>

                  <input
                    value={form.nokName}
                    onChange={event =>
                      set(
                        'nokName',
                        event.target.value
                      )
                    }
                    placeholder="e.g. Ngozi Okafor"
                  />

                </div>

                <div className="field">

                  <label>
                    Relationship
                  </label>

                  <input
                    value={
                      form.nokRelationship
                    }
                    onChange={event =>
                      set(
                        'nokRelationship',
                        event.target.value
                      )
                    }
                    placeholder="e.g. Spouse"
                  />

                </div>

                <div className="field">

                  <label>
                    Tel
                  </label>

                  <input
                    value={form.nokPhone}
                    onChange={event =>
                      set(
                        'nokPhone',
                        event.target.value
                      )
                    }
                    placeholder="e.g. 0803 000 0000"
                  />

                </div>

                <div className="field">

                  <label>
                    Address
                  </label>

                  <input
                    value={form.nokAddress}
                    onChange={event =>
                      set(
                        'nokAddress',
                        event.target.value
                      )
                    }
                  />

                </div>

              </div>

              </div>{/* /dash-modal-body */}

              <div className="dash-modal-actions">

                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowModal(false)
                    resetForm()
                    setFormError('')
                  }}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving}
                >
                  {saving
                    ? 'Registering…'
                    : 'Register & Check In'}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* TOAST — shared toast shell, teal success variant */}

      {toast && (
        <div className="dash-toast dash-toast-success">{toast}</div>
      )}

      {/* ---- Inline deposit modal (patient wallet feature) ---- */}
      {depositTargetPatient && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setDepositTargetPatient(null) }}>
          <div className="card dash-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">Record Deposit</div>
            <div className="dash-modal-body">
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                For <strong style={{ color: 'var(--teal)' }}>{depositTargetPatient.full_name}</strong>
              </div>
              {depositError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{depositError}</div>}
              <form id="deposit-form" onSubmit={handleDepositSubmit}>
                <div className="field">
                  <label>Amount (₦) *</label>
                  <input type="number" min="0.01" step="0.01" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} placeholder="e.g. 20000" autoFocus required />
                </div>
                <div className="field">
                  <label>Payment Method *</label>
                  <select value={depositMethod} onChange={e => setDepositMethod(e.target.value)}>
                    <option value="Cash">Cash</option>
                    <option value="POS">POS</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Card">Card</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label>Reference (optional)</label>
                  <input value={depositRef} onChange={e => setDepositRef(e.target.value)} placeholder="transfer ref, POS receipt no." />
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <input value={depositNotes} onChange={e => setDepositNotes(e.target.value)} placeholder="e.g. initial deposit" />
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setDepositTargetPatient(null)} disabled={depositSaving}>Cancel</button>
              <button type="submit" form="deposit-form" className="btn btn-primary" disabled={depositSaving}>{depositSaving ? 'Saving…' : 'Record Deposit'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
