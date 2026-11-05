import { useState, useMemo, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { useOfflineTable } from '../lib/useOfflineTable'
import { writeAudit } from '../lib/audit'
import { Send, CreditCard, FileText, Check, X, AlertTriangle, Clock, DollarSign } from 'lucide-react'

// =====================================================================
// RevenueCycleManager — aging dashboard + reminders + payment plans + write-offs
// =====================================================================
// Mounted as a new tab in the Billing module. Shows:
//   1. Aging dashboard (0-30, 31-60, 61-90, 90+ days)
//   2. Overdue invoices with one-click actions (Send Reminder, Payment Plan, Write Off)
//   3. Active payment plans
//   4. Pending write-off approvals
// =====================================================================

function formatMoney(n) {
  return '₦' + new Intl.NumberFormat('en-NG').format(Math.round(Number(n || 0)))
}

function daysSince(dateStr) {
  if (!dateStr) return 0
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24))
}

export default function RevenueCycleManager() {
  const { profile, hospital } = useAuth()
  const { records: invoices } = useOfflineTable('invoices', hospital?.id)
  const { records: patients } = useOfflineTable('patients', hospital?.id)
  const { records: paymentPlans, addRecord: addPlan, updateRecord: updatePlan } = useOfflineTable('payment_plans', hospital?.id, { realtime: true })
  const { records: reminders, addRecord: addReminder } = useOfflineTable('invoice_reminders', hospital?.id, { realtime: true })
  const { records: writeoffs, addRecord: addWriteoff, updateRecord: updateWriteoff } = useOfflineTable('invoice_writeoffs', hospital?.id, { realtime: true })

  const [showPlanModal, setShowPlanModal] = useState(null) // invoice object
  const [showWriteoffModal, setShowWriteoffModal] = useState(null) // invoice object
  const [toast, setToast] = useState('')

  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner'

  // ---- Aging calculation ----
  const aging = useMemo(() => {
    const overdue = (invoices || []).filter(inv =>
      Number(inv.balance || 0) > 0.01 &&
      inv.draft_status !== 'cancelled' &&
      inv.draft_status !== 'written_off'
    )
    const buckets = { '0-30': [], '31-60': [], '61-90': [], '90+': [] }
    for (const inv of overdue) {
      const days = daysSince(inv.created_at)
      if (days <= 30) buckets['0-30'].push(inv)
      else if (days <= 60) buckets['31-60'].push(inv)
      else if (days <= 90) buckets['61-90'].push(inv)
      else buckets['90+'].push(inv)
    }
    const totals = {}
    for (const [k, v] of Object.entries(buckets)) {
      totals[k] = { count: v.length, amount: v.reduce((s, i) => s + Number(i.balance || 0), 0) }
    }
    return { buckets, totals, overdue }
  }, [invoices])

  // ---- Send reminder ----
  const handleSendReminder = useCallback(async (invoice) => {
    const patient = patients.find(p => p.id === invoice.patient_id)
    const daysOverdue = daysSince(invoice.created_at)
    const message = `Dear ${patient?.full_name || 'Patient'}, your outstanding balance at ${hospital?.name || 'our hospital'} is ${formatMoney(invoice.balance)}. Please make payment to avoid service disruption. Thank you.`

    try {
      // Log the reminder
      await addReminder({
        hospital_id: hospital.id,
        invoice_id: invoice.id,
        patient_id: invoice.patient_id,
        reminder_type: 'in_app',
        days_overdue: daysOverdue,
        message_content: message,
        delivery_status: 'sent',
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'invoice.reminder_sent',
        entityType: 'invoices', entityId: invoice.id,
        patientId: invoice.patient_id,
        summary: `Sent reminder for invoice ${invoice.invoice_number || invoice.id.slice(0, 8)} — ${formatMoney(invoice.balance)} (${daysOverdue} days overdue)`,
        metadata: { invoice_id: invoice.id, days_overdue: daysOverdue, amount: invoice.balance },
      })

      setToast(`Reminder sent to ${patient?.full_name || 'patient'} (${formatMoney(invoice.balance)})`)
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }, [patients, hospital, profile, addReminder])

  // ---- Create payment plan ----
  const [planForm, setPlanForm] = useState({ installment_count: 3, frequency: 'monthly' })

  const handleCreatePlan = useCallback(async (e) => {
    e.preventDefault()
    const invoice = showPlanModal
    if (!invoice) return
    const total = Number(invoice.balance || 0)
    const installments = parseInt(planForm.installment_count) || 3
    const installmentAmount = Math.round(total / installments * 100) / 100
    const nextDue = new Date()
    nextDue.setDate(nextDue.getDate() + (planForm.frequency === 'weekly' ? 7 : planForm.frequency === 'biweekly' ? 14 : 30))

    try {
      await addPlan({
        hospital_id: hospital.id,
        patient_id: invoice.patient_id,
        invoice_id: invoice.id,
        total_amount: total,
        amount_paid: 0,
        installment_count: installments,
        installment_amount: installmentAmount,
        frequency: planForm.frequency,
        next_due_date: nextDue.toISOString().slice(0, 10),
        status: 'active',
        created_by: profile.id,
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'payment_plan.created',
        entityType: 'payment_plans', entityId: null,
        patientId: invoice.patient_id,
        summary: `Created payment plan: ${formatMoney(total)} over ${installments} ${planForm.frequency} installments (${formatMoney(installmentAmount)}/installment)`,
        metadata: { invoice_id: invoice.id, total, installments, installment_amount: installmentAmount, frequency: planForm.frequency },
      })

      setShowPlanModal(null)
      setToast('Payment plan created')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }, [showPlanModal, planForm, hospital, profile, addPlan])

  // ---- Create write-off request ----
  const [writeoffForm, setWriteoffForm] = useState({ amount: '', reason: '' })

  const handleCreateWriteoff = useCallback(async (e) => {
    e.preventDefault()
    const invoice = showWriteoffModal
    if (!invoice) return
    const amount = parseFloat(writeoffForm.amount)
    if (isNaN(amount) || amount <= 0 || amount > Number(invoice.balance)) {
      setToast('Invalid write-off amount')
      setTimeout(() => setToast(''), 3000)
      return
    }

    try {
      await addWriteoff({
        hospital_id: hospital.id,
        invoice_id: invoice.id,
        patient_id: invoice.patient_id,
        amount,
        reason: writeoffForm.reason,
        status: amount <= 10000 ? 'approved' : 'pending', // auto-approve small amounts
        requested_by: profile.id,
        requested_by_name: profile.full_name,
        approved_by: amount <= 10000 ? profile.id : null,
        approved_by_name: amount <= 10000 ? profile.full_name : null,
        approved_at: amount <= 10000 ? new Date().toISOString() : null,
      })

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'invoice.writeoff_requested',
        entityType: 'invoice_writeoffs', entityId: null,
        patientId: invoice.patient_id,
        summary: `Write-off requested: ${formatMoney(amount)} for invoice ${invoice.invoice_number || invoice.id.slice(0, 8)} — ${writeoffForm.reason}`,
        metadata: { invoice_id: invoice.id, amount, reason: writeoffForm.reason, auto_approved: amount <= 10000 },
      })

      setShowWriteoffModal(null)
      setWriteoffForm({ amount: '', reason: '' })
      setToast(amount <= 10000 ? 'Write-off approved automatically' : 'Write-off request submitted for approval')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }, [showWriteoffModal, writeoffForm, hospital, profile, addWriteoff])

  // ---- Approve write-off ----
  const handleApproveWriteoff = useCallback(async (wo) => {
    try {
      await updateWriteoff(wo.id, {
        status: 'approved',
        approved_by: profile.id,
        approved_by_name: profile.full_name,
        approved_at: new Date().toISOString(),
      })

      // Reduce the invoice balance
      const invoice = invoices.find(i => i.id === wo.invoice_id)
      if (invoice) {
        const newBalance = Math.max(0, Number(invoice.balance || 0) - Number(wo.amount))
        await supabase.from('invoices').update({
          balance: newBalance,
          draft_status: newBalance < 0.01 ? 'written_off' : invoice.draft_status,
        }).eq('id', invoice.id)
      }

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'invoice.writeoff_approved',
        entityType: 'invoice_writeoffs', entityId: wo.id,
        summary: `Approved write-off of ${formatMoney(wo.amount)} for ${wo.reason}`,
      })

      setToast('Write-off approved')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setToast('Error: ' + err.message)
      setTimeout(() => setToast(''), 3000)
    }
  }, [invoices, hospital, profile, updateWriteoff])

  const pendingWriteoffs = (writeoffs || []).filter(w => w.status === 'pending')
  const activePlans = (paymentPlans || []).filter(p => p.status === 'active')

  return (
    <div>
      {/* ---- Aging Dashboard ---- */}
      <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 20 }}>
        {Object.entries(aging.totals).map(([range, data]) => (
          <div key={range} className="dash-stat-card">
            <div className="dash-stat-icon" style={{
              background: range === '90+' ? 'rgba(240,79,95,0.14)' : range === '61-90' ? 'rgba(232,184,46,0.14)' : 'var(--teal-soft)',
              color: range === '90+' ? 'var(--danger)' : range === '61-90' ? 'var(--gold)' : 'var(--teal)',
            }}>
              <Clock size={20} />
            </div>
            <div>
              <div className="dash-stat-label">{range} days</div>
              <div className="dash-stat-value">{data.count}</div>
              <div className="dash-stat-delta">{formatMoney(data.amount)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ---- Overdue Invoices ---- */}
      {aging.overdue.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 20 }}>
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title">Overdue Invoices ({aging.overdue.length})</div>
              <div className="dash-panel-sub">Total outstanding: {formatMoney(aging.overdue.reduce((s, i) => s + Number(i.balance || 0), 0))}</div>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Patient', 'Invoice', 'Balance', 'Overdue', 'Actions'].map(h => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {aging.overdue.slice(0, 20).map(inv => {
                  const patient = patients.find(p => p.id === inv.patient_id)
                  const days = daysSince(inv.created_at)
                  const dayColor = days > 90 ? 'var(--danger)' : days > 60 ? 'var(--gold)' : 'var(--teal)'
                  return (
                    <tr key={inv.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                      <td style={{ padding: 10, fontWeight: 600, fontSize: 12.5 }}>{patient?.full_name || inv.patient_name || '—'}</td>
                      <td style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>{inv.invoice_number || inv.id.slice(0, 8)}</td>
                      <td style={{ padding: 10, fontSize: 12.5, fontWeight: 700 }}>{formatMoney(inv.balance)}</td>
                      <td style={{ padding: 10, fontSize: 12, color: dayColor, fontWeight: 600 }}>{days}d</td>
                      <td style={{ padding: 10 }}>
                        {isAdmin && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => handleSendReminder(inv)} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, color: 'var(--teal)', borderColor: 'var(--teal-border)' }} title="Send reminder">
                              <Send size={12} />
                            </button>
                            <button onClick={() => { setShowPlanModal(inv); setPlanForm({ installment_count: 3, frequency: 'monthly' }) }} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, color: 'var(--blue)' }} title="Payment plan">
                              <CreditCard size={12} />
                            </button>
                            <button onClick={() => { setShowWriteoffModal(inv); setWriteoffForm({ amount: '', reason: '' }) }} className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, color: 'var(--danger)' }} title="Write off">
                              <FileText size={12} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Active Payment Plans ---- */}
      {activePlans.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 20 }}>
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title">Active Payment Plans ({activePlans.length})</div>
              <div className="dash-panel-sub">Installment schedules for outstanding balances</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {activePlans.map(plan => {
              const patient = patients.find(p => p.id === plan.patient_id)
              const progress = plan.total_amount > 0 ? Math.round((plan.amount_paid / plan.total_amount) * 100) : 0
              return (
                <div key={plan.id} style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div>
                      <strong style={{ fontSize: 13 }}>{patient?.full_name || 'Patient'}</strong>
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>
                        {formatMoney(plan.installment_amount)}/{plan.frequency} · Next: {plan.next_due_date}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal)' }}>{progress}% paid</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--line)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${progress}%`, background: 'var(--teal)', borderRadius: 3, transition: 'width .5s ease' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
                    <span>Paid: {formatMoney(plan.amount_paid)}</span>
                    <span>Remaining: {formatMoney(plan.total_amount - plan.amount_paid)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ---- Pending Write-off Approvals ---- */}
      {isAdmin && pendingWriteoffs.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 20, borderColor: 'var(--danger)' }}>
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title" style={{ color: 'var(--danger)' }}>Pending Write-off Approvals ({pendingWriteoffs.length})</div>
              <div className="dash-panel-sub">Amounts over ₦10,000 require admin approval</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingWriteoffs.map(wo => {
              const patient = patients.find(p => p.id === wo.patient_id)
              return (
                <div key={wo.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 8, background: 'rgba(240,79,95,0.06)', border: '1px solid rgba(240,79,95,0.15)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{patient?.full_name || 'Patient'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      Write off {formatMoney(wo.amount)} — {wo.reason}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted-dim)' }}>
                      Requested by {wo.requested_by_name || '—'} on {new Date(wo.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => handleApproveWriteoff(wo)} className="btn btn-primary" style={{ width: 'auto', padding: '6px 12px', fontSize: 12, background: 'var(--success)', color: '#fff' }}>
                      <Check size={14} /> Approve
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ---- Payment Plan Modal ---- */}
      {showPlanModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowPlanModal(null) }}>
          <div className="card dash-modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">Create Payment Plan</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              Patient: {patients.find(p => p.id === showPlanModal.patient_id)?.full_name || '—'} · Balance: {formatMoney(showPlanModal.balance)}
            </div>
            <form onSubmit={handleCreatePlan}>
              <div className="dash-modal-body">
                <div className="field">
                  <label>Number of Installments</label>
                  <select value={planForm.installment_count} onChange={e => setPlanForm(f => ({ ...f, installment_count: parseInt(e.target.value) }))}>
                    <option value={2}>2 installments</option>
                    <option value={3}>3 installments</option>
                    <option value={6}>6 installments</option>
                    <option value={12}>12 installments</option>
                  </select>
                </div>
                <div className="field">
                  <label>Frequency</label>
                  <select value={planForm.frequency} onChange={e => setPlanForm(f => ({ ...f, frequency: e.target.value }))}>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Bi-weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-elevated)', fontSize: 12.5, color: 'var(--teal)', fontWeight: 600 }}>
                  Each installment: {formatMoney(Number(showPlanModal.balance || 0) / parseInt(planForm.installment_count || 1))}
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowPlanModal(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create Plan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---- Write-off Modal ---- */}
      {showWriteoffModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowWriteoffModal(null) }}>
          <div className="card dash-modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="dash-modal-title">Request Write-off</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              Patient: {patients.find(p => p.id === showWriteoffModal.patient_id)?.full_name || '—'} · Balance: {formatMoney(showWriteoffModal.balance)}
            </div>
            <form onSubmit={handleCreateWriteoff}>
              <div className="dash-modal-body">
                <div className="field">
                  <label>Amount to Write Off (₦) *</label>
                  <input type="number" step="0.01" value={writeoffForm.amount} onChange={e => setWriteoffForm(f => ({ ...f, amount: e.target.value }))} placeholder={`Max: ${showWriteoffModal.balance}`} required />
                </div>
                <div className="field">
                  <label>Reason *</label>
                  <textarea rows={2} value={writeoffForm.reason} onChange={e => setWriteoffForm(f => ({ ...f, reason: e.target.value }))} placeholder="e.g. Patient deceased, bad debt, HMO dispute" required style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
                </div>
                <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(232,184,46,0.08)', border: '1px solid var(--warning-soft)', fontSize: 11.5, color: 'var(--gold)' }}>
                  <AlertTriangle size={12} style={{ display: 'inline', marginRight: 4 }} />
                  Amounts ≤ ₦10,000 are auto-approved. Amounts > ₦10,000 require admin approval.
                </div>
              </div>
              <div className="dash-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowWriteoffModal(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ background: 'var(--danger)' }}>Submit Write-off</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className="dash-toast dash-toast-success">{toast}</div>}
    </div>
  )
}
