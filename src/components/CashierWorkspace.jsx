import { useState, useMemo, useEffect, useRef } from 'react'
import { useRealtimeAlert } from '../lib/useRealtimeAlert'
import { useOfflineTable } from '../lib/useOfflineTable'
import InvoiceViewer from './InvoiceViewer'
import CatalogPicker from './CatalogPicker'
import AppIcon from './icons'
import { writeAudit } from '../lib/audit'
import { useBillingCatalog, formatMoney, nextDocumentNumber, findContractForPatient } from '../lib/billingService'

const METHODS = ['Cash', 'POS', 'Bank Transfer', 'Card', 'HMO', 'Insurance', 'Other']

// ---------------------------------------------------------------------
// DOUBLE-SAVE / OFFLINE-SAFE WRITE HELPERS
// ---------------------------------------------------------------------
// Problem this solves:
//   useOfflineTable.addRecord() writes to local IndexedDB FIRST, then
//   attempts the Supabase INSERT. When the device is offline (or the
//   request is slow) the remote call fails AFTER the local row already
//   exists. addRecord then re-throws a friendly "server could not be
//   reached" message. The save handler's catch shows that error and
//   re-enables the button — but the modal stays open (the save "failed"
//   from the user's point of view). The cashier clicks "Save as Draft"
//   again, and a SECOND invoice row lands in IndexedDB. Both later sync
//   to the server → duplicate invoices + duplicate payments.
//
// Fix:
//   1. isRecoverableOfflineError() — recognises the offline/network
//      error that addRecord throws. Because the local write already
//      succeeded, this is NOT a real failure: the sync queue will push
//      it when the connection returns. We treat it as success.
//   2. INFLIGHT_SAVE_KEYS — a module-level Set keyed by patient + a
//      per-save nonce. While a save for this patient is in flight (even
//      one whose await hasn't settled yet), a second click is a no-op.
//      This closes the narrow window where a slow network leaves the
//      button clickable just long enough for a double-click, and it
//      also stops the "click again after the offline error" path.
// ---------------------------------------------------------------------
const NETWORK_ERROR_RE = /failed to fetch|networkerror|load failed|fetch failed|network request failed|err_internet|server could not be reached|offline or unstable/i
function isRecoverableOfflineError(err) {
  return NETWORK_ERROR_RE.test(String(err?.message || err || ''))
}
const INFLIGHT_SAVE_KEYS = new Set()

export default function CashierWorkspace({ patientId, patientName, hospital, profile, onClose }) {
  const { records: charges, addRecord: addCharge, updateRecord: updateCharge, deleteRecord: deleteCharge } = useOfflineTable('billable_charges', hospital?.id)
  const { addRecord: addInvoice } = useOfflineTable('invoices', hospital?.id)
  const { addRecord: addInvoiceItem } = useOfflineTable('invoice_items', hospital?.id)
  const { records: patients, updateRecord: updatePatient } = useOfflineTable('patients', hospital?.id)
  const { addRecord: addInsuranceClaim } = useOfflineTable('insurance_claims', hospital?.id)
  // ---- Payments register hook (FIX for the "payment saved but list empty" bug) ----
  // Previously handleGenerateInvoice only updated invoices.amount_paid and never
  // inserted a row into the payments table. As a result the Payments tab
  // (which reads from `payments`) showed 0 records even though the invoice
  // showed as paid. This hook is now used in the save handler below.
  const { addRecord: addPayment } = useOfflineTable('payments', hospital?.id)
  const { records: wallets, addRecord: addWallet, updateRecord: updateWallet, syncFromServer: syncWallets } = useOfflineTable('patient_wallets', hospital?.id)
  const { addRecord: addWalletTxn, syncFromServer: syncWalletTxns } = useOfflineTable('patient_wallet_transactions', hospital?.id)

  useRealtimeAlert('patient_wallets', hospital?.id, () => { syncWallets() }, { event: 'UPDATE' })
  useRealtimeAlert('patient_wallets', hospital?.id, () => { syncWallets() })

  const { catalog, priceLists, priceListItems, contracts, paymentMethods } = useBillingCatalog()
  const [showCatalogPicker, setShowCatalogPicker] = useState(false)

  const [discount, setDiscount] = useState('')
  const [tax, setTax] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('Cash')
  const [amountPaid, setAmountPaid] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)
  const [receiptInvoice, setReceiptInvoice] = useState(null)
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  const patientRecord = useMemo(() => patients.find(p => p.id === patientId) || null, [patients, patientId])
  const hmoProvider = patientRecord?.hmo_provider || null
  const hmoCoveragePercent = Math.min(100, Math.max(0, Number(patientRecord?.hmo_coverage_percent) || 0))
  const hasHmo = !!hmoProvider && hmoCoveragePercent > 0

  const isHmoFolderPatient = patientRecord?.category === 'hmo' && !!hmoProvider
  const patientWallet = useMemo(() => {
    if (isHmoFolderPatient) return null
    return wallets.find(w => w.patient_id === patientId) || null
  }, [wallets, patientId, isHmoFolderPatient])

  const walletBalance = Number(patientWallet?.balance || 0)
  const canUseWallet = !!patientWallet && walletBalance > 0.001

  const pendingCharges = useMemo(() => {
    return charges.filter(c => c.patient_id === patientId && c.status === 'pending')
  }, [charges, patientId])

  // Selected charge ids + the ids the user has explicitly removed via the
  // per-row "x" delete or by unchecking. We track `removedIds` separately
  // so the effect below only ADDs newly-arrived pending charges to the
  // selection — it never re-selects a charge the user just unchecked or
  // a charge whose id is in removedIds (already deleted). Without this,
  // any change to `pendingCharges` (e.g. a new charge pushed via realtime,
  // or the memo re-running with a new array reference) would wipe the
  // user's un-checks and silently re-add the row to the total.
  const [selectedIds, setSelectedIds] = useState([])
  const removedIdsRef = useRef(new Set())

  useEffect(() => {
    setSelectedIds(prev => {
      const prevSet = new Set(prev)
      const removed = removedIdsRef.current
      const next = []
      // Keep previously-selected ids that are STILL pending.
      for (const id of prev) {
        if (pendingCharges.some(c => c.id === id) && !removed.has(id)) {
          next.push(id)
        }
      }
      // Add NEW pending charges (not previously seen, not removed).
      for (const c of pendingCharges) {
        if (!prevSet.has(c.id) && !removed.has(c.id)) {
          next.push(c.id)
        }
      }
      return next
    })
  }, [pendingCharges])

  function toggleCharge(id) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  }

  async function addCustomCharge() {
    if (!catalog || catalog.length === 0) {
      const name = window.prompt('Enter custom charge name (e.g. Consultation, Lab Test):')
      if (!name) return
      const priceStr = window.prompt('Enter price for this service (₦):', '0')
      const price = parseFloat(priceStr) || 0
      await addCharge({
        hospital_id: hospital.id, patient_id: patientId, patient_name: patientName,
        source_module: 'Manual', source_transaction_id: `MANUAL-${Date.now()}`,
        item_name: name, category: 'Manual', quantity: 1, unit_price: price, total: price,
        status: 'pending', created_by: profile?.id
      })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'billing.custom_charge_added',
        entityType: 'billable_charge', entityId: null,
        patientId: patientId || null,
        summary: `Added custom charge "${name}" (₦${price.toFixed(2)}) for ${patientName || 'patient'}`,
        metadata: { patient_name: patientName, item_name: name, unit_price: price, quantity: 1, total: price, source_module: 'Manual' },
      })
      return
    }

    setShowCatalogPicker(true)
  }

  async function handleCatalogPick({ service, resolved, total, split }) {
    const qty = resolved.quantity || 1
    const unitPrice = resolved.price

    const categoryMap = {
      'consultation': 'Consultation',
      'lab':          'Lab',
      'procedure':    'Procedure',
      'drug':         'Drug',
      'bed':          'Bed',
      'service':      'Service',
      'anc_package':  'ANC',
      'registration': 'Registration',
      'other':        'Manual',
    }
    const chargeCategory = categoryMap[service.category] || 'Manual'

    await addCharge({
      hospital_id: hospital.id,
      patient_id: patientId,
      patient_name: patientName,
      source_module: 'Catalog',
      source_transaction_id: `CAT-${service.code}-${Date.now()}`,
      item_name: service.name,
      category: chargeCategory,
      quantity: qty,
      unit_price: unitPrice,
      total: total,
      status: 'pending',
      created_by: profile?.id,
    })

    writeAudit({
      hospitalId: hospital?.id, actor: profile,
      action: 'billing.catalog_charge_added',
      entityType: 'billable_charge', entityId: null,
      patientId: patientId || null,
      summary: `Added catalog charge "${service.name}" (${service.code}) × ${qty} = ${formatMoney(total)} for ${patientName || 'patient'}` +
        (split.hmoAmount > 0 ? ` — HMO ${formatMoney(split.hmoAmount)}, patient ${formatMoney(split.patientAmount)}` : ''),
      metadata: {
        patient_name: patientName,
        catalog_code: service.code,
        catalog_id: service.id,
        category: chargeCategory,
        item_name: service.name,
        unit_price: unitPrice,
        quantity: qty,
        total,
        price_list_id: resolved.priceListId,
        contract_id: resolved.contractId,
        coverage_percent: resolved.coveragePercent,
        hmo_amount: split.hmoAmount,
        patient_amount: split.patientAmount,
        source_module: 'Catalog',
      },
    })

    setShowCatalogPicker(false)
  }

  const selectedCharges = pendingCharges.filter(c => selectedIds.includes(c.id))
  const subtotal = selectedCharges.reduce((s, c) => s + Number(c.total || 0), 0)
  const discountAmt = Number(discount) || 0
  const taxAmt = Number(tax) || 0
  const grandTotal = Math.max(0, subtotal - discountAmt + taxAmt)

  const hmoAmount = hasHmo ? Math.round(grandTotal * (hmoCoveragePercent / 100) * 100) / 100 : 0
  const patientAmount = Math.max(0, grandTotal - hmoAmount)
  const amountOwedByPatient = hasHmo ? patientAmount : grandTotal

  // Wallet deduction PREVIEW — what will be auto-deducted from the patient's
  // wallet when this invoice is finalized. Mirrors the actual deduction logic
  // at the save-site (line 194): Math.min(liveBalance, amountOwedByPatient).
  // Used to show the cashier + patient the TRUE balance due, not just the
  // pre-deduction grandTotal. HMO folder patients never get wallet deductions
  // (their wallet is bypassed), so the preview is 0 for them.
  const walletDeductionPreview = canUseWallet
    ? Math.min(walletBalance, amountOwedByPatient)
    : 0
  const balanceDueAfterWallet = Math.max(0, amountOwedByPatient - walletDeductionPreview)

  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  async function handleGenerateInvoice() {
    if (selectedCharges.length === 0) return alert('No charges selected.')
    // DOUBLE-SAVE GUARD: see comment on INFLIGHT_SAVE_KEYS above.
    // Prevents a second "Generate Invoice" click from creating a
    // duplicate invoice when the first click is still in flight or
    // when an offline error left the modal open with the local row
    // already written.
    const saveKey = `generate:${patientId}`
    if (INFLIGHT_SAVE_KEYS.has(saveKey)) return
    INFLIGHT_SAVE_KEYS.add(saveKey)

    const pAmt = Number(amountPaid) || 0
    if (pAmt <= 0 && !canUseWallet && amountOwedByPatient > 0.001) {
      const proceed = window.confirm(
        `No payment amount entered.\n\n` +
        `The invoice will be created as UNPAID with a balance of ${formatMoney(amountOwedByPatient)}.\n\n` +
        `You can record a payment on it later from:\n` +
        `  Billing → Unpaid Invoices tab → Take Payment\n\n` +
        `Click OK to create the unpaid invoice, or Cancel to go back and enter an amount.`
      )
      if (!proceed) { INFLIGHT_SAVE_KEYS.delete(saveKey); return }
    }
    // If the wallet covers the whole balance, we don't need a manual amount.
    // Without this guard, the confirm dialog above would fire even when the
    // patient owes ₦0 out-of-pocket (their wallet fully covers it).
    if (pAmt <= 0 && canUseWallet && balanceDueAfterWallet > 0.001) {
      const proceed = window.confirm(
        `No cash/card amount entered.\n\n` +
        `Wallet will auto-cover ${formatMoney(walletDeductionPreview)} of this invoice.\n` +
        `The remaining balance of ${formatMoney(balanceDueAfterWallet)} will be recorded as UNPAID.\n\n` +
        `You can collect it later from:\n` +
        `  Billing → Unpaid Invoices tab → Take Payment\n\n` +
        `Click OK to proceed, or Cancel to enter a payment amount now.`
      )
      if (!proceed) { INFLIGHT_SAVE_KEYS.delete(saveKey); return }
    }
    setSaving(true)
    try {
      let liveWallet = patientWallet
      let liveBalance = walletBalance
      if (!isHmoFolderPatient) {
        const latest = wallets.find(w => w.patient_id === patientId)
        if (latest) {
          liveWallet = latest
          liveBalance = Number(latest.balance || 0)
        }
      }
      let walletDeduction = 0
      if (liveWallet && liveBalance > 0.001) {
        walletDeduction = Math.min(liveBalance, amountOwedByPatient)
      }
      const totalPaid = walletDeduction + pAmt
      const bal = Math.max(0, amountOwedByPatient - totalPaid)
      const status = totalPaid >= amountOwedByPatient - 0.001 ? 'paid' : (totalPaid > 0 ? 'partial' : 'unpaid')

      const invoiceNumber = await nextDocumentNumber(hospital.id, 'invoice', new Date().getFullYear())
      const receiptNumber = (totalPaid > 0)
        ? await nextDocumentNumber(hospital.id, 'receipt', new Date().getFullYear())
        : null

      const newInv = await addInvoice({
        hospital_id: hospital.id, patient_id: patientId, patient_name: patientName,
        invoice_number: invoiceNumber,
        invoice_type: 'outpatient',
        draft_status: 'finalized',
        finalized_at: new Date().toISOString(),
        receipt_number: receiptNumber,
        subtotal,
        amount: grandTotal,
        discount: discountAmt, tax: taxAmt, grand_total: grandTotal,
        hmo_provider: hasHmo ? hmoProvider : null,
        hmo_coverage_percent: hasHmo ? hmoCoveragePercent : null,
        hmo_amount: hasHmo ? hmoAmount : 0,
        patient_amount: amountOwedByPatient,
        amount_paid: totalPaid,
        wallet_deduction: walletDeduction,
        wallet_id: walletDeduction > 0 && liveWallet ? liveWallet.id : null,
        balance: bal,
        payment_method: walletDeduction > 0 ? (pAmt > 0 ? `${paymentMethod} + Wallet` : 'Wallet') : paymentMethod,
        status, created_by: profile?.id
      })

      for (const charge of selectedCharges) {
        await addInvoiceItem({
          hospital_id: hospital.id, invoice_id: newInv.id, item_name: charge.item_name,
          quantity: charge.quantity, unit_price: charge.unit_price, total: charge.total,
          source_module: charge.source_module || null,
          category: charge.category || null,
        })
        await updateCharge(charge.id, { status: 'invoiced' })
      }

      // ---- FIX: insert a `payments` row for the cashier-collected portion ----
      // Without this, the Payments tab shows 0 records even though the invoice
      // shows as paid (because the KPI on top reads invoices.amount_paid, but
      // the Payments tab reads the `payments` table).
      //
      // Only the cashier-collected portion (pAmt) goes into `payments`.
      // The wallet-deducted portion is recorded separately in
      // patient_wallet_transactions (the existing code below) — that's the
      // correct split: wallet transactions belong to the wallet ledger, cash
      // / POS / transfer belong to the payments register. Mixing them would
      // double-count in the wallet ledger.
      if (pAmt > 0) {
        await addPayment({
          hospital_id: hospital.id,
          invoice_id: newInv.id,
          patient_id: patientId,
          patient_name: patientName,
          amount: pAmt,
          method: paymentMethod,
          received_by: profile?.id || null,
          reference_number: receiptNumber || `REF-${Date.now().toString().slice(-6)}`,
        })
      }

      if (walletDeduction > 0 && liveWallet) {
        const newWalletBalance = Math.max(0, liveBalance - walletDeduction)
        await addWalletTxn({
          hospital_id: hospital.id,
          patient_id: patientId,
          wallet_id: liveWallet.id,
          type: 'charge',
          amount: -walletDeduction,
          balance_after: newWalletBalance,
          method: 'Wallet',
          invoice_id: newInv.id,
          performed_by: profile?.id,
          performed_by_name: profile?.full_name || null,
          notes: `Auto-deducted for invoice ${newInv.invoice_number}`,
        })
        try {
          await updateWallet(liveWallet.id, { balance: newWalletBalance })
        } catch (walletErr) {
          console.warn('Local wallet balance update failed (server trigger still applies):', walletErr)
        }
        writeAudit({
          hospitalId: hospital?.id, actor: profile,
          action: 'wallet.charge',
          entityType: 'invoice', entityId: newInv.id,
          patientId: patientId,
          summary: `Auto-charged ${formatMoney(walletDeduction)} from ${patientName}'s wallet for invoice ${newInv.invoice_number}`,
          metadata: {
            invoice_id: newInv.id, invoice_number: newInv.invoice_number,
            wallet_id: liveWallet.id,
            wallet_deduction: walletDeduction,
            wallet_balance_before: liveBalance,
            wallet_balance_after: newWalletBalance,
          },
        })
      }

      if (hasHmo && hmoAmount > 0) {
        const claimNumber = await nextDocumentNumber(hospital.id, 'claim', new Date().getFullYear())
        // Section 3 enhancement: resolve the proper hmo_contract_id (was null
        // before — the system only matched by payer_name loose text). Now
        // we use findContractForPatient() to find the active contract for
        // the patient's hmo_provider text, then store the FK on the claim.
        const matchedContract = findContractForPatient(contracts, patientRecord)
        await addInsuranceClaim({
          hospital_id: hospital.id,
          patient_id: patientId,
          patient_name: patientName,
          provider: hmoProvider,
          policy_number: patientRecord?.hmo_number || null,
          invoice_id: newInv.id,
          amount: hmoAmount,
          status: 'submitted',
          submitted_at: new Date().toISOString(),
          created_by: profile?.id,
          claim_number: claimNumber,
          authorization_code: patientRecord?.hmo_authorization_code || null,
          authorization_date: patientRecord?.hmo_authorization_date || null,
          attending_physician: null,
          // NEW: link the claim to the proper hmo_contracts row so the
          // Insurance module can group claims by contract + show recovery
          // rate per provider accurately.
          hmo_contract_id: matchedContract?.id || patientRecord?.hmo_contract_id || null,
        })
        writeAudit({
          hospitalId: hospital?.id, actor: profile,
          action: 'insurance.claim_auto_filed',
          entityType: 'invoice', entityId: newInv.id,
          patientId: patientId || null,
          summary: `Auto-filed ${hmoProvider} claim for ₦${hmoAmount.toFixed(2)} on invoice ${newInv.invoice_number} (${patientName})`,
          metadata: {
            invoice_id: newInv.id, invoice_number: newInv.invoice_number,
            patient_name: patientName, provider: hmoProvider,
            policy_number: patientRecord?.hmo_number || null,
            coverage_percent: hmoCoveragePercent, amount: hmoAmount,
          },
        })
      }

      if (patientId) {
        await updatePatient(patientId, { queue_status: 'discharged', queue_updated_at: new Date().toISOString() })
      }

      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'billing.invoice_generated',
        entityType: 'invoice', entityId: newInv.id,
        patientId: patientId || null,
        summary: `Generated invoice ${newInv.invoice_number} for ${patientName} — ₦${grandTotal.toFixed(2)} (${status})`,
        metadata: {
          invoice_id: newInv.id, invoice_number: newInv.invoice_number,
          patient_name: patientName,
          subtotal, discount: discountAmt, tax: taxAmt, grand_total: grandTotal,
          hmo_provider: hasHmo ? hmoProvider : null,
          hmo_amount: hasHmo ? hmoAmount : 0,
          patient_amount: amountOwedByPatient,
          amount_paid: pAmt, balance: bal, payment_method: paymentMethod,
          status, charge_count: selectedCharges.length,
        },
      })

      setReceiptInvoice(newInv)

    } catch (err) {
      // OFFLINE-SAFE: same rationale as handleSaveAsDraft. addInvoice /
      // addPayment / addInvoiceItem all write to local IndexedDB before
      // the remote INSERT, so an offline throw means the local rows
      // already exist and the sync queue will deliver them. Treating it
      // as a hard failure (and leaving the modal open) is what caused
      // duplicate invoices on slow networks.
      if (isRecoverableOfflineError(err)) {
        showToast(`Invoice saved (offline) — saved on this device; it will sync automatically once you're back online.`)
        onClose()
      } else {
        alert(err.message || 'Failed to generate invoice')
      }
    } finally {
      INFLIGHT_SAVE_KEYS.delete(saveKey)
      setSaving(false)
    }
  }

  async function handleSaveAsDraft() {
    if (selectedCharges.length === 0) return alert('No charges selected.')
    // DOUBLE-SAVE GUARD: if a save for this patient is already in flight
    // (the await hasn't settled, or an offline error left the modal
    // open), ignore the click. The first click's write already landed in
    // local IndexedDB — running it again would create a duplicate invoice.
    const saveKey = `draft:${patientId}`
    if (INFLIGHT_SAVE_KEYS.has(saveKey)) return
    INFLIGHT_SAVE_KEYS.add(saveKey)
    setSaving(true)
    try {
      // ----------------------------------------------------------------
      // FIX: read the cashier-entered payment amount from state, exactly
      // like handleGenerateInvoice does. Previously the draft path
      // hardcoded `amount_paid: 0` and `balance: amountOwedByPatient`
      // (the full total), so a draft saved while the cashier had typed
      // ₦1000 into the shared `amountPaid` field would silently drop
      // the payment AND show the patient owing the full ₦3000 instead
      // of the ₦2000 balance. Now the draft records the actual amount
      // paid, computes the correct balance, derives the status, AND
      // writes a payments row + receipt number so the partial payment
      // is preserved when the draft is later finalized.
      // ----------------------------------------------------------------
      const pAmt = Number(amountPaid) || 0
      if (pAmt < 0) return alert('Amount paid cannot be negative.')
      if (pAmt > amountOwedByPatient + 0.001) {
        const proceed = window.confirm(
          `Amount entered (${formatMoney(pAmt)}) is greater than the patient's portion (${formatMoney(amountOwedByPatient)}).\n\n` +
          `The excess of ${formatMoney(pAmt - amountOwedByPatient)} will be recorded as overpayment on the draft.\n\n` +
          `Click OK to save the draft with this amount, or Cancel to go back.`
        )
        if (!proceed) return
      }

      // Mirror the wallet deduction logic from handleGenerateInvoice.
      // A draft saved with a wallet deduction should already deduct from
      // the wallet (so the balance reflects reality) — but ONLY if the
      // cashier actually used the wallet. We read the live wallet so
      // the deduction amount is accurate at save time.
      let liveWallet = patientWallet
      let liveBalance = walletBalance
      if (!isHmoFolderPatient) {
        const latest = wallets.find(w => w.patient_id === patientId)
        if (latest) {
          liveWallet = latest
          liveBalance = Number(latest.balance || 0)
        }
      }
      let walletDeduction = 0
      if (liveWallet && liveBalance > 0.001) {
        walletDeduction = Math.min(liveBalance, amountOwedByPatient)
      }
      const totalPaid = walletDeduction + pAmt
      const bal = Math.max(0, amountOwedByPatient - totalPaid)
      const status = totalPaid >= amountOwedByPatient - 0.001 ? 'paid' : (totalPaid > 0 ? 'partial' : 'unpaid')

      const draftInvoiceNumber = `DRAFT-${Date.now().toString().slice(-8)}`
      // Issue a receipt number whenever money changed hands — even on a
      // draft. This locks the receipt sequence so the next finalized
      // invoice doesn't reuse the same number. If the draft is later
      // discarded, the receipt number is "burned" — acceptable, since
      // the alternative (issue the receipt only at finalization) means
      // the draft would show paid without a traceable receipt.
      const receiptNumber = (totalPaid > 0)
        ? await nextDocumentNumber(hospital.id, 'receipt', new Date().getFullYear())
        : null

      const newInv = await addInvoice({
        hospital_id: hospital.id,
        patient_id: patientId,
        patient_name: patientName,
        invoice_number: draftInvoiceNumber,
        invoice_type: 'outpatient',
        draft_status: 'draft',
        subtotal,
        amount: grandTotal,
        discount: discountAmt,
        tax: taxAmt,
        grand_total: grandTotal,
        hmo_provider: hasHmo ? hmoProvider : null,
        hmo_coverage_percent: hasHmo ? hmoCoveragePercent : null,
        hmo_amount: hasHmo ? hmoAmount : 0,
        patient_amount: amountOwedByPatient,
        amount_paid: totalPaid,
        wallet_deduction: walletDeduction,
        wallet_id: walletDeduction > 0 && liveWallet ? liveWallet.id : null,
        balance: bal,
        receipt_number: receiptNumber,
        payment_method: walletDeduction > 0 ? (pAmt > 0 ? `${paymentMethod} + Wallet` : 'Wallet') : paymentMethod,
        status,
        created_by: profile?.id,
      })

      for (const charge of selectedCharges) {
        await addInvoiceItem({
          hospital_id: hospital.id, invoice_id: newInv.id, item_name: charge.item_name,
          quantity: charge.quantity, unit_price: charge.unit_price, total: charge.total,
          source_module: charge.source_module || null,
          category: charge.category || null,
        })
        await updateCharge(charge.id, { status: 'invoiced' })
      }

      // Record the cashier-collected portion in the payments register
      // (same pattern as handleGenerateInvoice). Without this the draft
      // shows `amount_paid > 0` but the Payments tab has no record,
      // making reconciliation impossible.
      if (pAmt > 0) {
        await addPayment({
          hospital_id: hospital.id,
          invoice_id: newInv.id,
          patient_id: patientId,
          patient_name: patientName,
          amount: pAmt,
          method: paymentMethod,
          received_by: profile?.id || null,
          reference_number: receiptNumber || `REF-${Date.now().toString().slice(-6)}`,
        })
      }

      // Apply the wallet deduction immediately (same as finalized path).
      // A draft with a "wallet covers it" should already show the wallet
      // debited — otherwise the cashier could save the same draft twice
      // and double-spend the wallet. Locking the deduction at save time
      // matches the finalized behavior.
      if (walletDeduction > 0 && liveWallet) {
        const newWalletBalance = Math.max(0, liveBalance - walletDeduction)
        await addWalletTxn({
          hospital_id: hospital.id,
          patient_id: patientId,
          wallet_id: liveWallet.id,
          type: 'charge',
          amount: walletDeduction,
          balance_after: newWalletBalance,
          reference: `DRAFT-${draftInvoiceNumber}`,
          description: `Wallet deduction for draft invoice ${draftInvoiceNumber} — ${patientName}`,
          invoice_id: newInv.id,
          created_by: profile?.id || null,
        })
        await updateWallet(liveWallet.id, { balance: newWalletBalance, updated_at: new Date().toISOString() })
      }

      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'invoice.draft_created',
        entityType: 'invoice', entityId: newInv.id,
        patientId: patientId,
        summary: `Created draft invoice for ${patientName} — ${formatMoney(grandTotal)} (paid ${formatMoney(totalPaid)}, balance ${formatMoney(bal)}) draft #${draftInvoiceNumber}`,
        metadata: {
          patient_name: patientName, subtotal, discount: discountAmt, tax: taxAmt,
          grand_total: grandTotal, amount_paid: totalPaid, balance: bal,
          wallet_deduction: walletDeduction, status,
          item_count: selectedCharges.length,
        },
      })

      showToast(
        totalPaid > 0
          ? `Draft saved — paid ${formatMoney(totalPaid)}, balance ${formatMoney(bal)}. Review in Billing → Drafts`
          : `Draft invoice saved — review and finalize it in Billing → Drafts`
      )
      onClose()
    } catch (err) {
      // OFFLINE-SAFE: addInvoice/addPayment/addInvoiceItem write to local
      // IndexedDB BEFORE attempting the remote INSERT. When the device is
      // offline the remote call fails and the method re-throws a
      // "server could not be reached" error — but the local row already
      // exists and the sync queue will push it when reconnected.
      // Treating that throw as a real failure (and leaving the modal open)
      // is what caused duplicate drafts: the cashier saw the error,
      // clicked "Save as Draft" again, and a second invoice was created.
      if (isRecoverableOfflineError(err)) {
        showToast(
          totalPaid > 0
            ? `Draft saved (offline) — paid ${formatMoney(totalPaid)}, balance ${formatMoney(bal)}. Saved on this device; it will sync automatically once you're back online. Review in Billing → Drafts`
            : `Draft invoice saved (offline). Saved on this device; it will sync automatically once you're back online. Review in Billing → Drafts`
        )
        onClose()
      } else {
        alert(err.message || 'Failed to save draft')
      }
    } finally {
      INFLIGHT_SAVE_KEYS.delete(saveKey)
      setSaving(false)
    }
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 680 }} onClick={e => e.stopPropagation()}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14, flexShrink: 0 }}>
          <div>
            <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Billing Workspace</div>
            <div style={{ fontSize: 13, color: 'var(--teal)', fontWeight: 700, marginTop: 2 }}>{patientName}</div>
          </div>
          <button className="dash-icon-btn" onClick={onClose} aria-label="Close billing workspace"><AppIcon name="close" size={18} /></button>
        </div>

        {canUseWallet && (
          <div style={{
            marginBottom: 12, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(0,199,199,0.08)', border: '1px solid var(--teal-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12.5, color: 'var(--ivory)' }}>
              <strong style={{ color: 'var(--teal)' }}>Wallet balance: {formatMoney(walletBalance)}</strong>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                Will auto-deduct up to {formatMoney(Math.min(walletBalance, amountOwedByPatient))} from this invoice.
                {walletBalance >= amountOwedByPatient ? ' Invoice will be fully covered.' : ` Remaining ${formatMoney(amountOwedByPatient - walletBalance)} will be the balance due.`}
              </div>
            </div>
          </div>
        )}
        {hasHmo && (
          <div style={{
            marginBottom: 12, padding: '8px 12px', borderRadius: 8,
            background: 'rgba(118,87,232,0.06)', border: '1px solid rgba(118,87,232,0.25)',
            fontSize: 11.5, color: 'var(--muted)',
          }}>
            <strong style={{ color: 'var(--violet)' }}>HMO patient:</strong> Wallet is bypassed. The HMO covers {hmoCoveragePercent}% ({formatMoney(hmoAmount)}); patient pays {formatMoney(amountOwedByPatient)} directly.
          </div>
        )}

        <div className="dash-modal-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Automatic Charges</div>
            <button className="btn btn-ghost" style={{ width: 'auto', fontSize: 11.5, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={addCustomCharge}>
              <AppIcon name="plus" size={14} /> Add Charge from Catalog
            </button>
          </div>

          {pendingCharges.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--muted)', fontSize: 12.5 }}>No pending charges for this patient.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingCharges.map(c => {
                const isSelected = selectedIds.includes(c.id)
                const canDeleteCharge = profile && (profile.role === 'owner' || profile.role === 'admin')
                return (
                  <div key={c.id} className={`billing-charge-row ${isSelected ? 'selected' : ''}`} onClick={() => toggleCharge(c.id)} style={{ cursor: 'pointer' }}>
                    <div className="billing-charge-check">{isSelected && <AppIcon name="check" size={12} strokeWidth={3} />}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{c.item_name} (x{c.quantity})</div>
                      <div style={{ marginTop: 4 }}>
                        <span className="billing-source-tag">{c.source_module}</span>
                      </div>
                    </div>
                    <div style={{ fontWeight: 700, color: 'var(--teal)', fontFamily: 'var(--font-mono)' }}>{formatMoney(c.total)}</div>
                    {canDeleteCharge && (
                      <button
                        type="button"
                        className="dash-icon-btn"
                        title="Delete this charge permanently"
                        style={{ marginLeft: 6, color: 'var(--danger)', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (!window.confirm(`Delete "${c.item_name}" (${formatMoney(c.total)}) permanently?\n\nThis cannot be undone.`)) return
                          try {
                            // Mark removed FIRST so the selection effect
                            // doesn't re-add this id if pendingCharges
                            // re-runs before the delete propagates.
                            removedIdsRef.current.add(c.id)
                            setSelectedIds(prev => prev.filter(id => id !== c.id))
                            await deleteCharge(c.id)
                            writeAudit({
                              hospitalId: hospital?.id, actor: profile,
                              action: 'billing.charge_deleted',
                              entityType: 'billable_charge', entityId: c.id,
                              patientId: patientId || null,
                              summary: `Deleted pending charge "${c.item_name}" — ${formatMoney(c.total)} for ${patientName || 'patient'}`,
                              metadata: {
                                patient_id: patientId,
                                patient_name: patientName,
                                item_name: c.item_name,
                                total: c.total,
                                quantity: c.quantity,
                                source_module: c.source_module,
                                category: c.category,
                              },
                            })
                            showToast(`Deleted "${c.item_name}"`)
                          } catch (err) {
                            // Restore on failure — allow re-selection.
                            removedIdsRef.current.delete(c.id)
                            showToast(err.message || 'Could not delete charge.')
                          }
                        }}
                      >
                        <AppIcon name="close" size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line-soft)' }}>
            <div className="dash-field-grid" style={{ margin: '0 0 16px' }}>
              <div className="field">
                <label>Discount (₦)</label>
                <input type="number" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="0.00" />
              </div>
              <div className="field">
                <label>Tax / VAT (₦)</label>
                <input type="number" value={tax} onChange={e => setTax(e.target.value)} placeholder="0.00" />
              </div>
            </div>

            <div className="billing-summary-row"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
            <div className="billing-summary-row" style={{ color: 'var(--danger)' }}><span>Discount</span><span>- {formatMoney(discountAmt)}</span></div>
            <div className="billing-summary-row" style={{ color: 'var(--gold)' }}><span>Tax / VAT</span><span>+ {formatMoney(taxAmt)}</span></div>
            <div className="billing-summary-row grand" style={{ marginBottom: (hasHmo || walletDeductionPreview > 0) ? 12 : 16 }}>
              <span>Total Bill</span><span style={{ color: 'var(--teal)' }}>{formatMoney(grandTotal)}</span>
            </div>

            {/* Wallet deduction line — shown only when there's a real deduction
                to apply. Mirrors the wallet banner above, but as a totals-row
                so the cashier sees the math: Total Bill - Wallet = Balance Due.
                Without this row, the cashier/patient thinks they owe the full
                Total Bill, when in fact the wallet will auto-cover part of it. */}
            {walletDeductionPreview > 0 && (
              <div className="billing-summary-row" style={{ color: 'var(--teal)', marginBottom: hasHmo ? 12 : 16 }}>
                <span>Wallet Deduction</span><span>- {formatMoney(walletDeductionPreview)}</span>
              </div>
            )}

            {/* True balance due after HMO + wallet. This is the amount the
                patient actually needs to pay out of pocket today. */}
            {(walletDeductionPreview > 0 || hasHmo) && (
              <div className="billing-summary-row" style={{
                marginBottom: 16, paddingTop: 8, borderTop: '1px dashed var(--line-soft)',
                fontSize: 15, fontWeight: 800,
              }}>
                <span>Balance Due</span>
                <span style={{ color: 'var(--gold)' }}>{formatMoney(balanceDueAfterWallet)}</span>
              </div>
            )}

            {hasHmo && (
              <div className="billing-hmo-box" style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  {hmoProvider} Coverage ({hmoCoveragePercent}%)
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: 'var(--muted)' }}>HMO Covers</span>
                  <span style={{ fontWeight: 700, color: 'var(--teal)' }}>{formatMoney(hmoAmount)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 800 }}>
                  <span>Patient Pays</span>
                  <span style={{ color: 'var(--gold)' }}>{formatMoney(patientAmount)}</span>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                  The HMO's share will be auto-filed as a claim in Insurance / HMO Claims.
                </div>
              </div>
            )}

            <div className="field">
              <label>Payment Method</label>
              <div className="billing-method-grid">
                {METHODS.map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`billing-method-chip ${paymentMethod === m ? 'active' : ''}`}
                    onClick={() => setPaymentMethod(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>{hasHmo ? 'Amount Paid by Patient (₦)' : 'Amount Paid (₦)'}</label>
              <input
                type="number"
                value={amountPaid}
                onChange={e => setAmountPaid(e.target.value)}
                placeholder={balanceDueAfterWallet.toFixed(2)}
                style={{ fontSize: 16, fontWeight: 700 }}
              />
            </div>
          </div>
        </div>

        <div className="dash-modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-ghost"
            style={{ color: 'var(--gold)', borderColor: 'var(--gold)' }}
            onClick={handleSaveAsDraft}
            disabled={saving || selectedCharges.length === 0}
            title="Save as a draft — review and finalize later in Billing → Drafts. No invoice number is consumed until finalization."
          >
            {saving ? 'Saving…' : 'Save as Draft'}
          </button>
          <button className="btn btn-primary" onClick={handleGenerateInvoice} disabled={saving || selectedCharges.length === 0}>
            {saving ? 'Generating…' : 'Generate Invoice'}
          </button>
        </div>
      </div>

      {receiptInvoice && (
        <InvoiceViewer
          invoice={receiptInvoice}
          hospital={hospital}
          profile={profile}
          onClose={() => { setReceiptInvoice(null); onClose() }}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
          padding: '10px 18px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, zIndex: 100,
          maxWidth: '85vw', textAlign: 'center',
        }}>
          {toast}
        </div>
      )}

      {showCatalogPicker && (
        <CatalogPicker
          catalog={catalog}
          priceLists={priceLists}
          priceListItems={priceListItems}
          contracts={contracts}
          patient={patients.find(p => p.id === patientId) || null}
          onPick={handleCatalogPick}
          onClose={() => setShowCatalogPicker(false)}
        />
      )}
    </div>
  )
}