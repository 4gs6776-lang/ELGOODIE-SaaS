import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useCurrentHospital } from '../lib/useCurrentHospital';
import {
  WRITEOFF_TYPES,
  getWriteoffPolicy,
  formatCurrency,
  requestWriteoff,
  approveWriteoff,
} from '../lib/revenueCycle';
import './RevenueCycle.css';

export default function WriteOffManager({ prefill }) {
  const { hospitalId, userId, userRole } = useCurrentHospital();
  const [writeoffs, setWriteoffs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showRequest, setShowRequest] = useState(false);
  const [tab, setTab] = useState('pending');
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const [form, setForm] = useState({
    patient_id: '', invoice_id: '', amount: '',
    writeoff_type: 'bad_debt', reason: '', justification: '',
  });
  const [patients, setPatients] = useState([]);
  const [invoices, setInvoices] = useState([]);

  const canApprove = useMemo(
    () => ['admin', 'super_admin', 'finance_manager', 'medical_director'].includes(userRole),
    [userRole]
  );

  useEffect(() => {
    if (hospitalId) loadWriteoffs();
  }, [hospitalId, tab]);

  useEffect(() => {
    if (prefill) {
      setForm({
        patient_id: prefill.patient_id || '',
        invoice_id: prefill.invoice_id || '',
        amount: prefill.amount?.toString() || '',
        writeoff_type: 'bad_debt', reason: '', justification: '',
      });
      setShowRequest(true);
    }
  }, [prefill]);

  // FIX: 2-step fetch — no nested select on `users` (which doesn't exist)
  // The component was using `requester:users!requested_by(full_name)` which
  // fails because the project uses `profiles`, not `users`. The v_pending_writeoffs
  // view already joins profiles correctly, so we can use it for the pending tab.
  // For the processed tab, we do a 2-step fetch.
  async function loadWriteoffs() {
    setLoading(true);
    try {
      if (tab === 'pending') {
        // Use the v_pending_writeoffs view which already joins profiles
        const { data, error } = await supabase
          .from('v_pending_writeoffs')
          .select('*')
          .eq('hospital_id', hospitalId)
          .order('requested_at', { ascending: false });
        if (error) throw error;
        setWriteoffs(data || []);
      } else {
        // Processed tab — fetch writeoffs, then join patients + profiles in JS
        const { data: woRows, error: woErr } = await supabase
          .from('invoice_writeoffs')
          .select('*')
          .eq('hospital_id', hospitalId)
          .in('status', ['approved', 'applied', 'rejected'])
          .order('created_at', { ascending: false });
        if (woErr) throw woErr;
        if (!woRows || woRows.length === 0) {
          setWriteoffs([]);
        } else {
          // Fetch patients and profiles (requesters) separately
          const patientIds = [...new Set(woRows.map(w => w.patient_id).filter(Boolean))];
          const requesterIds = [...new Set(woRows.map(w => w.requested_by).filter(Boolean))];

          const [patResp, profResp] = await Promise.all([
            patientIds.length > 0
              ? supabase.from('patients').select('id, full_name, hospital_number').in('id', patientIds)
              : Promise.resolve({ data: [] }),
            requesterIds.length > 0
              ? supabase.from('profiles').select('id, full_name').in('id', requesterIds)
              : Promise.resolve({ data: [] }),
          ]);

          const patMap = (patResp.data || []).reduce((m, p) => { m[p.id] = p; return m; }, {});
          const profMap = (profResp.data || []).reduce((m, p) => { m[p.id] = p; return m; }, {});

          const joined = woRows.map(w => ({
            ...w,
            patient: patMap[w.patient_id] || null,
            requester: profMap[w.requested_by] || null,
          }));
          setWriteoffs(joined);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (showRequest && hospitalId) {
      supabase
        .from('patients')
        .select('id, full_name, hospital_number')
        .eq('hospital_id', hospitalId)
        .order('full_name')
        .then(({ data }) => setPatients(data || []));
    }
  }, [showRequest, hospitalId]);

  useEffect(() => {
    if (form.patient_id) {
      supabase
        .from('invoices')
        .select('id, invoice_number, amount, grand_total, amount_paid')
        .eq('hospital_id', hospitalId)
        .eq('patient_id', form.patient_id)
        .then(({ data }) => setInvoices(data || []));
    } else {
      setInvoices([]);
    }
  }, [form.patient_id, hospitalId]);

  async function handleRequest() {
    if (!form.patient_id || !form.amount || !form.reason) {
      setError('Patient, amount, and reason are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const id = await requestWriteoff({
        hospital_id: hospitalId,
        patient_id: form.patient_id,
        invoice_id: form.invoice_id || null,
        amount: parseFloat(form.amount),
        writeoff_type: form.writeoff_type,
        reason: form.reason,
        justification: form.justification,
        user_id: userId,
      });

      const policy = getWriteoffPolicy(parseFloat(form.amount), form.writeoff_type);
      if (policy.autoApprovable) {
        setToast({ type: 'success', msg: 'Write-off auto-approved (below threshold)' });
      } else {
        setToast({ type: 'info', msg: 'Write-off submitted for admin approval' });
      }

      setShowRequest(false);
      setForm({ patient_id: '', invoice_id: '', amount: '', writeoff_type: 'bad_debt', reason: '', justification: '' });
      await loadWriteoffs();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(writeoffId) {
    setLoading(true);
    try {
      await approveWriteoff(writeoffId, userId, 'approved');
      setToast({ type: 'success', msg: 'Write-off approved & applied to invoice' });
      await loadWriteoffs();
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function handleReject(writeoffId) {
    if (!rejectReason) return;
    setLoading(true);
    try {
      await approveWriteoff(writeoffId, userId, 'rejected', rejectReason);
      setToast({ type: 'info', msg: 'Write-off rejected' });
      setRejecting(null);
      setRejectReason('');
      await loadWriteoffs();
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setLoading(false);
    }
  }

  const policy = useMemo(
    () => form.amount ? getWriteoffPolicy(parseFloat(form.amount), form.writeoff_type) : null,
    [form.amount, form.writeoff_type]
  );

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  return (
    <div className="rc-page">
      <header className="rc-header">
        <div>
          <h1>Write-offs</h1>
          <p>Bad debt, charity care, and adjustments</p>
        </div>
        <div className="rc-header-actions">
          <button className="rc-btn-primary" onClick={() => setShowRequest(true)}>+ Request Write-off</button>
        </div>
      </header>

      {error && <div className="rc-error">{error}</div>}
      {toast && <div className={`rc-toast rc-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="rc-tabs">
        <button className={`rc-tab ${tab === 'pending' ? 'rc-tab-active' : ''}`} onClick={() => setTab('pending')}>Pending Approval</button>
        <button className={`rc-tab ${tab === 'processed' ? 'rc-tab-active' : ''}`} onClick={() => setTab('processed')}>Processed</button>
      </div>

      <table className="rc-table">
        <thead>
          <tr>
            <th>Patient</th><th>Type</th><th>Amount</th><th>Status</th>
            <th>Requested By</th><th>Reason</th>
            {canApprove && tab === 'pending' && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7}>Loading...</td></tr>
          ) : writeoffs.length === 0 ? (
            <tr><td colSpan={7} className="rc-empty">No write-offs in this view</td></tr>
          ) : writeoffs.map(w => (
            <tr key={w.id}>
              <td>
                <div>{w.patient?.full_name || w.patient_name || 'Unknown'}</div>
                <div className="rc-meta">{w.patient?.hospital_number || w.hospital_number || '—'}</div>
              </td>
              <td>{WRITEOFF_TYPES.find(t => t.id === w.writeoff_type)?.label || w.writeoff_type}</td>
              <td className="rc-amount">{formatCurrency(w.writeoff_amount)}</td>
              <td>
                <span className={`rc-pill rc-pill-${w.status === 'pending_approval' ? 'pending' : w.status === 'approved' || w.status === 'applied' ? 'paid' : 'overdue'}`}>
                  {w.status.replace('_', ' ')}
                </span>
                {w.requires_admin_approval && w.status === 'pending_approval' && (
                  <span className="rc-pill rc-pill-overdue" style={{ marginLeft: 4 }}>Admin</span>
                )}
              </td>
              <td>{w.requested_by_name || w.requester?.full_name || '—'}</td>
              <td className="rc-cell-reason">{w.reason}</td>
              {canApprove && tab === 'pending' && (
                <td>
                  {rejecting === w.id ? (
                    <div className="rc-reject-inline">
                      <input type="text" placeholder="Rejection reason" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
                      <button className="rc-btn-danger" onClick={() => handleReject(w.id)}>Confirm</button>
                      <button className="rc-btn-ghost" onClick={() => { setRejecting(null); setRejectReason(''); }}>Cancel</button>
                    </div>
                  ) : (
                    <div className="rc-action-row">
                      <button className="rc-btn-mini" onClick={() => handleApprove(w.id)}>✓ Approve</button>
                      <button className="rc-btn-mini rc-btn-danger" onClick={() => setRejecting(w.id)}>✗ Reject</button>
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {showRequest && (
        <div className="rc-modal-overlay" onClick={() => setShowRequest(false)}>
          <div className="rc-modal" onClick={e => e.stopPropagation()}>
            <header className="rc-modal-header">
              <h2>Request Write-off</h2>
              <button className="rc-close" onClick={() => setShowRequest(false)}>×</button>
            </header>
            <div className="rc-modal-body">
              <div className="rc-form-row">
                <label>Patient *</label>
                <select value={form.patient_id} onChange={e => setForm({ ...form, patient_id: e.target.value })}>
                  <option value="">Select patient...</option>
                  {patients.map(p => (
                    <option key={p.id} value={p.id}>{p.full_name} — {p.hospital_number}</option>
                  ))}
                </select>
              </div>

              {form.patient_id && invoices.length > 0 && (
                <div className="rc-form-row">
                  <label>Invoice (optional)</label>
                  <select value={form.invoice_id} onChange={e => setForm({ ...form, invoice_id: e.target.value })}>
                    <option value="">No specific invoice</option>
                    {invoices.map(i => (
                      <option key={i.id} value={i.id}>
                        {i.invoice_number} — Outstanding: {formatCurrency((i.grand_total || i.amount || 0) - (i.amount_paid || 0))}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="rc-form-row-2">
                <div>
                  <label>Amount (₦) *</label>
                  <input type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
                </div>
                <div>
                  <label>Type</label>
                  <select value={form.writeoff_type} onChange={e => setForm({ ...form, writeoff_type: e.target.value })}>
                    {WRITEOFF_TYPES.map(t => (<option key={t.id} value={t.id}>{t.label}</option>))}
                  </select>
                </div>
              </div>

              {policy && (
                <div className={`rc-policy-banner ${policy.autoApprovable ? 'rc-policy-auto' : 'rc-policy-admin'}`}>
                  {policy.autoApprovable
                    ? `✓ Below ${formatCurrency(policy.threshold)} — auto-approved (${policy.label})`
                    : `⚠ Above ${formatCurrency(policy.threshold)} — requires admin approval`}
                </div>
              )}

              <div className="rc-form-row">
                <label>Reason *</label>
                <input type="text" placeholder="Brief reason" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
              </div>

              <div className="rc-form-row">
                <label>Justification (optional)</label>
                <textarea rows={3} placeholder="Additional context for approver" value={form.justification} onChange={e => setForm({ ...form, justification: e.target.value })} />
              </div>
            </div>
            <footer className="rc-modal-footer">
              <button className="rc-btn-ghost" onClick={() => setShowRequest(false)}>Cancel</button>
              <button className="rc-btn-primary" disabled={loading || !form.patient_id || !form.amount || !form.reason} onClick={handleRequest}>
                {loading ? 'Submitting...' : 'Submit Request'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
