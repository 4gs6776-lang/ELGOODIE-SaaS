
// =====================================================================
// GOODIE-MEDHUB — Centralized permissions (Stage 2: DB-backed RBAC)
// =====================================================================
//
// Phase 4 upgrade: hospital Admins can now customize which modules
// each role can access via Settings → Role Permissions.
//
// How it works:
//   1. The hospital_role_permissions table stores per-hospital
//      custom permissions (one row per role+module).
//   2. useRolePermissions() hook loads them via useOfflineTable
//      (offline-first — cached in IndexedDB).
//   3. buildPermissionsWithDb() builds the permission object using
//      the DB rows if they exist, falling back to the hardcoded
//      defaults below if the DB is empty (backward compat).
//   4. The existing can(), canAccessModule(), buildPermissions()
//      functions continue to work with hardcoded defaults for
//      any code that doesn't use the DB-backed version.
//
// Safety rules enforced at the DB level (migration 067 triggers):
//   - Owner role: ALWAYS full access (can't be restricted)
//   - CMD role: ALWAYS read-only (can_create/edit/delete forced to false)
//   - These are also enforced in the frontend as a defense-in-depth.
// =====================================================================

export const ACTIONS = {
  VIEW: 'view',
  CREATE: 'create',
  EDIT: 'edit',
  DELETE: 'delete',
  ARCHIVE: 'archive',
  CANCEL: 'cancel',
  APPROVE: 'approve',
  PUBLISH: 'publish',
  EXPORT: 'export',
  IMPORT: 'import',
  PRINT: 'print',
  MANAGE_SETTINGS: 'manage_settings',
}

export const ALL_ACTIONS = Object.values(ACTIONS)

export const FULL_ACCESS_ROLES = ['admin', 'owner']

export const ROLE_LABELS = {
  admin: 'Admin',
  owner: 'Owner',
  doctor: 'Doctor',
  nurse: 'Nurse',
  front_desk: 'Front Desk',
  pharmacist: 'Pharmacist',
  lab: 'Laboratory',
  billing: 'Billing',
  cmd: 'CMD (Read-Only)',
  staff: 'Staff',
}

// Who may CHANGE a patient's stored details (name, age, contacts, allergies,
// ward/bed...) or delete a patient record. Everyone else can still view
// patients and use them in their own work (consultations, dispensing, billing).
export const PATIENT_EDIT_ROLES = ['front_desk', 'nurse', 'admin']
export function canEditPatientDetails(role) {
  return PATIENT_EDIT_ROLES.includes(role)
}

// All configurable modules (shown in the Admin UI)
export const MODULES = [
  'overview',
  'patients',
  'reception',
  'appointments',
  'doctor',
  'nursing',
  'ipd',
  'admissions',
  'handover',
  'billing',
  'pharmacy',
  'laboratory',
  'radiology',
  'inventory',
  'staff',
  'insurance',
  'reports',
  'notifications',
  'roster',
  'messages',
  'settings',
  'hmo_patients',
  'anc_patients',
  'ai_diagnostics',
]

// Module labels for the Admin UI (human-readable names)
export const MODULE_LABELS = {
  overview: 'Dashboard Overview',
  patients: 'Patients',
  reception: 'Reception',
  appointments: 'Appointments',
  doctor: 'Doctor Workbench',
  nursing: 'Nursing',
  ipd: 'IPD / Inpatient',
  admissions: 'Admissions',
  handover: 'Shift Handover',
  billing: 'Billing / Cashier',
  pharmacy: 'Pharmacy',
  laboratory: 'Laboratory',
  radiology: 'Radiology',
  inventory: 'Inventory',
  staff: 'Staff Management',
  insurance: 'Insurance / HMO',
  reports: 'Financial Reports',
  notifications: 'Reminders',
  roster: 'Duty Roster',
  messages: 'Messages',
  settings: 'Settings',
  hmo_patients: 'HMO Patients',
  anc_patients: 'ANC Patients',
  ai_diagnostics: 'AI Diagnostics',
}

// Roles that can be configured (owner excluded — always full access)
export const CONFIGURABLE_ROLES = [
  'admin', 'doctor', 'nurse', 'front_desk',
  'pharmacist', 'lab', 'billing', 'cmd', 'staff',
]

const COMMON_ACCESS = [
  'overview',
  'roster',
  'notifications',
  'messages',
  'settings',
]

// ---- Hardcoded defaults (fallback when no DB rows exist) ----
// These EXACTLY match the behavior before the RBAC upgrade — so any
// hospital that hasn't run migration 067 sees zero behavior change.
const ROLE_MODULES = {
  doctor: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'appointments',
    'doctor', 'ipd', 'admissions', 'handover', 'ai_diagnostics',
  ],
  nurse: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'appointments',
    'nursing', 'ipd', 'admissions', 'handover', 'reception',
    'laboratory', 'radiology', 'ai_diagnostics',
  ],
  front_desk: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'reception',
    'appointments', 'insurance', 'admissions',
  ],
  pharmacist: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'pharmacy',
    'inventory', 'handover',
  ],
  lab: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'laboratory',
    'radiology', 'handover',
  ],
  billing: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'billing',
    'insurance',
  ],
  staff: [...COMMON_ACCESS],
  cmd: [
    ...COMMON_ACCESS,
    'patients', 'hmo_patients', 'anc_patients', 'reception',
    'appointments', 'doctor', 'nursing', 'ipd', 'admissions',
    'handover', 'pharmacy', 'laboratory', 'radiology', 'inventory',
    'billing', 'insurance', 'reports', 'ai_diagnostics', 'staff',
  ],
}

const BASELINE_MODULE_ACTIONS = [
  ACTIONS.VIEW,
  ACTIONS.CREATE,
  ACTIONS.EDIT,
]

const ROLE_ACTION_OVERRIDES = {
  doctor: { doctor: [ACTIONS.DELETE] },
  lab: { laboratory: [ACTIONS.DELETE], radiology: [ACTIONS.DELETE] },
  nurse: { nursing: [ACTIONS.ARCHIVE] },
  front_desk: { appointments: [ACTIONS.CANCEL] },
}

// ---- Hardcoded permission functions (fallback) ----
// These continue to work exactly as before. They're used when the
// DB-backed permissions aren't loaded yet or the hospital hasn't
// customized anything.

const moduleActionCache = new Map()

function actionsForModule(role, moduleKey) {
  const cacheKey = `${role}|${moduleKey}`
  const cached = moduleActionCache.get(cacheKey)
  if (cached) return cached

  let actions
  if (FULL_ACCESS_ROLES.includes(role)) {
    actions = ALL_ACTIONS
  } else if (ROLE_MODULES[role]?.includes(moduleKey)) {
    actions = new Set(BASELINE_MODULE_ACTIONS)
    const overrides = ROLE_ACTION_OVERRIDES[role]?.[moduleKey]
    if (overrides) {
      overrides.forEach(action => actions.add(action))
    }
    actions = [...actions]
  } else {
    actions = []
  }

  moduleActionCache.set(cacheKey, actions)
  return actions
}

export function can(role, action, moduleKey) {
  if (!role || !action || !moduleKey) return false
  // Safety: owner always has full access
  if (role === 'owner') return true
  // Safety: CMD is always read-only
  if (role === 'cmd' && action !== ACTIONS.VIEW && action !== ACTIONS.PRINT && action !== ACTIONS.EXPORT) return false
  return actionsForModule(role, moduleKey).includes(action)
}

export function canAccessModule(role, moduleKey) {
  if (!role || !moduleKey) return false
  if (FULL_ACCESS_ROLES.includes(role)) return true
  // CMD can view all modules (read-only)
  if (role === 'cmd') return true
  return Boolean(ROLE_MODULES[role]?.includes(moduleKey))
}

export function getAccessibleModules(role) {
  if (FULL_ACCESS_ROLES.includes(role)) return [...MODULES]
  return [...(ROLE_MODULES[role] || COMMON_ACCESS)]
}

// Convenience permissions object for components (hardcoded fallback).
export function buildPermissions(role) {
  return {
    role,
    isAdmin: role === 'admin',
    isOwner: role === 'owner',
    isFullAccess: FULL_ACCESS_ROLES.includes(role),
    can: (action, moduleKey) => can(role, action, moduleKey),
    canAccess: moduleKey => canAccessModule(role, moduleKey),
    modules: getAccessibleModules(role),
  }
}

// =====================================================================
// DB-backed permission functions (Phase 4 RBAC)
// =====================================================================
//
// These accept a `dbPermissions` array (from useOfflineTable) and build
// the permission object using the DB rows. If dbPermissions is empty
// or null, they fall back to the hardcoded defaults above.
//
// Usage:
//   const { records: dbPerms } = useOfflineTable('hospital_role_permissions', hospital?.id)
//   const perms = buildPermissionsWithDb(profile?.role, dbPerms)
//   // perms.can('create', 'patients')  → true/false based on DB
//   // perms.canAccess('billing')       → true/false based on DB
//   // perms.modules                    → array of accessible module keys
// =====================================================================

export function canWithDb(role, action, moduleKey, dbPermissions) {
  if (!role || !action || !moduleKey) return false

  // Owner: always full access
  if (role === 'owner') return true

  // Admin: always full access (can't be restricted by the Admin UI)
  if (role === 'admin') return true

  // CMD: always read-only (even if DB says can_create=true — the DB
  // trigger also enforces this, but we double-check here)
  if (role === 'cmd') {
    return action === ACTIONS.VIEW || action === ACTIONS.PRINT || action === ACTIONS.EXPORT
  }

  // If no DB permissions, fall back to hardcoded defaults
  if (!dbPermissions || dbPermissions.length === 0) {
    return can(role, action, moduleKey)
  }

  // Find the DB row for this role+module
  const row = dbPermissions.find(p => p.role === role && p.module === moduleKey)
  if (!row) {
    // No row = not configured = fall back to hardcoded defaults
    return can(role, action, moduleKey)
  }

  // Use the DB row
  switch (action) {
    case ACTIONS.VIEW: return row.can_view !== false
    case ACTIONS.CREATE: return row.can_create === true
    case ACTIONS.EDIT: return row.can_edit === true
    case ACTIONS.DELETE: return row.can_delete === true
    default:
      // For other actions (ARCHIVE, CANCEL, APPROVE, etc.), fall back
      // to hardcoded defaults (the DB model only tracks view/create/edit/delete)
      return can(role, action, moduleKey)
  }
}

export function canAccessModuleWithDb(role, moduleKey, dbPermissions) {
  if (!role || !moduleKey) return false

  // Owner + Admin: always full access
  if (FULL_ACCESS_ROLES.includes(role)) return true

  // CMD: can view all modules (read-only)
  if (role === 'cmd') return true

  // If no DB permissions, fall back to hardcoded defaults
  if (!dbPermissions || dbPermissions.length === 0) {
    return canAccessModule(role, moduleKey)
  }

  // Find the DB row for this role+module
  const row = dbPermissions.find(p => p.role === role && p.module === moduleKey)
  if (!row) {
    // No row = not configured = fall back to hardcoded defaults
    return canAccessModule(role, moduleKey)
  }

  return row.can_view !== false
}

export function getAccessibleModulesWithDb(role, dbPermissions) {
  if (FULL_ACCESS_ROLES.includes(role)) return [...MODULES]
  if (role === 'cmd') return [...MODULES] // CMD sees all (read-only)

  // If no DB permissions, fall back to hardcoded defaults
  if (!dbPermissions || dbPermissions.length === 0) {
    return getAccessibleModules(role)
  }

  // Filter DB rows for this role where can_view=true
  const accessible = dbPermissions
    .filter(p => p.role === role && p.can_view !== false)
    .map(p => p.module)

  // If no rows found for this role, fall back to hardcoded defaults
  if (accessible.length === 0) {
    return getAccessibleModules(role)
  }

  return accessible
}

// Build the full permission object using DB-backed permissions.
// Falls back to hardcoded defaults when dbPermissions is empty/null.
export function buildPermissionsWithDb(role, dbPermissions) {
  return {
    role,
    isAdmin: role === 'admin',
    isOwner: role === 'owner',
    isFullAccess: FULL_ACCESS_ROLES.includes(role) || role === 'cmd',
    isReadOnly: role === 'cmd',
    can: (action, moduleKey) => canWithDb(role, action, moduleKey, dbPermissions),
    canAccess: moduleKey => canAccessModuleWithDb(role, moduleKey, dbPermissions),
    modules: getAccessibleModulesWithDb(role, dbPermissions),
  }
}
