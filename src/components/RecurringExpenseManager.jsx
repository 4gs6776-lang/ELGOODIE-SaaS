import { useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from '../lib/useOfflineTable'
import AppIcon from './icons'
import { writeAudit } from '../lib/audit'
import { RECURRING_FREQUENCIES, EXPENSE_CATEGORIES, postRecurringExpense, formatMoney } from '../lib/billingService'

// =====================================================================
// <RecurringExpenseManager> — CRUD UI for recurring_expenses.
// Shown in Settings → Recurring Expenses.
//
// Lists active recurring templates + "Post Now" button for each +
// CRUD modal for create/edit. Shows next_due_date + post_count.
// =====================================================================

const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'POS', 'Cheque', 'Other']

export default function RecurringExpenseManager() {
  const { profile, hospital } = useAuth()
  const { records: recurring, addRecord: addRecurring, updateRecord: updateRecurring, deleteRecord: deleteRecurring } = useOfflineTable('recurring_expenses', hospital?.id)
  const { addRecord: addExpense } = useOfflineTable('hospital_expenses', hospital?.id)
  const { records: vendors } = useOfflineTable('expense_vendors', hospital?.id)

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [posting, setPosting] = useState(null)  // id of template being posted
  const [error, setError] = useState('')

  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    description: '', category: EXPENSE_CATEGORIES[0], amount: '',
    payment_method: 'Bank Transfer', vendor_id: '',
    frequency: 'monthly', day_of_month: '1', next_due_date: today,
    end_date: '', auto_post: false, requires_approval: false,
    approval_threshold: '', reference_template: '', notes: '',
  })

  function resetForm() {
    setForm({
      description: '', category: EXPENSE_CATEGORIES[0], amount: '',
      payment_method: 'Bank Transfer', vendor_id: '',
      frequency: 'monthly', day_of_month: '1', next_due_date: today,
      end_date: '', auto_post: false, requires_approval: false,
      approval_threshold: '', reference_template: '', notes: '',
    })
    setEditingId(null); setError('')
  }

  function openModal(item = null) {
    if (item) {
      setEditingId(item.id)
      setForm({
        description: item.description || '',
        category: item.category || EXPENSE_CATEGORIES[0],
        amount: String(item.amount ?? ''),
        payment_method: item.payment_method || 'Bank Transfer',
        vendor_id: item.vendor_id || '',
        frequency: item.frequency || 'monthly',
        day_of_month: String(item.day_of_month ?? '1'),
        next_due_date: item.next_due_date || today,
        end_date: item.end_date || '',
        auto_post: !!item.auto_post,
        requires_approval: !!item.requires_approval,
        approval_threshold: String(item.approval_threshold ?? ''),
        reference_template: item.reference_template || '',
        notes: item.notes || '',
      })
    } else { resetForm() }
    setShowModal(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setError('')
    if (!form.description.trim()) { setError('Description is required'); return }
    const amt = parseFloat(form.amount)
    if (isNaN(amt) || amt <= 0) { setError('Amount must be greater than 0'); return }
    if (!form.next_due_date) { setError('Next due date is required'); return }

    setSaving(true)
    try {
      const payload = {
        hospital_id: hospital.id,
        description: form.description.trim(),
        category: form.category,
        amount: amt,
        payment_method: form.payment_method,
        vendor_id: form.vendor_id || null,
        frequency: form.frequency,
        day_of_month: parseInt(form.day_of_month, 10) || 1,
        next_due_date: form.next_due_date,
        end_date: form.end_date || null,
        auto_post: !!form.auto_post,
        requires_approval: !!form.requires_approval,
        approval_threshold: parseFloat(form.approval_threshold) || 0,
        reference_template: form.reference_template.trim() || null,
        notes: form.notes.trim() || null,
        is_active: true,
        created_by: profile?.id || null,
        created_by_name: profile?.full_name || null,
      }
      if (editingId) {
        await updateRecurring(editingId, payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'recurring_expense.updated',
          entityType: 'recurring_expense', entityId: editingId,
          summary: `Updated recurring expense "${payload.description}" — ${formatMoney(payload.amount)} (${payload.frequency})`,
          metadata: payload,
        })
      } else {
        const saved = await addRecurring(payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'recurring_expense.created',
          entityType: 'recurring_expense', entityId: saved?.id || null,
          summary: `Created recurring expense "${payload.description}" — ${formatMoney(payload.amount)} (${payload.frequency}, next due ${payload.next_due_date})`,
          metadata: payload,
        })
      }
      setShowModal(false); resetForm()
    } catch (err) {
      setError(err.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function handlePostNow(item) {
    if (!confirm(`Post "${item.description}" now for ${formatMoney(item.amount)}? This creates a hospital expense and advances the next due date.`)) return
    setPosting(item.id)
    try {
      const result = await postRecurringExpense({
        hospital, profile,
        recurring: item,
        addExpense, updateRecurring,
        writeAudit,
      })
      if (result.success) {
        // success — UI will refresh automatically via realtime
      } else {
        alert(result.error || 'Could not post')
      }
    } finally {
      setPosting(null)
    }
  }

  async function handleToggleActive(item) {
    await updateRecurring(item.id, { is_active: !item.is_active })
    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: item.is_active ? 'recurring_expense.deactivated' : 'recurring_expense.activated',
      entityType: 'recurring_expense', entityId: item.id,
      summary: `${item.is_active ? 'Deactivated' : 'Activated'} recurring expense "${item.description}"`,
      metadata: { is_active: !item.is_active },
    })
  }

  async function handleDelete(item) {
    if (!confirm(`Delete recurring expense "${item.description}"? This stops future auto-posts but does NOT delete past expenses.`)) return
    await deleteRecurring(item.id)
    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'recurring_expense.deleted',
      entityType: 'recurring_expense', entityId: item.id,
      summary: `Deleted recurring expense "${item.description}"`,
      metadata: { description: item.description, amount: item.amount },
    })
  }

  const sorted = useMemo(() => {
    return [...(recurring || [])].sort((a, b) => {
      // Active first, then by next_due_date
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
      return new Date(a.next_due_date) - new Date(b.next_due_date)
    })
  }, [recurring])

  const todayDate = new Date().toISOString().slice(0, 10)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => openModal(null)}>
          <AppIcon name="plus" size={14} /> Add Recurring Expense
        </button>
      </div>

      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)', fontSize: 12.5 }}>
          No recurring expenses yet. Add monthly salaries, rent, NEPA bills, etc. to automate posting.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sorted.map(item => {
            const isOverdue = item.is_active && item.next_due_date <= todayDate
            const vendor = vendors?.find(v => v.id === item.vendor_id)
            return (
              <div key={item.id} style={{
                padding: 14, borderRadius: 10,
                background: 'var(--bg-elevated)',
                border: `1px solid ${isOverdue ? 'var(--danger)' : item.is_active ? 'var(--line-soft)' : 'var(--line)'}`,
                opacity: item.is_active ? 1 : 0.6,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{item.description}</strong>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(118,87,232,0.14)', color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{item.category}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(0,199,199,0.14)', color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{item.frequency}</span>
                      {item.auto_post && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(16,185,129,0.14)', color: 'var(--mint)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Auto-post</span>}
                      {!item.is_active && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(154,170,183,0.14)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Inactive</span>}
                      {isOverdue && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(225,104,94,0.14)', color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: 0.5 }}>⚠ Overdue</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                      <strong style={{ color: 'var(--ivory)' }}>{formatMoney(item.amount)}</strong> · {item.payment_method}
                      {vendor && ` · ${vendor.name}`}
                      {item.reference_template && ` · ref: ${item.reference_template}`}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                      Next due: <strong style={{ color: isOverdue ? 'var(--danger)' : 'var(--ivory)' }}>{item.next_due_date}</strong>
                      {item.end_date && ` · ends ${item.end_date}`}
                      {` · posted ${item.post_count || 0}×`}
                      {item.last_posted_at && ` · last ${new Date(item.last_posted_at).toLocaleDateString('en-NG')}`}
                    </div>
                    {item.notes && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>{item.notes}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {item.is_active && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ width: 'auto', padding: '5px 10px', fontSize: 11 }}
                        disabled={posting === item.id}
                        onClick={() => handlePostNow(item)}
                        title="Create an expense NOW using this template, then advance next_due_date"
                      >
                        {posting === item.id ? 'Posting…' : 'Post Now'}
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '5px 10px', fontSize: 11 }} onClick={() => openModal(item)}>Edit</button>
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '5px 10px', fontSize: 11 }} onClick={() => handleToggleActive(item)}>{item.is_active ? 'Disable' : 'Activate'}</button>
                    <button type="button" className="btn btn-ghost" style={{ width: 'auto', padding: '5px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => handleDelete(item)}>Delete</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setShowModal(false); resetForm() } }}>
          <div className="card dash-modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
              <div className="dash-modal-title" style={{ paddingBottom: 0 }}>{editingId ? 'Edit Recurring Expense' : 'Add Recurring Expense'}</div>
              <button className="dash-icon-btn" onClick={() => { setShowModal(false); resetForm() }} aria-label="Close"><AppIcon name="close" size={18} /></button>
            </div>
            <div className="dash-modal-body">
              <form id="recurring-form" onSubmit={handleSave}>
                {error && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Category</label>
                    <select value={form.category} onChange={e => setField('category', e.target.value)}>
                      {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Amount (₦) *</label>
                    <input type="number" min="0" step="any" value={form.amount} onChange={e => setField('amount', e.target.value)} placeholder="e.g. 500000" required style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }} />
                  </div>
                </div>
                <div className="field">
                  <label>Description *</label>
                  <input value={form.description} onChange={e => setField('description', e.target.value)} placeholder="e.g. Staff salaries — April 2026" autoFocus required />
                </div>
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Frequency</label>
                    <select value={form.frequency} onChange={e => setField('frequency', e.target.value)}>
                      {RECURRING_FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Day of Month (1-31)</label>
                    <input type="number" min="1" max="31" value={form.day_of_month} onChange={e => setField('day_of_month', e.target.value)} />
                  </div>
                </div>
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Next Due Date *</label>
                    <input type="date" value={form.next_due_date} onChange={e => setField('next_due_date', e.target.value)} required />
                  </div>
                  <div className="field">
                    <label>End Date (optional)</label>
                    <input type="date" value={form.end_date} onChange={e => setField('end_date', e.target.value)} />
                  </div>
                </div>
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Payment Method</label>
                    <select value={form.payment_method} onChange={e => setField('payment_method', e.target.value)}>
                      {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Vendor (optional)</label>
                    <select value={form.vendor_id} onChange={e => setField('vendor_id', e.target.value)}>
                      <option value="">—</option>
                      {(vendors || []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label>Reference Template (optional)</label>
                  <input value={form.reference_template} onChange={e => setField('reference_template', e.target.value)} placeholder="e.g. RENT-{YYYY}-{MM} (auto-fills each posted expense's reference)" style={{ fontFamily: 'var(--font-mono, monospace)' }} />
                </div>
                <div className="dash-field-grid">
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={form.auto_post} onChange={e => setField('auto_post', e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--mint)' }} />
                      Auto-post on due date
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      If enabled, the system posts automatically (requires server-side cron — for now, click "Post Now" manually).
                    </div>
                  </div>
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={form.requires_approval} onChange={e => setField('requires_approval', e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--gold)' }} />
                      Require approval if amount {'>'} threshold
                    </label>
                    <input type="number" min="0" step="any" value={form.approval_threshold} onChange={e => setField('approval_threshold', e.target.value)} placeholder="e.g. 100000" disabled={!form.requires_approval} style={{ marginTop: 4, opacity: form.requires_approval ? 1 : 0.5, fontFamily: 'var(--font-mono, monospace)' }} />
                  </div>
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <textarea value={form.notes} onChange={e => setField('notes', e.target.value)} rows={2} style={{ width: '100%', padding: '8px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', resize: 'vertical' }} />
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setShowModal(false); resetForm() }} disabled={saving}>Cancel</button>
              <button type="submit" form="recurring-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (editingId ? 'Save Changes' : 'Add Recurring Expense')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  function setField(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }
}
