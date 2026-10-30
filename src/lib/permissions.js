
 // =====================================================================
 // GOODIE-MEDHUB — Centralized permissions (Stage 1)
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
  staff: 'Staff',
}

// Who may CHANGE a patient's stored details (name, age, contacts, allergies,
// ward/bed...) or delete a patient record. Everyone else can still view
// patients and use them in their own work (consultations, dispensing, billing).
export const PATIENT_EDIT_ROLES = ['front_desk', 'nurse', 'admin']
export function canEditPatientDetails(role) {
  return PATIENT_EDIT_ROLES.includes(role)
}

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

const COMMON_ACCESS = [
  'overview',
  'roster',
  'notifications',
  'messages',
  'settings',
]

const ROLE_MODULES = {
  doctor: [
    ...COMMON_ACCESS,
    'patients',
    'hmo_patients',
    'anc_patients',
    'appointments',
    'doctor',
    'ipd',
    'admissions',
    'handover',
    'ai_diagnostics',
  ],

  nurse: [
    ...COMMON_ACCESS,
    'patients',
    'hmo_patients',
    'anc_patients',
    'appointments',
    'nursing',
    'ipd',
    'admissions',
    'handover',
    'reception',
    'laboratory',
    'radiology',
    'ai_diagnostics',
  ],

  front_desk: [
    ...COMMON_ACCESS,
    'patients',
    'hmo_patients',
    'anc_patients',
    'reception',
    'appointments',
    'insurance',
    'admissions',
  ],

  pharmacist: [
    ...COMMON_ACCESS,
    'patients',
    'hmo_patients',
    'anc_patients',
    'pharmacy',
    'inventory',
    'handover',
  ],

  lab: [
    ...COMMON_ACCESS,
    'patients',
    'hmo_patients',
    'anc_patients',
    'laboratory',
    'radiology',
    'handover',
  ],

  billing: [
    ...COMMON_ACCESS,
    'patients',
    'hmo_patients',
    'anc_patients',
    'billing',
    'insurance',
  ],
}

const BASELINE_MODULE_ACTIONS = [
  ACTIONS.VIEW,
  ACTIONS.CREATE,
  ACTIONS.EDIT,
]

const ROLE_ACTION_OVERRIDES = {
  doctor: {
    doctor: [ACTIONS.DELETE],
  },

  lab: {
    laboratory: [ACTIONS.DELETE],
    radiology: [ACTIONS.DELETE],
  },

  nurse: {
    nursing: [ACTIONS.ARCHIVE],
  },

  front_desk: {
    appointments: [ACTIONS.CANCEL],
  },
}

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

// Can this role perform an action on a module?
export function can(role, action, moduleKey) {
  if (!role || !action || !moduleKey) return false

  return actionsForModule(role, moduleKey).includes(action)
}

// Can this role access a module?
export function canAccessModule(role, moduleKey) {
  if (FULL_ACCESS_ROLES.includes(role)) return true

  return Boolean(ROLE_MODULES[role]?.includes(moduleKey))
}

// Get modules accessible to a role.
export function getAccessibleModules(role) {
  if (FULL_ACCESS_ROLES.includes(role)) return [...MODULES]

  return [...(ROLE_MODULES[role] || COMMON_ACCESS)]
}

// Convenience permissions object for components.
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
