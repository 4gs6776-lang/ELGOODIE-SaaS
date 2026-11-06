// src/lib/revenueCycle.js (v2 — fixes all FK/column-name issues)
//
// FIXES FROM v1:
//   1. fetchOutstandingInvoices: removed nested `patient:patients(...)` select
//      (no FK between invoices and patients exists). Now does 2 separate
//      queries and joins them in JS.
//   2. All references to invoice.total_amount → invoice.amount (project uses
//      `amount` not `total_amount`).
//   3. All references to invoice.invoice_number → keep as-is (verified correct).
//   4. All references to patient.hmo_policy_no → patient.hmo_number
//      (project uses `hmo_number` not `hmo_policy_no`).
//   5. All references to patient.hmo_member_id → patient.hmo_id_code
//      (project uses `hmo_id_code` not `hmo_member_id`).

import { supabase } from './supabaseClient';

// ============================================================
// AGING BUCKETS
// ============================================================
export const AGING_BUCKETS = [
  { id: 'current',      label: 'Current',       min: -Infinity, max: 0,        color: '#10B981' },
  { id: '1-30',         label: '1-30 days',     min: 1,         max: 30,       color: '#3B82F6' },
  { id: '31-60',        label: '31-60 days',    min: 31,        max: 60,       color: '#F59E0B' },
  { id: '61-90',        label: '61-90 days',    min: 61,        max: 90,       color: '#F97316' },
  { id: 'over_90',      label: '90+ days',      min: 91,        max: Infinity, color: '#EF4444' },
];

export function getAgingBucket(daysOverdue) {
  const d = Math.max(0, daysOverdue);
  return AGING_BUCKETS.find(b => d >= b.min && d <= b.max) || AGING_BUCKETS[0];
}

export function calcDaysOverdue(dueDate) {
  if (!dueDate) return 0;
  const today = new Date();
  const due = new Date(dueDate);
  const diff = Math.floor((today - due) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

// ============================================================
// AGING DASHBOARD DATA
// ============================================================
export function buildAgingReport(invoices) {
  if (!Array.isArray(invoices)) return { buckets: [], totalOutstanding: 0 };

  const buckets = AGING_BUCKETS.map(b => ({
    ...b,
    count: 0,
    outstanding: 0,
    invoices: [],
  }));

  let totalOutstanding = 0;

  for (const inv of invoices) {
    // FIX: project uses `amount` (or `grand_total`), NOT `total_amount`
    const outstanding = (inv.grand_total || inv.amount || inv.total_amount || 0)
      - (inv.amount_paid || 0);
    if (outstanding <= 0) continue;

    const dueDate = inv.due_date;
    const days = calcDaysOverdue(dueDate);
    const bucket = getAgingBucket(days);

    const idx = buckets.findIndex(b => b.id === bucket.id);
    buckets[idx].count += 1;
    buckets[idx].outstanding += outstanding;
    buckets[idx].invoices.push({ ...inv, daysOverdue: days, outstanding });

    totalOutstanding += outstanding;
  }

  return { buckets, totalOutstanding };
}

// ============================================================
// PAYMENT PLAN CALCULATIONS
// ============================================================
export function computeInstallmentAmount(totalAmount, depositAmount, count) {
  if (count <= 0) return 0;
  return Math.round((totalAmount - depositAmount) / count * 100) / 100;
}

export function generateInstallmentSchedule({
  totalAmount,
  depositAmount = 0,
  installmentCount,
  frequency = 'monthly',
  startDate = new Date(),
}) {
  const perInstallment = computeInstallmentAmount(totalAmount, depositAmount, installmentCount);
  const schedule = [];

  for (let i = 1; i <= installmentCount; i++) {
    const dueDate = new Date(startDate);
    if (frequency === 'weekly') {
      dueDate.setDate(dueDate.getDate() + (i * 7));
    } else if (frequency === 'biweekly') {
      dueDate.setDate(dueDate.getDate() + (i * 14));
    } else {
      dueDate.setMonth(dueDate.getMonth() + i);
    }

    schedule.push({
      installment_no: i,
      due_date: dueDate.toISOString().split('T')[0],
      amount_due: perInstallment,
      status: 'pending',
    });
  }

  return schedule;
}

export function getPlanProgress(plan, installments = []) {
  const paid = installments
    .filter(i => i.status === 'paid' || i.status === 'partial')
    .reduce((sum, i) => sum + (i.amount_paid || 0), 0);
  const total = plan.total_amount || 0;
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  const remaining = total - paid - (plan.deposit_amount || 0);
  const nextInstallment = installments.find(i => i.status === 'pending' || i.status === 'partial');
  return { paid, remaining, pct, nextInstallment };
}

// ============================================================
// WRITE-OFF POLICY
// ============================================================
export const WRITEOFF_TYPES = [
  { id: 'bad_debt',            label: 'Bad Debt',              threshold: 50000,  needsApproval: true  },
  { id: 'charity_care',        label: 'Charity Care',          threshold: 100000, needsApproval: true  },
  { id: 'administrative',      label: 'Administrative Error',  threshold: 10000,  needsApproval: false },
  { id: 'insurance_shortfall', label: 'Insurance Shortfall',   threshold: 50000,  needsApproval: true  },
  { id: 'courtesy_adjustment', label: 'Courtesy Adjustment',   threshold: 5000,   needsApproval: false },
];

export function getWriteoffPolicy(amount, type) {
  const def = WRITEOFF_TYPES.find(t => t.id === type) || WRITEOFF_TYPES[0];
  const needsApproval = def.needsApproval && amount >= def.threshold;
  return {
    ...def,
    amount,
    requiresApproval: needsApproval,
    autoApprovable: !needsApproval,
  };
}

// ============================================================
// HMO CLAIM BUILDER
// ============================================================
export function buildClaimFromInvoice(invoice, patient, encounter, lineItems) {
  const claim = {
    patient_id: patient.id,
    invoice_id: invoice.id,
    encounter_id: encounter?.id || null,
    // FIX: patient.hmo_provider is correct; hmo_policy_no → hmo_number;
    // hmo_member_id → hmo_id_code
    hmo_provider: patient.hmo_provider || '',
    hmo_policy_no: patient.hmo_number || '',
    hmo_member_id: patient.hmo_id_code || '',
    claim_type: encounter?.admission_date ? 'inpatient' : 'outpatient',
    date_of_service: encounter?.encounter_date || invoice.created_at,
    admission_date: encounter?.admission_date || null,
    discharge_date: encounter?.discharge_date || null,
    diagnosis_codes: encounter?.diagnosis_codes || [],
    procedure_codes: encounter?.procedure_codes || [],
    total_claimed: lineItems.reduce((s, l) => s + (l.unit_price * l.quantity), 0),
    status: 'draft',
    prepared_at: new Date().toISOString(),
  };

  return { claim, lineItems };
}

// ============================================================
// REMINDER TEMPLATES
// ============================================================
export function fillReminderTemplate(template, vars) {
  if (!template) return '';
  let out = template;
  const replacements = {
    patient_name: vars.patientName || 'Patient',
    invoice_no: vars.invoiceNo || 'N/A',
    amount: formatCurrency(vars.amount || 0),
    due_date: vars.dueDate || 'N/A',
    hospital_name: vars.hospitalName || '',
    phone: vars.phone || '',
    days_overdue: vars.daysOverdue || 0,
    installment_no: vars.installmentNo || '',
  };
  for (const [k, v] of Object.entries(replacements)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  }
  return out;
}

export function formatCurrency(amount, currency = 'NGN') {
  const sym = currency === 'NGN' ? '₦' : currency === 'USD' ? '$' : '';
  return `${sym}${Number(amount || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ============================================================
// SUPABASE CALLS
// ============================================================

// FIX: Removed nested `patient:patients(...)` select because there's no
// FK between invoices and patients. We do 2 separate queries and join in JS.
export async function fetchOutstandingInvoices(hospitalId) {
  // 1. Fetch invoices
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, amount, grand_total, amount_paid,
      due_date, created_at, status, patient_id, patient_name
    `)
    .eq('hospital_id', hospitalId)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (invErr) throw invErr;
  if (!invoices || invoices.length === 0) return [];

  // 2. Fetch all patients for this hospital (one query, then join in JS)
  const patientIds = [...new Set(invoices.map(i => i.patient_id).filter(Boolean))];
  let patientsMap = {};
  if (patientIds.length > 0) {
    const { data: patients, error: patErr } = await supabase
      .from('patients')
      .select('id, full_name, hospital_number, phone, hmo_provider, hmo_number, hmo_id_code')
      .in('id', patientIds);
    if (patErr) throw patErr;
    patientsMap = (patients || []).reduce((m, p) => { m[p.id] = p; return m; }, {});
  }

  // 3. Join
  return invoices.map(inv => ({
    ...inv,
    // Normalise: expose `total_amount` for the buildAgingReport function
    total_amount: inv.grand_total || inv.amount,
    patient: patientsMap[inv.patient_id] || {
      full_name: inv.patient_name || 'Unknown',
      hospital_number: '—',
      phone: '',
      hmo_provider: '',
    },
  }));
}

// Create a payment plan via RPC
export async function createPaymentPlan(payload) {
  const { data, error } = await supabase.rpc('create_payment_plan', {
    p_hospital_id: payload.hospital_id,
    p_patient_id: payload.patient_id,
    p_invoice_id: payload.invoice_id,
    p_total_amount: payload.total_amount,
    p_deposit_amount: payload.deposit_amount || 0,
    p_installment_count: payload.installment_count,
    p_frequency: payload.frequency,
    p_start_date: payload.start_date,
    p_notes: payload.notes,
    p_user_id: payload.user_id,
  });
  if (error) throw error;
  return data;
}

// Request a write-off via RPC (v4 signature — all params have defaults)
export async function requestWriteoff(payload) {
  const { data, error } = await supabase.rpc('request_writeoff', {
    p_hospital_id: payload.hospital_id,
    p_patient_id: payload.patient_id,
    p_invoice_id: payload.invoice_id,
    p_amount: payload.amount,
    p_writeoff_type: payload.writeoff_type,
    p_reason: payload.reason,
    p_justification: payload.justification,
    p_user_id: payload.user_id,
    p_threshold: payload.threshold || 50000,
  });
  if (error) throw error;
  return data;
}

// Approve / reject a write-off
export async function approveWriteoff(writeoffId, approverId, decision, rejectReason = null) {
  const { data, error } = await supabase.rpc('approve_writeoff', {
    p_writeoff_id: writeoffId,
    p_approver_id: approverId,
    p_decision: decision,
    p_reject_reason: rejectReason,
  });
  if (error) throw error;
  return data;
}

// Queue an SMS reminder for an invoice
export async function queueReminder(invoiceId, reminderType = 'invoice', channel = 'sms') {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.rpc('queue_reminder_for_invoice', {
    p_hospital_id: user?.user_metadata?.hospital_id,
    p_invoice_id: invoiceId,
    p_reminder_type: reminderType,
    p_channel: channel,
    p_user_id: user?.id,
  });
  if (error) throw error;
  return data;
}

// Dispatch queued reminders via Edge Function
export async function dispatchReminder(reminderId) {
  const { data, error } = await supabase.functions.invoke('send-invoice-reminder', {
    body: { reminder_id: reminderId },
  });
  if (error) throw error;
  return data;
}

// ============================================================
// CSV EXPORT (for aging report)
// ============================================================
export function exportAgingCsv(buckets) {
  const rows = [['Bucket', 'Count', 'Outstanding']];
  for (const b of buckets) {
    rows.push([b.label, b.count, b.outstanding.toFixed(2)]);
  }
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aging-report-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
