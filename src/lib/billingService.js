// =====================================================================
// GOODIE-MEDHUB — src/lib/billingService.js
//
// Phase 1 service layer. Wraps the offline-first hooks with type-safe
// helpers for:
//   - Looking up services in the catalog
//   - Resolving the effective price for a (service, patient) pair
//     (takes into account the patient's HMO contract price list)
//   - Computing HMO split (HMO covers X%, patient pays Y)
//   - Calling next_document_number() RPC for sequential numbering
//
// Phase 2 will add: invoice lifecycle (draft → finalize), payment
// allocation, credit notes, claim status updates.
//
// USAGE (in any component):
//   import { useBillingCatalog, resolvePriceForPatient } from '../lib/billingService'
//
//   const { catalog, priceLists, contracts, paymentMethods, vendors } = useBillingCatalog()
//   const price = resolvePriceForPatient(catalog, priceLists, contracts, patient, serviceCode)
// =====================================================================

import { useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from './useOfflineTable'
import { supabase } from './supabaseClient'

// ---------------------------------------------------------------------
// HOOK: useBillingCatalog
// Loads everything the CashierWorkspace / Settings / PatientProfile
// need to look up prices and contracts. All hospital-scoped via RLS.
// ---------------------------------------------------------------------

export function useBillingCatalog() {
  const { hospital } = useAuth()
  const hospitalId = hospital?.id

  const { records: catalog, loading: catalogLoading } = useOfflineTable('service_catalog', hospitalId)
  const { records: priceLists, loading: priceListsLoading } = useOfflineTable('price_lists', hospitalId)
  const { records: priceListItems, loading: itemsLoading } = useOfflineTable('price_list_items', hospitalId)
  const { records: contracts, loading: contractsLoading } = useOfflineTable('hmo_contracts', hospitalId)
  const { records: paymentMethods, loading: methodsLoading } = useOfflineTable('hospital_payment_methods', hospitalId)
  const { records: vendors, loading: vendorsLoading } = useOfflineTable('expense_vendors', hospitalId)
  const { records: documentSequences } = useOfflineTable('document_sequences', hospitalId)

  return useMemo(() => ({
    catalog: catalog || [],
    priceLists: priceLists || [],
    priceListItems: priceListItems || [],
    contracts: contracts || [],
    paymentMethods: paymentMethods || [],
    vendors: vendors || [],
    documentSequences: documentSequences || [],
    loading: catalogLoading || priceListsLoading || itemsLoading || contractsLoading || methodsLoading || vendorsLoading,
  }), [catalog, priceLists, priceListItems, contracts, paymentMethods, vendors, documentSequences,
       catalogLoading, priceListsLoading, itemsLoading, contractsLoading, methodsLoading, vendorsLoading])
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

// Find a service in the catalog by code
export function findServiceByCode(catalog, code) {
  if (!catalog || !code) return null
  return catalog.find(s => s.code === code && s.is_active !== false) || null
}

// Find a service in the catalog by id
export function findServiceById(catalog, id) {
  if (!catalog || !id) return null
  return catalog.find(s => s.id === id) || null
}

// Find the patient's HMO contract (if any).
// A patient has an HMO contract if they have hmo_provider set AND
// category === 'hmo'. We match by payer_name (loose) — Phase 2 will
// add a proper patient_hmo_enrollments table with FK to hmo_contracts.
export function findContractForPatient(contracts, patient) {
  if (!contracts || !patient) return null
  if (patient.category !== 'hmo' && !patient.hmo_provider) return null
  if (!patient.hmo_provider || patient.hmo_provider === 'Self-Pay (No HMO)') return null
  return contracts.find(c =>
    c.is_active !== false &&
    c.payer_name === patient.hmo_provider
  ) || null
}

// Resolve the price list for a patient. Priority:
//   1. Their HMO contract's price_list_id (if they're an HMO patient)
//   2. The hospital's default price list (is_default=true)
//   3. null (caller falls back to catalog.default_price)
export function findPriceListForPatient(priceLists, contracts, patient) {
  if (!priceLists || priceLists.length === 0) return null

  // HMO patient → use their contract's price list
  const contract = findContractForPatient(contracts, patient)
  if (contract?.price_list_id) {
    const pl = priceLists.find(p => p.id === contract.price_list_id && p.is_active !== false)
    if (pl) return pl
  }

  // Default price list
  const defaultPl = priceLists.find(p => p.is_default && p.is_active !== false)
  if (defaultPl) return defaultPl

  // First active price list as last resort
  return priceLists.find(p => p.is_active !== false) || null
}

// Resolve the effective price + coverage for a single service for a patient.
// Returns:
//   {
//     service:       the catalog row,
//     price:         the effective price (from price list or catalog default),
//     coveragePercent: 0-100 (HMO covers X%),
//     copayPercent:    0-100 (patient pays Y% of price),
//     copayAmount:     fixed copay (added on top of copayPercent if set),
//     isExcluded:      true if this service is excluded from the price list,
//     priorAuthRequired: true if pre-auth needed,
//     source:        'price_list' | 'catalog_default'
//   }
export function resolvePriceForPatient(catalog, priceLists, priceListItems, contracts, patient, serviceCode) {
  const service = findServiceByCode(catalog, serviceCode)
  if (!service) {
    return null
  }

  const priceList = findPriceListForPatient(priceLists, contracts, patient)
  const contract = findContractForPatient(contracts, patient)

  // Default: catalog price, 100% patient pays
  const result = {
    service,
    price: Number(service.default_price) || 0,
    coveragePercent: 0,
    copayPercent: 100,
    copayAmount: 0,
    isExcluded: false,
    priorAuthRequired: false,
    source: 'catalog_default',
    priceListId: priceList?.id || null,
    contractId: contract?.id || null,
  }

  if (!priceList) return result

  // Look up the override in price_list_items
  const item = priceListItems.find(
    pli => pli.price_list_id === priceList.id && pli.service_catalog_id === service.id
  )

  if (item) {
    result.price = Number(item.price) || result.price
    result.coveragePercent = Number(item.coverage_percent) || 0
    result.copayPercent = Math.max(0, Math.min(100, 100 - result.coveragePercent))
    result.copayAmount = Number(item.copay_amount) || 0
    result.isExcluded = !!item.is_excluded
    result.priorAuthRequired = !!item.prior_auth_required
    result.source = 'price_list'
  } else if (contract) {
    // No specific override for this service in this contract's price list
    // → fall back to the contract's default_coverage_percent
    result.coveragePercent = Number(contract.default_coverage_percent) || 0
    result.copayPercent = Math.max(0, Math.min(100, 100 - result.coveragePercent))
  }

  return result
}

// Compute the HMO split for a given total amount + coverage config.
// Returns:
//   {
//     hmoAmount:    what the HMO covers (may be 0 if no contract),
//     patientAmount: what the patient pays (including any fixed copay),
//     coveragePercent, copayPercent, copayAmount
//   }
export function computeHmoSplit(totalAmount, { coveragePercent = 0, copayPercent = 100, copayAmount = 0 } = {}) {
  const total = Number(totalAmount) || 0
  const cov = Math.max(0, Math.min(100, Number(coveragePercent) || 0))
  const cop = Math.max(0, Math.min(100, Number(copayPercent) || 0))
  const copayFixed = Number(copayAmount) || 0

  // HMO covers cov% of the (total minus fixed copay).
  // The patient pays the rest + the fixed copay.
  const netAfterCopay = Math.max(0, total - copayFixed)
  const hmoAmount = Math.round(netAfterCopay * (cov / 100) * 100) / 100
  const patientAmount = Math.max(0, total - hmoAmount)

  return {
    hmoAmount,
    patientAmount,
    coveragePercent: cov,
    copayPercent: cop,
    copayAmount: copayFixed,
  }
}

// ---------------------------------------------------------------------
// RPC: next_document_number
// Calls the SECURITY DEFINER function from migration 039. Atomic and
// concurrency-safe.
//
// Returns: 'INV-000001' (or null on error)
// ---------------------------------------------------------------------

export async function nextDocumentNumber(hospitalId, docType, fiscalYear = null) {
  if (!hospitalId || !docType) return null
  try {
    const year = fiscalYear ?? new Date().getFullYear()
    const { data, error } = await supabase.rpc('next_document_number', {
      p_hospital_id: hospitalId,
      p_doc_type: docType,
      p_fiscal_year: year,
    })
    if (error) {
      console.warn('next_document_number RPC failed:', error.message)
      // Fallback to a timestamp-based number if the RPC isn't deployed yet
      return `${docType.toUpperCase()}-${Date.now().toString().slice(-6)}`
    }
    return data
  } catch (err) {
    console.warn('next_document_number RPC threw:', err?.message || err)
    return `${docType.toUpperCase()}-${Date.now().toString().slice(-6)}`
  }
}

// ---------------------------------------------------------------------
// CONSTANTS — exported for UI consumption
// ---------------------------------------------------------------------

export const SERVICE_CATEGORIES = [
  { value: 'consultation', label: 'Consultation' },
  { value: 'lab',          label: 'Laboratory' },
  { value: 'procedure',    label: 'Procedure' },
  { value: 'drug',         label: 'Drug / Medication' },
  { value: 'bed',          label: 'Bed / Ward Charge' },
  { value: 'service',      label: 'Service' },
  { value: 'anc_package',  label: 'ANC / Maternity Package' },
  { value: 'registration', label: 'Registration Fee' },
  { value: 'other',        label: 'Other' },
]

export const PRICE_LIST_TYPES = [
  { value: 'standard',  label: 'Standard (Walk-in)' },
  { value: 'hmo',       label: 'HMO Tariff' },
  { value: 'staff',     label: 'Staff Tariff' },
  { value: 'corporate', label: 'Corporate Tariff' },
  { value: 'charity',   label: 'Charity / Subsidised' },
  { value: 'custom',    label: 'Custom' },
]

export const PAYER_TYPES = [
  { value: 'hmo',        label: 'HMO' },
  { value: 'insurance',  label: 'Insurance' },
  { value: 'corporate',  label: 'Corporate' },
  { value: 'government', label: 'Government' },
]

export const VENDOR_TYPES = [
  { value: 'supplier',   label: 'Supplier' },
  { value: 'utility',    label: 'Utility Company' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'staff',      label: 'Staff / Payroll' },
  { value: 'government', label: 'Government / Tax Authority' },
  { value: 'other',      label: 'Other' },
]

export const DOC_TYPES = [
  { value: 'invoice',     label: 'Invoice',     prefix: 'INV-' },
  { value: 'receipt',     label: 'Receipt',     prefix: 'RCT-' },
  { value: 'credit_note', label: 'Credit Note', prefix: 'CN-' },
  { value: 'claim',       label: 'HMO Claim',   prefix: 'CLM-' },
  { value: 'expense',     label: 'Expense',     prefix: 'EXP-' },
  { value: 'statement',   label: 'Statement',   prefix: 'STMT-' },
  { value: 'deposit',     label: 'Deposit',     prefix: 'DEP-' },
]

// Format money as Naira — used everywhere in the billing UI
export function formatMoney(n) {
  const v = Number(n || 0)
  return '₦' + v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// =====================================================================
// PHASE 2 — Invoice lifecycle, payment allocation, credit notes,
// deposits, statement generation
// =====================================================================

// ---------------------------------------------------------------------
// HOOK: useBillingPhase2 — loads all the new Phase 2 tables
// ---------------------------------------------------------------------

export function useBillingPhase2() {
  const { hospital } = useAuth()
  const hospitalId = hospital?.id

  const { records: creditNotes, addRecord: addCreditNote, updateRecord: updateCreditNote } = useOfflineTable('credit_notes', hospitalId)
  const { records: allocations, addRecord: addAllocation, deleteRecord: deleteAllocation } = useOfflineTable('payment_allocations', hospitalId)
  const { records: deposits, addRecord: addDeposit, updateRecord: updateDeposit } = useOfflineTable('deposits', hospitalId)
  const { records: statementRuns, addRecord: addStatementRun, updateRecord: updateStatementRun } = useOfflineTable('statement_runs', hospitalId)
  const { records: invoices, updateRecord: updateInvoice } = useOfflineTable('invoices', hospitalId)
  const { records: payments, addRecord: addPayment, updateRecord: updatePayment } = useOfflineTable('payments', hospitalId)

  return useMemo(() => ({
    creditNotes: creditNotes || [],
    allocations: allocations || [],
    deposits: deposits || [],
    statementRuns: statementRuns || [],
    invoices: invoices || [],
    payments: payments || [],
    // mutators
    addCreditNote, updateCreditNote,
    addAllocation, deleteAllocation,
    addDeposit, updateDeposit,
    addStatementRun, updateStatementRun,
    updateInvoice,
    addPayment, updatePayment,
  }), [creditNotes, allocations, deposits, statementRuns, invoices, payments,
       addCreditNote, updateCreditNote, addAllocation, deleteAllocation,
       addDeposit, updateDeposit, addStatementRun, updateStatementRun,
       updateInvoice, addPayment, updatePayment])
}

// ---------------------------------------------------------------------
// CONSTANTS — Phase 2
// ---------------------------------------------------------------------

export const INVOICE_TYPES = [
  { value: 'outpatient',        label: 'Outpatient' },
  { value: 'inpatient_interim', label: 'Inpatient (Interim)' },
  { value: 'inpatient_final',   label: 'Inpatient (Final)' },
  { value: 'package',           label: 'Package / ANC' },
  { value: 'credit_note',       label: 'Credit Note' },
]

export const DRAFT_STATUSES = [
  { value: 'draft',      label: 'Draft',        color: 'var(--gold)' },
  { value: 'finalized',  label: 'Finalized',    color: 'var(--teal)' },
  { value: 'cancelled',  label: 'Cancelled',    color: 'var(--muted)' },
  { value: 'written_off', label: 'Written Off', color: 'var(--danger)' },
]

export const CREDIT_NOTE_REASONS = [
  { value: 'overcharge',           label: 'Overcharge' },
  { value: 'service_not_rendered', label: 'Service Not Rendered' },
  { value: 'hmo_short_payment',    label: 'HMO Short Payment' },
  { value: 'duplicate_charge',     label: 'Duplicate Charge' },
  { value: 'patient_dispute',      label: 'Patient Dispute' },
  { value: 'pricing_error',        label: 'Pricing Error' },
  { value: 'goodwill',             label: 'Goodwill Gesture' },
  { value: 'other',                label: 'Other' },
]

export const DEPOSIT_STATUSES = [
  { value: 'pending',   label: 'Pending',   color: 'var(--gold)' },
  { value: 'partial',    label: 'Partial',    color: 'var(--blue)' },
  { value: 'allocated',  label: 'Allocated', color: 'var(--teal)' },
  { value: 'refunded',   label: 'Refunded',  color: 'var(--muted)' },
]

// ---------------------------------------------------------------------
// INVOICE LIFECYCLE
// ---------------------------------------------------------------------

// Create a DRAFT invoice (no invoice_number assigned yet — gets one
// when finalized). Used by the new Draft mode in CashierWorkspace.
//
// Returns: { success, invoice?, error? }
export async function createDraftInvoice({
  hospital, profile, patientId, patientName, items, discount = 0, tax = 0,
  invoiceType = 'outpatient', admissionId = null,
  priceListId = null, hmoContractId = null, hmoAuthorizationCode = null,
  hmoProvider = null, hmoCoveragePercent = 0, hmoAmount = 0, patientAmount = 0,
  updateInvoice, writeAudit,
}) {
  if (!hospital?.id || !patientId || !items?.length) {
    return { success: false, error: 'Missing required fields' }
  }
  try {
    const subtotal = items.reduce((s, it) => s + Number(it.total || 0), 0)
    const discountAmt = Number(discount) || 0
    const taxAmt = Number(tax) || 0
    const grandTotal = Math.max(0, subtotal - discountAmt + taxAmt)

    const draftInvoice = await updateInvoice({
      hospital_id: hospital.id,
      patient_id: patientId,
      patient_name: patientName,
      // No invoice_number yet — assigned at finalize time
      invoice_number: `DRAFT-${Date.now().toString().slice(-8)}`,
      invoice_type: invoiceType,
      draft_status: 'draft',
      subtotal,
      amount: grandTotal,
      discount: discountAmt,
      tax: taxAmt,
      grand_total: grandTotal,
      hmo_provider: hmoProvider,
      hmo_coverage_percent: hmoCoveragePercent,
      hmo_amount: hmoAmount,
      patient_amount: patientAmount || grandTotal,
      amount_paid: 0,
      balance: patientAmount || grandTotal,
      status: 'unpaid',
      admission_id: admissionId,
      price_list_id: priceListId,
      hmo_contract_id: hmoContractId,
      hmo_authorization_code: hmoAuthorizationCode,
      created_by: profile?.id,
    })

    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'invoice.draft_created',
      entityType: 'invoice', entityId: draftInvoice?.id || null,
      patientId,
      summary: `Created draft invoice for ${patientName} — ${formatMoney(grandTotal)} (${invoiceType})`,
      metadata: { patient_name: patientName, subtotal, discount: discountAmt, tax: taxAmt, grand_total: grandTotal, invoice_type: invoiceType, item_count: items.length },
    })

    return { success: true, invoice: draftInvoice }
  } catch (err) {
    return { success: false, error: err.message || 'Could not create draft invoice' }
  }
}

// Finalize a draft — assigns sequential invoice_number via the
// next_document_number RPC, marks draft_status = 'finalized'.
//
// Returns: { success, invoice?, invoiceNumber?, error? }
export async function finalizeDraftInvoice({
  hospital, profile, invoice, updateInvoice, writeAudit,
}) {
  if (!invoice) return { success: false, error: 'No invoice provided' }
  if (invoice.draft_status === 'finalized') {
    return { success: true, invoice, invoiceNumber: invoice.invoice_number }
  }

  try {
    // Call the RPC for a sequential invoice_number
    const invoiceNumber = await nextDocumentNumber(hospital.id, 'invoice', new Date().getFullYear())
    if (!invoiceNumber) {
      return { success: false, error: 'Could not generate invoice number' }
    }

    await updateInvoice(invoice.id, {
      invoice_number: invoiceNumber,
      draft_status: 'finalized',
      finalized_at: new Date().toISOString(),
    })

    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'invoice.finalized',
      entityType: 'invoice', entityId: invoice.id,
      patientId: invoice.patient_id,
      summary: `Finalized invoice ${invoiceNumber} for ${invoice.patient_name} — ${formatMoney(invoice.grand_total || invoice.amount)}`,
      metadata: { invoice_number: invoiceNumber, grand_total: invoice.grand_total, invoice_type: invoice.invoice_type },
    })

    return { success: true, invoiceNumber }
  } catch (err) {
    return { success: false, error: err.message || 'Could not finalize invoice' }
  }
}

// Cancel a draft (cannot cancel finalized invoices — use credit notes).
export async function cancelDraftInvoice({ hospital, profile, invoice, updateInvoice, writeAudit }) {
  if (!invoice) return { success: false, error: 'No invoice provided' }
  if (invoice.draft_status !== 'draft') {
    return { success: false, error: 'Only draft invoices can be cancelled' }
  }
  try {
    await updateInvoice(invoice.id, { draft_status: 'cancelled' })
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'invoice.cancelled',
      entityType: 'invoice', entityId: invoice.id,
      patientId: invoice.patient_id,
      summary: `Cancelled draft invoice ${invoice.invoice_number} for ${invoice.patient_name}`,
      metadata: { invoice_id: invoice.id, draft_invoice_number: invoice.invoice_number },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not cancel invoice' }
  }
}

// Write off a finalized invoice (with reason — Phase 4 will add approval workflow)
export async function writeOffInvoice({ hospital, profile, invoice, reason, updateInvoice, writeAudit }) {
  if (!invoice) return { success: false, error: 'No invoice provided' }
  if (invoice.draft_status !== 'finalized') {
    return { success: false, error: 'Only finalized invoices can be written off' }
  }
  if (!reason?.trim()) {
    return { success: false, error: 'Reason is required for write-offs' }
  }
  try {
    await updateInvoice(invoice.id, {
      draft_status: 'written_off',
      written_off_reason: reason.trim(),
      written_off_by: profile?.id,
      written_off_at: new Date().toISOString(),
    })
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'invoice.written_off',
      entityType: 'invoice', entityId: invoice.id,
      patientId: invoice.patient_id,
      summary: `Wrote off invoice ${invoice.invoice_number} for ${invoice.patient_name} — ${formatMoney(invoice.balance)} — reason: ${reason.trim()}`,
      metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number, balance: invoice.balance, reason: reason.trim() },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not write off invoice' }
  }
}

// ---------------------------------------------------------------------
// MULTI-INVOICE PAYMENT ALLOCATION
// ---------------------------------------------------------------------

// Allocate a payment across one or more invoices.
//
// `allocations` is an array of { invoice_id, amount }.
// The function:
//   1. Inserts a payments row (with invoice_id = first allocation's invoice_id for backwards compat)
//   2. Inserts payment_allocations rows for each invoice
//   3. Updates each invoice's amount_paid, balance, status
//   4. Emits an audit event
//
// Returns: { success, payment?, allocations?, error? }
export async function allocatePaymentAcrossInvoices({
  hospital, profile, patientId, patientName, totalAmount, method, referenceNumber = null,
  allocations,  // [{ invoice_id, amount }]
  addPayment, addAllocation, updateInvoice, invoices, writeAudit,
}) {
  if (!hospital?.id || !patientId || !totalAmount || !allocations?.length) {
    return { success: false, error: 'Missing required fields' }
  }
  const totalAlloc = allocations.reduce((s, a) => s + Number(a.amount || 0), 0)
  if (Math.abs(totalAlloc - totalAmount) > 0.01) {
    return { success: false, error: `Allocation total (${formatMoney(totalAlloc)}) does not match payment amount (${formatMoney(totalAmount)})` }
  }

  try {
    // 1. Insert the payment row (invoice_id = first allocation's invoice_id)
    const firstInvoiceId = allocations[0].invoice_id
    const payment = await addPayment({
      hospital_id: hospital.id,
      invoice_id: firstInvoiceId,
      patient_id: patientId,
      patient_name: patientName,
      amount: totalAmount,
      method,
      reference_number: referenceNumber || `REF-${Date.now().toString().slice(-6)}`,
      received_by: profile?.id,
    })

    // 2. Insert payment_allocations rows + update each invoice
    for (const alloc of allocations) {
      const amt = Number(alloc.amount || 0)
      if (amt <= 0) continue

      await addAllocation({
        hospital_id: hospital.id,
        payment_id: payment.id,
        invoice_id: alloc.invoice_id,
        amount: amt,
        allocation_type: 'principal',
        allocated_by: profile?.id,
        allocated_by_name: profile?.full_name,
      })

      // Update the invoice's amount_paid, balance, status
      const inv = invoices.find(i => i.id === alloc.invoice_id)
      if (inv) {
        const newPaid = Number(inv.amount_paid || 0) + amt
        const grandTotal = Number(inv.grand_total || inv.amount || 0)
        const newBal = Math.max(0, grandTotal - newPaid)
        const newStatus = newBal <= 0.001 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid')
        await updateInvoice(inv.id, {
          amount_paid: newPaid,
          balance: newBal,
          status: newStatus,
          // Assign a receipt_number if this is the first payment on the invoice
          receipt_number: inv.receipt_number || await nextDocumentNumber(hospital.id, 'receipt', new Date().getFullYear()),
        })
      }
    }

    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'payment.multi_invoice_allocated',
      entityType: 'payment', entityId: payment.id,
      patientId,
      summary: `Recorded ${formatMoney(totalAmount)} (${method}) for ${patientName} — allocated across ${allocations.length} invoice(s)`,
      metadata: {
        payment_id: payment.id, total_amount: totalAmount, method,
        allocations: allocations.map(a => ({ invoice_id: a.invoice_id, amount: a.amount })),
      },
    })

    return { success: true, payment }
  } catch (err) {
    return { success: false, error: err.message || 'Could not allocate payment' }
  }
}

// ---------------------------------------------------------------------
// CREDIT NOTES
// ---------------------------------------------------------------------

// Create + post a credit note against an invoice.
//
// Refund method determines how the credit is returned:
//   'cash'         → cashier pays out cash (separate payment row with negative amount)
//   'wallet'       → credit the patient's wallet (separate wallet_transaction row)
//   'bank_transfer' → record a bank transfer refund
//   'none'         → just reduce the invoice balance, no refund (used when invoice was unpaid)
//
// Returns: { success, creditNote?, error? }
export async function createCreditNote({
  hospital, profile, invoice, amount, reasonCode, reasonText,
  refundMethod = 'none', refundReference = null,
  addCreditNote, updateInvoice, writeAudit,
}) {
  if (!invoice) return { success: false, error: 'No invoice provided' }
  const amt = Number(amount)
  if (isNaN(amt) || amt <= 0) return { success: false, error: 'Amount must be greater than 0' }
  if (!reasonCode || !reasonText?.trim()) {
    return { success: false, error: 'Reason code and text are required' }
  }

  try {
    // Assign sequential credit_note_number via the RPC
    const cnNumber = await nextDocumentNumber(hospital.id, 'credit_note', new Date().getFullYear())
    if (!cnNumber) return { success: false, error: 'Could not generate credit note number' }

    const creditNote = await addCreditNote({
      hospital_id: hospital.id,
      original_invoice_id: invoice.id,
      credit_note_number: cnNumber,
      amount: amt,
      reason_code: reasonCode,
      reason_text: reasonText.trim(),
      refund_method: refundMethod,
      refund_reference: refundReference,
      status: 'posted',
      posted_at: new Date().toISOString(),
      posted_by: profile?.id,
      created_by: profile?.id,
    })

    // Update the invoice: reduce amount_paid (if was paid) or reduce balance
    const currentPaid = Number(invoice.amount_paid || 0)
    const currentBalance = Number(invoice.balance || 0)
    const grandTotal = Number(invoice.grand_total || invoice.amount || 0)

    let newPaid, newBalance, newStatus
    if (refundMethod === 'none' || refundMethod === 'wallet') {
      // Reduce the invoice balance (no cash leaves the building)
      newBalance = Math.max(0, currentBalance - amt)
      newPaid = Math.max(0, grandTotal - newBalance)
    } else {
      // Cash / bank refund — reduce amount_paid (money is leaving)
      newPaid = Math.max(0, currentPaid - amt)
      newBalance = Math.max(0, grandTotal - newPaid)
    }
    newStatus = newBalance <= 0.001 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid')

    await updateInvoice(invoice.id, {
      amount_paid: newPaid,
      balance: newBalance,
      status: newStatus,
    })

    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'credit_note.posted',
      entityType: 'credit_note', entityId: creditNote?.id || null,
      patientId: invoice.patient_id,
      summary: `Posted credit note ${cnNumber} for ${formatMoney(amt)} against invoice ${invoice.invoice_number} — reason: ${reasonText.trim()}`,
      metadata: {
        credit_note_id: creditNote?.id, credit_note_number: cnNumber,
        invoice_id: invoice.id, invoice_number: invoice.invoice_number,
        amount: amt, reason_code: reasonCode, refund_method: refundMethod,
      },
    })

    return { success: true, creditNote }
  } catch (err) {
    return { success: false, error: err.message || 'Could not create credit note' }
  }
}

// ---------------------------------------------------------------------
// PATIENT ACCOUNT STATEMENT
// ---------------------------------------------------------------------

// Compute a patient's account statement for a date range.
// Returns the totals + the ledger entries (invoices, payments, credit notes).
//
// This is a CLIENT-SIDE computation (no SQL). For very large patient
// histories, a server-side RPC would be more efficient — Phase 3+.
export function computePatientStatement({
  invoices, payments, creditNotes, deposits,
  patientId, periodFrom, periodTo,
}) {
  const fromMs = periodFrom ? new Date(periodFrom).getTime() : 0
  const toMs = periodTo ? new Date(periodTo + 'T23:59:59').getTime() : Date.now()

  // Filter to this patient + date range
  const patientInvoices = (invoices || []).filter(i =>
    i.patient_id === patientId &&
    new Date(i.created_at).getTime() >= fromMs &&
    new Date(i.created_at).getTime() <= toMs &&
    i.draft_status !== 'cancelled'
  )
  const patientPayments = (payments || []).filter(p =>
    p.patient_id === patientId &&
    new Date(p.created_at).getTime() >= fromMs &&
    new Date(p.created_at).getTime() <= toMs &&
    p.status !== 'reversed'
  )
  const patientCreditNotes = (creditNotes || []).filter(cn =>
    cn.original_invoice_id && (invoices || []).find(i => i.id === cn.original_invoice_id)?.patient_id === patientId &&
    new Date(cn.created_at).getTime() >= fromMs &&
    new Date(cn.created_at).getTime() <= toMs &&
    cn.status === 'posted'
  )

  // Opening balance = sum of all invoices BEFORE period_from minus all payments BEFORE period_from
  const openingInvoices = (invoices || []).filter(i =>
    i.patient_id === patientId &&
    new Date(i.created_at).getTime() < fromMs &&
    i.draft_status !== 'cancelled'
  ).reduce((s, i) => s + Number(i.grand_total || i.amount || 0), 0)
  const openingPayments = (payments || []).filter(p =>
    p.patient_id === patientId &&
    new Date(p.created_at).getTime() < fromMs &&
    p.status !== 'reversed'
  ).reduce((s, p) => s + Number(p.amount || 0), 0)
  const openingBalance = openingInvoices - openingPayments

  // Period totals
  const totalInvoiced = patientInvoices.reduce((s, i) => s + Number(i.grand_total || i.amount || 0), 0)
  const totalPaid = patientPayments.reduce((s, p) => s + Number(p.amount || 0), 0)
  const totalRefunded = patientCreditNotes.reduce((s, cn) => s + (cn.refund_method === 'cash' || cn.refund_method === 'bank_transfer' ? Number(cn.amount || 0) : 0), 0)
  const totalAdjusted = patientCreditNotes.reduce((s, cn) => s + (cn.refund_method === 'none' || cn.refund_method === 'wallet' ? Number(cn.amount || 0) : 0), 0)

  // Closing balance = opening + invoiced - paid + refunded (cash refunds increase what patient is owed back)
  //                   - adjusted (credits that reduced the invoice balance without cash leaving)
  const closingBalance = openingBalance + totalInvoiced - totalPaid - totalAdjusted

  // Build a unified ledger sorted by date
  const ledger = [
    ...patientInvoices.map(i => ({
      date: i.created_at, type: 'invoice', number: i.invoice_number,
      description: `Invoice ${i.invoice_number} (${i.invoice_type || 'outpatient'})`,
      debit: Number(i.grand_total || i.amount || 0), credit: 0,
      ref: i,
    })),
    ...patientPayments.map(p => ({
      date: p.created_at, type: 'payment', number: p.reference_number || p.id.slice(0, 8),
      description: `Payment (${p.method})${p.reference_number ? ` ref ${p.reference_number}` : ''}`,
      debit: 0, credit: Number(p.amount || 0),
      ref: p,
    })),
    ...patientCreditNotes.map(cn => ({
      date: cn.created_at, type: 'credit_note', number: cn.credit_note_number,
      description: `Credit note (${cn.reason_code}) — ${cn.reason_text}`,
      debit: cn.refund_method === 'cash' || cn.refund_method === 'bank_transfer' ? Number(cn.amount || 0) : 0,
      credit: cn.refund_method === 'none' || cn.refund_method === 'wallet' ? Number(cn.amount || 0) : 0,
      ref: cn,
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date))

  return {
    periodFrom, periodTo,
    openingBalance,
    totalInvoiced, totalPaid, totalRefunded, totalAdjusted,
    closingBalance,
    invoiceCount: patientInvoices.length,
    paymentCount: patientPayments.length,
    creditNoteCount: patientCreditNotes.length,
    ledger,
  }
}


// =====================================================================
// PHASE 3 — HMO Claims Lifecycle, Pre-Auth Capture, Claim Form PDF,
// Batch Submission, Shortfall Handling
// =====================================================================

// ---------------------------------------------------------------------
// CONSTANTS — Phase 3
// ---------------------------------------------------------------------

export const CLAIM_STATUSES = [
  { value: 'submitted', label: 'Submitted',  color: 'var(--blue)',    description: 'Claim sent to HMO, awaiting response' },
  { value: 'queried',   label: 'Queried',    color: 'var(--gold)',    description: 'HMO has queried the claim for more info' },
  { value: 'approved',  label: 'Approved',   color: 'var(--teal)',    description: 'HMO has approved the claim (amount may differ)' },
  { value: 'paid',      label: 'Paid',       color: 'var(--mint)',    description: 'HMO payment received and allocated to claim' },
  { value: 'rejected',  label: 'Rejected',    color: 'var(--danger)',  description: 'HMO has rejected the claim' },
  { value: 'disputed',  label: 'Disputed',   color: 'var(--violet)',  description: 'Hospital disputes HMO rejection or shortfall' },
  { value: 'cancelled', label: 'Cancelled', color: 'var(--muted)',   description: 'Claim cancelled by hospital before HMO response' },
]

export const SHORTFALL_HANDLING_OPTIONS = [
  { value: 'patient_balance', label: 'Charge patient the shortfall',  description: 'Patient is billed for the difference' },
  { value: 'write_off',      label: 'Write off the shortfall',         description: 'Hospital absorbs the loss (with reason)' },
  { value: 'disputed',       label: 'Dispute / re-submit',             description: 'Hospital disputes the HMO decision' },
]

// Build a clinical_summary JSONB object suitable for the claim form PDF.
// Pulls diagnosis, procedures, drugs, attending physician from the
// invoice + its items + the patient record.
//
// Used by the auto-claim-file logic in CashierWorkspace and by the
// "Generate Claim Form" button in the Insurance module.
export function buildClinicalSummary({ invoice, invoiceItems = [], patient = null, attendingPhysician = null }) {
  if (!invoice) return null
  return {
    generated_at: new Date().toISOString(),
    invoice_number: invoice.invoice_number,
    invoice_total: Number(invoice.grand_total || invoice.amount || 0),
    hmo_amount: Number(invoice.hmo_amount || 0),
    patient_amount: Number(invoice.patient_amount || 0),
    coverage_percent: Number(invoice.hmo_coverage_percent || 0),
    attending_physician: attendingPhysician || null,
    patient: patient ? {
      full_name: patient.full_name,
      mrn: patient.patient_id || patient.hospital_number || null,
      phone: patient.phone || null,
      hmo_number: patient.hmo_number || null,
      hmo_provider: patient.hmo_provider || null,
    } : null,
    // Group items by category — claim form shows them as separate sections
    items: invoiceItems.map(it => ({
      name: it.item_name,
      quantity: Number(it.quantity || 1),
      unit_price: Number(it.unit_price || 0),
      total: Number(it.total || 0),
      category: it.category || null,
      source_module: it.source_module || null,
    })),
    totals: {
      consultations: invoiceItems
        .filter(it => ['consultation','Consultation'].includes(it.category))
        .reduce((s, it) => s + Number(it.total || 0), 0),
      lab_tests: invoiceItems
        .filter(it => ['lab','Lab'].includes(it.category))
        .reduce((s, it) => s + Number(it.total || 0), 0),
      drugs: invoiceItems
        .filter(it => ['drug','Drug','Medication','Medications'].includes(it.category))
        .reduce((s, it) => s + Number(it.total || 0), 0),
      procedures: invoiceItems
        .filter(it => ['procedure','Procedure'].includes(it.category))
        .reduce((s, it) => s + Number(it.total || 0), 0),
      bed_charges: invoiceItems
        .filter(it => ['bed','Bed'].includes(it.category))
        .reduce((s, it) => s + Number(it.total || 0), 0),
      other: invoiceItems
        .filter(it => !['consultation','Consultation','lab','Lab','drug','Drug','Medication','Medications','procedure','Procedure','bed','Bed'].includes(it.category))
        .reduce((s, it) => s + Number(it.total || 0), 0),
    },
  }
}

// ---------------------------------------------------------------------
// CLAIM STATUS UPDATE — atomic with audit trail
//
// Updates the claim's status + relevant timestamp columns, and inserts
// a row into claim_status_history. Both writes happen client-side;
// Phase 3+ would wrap this in a server-side RPC for atomicity.
//
// Returns: { success, error? }
// ---------------------------------------------------------------------

export async function updateClaimStatus({
  hospital, profile,
  claim,              // the insurance_claims row
  newStatus,          // 'submitted' | 'queried' | 'approved' | 'paid' | 'rejected' | 'disputed' | 'cancelled'
  reason = null,      // why the status changed
  metadata = {},      // structured details (approval_amount, query_reason, etc.)
  updateClaim,        // mutator from useOfflineTable('insurance_claims')
  addStatusHistory,   // mutator from useOfflineTable('claim_status_history')
  writeAudit,         // audit helper
}) {
  if (!claim?.id) return { success: false, error: 'No claim provided' }
  if (!CLAIM_STATUSES.find(s => s.value === newStatus)) {
    return { success: false, error: `Invalid status: ${newStatus}` }
  }

  const oldStatus = claim.status
  if (oldStatus === newStatus) {
    return { success: true, skipped: 'No status change' }
  }

  try {
    // 1. Update the claim with status + relevant timestamp columns
    const now = new Date().toISOString()
    const updates = { status: newStatus }
    if (newStatus === 'queried') {
      updates.queried_at = now
      updates.queried_by = profile?.id || null
      updates.queried_by_name = profile?.full_name || null
      if (reason) updates.query_reason = reason
      if (metadata.query_response) updates.query_response = metadata.query_response
    } else if (newStatus === 'approved') {
      updates.approved_at = now
      updates.approved_by = profile?.id || null
      updates.approved_by_name = profile?.full_name || null
      if (metadata.approved_amount != null) updates.approved_amount = Number(metadata.approved_amount)
    } else if (newStatus === 'paid') {
      updates.paid_at = now
      if (metadata.paid_amount != null) updates.paid_amount = Number(metadata.paid_amount)
      if (metadata.payment_reference) updates.payment_reference = metadata.payment_reference
      if (metadata.payment_date) updates.payment_date = metadata.payment_date
      // Compute shortfall if approved_amount exists
      const approved = Number(metadata.approved_amount ?? claim.approved_amount ?? claim.amount ?? 0)
      const paid = Number(metadata.paid_amount ?? 0)
      const shortfall = Math.max(0, approved - paid)
      updates.shortfall_amount = shortfall
    } else if (newStatus === 'rejected') {
      updates.rejected_at = now
      updates.rejected_by = profile?.id || null
      updates.rejected_by_name = profile?.full_name || null
      if (reason) updates.rejection_reason = reason
      if (metadata.rejection_code) updates.rejection_code = metadata.rejection_code
    }

    await updateClaim(claim.id, updates)

    // 2. Insert a row into claim_status_history
    await addStatusHistory({
      hospital_id: hospital.id,
      claim_id: claim.id,
      from_status: oldStatus,
      to_status: newStatus,
      changed_by: profile?.id || null,
      changed_by_name: profile?.full_name || null,
      changed_at: now,
      reason: reason || null,
      metadata: {
        ...metadata,
        claim_number: claim.claim_number,
        invoice_id: claim.invoice_id,
        provider: claim.provider,
      },
    })

    // 3. Emit an audit event
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: `claim.${newStatus}`,
      entityType: 'insurance_claim', entityId: claim.id,
      patientId: claim.patient_id || null,
      summary: `Claim ${claim.claim_number || claim.id.slice(0,8)} (${claim.provider || 'HMO'}) ${oldStatus} → ${newStatus}${reason ? ` — ${reason}` : ''}`,
      metadata: {
        claim_id: claim.id, claim_number: claim.claim_number,
        from_status: oldStatus, to_status: newStatus,
        reason, ...metadata,
      },
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not update claim status' }
  }
}

// ---------------------------------------------------------------------
// SHORTFALL HANDLING — what to do when HMO pays less than approved
//
// Options:
//   'patient_balance' — create a billable_charge on the patient for the
//                       shortfall amount (so it shows up in their next invoice)
//   'write_off'        — record the loss with a reason (no patient balance)
//   'disputed'         — set claim status back to 'disputed' for follow-up
//
// Returns: { success, error? }
// ---------------------------------------------------------------------

export async function handleClaimShortfall({
  hospital, profile,
  claim, shortfallHandling, notes = null,
  updateClaim, addBillableCharge, addStatusHistory, writeAudit,
}) {
  if (!claim?.id) return { success: false, error: 'No claim provided' }
  if (!SHORTFALL_HANDLING_OPTIONS.find(o => o.value === shortfallHandling)) {
    return { success: false, error: `Invalid shortfall handling: ${shortfallHandling}` }
  }
  const shortfall = Number(claim.shortfall_amount || 0)
  if (shortfall <= 0) {
    return { success: false, error: 'No shortfall to handle (shortfall_amount is 0)' }
  }

  try {
    const now = new Date().toISOString()

    // 1. Update the claim with shortfall handling info
    await updateClaim(claim.id, {
      shortfall_handling: shortfallHandling,
      shortfall_handled_at: now,
      shortfall_handled_by: profile?.id || null,
      shortfall_notes: notes || null,
      // If disputed, also change the claim status back to 'disputed'
      ...(shortfallHandling === 'disputed' ? { status: 'disputed' } : {}),
    })

    // 2. If patient_balance — create a billable_charge for the shortfall
    if (shortfallHandling === 'patient_balance') {
      await addBillableCharge({
        hospital_id: hospital.id,
        patient_id: claim.patient_id,
        patient_name: claim.patient_name,
        source_module: 'Insurance',
        source_transaction_id: `SHORTFALL-${claim.id.slice(0,8)}-${Date.now()}`,
        item_name: `HMO Shortfall — ${claim.provider || 'HMO'} (Claim ${claim.claim_number || claim.id.slice(0,8)})`,
        category: 'HMO Shortfall',
        quantity: 1,
        unit_price: shortfall,
        total: shortfall,
        status: 'pending',
        created_by: profile?.id || null,
      })
    }

    // 3. Insert a status history row
    await addStatusHistory({
      hospital_id: hospital.id,
      claim_id: claim.id,
      from_status: claim.status,
      to_status: shortfallHandling === 'disputed' ? 'disputed' : claim.status,
      changed_by: profile?.id || null,
      changed_by_name: profile?.full_name || null,
      changed_at: now,
      reason: `Shortfall of ₦${shortfall.toFixed(2)} handled as: ${shortfallHandling}${notes ? ` — ${notes}` : ''}`,
      metadata: {
        shortfall_amount: shortfall,
        shortfall_handling: shortfallHandling,
        notes: notes || null,
      },
    })

    // 4. Audit event
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: `claim.shortfall_${shortfallHandling}`,
      entityType: 'insurance_claim', entityId: claim.id,
      patientId: claim.patient_id || null,
      summary: `Shortfall ₦${shortfall.toFixed(2)} on claim ${claim.claim_number || claim.id.slice(0,8)} (${claim.provider}) handled as: ${shortfallHandling}${notes ? ` — ${notes}` : ''}`,
      metadata: {
        claim_id: claim.id, claim_number: claim.claim_number,
        shortfall_amount: shortfall, shortfall_handling: shortfallHandling, notes: notes || null,
      },
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not handle shortfall' }
  }
}

// ---------------------------------------------------------------------
// CLAIM FORM PDF — NHIS-style printable claim form
//
// Opens a new browser window with a printable claim form containing:
//   - Hospital logo + name + address
//   - Patient details (name, MRN, HMO number, phone)
//   - HMO details (provider, policy number, authorization code)
//   - Diagnosis + procedures + drugs + attending physician
//   - Itemized services with quantities and prices
//   - Totals: subtotal, HMO amount, patient amount
//   - Signature lines (attending physician, hospital stamp, HMO stamp)
//
// No return value — opens a print window.
// ---------------------------------------------------------------------

export function generateClaimFormPDF({ claim, invoice, invoiceItems, patient, hospital, profile }) {
  const win = window.open('', '_blank')
  if (!win) {
    alert('Please allow popups to generate the claim form PDF.')
    return
  }

  const clinicalSummary = claim.clinical_summary || buildClinicalSummary({ invoice, invoiceItems, patient, attendingPhysician: claim.attending_physician })
  const totals = clinicalSummary?.totals || {}

  const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-NG') : '—'
  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const itemRows = (invoiceItems || []).map(it => `
    <tr>
      <td>${escapeHtml(it.item_name)}</td>
      <td>${escapeHtml(it.category || '—')}</td>
      <td style="text-align:center">${escapeHtml(it.quantity)}</td>
      <td style="text-align:right">${formatMoney(it.unit_price)}</td>
      <td style="text-align:right">${formatMoney(it.total)}</td>
    </tr>
  `).join('')

  const html = `
    <html><head><title>Claim Form — ${escapeHtml(claim.claim_number || 'CLM')}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 40px; color: #111; max-width: 800px; margin: auto; font-size: 12px; }
      .header { text-align: center; border-bottom: 3px solid #0f172a; padding-bottom: 16px; margin-bottom: 20px; }
      .h-name { font-size: 22px; font-weight: bold; text-transform: uppercase; }
      .h-meta { font-size: 12px; color: #555; margin-top: 3px; }
      h1 { text-align: center; font-size: 18px; margin: 20px 0; letter-spacing: 1px; }
      .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
      .box { background: #f8f9fa; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; }
      .box h3 { margin: 0 0 8px 0; font-size: 11px; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
      .box div { margin-bottom: 3px; }
      .totals { background: #f0f9ff; padding: 12px; border-radius: 6px; border: 1px solid #bae6fd; margin: 16px 0; }
      .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
      .totals .grand { font-weight: bold; font-size: 14px; border-top: 2px solid #0f172a; padding-top: 6px; margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; margin: 16px 0; }
      th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
      th { background: #f1f5f9; font-size: 11px; text-transform: uppercase; }
      .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; margin-top: 60px; }
      .sign-line { border-top: 1px solid #0f172a; padding-top: 4px; text-align: center; font-size: 11px; color: #64748b; }
      .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 10px; }
      .claim-number { background: #fef3c7; padding: 6px 12px; border-radius: 4px; display: inline-block; font-weight: bold; font-size: 13px; }
    </style></head><body>
      <div class="header">
        ${hospital?.logo_url ? `<img src="${escapeHtml(hospital.logo_url)}" alt="logo" style="max-width: 100px; max-height: 70px; margin: 0 auto 8px; display: block;" />` : ''}
        <div class="h-name">${escapeHtml(hospital?.name || 'Hospital')}</div>
        ${hospital?.address ? `<div class="h-meta">${escapeHtml(hospital.address)}</div>` : ''}
        ${hospital?.phone ? `<div class="h-meta">Tel: ${escapeHtml(hospital.phone)}</div>` : ''}
      </div>

      <h1>HMO / INSURANCE CLAIM FORM</h1>

      <div style="text-align: center; margin-bottom: 16px;">
        <span class="claim-number">Claim #: ${escapeHtml(claim.claim_number || '—')}</span>
      </div>

      <div class="grid-2">
        <div class="box">
          <h3>Patient Details</h3>
          <div><strong>Name:</strong> ${escapeHtml(patient?.full_name || claim.patient_name || '—')}</div>
          <div><strong>MRN:</strong> ${escapeHtml(patient?.patient_id || patient?.hospital_number || '—')}</div>
          <div><strong>Phone:</strong> ${escapeHtml(patient?.phone || '—')}</div>
          <div><strong>HMO Number:</strong> ${escapeHtml(patient?.hmo_number || claim.policy_number || '—')}</div>
        </div>
        <div class="box">
          <h3>HMO / Insurance Details</h3>
          <div><strong>Provider:</strong> ${escapeHtml(claim.provider || '—')}</div>
          <div><strong>Policy Number:</strong> ${escapeHtml(claim.policy_number || '—')}</div>
          <div><strong>Authorization Code:</strong> ${escapeHtml(claim.authorization_code || '—')}</div>
          <div><strong>Authorization Date:</strong> ${formatDate(claim.authorization_date)}</div>
        </div>
      </div>

      <div class="box">
        <h3>Clinical Summary</h3>
        <div><strong>Attending Physician:</strong> ${escapeHtml(claim.attending_physician || '—')}</div>
        <div><strong>Date of Service:</strong> ${formatDate(invoice?.created_at || claim.created_at)}</div>
        <div><strong>Invoice Number:</strong> ${escapeHtml(invoice?.invoice_number || '—')}</div>
      </div>

      <h3 style="margin-top: 20px;">Services Rendered</h3>
      <table>
        <thead><tr><th>Description</th><th>Category</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${itemRows || '<tr><td colspan="5">No items recorded</td></tr>'}</tbody>
      </table>

      <div class="totals">
        <div><span>Consultations</span><span>${formatMoney(totals.consultations || 0)}</span></div>
        <div><span>Laboratory Tests</span><span>${formatMoney(totals.lab_tests || 0)}</span></div>
        <div><span>Pharmacy / Drugs</span><span>${formatMoney(totals.drugs || 0)}</span></div>
        <div><span>Procedures</span><span>${formatMoney(totals.procedures || 0)}</span></div>
        <div><span>Bed / Ward Charges</span><span>${formatMoney(totals.bed_charges || 0)}</span></div>
        <div><span>Other Services</span><span>${formatMoney(totals.other || 0)}</span></div>
        <div class="grand"><span>Total Invoice</span><span>${formatMoney(invoice?.grand_total || invoice?.amount || 0)}</span></div>
        <div><span>HMO Covers (${invoice?.hmo_coverage_percent || 0}%)</span><span>${formatMoney(claim.amount)}</span></div>
        <div><span>Patient Pays</span><span>${formatMoney(invoice?.patient_amount || 0)}</span></div>
      </div>

      <div class="signatures">
        <div><div style="height: 40px;"></div><div class="sign-line">Attending Physician</div></div>
        <div><div style="height: 40px;"></div><div class="sign-line">Hospital Stamp &amp; Signature</div></div>
        <div><div style="height: 40px;"></div><div class="sign-line">HMO Authorizing Officer</div></div>
      </div>

      <div class="footer">
        Generated on ${new Date().toLocaleString('en-NG')} by ${escapeHtml(profile?.full_name || 'System')}<br/>
        This claim form is for ${escapeHtml(claim.provider || 'the HMO')} — please submit within 30 days of service.
      </div>
    </body></html>`

  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 500)
}

// ---------------------------------------------------------------------
// BATCH CLAIM SUBMISSION — submit multiple claims to HMO at once
//
// Marks all selected claims with the same batch_id + sets status to
// 'submitted' (if not already). Useful when generating a weekly batch
// of claims to send to an HMO.
//
// Returns: { success, batchId?, submittedCount?, error? }
// ---------------------------------------------------------------------

export async function batchSubmitClaims({
  hospital, profile,
  claims,                  // array of insurance_claims rows
  updateClaim,             // mutator (called per claim)
  addStatusHistory,         // mutator
  writeAudit,
}) {
  if (!claims?.length) return { success: false, error: 'No claims selected' }

  // Generate a batch_id (one UUID for the whole batch)
  const batchId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const now = new Date().toISOString()
  let submittedCount = 0

  try {
    for (const claim of claims) {
      // Skip claims that are already paid/approved/rejected — only submit
      // claims that are in draft/queried/disputed/cancelled states
      if (['paid', 'approved', 'rejected'].includes(claim.status)) continue

      const oldStatus = claim.status
      await updateClaim(claim.id, {
        status: 'submitted',
        submitted_at: claim.submitted_at || now,
        batch_id: batchId,
      })

      await addStatusHistory({
        hospital_id: hospital.id,
        claim_id: claim.id,
        from_status: oldStatus,
        to_status: 'submitted',
        changed_by: profile?.id || null,
        changed_by_name: profile?.full_name || null,
        changed_at: now,
        reason: `Batch submission (batch ${batchId.slice(0,8)})`,
        metadata: { batch_id: batchId, claim_number: claim.claim_number, provider: claim.provider },
      })

      submittedCount++
    }

    if (submittedCount === 0) {
      return { success: false, error: 'None of the selected claims are in a submittable state' }
    }

    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: 'claim.batch_submitted',
      entityType: 'insurance_claim', entityId: null,
      summary: `Batch submitted ${submittedCount} claim(s) to ${claims[0]?.provider || 'HMO'} (batch ${batchId.slice(0,8)})`,
      metadata: {
        batch_id: batchId,
        claim_ids: claims.map(c => c.id),
        claim_numbers: claims.map(c => c.claim_number).filter(Boolean),
        provider: claims[0]?.provider,
        submitted_count: submittedCount,
      },
    })

    return { success: true, batchId, submittedCount }
  } catch (err) {
    return { success: false, error: err.message || 'Could not batch submit claims' }
  }
}

// =====================================================================
// PHASE 4 — Approvals, Recurring Expenses, Financial Reports,
// End-of-Day Reconciliation, Credit Control Rules
// =====================================================================

// ---------------------------------------------------------------------
// CONSTANTS — Phase 4
// ---------------------------------------------------------------------

export const APPROVAL_REQUEST_TYPES = [
  { value: 'discount',                 label: 'Discount',         description: 'Discount applied to an invoice above the approval threshold' },
  { value: 'write_off',                label: 'Write-off',       description: 'Invoice written off as bad debt above the threshold' },
  { value: 'refund',                    label: 'Refund',          description: 'Cash/wallet refund to patient above the threshold' },
  { value: 'credit_note',              label: 'Credit Note',     description: 'Credit note issued above the threshold' },
  { value: 'expense',                   label: 'Expense',        description: 'Hospital expense above the threshold' },
  { value: 'claim_resubmission',        label: 'Claim Re-submit', description: 'HMO claim being re-submitted after rejection' },
  { value: 'registration_fee_waiver',   label: 'Reg Fee Waiver',  description: 'Registration fee waived (above threshold)' },
  { value: 'other',                     label: 'Other',           description: 'Any other action requiring approval' },
]

export const APPROVAL_STATUSES = [
  { value: 'pending',   label: 'Pending',   color: 'var(--gold)' },
  { value: 'approved',  label: 'Approved', color: 'var(--teal)' },
  { value: 'rejected',  label: 'Rejected', color: 'var(--danger)' },
  { value: 'cancelled', label: 'Cancelled', color: 'var(--muted)' },
  { value: 'expired',   label: 'Expired',  color: 'var(--muted)' },
]

export const RECURRING_FREQUENCIES = [
  { value: 'weekly',    label: 'Weekly' },
  { value: 'monthly',   label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly',    label: 'Yearly' },
]

export const CREDIT_CONTROL_ACTIONS = [
  { value: 'warn',                  label: 'Warn only',                description: 'Show a warning banner but allow the action to proceed' },
  { value: 'block',                 label: 'Block',                    description: 'Hard block — action is prevented entirely' },
  { value: 'block_with_override',  label: 'Block with override',       description: 'Block unless user has override role (admin/owner)' },
]

export const EXPENSE_CATEGORIES = [
  'Salaries & Wages', 'Rent', 'Utilities', 'Medical Supplies', 'Office Supplies',
  'Equipment Purchase', 'Equipment Maintenance', 'Cleaning & Hygiene',
  'Transport / Fuel', 'Bank Charges', 'Marketing', 'Miscellaneous',
]

// ---------------------------------------------------------------------
// APPROVAL WORKFLOW
// ---------------------------------------------------------------------

// Create an approval request. Returns { success, approval? }.
// The caller is responsible for performing the actual action AFTER
// the approval comes through (use pollApprovalStatus or listen on
// realtime — see Phase 4 README).
export async function requestApproval({
  hospital, profile,
  requestType,           // one of APPROVAL_REQUEST_TYPES values
  entityType,             // e.g. 'invoice', 'expense', 'credit_note'
  entityId = null,        // optional FK to the entity (may be null if not yet created)
  amount,                 // amount being approved (for threshold checks)
  reason,                 // why this needs approval
  approverRole = 'admin', // who can approve (default admin+owner)
  payload = {},           // structured details for the action
  addApproval,            // mutator from useOfflineTable('approval_requests')
  writeAudit,
}) {
  if (!hospital?.id || !requestType || !entityType || !reason?.trim()) {
    return { success: false, error: 'Missing required fields' }
  }
  try {
    const approval = await addApproval({
      hospital_id: hospital.id,
      request_type: requestType,
      entity_type: entityType,
      entity_id: entityId,
      amount: Number(amount) || 0,
      requested_by: profile?.id || null,
      requested_by_name: profile?.full_name || null,
      reason: reason.trim(),
      approver_role: approverRole,
      payload,
      status: 'pending',
    })
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: `approval.requested`,
      entityType: 'approval_request', entityId: approval?.id || null,
      summary: `Approval requested: ${requestType} for ${formatMoney(amount)} — ${reason.trim()}`,
      metadata: { request_type: requestType, entity_type: entityType, entity_id: entityId, amount, reason: reason.trim() },
    })
    return { success: true, approval }
  } catch (err) {
    return { success: false, error: err.message || 'Could not create approval request' }
  }
}

// Approve an approval request. Returns { success, error? }.
export async function approveApprovalRequest({
  hospital, profile,
  approval,              // the approval_requests row
  approvalReason = null,  // optional reason from the approver
  updateApproval,         // mutator
  writeAudit,
}) {
  if (!approval?.id) return { success: false, error: 'No approval provided' }
  if (approval.status !== 'pending') return { success: false, error: `Cannot approve a ${approval.status} request` }
  try {
    const now = new Date().toISOString()
    await updateApproval(approval.id, {
      status: 'approved',
      approver_id: profile?.id || null,
      approver_name: profile?.full_name || null,
      approved_at: now,
      approval_reason: approvalReason?.trim() || null,
      actioned_at: now,
    })
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: `approval.approved`,
      entityType: 'approval_request', entityId: approval.id,
      summary: `Approved ${approval.request_type} request for ${formatMoney(approval.amount)}${approvalReason ? ` — ${approvalReason}` : ''}`,
      metadata: { request_type: approval.request_type, entity_type: approval.entity_type, amount: approval.amount, reason: approvalReason },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not approve' }
  }
}

// Reject an approval request. Returns { success, error? }.
export async function rejectApprovalRequest({
  hospital, profile,
  approval,
  rejectionReason,  // required
  updateApproval,
  writeAudit,
}) {
  if (!approval?.id) return { success: false, error: 'No approval provided' }
  if (approval.status !== 'pending') return { success: false, error: `Cannot reject a ${approval.status} request` }
  if (!rejectionReason?.trim()) return { success: false, error: 'Rejection reason is required' }
  try {
    const now = new Date().toISOString()
    await updateApproval(approval.id, {
      status: 'rejected',
      approver_id: profile?.id || null,
      approver_name: profile?.full_name || null,
      approved_at: now,
      rejection_reason: rejectionReason.trim(),
      actioned_at: now,
    })
    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: `approval.rejected`,
      entityType: 'approval_request', entityId: approval.id,
      summary: `Rejected ${approval.request_type} request for ${formatMoney(approval.amount)} — ${rejectionReason.trim()}`,
      metadata: { request_type: approval.request_type, entity_type: approval.entity_type, amount: approval.amount, rejection_reason: rejectionReason.trim() },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Could not reject' }
  }
}

// ---------------------------------------------------------------------
// RECURRING EXPENSES
// ---------------------------------------------------------------------

// Post a recurring expense NOW — creates a hospital_expenses row using
// the template, then advances next_due_date by the frequency.
//
// Returns: { success, expense?, error? }
export async function postRecurringExpense({
  hospital, profile,
  recurring,             // the recurring_expenses row
  addExpense,             // mutator from useOfflineTable('hospital_expenses')
  updateRecurring,       // mutator from useOfflineTable('recurring_expenses')
  writeAudit,
}) {
  if (!recurring?.id) return { success: false, error: 'No recurring expense provided' }
  if (!recurring.is_active) return { success: false, error: 'Recurring expense is not active' }
  try {
    // 1. Create the expense row
    const reference = recurring.reference_template
      ? recurring.reference_template
          .replace('{YYYY}', String(new Date().getFullYear()))
          .replace('{MM}', String(new Date().getMonth() + 1).padStart(2, '0'))
          .replace('{DD}', String(new Date().getDate()).padStart(2, '0'))
      : null

    const expense = await addExpense({
      hospital_id: hospital.id,
      category: recurring.category,
      description: recurring.description,
      amount: recurring.amount,
      payment_method: recurring.payment_method,
      reference_number: reference,
      paid_at: new Date().toISOString(),
      recorded_by: profile?.id || null,
      recorded_by_name: profile?.full_name || null,
    })

    // 2. Advance next_due_date by the frequency
    const nextDue = computeNextDueDate(recurring.next_due_date, recurring.frequency)

    // 3. Update the recurring template
    await updateRecurring(recurring.id, {
      last_posted_at: new Date().toISOString(),
      last_posted_expense_id: expense?.id || null,
      post_count: (recurring.post_count || 0) + 1,
      next_due_date: nextDue.toISOString().slice(0, 10),
      // If end_date has passed, mark as inactive
      ...(recurring.end_date && new Date(nextDue) > new Date(recurring.end_date) ? { is_active: false } : {}),
    })

    writeAudit?.({
      hospitalId: hospital.id, actor: profile,
      action: `recurring_expense.posted`,
      entityType: 'recurring_expense', entityId: recurring.id,
      summary: `Posted recurring expense "${recurring.description}" — ${formatMoney(recurring.amount)} (${recurring.frequency})`,
      metadata: {
        recurring_id: recurring.id,
        expense_id: expense?.id,
        amount: recurring.amount,
        frequency: recurring.frequency,
        post_count: (recurring.post_count || 0) + 1,
      },
    })

    return { success: true, expense }
  } catch (err) {
    return { success: false, error: err.message || 'Could not post recurring expense' }
  }
}

// Compute the next due date given a current due date + frequency.
function computeNextDueDate(currentDue, frequency) {
  const d = new Date(currentDue)
  switch (frequency) {
    case 'weekly':    d.setDate(d.getDate() + 7); break
    case 'monthly':   d.setMonth(d.getMonth() + 1); break
    case 'quarterly': d.setMonth(d.getMonth() + 3); break
    case 'yearly':    d.setFullYear(d.getFullYear() + 1); break
  }
  return d
}

// ---------------------------------------------------------------------
// FINANCIAL REPORTS — client-side computation
// ---------------------------------------------------------------------

// Report 1: Daily Collection Summary
// Returns: { byMethod: [{ method, count, total }], byCashier: [{ cashierName, count, total }] }
export function getDailyCollectionSummary({ payments, date = new Date() }) {
  const targetDateStr = new Date(date).toDateString()
  const todayPayments = (payments || []).filter(p =>
    p.status !== 'reversed' &&
    new Date(p.created_at).toDateString() === targetDateStr
  )

  const byMethod = {}
  const byCashier = {}
  for (const p of todayPayments) {
    const method = p.method || 'Cash'
    const cashier = p.recorded_by_name || p.received_by_name || 'Unknown'
    if (!byMethod[method]) byMethod[method] = { method, count: 0, total: 0 }
    if (!byCashier[cashier]) byCashier[cashier] = { cashierName: cashier, count: 0, total: 0 }
    byMethod[method].count++
    byMethod[method].total += Number(p.amount || 0)
    byCashier[cashier].count++
    byCashier[cashier].total += Number(p.amount || 0)
  }
  return {
    byMethod: Object.values(byMethod).sort((a, b) => b.total - a.total),
    byCashier: Object.values(byCashier).sort((a, b) => b.total - a.total),
    totalCount: todayPayments.length,
    totalAmount: todayPayments.reduce((s, p) => s + Number(p.amount || 0), 0),
  }
}

// Report 2: Outstanding Invoices & Aging
// Buckets: 0-30, 31-60, 61-90, 90+ days
export function getOutstandingAging({ invoices, asOfDate = new Date() }) {
  const asOfMs = new Date(asOfDate).getTime()
  const outstanding = (invoices || []).filter(i =>
    i.draft_status !== 'cancelled' &&
    i.draft_status !== 'written_off' &&
    Number(i.balance || 0) > 0.001
  )

  const buckets = {
    '0-30':   { label: '0–30 days',   total: 0, count: 0, invoices: [] },
    '31-60':  { label: '31–60 days',  total: 0, count: 0, invoices: [] },
    '61-90':  { label: '61–90 days',  total: 0, count: 0, invoices: [] },
    '90+':    { label: '90+ days',     total: 0, count: 0, invoices: [] },
  }

  for (const inv of outstanding) {
    const ageDays = Math.floor((asOfMs - new Date(inv.created_at).getTime()) / (1000 * 60 * 60 * 24))
    let bucket
    if (ageDays <= 30) bucket = buckets['0-30']
    else if (ageDays <= 60) bucket = buckets['31-60']
    else if (ageDays <= 90) bucket = buckets['61-90']
    else bucket = buckets['90+']
    bucket.total += Number(inv.balance || 0)
    bucket.count++
    bucket.invoices.push({ ...inv, ageDays })
  }

  return {
    buckets,
    totalOutstanding: outstanding.reduce((s, i) => s + Number(i.balance || 0), 0),
    totalInvoices: outstanding.length,
  }
}

// Report 3: Revenue by Department / Service
// Uses billable_charges.category to group revenue.
export function getRevenueByDepartment({ billableCharges, invoices, periodFrom, periodTo }) {
  const fromMs = periodFrom ? new Date(periodFrom).getTime() : 0
  const toMs = periodTo ? new Date(periodTo + 'T23:59:59').getTime() : Date.now()

  // Map billable_charge categories to "departments"
  const categoryToDept = {
    'Consultation': 'Consultations',
    'Lab': 'Laboratory',
    'Radiology': 'Radiology',
    'Pharmacy': 'Pharmacy',
    'Drug': 'Pharmacy',
    'Medication': 'Pharmacy',
    'Procedure': 'Procedures',
    'Bed': 'IPD / Ward',
    'Service': 'Other Services',
    'ANC': 'ANC / Maternity',
    'Registration': 'Registration',
    'Manual': 'Other Services',
    'HMO Shortfall': 'HMO Shortfalls',
    'Insurance': 'Insurance',
  }

  const deptTotals = {}
  for (const c of (billableCharges || [])) {
    if (c.status !== 'invoiced') continue
    const chargeMs = new Date(c.created_at).getTime()
    if (chargeMs < fromMs || chargeMs > toMs) continue
    const dept = categoryToDept[c.category] || 'Other'
    if (!deptTotals[dept]) deptTotals[dept] = { department: dept, total: 0, count: 0 }
    deptTotals[dept].total += Number(c.total || 0)
    deptTotals[dept].count++
  }

  return {
    byDepartment: Object.values(deptTotals).sort((a, b) => b.total - a.total),
    totalRevenue: Object.values(deptTotals).reduce((s, d) => s + d.total, 0),
    totalCount: Object.values(deptTotals).reduce((s, d) => s + d.count, 0),
  }
}

// Report 4: HMO Claims Status & Recovery
export function getClaimsStatusSummary({ claims, periodFrom, periodTo }) {
  const fromMs = periodFrom ? new Date(periodFrom).getTime() : 0
  const toMs = periodTo ? new Date(periodTo + 'T23:59:59').getTime() : Date.now()

  const inPeriod = (claims || []).filter(c => {
    const ms = new Date(c.submitted_at || c.created_at).getTime()
    return ms >= fromMs && ms <= toMs
  })

  const byStatus = {}
  const byProvider = {}
  for (const c of inPeriod) {
    const status = c.status || 'submitted'
    if (!byStatus[status]) byStatus[status] = { status, count: 0, claimed: 0, approved: 0, paid: 0 }
    byStatus[status].count++
    byStatus[status].claimed += Number(c.amount || 0)
    byStatus[status].approved += Number(c.approved_amount || 0)
    byStatus[status].paid += Number(c.paid_amount || 0)

    const provider = c.provider || 'Unknown'
    if (!byProvider[provider]) byProvider[provider] = { provider, count: 0, claimed: 0, approved: 0, paid: 0, shortfall: 0 }
    byProvider[provider].count++
    byProvider[provider].claimed += Number(c.amount || 0)
    byProvider[provider].approved += Number(c.approved_amount || 0)
    byProvider[provider].paid += Number(c.paid_amount || 0)
    byProvider[provider].shortfall += Number(c.shortfall_amount || 0)
  }

  return {
    byStatus: Object.values(byStatus),
    byProvider: Object.values(byProvider).sort((a, b) => b.claimed - a.claimed),
    totalClaimed: inPeriod.reduce((s, c) => s + Number(c.amount || 0), 0),
    totalApproved: inPeriod.reduce((s, c) => s + Number(c.approved_amount || 0), 0),
    totalPaid: inPeriod.reduce((s, c) => s + Number(c.paid_amount || 0), 0),
    totalShortfall: inPeriod.reduce((s, c) => s + Number(c.shortfall_amount || 0), 0),
    totalClaims: inPeriod.length,
  }
}

// Report 5: Expense vs Revenue (P&L summary)
export function getExpenseVsRevenue({ invoices, expenses, periodFrom, periodTo }) {
  const fromMs = periodFrom ? new Date(periodFrom).getTime() : 0
  const toMs = periodTo ? new Date(periodTo + 'T23:59:59').getTime() : Date.now()

  const periodInvoices = (invoices || []).filter(i => {
    const ms = new Date(i.created_at).getTime()
    return ms >= fromMs && ms <= toMs && i.draft_status !== 'cancelled'
  })
  const periodExpenses = (expenses || []).filter(e => {
    const ms = new Date(e.paid_at || e.created_at).getTime()
    return ms >= fromMs && ms <= toMs
  })

  const revenue = periodInvoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0)
  const invoiced = periodInvoices.reduce((s, i) => s + Number(i.grand_total || i.amount || 0), 0)
  const outstanding = periodInvoices.reduce((s, i) => s + Number(i.balance || 0), 0)
  const totalExpenses = periodExpenses.reduce((s, e) => s + Number(e.amount || 0), 0)
  const netProfit = revenue - totalExpenses

  // Group expenses by category
  const byCategory = {}
  for (const e of periodExpenses) {
    const cat = e.category || 'Miscellaneous'
    if (!byCategory[cat]) byCategory[cat] = { category: cat, total: 0, count: 0 }
    byCategory[cat].total += Number(e.amount || 0)
    byCategory[cat].count++
  }

  return {
    revenue,
    invoiced,
    outstanding,
    totalExpenses,
    netProfit,
    margin: revenue > 0 ? (netProfit / revenue) * 100 : 0,
    expensesByCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
    invoiceCount: periodInvoices.length,
    expenseCount: periodExpenses.length,
  }
}

// Report 6: Patient Statement (already in Phase 2 — re-exported here for convenience)
// Use computePatientStatement() from Phase 2.

// ---------------------------------------------------------------------
// CREDIT CONTROL — evaluate whether a patient should be blocked
// ---------------------------------------------------------------------

// Evaluate credit control rules for a patient.
// Returns: { blocked: bool, action: 'warn'|'block'|'block_with_override'|'none', reason, ruleId?, outstandingBalance, oldestInvoiceAgeDays }
export function evaluateCreditControl({ patient, invoices, rules }) {
  if (!patient) return { blocked: false, action: 'none', reason: null }
  const activeRules = (rules || []).filter(r => r.is_active)
  if (activeRules.length === 0) return { blocked: false, action: 'none', reason: null }

  // Compute patient's outstanding balance + oldest unpaid invoice age
  const patientOutstanding = (invoices || [])
    .filter(i =>
      i.patient_id === patient.id &&
      i.draft_status !== 'cancelled' &&
      i.draft_status !== 'written_off' &&
      Number(i.balance || 0) > 0.001
    )
  const outstandingBalance = patientOutstanding.reduce((s, i) => s + Number(i.balance || 0), 0)
  if (patientOutstanding.length === 0) {
    return { blocked: false, action: 'none', reason: null, outstandingBalance: 0, oldestInvoiceAgeDays: 0 }
  }
  const oldestInvoice = patientOutstanding.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
  const oldestInvoiceAgeDays = Math.floor((Date.now() - new Date(oldestInvoice.created_at).getTime()) / (1000 * 60 * 60 * 24))

  // Find the first matching rule
  for (const rule of activeRules) {
    // Check if rule applies to this patient's category
    if (!rule.applies_to_all && !rule.applies_to_categories?.includes(patient.category || 'outpatient')) continue

    if (outstandingBalance >= Number(rule.outstanding_balance_threshold || 0) &&
        oldestInvoiceAgeDays >= Number(rule.oldest_invoice_age_days || 0)) {
      return {
        blocked: rule.action !== 'warn',
        action: rule.action,
        reason: `Outstanding balance ${formatMoney(outstandingBalance)} with oldest unpaid invoice ${oldestInvoiceAgeDays} days old exceeds threshold (${formatMoney(rule.outstanding_balance_threshold)} / ${rule.oldest_invoice_age_days} days)`,
        ruleId: rule.id,
        ruleName: rule.name,
        outstandingBalance,
        oldestInvoiceAgeDays,
      }
    }
  }

  return { blocked: false, action: 'none', reason: null, outstandingBalance, oldestInvoiceAgeDays }
}

// Check if a patient has any active credit block (manual or rule-triggered)
export function getActivePatientBlock(patientId, blocks) {
  return (blocks || []).find(b => b.patient_id === patientId && b.status === 'active')
}

// =====================================================================
// DISCOUNT MANAGEMENT — integrated with the Billing module.
// Server-authoritative: every apply/ approve call goes through a
// SECURITY DEFINER RPC (111_billing_discounts_and_calculator.sql) that
// re-validates hospital_id, recomputes totals inside a transaction, and
// writes the audit row. The frontend value is only a preview.
// =====================================================================

// Read the per-hospital discount settings (auto-creates defaults if
// the hospital has no row yet). Returns null if offline / on error so
// callers fall back to sensible defaults.
export async function fetchDiscountSettings(hospitalId) {
  if (!hospitalId) return null
  try {
    const { data, error } = await supabase.rpc('get_discount_settings', { p_hospital_id: hospitalId })
    if (error) { console.warn('get_discount_settings RPC failed:', error); return null }
    return data
  } catch (e) {
    console.warn('fetchDiscountSettings failed (offline?):', e)
    return null
  }
}

// Default settings used when the RPC is unreachable (offline). Matches
// the SQL defaults so the cashier's self-apply limit is conservative.
export const DEFAULT_DISCOUNT_SETTINGS = {
  max_cashier_discount_percent: 5,
  review_threshold_percent: 20,
  max_invoice_discount_amount: 0,
  enable_item_discounts: true,
  enable_invoice_discounts: true,
  requires_reason: true,
  approver_roles: ['admin', 'owner'],
}

// Apply a discount to an invoice via the authoritative RPC.
// payload: { invoiceId, type:'percent'|'fixed'|'item', value, reason,
//            itemDiscounts?:[{item_id, amount, percent}] }
// Returns { ok, error?, ...computed } from the server.
export async function applyInvoiceDiscount(payload) {
  const { invoiceId, type, value, reason, itemDiscounts } = payload || {}
  if (!invoiceId || !type) return { ok: false, error: 'Missing invoice or discount type' }
  try {
    const { data, error } = await supabase.rpc('apply_invoice_discount', {
      p_invoice_id: invoiceId,
      p_discount_type: type,
      p_discount_value: Number(value) || 0,
      p_reason: reason || null,
      p_item_discounts: type === 'item' ? (itemDiscounts || []) : null,
    })
    if (error) return { ok: false, error: error.message || String(error) }
    return data || { ok: false, error: 'No response from server' }
  } catch (e) {
    return { ok: false, error: e?.message || 'Network error applying discount' }
  }
}

// Submit a discount for supervisor approval (cashier over their limit).
// payload: { invoiceId, type, value, reason }
export async function createDiscountApprovalRequest(payload) {
  const { invoiceId, type, value, reason } = payload || {}
  if (!invoiceId || !type) return { ok: false, error: 'Missing invoice or discount type' }
  try {
    const { data, error } = await supabase.rpc('create_discount_approval_request', {
      p_invoice_id: invoiceId,
      p_discount_type: type,
      p_discount_value: Number(value) || 0,
      p_reason: reason || null,
    })
    if (error) return { ok: false, error: error.message || String(error) }
    return data || { ok: false, error: 'No response from server' }
  } catch (e) {
    return { ok: false, error: e?.message || 'Network error submitting approval' }
  }
}

// Apply a previously-approved discount request. Called by the supervisor
// from the ApprovalQueueModal: on approve, re-run apply_invoice_discount
// passing the approval_request_id so the RPC verifies status='approved'
// and stamps the approver on the invoice.
export async function applyApprovedDiscount(invoiceId, approvalRequestId, reason) {
  if (!invoiceId || !approvalRequestId) return { ok: false, error: 'Missing invoice or approval id' }
  try {
    // Fetch the approved request to recover the discount type/value.
    const { data: req, error: e1 } = await supabase
      .from('approval_requests')
      .select('payload, status, amount')
      .eq('id', approvalRequestId)
      .single()
    if (e1) return { ok: false, error: e1.message }
    if (!req) return { ok: false, error: 'Approval request not found' }
    if (req.status !== 'approved') return { ok: false, error: 'Discount has not been approved' }
    const p = req.payload || {}
    const { data, error } = await supabase.rpc('apply_invoice_discount', {
      p_invoice_id: invoiceId,
      p_discount_type: p.discount_type || 'fixed',
      p_discount_value: Number(p.discount_value || req.amount || 0),
      p_reason: reason || p.reason || 'Approved discount',
      p_approval_request_id: approvalRequestId,
    })
    if (error) return { ok: false, error: error.message }
    return data || { ok: false, error: 'No response from server' }
  } catch (e) {
    return { ok: false, error: e?.message || 'Network error applying approved discount' }
  }
}

// =====================================================================
// DISCOUNT REPORTS — pure client-side aggregator (matches the existing
// report-aggregator pattern in this file: getDailyCollectionSummary etc.).
// Feeds the new "Discounts" tab in Reports.jsx.
// =====================================================================
export function getDiscountSummary({ invoices, approvals, periodFrom, periodTo }) {
  const from = periodFrom ? new Date(periodFrom) : null
  const to = periodTo ? new Date(periodTo) : null
  const inRange = (d) => {
    if (!d) return false
    const t = new Date(d).getTime()
    if (from && t < from.getTime()) return false
    if (to && t > to.getTime() + 86400000) return false
    return true
  }

  // Discounts applied = invoices with discount_type <> 'none' and a
  // non-zero discount, created/updated within the period. We use
  // updated_at so re-Discounting still shows in the right period.
  const discounted = (invoices || []).filter(inv =>
    inv.discount_type && inv.discount_type !== 'none' &&
    Number(inv.discount || 0) > 0 &&
    inRange(inv.updated_at || inv.created_at)
  )

  const totalDiscountAmount = discounted.reduce((s, i) => s + Number(i.discount || 0), 0)
  const totalOriginalSubtotal = discounted.reduce((s, i) => s + Number(i.subtotal || 0), 0)
  const totalFinalPayable = discounted.reduce((s, i) => s + Number(i.grand_total || 0), 0)

  // By cashier (requested_by_name on approval_requests, or the audit
  // trail). We approximate via approval_requests payload.requested_by_name.
  const discountReqs = (approvals || []).filter(a =>
    a.request_type === 'discount' && inRange(a.requested_at || a.created_at))
  const byCashier = {}
  for (const a of discountReqs) {
    const name = a.requested_by_name || 'Unknown'
    if (!byCashier[name]) byCashier[name] = { count: 0, amount: 0 }
    byCashier[name].count += 1
    byCashier[name].amount += Number(a.amount || 0)
  }
  // By approver.
  const byApprover = {}
  for (const a of discountReqs.filter(a => a.status === 'approved' || a.status === 'rejected')) {
    const name = a.approver_name || 'Unknown'
    if (!byApprover[name]) byApprover[name] = { approved: 0, rejected: 0, amount: 0 }
    if (a.status === 'approved') { byApprover[name].approved += 1; byApprover[name].amount += Number(a.amount || 0) }
    else byApprover[name].rejected += 1
  }

  // By discount type (percent / fixed / item).
  const byType = { percent: 0, fixed: 0, item: 0 }
  for (const inv of discounted) {
    if (byType[inv.discount_type] !== undefined) byType[inv.discount_type] += Number(inv.discount || 0)
  }

  // Approval outcomes.
  const pending = discountReqs.filter(a => a.status === 'pending').length
  const approved = discountReqs.filter(a => a.status === 'approved').length
  const rejected = discountReqs.filter(a => a.status === 'rejected').length

  return {
    totalDiscountAmount,
    totalOriginalSubtotal,
    totalFinalPayable,
    discountCount: discounted.length,
    avgDiscountPercent: totalOriginalSubtotal > 0 ? (totalDiscountAmount / totalOriginalSubtotal) * 100 : 0,
    byCashier,
    byApprover,
    byType,
    approvals: { pending, approved, rejected, total: discountReqs.length },
    // Revenue impact = original revenue that was given up as discounts.
    revenueImpact: totalDiscountAmount,
  }
}

