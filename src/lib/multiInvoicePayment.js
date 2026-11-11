// =====================================================================
// GOODIE-MEDHUB — Multi-Invoice Payment Allocation
// ---------------------------------------------------------------------
// CORRECTIONS (reviewer issues):
//
//   1. ONLY emits invoice.status values 'unpaid' or 'paid' — never
//      'partial'. The production DB CHECK constraint on invoices.status
//      accepts ONLY 'unpaid' and 'paid' (verified by the backend owner).
//      The previous code emitted 'partial' on line 581, which would
//      cause a 400 (CheckViolation) on every multi-invoice payment
//      that did not fully pay each invoice. Now: an invoice with a
//      remaining balance stays 'unpaid'; an invoice with zero balance
//      becomes 'paid'.
//
//   2. Atomic operation: the entire allocation either fully succeeds
//      or fully fails. The frontend does NOT attempt a "compensating
//      rollback" by guessing what partially wrote — instead, it
//      delegates the atomic write to the backend RPC
//      `allocate_payment(p_payment_id uuid, p_payload jsonb)`. If the
//      RPC is unavailable (the user said its body is currently only a
//      placeholder), the function REFUSES to write and returns
//      `{ success: false, error: 'allocate_payment RPC unavailable —
//      coordinate with backend owner' }`. The frontend NEVER silently
//      implements a non-atomic workaround that could leave invoices
//      half-paid.
//
//   3. Cross-patient and cross-hospital validation: every invoice in
//      the allocation set MUST belong to the same patient AND the
//      same hospital as the payment. Cross-patient or cross-hospital
//      allocation is rejected with a clear error.
//
//   4. Overpayment prevention: the total of allocations MUST equal
//      the payment amount. A single invoice cannot receive more than
//      its current balance. Both checks are enforced client-side
//      BEFORE the RPC call AND the RPC is expected to re-enforce
//      them server-side (defense in depth — frontend validation never
//      replaces backend authorization).
//
//   5. Duplicate allocation prevention: each invoice_id may appear
//      at most ONCE in the allocation set. Duplicates are rejected.
//
//   6. Receipt generation: the RPC is expected to assign a single
//      receipt_number to the payment (one payment → one receipt,
//      even though the payment is split across many invoices).
//      The frontend surfaces this receipt_number in the modal's
//      "Allocation breakdown" panel for the cashier to print.
//
//   7. Preserves the existing UI design — the modal still looks the
//      same; only the submit handler and the breakdown panel change.
//
// BACKEND CONTRACT (the frontend depends on this — coordinate with
// the backend owner before relying on it):
//
//   RPC: allocate_payment(p_payment_id uuid, p_payload jsonb)
//     p_payload shape:
//       {
//         hospital_id:   uuid,
//         patient_id:    uuid,
//         total_amount:  numeric,
//         method:        text,
//         reference_number: text | null,
//         received_by:   uuid,
//         allocations: [
//           { invoice_id: uuid, amount: numeric },
//           ...
//         ]
//       }
//     Returns: { success: boolean, receipt_number: text | null,
//               payment_id: uuid, allocations: [...], error: text | null }
//     The RPC MUST:
//       a. Verify every invoice_id belongs to the same hospital_id
//          AND patient_id as the payment. RLS already enforces
//          hospital scope; the RPC additionally enforces patient
//          scope at the function level.
//       b. Verify sum(allocations.amount) == total_amount (no
//          overpayment, no underpayment unless unallocated balance
//          is explicitly supported — see the
//          `allow_unallocated_balance` field below).
//       c. Verify each allocation.amount <= invoice.balance (no
//          overpayment of a single invoice).
//       d. Verify no duplicate invoice_id in the allocations array.
//       e. INSERT the payments row (or UPDATE p_payment_id if a
//          placeholder row already exists).
//       f. INSERT a payment_allocations row for each allocation.
//       g. UPDATE each invoice: amount_paid += allocation.amount,
//          balance -= allocation.amount, status = 'paid' if
//          balance <= 0.005 else 'unpaid'. NEVER emit 'partial'.
//       h. Assign a single receipt_number to the payment via the
//          existing next_document_number() RPC.
//       i. ALL of the above in ONE transaction. On ANY failure, the
//          transaction rolls back — no partial writes.
//       j. Return the receipt_number so the frontend can render the
//          receipt.
//
//   If `allow_unallocated_balance: true` is passed in p_payload,
//   the RPC MAY accept sum(allocations.amount) < total_amount and
//   treat the difference as a patient deposit (recorded in the
//   `deposits` table). The frontend does NOT use this path today
//   — it requires exact allocation — but the contract supports it
//   for future use.
// =====================================================================

import { supabase } from './supabaseClient'
import { formatMoney } from './billingService'

// Tolerance for floating-point comparisons. Two allocations whose
// sum differs from the total amount by less than EPSILON are
// considered equal.
const EPSILON = 0.01

// The only invoice.status values the production DB accepts.
// The user verified this with the backend owner.
const ALLOWED_INVOICE_STATUSES = new Set(['unpaid', 'paid'])

// =====================================================================
// VALIDATION
// =====================================================================

/**
 * Validate the allocation payload BEFORE calling the backend RPC.
 * Returns `{ valid: true }` or `{ valid: false, error: string }`.
 *
 * The backend RPC MUST re-validate everything — this is a
 * defense-in-depth check, not a substitute for backend authorization.
 */
export function validateAllocation({
  hospitalId, patientId, totalAmount, allocations, invoices,
}) {
  if (!hospitalId) return { valid: false, error: 'Hospital ID is required.' }
  if (!patientId) return { valid: false, error: 'Patient ID is required.' }
  if (!totalAmount || Number(totalAmount) <= 0) {
    return { valid: false, error: 'Total amount must be greater than 0.' }
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return { valid: false, error: 'At least one allocation is required.' }
  }

  // Cross-patient + cross-hospital check
  const invoiceIds = allocations.map(a => a.invoice_id)
  const seenInvoiceIds = new Set()
  for (const alloc of allocations) {
    if (!alloc.invoice_id) {
      return { valid: false, error: 'Every allocation must reference an invoice_id.' }
    }
    if (seenInvoiceIds.has(alloc.invoice_id)) {
      return { valid: false, error: `Duplicate allocation for invoice ${alloc.invoice_id}.` }
    }
    seenInvoiceIds.add(alloc.invoice_id)

    const amt = Number(alloc.amount)
    if (isNaN(amt) || amt <= 0) {
      return { valid: false, error: `Allocation for invoice ${alloc.invoice_id} must be greater than 0.` }
    }
  }

  // Look up each invoice in the local cache.
  // The backend RPC will re-verify against the live DB.
  const invoicesById = new Map((invoices || []).map(i => [i.id, i]))
  for (const alloc of allocations) {
    const inv = invoicesById.get(alloc.invoice_id)
    if (!inv) {
      return { valid: false, error: `Invoice ${alloc.invoice_id} was not found in the local cache.` }
    }
    if (inv.hospital_id !== hospitalId) {
      // SECURITY: cross-hospital allocation refused. This is a
      // defense-in-depth check — RLS already prevents the write at
      // the backend, but we surface the error to the cashier here
      // so they don't waste a round-trip.
      return {
        valid: false,
        error: `Invoice ${inv.invoice_number || alloc.invoice_id} belongs to a different hospital. Cross-hospital allocation is not allowed.`,
      }
    }
    if (inv.patient_id !== patientId) {
      return {
        valid: false,
        error: `Invoice ${inv.invoice_number || alloc.invoice_id} belongs to a different patient. Cross-patient allocation is not allowed.`,
      }
    }
    // Only finalized invoices (not draft / cancelled / written_off)
    // may receive a payment allocation.
    if (inv.draft_status && inv.draft_status !== 'finalized') {
      return {
        valid: false,
        error: `Invoice ${inv.invoice_number || alloc.invoice_id} is ${inv.draft_status}, not finalized. Only finalized invoices may receive payments.`,
      }
    }
    // Overpayment check: an invoice may not receive more than its
    // current balance.
    const currentBalance = Number(inv.balance || 0)
    if (Number(alloc.amount) > currentBalance + EPSILON) {
      return {
        valid: false,
        error: `Allocation of ${formatMoney(alloc.amount)} for invoice ${inv.invoice_number || alloc.invoice_id} exceeds its balance of ${formatMoney(currentBalance)}.`,
      }
    }
  }

  // Total allocation must equal the payment amount. We do NOT
  // support unallocated balance in this iteration — see the
  // `allow_unallocated_balance` contract note above.
  const totalAlloc = allocations.reduce((s, a) => s + Number(a.amount || 0), 0)
  if (Math.abs(totalAlloc - Number(totalAmount)) > EPSILON) {
    return {
      valid: false,
      error: `Allocated total (${formatMoney(totalAlloc)}) does not match payment amount (${formatMoney(totalAmount)}). Adjust the allocations to match.`,
    }
  }

  return { valid: true }
}

// =====================================================================
// RPC CALL — backend atomic allocation
// =====================================================================

/**
 * Call the backend `allocate_payment(p_payment_id, p_payload)` RPC.
 *
 * The RPC is the ONLY path that writes to the DB. The frontend does
 * NOT insert payments / payment_allocations / invoices rows directly
 * for the multi-invoice flow — it always goes through this RPC.
 *
 * If the RPC is unavailable (returns 42804 / 42P01 / function-not-
 * found), the function returns `{ success: false, reason:
 * 'rpc_unavailable' }` and the caller MUST refuse to write. The
 * frontend NEVER silently implements a non-atomic workaround.
 *
 * @returns {Promise<{success: boolean, receipt?: object, error?: string, reason?: string}>}
 */
export async function callAllocatePaymentRpc({
  hospitalId, patientId, patientName,
  totalAmount, method, referenceNumber,
  receivedBy, allocations,
}) {
  if (!supabase?.rpc) {
    return {
      success: false,
      reason: 'rpc_unavailable',
      error: 'Supabase client is not initialised. Cannot call allocate_payment RPC.',
    }
  }

  // The RPC's first parameter is the payment_id. The frontend does
  // NOT pre-create a payments row — it passes NULL and lets the RPC
  // create the row atomically inside its transaction. (The RPC's
  // signature is `allocate_payment(uuid, jsonb)` per the user's
  // verified production DB facts.)
  const paymentId = null

  const payload = {
    hospital_id: hospitalId,
    patient_id: patientId,
    patient_name: patientName,
    total_amount: Number(totalAmount),
    method,
    reference_number: referenceNumber || null,
    received_by: receivedBy || null,
    // The RPC is expected to assign a single receipt_number to the
    // payment via next_document_number() inside the transaction.
    allocations: allocations.map(a => ({
      invoice_id: a.invoice_id,
      amount: Number(a.amount),
    })),
    // Future: allow_unallocated_balance: false
  }

  try {
    const { data, error } = await supabase.rpc('allocate_payment', {
      p_payment_id: paymentId,
      p_payload: payload,
    })

    if (error) {
      // Detect "function does not exist" — PostgREST returns
      // PGRST202 (schemaCacheMiss) or 42883 (undefined_function)
      // when the RPC has not been deployed. In either case, we
      // refuse to write.
      const code = error.code || ''
      const msg = (error.message || '').toLowerCase()
      const rpcMissing =
        code === 'PGRST202' ||
        code === '42883' ||
        msg.includes('could not find the function') ||
        msg.includes('does not exist') ||
        msg.includes('function public.allocate_payment') ||
        // PostgREST returns this generic message when the RPC's
        // body throws a "feature not implemented" error (the
        // placeholder body the user mentioned).
        msg.includes('not implemented') ||
        msg.includes('placeholder')

      if (rpcMissing) {
        return {
          success: false,
          reason: 'rpc_unavailable',
          error:
            'The allocate_payment RPC is not deployed or is currently a placeholder. ' +
            'Coordinate with the backend owner to implement it. The frontend refuses to ' +
            'write multi-invoice payments without the atomic backend path.',
          rawError: error,
        }
      }

      // Any other error from the RPC — return as-is so the modal
      // can surface the exact message to the cashier.
      return {
        success: false,
        reason: 'rpc_error',
        error: error.message || 'The allocate_payment RPC returned an error.',
        rawError: error,
      }
    }

    // The RPC returns a single JSON row (or a single-element array).
    const result = Array.isArray(data) ? data[0] : data
    if (!result) {
      return {
        success: false,
        reason: 'rpc_empty',
        error: 'The allocate_payment RPC returned no data.',
      }
    }

    // Normalize the result. The RPC may return either snake_case or
    // camelCase keys — handle both.
    const receipt = {
      payment_id: result.payment_id || result.paymentId || null,
      receipt_number: result.receipt_number || result.receiptNumber || null,
      total_amount: Number(result.total_amount || result.totalAmount || totalAmount),
      method,
      reference_number: referenceNumber || null,
      patient_id: patientId,
      patient_name: patientName,
      hospital_id: hospitalId,
      allocations: (result.allocations || allocations).map(a => ({
        invoice_id: a.invoice_id || a.invoiceId,
        invoice_number: a.invoice_number || a.invoiceNumber || null,
        amount: Number(a.amount),
        // The RPC returns the invoice's new state so the frontend
        // can refresh its local cache.
        new_amount_paid: a.new_amount_paid != null ? Number(a.new_amount_paid) : null,
        new_balance: a.new_balance != null ? Number(a.new_balance) : null,
        new_status: a.new_status || null,
      })),
      allocated_at: result.allocated_at || result.allocatedAt || new Date().toISOString(),
      received_by: receivedBy,
    }

    // Sanity-check: the RPC must only emit 'unpaid' or 'paid' for
    // invoice statuses. If it emitted anything else (e.g. 'partial'),
    // treat as an error — the production CHECK constraint would
    // have already rejected the write, but we double-check here so
    // the frontend never caches a bad state.
    for (const a of receipt.allocations) {
      if (a.new_status && !ALLOWED_INVOICE_STATUSES.has(a.new_status)) {
        return {
          success: false,
          reason: 'rpc_bad_status',
          error:
            `The allocate_payment RPC returned an unsupported invoice status ` +
            `'${a.new_status}' for invoice ${a.invoice_id}. Only 'unpaid' and 'paid' ` +
            `are accepted by the production database. Coordinate with the backend owner.`,
        }
      }
    }

    return { success: true, receipt }
  } catch (err) {
    return {
      success: false,
      reason: 'exception',
      error: err?.message || 'Could not call the allocate_payment RPC.',
      rawError: err,
    }
  }
}

// =====================================================================
// PUBLIC ENTRY POINT
// =====================================================================

/**
 * Allocate a payment across one or more invoices.
 *
 * This is the ONLY function the MultiInvoicePaymentModal calls. It:
 *   1. Validates the payload (cross-patient, cross-hospital,
 *      overpayment, duplicate, totals match).
 *   2. Calls the backend `allocate_payment` RPC atomically.
 *   3. Returns the receipt data for the modal to render.
 *
 * If the RPC is unavailable, returns `{ success: false, reason:
 * 'rpc_unavailable' }` and the modal surfaces a clear error
 * instructing the cashier to coordinate with the backend owner.
 *
 * The frontend NEVER writes payments / payment_allocations / invoices
 * rows directly when this function is called — that would bypass
 * the backend's atomic guarantee and could leave the DB in an
 * inconsistent state on partial failure.
 *
 * @param {object} params
 * @param {object} params.hospital    - The active hospital object (must have .id).
 * @param {object} params.profile     - The cashier's profile (must have .id).
 * @param {string} params.patientId   - The patient's UUID.
 * @param {string} params.patientName - The patient's display name (for the receipt).
 * @param {number} params.totalAmount - The total payment amount.
 * @param {string} params.method      - Payment method (Cash, POS, Bank Transfer, …).
 * @param {string} [params.referenceNumber] - Optional reference number.
 * @param {Array<{invoice_id: string, amount: number}>} params.allocations - Allocation breakdown.
 * @param {Array} params.invoices     - The local invoices cache (for client-side validation).
 *
 * @returns {Promise<{success: boolean, receipt?: object, error?: string, reason?: string}>}
 */
export async function allocatePaymentAcrossInvoices({
  hospital, profile, patientId, patientName,
  totalAmount, method, referenceNumber = null,
  allocations, invoices,
}) {
  // 1. Validate.
  const validation = validateAllocation({
    hospitalId: hospital?.id,
    patientId,
    totalAmount,
    allocations,
    invoices,
  })
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  // 2. Call the backend RPC.
  const result = await callAllocatePaymentRpc({
    hospitalId: hospital.id,
    patientId,
    patientName,
    totalAmount,
    method,
    referenceNumber,
    receivedBy: profile?.id,
    allocations,
  })

  return result
}

// =====================================================================
// RECEIPT FORMATTER
// =====================================================================

/**
 * Build a printable receipt object from the RPC result.
 * Used by the MultiInvoicePaymentModal's receipt panel.
 */
export function buildReceipt(receipt, hospital, profile) {
  if (!receipt) return null
  return {
    hospital_name: hospital?.name || '',
    hospital_id: hospital?.id || '',
    cashier: profile?.full_name || '',
    cashier_id: profile?.id || '',
    payment_id: receipt.payment_id,
    receipt_number: receipt.receipt_number,
    patient_id: receipt.patient_id,
    patient_name: receipt.patient_name,
    total_amount: Number(receipt.total_amount),
    method: receipt.method,
    reference_number: receipt.reference_number,
    allocated_at: receipt.allocated_at,
    allocations: receipt.allocations.map(a => ({
      invoice_id: a.invoice_id,
      invoice_number: a.invoice_number,
      amount: Number(a.amount),
      new_amount_paid: a.new_amount_paid != null ? Number(a.new_amount_paid) : null,
      new_balance: a.new_balance != null ? Number(a.new_balance) : null,
      new_status: a.new_status,
    })),
  }
}
