import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useCurrentHospital } from '../lib/useCurrentHospital';
import {
  formatCurrency,
  generateInstallmentSchedule,
  getPlanProgress,
  createPaymentPlan,
} from '../lib/revenueCycle';
import './RevenueCycle.css';

export default function PaymentPlans({ onSelectPatient }) {
  const { hospitalId, userId } = useCurrentHospital();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [installments, setInstallments] = useState([]);
  const [error, setError] = useState(null);

  // New plan form state
  const [form, setForm] = useState({
    patient_id: '',
    invoice_id: '',
    total_amount: '',
    deposit_amount: 0,
    installment_count: 3,
    frequency: 'monthly',
    start_date: new Date().toISOString().split('T')[0],
    notes: '',
  });
  const [patients, setPatients] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (hospitalId) loadPlans();
  }, [hospitalId]);

  async function loadPlans() {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('payment_plans')
        .select(`
          *,
          patient:patients(id, full_name, hospital_number, phone),
          invoice:invoices(id, invoice_number, total_amount)
        `)
        .eq('hospital_id', hospitalId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setPlans(data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Load patient list when opening the create dialog
  useEffect(() => {
    if (showCreate && hospitalId) {
      supabase
        .from('patients')
        .select('id, full_name, hospital_number, phone')
        .eq('hospital_id', hospitalId)
        .order('full_name')
        .then(({ data }) => setPatients(data || []));
    }
  }, [showCreate, hospitalId]);

  // Load patient's outstanding invoices when patient selected
  useEffect(() => {
    if (form.patient_id) {
      supabase
        .from('invoices')
        .select('id, invoice_number, total_amount, amount_paid, due_date')
        .eq('hospital_id', hospitalId)
        .eq('patient_id', form.patient_id)
        .then(({ data }) => setInvoices(data || []));
    } else {
      setInvoices([]);
    }
  }, [form.patient_id, hospitalId]);

  async function handleCreate() {
    if (!form.patient_id || !form.total_amount) return;
    setSaving(true);
    setError(null);
    try {
      const planId = await createPaymentPlan({
        hospital_id: hospitalId,
        patient_id: form.patient_id,
        invoice_id: form.invoice_id || null,
        total_amount: parseFloat(form.total_amount),
        deposit_amount: parseFloat(form.deposit_amount) || 0,
        installment_count: parseInt(form.installment_count, 10),
        frequency: form.frequency,
        start_date: form.start_date,
        notes: form.notes,
        user_id: userId,
      });
      setShowCreate(false);
      setForm({
        patient_id: '',
        invoice_id: '',
        total_amount: '',
        deposit_amount: 0,
        installment_count: 3,
        frequency: 'monthly',
        start_date: new Date().toISOString().split('T')[0],
        notes: '',
      });
      await loadPlans();
      // Auto-select newly created plan
      const created = (plans.length && plans[0]) || null;
      return planId;
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Load installments for selected plan
  useEffect(() => {
    if (selectedPlan) {
      supabase
        .from('payment_plan_installments')
        .select('*')
        .eq('plan_id', selectedPlan.id)
        .order('installment_no')
        .then(({ data, error }) => {
          if (!error) setInstallments(data || []);
        });
    }
  }, [selectedPlan]);

  // Mark installment paid
  async function recordInstallmentPayment(installment, amount) {
    const newPaid = (installment.amount_paid || 0) + parseFloat(amount);
    const newStatus = newPaid >= installment.amount_due ? 'paid' : 'partial';
    await supabase
      .from('payment_plan_installments')
      .update({
        amount_paid: newPaid,
        status: newStatus,
        paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
      })
      .eq('id', installment.id);

    // Refresh installments
    const { data } = await supabase
      .from('payment_plan_installments')
      .select('*')
      .eq('plan_id', selectedPlan.id)
      .order('installment_no');
    setInstallments(data || []);

    // If all installments paid, mark plan completed
    const allPaid = (data || []).every(i => i.status === 'paid');
    if (allPaid) {
      await supabase
        .from('payment_plans')
        .update({ status: 'completed' })
        .eq('id', selectedPlan.id);
      await loadPlans();
    }
  }

  const filteredPlans = useMemo(() => {
    return plans.filter(p => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const name = p.patient?.full_name || '';
        const num = p.patient?.hospital_number || '';
        return name.toLowerCase().includes(term) || num.includes(term);
      }
      return true;
    });
  }, [plans, searchTerm, statusFilter]);

  const schedulePreview = useMemo(() => {
    if (!form.total_amount) return [];
    return generateInstallmentSchedule({
      totalAmount: parseFloat(form.total_amount),
      depositAmount: parseFloat(form.deposit_amount) || 0,
      installmentCount: parseInt(form.installment_count, 10) || 1,
      frequency: form.frequency,
      startDate: form.start_date,
    });
  }, [form]);

  return (
    <div className="rc-page">
      <header className="rc-header">
        <div>
          <h1>Payment Plans</h1>
          <p>Split large bills into installments for patients</p>
        </div>
        <div className="rc-header-actions">
          <input
            className="rc-search"
            placeholder="Search patient..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
          <select
            className="rc-select"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="defaulted">Defaulted</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button className="rc-btn-primary" onClick={() => setShowCreate(true)}>
            + New Payment Plan
          </button>
        </div>
      </header>

      {error && <div className="rc-error">{error}</div>}

      <div className="rc-grid">
        <div className="rc-list">
          {loading ? (
            <div className="rc-loading">Loading...</div>
          ) : filteredPlans.length === 0 ? (
            <div className="rc-empty">No payment plans found</div>
          ) : (
            filteredPlans.map(plan => {
              const progress = getPlanProgress(plan, plan.installments || []);
              return (
                <div
                  key={plan.id}
                  className={`rc-card ${selectedPlan?.id === plan.id ? 'rc-card-active' : ''}`}
                  onClick={() => setSelectedPlan(plan)}
                >
                  <div className="rc-card-row">
                    <span className="rc-card-title">
                      {plan.patient?.full_name}
                    </span>
                    <span className={`rc-pill rc-pill-${plan.status}`}>
                      {plan.status}
                    </span>
                  </div>
                  <div className="rc-card-row rc-card-meta">
                    <span>{plan.patient?.hospital_number}</span>
                    <span>{formatCurrency(plan.total_amount)}</span>
                  </div>
                  <div className="rc-progress">
                    <div
                      className="rc-progress-bar"
                      style={{ width: `${progress.pct}%` }}
                    />
                  </div>
                  <div className="rc-card-row rc-card-meta">
                    <span>{progress.pct}% paid</span>
                    <span>Next: {plan.next_due_date}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {selectedPlan && (
          <aside className="rc-detail">
            <h2>{selectedPlan.patient?.full_name}</h2>
            <div className="rc-detail-grid">
              <div><label>Total</label><span>{formatCurrency(selectedPlan.total_amount)}</span></div>
              <div><label>Deposit</label><span>{formatCurrency(selectedPlan.deposit_amount)}</span></div>
              <div><label>Balance</label><span>{formatCurrency(selectedPlan.balance_amount)}</span></div>
              <div><label>Installment</label><span>{formatCurrency(selectedPlan.installment_amount)}</span></div>
              <div><label>Frequency</label><span>{selectedPlan.frequency}</span></div>
              <div><label>Next Due</label><span>{selectedPlan.next_due_date}</span></div>
            </div>

            <h3>Installments</h3>
            <table className="rc-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Due Date</th>
                  <th>Amount</th>
                  <th>Paid</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {installments.map(i => (
                  <InstallmentRow
                    key={i.id}
                    installment={i}
                    onPay={recordInstallmentPayment}
                  />
                ))}
              </tbody>
            </table>

            {selectedPlan.notes && (
              <div className="rc-notes">
                <label>Notes</label>
                <p>{selectedPlan.notes}</p>
              </div>
            )}
          </aside>
        )}
      </div>

      {showCreate && (
        <CreatePlanModal
          form={form}
          setForm={setForm}
          patients={patients}
          invoices={invoices}
          schedulePreview={schedulePreview}
          saving={saving}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

function InstallmentRow({ installment, onPay }) {
  const [showPay, setShowPay] = useState(false);
  const [amount, setAmount] = useState('');

  return (
    <>
      <tr>
        <td>{installment.installment_no}</td>
        <td>{installment.due_date}</td>
        <td>{formatCurrency(installment.amount_due)}</td>
        <td>{formatCurrency(installment.amount_paid || 0)}</td>
        <td>
          <span className={`rc-pill rc-pill-${installment.status}`}>
            {installment.status}
          </span>
        </td>
        <td>
          {installment.status !== 'paid' && (
            <button
              className="rc-btn-mini"
              onClick={() => setShowPay(true)}
            >
              Record Payment
            </button>
          )}
        </td>
      </tr>
      {showPay && (
        <tr>
          <td colSpan={6}>
            <div className="rc-pay-inline">
              <input
                type="number"
                placeholder={`Amount (max ${installment.amount_due - (installment.amount_paid || 0)})`}
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
              <button
                className="rc-btn-primary"
                disabled={!amount}
                onClick={() => {
                  onPay(installment, amount);
                  setShowPay(false);
                  setAmount('');
                }}
              >
                Save
              </button>
              <button className="rc-btn-ghost" onClick={() => setShowPay(false)}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function CreatePlanModal({ form, setForm, patients, invoices, schedulePreview, saving, onClose, onCreate }) {
  return (
    <div className="rc-modal-overlay" onClick={onClose}>
      <div className="rc-modal" onClick={e => e.stopPropagation()}>
        <header className="rc-modal-header">
          <h2>Create Payment Plan</h2>
          <button onClick={onClose} className="rc-close">×</button>
        </header>
        <div className="rc-modal-body">
          <div className="rc-form-row">
            <label>Patient *</label>
            <select
              value={form.patient_id}
              onChange={e => setForm({ ...form, patient_id: e.target.value })}
            >
              <option value="">Select patient...</option>
              {patients.map(p => (
                <option key={p.id} value={p.id}>
                  {p.full_name} — {p.hospital_number}
                </option>
              ))}
            </select>
          </div>

          {form.patient_id && invoices.length > 0 && (
            <div className="rc-form-row">
              <label>Linked Invoice (optional)</label>
              <select
                value={form.invoice_id}
                onChange={e => {
                  const inv = invoices.find(i => i.id === e.target.value);
                  setForm({
                    ...form,
                    invoice_id: e.target.value,
                    total_amount: inv
                      ? (inv.total_amount - (inv.amount_paid || 0)).toString()
                      : form.total_amount,
                  });
                }}
              >
                <option value="">No invoice</option>
                {invoices.map(i => (
                  <option key={i.id} value={i.id}>
                    {i.invoice_number} — Balance: {formatCurrency((i.total_amount || 0) - (i.amount_paid || 0))}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="rc-form-row-2">
            <div>
              <label>Total Amount (₦) *</label>
              <input
                type="number"
                value={form.total_amount}
                onChange={e => setForm({ ...form, total_amount: e.target.value })}
              />
            </div>
            <div>
              <label>Deposit (₦)</label>
              <input
                type="number"
                value={form.deposit_amount}
                onChange={e => setForm({ ...form, deposit_amount: e.target.value })}
              />
            </div>
          </div>

          <div className="rc-form-row-2">
            <div>
              <label>Installments</label>
              <input
                type="number"
                min="1"
                value={form.installment_count}
                onChange={e => setForm({ ...form, installment_count: e.target.value })}
              />
            </div>
            <div>
              <label>Frequency</label>
              <select
                value={form.frequency}
                onChange={e => setForm({ ...form, frequency: e.target.value })}
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>

          <div className="rc-form-row">
            <label>Start Date</label>
            <input
              type="date"
              value={form.start_date}
              onChange={e => setForm({ ...form, start_date: e.target.value })}
            />
          </div>

          <div className="rc-form-row">
            <label>Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              rows={2}
            />
          </div>

          {schedulePreview.length > 0 && (
            <div className="rc-preview">
              <h4>Preview Schedule</h4>
              <table className="rc-table">
                <thead>
                  <tr><th>#</th><th>Due</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {schedulePreview.map(s => (
                    <tr key={s.installment_no}>
                      <td>{s.installment_no}</td>
                      <td>{s.due_date}</td>
                      <td>{formatCurrency(s.amount_due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <footer className="rc-modal-footer">
          <button className="rc-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="rc-btn-primary" disabled={saving || !form.patient_id || !form.total_amount} onClick={onCreate}>
            {saving ? 'Creating...' : 'Create Plan'}
          </button>
        </footer>
      </div>
    </div>
  );
}
