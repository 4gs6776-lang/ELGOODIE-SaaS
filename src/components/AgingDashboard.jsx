import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  buildAgingReport,
  formatCurrency,
  exportAgingCsv,
  fetchOutstandingInvoices,
  queueReminder,
  dispatchReminder,
} from '../lib/revenueCycle';
import { useCurrentHospital } from '../lib/useCurrentHospital';
import './RevenueCycle.css';

export default function AgingDashboard({ onWriteoff, onPaymentPlan }) {
  const { hospitalId } = useCurrentHospital();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBucket, setSelectedBucket] = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (hospitalId) loadInvoices();
    // Subscribe to changes
    const sub = supabase
      .channel('invoices-aging')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'invoices', filter: `hospital_id=eq.${hospitalId}` },
        () => loadInvoices()
      )
      .subscribe();
    return () => supabase.removeChannel(sub);
  }, [hospitalId]);

  async function loadInvoices() {
    setLoading(true);
    try {
      const data = await fetchOutstandingInvoices(hospitalId);
      setInvoices(data);
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setLoading(false);
    }
  }

  const { buckets, totalOutstanding } = useMemo(() => buildAgingReport(invoices), [invoices]);

  // One-click: send reminder
  async function handleSendReminder(invoice, reminderType = 'invoice') {
    setActionLoading({ ...actionLoading, [`${invoice.id}-reminder`]: true });
    try {
      const reminderId = await queueReminder(invoice.id, reminderType);
      if (reminderId) {
        await dispatchReminder(reminderId);
        setToast({ type: 'success', msg: `Reminder sent to ${invoice.patient?.full_name}` });
      } else {
        setToast({ type: 'info', msg: 'No outstanding balance — nothing to remind' });
      }
    } catch (e) {
      setToast({ type: 'error', msg: e.message });
    } finally {
      setActionLoading({ ...actionLoading, [`${invoice.id}-reminder`]: false });
    }
  }

  // One-click: create payment plan
  function handlePaymentPlan(invoice) {
    if (onPaymentPlan) {
      onPaymentPlan({
        patient_id: invoice.patient?.id,
        invoice_id: invoice.id,
        total_amount: (invoice.total_amount || 0) - (invoice.amount_paid || 0),
        patient_name: invoice.patient?.full_name,
      });
    }
  }

  // One-click: write off
  function handleWriteoff(invoice) {
    if (onWriteoff) {
      onWriteoff({
        patient_id: invoice.patient?.id,
        invoice_id: invoice.id,
        amount: (invoice.total_amount || 0) - (invoice.amount_paid || 0),
        patient_name: invoice.patient?.full_name,
      });
    }
  }

  function showToast(type, msg) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  }

  if (loading) {
    return <div className="rc-loading">Loading aging report...</div>;
  }

  const visibleBuckets = selectedBucket
    ? buckets.filter(b => b.id === selectedBucket)
    : buckets.filter(b => b.count > 0);

  return (
    <div className="rc-page">
      <header className="rc-header">
        <div>
          <h1>Aging Report</h1>
          <p>{invoices.length} outstanding invoices — total {formatCurrency(totalOutstanding)}</p>
        </div>
        <div className="rc-header-actions">
          <button className="rc-btn-ghost" onClick={() => exportAgingCsv(buckets)}>
            ↓ Export CSV
          </button>
          {selectedBucket && (
            <button className="rc-btn-ghost" onClick={() => setSelectedBucket(null)}>
              ← Show all buckets
            </button>
          )}
        </div>
      </header>

      {toast && (
        <div className={`rc-toast rc-toast-${toast.type}`}>
          {toast.msg}
        </div>
      )}

      {/* Buckets grid */}
      <div className="rc-buckets">
        {buckets.map(b => (
          <div
            key={b.id}
            className="rc-bucket"
            style={{ borderLeftColor: b.color }}
            onClick={() => setSelectedBucket(b.id === selectedBucket ? null : b.id)}
          >
            <div className="rc-bucket-label">{b.label}</div>
            <div className="rc-bucket-count">{b.count}</div>
            <div className="rc-bucket-amount" style={{ color: b.color }}>
              {formatCurrency(b.outstanding)}
            </div>
          </div>
        ))}
      </div>

      {/* Invoice table */}
      <div className="rc-table-container">
        <table className="rc-table">
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Patient</th>
              <th>Outstanding</th>
              <th>Due Date</th>
              <th>Days Overdue</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleBuckets.flatMap(b => b.invoices.map(inv => (
              <tr key={inv.id}>
                <td>{inv.invoice_number}</td>
                <td>
                  <div>{inv.patient?.full_name}</div>
                  <div className="rc-meta">{inv.patient?.hospital_number} · {inv.patient?.phone}</div>
                </td>
                <td className="rc-amount">{formatCurrency(inv.outstanding)}</td>
                <td>{inv.due_date || '—'}</td>
                <td>
                  <span className={`rc-pill rc-pill-${inv.daysOverdue > 30 ? 'overdue' : 'pending'}`}>
                    {inv.daysOverdue} days
                  </span>
                </td>
                <td>
                  <div className="rc-action-row">
                    <button
                      className="rc-btn-mini"
                      disabled={actionLoading[`${inv.id}-reminder`]}
                      onClick={() => handleSendReminder(inv)}
                      title="Send SMS reminder"
                    >
                      📱 Remind
                    </button>
                    <button
                      className="rc-btn-mini"
                      onClick={() => handlePaymentPlan(inv)}
                      title="Create payment plan"
                    >
                      📅 Plan
                    </button>
                    <button
                      className="rc-btn-mini rc-btn-danger"
                      onClick={() => handleWriteoff(inv)}
                      title="Write off balance"
                    >
                      ✂ Write-off
                    </button>
                  </div>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
        {visibleBuckets.every(b => b.invoices.length === 0) && (
          <div className="rc-empty">No invoices in this view 🎉</div>
        )}
      </div>
    </div>
  );
}
