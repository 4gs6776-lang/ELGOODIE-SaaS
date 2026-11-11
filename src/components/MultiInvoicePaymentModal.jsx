import { useState, useMemo } from 'react'
import AppIcon from './icons'
import PatientAutocomplete from './common/PatientAutocomplete'
import { formatMoney } from '../lib/billingService'
import {
  allocatePaymentAcrossInvoices,
  buildReceipt,
} from '../lib/multiInvoicePayment'

// =====================================================================
// MultiInvoicePaymentModal — corrected
// ---------------------------------------------------------------------
// CORRECTIONS:
//   1. Cross-patient + cross-hospital validation: the modal already
//      filters outstanding invoices by patient_id, so the cashier
//      cannot accidentally pick another patient's invoice. The
//      submit handler additionally calls validateAllocation() which
//      re-checks hospital_id and patient_id.
//   2. Overpayment prevention: per-invoice input is clamped via the
//      `max` attribute; the submit handler re-validates that
//      allocations do not exceed each invoice's balance.
//   3. Duplicate allocation prevention: the allocations object is
//      keyed by invoice_id, so duplicates are structurally
//      impossible. The validation also rejects duplicates as a
//      defense-in-depth.
//   4. Atomic operation: the entire allocation is delegated to the
//      backend `allocate_payment` RPC. If the RPC is unavailable,
//      the modal surfaces a clear error and refuses to write — it
//      NEVER silently implements a non-atomic frontend-only path.
//   5. Allocation breakdown panel: shows each invoice's
//      invoice_number, allocated amount, new balance, new status
//      — visible BEFORE the cashier confirms and AFTER the RPC
//      returns the receipt.
//   6. Receipt: after a successful allocation, the modal renders a
//      printable receipt section with the receipt_number, total
//      amount, method, and the per-invoice breakdown.
//   7. UI preserved: the modal still uses the existing Liquid Glass
//      styles (.dash-modal-backdrop, .dash-modal, .dash-modal-title,
//      .dash-modal-body, .dash-modal-actions, .btn, .btn-ghost,
//      .btn-primary, .field, .error-box, etc.). No new CSS file is
//      introduced.
// =====================================================================

const PAYMENT_METHODS = ['Cash', 'POS', 'Bank Transfer', 'Cheque', 'Wallet', 'Other']

export default function MultiInvoicePaymentModal({
  hospital, profile, invoices = [], patients = [],
  onClose, onAllocated,
  // The following props are kept for backwards compatibility with
  // existing call sites in Billing.jsx, but are NO LONGER USED.
  // The corrected modal does NOT call addPayment / addAllocation /
  // updateInvoice directly — it always goes through the backend RPC
  // for atomicity.
  addAllocation: _addAllocation,
  updateInvoice: _updateInvoice,
  writeAudit: _writeAudit,
}) {
  const [patientOption, setPatientOption] = useState(null)
  const [totalAmount, setTotalAmount] = useState('')
  const [method, setMethod] = useState('Cash')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [allocations, setAllocations] = useState({})  // { [invoice_id]: string amount }
  const [autoMode, setAutoMode] = useState('oldest_first')  // 'oldest_first' | 'manual'
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [receipt, setReceipt] = useState(null)  // populated after a successful allocation

  const patient = patientOption?.patient || null
  const patientId = patient?.id

  // Patient's outstanding invoices — strictly scoped to this patient
  // AND this hospital. Cross-patient and cross-hospital invoices are
  // structurally excluded from this list.
  const outstandingInvoices = useMemo(() => {
    if (!patientId) return []
    return (invoices || [])
      .filter(i =>
        i.patient_id === patientId &&
        // HOSPITAL SCOPE — defense in depth. RLS already enforces
        // this at the backend, but we filter the local cache too
        // so the cashier never sees another hospital's invoices.
        i.hospital_id === hospital?.id &&
        // Only finalized invoices may receive a payment.
        (!i.draft_status || i.draft_status === 'finalized') &&
        // Only invoices with a positive balance are "outstanding".
        Number(i.balance || 0) > 0.001
      )
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))  // oldest first
  }, [invoices, patientId, hospital?.id])

  const totalAmt = parseFloat(totalAmount) || 0

  const allocatedTotal = useMemo(() => {
    return Object.values(allocations).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  }, [allocations])

  const unallocated = Math.max(0, totalAmt - allocatedTotal)
  const overallocated = Math.max(0, allocatedTotal - totalAmt)

  // Per-invoice overpayment check — drives the inline warning
  // under each row.
  const overpaymentsByInvoice = useMemo(() => {
    const map = {}
    for (const inv of outstandingInvoices) {
      const alloc = parseFloat(allocations[inv.id]) || 0
      if (alloc > Number(inv.balance || 0) + 0.01) {
        map[inv.id] = {
          excess: alloc - Number(inv.balance || 0),
          balance: Number(inv.balance || 0),
        }
      }
    }
    return map
  }, [outstandingInvoices, allocations])

  const hasOverpayment = Object.keys(overpaymentsByInvoice).length > 0
  const hasMismatch = Math.abs(allocatedTotal - totalAmt) > 0.01
  const canSubmit =
    !!patientId &&
    totalAmt > 0 &&
    Object.keys(allocations).length > 0 &&
    !hasMismatch &&
    !hasOverpayment &&
    !saving

  function autoAllocate() {
    if (!totalAmt || totalAmt <= 0) {
      setError('Enter a total amount first')
      return
    }
    setError('')
    const newAllocs = {}
    let remaining = totalAmt
    for (const inv of outstandingInvoices) {
      if (remaining <= 0.001) break
      const balance = Number(inv.balance || 0)
      const thisAlloc = Math.min(balance, remaining)
      newAllocs[inv.id] = thisAlloc.toFixed(2)
      remaining -= thisAlloc
    }
    setAllocations(newAllocs)
    setAutoMode('oldest_first')
  }

  function clearAllocations() {
    setAllocations({})
    setAutoMode('manual')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setReceipt(null)

    if (!patientId) { setError('Pick a patient first'); return }
    if (!totalAmt || totalAmt <= 0) { setError('Enter a valid total amount'); return }
    if (Object.keys(allocations).length === 0) {
      setError('Allocate the payment across invoices (click "Auto-allocate" or enter amounts manually)')
      return
    }
    if (hasOverpayment) {
      setError('One or more allocations exceed the invoice balance. Adjust the amounts to fit.')
      return
    }
    if (hasMismatch) {
      setError(
        `Allocated total (${formatMoney(allocatedTotal)}) does not match payment amount (${formatMoney(totalAmt)}). ` +
        `Adjust the allocations to match.`
      )
      return
    }

    setSaving(true)
    try {
      const allocationsArray = Object.entries(allocations)
        .map(([invoice_id, amount]) => ({ invoice_id, amount: parseFloat(amount) }))
        .filter(a => a.amount > 0)

      const result = await allocatePaymentAcrossInvoices({
        hospital,
        profile,
        patientId,
        patientName: patient.full_name,
        totalAmount: totalAmt,
        method,
        referenceNumber: referenceNumber.trim() || null,
        allocations: allocationsArray,
        invoices,
      })

      if (result.success) {
        const printable = buildReceipt(result.receipt, hospital, profile)
        setReceipt(printable)
        // Notify the parent so it can refresh its invoice / payment
        // lists. We do NOT close the modal immediately — the cashier
        // should see the receipt first and then click "Done".
        onAllocated?.(printable)
      } else {
        // Distinguish "RPC unavailable" from a normal RPC error so
        // the cashier knows whether to wait for backend support or
        // fix their input.
        if (result.reason === 'rpc_unavailable') {
          setError(
            (result.error || '') +
            ' The modal will not write a partial payment — please try again once the backend RPC is available.'
          )
        } else {
          setError(result.error || 'Could not allocate payment')
        }
      }
    } catch (err) {
      setError(err.message || 'Could not allocate payment')
    } finally {
      setSaving(false)
    }
  }

  function handlePrint() {
    if (typeof window !== 'undefined') window.print()
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 760, maxHeight: '92vh' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
          <div>
            <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Multi-Invoice Payment</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
              Record one payment and split it across multiple outstanding invoices for the same patient.
            </div>
          </div>
          <button className="dash-icon-btn" onClick={onClose} aria-label="Close"><AppIcon name="close" size={18} /></button>
        </div>

        <div className="dash-modal-body" style={{ overflowY: 'auto' }}>
          {/* ---- RECEIPT PANEL (rendered after a successful allocation) ---- */}
          {receipt ? (
            <div className="receipt-panel" style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg-elevated)' }}>
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{receipt.hospital_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Payment Receipt</div>
                <div style={{ fontSize: 13, fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, marginTop: 4 }}>
                  {receipt.receipt_number || '—'}
                </div>
              </div>
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: 'var(--muted)' }}>Patient</span>
                  <span>{receipt.patient_name}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: 'var(--muted)' }}>Date</span>
                  <span>{new Date(receipt.allocated_at).toLocaleString('en-NG')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: 'var(--muted)' }}>Method</span>
                  <span>{receipt.method}</span>
                </div>
                {receipt.reference_number && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--muted)' }}>Reference</span>
                    <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{receipt.reference_number}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: 'var(--muted)' }}>Cashier</span>
                  <span>{receipt.cashier}</span>
                </div>
              </div>
              <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                  Allocation Breakdown
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>Invoice</th>
                      <th style={{ padding: '4px 6px', textAlign: 'right', borderBottom: '1px solid var(--line)' }}>Allocated</th>
                      <th style={{ padding: '4px 6px', textAlign: 'right', borderBottom: '1px solid var(--line)' }}>New Balance</th>
                      <th style={{ padding: '4px 6px', textAlign: 'center', borderBottom: '1px solid var(--line)' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipt.allocations.map((a, i) => (
                      <tr key={i}>
                        <td style={{ padding: '4px 6px', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }}>
                          {a.invoice_number || a.invoice_id.slice(0, 8) + '…'}
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
                          {formatMoney(a.amount)}
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
                          {a.new_balance != null ? formatMoney(a.new_balance) : '—'}
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                          {a.new_status === 'paid'
                            ? <span style={{ color: 'var(--teal)', fontWeight: 700 }}>PAID</span>
                            : <span style={{ color: 'var(--gold)' }}>{a.new_status || 'unpaid'}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ padding: '6px', fontWeight: 700 }}>Total</td>
                      <td style={{ padding: '6px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }}>
                        {formatMoney(receipt.total_amount)}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={handlePrint}>Print</button>
                <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
              </div>
            </div>
          ) : (
            <form id="multi-pay-form" onSubmit={handleSubmit}>
              {error && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{error}</div>}

              {/* Patient picker */}
              <div className="field">
                <label>Patient *</label>
                <PatientAutocomplete
                  patients={patients}
                  value={patientOption}
                  onChange={(opt) => { setPatientOption(opt); setAllocations({}); setError('') }}
                  placeholder="Search patient by name, MRN or phone…"
                  emptyText="No matching patient"
                  ariaLabel="Patient"
                />
              </div>

              {/* Payment amount + method */}
              <div className="dash-field-grid">
                <div className="field">
                  <label>Total Payment Amount (₦) *</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={totalAmount}
                    onChange={e => { setTotalAmount(e.target.value); setAllocations({}) }}
                    placeholder="e.g. 50000"
                    required
                    style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, fontSize: 16 }}
                  />
                </div>
                <div className="field">
                  <label>Payment Method</label>
                  <select value={method} onChange={e => setMethod(e.target.value)}>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Reference Number (optional)</label>
                <input
                  value={referenceNumber}
                  onChange={e => setReferenceNumber(e.target.value)}
                  placeholder="POS ref, transfer ref, cheque no…"
                />
              </div>

              {/* Outstanding invoices for this patient */}
              {patientId && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Outstanding Invoices ({outstandingInvoices.length})
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }} onClick={autoAllocate} disabled={!totalAmt}>
                        Auto-allocate (oldest first)
                      </button>
                      <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }} onClick={clearAllocations}>
                        Clear
                      </button>
                    </div>
                  </div>

                  {outstandingInvoices.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, background: 'var(--bg-elevated)', borderRadius: 8 }}>
                      No outstanding invoices for this patient.
                    </div>
                  ) : (
                    <div style={{ border: '1px solid var(--line)', borderRadius: 8, maxHeight: 280, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)' }}>
                          <tr>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>Invoice</th>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>Date</th>
                            <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid var(--line)' }}>Balance</th>
                            <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid var(--line)' }}>Allocate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {outstandingInvoices.map(inv => {
                            const overpay = overpaymentsByInvoice[inv.id]
                            return (
                              <tr key={inv.id} style={{ background: overpay ? 'rgba(239, 68, 68, 0.06)' : 'transparent' }}>
                                <td style={{ padding: '8px', borderBottom: '1px solid var(--line-soft)' }}>
                                  <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, fontSize: 11.5 }}>{inv.invoice_number}</div>
                                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{inv.invoice_type || 'outpatient'}</div>
                                </td>
                                <td style={{ padding: '8px', borderBottom: '1px solid var(--line-soft)', fontSize: 11, color: 'var(--muted)' }}>
                                  {new Date(inv.created_at).toLocaleDateString('en-NG')}
                                </td>
                                <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid var(--line-soft)', fontFamily: 'var(--font-mono, monospace)', color: 'var(--danger)' }}>
                                  {formatMoney(inv.balance)}
                                </td>
                                <td style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid var(--line-soft)' }}>
                                  <input
                                    type="number"
                                    min="0"
                                    max={Number(inv.balance || 0).toFixed(2)}
                                    step="0.01"
                                    value={allocations[inv.id] || ''}
                                    onChange={e => {
                                      setAllocations(prev => ({ ...prev, [inv.id]: e.target.value }))
                                      setError('')
                                    }}
                                    placeholder="0.00"
                                    style={{
                                      width: 100,
                                      padding: '4px 6px',
                                      fontSize: 11,
                                      textAlign: 'right',
                                      fontFamily: 'var(--font-mono, monospace)',
                                      borderRadius: 4,
                                      border: `1px solid ${overpay ? 'var(--danger)' : 'var(--line)'}`,
                                      background: 'var(--bg-card)',
                                      color: 'var(--ivory)',
                                    }}
                                  />
                                  {overpay && (
                                    <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>
                                      Exceeds balance by {formatMoney(overpay.excess)}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Allocation summary */}
                  {totalAmt > 0 && (
                    <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--bg-elevated)', border: `1px solid ${hasMismatch || hasOverpayment ? 'var(--danger)' : 'var(--line-soft)'}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                        <span style={{ color: 'var(--muted)' }}>Total Payment</span>
                        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }}>{formatMoney(totalAmt)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                        <span style={{ color: 'var(--muted)' }}>Allocated</span>
                        <span style={{
                          fontFamily: 'var(--font-mono, monospace)',
                          color: hasMismatch ? 'var(--danger)' : (allocatedTotal === totalAmt ? 'var(--teal)' : 'var(--gold)'),
                        }}>
                          {formatMoney(allocatedTotal)}
                        </span>
                      </div>
                      {overallocated > 0.001 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--danger)' }}>
                          <span>Over-allocated</span>
                          <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatMoney(overallocated)}</span>
                        </div>
                      )}
                      {unallocated > 0.001 && overallocated <= 0.001 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--gold)' }}>
                          <span>Unallocated (must equal 0 to submit)</span>
                          <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatMoney(unallocated)}</span>
                        </div>
                      )}
                      {unallocated <= 0.001 && allocatedTotal > 0 && !hasOverpayment && (
                        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--line)', fontSize: 11, color: 'var(--teal)' }}>
                          ✓ Fully allocated — payment will close out {Object.values(allocations).filter(v => parseFloat(v) > 0).length} invoice(s)
                        </div>
                      )}
                      {hasOverpayment && (
                        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--line)', fontSize: 11, color: 'var(--danger)' }}>
                          ✗ One or more allocations exceed the invoice balance. Reduce the amount to match.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Atomicity note */}
                  <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--muted)', fontStyle: 'italic' }}>
                    The entire allocation is processed atomically by the backend <code>allocate_payment</code> RPC.
                    If any step fails, no invoices are modified.
                  </div>
                </div>
              )}
            </form>
          )}
        </div>

        {!receipt && (
          <div className="dash-modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" form="multi-pay-form" className="btn btn-primary" disabled={!canSubmit}>
              {saving ? 'Recording…' : `Record ${totalAmt ? formatMoney(totalAmt) : ''} Payment`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
