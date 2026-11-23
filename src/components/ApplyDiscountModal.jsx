import { useState, useEffect, useMemo } from 'react'
import { formatMoney } from '../lib/billingService'

// =====================================================================
// ApplyDiscountModal — dedicated discount management UI for an invoice.
//
// Supports: percentage, fixed-amount, item-specific, invoice-wide.
// Preview updates immediately. If the discount exceeds the cashier's
// authorization limit (from hospital_discount_settings), it routes to
// the approval flow (approval_requests table, request_type='discount')
// instead of applying immediately. Reuses existing infrastructure:
//   • apply_invoice_discount RPC (server-authoritative math)
//   • create_discount_approval_request RPC (for over-limit requests)
//   • audit via the RPC itself (billing.discount_applied /
//     billing.discount_approval_requested)
//
// HMO note: HMO coverage is NOT a cashier discount. If the invoice has
// an HMO split, the discount applies to the patient-liable subtotal
// (grand_total already reflects the HMO split), and we display the HMO
// coverage separately so the cashier never confuses the two.
// =====================================================================

export default function ApplyDiscountModal({
  open,
  onClose,
  invoice,            // the invoice row being discounted
  items,              // invoice_items for this invoice (for item discounts)
  profile,
  hospital,
  settings,           // hospital_discount_settings row (from RPC)
  onApplyDiscount,    // async ({invoiceId, type, value, reason, approvalRequestId?, itemDiscounts?}) => {ok, error, ...}
  onRequestApproval,  // async ({invoiceId, type, value, reason}) => {ok, error, requestId}
  showToast,
}) {
  const [type, setType] = useState('percent')           // percent | fixed | item
  const [value, setValue] = useState('')                  // percent or amount
  const [reason, setReason] = useState('')
  const [itemDiscounts, setItemDiscounts] = useState({}) // { [itemId]: { amount:'', percent:'' } }
  const [applying, setApplying] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setType('percent'); setValue(''); setReason(''); setItemDiscounts({}); setError('')
    }
  }, [open, invoice?.id])

  if (!open || !invoice) return null

  const subtotal = useMemo(() => {
    if (!items || items.length === 0) return Number(invoice.subtotal || 0)
    return items.reduce((s, it) => s + Number(it.total || 0), 0)
  }, [items, invoice])

  const numericValue = Number(value) || 0

  const { discountAmount, finalPayable } = useMemo(() => {
    let dAmt = 0
    if (type === 'percent') dAmt = (subtotal * numericValue) / 100
    else if (type === 'fixed') dAmt = numericValue
    else if (type === 'item') {
      dAmt = Object.entries(itemDiscounts).reduce((sum, [itemId, d]) => {
        const item = items?.find(it => it.id === itemId)
        if (!item) return sum
        if (Number(d.percent) > 0) return sum + (Number(item.total) * Number(d.percent)) / 100
        return sum + (Number(d.amount) || 0)
      }, 0)
    }
    dAmt = Math.min(dAmt, subtotal) // cannot exceed subtotal
    return { discountAmount: dAmt, finalPayable: Math.max(0, subtotal - dAmt) }
  }, [type, numericValue, subtotal, itemDiscounts, items])

  // Authorization check: does this discount exceed the cashier's limit?
  const maxPercent = Number(settings?.max_cashier_discount_percent ?? 5)
  const effectivePercent = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0
  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner'
  const exceedsLimit = !isAdmin && effectivePercent > maxPercent

  const reasonRequired = settings?.requires_reason !== false
  const reasonMissing = reasonRequired && !reason.trim()
  const tooLarge = discountAmount > subtotal
  const invalidPercent = type === 'percent' && (numericValue < 0 || numericValue > 100)
  const invalidFixed = type === 'fixed' && numericValue < 0
  const canApply = !reasonMissing && !tooLarge && !invalidPercent && !invalidFixed && discountAmount > 0 && !applying

  const handleApply = async () => {
    setError('')
    if (reasonMissing) { setError('A discount reason is required.'); return }
    if (tooLarge) { setError('Discount cannot exceed the eligible subtotal.'); return }
    if (invalidPercent) { setError('Percentage must be between 0 and 100.'); return }
    if (invalidFixed) { setError('Discount amount cannot be negative.'); return }

    // If the cashier is over their limit, they must request approval —
    // we do NOT apply immediately.
    if (exceedsLimit) {
      setError(`This discount (${effectivePercent.toFixed(1)}%) exceeds your authorization limit (${maxPercent}%). Submit it for supervisor approval.`)
      return
    }

    setApplying(true)
    try {
      const payload = {
        invoiceId: invoice.id, type, value: numericValue, reason: reason.trim(),
      }
      if (type === 'item') {
        payload.itemDiscounts = Object.entries(itemDiscounts)
          .filter(([, d]) => Number(d.amount) > 0 || Number(d.percent) > 0)
          .map(([itemId, d]) => ({
            item_id: itemId,
            amount: Number(d.amount) || 0,
            percent: Number(d.percent) || 0,
          }))
      }
      const res = await onApplyDiscount(payload)
      if (!res?.ok) { setError(res?.error || 'Could not apply discount.'); return }
      showToast?.(`Discount of ${formatMoney(discountAmount)} applied`)
      onClose()
    } catch (e) {
      setError(e?.message || 'Could not apply discount.')
    } finally {
      setApplying(false)
    }
  }

  const handleRequestApproval = async () => {
    setError('')
    if (reasonMissing) { setError('A discount reason is required for approval requests.'); return }
    setRequesting(true)
    try {
      const res = await onRequestApproval({ invoiceId: invoice.id, type, value: numericValue, reason: reason.trim() })
      if (!res?.ok) { setError(res?.error || 'Could not submit approval request.'); return }
      showToast?.(`Approval request submitted — a supervisor will review it.`)
      onClose()
    } catch (e) {
      setError(e?.message || 'Could not submit approval request.')
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 10000, padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated, #fff)', borderRadius: 14,
          width: 'min(560px, 96vw)', maxHeight: '90vh', overflow: 'auto',
          boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border, #eee)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Apply Discount</div>
            <div style={{ fontSize: 12, color: 'var(--muted, #888)', marginTop: 2 }}>
              Invoice {invoice.invoice_number || invoice.id?.slice(0,8)} · {invoice.patient_name || ''}
            </div>
          </div>
          <button onClick={onClose} style={ghostBtn}>✕</button>
        </div>

        <div style={{ padding: 20 }}>
          {/* Discount type selector */}
          <label style={fieldLabel}>Discount type</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
            {[
              { v: 'percent', l: 'Percentage', ex: 'e.g. 10%' },
              { v: 'fixed', l: 'Fixed amount', ex: 'e.g. ₦5,000' },
              ...(settings?.enable_item_discounts !== false ? [{ v: 'item', l: 'Per item', ex: 'individual lines' }] : []),
            ].map(opt => (
              <button
                key={opt.v}
                onClick={() => { setType(opt.v); setValue(''); setError('') }}
                style={{
                  padding: '10px 8px', borderRadius: 10, cursor: 'pointer',
                  border: type === opt.v ? '1px solid var(--teal, #0d9488)' : '1px solid var(--border, #e2e2e2)',
                  background: type === opt.v ? 'var(--teal-soft, #e6f7f5)' : 'var(--bg-muted, #f7f7f7)',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: type === opt.v ? 'var(--teal, #0d9488)' : 'var(--text, #333)' }}>{opt.l}</div>
                <div style={{ fontSize: 10.5, color: 'var(--muted, #888)', marginTop: 2 }}>{opt.ex}</div>
              </button>
            ))}
          </div>

          {/* Value input (for percent / fixed) */}
          {type !== 'item' && (
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabel}>
                {type === 'percent' ? 'Discount percentage (%)' : 'Discount amount (₦)'}
              </label>
              <input
                type="number"
                value={value}
                onChange={e => { setValue(e.target.value); setError('') }}
                placeholder={type === 'percent' ? '0' : '0.00'}
                min="0"
                style={inputStyle}
                autoFocus
              />
            </div>
          )}

          {/* Item-specific discount table */}
          {type === 'item' && (
            <div style={{ marginBottom: 16, maxHeight: 220, overflow: 'auto', border: '1px solid var(--border, #eee)', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-muted, #f7f7f7)' }}>
                    <th style={th}>Item</th>
                    <th style={th}>Total</th>
                    <th style={th}>% Off</th>
                    <th style={th}>Or ₦ off</th>
                  </tr>
                </thead>
                <tbody>
                  {(items || []).map(it => {
                    const d = itemDiscounts[it.id] || { percent: '', amount: '' }
                    return (
                      <tr key={it.id} style={{ borderTop: '1px solid var(--border, #f0f0f0)' }}>
                        <td style={td}>{it.item_name || it.name}</td>
                        <td style={td}>{formatMoney(it.total)}</td>
                        <td style={td}>
                          <input type="number" min="0" max="100" value={d.percent}
                            onChange={e => setItemDiscounts(prev => ({ ...prev, [it.id]: { ...d, percent: e.target.value, amount: '' } }))}
                            style={miniInput} />
                        </td>
                        <td style={td}>
                          <input type="number" min="0" value={d.amount}
                            onChange={e => setItemDiscounts(prev => ({ ...prev, [it.id]: { ...d, amount: e.target.value, percent: '' } }))}
                            style={miniInput} />
                        </td>
                      </tr>
                    )
                  })}
                  {(!items || items.length === 0) && (
                    <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: 'var(--muted, #999)' }}>No billable items on this invoice.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Reason */}
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>Reason {reasonRequired && <span style={{ color: '#c0392b' }}>*</span>}</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Staff discount, good-will gesture, supervisor-approved waiver…"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {/* Preview */}
          <div style={{ background: 'var(--bg-muted, #f7f7f7)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted, #666)', marginBottom: 8, letterSpacing: 0.3 }}>PREVIEW</div>
            <Row label="Original subtotal" value={formatMoney(subtotal)} />
            {invoice.hmo_contract_id && (
              <Row label="HMO coverage" value="respected — not a discount" muted />
            )}
            <Row label={`Discount (${type === 'percent' ? `${numericValue}%` : type === 'fixed' ? 'fixed' : 'item'})`}
              value={`- ${formatMoney(discountAmount)}`} accent="var(--teal, #0d9488)" />
            <div style={{ borderTop: '1px solid var(--border, #e2e2e2)', margin: '8px 0' }} />
            <Row label="Final payable amount" value={formatMoney(finalPayable)} bold />
            {invoice.amount_paid > 0 && (
              <Row label="Already paid" value={formatMoney(invoice.amount_paid)} muted />
            )}
            <Row label="New outstanding balance" value={formatMoney(Math.max(0, finalPayable - Number(invoice.amount_paid || 0)))} />
          </div>

          {/* Authorization banner */}
          {exceedsLimit && (
            <div style={{ background: 'var(--gold-soft, #fbf3dd)', border: '1px solid var(--gold, #c8a44a)',
              borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12.5 }}>
              ⚠ This discount ({effectivePercent.toFixed(1)}%) exceeds your authorization limit
              ({maxPercent}%). It must be submitted for supervisor approval — it will <b>not</b> be
              applied until approved.
            </div>
          )}
          {error && (
            <div style={{ background: '#fdecea', border: '1px solid #e57373', borderRadius: 8,
              padding: 10, marginBottom: 16, fontSize: 12.5, color: '#c0392b' }}>{error}</div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={ghostBtn}>Cancel</button>
            {exceedsLimit ? (
              <button onClick={handleRequestApproval} disabled={!!requesting || !!reasonMissing}
                style={primaryBtn(requesting || reasonMissing)}>
                {requesting ? 'Submitting…' : 'Submit for approval'}
              </button>
            ) : (
              <button onClick={handleApply} disabled={!canApply}
                style={primaryBtn(!canApply)}>
                {applying ? 'Applying…' : `Apply ${formatMoney(discountAmount)} discount`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- styles ----
const ghostBtn = {
  background: 'transparent', border: '1px solid var(--border, #e2e2e2)',
  borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--muted, #666)',
}
const primaryBtn = (disabled) => ({
  background: disabled ? 'var(--bg-muted, #e0e0e0)' : 'var(--teal, #0d9488)',
  color: disabled ? 'var(--muted, #999)' : '#fff', border: 'none', borderRadius: 8,
  padding: '8px 16px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700,
})
const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted, #666)', marginBottom: 6 }
const inputStyle = {
  width: '100%', padding: '9px 12px', fontSize: 14, borderRadius: 8,
  border: '1px solid var(--border, #e2e2e2)', background: 'var(--bg-elevated, #fff)',
  color: 'var(--text, #1a1a1a)',
}
const miniInput = { width: 70, padding: '4px 6px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border, #e2e2e2)', textAlign: 'center' }
const th = { padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--muted, #666)' }
const td = { padding: '6px 8px', fontSize: 12.5, color: 'var(--text, #333)' }

function Row({ label, value, muted, bold, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
      <span style={{ color: muted ? 'var(--muted, #999)' : 'var(--text, #555)', fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ color: accent || (muted ? 'var(--muted, #999)' : 'var(--text, #1a1a1a)'), fontWeight: bold ? 700 : 600 }}>{value}</span>
    </div>
  )
}
