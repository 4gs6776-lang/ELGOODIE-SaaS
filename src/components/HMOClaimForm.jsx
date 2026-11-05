import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useCurrentHospital } from '../lib/useCurrentHospital';
import { buildClaimFromInvoice, formatCurrency } from '../lib/revenueCycle';
import './RevenueCycle.css';

const LINE_TYPES = [
  { id: 'consultation',   label: 'Consultation' },
  { id: 'investigation',  label: 'Investigation' },
  { id: 'procedure',      label: 'Procedure' },
  { id: 'pharmacy',       label: 'Pharmacy' },
  { id: 'consumable',     label: 'Consumable' },
  { id: 'accommodation',  label: 'Accommodation' },
  { id: 'other',          label: 'Other' },
];

export default function HMOClaimForm() {
  const { hospitalId, userId } = useCurrentHospital();
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [lineItems, setLineItems] = useState([]);

  // New claim form
  const [form, setForm] = useState({
    patient_id: '',
    invoice_id: '',
    encounter_id: '',
    hmo_provider: '',
    hmo_policy_no: '',
    hmo_member_id: '',
    claim_type: 'outpatient',
    date_of_service: new Date().toISOString().split('T')[0],
    diagnosis_codes: '',
    procedure_codes: '',
    pre_auth_code: '',
  });
  const [patients, setPatients] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [encounters, setEncounters] = useState([]);
  const [draftLineItems, setDraftLineItems] = useState([
    { line_type: 'consultation', description: '', code: '', quantity: 1, unit_price: 0 },
  ]);

  useEffect(() => {
    if (hospitalId) loadClaims();
  }, [hospitalId]);

  async function loadClaims() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('hmo_claims')
        .select(`
          *,
          patient:patients(id, full_name, hospital_number, hmo_provider)
        `)
        .eq('hospital_id', hospitalId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setClaims(data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Patient picker
  useEffect(() => {
    if (showCreate && hospitalId) {
      supabase
        .from('patients')
        .select('id, full_name, hospital_number, hmo_provider, hmo_policy_no, hmo_member_id, phone')
        .eq('hospital_id', hospitalId)
        .not('hmo_provider', 'is', null)
        .order('full_name')
        .then(({ data }) => setPatients(data || []));
    }
  }, [showCreate, hospitalId]);

  // Load patient invoices + encounters
  useEffect(() => {
    if (form.patient_id) {
      Promise.all([
        supabase
          .from('invoices')
          .select('id, invoice_number, total_amount, amount_paid, created_at')
          .eq('hospital_id', hospitalId)
          .eq('patient_id', form.patient_id)
          .order('created_at', { ascending: false }),
        supabase
          .from('encounters')
          .select('id, encounter_date, admission_date, discharge_date, diagnosis_codes, procedure_codes')
          .eq('hospital_id', hospitalId)
          .eq('patient_id', form.patient_id)
          .order('encounter_date', { ascending: false })
      ]).then(([inv, enc]) => {
        setInvoices(inv.data || []);
        setEncounters(enc.data || []);
      });
    } else {
      setInvoices([]);
      setEncounters([]);
    }
  }, [form.patient_id, hospitalId]);

  // Auto-fill HMO info when patient picked
  function pickPatient(patientId) {
    const p = patients.find(x => x.id === patientId);
    setForm({
      ...form,
      patient_id: patientId,
      hmo_provider: p?.hmo_provider || '',
      hmo_policy_no: p?.hmo_policy_no || '',
      hmo_member_id: p?.hmo_member_id || '',
    });
  }

  function addLineItem() {
    setDraftLineItems([
      ...draftLineItems,
      { line_type: 'consultation', description: '', code: '', quantity: 1, unit_price: 0 },
    ]);
  }

  function updateLineItem(idx, field, value) {
    const next = [...draftLineItems];
    next[idx] = { ...next[idx], [field]: field === 'quantity' || field === 'unit_price' ? parseFloat(value) || 0 : value };
    setDraftLineItems(next);
  }

  function removeLineItem(idx) {
    setDraftLineItems(draftLineItems.filter((_, i) => i !== idx));
  }

  const totalClaimed = useMemo(
    () => draftLineItems.reduce((s, l) => s + (l.quantity * l.unit_price), 0),
    [draftLineItems]
  );

  async function handleCreate() {
    if (!form.patient_id || !form.hmo_provider || draftLineItems.length === 0) {
      setError('Patient, HMO provider, and at least one line item are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Generate claim number via RPC
      const { data: claimNo } = await supabase.rpc('generate_hmo_claim_number', {
        p_hospital_id: hospitalId,
      });

      const { data: claim, error: claimErr } = await supabase
        .from('hmo_claims')
        .insert({
          hospital_id: hospitalId,
          patient_id: form.patient_id,
          invoice_id: form.invoice_id || null,
          encounter_id: form.encounter_id || null,
          hmo_provider: form.hmo_provider,
          hmo_policy_no: form.hmo_policy_no,
          hmo_member_id: form.hmo_member_id,
          claim_number: claimNo,
          claim_type: form.claim_type,
          date_of_service: form.date_of_service,
          diagnosis_codes: form.diagnosis_codes ? form.diagnosis_codes.split(',').map(s => s.trim()) : [],
          procedure_codes: form.procedure_codes ? form.procedure_codes.split(',').map(s => s.trim()) : [],
          total_claimed: totalClaimed,
          pre_auth_code: form.pre_auth_code,
          status: 'draft',
          prepared_by: userId,
        })
        .select()
        .single();

      if (claimErr) throw claimErr;

      // Insert line items
      const items = draftLineItems
        .filter(l => l.description && l.unit_price > 0)
        .map(l => ({
          hospital_id: hospitalId,
          claim_id: claim.id,
          line_type: l.line_type,
          description: l.description,
          code: l.code,
          quantity: l.quantity,
          unit_price: l.unit_price,
        }));

      if (items.length > 0) {
        const { error: itemsErr } = await supabase
          .from('hmo_claim_line_items')
          .insert(items);
        if (itemsErr) throw itemsErr;
      }

      setToast({ type: 'success', msg: `Claim ${claimNo} created` });
      setShowCreate(false);
      setForm({
        patient_id: '', invoice_id: '', encounter_id: '',
        hmo_provider: '', hmo_policy_no: '', hmo_member_id: '',
        claim_type: 'outpatient',
        date_of_service: new Date().toISOString().split('T')[0],
        diagnosis_codes: '', procedure_codes: '', pre_auth_code: '',
      });
      setDraftLineItems([{ line_type: 'consultation', description: '', code: '', quantity: 1, unit_price: 0 }]);
      await loadClaims();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitClaim(claim) {
    setLoading(true);
    try {
      await supabase
        .from('hmo_claims')
        .update({
          status: 'submitted',
          submission_date: new Date().toISOString(),
        })
        .eq('id', claim.id);
      setToast({ type: 'success', msg: `Claim ${claim.claim_number} submitted to ${claim.hmo_provider}` });
      await loadClaims();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function printClaim(claim) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const html = renderClaimHtml(claim, lineItems);
    printWindow.document.write(html);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 250);
  }

  // Load line items when claim selected
  useEffect(() => {
    if (selectedClaim) {
      supabase
        .from('hmo_claim_line_items')
        .select('*')
        .eq('claim_id', selectedClaim.id)
        .order('created_at')
        .then(({ data }) => setLineItems(data || []));
    }
  }, [selectedClaim]);

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
          <h1>HMO Claims</h1>
          <p>Generate and track insurance claims</p>
        </div>
        <div className="rc-header-actions">
          <button className="rc-btn-primary" onClick={() => setShowCreate(true)}>
            + New Claim
          </button>
        </div>
      </header>

      {error && <div className="rc-error">{error}</div>}
      {toast && <div className={`rc-toast rc-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="rc-grid">
        <div className="rc-list">
          {loading ? (
            <div className="rc-loading">Loading...</div>
          ) : claims.length === 0 ? (
            <div className="rc-empty">No HMO claims yet</div>
          ) : claims.map(c => (
            <div
              key={c.id}
              className={`rc-card ${selectedClaim?.id === c.id ? 'rc-card-active' : ''}`}
              onClick={() => setSelectedClaim(c)}
            >
              <div className="rc-card-row">
                <span className="rc-card-title">{c.claim_number}</span>
                <span className={`rc-pill rc-pill-${c.status === 'approved' || c.status === 'paid' ? 'paid' : c.status === 'rejected' ? 'overdue' : 'pending'}`}>
                  {c.status.replace('_', ' ')}
                </span>
              </div>
              <div className="rc-card-row rc-card-meta">
                <span>{c.patient?.full_name}</span>
                <span>{formatCurrency(c.total_claimed)}</span>
              </div>
              <div className="rc-card-row rc-card-meta">
                <span>{c.hmo_provider}</span>
                <span>{c.date_of_service}</span>
              </div>
            </div>
          ))}
        </div>

        {selectedClaim && (
          <aside className="rc-detail">
            <h2>{selectedClaim.claim_number}</h2>
            <div className="rc-detail-grid">
              <div><label>Patient</label><span>{selectedClaim.patient?.full_name}</span></div>
              <div><label>HMO</label><span>{selectedClaim.hmo_provider}</span></div>
              <div><label>Policy #</label><span>{selectedClaim.hmo_policy_no || '—'}</span></div>
              <div><label>Member #</label><span>{selectedClaim.hmo_member_id || '—'}</span></div>
              <div><label>Type</label><span>{selectedClaim.claim_type}</span></div>
              <div><label>Service Date</label><span>{selectedClaim.date_of_service}</span></div>
              <div><label>Total Claimed</label><span>{formatCurrency(selectedClaim.total_claimed)}</span></div>
              <div><label>Pre-auth</label><span>{selectedClaim.pre_auth_code || '—'}</span></div>
            </div>

            {selectedClaim.diagnosis_codes?.length > 0 && (
              <div className="rc-tags">
                <label>Diagnoses:</label>
                {selectedClaim.diagnosis_codes.map((c, i) => (
                  <span key={i} className="rc-tag">{c}</span>
                ))}
              </div>
            )}

            <h3>Line Items</h3>
            <table className="rc-table">
              <thead>
                <tr><th>Type</th><th>Description</th><th>Code</th><th>Qty</th><th>Unit</th><th>Total</th></tr>
              </thead>
              <tbody>
                {lineItems.map(li => (
                  <tr key={li.id}>
                    <td>{li.line_type}</td>
                    <td>{li.description}</td>
                    <td>{li.code || '—'}</td>
                    <td>{li.quantity}</td>
                    <td>{formatCurrency(li.unit_price)}</td>
                    <td>{formatCurrency(li.total_price)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="rc-amount">Total</td>
                  <td className="rc-amount">{formatCurrency(selectedClaim.total_claimed)}</td>
                </tr>
              </tfoot>
            </table>

            <div className="rc-action-row">
              {selectedClaim.status === 'draft' && (
                <button className="rc-btn-primary" onClick={() => submitClaim(selectedClaim)}>
                  Submit Claim
                </button>
              )}
              <button className="rc-btn-ghost" onClick={() => printClaim(selectedClaim)}>
                🖨 Print / Export
              </button>
            </div>
          </aside>
        )}
      </div>

      {showCreate && (
        <div className="rc-modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="rc-modal rc-modal-wide" onClick={e => e.stopPropagation()}>
            <header className="rc-modal-header">
              <h2>New HMO Claim</h2>
              <button className="rc-close" onClick={() => setShowCreate(false)}>×</button>
            </header>
            <div className="rc-modal-body">
              <div className="rc-form-row">
                <label>Patient *</label>
                <select
                  value={form.patient_id}
                  onChange={e => pickPatient(e.target.value)}
                >
                  <option value="">Select patient (with HMO)...</option>
                  {patients.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.full_name} — {p.hospital_number} ({p.hmo_provider || 'no HMO'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="rc-form-row-2">
                <div>
                  <label>HMO Provider *</label>
                  <input
                    type="text"
                    value={form.hmo_provider}
                    onChange={e => setForm({ ...form, hmo_provider: e.target.value })}
                  />
                </div>
                <div>
                  <label>Policy #</label>
                  <input
                    type="text"
                    value={form.hmo_policy_no}
                    onChange={e => setForm({ ...form, hmo_policy_no: e.target.value })}
                  />
                </div>
              </div>

              <div className="rc-form-row-2">
                <div>
                  <label>Member #</label>
                  <input
                    type="text"
                    value={form.hmo_member_id}
                    onChange={e => setForm({ ...form, hmo_member_id: e.target.value })}
                  />
                </div>
                <div>
                  <label>Pre-auth Code</label>
                  <input
                    type="text"
                    value={form.pre_auth_code}
                    onChange={e => setForm({ ...form, pre_auth_code: e.target.value })}
                  />
                </div>
              </div>

              <div className="rc-form-row-2">
                <div>
                  <label>Claim Type</label>
                  <select
                    value={form.claim_type}
                    onChange={e => setForm({ ...form, claim_type: e.target.value })}
                  >
                    <option value="outpatient">Outpatient</option>
                    <option value="inpatient">Inpatient</option>
                    <option value="emergency">Emergency</option>
                    <option value="day_case">Day Case</option>
                  </select>
                </div>
                <div>
                  <label>Date of Service</label>
                  <input
                    type="date"
                    value={form.date_of_service}
                    onChange={e => setForm({ ...form, date_of_service: e.target.value })}
                  />
                </div>
              </div>

              {form.patient_id && invoices.length > 0 && (
                <div className="rc-form-row">
                  <label>Linked Invoice (optional)</label>
                  <select
                    value={form.invoice_id}
                    onChange={e => setForm({ ...form, invoice_id: e.target.value })}
                  >
                    <option value="">No invoice</option>
                    {invoices.map(i => (
                      <option key={i.id} value={i.id}>
                        {i.invoice_number} — {formatCurrency(i.total_amount)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {form.patient_id && encounters.length > 0 && (
                <div className="rc-form-row">
                  <label>Linked Encounter (optional)</label>
                  <select
                    value={form.encounter_id}
                    onChange={e => {
                      const enc = encounters.find(x => x.id === e.target.value);
                      setForm({
                        ...form,
                        encounter_id: e.target.value,
                        diagnosis_codes: enc?.diagnosis_codes?.join(', ') || form.diagnosis_codes,
                        procedure_codes: enc?.procedure_codes?.join(', ') || form.procedure_codes,
                        claim_type: enc?.admission_date ? 'inpatient' : 'outpatient',
                      });
                    }}
                  >
                    <option value="">No encounter</option>
                    {encounters.map(e => (
                      <option key={e.id} value={e.id}>
                        {e.encounter_date} {e.admission_date ? '(admitted)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="rc-form-row-2">
                <div>
                  <label>Diagnosis Codes (ICD-10, comma-separated)</label>
                  <input
                    type="text"
                    placeholder="e.g. J00, M54.5"
                    value={form.diagnosis_codes}
                    onChange={e => setForm({ ...form, diagnosis_codes: e.target.value })}
                  />
                </div>
                <div>
                  <label>Procedure Codes (CPT, comma-separated)</label>
                  <input
                    type="text"
                    placeholder="e.g. 99213, 80053"
                    value={form.procedure_codes}
                    onChange={e => setForm({ ...form, procedure_codes: e.target.value })}
                  />
                </div>
              </div>

              <h3>Line Items</h3>
              <table className="rc-table rc-line-items">
                <thead>
                  <tr>
                    <th>Type</th><th>Description</th><th>Code</th>
                    <th>Qty</th><th>Unit Price</th><th>Total</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {draftLineItems.map((li, idx) => (
                    <tr key={idx}>
                      <td>
                        <select
                          value={li.line_type}
                          onChange={e => updateLineItem(idx, 'line_type', e.target.value)}
                        >
                          {LINE_TYPES.map(t => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={li.description}
                          onChange={e => updateLineItem(idx, 'description', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={li.code}
                          onChange={e => updateLineItem(idx, 'code', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={li.quantity}
                          onChange={e => updateLineItem(idx, 'quantity', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={li.unit_price}
                          onChange={e => updateLineItem(idx, 'unit_price', e.target.value)}
                        />
                      </td>
                      <td>{formatCurrency(li.quantity * li.unit_price)}</td>
                      <td>
                        {draftLineItems.length > 1 && (
                          <button className="rc-btn-mini rc-btn-danger" onClick={() => removeLineItem(idx)}>×</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>
                      <button className="rc-btn-mini" onClick={addLineItem}>+ Add line</button>
                    </td>
                    <td className="rc-amount">Total:</td>
                    <td className="rc-amount">{formatCurrency(totalClaimed)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <footer className="rc-modal-footer">
              <button className="rc-btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button
                className="rc-btn-primary"
                disabled={loading || !form.patient_id || !form.hmo_provider}
                onClick={handleCreate}
              >
                {loading ? 'Creating...' : 'Create Claim'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Printable claim HTML
// ============================================================
function renderClaimHtml(claim, lineItems) {
  const rows = lineItems.map(li => `
    <tr>
      <td>${li.line_type}</td>
      <td>${li.description}</td>
      <td>${li.code || ''}</td>
      <td style="text-align:right">${li.quantity}</td>
      <td style="text-align:right">₦${Number(li.unit_price).toLocaleString('en-NG', {minimumFractionDigits: 2})}</td>
      <td style="text-align:right">₦${Number(li.total_price).toLocaleString('en-NG', {minimumFractionDigits: 2})}</td>
    </tr>
  `).join('');

  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>HMO Claim ${claim.claim_number}</title>
<style>
  body { font-family: 'Noto Sans', Arial, sans-serif; color: #1a1a1a; padding: 40px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .claim-no { font-size: 14px; color: #666; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 24px; }
  .grid div { font-size: 13px; }
  .grid label { color: #888; display: block; font-size: 11px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 8px 6px; border-bottom: 1px solid #e0e0e0; font-size: 12px; }
  th { background: #f5f5f5; text-align: left; }
  tfoot td { font-weight: 600; }
  .footer { margin-top: 60px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; font-size: 12px; }
  .sign { border-top: 1px solid #333; padding-top: 6px; }
</style>
</head>
<body>
  <h1>HMO CLAIM FORM</h1>
  <div class="claim-no">Claim No: ${claim.claim_number} · Date: ${new Date().toLocaleDateString()}</div>

  <div class="grid">
    <div><label>Patient</label>${claim.patient?.full_name || ''}</div>
    <div><label>Hospital Number</label>${claim.patient?.hospital_number || ''}</div>
    <div><label>HMO Provider</label>${claim.hmo_provider}</div>
    <div><label>Policy No</label>${claim.hmo_policy_no || ''}</div>
    <div><label>Member No</label>${claim.hmo_member_id || ''}</div>
    <div><label>Pre-auth Code</label>${claim.pre_auth_code || '—'}</div>
    <div><label>Claim Type</label>${claim.claim_type}</div>
    <div><label>Date of Service</label>${claim.date_of_service}</div>
    <div><label>Diagnosis Codes</label>${(claim.diagnosis_codes || []).join(', ') || '—'}</div>
    <div><label>Procedure Codes</label>${(claim.procedure_codes || []).join(', ') || '—'}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Type</th><th>Description</th><th>Code</th>
        <th style="text-align:right">Qty</th>
        <th style="text-align:right">Unit (₦)</th>
        <th style="text-align:right">Total (₦)</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="5" style="text-align:right">TOTAL CLAIMED</td>
        <td style="text-align:right">₦${Number(claim.total_claimed).toLocaleString('en-NG', {minimumFractionDigits: 2})}</td>
      </tr>
    </tfoot>
  </table>

  <div class="footer">
    <div class="sign">Prepared by</div>
    <div class="sign">HMO Authorized Signature & Date</div>
  </div>
</body>
</html>
  `;
}
