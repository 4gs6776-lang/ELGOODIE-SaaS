// =====================================================================
// GOODIE-MEDHUB — drugOptions.js (shared)
// ---------------------------------------------------------------------
// Builds the dropdown options for picking a drug, used by:
//   • DoctorWorkbench prescription writer
//   • Discharge → Take-Home Drugs editor
//
// The list merges the hospital's actual `inventory_items` (category
// 'drug', with live stock) with a small built-in GLOBAL_MEDICATIONS
// reference list (common essentials every hospital stocks, so a fresh
// install still has something to pick from before inventory is loaded).
//
// Hoisted out of DoctorWorkbench.jsx so both the prescription writer
// and the discharge take-home-drugs editor show the SAME hospital
// pharmacy list — previously the discharge editor was a free-text
// input, so doctors had no way to pick a stocked drug and the pharmacy
// had nothing to dispense against.
// =====================================================================

// Common essentials — every hospital stocks these. Keep the list small;
// the real source of truth is the hospital's own inventory_items rows.
export const GLOBAL_MEDICATIONS = [
  { id: 'GMED-001', name: 'Ceftriaxone 1g Injection', generic: 'Ceftriaxone', strength: '1g', form: 'Injection', route: 'IV/IM' },
  { id: 'GMED-002', name: 'Ceftriaxone 500mg Injection', generic: 'Ceftriaxone', strength: '500mg', form: 'Injection', route: 'IV/IM' },
  { id: 'GMED-003', name: 'Amoxicillin 500mg Capsule', generic: 'Amoxicillin', strength: '500mg', form: 'Capsule', route: 'Oral' },
  { id: 'GMED-004', name: 'Paracetamol 500mg Tablet', generic: 'Paracetamol', strength: '500mg', form: 'Tablet', route: 'Oral' },
  { id: 'GMED-005', name: 'Artesunate 120mg Injection', generic: 'Artesunate', strength: '120mg', form: 'Injection', route: 'IV' },
  { id: 'GMED-006', name: 'Methyldopa 250mg Tablet', generic: 'Methyldopa', strength: '250mg', form: 'Tablet', route: 'Oral' },
  // Can be expanded or moved to a database table later
]

// Build the merged, de-duplicated option list for a drug picker.
//
// inventoryItems: rows from useOfflineTable('inventory_items') /
//                 useLazyTable('inventory_items').
//
// Returns an array of:
//   { id, inventoryId, globalMedId, label, generic, strength, form,
//     route, stock, sublabel, right, rightTone }
//
// `right` / `rightTone` drive the small right-aligned stock badge in
// the Autocomplete option rows ("In stock: N" green / "Out of stock" red).
export function buildDrugOptions(inventoryItems = []) {
  const map = new Map()
  const push = (key, opt) => { if (!map.has(key)) map.set(key, opt) }

  inventoryItems.forEach(it => {
    if (String(it.category || '').toLowerCase() !== 'drug') return
    push(String(it.name || '').toLowerCase(), {
      id: `inv-${it.id}`,
      inventoryId: it.id,
      globalMedId: null,
      label: it.name,
      generic: it.generic_name || 'Generic',
      strength: it.strength || '',
      form: it.dosage_form || '',
      route: it.route || '',
      stock: Number(it.quantity || 0),
    })
  })

  GLOBAL_MEDICATIONS.forEach(gm => {
    const hospMatch = inventoryItems.find(it =>
      String(it.name || '').toLowerCase() === gm.name.toLowerCase() &&
      String(it.category || '').toLowerCase() === 'drug')
    push(gm.name.toLowerCase(), {
      id: `gmed-${gm.id}`,
      inventoryId: hospMatch?.id || null,
      globalMedId: gm.id,
      label: gm.name,
      generic: gm.generic,
      strength: gm.strength,
      form: gm.form,
      route: gm.route,
      stock: hospMatch ? Number(hospMatch.quantity || 0) : 0,
    })
  })

  return [...map.values()].map(o => ({
    ...o,
    sublabel: [o.generic, o.form, o.strength].filter(Boolean).join(' · '),
    right: o.stock > 0 ? `In stock: ${o.stock}` : 'Out of stock',
    rightTone: o.stock > 0 ? 'good' : 'bad',
  }))
}
