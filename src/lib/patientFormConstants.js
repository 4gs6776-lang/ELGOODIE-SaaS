// =====================================================================
// GOODIE-MEDHUB — shared patient-form constants
// ---------------------------------------------------------------------
// Single source of truth for the dropdown options used in patient
// registration (Reception) and patient edit (PatientProfile → Edit Info).
// Previously these arrays were duplicated inline in Reception.jsx only,
// so the Edit Info tab had free-text inputs for blood group / genotype
// / marital status instead of the controlled dropdowns Reception uses.
// Centralizing them here lets EditInfoTab render the SAME controlled
// inputs Reception uses, so editing a patient doesn't lose validation.
// =====================================================================

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']

export const GENOTYPES = ['AA', 'AS', 'SS', 'AC']

export const MARITAL_STATUSES = ['Single', 'Married', 'Widow', 'Widower', 'Divorced']

export const RELIGIONS = ['Christianity', 'Islam', 'Traditional', 'Other']

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)',
  'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
  'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers',
  'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
]

export const AFRICAN_COUNTRIES = [
  'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde',
  'Cameroon', 'Central African Republic', 'Chad', 'Comoros', 'Congo (Republic)',
  'Congo (DRC)', 'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini',
  'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea', 'Guinea-Bissau', 'Ivory Coast',
  'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar', 'Malawi', 'Mali',
  'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger',
  'Nigeria', 'Rwanda', 'Sao Tome and Principe', 'Senegal', 'Seychelles',
  'Sierra Leone', 'Somalia', 'South Africa', 'South Sudan', 'Sudan', 'Tanzania',
  'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe',
]

export const PATIENT_CATEGORIES = [
  { value: 'personal',  label: 'Personal Folder' },
  { value: 'family',    label: 'Family Folder' },
  { value: 'emergency', label: 'Emergency Folder' },
  { value: 'anc',       label: 'ANC Folder' },
  { value: 'hmo',       label: 'HMO Folder' },
]

export const PATIENT_STATUSES = [
  { value: 'stable',  label: 'Stable' },
  { value: 'review',  label: 'In Review' },
  { value: 'critical', label: 'Critical' },
]

// Compute age from a date-of-birth string (YYYY-MM-DD). Returns '' for
// invalid/empty input. Mirrors the calculateAge helper Reception uses
// internally — keeping it here means Edit Info can auto-update the age
// field whenever the user changes the DOB, just like Reception does.
export function calculateAgeFromDob(dobStr) {
  if (!dobStr) return ''
  const dob = new Date(dobStr)
  if (Number.isNaN(dob.getTime())) return ''
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
  return Number.isFinite(age) && age >= 0 ? age : ''
}

// Compute EDD from LMP (Last Menstrual Period) — LMP + 280 days.
// Mirrors calculateEdd() in Reception.jsx so ANC edits can recompute
// the EDD whenever the LMP is changed in Edit Info.
export function calculateEddFromLmp(lmpStr) {
  if (!lmpStr) return ''
  const lmp = new Date(lmpStr)
  if (Number.isNaN(lmp.getTime())) return ''
  lmp.setDate(lmp.getDate() + 280)
  return lmp.toISOString().slice(0, 10)
}
