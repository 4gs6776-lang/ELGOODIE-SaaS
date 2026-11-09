import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../../context/AuthContext'
import { HospitalProvider } from '../../context/HospitalContext'
import { supabase } from '../../lib/supabaseClient'
import AppIcon from '../../components/icons'
import RevenueCycle from './RevenueCycle'
import ConnectionState from '../../components/common/ConnectionState'
import TrashIcon from '../../components/icons/TrashIcon'
import SpringToggle from '../../components/SpringToggle'
import { useHospitalBranding } from '../../lib/useHospitalBranding'
import { writeAudit } from '../../lib/audit'
import {
  getTimezone,
  formatWeekdayDate,
  formatTime,
  formatDateTime,
  formatMonthYear,
  dayKeyInZone,
  todayKeyInZone,
} from '../../lib/datetime'
import {
  FULL_ACCESS_ROLES,
  ROLE_LABELS,
  getAccessibleModulesWithDb,
  canWithDb,
} from '../../lib/permissions'
import {
  DEFAULT_REGISTRATION_FEES,
  FOLDER_CATEGORY_LABELS,
  getFeeForCategory,
  formatFee,
} from '../../lib/registrationFees'
import Billing from './Billing'
import Staff from './Staff'
import Appointments from './Appointments'
import {
  useOfflineTable,
  getAllSyncErrors,
  subscribeSyncErrors,
  retryTableQueue,
  skipStuckSyncItem,
} from '../../lib/useOfflineTable';
import Pharmacy from './Pharmacy'
import Laboratory from './Laboratory'
import Radiology from './Radiology'
import Insurance from './Insurance'
import Inventory from './Inventory'
import HmoPatients from './HmoPatients'
import AncPatients from './AncPatients'
import Reports from './Reports'
import Facilities from './Facilities'
import AuditLog from './AuditLog'
import Notifications from './Notifications'
import Settings from './Settings'
import Subscription from './Subscription'
import DoctorWorkbench from './DoctorWorkbench'
import Nursing from './Nursing'
import DutyRoster from './DutyRoster'
import IPD from './IPD'
import Admissions from './Admissions'
import Reception from './Reception'
import PatientProfile from '../../components/PatientProfile'
import Messages from './Messages'
import ShiftHandover from './ShiftHandover'
import AiDiagnostics from './AiDiagnostics'
import DashboardOverview from '../../components/dashboard/DashboardOverview'
import { useMedicationReminders } from '../../hooks/useMedicationReminders'
import { usePagination } from '../../lib/usePagination'
import { useSubscriptionAlerts, getSubscriptionBanner } from '../../lib/useSubscriptionAlerts'
import { getEntitlements, subscribeEntitlements, isModuleAllowedByPlan } from '../../lib/planEntitlements'
import Pagination from '../../components/common/Pagination'

// Same option lists used in Reception's registration form, kept in sync
// so a patient added here has the exact same fields/choices available.
const BLOOD_GROUPS = ['A+','A-','B+','B-','AB+','AB-','O+','O-','Unknown']
const GENOTYPES = ['AA','AS','SS','AC']
const MARITAL_STATUSES = ['Single','Married','Widow','Widower','Divorced']
const RELIGIONS = ['Christianity','Islam','Traditional','Other']
const CATEGORIES = [
  { value: 'personal',  label: 'Personal Folder',  defaultPrice: DEFAULT_REGISTRATION_FEES.personal },
  { value: 'family',    label: 'Family Folder',    defaultPrice: DEFAULT_REGISTRATION_FEES.family },
  { value: 'emergency', label: 'Emergency Folder',  defaultPrice: DEFAULT_REGISTRATION_FEES.emergency },
  { value: 'hmo',       label: 'HMO Folder',        defaultPrice: DEFAULT_REGISTRATION_FEES.hmo },
  { value: 'anc',       label: 'ANC Folder',       defaultPrice: DEFAULT_REGISTRATION_FEES.anc },
]
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

const EMPTY_PATIENT_FORM = {
  surname: '', otherNames: '', phone: '', email: '', gender: '', maritalStatus: '',
  dateOfBirth: '', age: '', bloodGroup: '', genotype: '', nationality: '', stateOfOrigin: '',
  occupation: '', religion: '', category: '', homeAddress: '', ancSpecialPoint: '',
  ancDateOfBooking: '', ancIndication: '', ancLmp: '', ancEdd: '', ancHusbandName: '',
  ancHusbandOccupation: '', ancEmployer: '', nokName: '', nokRelationship: '',
  nokPhone: '', nokAddress: '',
  // Folder registration fee waiver — used by the quick-add form.
  waiveRegistrationFee: false,
  waiveReason: '',
}

function calculatePatientAge(dobStr) {
  if (!dobStr) return ''
  const dob = new Date(dobStr)
  if (Number.isNaN(dob.getTime())) return ''
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
  return age >= 0 ? String(age) : ''
}

const NAV_ITEMS = [
  { key: 'overview', label: 'Dashboard', section: 'Main', icon: 'home' },
  { key: 'appointments', label: 'Appointments', section: 'Main', icon: 'calendar' },
  { key: 'patients', label: 'Patients', section: 'Main', icon: 'users' },
  { key: 'reception', label: 'Reception', section: 'Main', icon: 'reception' },
  { key: 'billing', label: 'Billing & Invoices', section: 'Main', icon: 'billing' },
  { key: 'revenue-cycle', label: 'Revenue Cycle', section: 'Main', icon: 'billing' },
  { key: 'laboratory', label: 'Laboratory', section: 'Main', icon: 'lab' },
  { key: 'pharmacy', label: 'Pharmacy', section: 'Main', icon: 'pharmacy' },
  { key: 'radiology', label: 'Radiology', section: 'Main', icon: 'radiology' },
  { key: 'inventory', label: 'Inventory', section: 'Main', icon: 'inventory' },
  { key: 'hmo-patients', label: 'HMO Patients', section: 'Main', icon: 'insurance' },
  { key: 'anc-patients', label: 'ANC Patients', section: 'Main', icon: 'nurse' },
  { key: 'staff', label: 'Staff', section: 'Operations', icon: 'users' },
  { key: 'doctor', label: 'Doctor Workbench', section: 'Operations', icon: 'doctor' },
  { key: 'nursing', label: 'Nursing / Triage', section: 'Operations', icon: 'nurse' },
  { key: 'handover', label: 'Shift Handover', section: 'Operations', icon: 'handover' },
  { key: 'ipd', label: 'IPD Management', section: 'Operations', icon: 'bed' },
  { key: 'admissions', label: 'Admissions', section: 'Operations', icon: 'bed' },
  { key: 'insurance', label: 'Insurance / HMO', section: 'Operations', icon: 'insurance' },
  { key: 'reports', label: 'Reports', section: 'Operations', icon: 'reports' },
  { key: 'facilities', label: 'Facilities', section: 'Operations', icon: 'building' },
  { key: 'audit-log', label: 'Audit Log', section: 'Operations', icon: 'shield' },
  { key: 'ai-diagnostics', label: 'AI Diagnostics', section: 'Operations', icon: 'activity' },
  { key: 'notifications', label: 'Reminders', section: 'Operations', icon: 'bell' },
  { key: 'roster', label: 'Duty Roster', section: 'Operations', icon: 'calendar' },
  { key: 'messages', label: 'Messages', section: 'Operations', icon: 'chat' },
  { key: 'subscription', label: 'Subscription', section: 'Operations', icon: 'subscription' },
  { key: 'settings', label: 'Settings', section: 'Operations', icon: 'settings' },
]

const PAGE_TITLES = {
  overview: 'Dashboard', patients: 'Patient Management', appointments: 'Appointments',
  billing: 'Billing & Invoices', staff: 'Staff', pharmacy: 'Pharmacy', laboratory: 'Laboratory',
  nursing: 'Nursing / Triage', doctor: 'Doctor Workbench', radiology: 'Radiology',
  insurance: 'Insurance / HMO Claims', inventory: 'Inventory & Supplies', reports: 'Reports & Analytics',
  notifications: 'Reminders & Alerts', settings: 'Settings', ipd: 'IPD Management',
  reception: 'Reception', admissions: 'Admissions', roster: 'Duty Roster', messages: 'Messages',
  handover: 'Shift Handover', subscription: 'Subscription',
}

const COMMON_ACCESS = ['overview', 'roster', 'notifications', 'messages', 'settings']

// Stage 1: role → module access now lives in src/lib/permissions.js
// (single source of truth). The lists moved there unchanged, so every
// role sees exactly the same navigation as before.

function LiveClock({ hospital }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let intervalId
    const msToNextSecond = 1000 - (Date.now() % 1000)
    const timeoutId = setTimeout(() => {
      setNow(new Date())
      intervalId = setInterval(() => setNow(new Date()), 1000)
    }, msToNextSecond)
    return () => {
      clearTimeout(timeoutId)
      if (intervalId) clearInterval(intervalId)
    }
  }, [])

  // Hospital-configured timezone (hospitals.timezone) — falls back to
  // Africa/Lagos, the value the old hardcoded clock used.
  const timezone = getTimezone(hospital)
  const timeStr = useMemo(() => formatTime(now, timezone), [now, timezone])
  const dateStr = useMemo(() => formatWeekdayDate(now, timezone), [now, timezone])

  return (
    <div className="dash-live-clock" title={`Hospital time (${timezone})`}>
      <div className="dash-live-clock-icon"><AppIcon name="clock" size={15} /></div>
      <div className="dash-live-clock-text">
        <div className="dash-live-clock-time"><span key={timeStr} className="dash-clock-tick">{timeStr}</span></div>
        <div className="dash-live-clock-date">{dateStr}</div>
      </div>
    </div>
  )
}

export default function Dashboard(){
  const { profile, hospital, signOut } = useAuth()

  // ---- Hospital branding (dashboard background) ----
  // Reads the hospital_branding row + applies it to the #hospital-bg-overlay
  // div via CSS. This is hospital-level (visible to all staff), not per-user.
  useHospitalBranding()

  // Hospital timezone — every date/time displayed in this file goes
  // through src/lib/datetime.js with this zone (Stage 1 req. #11).
  const hospitalTz = getTimezone(hospital)

  // ---- DB-backed role permissions (RBAC) ----
  // MUST be declared BEFORE allowedKeys which uses it.
  // Wrapped in try-catch so a missing hospital_role_permissions table
  // (migration 067 not run yet) doesn't crash the dashboard.
  let dbRolePerms = []
  try {
    const result = useOfflineTable('hospital_role_permissions', hospital?.id)
    dbRolePerms = result.records || []
  } catch { dbRolePerms = [] }

  // FIX: DB-backed permission checks for patient create/delete.
  // Before this fix, the "Add Patient" button and delete button were
  // only hidden from doctors. Now they respect the admin's DB-configured
  // can_create / can_delete settings for the patients module.
  const canCreatePatient = canWithDb(profile?.role, 'create', 'patients', dbRolePerms)
  const canDeletePatient = canWithDb(profile?.role, 'delete', 'patients', dbRolePerms)

  const allowedKeys = useMemo(() => {
    if (FULL_ACCESS_ROLES.includes(profile?.role)) return null
    // DB-backed: uses the hospital's custom role permissions if they exist,
    // falls back to hardcoded defaults when the DB is empty or a specific
    // role+module row doesn't exist.
    return getAccessibleModulesWithDb(profile?.role, dbRolePerms)
  }, [profile?.role, dbRolePerms])
  // What the hospital's PLAN includes (menu items for modules the plan
  // doesn't include are hidden; existing data is never touched).
  const planEntitlements = useSyncExternalStore(subscribeEntitlements, getEntitlements, getEntitlements)
  // FIX: Normalize nav keys (hyphens → underscores) before checking against
  // allowedKeys. The MODULES array in permissions.js uses underscores
  // (hmo_patients, anc_patients, ai_diagnostics) but NAV_ITEMS uses
  // hyphens (hmo-patients, anc-patients, ai-diagnostics). Without
  // normalization, the .includes() check fails and the menu items
  // are hidden even when the admin granted access.
  const roleNavItems = allowedKeys ? NAV_ITEMS.filter(item => allowedKeys.includes(item.key.replace(/-/g, '_'))) : NAV_ITEMS
  const visibleNavItems = roleNavItems.filter(item => isModuleAllowedByPlan(item.key, planEntitlements))

  // Subscription alerts (banner + bell entries) — hospital ADMIN only,
  // since they are the one who can act on billing. Live-updating.
  const isHospitalAdmin = profile?.role === 'admin'
  const subAlerts = useSubscriptionAlerts(hospital?.id, isHospitalAdmin)

  const [tab, setTab] = useState('overview')
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Theme mode is managed by ThemeContext (ThemeProvider in main.jsx)
  // — the SpringToggle in the header calls toggleMode() from useTheme().

  const [syncErrors, setSyncErrors] = useState([])
  const [syncPanelOpen, setSyncPanelOpen] = useState(false)
  const [syncActionBusy, setSyncActionBusy] = useState(false)

  const [activeMenu, setActiveMenu] = useState(null)
  const headerMenuRef = useRef(null)

  const { records: patients, loading, isOnline, pendingCount, addRecord, deleteRecord } = useOfflineTable('patients', hospital?.id)

  // ---- Medication reminders (blinking red light on Reminders nav item) ----
  const { dueIn2Min, dueNow } = useMedicationReminders(hospital?.id)
  const [reminderToast, setReminderToast] = useState(null)

  // Fire a toast when a medication is due in 2 minutes or right now
  useEffect(() => {
    if (dueIn2Min.length > 0) {
      const first = dueIn2Min[0]
      const msg = `In 2 minutes: give ${first.drug_name} (${first.dosage || ''}) to ${first.patient_name}`
      setReminderToast(msg)
      setTimeout(() => setReminderToast(null), 10000)
    }
  }, [dueIn2Min.length])

  useEffect(() => {
    if (dueNow.length > 0) {
      const first = dueNow[0]
      const msg = `DUE NOW: give ${first.drug_name} (${first.dosage || ''}) to ${first.patient_name}`
      setReminderToast(msg)
      setTimeout(() => setReminderToast(null), 10000)
    }
  }, [dueNow.length])
  
  // NEW: Fetch patient vitals to determine who was attended today
  const { records: vitals } = useOfflineTable('patient_vitals', hospital?.id)

  const [profilePatientId, setProfilePatientId] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY_PATIENT_FORM)
  const [status, setStatus] = useState('stable')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const [todayApptCount, setTodayApptCount] = useState(0)
  const [upcomingApptCount, setUpcomingApptCount] = useState(0)
  const [revenueCollected, setRevenueCollected] = useState(0)
  const [revenueOutstanding, setRevenueOutstanding] = useState(0)
  const [pendingBillCount, setPendingBillCount] = useState(0)
  const [invoicesList, setInvoicesList] = useState([])
  const [weeklyCounts, setWeeklyCounts] = useState([0,0,0,0,0,0,0])
  const [appointments, setAppointments] = useState([])
  const [search, setSearch] = useState('')
  const [patientSearch, setPatientSearch] = useState('')  // dedicated search for the patients tab
  const [searchOpen, setSearchOpen] = useState(false)
  const [deepLinkSearch, setDeepLinkSearch] = useState('')
  const searchBoxRef = useRef(null)
  const searchInputRef = useRef(null)

  // Phones: the collapsed search icon cannot receive focus itself
  // (the input is display:none until expanded), so focus the input
  // right after the sheet expands — covers icon taps and ⌘K/Ctrl+K.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])
  const [pending, setPending] = useState(null)
  const pendingTimeoutRef = useRef(null)
  const pendingIntervalRef = useRef(null)

  const [todayDuty, setTodayDuty] = useState([])
  const [loadingDuty, setLoadingDuty] = useState(true)

  const { records: inventoryItems } = useOfflineTable('inventory_items', hospital?.id)
  const { records: labTests } = useOfflineTable('lab_tests', hospital?.id)
  const { records: allMessages } = useOfflineTable('messages', hospital?.id)

  // ---- Registration fees (folder-prices feature) -------------------
  // Same flow as Reception: when a patient is added via the quick-add
  // form, push a pending billable_charge for the folder fee to the
  // cashier's queue (unless waived). Falls back to hard-coded defaults
  // (DEFAULT_REGISTRATION_FEES) until the admin sets values in Settings.
  const { records: feeRecords } = useOfflineTable('hospital_registration_fees', hospital?.id)
  const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id)
  // dbRolePerms is now declared earlier (before allowedKeys) with a
  // try-catch wrapper so a missing hospital_role_permissions table
  // doesn't crash the dashboard.
  const selectedCategoryFee = getFeeForCategory(form.category, feeRecords)
  const hasRegistrationFee = selectedCategoryFee > 0

  useEffect(() => computeWeeklyCounts(patients), [patients])
  useEffect(() => subscribeSyncErrors(setSyncErrors), [])
  useEffect(() => {
    // FIX: Normalize tab key (hyphens → underscores) for the same reason
    if (allowedKeys && !allowedKeys.includes(tab.replace(/-/g, '_'))) setTab('overview')
    // Also covers deep links (e.g. a reminder pointing at a module the plan lacks).
    else if (!isModuleAllowedByPlan(tab, planEntitlements)) setTab('overview')
  }, [allowedKeys, tab, planEntitlements])

  useEffect(() => {
    function handleClickOutside(e) {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
        setActiveMenu(null)
      }
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
        setSearchOpen(true)
      } else if (e.key === 'Escape') {
        setSearchOpen(false)
        searchInputRef.current?.blur()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  function activateSearch(){
    setSearchOpen(true)
    searchInputRef.current?.focus()
  }

  function handleSearchKeyDown(e){
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activateSearch()
    }
  }

  const stuckTables = useMemo(() => {
    if (!Array.isArray(syncErrors)) return [];
    const groups = {};
    syncErrors.forEach(err => {
      const table = err.table_name || 'Unknown table';
      if (!groups[table]) {
        groups[table] = { table, queueLength: 0, message: err._syncErrorMessage || 'Unknown error' };
      }
      groups[table].queueLength += 1;
    });
    return Object.values(groups);
  }, [syncErrors])

  async function handleRetrySync(table){
    if (!hospital?.id) return
    setSyncActionBusy(true)
    try {
      await retryTableQueue(table)
      setSyncErrors(await getAllSyncErrors())
    } finally {
      setSyncActionBusy(false)
    }
  }

  async function handleSkipStuck(table){
    if (!hospital?.id) return
    if (!confirm(`Discard ALL stuck items for "${table}"?\n\nThese changes will NOT reach the database. The local copies stay on this device marked as discarded, and the rest of the queue can proceed.`)) return
    setSyncActionBusy(true)
    try {
      const errorsToSkip = syncErrors.filter(err => err.table_name === table)
      for (const err of errorsToSkip) {
        await skipStuckSyncItem(err.id)
      }
      setSyncErrors(await getAllSyncErrors())
    } finally {
      setSyncActionBusy(false)
    }
  }

  function computeWeeklyCounts(patientList){
    const counts = [0,0,0,0,0,0,0]
    const now = new Date()
    const sevenDaysAgo = new Date(now)
    sevenDaysAgo.setDate(now.getDate() - 6)
    sevenDaysAgo.setHours(0,0,0,0)

    patientList.forEach(p => {
      const created = new Date(p.created_at)
      if (!Number.isNaN(created.getTime()) && created >= sevenDaysAgo) counts[created.getDay()] += 1
    })
    setWeeklyCounts(counts)
  }

  async function loadOverviewSummary(){
    const todayKey = todayKeyInZone(hospitalTz)

    const { data: apptData } = await supabase.from('appointments').select('*').eq('hospital_id', hospital.id)
    if (apptData) {
      setAppointments(apptData)
      setTodayApptCount(apptData.filter(a => dayKeyInZone(a.appointment_time, hospitalTz) === todayKey).length)
      setUpcomingApptCount(apptData.filter(a => new Date(a.appointment_time) > new Date() && a.status === 'scheduled').length)
    }

    const { data: invData } = await supabase.from('invoices').select('id, invoice_number, patient_name, amount, status, created_at').eq('hospital_id', hospital.id)
    if (invData) {
      setInvoicesList(invData)
      setRevenueCollected(invData.filter(i => i.status === 'paid').reduce((sum,i) => sum + Number(i.amount || 0),0))
      const unpaid = invData.filter(i => i.status === 'unpaid')
      setRevenueOutstanding(unpaid.reduce((sum,i) => sum + Number(i.amount || 0),0))
      setPendingBillCount(unpaid.length)
    }
  }

  async function loadTodayDuty(){
    if (!hospital?.id) return
    setLoadingDuty(true)
    try {
      const now = new Date()
      const month = now.getMonth() + 1
      const year = now.getFullYear()
      const todayKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')

      const { data: roster } = await supabase.from('rosters').select('id').eq('hospital_id', hospital.id).eq('month', month).eq('year', year).is('department', null).maybeSingle()
      if (!roster) { setTodayDuty([]); return }

      const { data: entries } = await supabase.from('roster_entries').select('staff_id, shift_code').eq('roster_id', roster.id).eq('roster_date', todayKey)
      if (!entries || entries.length === 0) { setTodayDuty([]); return }

      const staffIds = entries.map(e => e.staff_id)
      const { data: staffData } = await supabase.from('profiles').select('id, full_name, role').in('id', staffIds)

      const combined = entries.map(e => {
        const staffMember = (staffData || []).find(s => s.id === e.staff_id)
        return staffMember ? { name: staffMember.full_name, role: staffMember.role, shift: e.shift_code } : null
      }).filter(Boolean).filter(e => e.shift && e.shift !== 'OFF')

      setTodayDuty(combined)
    } catch {
      setTodayDuty([])
    } finally {
      setLoadingDuty(false)
    }
  }

  useEffect(() => {
    if (hospital?.id) {
      loadOverviewSummary()
      loadTodayDuty()
    }
  }, [hospital?.id])

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  function setField(field, value) {
    setForm(current => ({ ...current, [field]: value }))
  }

  function handleDobChange(value) {
    setForm(current => ({ ...current, dateOfBirth: value, age: calculatePatientAge(value) }))
  }

  async function handleAdd(e){
    e.preventDefault()
    const surname = form.surname.trim()
    const otherNames = form.otherNames.trim()
    const fullName = `${surname} ${otherNames}`.trim()
    if (!surname) return
    if (!hospital || !profile) {
      showToast('Still loading your account — wait a moment and try again')
      return
    }
    setSaving(true)
    try {
      const isAnc = form.category === 'anc'
      const savedPatient = await addRecord({
        full_name: fullName,
        surname,
        other_names: otherNames || null,
        age: form.age ? parseInt(form.age, 10) : null,
        gender: form.gender || null,
        phone: form.phone?.trim() || null,
        email: form.email?.trim() || null,
        marital_status: form.maritalStatus || null,
        date_of_birth: form.dateOfBirth || null,
        blood_group: form.bloodGroup || null,
        genotype: form.genotype || null,
        nationality: form.nationality?.trim() || null,
        state_of_origin: form.stateOfOrigin || null,
        occupation: form.occupation?.trim() || null,
        religion: form.religion || null,
        category: form.category || null,
        address: form.homeAddress?.trim() || null,
        anc_special_point: isAnc ? form.ancSpecialPoint?.trim() || null : null,
        anc_date_of_booking: isAnc ? form.ancDateOfBooking || null : null,
        anc_indication: isAnc ? form.ancIndication?.trim() || null : null,
        anc_lmp: isAnc ? form.ancLmp || null : null,
        anc_edd: isAnc ? form.ancEdd || null : null,
        anc_husband_name: isAnc ? form.ancHusbandName?.trim() || null : null,
        anc_husband_occupation: isAnc ? form.ancHusbandOccupation?.trim() || null : null,
        anc_employer: isAnc ? form.ancEmployer?.trim() || null : null,
        emergency_contact_name: form.nokName?.trim() || null,
        emergency_contact_phone: form.nokPhone?.trim() || null,
        next_of_kin_relationship: form.nokRelationship?.trim() || null,
        next_of_kin_address: form.nokAddress?.trim() || null,
        status,
        created_by: profile.id,
      })
      setShowModal(false)
      setForm(EMPTY_PATIENT_FORM)
      setStatus('stable')

      // ---- Registration fee → billable_charge ----------------------
      // Mirror of Reception.jsx's flow: charge the folder fee to the
      // cashier's queue unless waived. HMO and unselected categories
      // have fee = 0 and are skipped automatically.
      const folderFee = getFeeForCategory(form.category, feeRecords)
      if (form.category && folderFee > 0) {
        if (form.waiveRegistrationFee) {
          writeAudit({
            hospitalId: hospital.id,
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
              source: 'dashboard_quick_add',
            },
          })
        } else {
          await addBillableCharge({
            hospital_id: hospital.id,
            patient_id: savedPatient?.id || null,
            patient_name: fullName,
            source_module: 'Dashboard',
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
            hospitalId: hospital.id,
            actor: profile,
            action: 'patient.registration_fee_charged',
            entityType: 'patient',
            entityId: savedPatient?.id || null,
            patientId: savedPatient?.id || null,
            summary: `Charged ${FOLDER_CATEGORY_LABELS[form.category] || form.category} registration fee (${formatFee(folderFee)}) for ${fullName} (quick add)`,
            metadata: {
              category: form.category,
              fee_amount: folderFee,
              billable_charge_item: `${FOLDER_CATEGORY_LABELS[form.category] || form.category} Registration Fee`,
              source: 'dashboard_quick_add',
            },
          })
        }
      }

      // Audit trail: record who registered the patient (Stage 1 req. #16).
      writeAudit({
        hospitalId: hospital.id,
        actor: profile,
        action: 'patient.create',
        entityType: 'patient',
        entityId: savedPatient?.id || null,
        summary: `Registered patient ${fullName} (quick add)`,
      })
      showToast(isOnline ? `${fullName} added` : `${fullName} added — will sync when back online`)
    } catch(err){
      showToast(err.message || 'Could not save patient')
    } finally {
      setSaving(false)
    }
  }

  function handleDelete(patient){
    if (pending) commitPendingDelete(pending.patient)
    let secondsLeft = 5
    setPending({patient,secondsLeft})
    pendingIntervalRef.current = setInterval(() => {
      secondsLeft -= 1
      setPending(prev => prev ? {...prev,secondsLeft} : prev)
      if(secondsLeft <= 0) clearInterval(pendingIntervalRef.current)
    },1000)
    pendingTimeoutRef.current = setTimeout(() => commitPendingDelete(patient),5000)
  }

  async function commitPendingDelete(patient){
    clearTimeout(pendingTimeoutRef.current)
    clearInterval(pendingIntervalRef.current)
    setPending(null)
    await deleteRecord(patient.id)
    // Patients are soft-deleted (deleted_at stamped, history kept).
    // Audit it so the archive is traceable (Stage 1 req. #16).
    writeAudit({
      hospitalId: hospital?.id,
      actor: profile,
      action: 'patient.archive',
      entityType: 'patient',
      entityId: patient.id,
      summary: `Archived patient record: ${patient.full_name}`,
      metadata: { soft_delete: true },
    })
  }

  function handleUndo(){
    if(!pending) return
    clearTimeout(pendingTimeoutRef.current)
    clearInterval(pendingIntervalRef.current)
    setPending(null)
    showToast(`${pending.patient.full_name} restored`)
  }

  const displayedPatients = pending ? patients.filter(p => p.id !== pending.patient.id) : patients
  const filteredPatients = displayedPatients.filter(p =>
    !patientSearch.trim() || String(p.full_name || '').toLowerCase().includes(patientSearch.trim().toLowerCase()) ||
    String(p.phone || '').toLowerCase().includes(patientSearch.trim().toLowerCase()) ||
    String(p.patient_id || p.hospital_number || '').toLowerCase().includes(patientSearch.trim().toLowerCase())
  )

  // Global Pagination Rule — the master patient list can grow into the
  // hundreds (or thousands) of records over a hospital's lifetime, so
  // only the current page's rows are rendered into the table. Page size
  // 20 matches Inventory/Pharmacy/Staff; resets to page 1 whenever the
  // search box above changes.
  const {
    pageItems: pagedPatients, currentPage: patientsPage, setCurrentPage: setPatientsPage,
    pageSize: patientsPageSize, setPageSize: setPatientsPageSize,
    totalPages: patientsTotalPages, totalItems: patientsTotalItems,
    startIndex: patientsStart, endIndex: patientsEnd,
  } = usePagination(filteredPatients, { pageSize: 20, resetKey: patientSearch })

  // Global search: live results across patients, appointments, and invoices
  const globalSearchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return { patients: [], appointments: [], invoices: [] }
    return {
      patients: patients.filter(p =>
        String(p.full_name || '').toLowerCase().includes(q) ||
        String(p.phone || '').toLowerCase().includes(q)
      ).slice(0, 5),
      appointments: appointments.filter(a =>
        String(a.patient_name || '').toLowerCase().includes(q) ||
        String(a.doctor_name || '').toLowerCase().includes(q)
      ).slice(0, 5),
      invoices: invoicesList.filter(i =>
        String(i.patient_name || '').toLowerCase().includes(q) ||
        String(i.invoice_number || '').toLowerCase().includes(q)
      ).slice(0, 5),
    }
  }, [search, patients, appointments, invoicesList])
  const globalSearchHasResults =
    globalSearchResults.patients.length + globalSearchResults.appointments.length + globalSearchResults.invoices.length > 0

  function goToSearchResult(kind, item){
    setSearchOpen(false)
    if (kind === 'patient') {
      setTab('patients')
      setSearch(item.full_name || '')
    } else if (kind === 'appointment') {
      setDeepLinkSearch(item.patient_name || '')
      setTab('appointments')
      setSearch('')
    } else if (kind === 'invoice') {
      setDeepLinkSearch(item.patient_name || item.invoice_number || '')
      setTab('billing')
      setSearch('')
    }
  }

  // NEW: Calculate Patients Attended Today
  const patientsSeenToday = useMemo(() => {
    const todayKey = todayKeyInZone(hospitalTz)
    const seenIds = new Set(vitals.filter(v => dayKeyInZone(v.created_at, hospitalTz) === todayKey).map(v => v.patient_id))
    return patients.filter(p => seenIds.has(p.id))
  }, [vitals, patients, hospitalTz])

  function formatMoney(n){
    return '₦' + Number(n || 0).toLocaleString('en-NG',{minimumFractionDigits:0})
  }

  function appointmentName(a){
    return a.patient_name || a.patient || a.full_name || a.name || 'Patient'
  }

  function appointmentReason(a){
    return a.department || a.reason || a.type || a.service || 'General Consultation'
  }

  const lowStockItems = useMemo(() => {
    return (inventoryItems || []).filter(i => {
      const qty = Number(i.quantity)
      const reorder = Number(i.reorder_level ?? 10)
      return !Number.isNaN(qty) && qty <= reorder
    })
  }, [inventoryItems])

  const isSameDay = (a, b) => {
    if (!a || !b) return false
    return dayKeyInZone(a, hospitalTz) === dayKeyInZone(b, hospitalTz)
  }

  const readyLabTests = useMemo(() => {
    const today = new Date()
    return (labTests || [])
      .filter(t => t.status === 'completed' && isSameDay(t.completed_at || t.updated_at, today))
      .sort((a,b) => new Date(b.completed_at || b.updated_at) - new Date(a.completed_at || a.updated_at))
  }, [labTests])

  const notificationItems = useMemo(() => {
    const items = []
    if (lowStockItems.length > 0) {
      const names = lowStockItems.slice(0,2).map(i => i.name).filter(Boolean).join(', ')
      items.push({
        icon: <AppIcon name="alert" size={13} style={{ color: 'var(--warning)' }} />,
        text: <>Low stock: <strong>{lowStockItems.length} item{lowStockItems.length === 1 ? '' : 's'}</strong>{names ? ` (${names}${lowStockItems.length > 2 ? '…' : ''})` : ''} need reordering.</>,
      })
    }
    readyLabTests.slice(0,3).forEach(t => {
      items.push({ icon: <AppIcon name="lab" size={13} style={{ color: 'var(--violet)' }} />, text: <>Lab result ready for <strong>{t.patient_name || 'patient'}</strong> ({t.test_name || 'test'}).</> })
    })
    if (todayApptCount > 0) {
      items.push({ icon: <AppIcon name="calendar" size={13} style={{ color: 'var(--blue)' }} />, text: <><strong>{todayApptCount}</strong> appointment{todayApptCount === 1 ? '' : 's'} scheduled for today.</> })
    }

    // Unread subscription notifications go FIRST (admin only — the hook
    // returns an empty list for everyone else). Clicking one marks it
    // read and opens the Subscription page.
    const subItems = (subAlerts.notifications || []).map(n => ({
      icon: <AppIcon name="subscription" size={13} style={{ color: n.severity === 'critical' ? 'var(--danger)' : n.severity === 'warning' ? 'var(--warning)' : 'var(--teal)' }} />,
      text: <><strong>{n.title}</strong>{n.body ? ` — ${n.body}` : ''}</>,
      onClick: () => { subAlerts.markRead(n.id); setTab('subscription'); setActiveMenu(null) },
    }))
    return [...subItems, ...items]
  }, [lowStockItems, readyLabTests, todayApptCount, subAlerts.notifications, subAlerts.markRead])

  // Top-of-page subscription banner (admin only). Describes the status
  // stored in the database; never decides it. "Days left" uses the
  // hospital's own timezone.
  const subBanner = isHospitalAdmin ? getSubscriptionBanner(subAlerts.subscription, todayKeyInZone(hospitalTz)) : null

  // ---- TRUE unread message count (per-user read tracking) -----------
  // Replaces the old "messages from others in the last 24h" heuristic.
  // Uses the message_channel_reads table (migration 033) which records
  // when the current user last opened each channel.
  //
  // The Messages page computes the actual count (since it already loads
  // both messages and read states). It broadcasts via a window event so
  // the Dashboard bell can pick it up without prop drilling. We default
  // to a re-computed value here using just the messages table as a
  // fallback — the moment the user opens Messages, the count gets
  // replaced by the accurate value from the event.
  const { records: myReadStates } = useOfflineTable('message_channel_reads', hospital?.id)
  const [unreadMessageCount, setUnreadMessageCount] = useState(0)

  // Recompute the count locally — gives a sensible default before the
  // user opens the Messages page (or if they never do).
  const computedUnreadCount = useMemo(() => {
    if (!profile?.id) return 0
    const myReads = new Map()
    for (const r of myReadStates) {
      if (r.user_id === profile.id) {
        myReads.set(`${r.channel_type}|${r.channel_key}`, new Date(r.last_read_at).getTime())
      }
    }
    let count = 0
    for (const m of allMessages || []) {
      if (m.sender_id === profile.id) continue
      if (m.channel_type !== 'department' && m.channel_type !== 'dm') continue
      if (m.channel_type === 'dm') {
        const ids = (m.channel_key || '').split('__')
        if (!ids.includes(profile.id)) continue
      }
      const lastRead = myReads.get(`${m.channel_type}|${m.channel_key}`) || 0
      if (new Date(m.created_at).getTime() > lastRead) count++
    }
    return count
  }, [allMessages, myReadStates, profile?.id])

  // Listen for the live update event from the Messages page. When it
  // fires, replace the local computed value with the accurate one.
  useEffect(() => {
    function onUnreadUpdate(e) {
      if (e?.detail && typeof e.detail.count === 'number') {
        setUnreadMessageCount(e.detail.count)
      }
    }
    window.addEventListener('gmed:messages-unread', onUnreadUpdate)
    return () => window.removeEventListener('gmed:messages-unread', onUnreadUpdate)
  }, [])

  // Use the event-sourced value if it's been set (> 0 OR if we've
  // ever received an event); otherwise fall back to the locally computed
  // value. We use a ref-style approach: track whether the event has
  // ever fired.
  const unreadMessageCountRef = useRef(false)
  useEffect(() => {
    if (computedUnreadCount !== null) {
      // The event hasn't fired yet — use the locally computed value.
      if (!unreadMessageCountRef.current) {
        setUnreadMessageCount(computedUnreadCount)
      }
    }
  }, [computedUnreadCount])
  useEffect(() => {
    function markFired() { unreadMessageCountRef.current = true }
    window.addEventListener('gmed:messages-unread', markFired, { once: true })
    return () => window.removeEventListener('gmed:messages-unread', markFired)
  }, [])

  // Final value: prefer the event-sourced count once the event has
  // fired, otherwise the locally-computed default.
  const recentMessageCount = unreadMessageCountRef.current ? unreadMessageCount : computedUnreadCount

  // ---- TRUE unread count for the bell badge ------------------------
  // Only counts: (1) unread subscription alerts + (2) unread messages.
  // Status info like low stock, ready labs, today's appointments stay
  // in the popover (so users still see them when they click the bell),
  // but they no longer inflate the badge count.
  const trueUnreadCount = useMemo(() => {
    const subUnread = (subAlerts.notifications || []).length
    return subUnread + recentMessageCount
  }, [subAlerts.notifications, recentMessageCount])

  const upcoming = appointments
    .filter(a => {
      const d = new Date(a.appointment_time)
      return !Number.isNaN(d.getTime()) && d >= new Date()
    })
    .sort((a,b) => new Date(a.appointment_time) - new Date(b.appointment_time))
    .slice(0,5)

  // Smooth Catmull-Rom spline through a set of points — used for the patient trend chart
  function smoothPath(points){
    if (points.length < 2) return ''
    let d = `M ${points[0].x} ${points[0].y}`
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? i : i - 1]
      const p1 = points[i]
      const p2 = points[i + 1]
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
      const cp1x = p1.x + (p2.x - p0.x) / 6
      const cp1y = p1.y + (p2.y - p0.y) / 6
      const cp2x = p2.x - (p3.x - p1.x) / 6
      const cp2y = p2.y - (p3.y - p1.y) / 6
      d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
    }
    return d
  }

  // Real patient-registration & appointment-visit trend for the current month
  const patientTrend = useMemo(() => {
    const now = new Date()
    const year = now.getFullYear(), month = now.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const newByDay = new Array(daysInMonth + 1).fill(0)
    const returningByDay = new Array(daysInMonth + 1).fill(0)

    patients.forEach(p => {
      const d = new Date(p.created_at)
      if (d.getFullYear() === year && d.getMonth() === month) newByDay[d.getDate()] += 1
    })
    appointments.forEach(a => {
      const d = new Date(a.appointment_time)
      if (d.getFullYear() === year && d.getMonth() === month) returningByDay[d.getDate()] += 1
    })

    const rawMax = Math.max(1, ...newByDay, ...returningByDay)
    const niceMax = Math.max(4, Math.ceil(rawMax / 4) * 4)
    const chartLeft = 35, chartRight = 610, chartBottom = 225, chartTop = 40, baselineY = 237

    const xFor = day => chartLeft + ((day - 1) / (daysInMonth - 1 || 1)) * (chartRight - chartLeft)
    const yFor = value => baselineY - (value / niceMax) * (baselineY - chartTop)

    const newPoints = []
    const returningPoints = []
    for (let day = 1; day <= daysInMonth; day++) {
      newPoints.push({ x: xFor(day), y: yFor(newByDay[day]) })
      returningPoints.push({ x: xFor(day), y: yFor(returningByDay[day]) })
    }

    const newLine = smoothPath(newPoints)
    const returningLine = smoothPath(returningPoints)
    const newArea = `${newLine} L${chartRight} ${chartBottom} L${chartLeft} ${chartBottom} Z`
    const returningArea = `${returningLine} L${chartRight} ${chartBottom} L${chartLeft} ${chartBottom} Z`

    const tickDays = [...new Set([1, 5, 10, 15, 20, 25, daysInMonth].filter(d => d <= daysInMonth))]
    const monthLabel = formatMonthYear(now, hospitalTz).split(' ')[0]
    const xLabels = tickDays.map(d => `${monthLabel} ${d}`)
    const yLabels = [niceMax, niceMax * 0.75, niceMax * 0.5, niceMax * 0.25, 0]

    return { newLine, returningLine, newArea, returningArea, xLabels, yLabels }
  }, [patients, appointments, hospitalTz])

  // Real department activity from the appointment records already loaded by the
  // offline-first table. This replaces the old patient-folder breakdown so the
  // dashboard now matches the reference's clinical department view without
  // introducing mock statistics or a second data source.
  const departmentBreakdown = useMemo(() => {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth()
    const palette = [
      'var(--violet)',
      'var(--teal)',
      'var(--gold)',
      'var(--blue)',
      'var(--success)',
      'var(--danger)',
    ]
    const counts = new Map()

    appointments.forEach(a => {
      const d = new Date(a.appointment_time)
      if (Number.isNaN(d.getTime()) || d.getFullYear() !== year || d.getMonth() !== month) return
      const raw = a.department || a.specialty || a.service || a.reason || a.type || 'Other'
      const label = String(raw).trim() || 'Other'
      counts.set(label, (counts.get(label) || 0) + 1)
    })

    const sorted = [...counts.entries()].sort((a,b) => b[1] - a[1])
    const top = sorted.slice(0, 5)
    const otherCount = sorted.slice(5).reduce((sum, [, count]) => sum + count, 0)
    if (otherCount > 0) top.push(['Other', otherCount])

    const total = top.reduce((sum, [, count]) => sum + count, 0)
    const rows = top.map(([label, count], index) => ({
      key: `${label}-${index}`,
      label,
      color: palette[index % palette.length],
      count,
      pct: total ? (count / total) * 100 : 0,
    }))

    let cumulative = 0
    const gradientStops = rows.map(r => {
      const start = cumulative
      cumulative += r.pct
      return `${r.color} ${start.toFixed(1)}% ${cumulative.toFixed(1)}%`
    }).join(', ')

    return {
      rows,
      total,
      gradientStops: gradientStops || 'rgba(0,199,199,.16) 0% 4%, rgba(148,163,184,.10) 4% 100%',
    }
  }, [appointments])

  // Real daily paid-invoice revenue for the current month
  const revenueTrend = useMemo(() => {
    const now = new Date()
    const year = now.getFullYear(), month = now.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const byDay = new Array(daysInMonth + 1).fill(0)

    invoicesList.forEach(inv => {
      if (inv.status !== 'paid') return
      const d = new Date(inv.created_at)
      if (d.getFullYear() === year && d.getMonth() === month) byDay[d.getDate()] += Number(inv.amount || 0)
    })

    const thisMonthTotal = byDay.reduce((a,b) => a+b, 0)
    const lastMonthDate = new Date(year, month - 1, 1)
    const lastMonthTotal = invoicesList
      .filter(inv => inv.status === 'paid')
      .filter(inv => {
        const d = new Date(inv.created_at)
        return d.getFullYear() === lastMonthDate.getFullYear() && d.getMonth() === lastMonthDate.getMonth()
      })
      .reduce((sum, inv) => sum + Number(inv.amount || 0), 0)

    const changePct = lastMonthTotal > 0 ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100 : null
    const max = Math.max(1, ...byDay.slice(1))
    const bars = byDay.slice(1).map(v => Math.max(2, (v / max) * 100))
    const tickDays = [1, 8, 15, 22, daysInMonth].filter((d,i,arr) => arr.indexOf(d) === i && d <= daysInMonth)
    const monthLabel = formatMonthYear(now, hospitalTz).split(' ')[0]

    return { bars, thisMonthTotal, changePct, xLabels: tickDays.map(d => `${monthLabel} ${d}`) }
  }, [invoicesList, hospitalTz])

  // Most recently registered patients, for the Recent Patients panel
  const recentPatients = useMemo(() => {
    return [...patients]
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 6)
  }, [patients])

  function initials(name){
    return String(name || '?').trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase()
  }

  if(profile?.role === 'owner'){
    window.location.href = '/owner'
    return null
  }

  if(profile && profile.active === false){
    return (
      <div className="dash-account-state">
        <div className="card">
          <div className="dash-state-title">Account deactivated</div>
          <div className="dash-state-text">
            Your access has been deactivated by an administrator at {hospital?.name || 'your hospital'}. Contact them if you believe this is a mistake.
          </div>
          <button className="btn btn-ghost" onClick={signOut}>Sign Out</button>
        </div>
      </div>
    )
  }

  if(hospital && hospital.status !== 'active'){
    return (
      <div className="dash-account-state">
        <div className="card">
          <div className="dash-state-title">
            {hospital.status === 'pending' ? 'Account pending approval' : 'Account suspended'}
          </div>
          <div className="dash-state-text">
            {hospital.status === 'pending'
              ? "Your hospital's account is being reviewed. You'll be able to log in fully once it's approved."
              : 'Please contact the platform administrator for help.'}
          </div>
          <button className="btn btn-ghost" onClick={signOut}>Sign Out</button>
        </div>
      </div>
    )
  }

  let currentSection = null

  return (
    <HospitalProvider>
    <div className="dash-shell">
      {/* Hospital branding background overlay — fixed, behind everything,
          pointer-events:none so it never blocks clicks. Brightness/opacity
          are applied to this div ONLY, never to dashboard content. */}
      <div
        id="hospital-bg-overlay"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          display: 'none',  // hidden by default — useHospitalBranding enables it
          transition: 'opacity 0.3s ease',
        }}
      />
      <div className={`dash-overlay ${drawerOpen ? 'show' : ''}`} onClick={() => setDrawerOpen(false)} />

      <aside className={`dash-sidebar ${drawerOpen ? 'open' : ''}`}>
        <div className="dash-brand">
          {hospital?.logo_url ? (
            <img src={hospital.logo_url} alt={hospital?.name || 'Hospital'} style={{ maxWidth: 40, maxHeight: 40, borderRadius: 8, objectFit: 'contain', flexShrink: 0 }} />
          ) : (
            <div className="dash-brand-mark">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.8 8.6c0 5-6.2 9.4-8.3 10.8a1 1 0 0 1-1 0C9.4 18 3.2 13.6 3.2 8.6a4.9 4.9 0 0 1 8.8-3 4.9 4.9 0 0 1 8.8 3Z"/>
                <path d="M4 12h3l1.5-3L11 15l1.8-6L14 12h6"/>
              </svg>
            </div>
          )}
          <div>
            <div className="dash-brand-name">{hospital?.name || 'Loading…'}</div>
            <div className="dash-brand-sub">G-MedHub</div>
          </div>
        </div>

        <nav className="dash-nav">
          {visibleNavItems.map((item,i) => {
            const showLabel = item.section !== currentSection
            currentSection = item.section
            return (
              <div key={i}>
                {showLabel && <div className="dash-nav-label">{item.section}</div>}
                <button
                  type="button"
                  className={`dash-nav-item ${tab === item.key ? 'active' : ''}`}
                  onClick={() => { setTab(item.key); setDrawerOpen(false) }}
                  aria-current={tab === item.key ? 'page' : undefined}
                >
                  <AppIcon name={item.icon} size={17}/>
                  <span>{item.label}</span>
                  {item.key === 'notifications' && (dueIn2Min.length > 0 || dueNow.length > 0) && (
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: 'var(--danger)',
                      display: 'inline-block', marginLeft: 'auto',
                      animation: 'gmedhub-blink 1s ease-in-out infinite alternate',
                      boxShadow: '0 0 6px var(--danger)',
                    }} />
                  )}
                </button>
              </div>
            )
          })}
        </nav>

        <div className="dash-emergency">
          <div className="dash-emergency-head">
            <span>Emergency Line</span>
            <AppIcon name="phone" size={15}/>
          </div>
          <strong>{hospital?.phone || '+2348148364233'}</strong>
          <span className="dash-emergency-name">{hospital?.emergency_contact_name || 'G-MedHub'}</span>
          <small>24/7 Available</small>
        </div>
        
        <div className="dash-foot">
          <div className="dash-foot-user">
            <div className="dash-foot-avatar">
              {(profile?.full_name || 'D').charAt(0).toUpperCase()}
            </div>
            <div className="dash-foot-user-info">
              <div className="dash-foot-name">{profile?.full_name || 'Administrator'}</div>
              <div className="dash-foot-role">{ROLE_LABELS[profile?.role] || 'Staff'}</div>
            </div>
            <button className="dash-icon-btn dash-foot-signout" onClick={signOut} title="Sign out">
              <AppIcon name="power" size={16}/>
            </button>
          </div>
        </div>
      </aside>

      <main className="dash-main">
        {/* Top Header Bar */}
        <header className="dash-topbar">
          <button
            type="button"
            className="dash-burger"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
          >
            <AppIcon name="menu" size={21}/>
          </button>

          <div
            className={`dash-search ${searchOpen ? 'is-open' : ''}`}
            ref={searchBoxRef}
            aria-expanded={searchOpen}
            tabIndex={0}
            aria-label="Search patients, invoices, appointments"
            onClick={activateSearch}
            onKeyDown={handleSearchKeyDown}
          >
            <AppIcon name="search" size={17}/>
            <input
              ref={searchInputRef}
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchOpen(true) }}
              onFocus={() => setSearchOpen(true)}
              aria-label="Search patients, invoices and appointments"
              placeholder="Search patients, invoices, appointments..."
            />
            <kbd>⌘ K</kbd>

            {searchOpen && search.trim() && (
              <div className="dash-search-results">
                {globalSearchHasResults ? (
                  <>
                    {globalSearchResults.patients.length > 0 && (
                      <div className="dash-search-group">
                        <div className="dash-search-group-label">Patients</div>
                        {globalSearchResults.patients.map(p => (
                          <button key={p.id} className="dash-search-result" onClick={() => goToSearchResult('patient', p)}>
                            <AppIcon name="users" size={14}/>
                            <span>{p.full_name}</span>
                            {p.phone && <span className="dash-search-result-meta">{p.phone}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {globalSearchResults.appointments.length > 0 && (
                      <div className="dash-search-group">
                        <div className="dash-search-group-label">Appointments</div>
                        {globalSearchResults.appointments.map(a => (
                          <button key={a.id} className="dash-search-result" onClick={() => goToSearchResult('appointment', a)}>
                            <AppIcon name="calendar" size={14}/>
                            <span>{a.patient_name}</span>
                            {a.doctor_name && <span className="dash-search-result-meta">Dr. {a.doctor_name}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {globalSearchResults.invoices.length > 0 && (
                      <div className="dash-search-group">
                        <div className="dash-search-group-label">Invoices</div>
                        {globalSearchResults.invoices.map(i => (
                          <button key={i.id} className="dash-search-result" onClick={() => goToSearchResult('invoice', i)}>
                            <AppIcon name="billing" size={14}/>
                            <span>{i.patient_name || i.invoice_number || 'Invoice'}</span>
                            <span className="dash-search-result-meta">₦{Number(i.amount || 0).toLocaleString()}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="dash-search-empty">No matches for "{search.trim()}"</div>
                )}
              </div>
            )}
          </div>

          {/* Interactive Actions Icons & Popovers */}
          <div className="dash-top-actions" ref={headerMenuRef} style={{ position: 'relative' }}>

            {/* Live connection/sync truth (Stage 1 req. #14) */}
            <ConnectionState
              isOnline={isOnline}
              pendingCount={pendingCount}
              failedCount={syncErrors.length}
              onRetry={async () => {
                if (syncErrors.length > 0) {
                  setSyncPanelOpen(v => !v)
                } else {
                  await retryTableQueue()
                }
              }}
            />

            <LiveClock hospital={hospital} />

            {/* Theme Toggle — glassmorphic SpringToggle (light/dark mode).
                Redesigned to NOT cause the reload loop the old version had.
                Reads from React context, no DOM MutationObserver. */}
            <SpringToggle />

            {/* 2. Notifications Bell Popover */}
            <div style={{ position: 'relative' }}>
              <button 
                className="dash-icon-btn dash-notify" 
                title="Notifications"
                onClick={() => setActiveMenu(activeMenu === 'notifs' ? null : 'notifs')}
              >
                <AppIcon name="bell" size={18}/>
                {trueUnreadCount > 0 && <span>{trueUnreadCount > 9 ? '9+' : trueUnreadCount}</span>}
              </button>

              {activeMenu === 'notifs' && (
                <div className="dash-popover-menu">
                  <div className="dash-popover-header">
                    Notifications {trueUnreadCount > 0 ? `(${trueUnreadCount} unread)` : ''}
                  </div>
                  {(subAlerts.notifications || []).length > 0 && (
                    <button className="dash-view-all" style={{ margin: '4px 14px 0' }} onClick={subAlerts.markAllRead}>
                      Mark subscription alerts as read
                    </button>
                  )}
                  <div className="dash-popover-body">
                    {notificationItems.length > 0 ? notificationItems.map((n, i) => (
                      <div
                        className="dash-popover-item"
                        key={i}
                        onClick={n.onClick}
                        style={n.onClick ? { cursor: 'pointer' } : undefined}
                      >{n.icon} {n.text}</div>
                    )) : (
                      <div className="dash-popover-item" style={{ color: 'var(--muted)' }}>You're all caught up — nothing needs attention right now.</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 3. Messages */}
            <button
              className="dash-icon-btn dash-notify dash-message"
              title="Messages"
              onClick={() => { setTab('messages'); setActiveMenu(null) }}
            >
              <AppIcon name="chat" size={18}/>
              {recentMessageCount > 0 && <span>{recentMessageCount > 9 ? '9+' : recentMessageCount}</span>}
            </button>

            <div className="dash-hospital-selector">
              <AppIcon name="building" size={17}/>
              <span>{hospital?.name || 'Your Hospital'}</span>
              <span className="dash-chevron"><AppIcon name="arrowDown" size={13}/></span>
            </div>
          </div>
        </header>

        <div className="dash-content">
          {subBanner && tab !== 'subscription' && (
            <div
              className="dash-sync-alert"
              style={subBanner.tone === 'critical' ? undefined : { borderColor: 'rgba(201,169,97,0.35)', background: 'rgba(201,169,97,0.12)' }}
            >
              <div>
                <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: subBanner.tone === 'critical' ? 'var(--danger)' : 'var(--gold)' }}>
                  <AppIcon name="alert" size={14} /> {subBanner.title}
                </strong>
                <span>{subBanner.text}{!isOnline ? ' (offline — showing last verified status)' : ''}</span>
              </div>
              <button
                onClick={() => setTab('subscription')}
                style={subBanner.tone === 'critical' ? undefined : { borderColor: 'rgba(201,169,97,0.4)', color: 'var(--gold)' }}
              >
                View
              </button>
            </div>
          )}

          {stuckTables.length > 0 && (
            <div className="dash-sync-alert">
              <div>
                <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <AppIcon name="alert" size={14} /> Sync needs attention
                </strong>
                <span>{stuckTables.length} table{stuckTables.length > 1 ? 's' : ''} {stuckTables.length === 1 ? 'has' : 'have'} pending records.</span>
              </div>
              <button onClick={() => setSyncPanelOpen(v => !v)}>Review</button>
            </div>
          )}

          {syncPanelOpen && stuckTables.length > 0 && (
            <div className="dash-sync-panel">
              <div className="dash-panel-title">Sync queue</div>
              {stuckTables.map(err => (
                <div className="dash-sync-item" key={err.table}>
                  <div>
                    <strong>{err.table}</strong>
                    <small>{err.queueLength} item{err.queueLength === 1 ? '' : 's'} waiting</small>
                    <code>{err.message}</code>
                  </div>
                  <div>
                    <button className="btn btn-ghost" disabled={syncActionBusy} onClick={() => handleRetrySync(err.table)}>Retry</button>
                    <button className="btn btn-ghost dash-danger-btn" disabled={syncActionBusy} onClick={() => handleSkipStuck(err.table)}>Skip</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'overview' && (
            <DashboardOverview hospital={hospital} profile={profile} />
          )}

                    {/* Other tab routing components */}
          {tab === 'appointments' && <Appointments initialSearch={deepLinkSearch}/>}
          {tab === 'patients' && (
            profilePatientId ? (
              <PatientProfile
                patientId={profilePatientId}
                patient={patients.find(p => p.id === profilePatientId)}
                onClose={() => setProfilePatientId(null)}
              />
            ) : (
              <>
                {/* NEW: ATTENDED TODAY SECTION */}
                {patientsSeenToday.length > 0 && (
                  <div className="dash-panel" style={{ marginBottom: 16, borderColor: 'var(--teal)' }}>
                    <div className="dash-panel-head">
                      <div>
                        <div className="dash-panel-title" style={{ color: 'var(--teal)', fontSize: 14 }}>Attended Today ({patientsSeenToday.length})</div>
                        <div className="dash-panel-sub">Quick access to patients seen today</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, padding: '0 16px 16px', flexWrap: 'wrap' }}>
                      {patientsSeenToday.map(p => (
                        <button
                          type="button"
                          key={p.id}
                          className="dash-chip-btn"
                          onClick={() => setProfilePatientId(p.id)}
                        >
                          {p.full_name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="dash-panel">
                  <div className="dash-panel-head dash-panel-head-wrap">
                    <div>
                      <div className="dash-panel-title">All Patients</div>
                      <div className="dash-panel-sub">{hospital?.name || 'your hospital'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div className="dash-search" style={{ minWidth: 200, maxWidth: 300 }}>
                        <AppIcon name="search" size={15} />
                        <input
                          placeholder="Search patient name…"
                          value={patientSearch}
                          onChange={e => setPatientSearch(e.target.value)}
                        />
                      </div>
                      {canCreatePatient && (
                        <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => setShowModal(true)}>+ Add Patient</button>
                      )}
                    </div>
                  </div>

                  {loading ? (
                    <div className="dash-empty-state">Loading…</div>
                  ) : filteredPatients.length === 0 ? (
                    <div className="dash-empty-state">
                      {patientSearch.trim() ? `No patients match "${patientSearch}".` : 'No patients yet. Add your first one above.'}
                    </div>
                  ) : (
                    <>
                      <div className="dash-table-wrap">
                        <table className="dash-full-table">
                          <thead><tr><th>Name</th><th>Age</th><th>Status</th><th>Registered</th><th></th></tr></thead>
                          <tbody>
                            {pagedPatients.map(p => (
                              <tr key={p.id}>
                                <td onClick={() => setProfilePatientId(p.id)} style={{ cursor: 'pointer', fontWeight: 700 }}>{p.full_name}</td>
                                <td>{p.age}</td>
                                <td><span className={`dash-status ${p.status === 'review' ? 'review' : 'stable'}`}>{p.status === 'review' ? 'In Review' : 'Stable'}</span></td>
                                <td style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDateTime(p.created_at, hospitalTz)}</td>
                                <td>{canDeletePatient ? <button className="dash-delete" onClick={() => handleDelete(p)} title="Delete"><TrashIcon size={13}/></button> : null}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <Pagination
                        currentPage={patientsPage}
                        totalPages={patientsTotalPages}
                        totalItems={patientsTotalItems}
                        startIndex={patientsStart}
                        endIndex={patientsEnd}
                        pageSize={patientsPageSize}
                        onPageChange={setPatientsPage}
                        onPageSizeChange={setPatientsPageSize}
                        itemLabel="patients"
                      />
                    </>
                  )}
                </div>
              </>
            )
          )}
          {tab === 'reception' && <Reception />}
          {tab === 'hmo-patients' && <HmoPatients />}
          {tab === 'anc-patients' && <AncPatients />}
          {tab === 'billing' && <Billing initialSearch={deepLinkSearch}/>}
          {tab === 'revenue-cycle' && <RevenueCycle />}
          {tab === 'laboratory' && <Laboratory />}
          {tab === 'pharmacy' && <Pharmacy />}
          {tab === 'radiology' && <Radiology />}
          {tab === 'inventory' && <Inventory />}
          {tab === 'staff' && <Staff />}
          {tab === 'doctor' && <DoctorWorkbench />}
          {tab === 'nursing' && <Nursing />}
          {tab === 'ipd' && <IPD />}
          {tab === 'admissions' && <Admissions />}
          {tab === 'handover' && <ShiftHandover />}
          {tab === 'insurance' && <Insurance />}
          {tab === 'reports' && <Reports />}
          {tab === 'facilities' && <Facilities />}
          {tab === 'audit-log' && <AuditLog />}
          {tab === 'ai-diagnostics' && <AiDiagnostics onClose={() => setTab('overview')} />}
          {tab === 'notifications' && <Notifications />}
          {tab === 'roster' && <DutyRoster />}
          {tab === 'messages' && <Messages />}
          {tab === 'subscription' && <Subscription />}
          {tab === 'settings' && <Settings />}

        </div>
      </main>

      {showModal && (
        <div className="dash-modal-backdrop">
          <div className="card dash-modal">
            <div className="dash-modal-title">Register Patient</div>
            <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
              <div className="dash-modal-body">
                <div className="dash-field-grid">
                  <div className="field"><label>Surname</label><input value={form.surname} onChange={e => setField('surname', e.target.value)} placeholder="e.g. Okafor"/></div>
                  <div className="field"><label>Other Names</label><input value={form.otherNames} onChange={e => setField('otherNames', e.target.value)} placeholder="e.g. Chinedu"/></div>

                  <div className="field"><label>Phone</label><input value={form.phone} onChange={e => setField('phone', e.target.value)} placeholder="e.g. 08012345678"/></div>
                  <div className="field"><label>Email</label><input type="email" value={form.email} onChange={e => setField('email', e.target.value)} placeholder="optional"/></div>

                  <div className="field">
                    <label>Gender</label>
                    <select value={form.gender} onChange={e => setField('gender', e.target.value)}>
                      <option value="">—</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Marital Status</label>
                    <select value={form.maritalStatus} onChange={e => setField('maritalStatus', e.target.value)}>
                      <option value="">—</option>
                      {MARITAL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div className="field"><label>Date of Birth</label><input type="date" value={form.dateOfBirth} onChange={e => handleDobChange(e.target.value)}/></div>
                  <div className="field"><label>Age</label><input value={form.age} readOnly placeholder="Auto-calculated" style={{ opacity: 0.75 }}/></div>

                  <div className="field">
                    <label>Blood Group</label>
                    <select value={form.bloodGroup} onChange={e => setField('bloodGroup', e.target.value)}>
                      <option value="">—</option>
                      {BLOOD_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Genotype</label>
                    <select value={form.genotype} onChange={e => setField('genotype', e.target.value)}>
                      <option value="">—</option>
                      {GENOTYPES.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>

                  <div className="field">
                    <label>Nationality</label>
                    <select value={form.nationality} onChange={e => setField('nationality', e.target.value)}>
                      <option value="">—</option>
                      {AFRICAN_COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>State of Origin</label>
                    <select value={form.stateOfOrigin} onChange={e => setField('stateOfOrigin', e.target.value)}>
                      <option value="">—</option>
                      {NIGERIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div className="field"><label>Occupation</label><input value={form.occupation} onChange={e => setField('occupation', e.target.value)} placeholder="e.g. Trader"/></div>
                  <div className="field">
                    <label>Religion</label>
                    <select value={form.religion} onChange={e => setField('religion', e.target.value)}>
                      <option value="">—</option>
                      {RELIGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>

                  <div className="field">
                    <label>Category / Folder</label>
                    <select value={form.category} onChange={e => setField('category', e.target.value)}>
                      <option value="">—</option>
                      {CATEGORIES.map(c => {
                        const fee = getFeeForCategory(c.value, feeRecords)
                        return <option key={c.value} value={c.value}>{c.label} — {formatFee(fee)}</option>
                      })}
                    </select>
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
                    {hasRegistrationFee && (
                      <div style={{ marginTop: 10 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ivory)', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={form.waiveRegistrationFee}
                            onChange={e => setField('waiveRegistrationFee', e.target.checked)}
                            style={{ width: 16, height: 16, accentColor: 'var(--teal)' }}
                          />
                          Waive registration fee
                        </label>
                        {form.waiveRegistrationFee && (
                          <input
                            value={form.waiveReason}
                            onChange={e => setField('waiveReason', e.target.value)}
                            placeholder="Reason for waiver (required) — e.g. staff family, charity case"
                            style={{ marginTop: 8, fontSize: 12.5 }}
                            required
                          />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <label>Status</label>
                    <select value={status} onChange={e => setStatus(e.target.value)}>
                      <option value="stable">Stable</option>
                      <option value="review">In Review</option>
                    </select>
                  </div>
                </div>

                <div className="field"><label>Home Address</label><input value={form.homeAddress} onChange={e => setField('homeAddress', e.target.value)} placeholder="e.g. 12 Aba Road, Port Harcourt"/></div>

                {form.category === 'anc' && (
                  <>
                    <div className="dash-modal-title" style={{ fontSize: 14, marginTop: 6 }}>ANC Details</div>
                    <div className="dash-field-grid">
                      <div className="field"><label>Special Point</label><input value={form.ancSpecialPoint} onChange={e => setField('ancSpecialPoint', e.target.value)}/></div>
                      <div className="field"><label>Date of Booking</label><input type="date" value={form.ancDateOfBooking} onChange={e => setField('ancDateOfBooking', e.target.value)}/></div>
                      <div className="field"><label>Indication</label><input value={form.ancIndication} onChange={e => setField('ancIndication', e.target.value)}/></div>
                      <div className="field"><label>LMP</label><input type="date" value={form.ancLmp} onChange={e => setField('ancLmp', e.target.value)}/></div>
                      <div className="field"><label>EDD</label><input type="date" value={form.ancEdd} onChange={e => setField('ancEdd', e.target.value)}/></div>
                      <div className="field"><label>Husband's Name</label><input value={form.ancHusbandName} onChange={e => setField('ancHusbandName', e.target.value)}/></div>
                      <div className="field"><label>Husband's Occupation</label><input value={form.ancHusbandOccupation} onChange={e => setField('ancHusbandOccupation', e.target.value)}/></div>
                      <div className="field"><label>Employer</label><input value={form.ancEmployer} onChange={e => setField('ancEmployer', e.target.value)}/></div>
                    </div>
                  </>
                )}

                <div className="dash-modal-title" style={{ fontSize: 14, marginTop: 6 }}>Next of Kin</div>
                <div className="dash-field-grid">
                  <div className="field"><label>Name</label><input value={form.nokName} onChange={e => setField('nokName', e.target.value)}/></div>
                  <div className="field"><label>Relationship</label><input value={form.nokRelationship} onChange={e => setField('nokRelationship', e.target.value)}/></div>
                  <div className="field"><label>Phone</label><input value={form.nokPhone} onChange={e => setField('nokPhone', e.target.value)}/></div>
                  <div className="field"><label>Address</label><input value={form.nokAddress} onChange={e => setField('nokAddress', e.target.value)}/></div>
                </div>
              </div>

              <div className="dash-modal-actions"><button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Patient'}</button></div>
            </form>
          </div>
        </div>
      )}

      {pending ? (
        <div className="dash-toast dash-undo-toast">
          <span>{pending.patient.full_name} removed ({pending.secondsLeft}s)</span>
          <button onClick={handleUndo}>Undo</button>
        </div>
      ) : toast && (
        <div className="dash-toast">{toast}</div>
      )}

      {/* Popover Menu Styling */}
      <style>{`
        .dash-popover-menu {
          position: absolute;
          top: 42px;
          right: 0;
          width: 280px;
          background: var(--bg-elevated);
          background-color: var(--glass-bg, var(--bg-elevated));
          background-image: var(--glass-sheen, none);
          -webkit-backdrop-filter: var(--glass-blur, none);
          backdrop-filter: var(--glass-blur, none);
          border: 1px solid var(--glass-border, var(--line));
          border-radius: 16px;
          box-shadow: var(--glass-shadow, 0 10px 25px rgba(0, 0, 0, 0.4));
          z-index: 100;
          overflow: hidden;
        }
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
          .dash-popover-menu { background: var(--bg-elevated); }
        }
        .dash-popover-header {
          padding: 10px 14px;
          font-size: 12px;
          font-weight: 600;
          background: var(--glass-head, var(--bg-card-hover));
          border-bottom: 1px solid var(--glass-border, var(--line));
          color: var(--ivory);
        }
        .dash-popover-body {
          max-height: 220px;
          overflow-y: auto;
        }
        .dash-popover-item {
          padding: 10px 14px;
          font-size: 12px;
          border-bottom: 1px solid var(--glass-border, var(--line));
          color: var(--muted);
          line-height: 1.4;
        }
        .dash-popover-item:last-child {
          border-bottom: none;
        }
      `}</style>

    </div>
    </HospitalProvider>
  )
}
