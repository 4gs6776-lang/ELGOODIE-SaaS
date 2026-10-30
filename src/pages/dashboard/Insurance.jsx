import { useState } from 'react'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import TrashIcon from '../../components/icons/TrashIcon'
import HmoProviderSelect from '../../components/common/HmoProviderSelect'
import AppIcon from '../../components/icons'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import { writeAudit } from '../../lib/audit'
import {
  CLAIM_STATUSES,
  SHORTFALL_HANDLING_OPTIONS,
  updateClaimStatus,
  handleClaimShortfall,
  generateClaimFormPDF,
  batchSubmitClaims,
} from '../../lib/billingService'

// PROVIDERS is kept for backward compat (used in the existing patientName
// state initializer). The actual UI now uses the searchable HmoProviderSelect
// component which pulls from the larger hmoProviders.js list (~30 HMOs).
const PROVIDERS = ['NHIS', 'Hygeia HMO', 'Reliance HMO', 'AXA Mansard', 'AIICO', 'Avon HMO', 'Other']

export default function Insurance(){
  const { profile, hospital } = useAuth()
  const { records: claims, loading, isOnline, pendingCount, addRecord, deleteRecord, updateRecord } = useOfflineTable('insurance_claims', hospital?.id)
  // Phase 3 — supporting tables
  const { records: invoices } = useOfflineTable('invoices', hospital?.id)
  const { records: invoiceItems } = useOfflineTable('invoice_items', hospital?.id)
  const { records: patients } = useOfflineTable('patients', hospital?.id)
  const { addRecord: addStatusHistory } = useOfflineTable('claim_status_history', hospital?.id)
  const { records: statusHistory } = useOfflineTable('claim_status_history', hospital?.id)
  const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id)
  const [showModal, setShowModal] = useState(false)
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  // Phase 3 — modal state for claim detail + status update + batch selection
  const [selectedClaim, setSelectedClaim] = useState(null)        // claim detail modal
  const [statusFilter, setStatusFilter] = useState('all')          // 'all' | 'submitted' | 'queried' | ...
  const [providerFilter, setProviderFilter] = useState('all')      // filter by HMO provider
  const [selectedIds, setSelectedIds] = useState(new Set())         // batch submission selection

  const [patientName, setPatientName] = useState('')
  const [provider, setProvider] = useState(PROVIDERS[0])
  const [policyNumber, setPolicyNumber] = useState('')
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  function showToast(msg){
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // ---- Realtime ----
  useRealtimeAlert('insurance_claims', hospital?.id, () => {
    showToast(`Claim status updated`)
  }, { event: 'UPDATE' })
  useRealtimeAlert('insurance_claims', hospital?.id, () => {
    showToast(`New claim filed`)
  })

  function formatMoney(n){
    return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })
  }

  async function handleAdd(e){
    e.preventDefault()
    setFormError('')
    if (!patientName || !policyNumber || !amount) {
      setFormError('Patient name, policy number, and amount are required.')
      return
    }
    if (!hospital || !profile) {
      setFormError('Still loading your account — try again in a moment.')
      return
    }
    setSaving(true)
    try {
      await addRecord({
        patient_name: patientName,
        provider,
        policy_number: policyNumber,
        amount: parseFloat(amount),
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        created_by: profile.id,
      })
      setShowModal(false)
      setPatientName(''); setProvider(PROVIDERS[0]); setPolicyNumber(''); setAmount('')
      showToast(isOnline ? 'Claim submitted' : 'Claim submitted — will sync when back online')
    } catch (err) {
      setFormError(err.message || 'Could not save claim')
    } finally {
      setSaving(false)
    }
  }

  async function handleApprove(claim){
    await updateRecord(claim.id, { status: 'approved' })
    showToast(isOnline ? 'Claim approved' : 'Claim approved — will sync when back online')
  }

  async function handleReject(claim){
    const reason = prompt(`Reason for rejecting claim for ${claim.patient_name}:`, claim.rejection_reason || '')
    if (reason === null) return
    await updateRecord(claim.id, { status: 'rejected', rejection_reason: reason })
    showToast(isOnline ? 'Claim rejected' : 'Claim rejected — will sync when back online')
  }

  async function handleReopen(claim){
    await updateRecord(claim.id, { status: 'submitted' })
    showToast(isOnline ? 'Marked submitted' : 'Marked submitted — will sync when back online')
  }

  async function handleDelete(claim){
    if (!confirm(`Delete this claim for ${claim.patient_name}?`)) return
    await deleteRecord(claim.id)
    showToast('Claim deleted')
  }

  // ---- Phase 3: full lifecycle handlers --------------------------------

  // Mark a claim as queried by HMO (with reason)
  async function handleQuery(claim) {
    const reason = prompt(`HMO queried claim for ${claim.patient_name}.\n\nWhat did the HMO ask for?`)
    if (!reason?.trim()) return
    const result = await updateClaimStatus({
      hospital, profile, claim,
      newStatus: 'queried', reason: reason.trim(),
      metadata: { query_reason: reason.trim() },
      updateClaim: updateRecord, addStatusHistory, writeAudit,
    })
    showToast(result.success ? `Marked queried — ${reason.trim()}` : (result.error || 'Could not update'))
  }

  // Approve a claim (optionally with a different approved_amount)
  async function handleApproveWithAmount(claim) {
    const approvedAmountStr = prompt(
      `Approve claim for ${claim.patient_name} (${claim.provider}).\n\n` +
      `Claimed amount: ₦${Number(claim.amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}\n\n` +
      `Enter the APPROVED amount (blank = full claim amount):`,
      String(claim.amount || '')
    )
    if (approvedAmountStr === null) return
    const approvedAmount = parseFloat(approvedAmountStr) || Number(claim.amount || 0)
    const result = await updateClaimStatus({
      hospital, profile, claim,
      newStatus: 'approved', reason: `Approved at ₦${approvedAmount.toFixed(2)}`,
      metadata: { approved_amount: approvedAmount },
      updateClaim: updateRecord, addStatusHistory, writeAudit,
    })
    showToast(result.success ? `Approved — ₦${approvedAmount.toFixed(2)}` : (result.error || 'Could not approve'))
  }

  // Mark claim as paid (with paid_amount + payment_reference)
  async function handleMarkPaid(claim) {
    const paidAmountStr = prompt(
      `Mark claim ${claim.claim_number || ''} as paid.\n\n` +
      `Approved amount: ₦${Number(claim.approved_amount || claim.amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}\n\n` +
      `Enter the amount HMO PAID:`,
      String(claim.approved_amount || claim.amount || '')
    )
    if (paidAmountStr === null) return
    const paidAmount = parseFloat(paidAmountStr) || 0
    const paymentReference = prompt('Payment reference (e.g. bank transfer ref):', '') || ''
    const paymentDate = prompt('Payment date (YYYY-MM-DD, blank = today):', '') || new Date().toISOString().slice(0, 10)
    const result = await updateClaimStatus({
      hospital, profile, claim,
      newStatus: 'paid',
      reason: `HMO paid ₦${paidAmount.toFixed(2)}`,
      metadata: {
        paid_amount: paidAmount,
        payment_reference: paymentReference.trim() || null,
        payment_date: paymentDate,
        approved_amount: claim.approved_amount,
      },
      updateClaim: updateRecord, addStatusHistory, writeAudit,
    })
    if (result.success) {
      const approved = Number(claim.approved_amount ?? claim.amount ?? 0)
      const shortfall = Math.max(0, approved - paidAmount)
      if (shortfall > 0.01) {
        showToast(`Paid ₦${paidAmount.toFixed(2)} — shortfall of ₦${shortfall.toFixed(2)} needs handling`)
      } else {
        showToast(`Paid ₦${paidAmount.toFixed(2)} — fully settled`)
      }
    } else {
      showToast(result.error || 'Could not mark as paid')
    }
  }

  // Reject a claim (with reason)
  async function handleRejectWithReason(claim) {
    const reason = prompt(`Reject claim for ${claim.patient_name}?\n\nReason (required):`, claim.rejection_reason || '')
    if (!reason?.trim()) return
    const rejectionCode = prompt('Rejection code (optional, e.g. "service_not_covered"):', '') || ''
    const result = await updateClaimStatus({
      hospital, profile, claim,
      newStatus: 'rejected', reason: reason.trim(),
      metadata: { rejection_code: rejectionCode.trim() || null },
      updateClaim: updateRecord, addStatusHistory, writeAudit,
    })
    showToast(result.success ? 'Claim rejected' : (result.error || 'Could not reject'))
  }

  // Handle shortfall — pick how to handle the difference
  async function handleShortfall(claim) {
    const shortfall = Number(claim.shortfall_amount || 0)
    if (shortfall <= 0) {
      showToast('No shortfall to handle')
      return
    }
    const options = SHORTFALL_HANDLING_OPTIONS.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
    const choice = prompt(
      `Shortfall of ₦${shortfall.toFixed(2)} on claim ${claim.claim_number || ''}.\n\n` +
      `How should it be handled?\n\n${options}\n\nEnter 1, 2, or 3:`
    )
    if (!choice) return
    const idx = parseInt(choice, 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= SHORTFALL_HANDLING_OPTIONS.length) {
      showToast('Invalid choice')
      return
    }
    const handling = SHORTFALL_HANDLING_OPTIONS[idx].value
    const notes = prompt('Notes (optional):', '') || ''
    const result = await handleClaimShortfall({
      hospital, profile, claim,
      shortfallHandling: handling, notes: notes.trim() || null,
      updateClaim: updateRecord, addBillableCharge, addStatusHistory, writeAudit,
    })
    showToast(result.success ? `Shortfall handled: ${SHORTFALL_HANDLING_OPTIONS[idx].label}` : (result.error || 'Could not handle shortfall'))
  }

  // Generate claim form PDF (NHIS-style)
  function handleGenerateClaimForm(claim) {
    const invoice = invoices.find(i => i.id === claim.invoice_id)
    const items = invoiceItems.filter(it => it.invoice_id === claim.invoice_id)
    const patient = patients.find(p => p.id === claim.patient_id)
    generateClaimFormPDF({ claim, invoice, invoiceItems: items, patient, hospital, profile })
  }

  // Batch submit selected claims
  async function handleBatchSubmit() {
    const selectedClaims = claims.filter(c => selectedIds.has(c.id))
    if (selectedClaims.length === 0) {
      showToast('Select claims first using the checkboxes')
      return
    }
    if (!confirm(`Submit ${selectedClaims.length} claim(s) to ${selectedClaims[0]?.provider || 'HMO'}?`)) return
    const result = await batchSubmitClaims({
      hospital, profile, claims: selectedClaims,
      updateClaim: updateRecord, addStatusHistory, writeAudit,
    })
    if (result.success) {
      showToast(`Batch submitted ${result.submittedCount} claim(s) — batch ${result.batchId.slice(0,8)}`)
      setSelectedIds(new Set())  // clear selection
    } else {
      showToast(result.error || 'Could not batch submit')
    }
  }

  function toggleClaimSelection(claimId) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(claimId)) next.delete(claimId)
      else next.add(claimId)
      return next
    })
  }

  function statusMeta(status){
    // Map Phase 3 statuses to colors + labels
    const found = CLAIM_STATUSES.find(s => s.value === status)
    if (found) {
      // Convert color names to soft backgrounds
      const bgMap = {
        'var(--blue)':   'rgba(59,130,246,0.14)',
        'var(--gold)':   'rgba(201,169,97,0.14)',
        'var(--teal)':   'var(--teal-soft)',
        'var(--mint)':   'rgba(16,185,129,0.14)',
        'var(--danger)': 'rgba(225,104,94,0.14)',
        'var(--violet)': 'rgba(118,87,232,0.14)',
        'var(--muted)':  'rgba(154,170,183,0.14)',
      }
      return { label: found.label, bg: bgMap[found.color] || 'var(--teal-soft)', color: found.color, description: found.description }
    }
    return { label: 'Submitted', bg: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }
  }

  function getClaimHistory(claimId) {
    return (statusHistory || [])
      .filter(h => h.claim_id === claimId)
      .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at))
  }

  const sorted = [...claims].sort((a, b) => new Date(b.submitted_at || b.created_at) - new Date(a.submitted_at || a.created_at))
  const insuranceSearch = searchTerm.trim().toLowerCase()
  const visibleClaims = sorted
    .filter(c => statusFilter === 'all' || c.status === statusFilter)
    .filter(c => {
      if (!insuranceSearch) return true
      return [c.patient_name, c.patient_id, c.provider, c.policy_number, c.claim_number, c.pa_number, c.icd_code, c.status, c.authorization_code]
        .some(v => String(v || '').toLowerCase().includes(insuranceSearch))
    })
  const submittedCount = claims.filter(c => c.status === 'submitted').length
  const approvedTotal = claims.filter(c => c.status === 'approved').reduce((sum, c) => sum + Number(c.amount), 0)
  const rejectedCount = claims.filter(c => c.status === 'rejected').length

  // How much is still owed by each HMO — pending (submitted) claims
  // grouped by provider, so month-end reconciliation is a glance away.
  const owedByProvider = Object.values(
    claims
      .filter(c => c.status === 'submitted')
      .reduce((acc, c) => {
        const key = c.provider || 'Unknown'
        if (!acc[key]) acc[key] = { provider: key, count: 0, total: 0 }
        acc[key].count += 1
        acc[key].total += Number(c.amount) || 0
        return acc
      }, {})
  ).sort((a, b) => b.total - a.total)

  // Global Pagination Rule — claims already live locally (offline
  // cache); only the current page is rendered into the DOM.
  const {
    pageItems: pagedClaims, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(visibleClaims, { pageSize: 10, resetKey: insuranceSearch })

  return (
    <>
      <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
          </div>
          <div>
            <div className="dash-stat-label">Pending</div>
            <div className="dash-stat-value">{submittedCount}</div>
            <div className="dash-stat-delta" style={{ color: 'var(--gold)' }}>awaiting review</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div>
            <div className="dash-stat-label">Approved Value</div>
            <div className="dash-stat-value" style={{ fontSize: 17 }}>{formatMoney(approvedTotal)}</div>
            <div className="dash-stat-delta">{claims.filter(c => c.status === 'approved').length} claim(s)</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
          </div>
          <div>
            <div className="dash-stat-label">Rejected</div>
            <div className="dash-stat-value">{rejectedCount}</div>
            <div className="dash-stat-delta">needs resubmission</div>
          </div>
        </div>
      </div>

      {owedByProvider.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 20 }}>
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title">Amount Owed by Each HMO</div>
              <div className="dash-panel-sub">Pending claims not yet approved/received</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            {owedByProvider.map(row => (
              <div key={row.provider} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{row.provider}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--gold)' }}>{formatMoney(row.total)}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{row.count} claim{row.count === 1 ? '' : 's'} pending</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="dash-panel">
        <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="dash-panel-title">Insurance / HMO Claims</div>
            <div className="dash-panel-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: isOnline ? 'var(--teal)' : 'var(--danger)', display: 'inline-block' }} />
              {isOnline ? 'Online' : 'Offline'}{pendingCount > 0 ? ` · ${pendingCount} syncing` : ''}
              {selectedIds.size > 0 && <span style={{ color: 'var(--teal)', fontWeight: 700 }}> · {selectedIds.size} selected</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}>
              <option value="all">All statuses</option>
              {CLAIM_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search patient, claim #, policy, PA code…" style={{ minWidth: 220, maxWidth: 320 }} />
            {selectedIds.size > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={handleBatchSubmit}
                title="Submit selected claims as a batch to the HMO"
              >
                <AppIcon name="send" size={14} /> Batch Submit ({selectedIds.size})
              </button>
            )}
            <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => setShowModal(true)}>+ New Claim</button>
            <ModuleHistoryButton moduleKey="hmo" />
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
        ) : visibleClaims.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No claims match these filters. Click "+ New Claim" to create one.</div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Claim #</th>
                    <th>Patient</th>
                    <th>Provider</th>
                    <th>Amount</th>
                    <th>Approved</th>
                    <th>Paid</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedClaims.map(claim => {
                    const meta = statusMeta(claim.status)
                    const isSelectable = !['paid', 'approved', 'rejected'].includes(claim.status)
                    return (
                      <tr key={claim.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                        <td style={{ padding: 8, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(claim.id)}
                            onChange={() => toggleClaimSelection(claim.id)}
                            disabled={!isSelectable}
                            style={{ width: 14, height: 14, accentColor: 'var(--teal)', cursor: isSelectable ? 'pointer' : 'not-allowed' }}
                            title={isSelectable ? 'Select for batch submission' : `Cannot batch submit a ${claim.status} claim`}
                          />
                        </td>
                        <td style={{ padding: 8, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, color: 'var(--blue)' }}>
                          {claim.claim_number || '—'}
                        </td>
                        <td style={{ padding: 8, fontWeight: 700, fontSize: 12.5 }}>{claim.patient_name}</td>
                        <td style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>{claim.provider}</td>
                        <td style={{ padding: 8, fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, fontSize: 12.5 }}>{formatMoney(claim.amount)}</td>
                        <td style={{ padding: 8, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: claim.approved_amount != null ? 'var(--teal)' : 'var(--muted)' }}>
                          {claim.approved_amount != null ? formatMoney(claim.approved_amount) : '—'}
                        </td>
                        <td style={{ padding: 8, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: claim.paid_amount != null ? 'var(--mint)' : 'var(--muted)' }}>
                          {claim.paid_amount != null ? formatMoney(claim.paid_amount) : '—'}
                          {Number(claim.shortfall_amount || 0) > 0 && (
                            <div style={{ fontSize: 10, color: 'var(--danger)', fontWeight: 700 }}>
                              ⚠ Shortfall: {formatMoney(claim.shortfall_amount)}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: 8 }}>
                          <span
                            onClick={() => setSelectedClaim(claim)}
                            style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', background: meta.bg, color: meta.color, textTransform: 'uppercase', letterSpacing: 0.5 }}
                            title={meta.description || 'Click to view details'}
                          >
                            {meta.label}
                          </span>
                        </td>
                        <td style={{ padding: 8 }}>
                          <button
                            onClick={() => setSelectedClaim(claim)}
                            className="btn btn-ghost"
                            style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }}
                            title="View claim details + take action"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              startIndex={startIndex}
              endIndex={endIndex}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
              itemLabel="claims"
            />
          </>
        )}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 400 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 18 }}>New Insurance Claim</div>
            {formError && <div className="error-box">{formError}</div>}
            <form onSubmit={handleAdd}>
              <div className="field">
                <label>Patient Name</label>
                <input value={patientName} onChange={e => setPatientName(e.target.value)} placeholder="e.g. Chinedu Okafor" />
              </div>
              <div className="field">
                <label>Provider / HMO</label>
                <HmoProviderSelect
                  value={provider}
                  onChange={setProvider}
                  placeholder="Search HMO provider…"
                  ariaLabel="HMO provider"
                  includeSelfPay={false}
                  hospitalId={hospital?.id}
                />
              </div>
              <div className="field">
                <label>Policy Number</label>
                <input value={policyNumber} onChange={e => setPolicyNumber(e.target.value)} placeholder="e.g. NHIS-2024-00123" />
              </div>
              <div className="field">
                <label>Claim Amount</label>
                <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Submit Claim'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---- Phase 3: Claim Detail Modal ----
          Shows full claim info + lifecycle timeline + action buttons
          for each status transition + shortfall handling + claim form PDF */}
      {selectedClaim && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setSelectedClaim(null) }}>
          <div className="card dash-modal" style={{ maxWidth: 720, maxHeight: '92vh' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14, flexShrink: 0 }}>
              <div>
                <div className="dash-modal-title" style={{ paddingBottom: 0 }}>
                  Claim {selectedClaim.claim_number || selectedClaim.id.slice(0, 8)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  {selectedClaim.patient_name} · {selectedClaim.provider} · {selectedClaim.policy_number || 'no policy #'}
                  {selectedClaim.authorization_code && ` · PA: ${selectedClaim.authorization_code}`}
                </div>
              </div>
              <button className="dash-icon-btn" onClick={() => setSelectedClaim(null)} aria-label="Close"><AppIcon name="close" size={18} /></button>
            </div>

            <div className="dash-modal-body" style={{ overflowY: 'auto' }}>
              {/* Amounts summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
                <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Claimed</div>
                  <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, fontWeight: 700, marginTop: 4 }}>{formatMoney(selectedClaim.amount)}</div>
                </div>
                <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Approved</div>
                  <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, fontWeight: 700, marginTop: 4, color: 'var(--teal)' }}>
                    {selectedClaim.approved_amount != null ? formatMoney(selectedClaim.approved_amount) : '—'}
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Paid</div>
                  <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, fontWeight: 700, marginTop: 4, color: 'var(--mint)' }}>
                    {selectedClaim.paid_amount != null ? formatMoney(selectedClaim.paid_amount) : '—'}
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 8, background: Number(selectedClaim.shortfall_amount || 0) > 0 ? 'rgba(225,104,94,0.08)' : 'var(--bg-elevated)', border: `1px solid ${Number(selectedClaim.shortfall_amount || 0) > 0 ? 'var(--danger)' : 'var(--line-soft)'}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Shortfall</div>
                  <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, fontWeight: 700, marginTop: 4, color: Number(selectedClaim.shortfall_amount || 0) > 0 ? 'var(--danger)' : 'var(--muted)' }}>
                    {Number(selectedClaim.shortfall_amount || 0) > 0 ? formatMoney(selectedClaim.shortfall_amount) : '—'}
                  </div>
                </div>
              </div>

              {/* Current status + description */}
              <div style={{ padding: 10, borderRadius: 8, background: statusMeta(selectedClaim.status).bg, border: `1px solid ${statusMeta(selectedClaim.status).color}33`, marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: statusMeta(selectedClaim.status).color, textTransform: 'uppercase', letterSpacing: 0.5 }}>Current Status</div>
                <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4, color: statusMeta(selectedClaim.status).color }}>{statusMeta(selectedClaim.status).label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{statusMeta(selectedClaim.status).description}</div>
              </div>

              {/* Action buttons — context-sensitive based on current status */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {selectedClaim.status === 'submitted' && (
                  <>
                    <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, color: 'var(--gold)', borderColor: 'var(--gold)' }} onClick={() => handleQuery(selectedClaim)}>Mark as Queried</button>
                    <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5 }} onClick={() => handleApproveWithAmount(selectedClaim)}>Approve</button>
                    <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => handleRejectWithReason(selectedClaim)}>Reject</button>
                  </>
                )}
                {selectedClaim.status === 'queried' && (
                  <>
                    <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5 }} onClick={() => handleApproveWithAmount(selectedClaim)}>Approve</button>
                    <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => handleRejectWithReason(selectedClaim)}>Reject</button>
                  </>
                )}
                {selectedClaim.status === 'approved' && (
                  <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, background: 'var(--mint)' }} onClick={() => handleMarkPaid(selectedClaim)}>Mark as Paid</button>
                )}
                {selectedClaim.status === 'paid' && Number(selectedClaim.shortfall_amount || 0) > 0 && selectedClaim.shortfall_handling == null && (
                  <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, background: 'var(--danger)' }} onClick={() => handleShortfall(selectedClaim)}>Handle Shortfall</button>
                )}
                {selectedClaim.status === 'rejected' && (
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, color: 'var(--violet)', borderColor: 'var(--violet)' }} onClick={async () => {
                    const result = await updateClaimStatus({ hospital, profile, claim: selectedClaim, newStatus: 'disputed', reason: 'Hospital disputes rejection', updateClaim: updateRecord, addStatusHistory, writeAudit })
                    showToast(result.success ? 'Marked disputed' : (result.error || 'Could not dispute'))
                  }}>Dispute Rejection</button>
                )}
                {['approved', 'paid', 'rejected', 'disputed', 'cancelled'].includes(selectedClaim.status) && (
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5 }} onClick={async () => {
                    const result = await updateClaimStatus({ hospital, profile, claim: selectedClaim, newStatus: 'submitted', reason: 'Reopened for resubmission', updateClaim: updateRecord, addStatusHistory, writeAudit })
                    showToast(result.success ? 'Reopened' : (result.error || 'Could not reopen'))
                  }}>Reopen</button>
                )}
                {/* Always-available actions */}
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 12px', fontSize: 11.5, marginLeft: 'auto' }} onClick={() => handleGenerateClaimForm(selectedClaim)} title="Generate NHIS-style printable claim form">
                  <AppIcon name="print" size={12} /> Claim Form PDF
                </button>
              </div>

              {/* Status history timeline */}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  Status History ({getClaimHistory(selectedClaim.id).length} events)
                </div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 8, maxHeight: 200, overflowY: 'auto' }}>
                  {getClaimHistory(selectedClaim.id).length === 0 ? (
                    <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 11.5 }}>No status history yet.</div>
                  ) : getClaimHistory(selectedClaim.id).map(h => (
                    <div key={h.id} style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: statusMeta(h.from_status).bg, color: statusMeta(h.from_status).color, textTransform: 'uppercase' }}>{h.from_status}</span>
                          <span style={{ color: 'var(--muted)', fontSize: 11 }}>→</span>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: statusMeta(h.to_status).bg, color: statusMeta(h.to_status).color, textTransform: 'uppercase' }}>{h.to_status}</span>
                        </div>
                        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{new Date(h.changed_at).toLocaleString('en-NG')}</span>
                      </div>
                      {h.reason && <div style={{ fontSize: 11.5, color: 'var(--ivory)', marginTop: 2 }}>{h.reason}</div>}
                      {h.changed_by_name && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>by {h.changed_by_name}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Rejection / query / shortfall details (if any) */}
              {selectedClaim.rejection_reason && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'rgba(225,104,94,0.08)', border: '1px solid rgba(225,104,94,0.25)', fontSize: 12, color: 'var(--danger)' }}>
                  <strong>Rejection reason:</strong> {selectedClaim.rejection_reason}
                  {selectedClaim.rejection_code && <div style={{ fontSize: 11, marginTop: 2 }}>Code: {selectedClaim.rejection_code}</div>}
                </div>
              )}
              {selectedClaim.query_reason && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'rgba(201,169,97,0.08)', border: '1px solid rgba(201,169,97,0.25)', fontSize: 12, color: 'var(--gold)' }}>
                  <strong>HMO query:</strong> {selectedClaim.query_reason}
                  {selectedClaim.query_response && <div style={{ fontSize: 11, marginTop: 2 }}>Response: {selectedClaim.query_response}</div>}
                </div>
              )}
              {Number(selectedClaim.shortfall_amount || 0) > 0 && selectedClaim.shortfall_handling && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'rgba(118,87,232,0.08)', border: '1px solid rgba(118,87,232,0.25)', fontSize: 12, color: 'var(--violet)' }}>
                  <strong>Shortfall ({selectedClaim.shortfall_handling}):</strong> {formatMoney(selectedClaim.shortfall_amount)}
                  {selectedClaim.shortfall_notes && <div style={{ fontSize: 11, marginTop: 2 }}>{selectedClaim.shortfall_notes}</div>}
                </div>
              )}
            </div>

            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setSelectedClaim(null)}>Close</button>
              <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { handleDelete(selectedClaim); setSelectedClaim(null) }}>Delete Claim</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
          padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 700, zIndex: 60, maxWidth: '85vw', textAlign: 'center',
        }}>
          {toast}
        </div>
      )}
    </>
  )
}
