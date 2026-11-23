import { useState } from 'react'
import { useOfflineTable } from '../lib/useOfflineTable'
import AppIcon from './icons'
import { writeAudit } from '../lib/audit'
import { formatDateTime, formatDateTimeSec, getTimezone } from '../lib/datetime'

const METHODS = ['Cash', 'POS', 'Bank Transfer', 'Card', 'HMO', 'Insurance', 'Other']

// Categories that should be grouped into a single "Medications" line on
// the printed bill. Items whose category matches are merged into one row
// showing only the total quantity of items and the combined total — the
// individual drug names are NOT listed on the bill (per the user's
// requirement: "instead of showing list of drugs given, it should just
// say 'medications'").
//
// Items without one of these categories (lab tests, imaging, consultation,
// manual charges) are still listed individually.
const DRUG_CATEGORIES = new Set(['Drug', 'Pharmacy', 'Medication', 'Medications'])

// Escape HTML special characters in user-supplied strings before
// interpolating them into the print window's HTML. Prevents broken
// layout when an item name or hospital name contains <, >, &, ", '.
function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export default function InvoiceViewer({ invoice, onClose, hospital, profile, onRegisterCalcTarget, onClearCalcTarget, onApplyDiscount }) {
  const timezone = getTimezone(hospital)
  const { updateRecord: updateInvoice } = useOfflineTable('invoices', hospital?.id)
  const { records: allItems } = useOfflineTable('invoice_items', hospital?.id)
  const { records: allPayments, addRecord: addPayment } = useOfflineTable('payments', hospital?.id)
  const { records: bankAccounts } = useOfflineTable('hospital_bank_accounts', hospital?.id)
  // ---- Patient wallet — for wallet-first deduction on partial payments
  // Per the universal wallet-first rule: ANY charge against a patient
  // who has a wallet balance must deduct from the wallet FIRST, then
  // record the remaining amount as a regular payment. Same logic that
  // CashierWorkspace uses at invoice-creation time, applied here to
  // additional payments recorded against an existing invoice.
  const { records: walletRecords } = useOfflineTable('patient_wallets', hospital?.id)
  const { addRecord: addWalletTxn } = useOfflineTable('patient_wallet_transactions', hospital?.id)
  // Patients — to resolve HMO category (HMO patients bypass the wallet)
  const { records: patients } = useOfflineTable('patients', hospital?.id)

  const [showPay, setShowPay] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('Cash')
  const [saving, setSaving] = useState(false)
  const [payError, setPayError] = useState('')

  const invItems = allItems.filter(i => i.invoice_id === invoice.id)
  const invPayments = allPayments.filter(p => p.invoice_id === invoice.id)

  // ---- Group drug items into a single "Medications" line ------------
  // The user wants the printed bill to show "Medications" as one row
  // instead of listing every individual drug. Lab tests, imaging,
  // consultation fees, and manual charges stay listed individually.
  //
  // Items without a `category` field (e.g. invoices created before this
  // patch was deployed) are listed individually — same as the old
  // behaviour. New invoices (created by the patched CashierWorkspace)
  // will have `category` populated.
  const { groupedMedications, otherItems } = (() => {
    const drugs = invItems.filter(it => DRUG_CATEGORIES.has(it.category))
    const others = invItems.filter(it => !DRUG_CATEGORIES.has(it.category))
    const medsTotal = drugs.reduce((sum, it) => sum + Number(it.total || 0), 0)
    const medsQty = drugs.reduce((sum, it) => sum + Number(it.quantity || 0), 0)
    return {
      groupedMedications: drugs.length > 0
        ? { item_name: 'Medications', quantity: medsQty, unit_price: null, total: medsTotal, count: drugs.length }
        : null,
      otherItems: others,
    }
  })()

  // ---- Active bank accounts for this hospital ------------------------
  // Shown on the printed bill so the patient can pay by bank transfer.
  const activeBankAccounts = (bankAccounts || [])
    .filter(a => a.active !== false && a.hospital_id === hospital?.id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))

  const grandTotal = Number(invoice.grand_total || invoice.amount || 0)
  const totalPaid = Number(invoice.amount_paid || 0)
  const balance = Number(invoice.balance || (grandTotal - totalPaid))
  // Wallet deduction — how much of totalPaid came from the patient's wallet
  // (vs. collected by the cashier in cash/card/etc.). New field added in
  // migration 025. Defaults to 0 for old invoices.
  const walletDeduction = Number(invoice.wallet_deduction || 0)
  const cashierCollected = Math.max(0, totalPaid - walletDeduction)

  // ---- Patient's wallet (for wallet-first deduction on the next payment)
  // HMO patients bypass the wallet — their bills go to the HMO claim flow.
  // Self-pay patients with a wallet get auto-deducted on every payment
  // recorded here, including partial payments against an existing invoice.
  const patientRecord = patients.find(p => p.id === invoice.patient_id) || null
  const isHmoPatient = !!patientRecord?.hmo_provider
    && patientRecord?.hmo_provider !== 'Self-Pay (No HMO)'
    && patientRecord?.category === 'hmo'
  const patientWallet = (!isHmoPatient)
    ? (walletRecords.find(w => w.patient_id === invoice.patient_id) || null)
    : null
  const walletBalance = Number(patientWallet?.balance || 0)
  // How much of the OUTSTANDING BALANCE the wallet could cover right now
  const walletCanCover = patientWallet ? Math.min(walletBalance, balance) : 0
  // The remaining balance after the wallet has done its part — this is
  // what the cashier must collect at the counter (cash / POS / transfer).
  const remainingAfterWallet = Math.max(0, balance - walletCanCover)

  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  async function handleSavePayment(e) {
    e.preventDefault()
    const amt = Number(payAmount) || 0

    // If the wallet can cover the whole balance, the cashier is allowed to
    // leave the amount at 0 — the wallet deduction alone will close out the
    // invoice. Otherwise we require a positive cashier-collected amount.
    if (amt < 0) { setPayError('Amount cannot be negative.'); return }
    if (amt === 0 && walletCanCover <= 0) {
      setPayError('Enter a valid amount (greater than 0).')
      return
    }
    if (amt > remainingAfterWallet + 0.001) {
      // The cashier entered more than what's actually outstanding after
      // the wallet deduction. Show a clear error message — we cap at the
      // remaining balance, never collect more than what's owed.
      if (walletCanCover > 0) {
        setPayError(`The wallet will cover ${formatMoney(walletCanCover)} automatically. The amount you can collect at the counter is at most ${formatMoney(remainingAfterWallet)}.`)
      } else {
        setPayError(`Amount exceeds the outstanding balance (${balance.toFixed(2)}).`)
      }
      return
    }

    // ---- Wallet-first deduction (universal rule) -----------------------
    // Any charge against a patient who has a wallet balance must deduct
    // from the wallet FIRST. The cashier-entered `amt` is the amount
    // they collected at the counter — it does NOT replace the wallet
    // deduction, it stacks on top of it (capped at the remaining
    // balance after the wallet has done its part).
    //
    //   walletDeduction  = min(walletBalance, balance)
    //   cashierCollected = min(amt, balance - walletDeduction)
    //   totalThisPayment = walletDeduction + cashierCollected
    //
    // Edge cases handled:
    //   - Wallet fully covers the balance → cashier's `amt` is refunded
    //     conceptually (we just don't record a cash payment for it).
    //     The cashier should enter 0 — but if they entered more, we cap
    //     cashierCollected at the remaining balance.
    //   - Wallet has 0 → behaves exactly like the old code.
    //   - HMO patient → no wallet deduction, behaves like the old code.
    const walletDeductionThisPayment = walletCanCover  // already capped at balance
    const cashierCollectedThisPayment = Math.max(0, Math.min(amt, balance - walletDeductionThisPayment))
    const totalThisPayment = walletDeductionThisPayment + cashierCollectedThisPayment

    if (totalThisPayment <= 0) {
      setPayError('Nothing to record — the invoice is already fully paid.')
      return
    }
    if (cashierCollectedThisPayment > 0 && cashierCollectedThisPayment < amt - 0.001) {
      // The cashier entered more than the remaining-after-wallet balance.
      // We'll still proceed (capping at the actual remaining balance), but
      // surface a clear note so they're not surprised by the difference.
      // We don't block — the wallet just absorbed part of what they thought
      // was a cash payment.
      // (No alert here; the post-save toast will explain it.)
    }

    setSaving(true)
    setPayError('')
    try {
      // ---- 1. Record the wallet charge (if any) ----------------------
      // Append-only ledger entry. The trigger on patient_wallet_transactions
      // will update the wallets.balance column automatically.
      if (walletDeductionThisPayment > 0 && patientWallet) {
        const newWalletBalance = walletBalance - walletDeductionThisPayment
        await addWalletTxn({
          hospital_id: hospital.id,
          patient_id: invoice.patient_id,
          wallet_id: patientWallet.id,
          type: 'charge',
          amount: -walletDeductionThisPayment,            // negative = money leaving the wallet
          balance_after: newWalletBalance,
          method: 'Wallet',
          invoice_id: invoice.id,
          performed_by: profile?.id,
          performed_by_name: profile?.full_name || null,
          notes: `Auto-deducted for invoice ${invoice.invoice_number || invoice.id.slice(0,8)} (additional payment)`,
        })
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'wallet.charge',
          entityType: 'invoice', entityId: invoice.id,
          patientId: invoice.patient_id,
          summary: `Auto-charged ${formatMoney(walletDeductionThisPayment)} from ${invoice.patient_name || 'patient'}'s wallet for invoice ${invoice.invoice_number || invoice.id.slice(0,8)} (additional payment)`,
          metadata: {
            invoice_id: invoice.id, invoice_number: invoice.invoice_number,
            wallet_id: patientWallet.id,
            wallet_deduction: walletDeductionThisPayment,
            wallet_balance_before: walletBalance,
            wallet_balance_after: newWalletBalance,
          },
        })
      }

      // ---- 2. Record the cashier-collected portion (if any) ---------
      // Only insert a payment row if the cashier actually collected cash /
      // POS / transfer. If the wallet covered the whole remaining balance,
      // there's nothing for the cashier to record — skip the payment row.
      if (cashierCollectedThisPayment > 0) {
        await addPayment({
          hospital_id: hospital.id, invoice_id: invoice.id, patient_id: invoice.patient_id,
          patient_name: invoice.patient_name, amount: cashierCollectedThisPayment, method: payMethod,
          received_by: profile?.id, reference_number: `REF-${Date.now().toString().slice(-6)}`
        })
      }

      // ---- 3. Update the invoice with new totals --------------------
      const newPaid = totalPaid + totalThisPayment
      const newBal = Math.max(0, grandTotal - newPaid)
      const newStatus = newBal <= 0.001 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid')
      // wallet_deduction on the invoice is the cumulative total — add the
      // new deduction to whatever was already recorded.
      const newWalletDeduction = walletDeduction + walletDeductionThisPayment
      await updateInvoice(invoice.id, {
        amount_paid: newPaid,
        balance: newBal,
        wallet_deduction: newWalletDeduction,
        wallet_id: newWalletDeduction > 0 ? (invoice.wallet_id || patientWallet?.id || null) : (invoice.wallet_id || null),
        payment_method: walletDeductionThisPayment > 0
          ? (cashierCollectedThisPayment > 0 ? `${payMethod} + Wallet` : 'Wallet')
          : payMethod,
        status: newStatus,
      })

      // ---- 4. Audit -------------------------------------------------
      writeAudit({
        hospitalId: hospital.id, actor: profile, action: 'invoice.payment_recorded',
        entityType: 'invoice', entityId: invoice.id, patientId: invoice.patient_id || null,
        summary: `Payment of ${formatMoney(totalThisPayment)} recorded for ${invoice.patient_name || 'invoice'} ${invoice.invoice_number || ''} — wallet ${formatMoney(walletDeductionThisPayment)} + cashier ${formatMoney(cashierCollectedThisPayment)} (${payMethod})`.trim(),
        metadata: {
          total_this_payment: totalThisPayment,
          wallet_deduction: walletDeductionThisPayment,
          cashier_collected: cashierCollectedThisPayment,
          method: payMethod,
          invoice_total: grandTotal,
          balance_after: newBal,
        },
      })

      setPayAmount(''); setShowPay(false)
      onClose() // Close to refresh table
    } catch (err) { setPayError(err.message || 'Could not save the payment.') } finally { setSaving(false) }
  }

  function handlePrint() {
    // Build the rows for the printed bill. Drug items are grouped into
    // a single "Medications" line (per the user's requirement); other
    // items are listed individually.
    const rows = []
    if (groupedMedications) {
      rows.push(`<tr><td>Medications</td><td>${escapeHtml(groupedMedications.quantity || '—')}</td><td>—</td><td>₦${Number(groupedMedications.total||0).toFixed(2)}</td></tr>`)
    }
    otherItems.forEach(it => {
      rows.push(`<tr><td>${escapeHtml(it.item_name)}</td><td>${escapeHtml(it.quantity)}</td><td>₦${Number(it.unit_price||0).toFixed(2)}</td><td>₦${Number(it.total||0).toFixed(2)}</td></tr>`)
    })
    const itemsRows = rows.join('')

    // Bank account details section (only if the hospital has any active
    // accounts configured). Shows below the totals on the printed bill.
    const bankSection = activeBankAccounts.length > 0 ? `
      <div class="bank-section">
        <h3>Bank Transfer Details</h3>
        <div class="bank-accounts">
          ${activeBankAccounts.map(a => `
            <div class="bank-account">
              <div><strong>Bank:</strong> ${escapeHtml(a.bank_name)}</div>
              <div><strong>Account Name:</strong> ${escapeHtml(a.account_name)}</div>
              <div><strong>Account Number:</strong> ${escapeHtml(a.account_number)}</div>
              ${a.sort_code ? `<div><strong>Sort Code:</strong> ${escapeHtml(a.sort_code)}</div>` : ''}
              ${a.notes ? `<div class="bank-notes">${escapeHtml(a.notes)}</div>` : ''}
            </div>
          `).join('')}
        </div>
        ${balance > 0 ? `<div class="bank-instructions">Please use the patient name <strong>${escapeHtml(invoice.patient_name || '')}</strong> as the transfer narration. Outstanding balance: <strong>₦${balance.toFixed(2)}</strong></div>` : ''}
      </div>
    ` : ''

    const html = `
      <html><head><title>Receipt ${escapeHtml(invoice.invoice_number)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #111; max-width: 800px; margin: auto; }
        .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 20px; margin-bottom: 30px; }
        .h-name { font-size: 24px; font-weight: bold; text-transform: uppercase; }
        .h-meta { font-size: 14px; color: #555; margin-top: 5px; }
        .grid { display: flex; justify-content: space-between; margin-bottom: 30px; font-size: 14px; }
        .box { background: #f8f9fa; padding: 15px; border-radius: 8px; width: 48%; }
        .box h3 { margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; color: #888; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
        th { background: #f8f9fa; font-weight: bold; }
        .totals { margin-left: auto; width: 300px; font-size: 14px; }
        .totals div { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
        .totals .grand { font-weight: bold; font-size: 18px; border-bottom: 2px solid #000; }
        .bank-section { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px 20px; margin-bottom: 30px; }
        .bank-section h3 { margin: 0 0 12px 0; font-size: 13px; text-transform: uppercase; color: #0369a1; letter-spacing: 1px; }
        .bank-accounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
        .bank-account { background: #fff; padding: 10px 12px; border-radius: 6px; border: 1px solid #e0f2fe; font-size: 13px; line-height: 1.6; }
        .bank-account div { margin-bottom: 2px; }
        .bank-notes { font-style: italic; color: #475569; margin-top: 4px; font-size: 12px; }
        .bank-instructions { margin-top: 12px; font-size: 12px; color: #475569; padding-top: 10px; border-top: 1px dashed #bae6fd; }
        .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #888; }
        .sign { margin-top: 60px; border-top: 1px solid #000; width: 200px; text-align: center; font-size: 12px; padding-top: 5px; }
      </style></head><body>
        <div class="header">
          ${hospital?.logo_url ? `<img src="${escapeHtml(hospital.logo_url)}" alt="logo" style="max-width: 120px; max-height: 80px; margin: 0 auto 10px; display: block; object-fit: contain;" />` : ''}
          <div class="h-name">${escapeHtml(hospital?.name || 'Hospital')}</div>
          ${hospital?.address ? `<div class="h-meta">${escapeHtml(hospital.address)}</div>` : ''}
          ${hospital?.phone ? `<div class="h-meta">Tel: ${escapeHtml(hospital.phone)}</div>` : ''}
        </div>
        <div class="grid">
          <div class="box">
            <h3>Patient Details</h3>
            <div><strong>Name:</strong> ${escapeHtml(invoice.patient_name)}</div>
            <div><strong>ID:</strong> ${escapeHtml(invoice.patient_id || '—')}</div>
          </div>
          <div class="box">
            <h3>Payment Details</h3>
            <div><strong>Receipt #:</strong> ${escapeHtml(invoice.invoice_number || invoice.id.slice(0,8))}</div>
            <div><strong>Date:</strong> ${escapeHtml(formatDateTime(invoice.created_at, timezone))}</div>
            <div><strong>Method:</strong> ${escapeHtml(invoice.payment_method || 'N/A')}</div>
          </div>
        </div>
        <table>
          <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
          <tbody>${itemsRows || '<tr><td colspan="4">No items recorded</td></tr>'}</tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span> <span>₦${Number(invoice.subtotal||grandTotal).toFixed(2)}</span></div>
          ${Number(invoice.discount || 0) > 0 ? `<div><span>Discount${invoice.discount_type && invoice.discount_type !== 'none' && invoice.discount_type !== 'fixed' ? ` (${invoice.discount_type === 'percent' ? Number(invoice.discount_percent||0)+'%' : invoice.discount_type})` : ''}${invoice.discount_reason ? ' — '+escapeHtml(invoice.discount_reason) : ''}</span> <span>- ₦${Number(invoice.discount).toFixed(2)}</span></div>` : ''}
          ${walletDeduction > 0 ? `<div><span>Paid from Wallet</span> <span>₦${walletDeduction.toFixed(2)}</span></div>` : ''}
          ${cashierCollected > 0 ? `<div><span>Amount Paid (${escapeHtml(invoice.payment_method || 'Cash')})</span> <span>₦${cashierCollected.toFixed(2)}</span></div>` : (walletDeduction === 0 ? `<div><span>Amount Paid</span> <span>₦${totalPaid.toFixed(2)}</span></div>` : '')}
          <div class="grand"><span>Balance Due</span> <span>₦${balance.toFixed(2)}</span></div>
        </div>
        ${bankSection}
        <div class="sign">Authorized Signature</div>
        <div class="footer">Thank you for choosing ${escapeHtml(hospital?.name || 'us')}. This is a computer generated receipt.</div>
      </body></html>`
    const win = window.open('', '_blank')
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 500)
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14, flexShrink: 0 }}>
          <div>
            <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Invoice Details</div>
            <div style={{ fontSize: 12.5, color: 'var(--blue)', fontWeight: 700, marginTop: 2 }}>{invoice.invoice_number || invoice.id.slice(0, 8)}</div>
          </div>
          <button className="dash-icon-btn" onClick={onClose} aria-label="Close invoice"><AppIcon name="close" size={18} /></button>
        </div>

        <div className="dash-modal-body">
          <div className="dash-patient-name" style={{ marginBottom: 18 }}>
            <span>{String(invoice.patient_name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{invoice.patient_name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Patient</div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Items Billed</div>
            {invItems.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No specific items recorded (likely a quick charge).</div>
            ) : (
              <>
                {/* Grouped "Medications" line — shown if any drug items exist */}
                {groupedMedications && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, padding: '8px 10px', borderRadius: 6, background: 'rgba(0,199,199,0.06)', border: '1px solid var(--line-soft)' }}>
                    <span>
                      <strong>Medications</strong>
                      <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 11 }}>
                        ({groupedMedications.count} item{groupedMedications.count === 1 ? '' : 's'}, qty {groupedMedications.quantity})
                      </span>
                    </span>
                    <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--teal)' }}>{formatMoney(groupedMedications.total)}</span>
                  </div>
                )}
                {/* Other items (lab tests, imaging, consultation, manual charges) — listed individually */}
                {otherItems.length === 0 && !groupedMedications ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No items to display.</div>
                ) : otherItems.map(it => (
                  <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
                    <span>
                      {it.item_name} (x{it.quantity})
                      {it.category && (
                        <span style={{
                          marginLeft: 8, fontSize: 10, fontWeight: 700,
                          padding: '1px 6px', borderRadius: 10,
                          background: 'rgba(118,87,232,0.14)', color: 'var(--violet)',
                          textTransform: 'uppercase', letterSpacing: 0.3,
                        }}>
                          {it.category}
                        </span>
                      )}
                    </span>
                    <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{formatMoney(it.total)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line-soft)' }} data-calc-avoid>
            {/* Discount breakdown — shows original subtotal, discount
                (with type + percent when structured), and final total.
                Preserves the original amount; never overwrites it. */}
            {Number(invoice.discount || 0) > 0 && (
              <>
                <div className="billing-summary-row" style={{ color: 'var(--muted)' }}>
                  <span>Original Subtotal</span>
                  <span>{formatMoney(Number(invoice.subtotal || 0) + Number(invoice.discount || 0))}</span>
                </div>
                <div className="billing-summary-row" style={{ color: 'var(--danger)' }}>
                  <span>
                    Discount{invoice.discount_type && invoice.discount_type !== 'none' && invoice.discount_type !== 'fixed'
                      ? ` (${invoice.discount_type === 'percent' ? `${Number(invoice.discount_percent || 0)}%` : invoice.discount_type})`
                      : ''}
                    {invoice.discount_reason ? ` — ${invoice.discount_reason}` : ''}
                  </span>
                  <span>- {formatMoney(invoice.discount)}</span>
                </div>
              </>
            )}
            <div className="billing-summary-row"><span>Grand Total</span><span style={{ fontWeight: 700, color: 'var(--ivory)' }}>{formatMoney(grandTotal)}</span></div>
            {walletDeduction > 0 && (
              <div className="billing-summary-row" style={{ color: 'var(--teal)' }}>
                <span>Paid from Wallet</span>
                <span>{formatMoney(walletDeduction)}</span>
              </div>
            )}
            {cashierCollected > 0 && (
              <div className="billing-summary-row" style={{ color: 'var(--teal)' }}>
                <span>Amount Paid ({invoice.payment_method || 'Cash'})</span>
                <span>{formatMoney(cashierCollected)}</span>
              </div>
            )}
            {walletDeduction === 0 && cashierCollected === 0 && (
              <div className="billing-summary-row" style={{ color: 'var(--teal)' }}>
                <span>Amount Paid</span>
                <span>{formatMoney(totalPaid)}</span>
              </div>
            )}
            <div className="billing-summary-row grand" style={{ color: balance > 0 ? 'var(--danger)' : 'var(--teal)' }}>
              <span>Balance Due</span><span>{formatMoney(balance)}</span>
            </div>
          </div>

          {invPayments.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Payment History</div>
              {invPayments.map(p => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <span>{formatDateTimeSec(p.created_at, timezone)} · {p.method}</span>
                  <span style={{ color: 'var(--ivory)', fontWeight: 700 }}>{formatMoney(p.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Bank accounts preview — what the patient will see when they print */}
          {activeBankAccounts.length > 0 && (
            <div style={{ marginTop: 20, padding: 14, borderRadius: 8, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.25)' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Bank Transfer Details <span style={{ color: 'var(--muted)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>(shown on printed bill)</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                {activeBankAccounts.map(a => (
                  <div key={a.id} style={{ fontSize: 12, color: 'var(--ivory)', lineHeight: 1.6 }}>
                    <div><strong>{a.bank_name}</strong></div>
                    <div>{a.account_name}</div>
                    <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--blue)' }}>{a.account_number}</div>
                    {a.notes && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>{a.notes}</div>}
                  </div>
                ))}
              </div>
              {balance > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed rgba(59,130,246,0.25)', fontSize: 11.5, color: 'var(--muted)' }}>
                  Outstanding balance: <strong style={{ color: 'var(--danger)' }}>{formatMoney(balance)}</strong> — use patient name as transfer narration.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dash-modal-actions">
          <button className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }} onClick={handlePrint}>
            <AppIcon name="print" size={15} /> Print Receipt
          </button>
          {onApplyDiscount && invoice && invoice.draft_status !== 'written_off' && invoice.status !== 'cancelled' && (
            <button
              className="btn btn-ghost"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--teal)', borderColor: 'var(--teal)' }}
              onClick={() => onApplyDiscount(invoice)}
              title="Apply a percentage, fixed-amount, or per-item discount to this invoice"
            >
              % Apply Discount
            </button>
          )}
          {balance > 0 && <button className="btn btn-primary" onClick={() => { setPayError(''); setShowPay(true) }}>Record Payment</button>}
        </div>
      </div>

      {showPay && (
        <div className="dash-modal-backdrop" style={{ zIndex: 110 }} onClick={e => { if (e.target === e.currentTarget) setShowPay(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">Record Payment</div>
            <div className="dash-modal-body">
              {/* ---- Wallet-first deduction banner ------------------------
                  Per the universal wallet-first rule: if this patient has
                  a wallet balance, the wallet is deducted FIRST. The
                  cashier-collected amount below is for the REMAINDER after
                  the wallet has done its part. */}
              {walletCanCover > 0 && (
                <div style={{
                  marginBottom: 14, padding: '10px 12px', borderRadius: 8,
                  background: 'rgba(0,199,199,0.08)', border: '1px solid var(--teal-border)',
                  fontSize: 12, color: 'var(--ivory)', lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 700, color: 'var(--teal)', marginBottom: 4 }}>
                    Wallet balance: {formatMoney(walletBalance)}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {walletCanCover >= balance ? (
                      <>The wallet will cover the full outstanding balance of <strong style={{ color: 'var(--teal)' }}>{formatMoney(balance)}</strong>.
                      You can leave the amount below as 0 — the wallet handles it automatically.</>
                    ) : (
                      <>The wallet will auto-deduct <strong style={{ color: 'var(--teal)' }}>{formatMoney(walletCanCover)}</strong> first.
                      The remaining <strong style={{ color: 'var(--gold)' }}>{formatMoney(remainingAfterWallet)}</strong> must be collected at the counter.</>
                    )}
                  </div>
                </div>
              )}
              {isHmoPatient && (
                <div style={{
                  marginBottom: 14, padding: '8px 12px', borderRadius: 8,
                  background: 'rgba(118,87,232,0.06)', border: '1px solid rgba(118,87,232,0.25)',
                  fontSize: 11.5, color: 'var(--muted)',
                }}>
                  <strong style={{ color: 'var(--violet)' }}>HMO patient:</strong> Wallet is bypassed. The patient pays their share directly.
                </div>
              )}
              <form id="record-payment-form" onSubmit={handleSavePayment}>
                {payError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{payError}</div>}
                <div className="field">
                  <label>Amount to Collect at Counter (₦)</label>
                  <input
                    type="number"
                    value={payAmount}
                    onChange={e => setPayAmount(e.target.value)}
                    onFocus={() => onRegisterCalcTarget?.('→ Amount to Collect', (v) => setPayAmount(String(v)))}
                    onBlur={() => onClearCalcTarget?.()}
                    placeholder={walletCanCover > 0
                      ? (remainingAfterWallet > 0 ? `Max: ${remainingAfterWallet.toFixed(2)} (wallet covers the rest)` : '0 — wallet covers everything')
                      : `Max: ${balance.toFixed(2)}`
                    }
                    autoFocus
                  />
                  {walletCanCover > 0 && remainingAfterWallet > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Total payment will be{' '}
                      <strong style={{ color: 'var(--teal)' }}>
                        {formatMoney(walletCanCover + (Math.min(Number(payAmount) || 0, remainingAfterWallet)))}
                      </strong>{' '}
                      (wallet {formatMoney(walletCanCover)} + cash {formatMoney(Math.min(Number(payAmount) || 0, remainingAfterWallet))})
                    </div>
                  )}
                  {walletCanCover >= balance && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Enter 0 (or any amount) — the wallet will fully cover the invoice.
                    </div>
                  )}
                </div>
                <div className="field">
                  <label>Method</label>
                  <select value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                    {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowPay(false)}>Cancel</button>
              <button type="submit" form="record-payment-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Payment'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
