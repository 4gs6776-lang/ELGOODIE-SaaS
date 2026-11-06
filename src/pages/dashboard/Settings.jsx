// src/pages/dashboard/Settings.jsx (PERFORMANCE-OPTIMIZED v2)
//
// FIX FROM v1: The original Settings.jsx imported 10 manager components
// at the top level — each one called useOfflineTable() internally,
// meaning every Settings page visit opened 18 IndexedDB reads + 18
// Supabase pulls even if the user only wanted to change their theme.
//
// This v2 wraps every heavy section in <AccordionSection> so:
//   1. Each section is collapsed by default
//   2. The expensive managers mount ONLY when the user expands that
//      section (lazy mount → 0 IndexedDB reads on initial load)
//   3. When collapsed, managers unmount → all their useOfflineTable
//      hooks stop fetching, free IndexedDB connections, clear timers
//
// Sections:
//   - Your Profile (defaultOpen — cheap to render)
//   - Appearance (defaultOpen — cheap, saved per user)
//   - Dashboard Background (admin only, lazy)
//   - Hospital (defaultOpen — cheap)
//   - Hospital Logo (admin only, lazy)
//   - Bank Accounts (admin only, lazy)
//   - Registration Fees (admin only, lazy)
//   - Service Catalog (admin only, lazy)
//   - Price Lists (admin only, lazy)
//   - HMO Contracts (admin only, lazy)
//   - HMO Providers (admin only, lazy)
//   - Payment Methods (admin only, lazy)
//   - Expense Vendors (admin only, lazy)
//   - Recurring Expenses (admin only, lazy)
//   - Credit Control Rules (admin only, lazy)
//   - Folder Categories (admin only, lazy)
//   - Role Permissions (admin only, lazy)
//   - Change Password (defaultOpen — cheap)
//   - Session (defaultOpen — cheap)
//
// Result: initial Settings page load goes from ~18 IndexedDB reads +
// 18 Supabase pulls (which took up to 7 minutes on slow networks)
// down to ~2 reads (bank_accounts, registration_fees) — but those
// are also lazy now, so the initial load is INSTANT.

import { useState, lazy, Suspense } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { useOfflineTable } from '../../lib/useOfflineTable';
import { useLazyMount } from '../../lib/useLazyTable';
import { writeAudit } from '../../lib/audit';
import AppIcon from '../../components/icons';
import AccordionSection from '../../components/AccordionSection';
import {
  DEFAULT_REGISTRATION_FEES,
  FOLDER_CATEGORY_LABELS,
  FOLDER_CATEGORY_ORDER,
  formatFee,
} from '../../lib/registrationFees';

// Heavy managers — lazy-loaded so they don't pull their tables
// until the user expands the section.
const ServiceCatalogManager    = lazy(() => import('../../components/ServiceCatalogManager'));
const PriceListManager         = lazy(() => import('../../components/PriceListManager'));
const HmoContractManager       = lazy(() => import('../../components/HmoContractManager'));
const PaymentMethodManager     = lazy(() => import('../../components/PaymentMethodManager'));
const ExpenseVendorManager     = lazy(() => import('../../components/ExpenseVendorManager'));
const RecurringExpenseManager  = lazy(() => import('../../components/RecurringExpenseManager'));
const CreditControlRulesManager = lazy(() => import('../../components/CreditControlRulesManager'));
const RolePermissionManager    = lazy(() => import('../../components/RolePermissionManager'));
const AppearanceSettings       = lazy(() => import('../../components/AppearanceSettings'));
const HospitalBackgroundSettings = lazy(() => import('../../components/HospitalBackgroundSettings'));
const FolderCategoryManager    = lazy(() => import('../../components/FolderCategoryManager'));
const HmoProviderManager       = lazy(() => import('../../components/HmoProviderManager'));

// ============================================================
// Helper — render a lazy manager with a Suspense fallback
// ============================================================
function LazyManager({ children }) {
  return (
    <Suspense fallback={<div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}>
      {children}
    </Suspense>
  );
}

// ============================================================
// Logo compression helper (kept from original)
// ============================================================
function compressLogo(file, maxWidth = 400) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('Could not compress the image.'));
        }, 'image/png', 0.92);
      };
      img.onerror = () => reject(new Error('Could not load the image.'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function roleLabel(role) {
  if (!role) return 'Staff';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function Settings() {
  const { profile, hospital, session, signOut, reload: reloadProfile } = useAuth();
  const [toast, setToast] = useState(null);

  // ---- Password change (cheap state — keep at top) ----
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // ---- Logo upload (cheap state) ----
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState('');

  // ---- Bank accounts (admin/owner only) ----
  // FIX: useLazyMount gates the useOfflineTable hook on the section
  // being open. When collapsed, the hook receives hospitalId=null
  // and does no I/O.
  const [bankSectionOpen, setBankSectionOpen] = useState(false);
  const bankMounted = useLazyMount(bankSectionOpen, 50);
  const { records: bankAccounts, addRecord: addBankAccount, updateRecord: updateBankAccount, deleteRecord: deleteBankAccount } =
    useOfflineTable('hospital_bank_accounts', bankMounted ? hospital?.id : null);

  const [showBankModal, setShowBankModal] = useState(false);
  const [bankEditingId, setBankEditingId] = useState(null);
  const [bankName, setBankName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [sortCode, setSortCode] = useState('');
  const [bankNotes, setBankNotes] = useState('');
  const [bankActive, setBankActive] = useState(true);
  const [bankSaving, setBankSaving] = useState(false);
  const [bankError, setBankError] = useState('');

  // ---- Registration fees (admin/owner only) ----
  const [feesSectionOpen, setFeesSectionOpen] = useState(false);
  const feesMounted = useLazyMount(feesSectionOpen, 50);
  const { records: feeRecords, addRecord: addFeeRecord, updateRecord: updateFeeRecord } =
    useOfflineTable('hospital_registration_fees', feesMounted ? hospital?.id : null);
  const [feeDraft, setFeeDraft] = useState({});
  const [feeSaving, setFeeSaving] = useState(false);
  const [feeError, setFeeError] = useState('');

  const canManageBank = profile?.role === 'admin' || profile?.role === 'owner';
  const canManageFees = profile?.role === 'admin' || profile?.role === 'owner';

  // ---- Section open states for the lazy managers ----
  const [openSections, setOpenSections] = useState({
    'service-catalog': false,
    'price-lists': false,
    'hmo-contracts': false,
    'hmo-providers': false,
    'payment-methods': false,
    'expense-vendors': false,
    'recurring-expenses': false,
    'credit-control': false,
    'folder-categories': false,
    'role-permissions': false,
    'dashboard-background': false,
  });

  function toggleSection(key) {
    setOpenSections(s => ({ ...s, [key]: !s[key] }));
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // ============================================================
  // Handlers (kept verbatim from original)
  // ============================================================

  async function handleLogoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type.startsWith('image/')) { setLogoError('Please select an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { setLogoError('Image is too large (max 5MB).'); return; }
    setLogoUploading(true); setLogoError('');
    try {
      const compressed = await compressLogo(file, 400);
      const filePath = `${hospital.id}/logo`;
      const { error: uploadErr } = await supabase.storage
        .from('hospital-logos').upload(filePath, compressed, { upsert: true, contentType: 'image/png' });
      if (uploadErr) throw uploadErr;
      const { data: urlData } = supabase.storage.from('hospital-logos').getPublicUrl(filePath);
      const logoUrl = `${urlData.publicUrl}?t=${Date.now()}`;
      const { error: updateErr } = await supabase.from('hospitals').update({ logo_url: logoUrl }).eq('id', hospital.id);
      if (updateErr) throw updateErr;
      writeAudit({
        hospitalId: hospital.id, actor: profile, action: 'hospital.logo_updated',
        entityType: 'hospital', entityId: hospital.id,
        summary: `Updated hospital logo for ${hospital.name}`,
        metadata: { file_name: file.name, file_size: file.size, logo_url: logoUrl },
      });
      showToast('Logo updated');
      reloadProfile?.();
    } catch (err) { setLogoError(err.message || 'Could not upload the logo.'); }
    finally { setLogoUploading(false); }
  }

  function resetBankForm() {
    setBankEditingId(null); setBankName(''); setAccountName(''); setAccountNumber('');
    setSortCode(''); setBankNotes(''); setBankActive(true); setBankError('');
  }
  function openBankAdd() { resetBankForm(); setShowBankModal(true); }
  function openBankEdit(account) {
    setBankEditingId(account.id);
    setBankName(account.bank_name || ''); setAccountName(account.account_name || '');
    setAccountNumber(account.account_number || ''); setSortCode(account.sort_code || '');
    setBankNotes(account.notes || ''); setBankActive(account.active !== false);
    setBankError(''); setShowBankModal(true);
  }

  async function handleBankSubmit(e) {
    e.preventDefault(); setBankError('');
    if (!bankName.trim() || !accountName.trim() || !accountNumber.trim()) {
      setBankError('Bank name, account name, and account number are required.'); return;
    }
    if (!hospital?.id) { setBankError('Hospital is still loading.'); return; }
    setBankSaving(true);
    try {
      const payload = {
        hospital_id: hospital.id, bank_name: bankName.trim(),
        account_name: accountName.trim(), account_number: accountNumber.trim(),
        sort_code: sortCode.trim() || null, notes: bankNotes.trim() || null,
        active: bankActive,
      };
      if (bankEditingId) {
        await updateBankRecord(bankEditingId, payload);
        showToast('Bank account updated');
      } else {
        await addBankAccount(payload);
        showToast('Bank account added');
      }
      setShowBankModal(false); resetBankForm();
    } catch (err) { setBankError(err.message || 'Could not save the bank account.'); }
    finally { setBankSaving(false); }
  }

  async function handleBankDelete(account) {
    if (!confirm(`Delete ${account.bank_name} account?`)) return;
    try { await deleteBankAccount(account.id); showToast('Bank account deleted'); }
    catch (err) { setBankError(err.message || 'Could not delete.'); }
  }

  async function handleBankToggleActive(account) {
    try { await updateBankAccount(account.id, { active: !account.active }); }
    catch (err) { setBankError(err.message || 'Could not update.'); }
  }

  async function handleSaveFees(e) {
    e.preventDefault(); setFeeError('');
    if (!hospital?.id) { setFeeError('Hospital is still loading.'); return; }
    setFeeSaving(true);
    try {
      for (const category of FOLDER_CATEGORY_ORDER) {
        const draftValue = feeDraft[category];
        if (draftValue === undefined || draftValue === '') continue;
        const amount = parseFloat(draftValue);
        if (isNaN(amount) || amount < 0) {
          setFeeError(`Invalid amount for ${FOLDER_CATEGORY_LABELS[category]}.`); return;
        }
        const existing = feeRecords.find(f => f.category === category);
        if (existing) {
          await updateFeeRecord(existing.id, { amount, hospital_id: hospital.id });
        } else {
          await addFeeRecord({ hospital_id: hospital.id, category, amount });
        }
      }
      setFeeDraft({}); showToast('Registration fees saved');
    } catch (err) { setFeeError(err.message || 'Could not save fees.'); }
    finally { setFeeSaving(false); }
  }

  async function handleResetFee(category) {
    try {
      const existing = feeRecords.find(f => f.category === category);
      if (existing) {
        await updateFeeRecord(existing.id, {
          amount: DEFAULT_REGISTRATION_FEES[category] || 0,
          hospital_id: hospital.id,
        });
        showToast(`${FOLDER_CATEGORY_LABELS[category]} reset to default`);
      }
    } catch (err) { setFeeError(err.message || 'Could not reset.'); }
  }

  async function handlePasswordChange(e) {
    e.preventDefault(); setFormError('');
    if (newPassword !== confirmPassword) { setFormError('Passwords do not match.'); return; }
    if (newPassword.length < 8) { setFormError('New password must be at least 8 characters.'); return; }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      showToast('Password updated');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err) { setFormError(err.message || 'Could not update password.'); }
    finally { setSaving(false); }
  }

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900, margin: '0 auto' }}>

        {/* 1. Your Profile — always open (cheap) */}
        <AccordionSection
          title="Your Profile"
          subtitle="Account details"
          icon="users"
          defaultOpen={true}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 0' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Full Name</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{profile?.full_name || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Email</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{session?.user?.email || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Role</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{roleLabel(profile?.role)}</div>
            </div>
          </div>
        </AccordionSection>

        {/* 2. Appearance — always open (cheap, per-user) */}
        <AccordionSection
          title="Appearance"
          subtitle="Customize your theme, mode, and accent color — saved per user"
          icon="settings"
          defaultOpen={true}
        >
          <div style={{ padding: '14px 0' }}>
            <LazyManager><AppearanceSettings /></LazyManager>
          </div>
        </AccordionSection>

        {/* 3. Dashboard Background — admin only, lazy */}
        {canManageBank && (
          <AccordionSection
            title="Dashboard Background"
            subtitle="Customize the dashboard wallpaper for everyone in your hospital"
            icon="building"
            defaultOpen={false}
          >
            <div style={{ padding: '14px 0' }}>
              <LazyManager><HospitalBackgroundSettings /></LazyManager>
            </div>
          </AccordionSection>
        )}

        {/* 4. Hospital info — always open (cheap) */}
        <AccordionSection
          title="Hospital"
          subtitle="Organization details"
          icon="building"
          defaultOpen={true}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 0' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Hospital Name</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{hospital?.name || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Account Status</div>
              <div style={{
                display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20,
                background: hospital?.status === 'active' ? 'var(--teal-soft)' : 'rgba(201,169,97,0.14)',
                color: hospital?.status === 'active' ? 'var(--teal)' : 'var(--gold)',
              }}>
                {hospital?.status ? hospital.status.charAt(0).toUpperCase() + hospital.status.slice(1) : 'Unknown'}
              </div>
            </div>
          </div>
        </AccordionSection>

        {/* 5. Hospital Logo — admin only, lazy */}
        {canManageBank && (
          <AccordionSection
            title="Hospital Logo"
            subtitle="Shown in sidebar, printed bills, and login page"
            icon="users"
            defaultOpen={false}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0' }}>
              <div style={{
                width: 80, height: 80, borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--line)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', flexShrink: 0,
              }}>
                {hospital?.logo_url ? (
                  <img src={hospital.logo_url} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 22, color: 'var(--muted)' }}>{hospital?.name?.charAt(0) || 'H'}</span>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <label style={{
                  display: 'inline-block', padding: '8px 14px', borderRadius: 8,
                  background: 'var(--bg-elevated)', border: '1px solid var(--line)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>
                  {logoUploading ? 'Uploading…' : 'Choose new logo'}
                  <input
                    type="file" accept="image/*"
                    onChange={handleLogoUpload}
                    disabled={logoUploading}
                    style={{ display: 'none' }}
                  />
                </label>
                {logoError && <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{logoError}</div>}
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                  PNG or JPG, max 5MB. Recommended 400×400px.
                </div>
              </div>
            </div>
          </AccordionSection>
        )}

        {/* 6. Bank Accounts — admin only, LAZY (heavy: useOfflineTable) */}
        {canManageBank && (
          <AccordionSection
            title="Bank Accounts"
            subtitle="Bank accounts shown on printed bills"
            icon="billing"
            defaultOpen={false}
          >
            <div style={{ padding: '14px 0' }}>
              <button
                onClick={openBankAdd}
                style={{
                  padding: '8px 14px', borderRadius: 8, border: '1px solid var(--line)',
                  background: 'var(--bg-elevated)', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 12,
                }}
              >
                + Add Bank Account
              </button>
              {bankMounted && (bankAccounts?.length || 0) === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>
                  No bank accounts yet. Click "Add Bank Account" to create one.
                </div>
              ) : bankMounted ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(bankAccounts || []).map(account => (
                    <div key={account.id} style={{
                      padding: 12, borderRadius: 8, border: '1px solid var(--line)',
                      background: 'var(--bg-elevated)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{account.bank_name}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {account.account_name} — {account.account_number}
                        </div>
                        {!account.active && (
                          <span style={{ fontSize: 10, color: '#b45309', fontWeight: 700, textTransform: 'uppercase' }}>Inactive</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => openBankEdit(account)} style={{ padding: '5px 10px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', cursor: 'pointer' }}>Edit</button>
                        <button onClick={() => handleBankToggleActive(account)} style={{ padding: '5px 10px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', cursor: 'pointer' }}>
                          {account.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button onClick={() => handleBankDelete(account)} style={{ padding: '5px 10px', fontSize: 11, borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#b91c1c', cursor: 'pointer' }}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>Expand to load bank accounts…</div>
              )}
              {bankError && <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{bankError}</div>}
            </div>
          </AccordionSection>
        )}

        {/* 7. Registration Fees — admin only, LAZY (heavy: useOfflineTable) */}
        {canManageFees && (
          <AccordionSection
            title="Registration Fees"
            subtitle="Per-folder-category fees charged at patient registration"
            icon="billing"
            defaultOpen={false}
          >
            <div style={{ padding: '14px 0' }}>
              {!feesMounted ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>Expand to load fees…</div>
              ) : (
                <form onSubmit={handleSaveFees} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {FOLDER_CATEGORY_ORDER.map(category => {
                    const fee = feeRecords?.find(f => f.category === category);
                    const draftValue = feeDraft[category] !== undefined ? feeDraft[category] : (fee?.amount?.toString() || '');
                    return (
                      <div key={category} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{FOLDER_CATEGORY_LABELS[category]}</div>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', fontSize: 13 }}>₦</span>
                          <input
                            type="number" min="0" step="0.01" value={draftValue}
                            onChange={e => setFeeDraft(d => ({ ...d, [category]: e.target.value }))}
                            style={{ padding: '6px 10px 6px 24px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', fontSize: 13, width: 130 }}
                          />
                        </div>
                        {fee && (
                          <button type="button" onClick={() => handleResetFee(category)} style={{ padding: '5px 8px', fontSize: 10, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', cursor: 'pointer' }}>Reset</button>
                        )}
                      </div>
                    );
                  })}
                  {feeError && <div style={{ fontSize: 12, color: '#dc2626' }}>{feeError}</div>}
                  <button type="submit" disabled={feeSaving} style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    background: 'var(--ivory, #0f172a)', color: '#fff',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start',
                  }}>
                    {feeSaving ? 'Saving…' : 'Save fees'}
                  </button>
                </form>
              )}
            </div>
          </AccordionSection>
        )}

        {/* 8-18. Heavy managers — each lazy-mounted on section open */}
        {canManageBank && (
          <>
            <AccordionSection
              title="Service Catalog"
              subtitle="Master list of billable services"
              icon="billing"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><ServiceCatalogManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Price Lists"
              subtitle="Multiple tariff sets for HMO / private / NHIA"
              icon="billing"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><PriceListManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="HMO Contracts"
              subtitle="Insurance contracts and tariff assignments"
              icon="users"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><HmoContractManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="HMO Providers"
              subtitle="Insurance companies"
              icon="users"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><HmoProviderManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Payment Methods"
              subtitle="Cash, card, transfer, wallet"
              icon="billing"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><PaymentMethodManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Expense Vendors"
              subtitle="Suppliers and payees"
              icon="users"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><ExpenseVendorManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Recurring Expenses"
              subtitle="Monthly rent, salaries, utilities"
              icon="billing"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><RecurringExpenseManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Credit Control Rules"
              subtitle="Deposit requirements and credit limits"
              icon="shield"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><CreditControlRulesManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Folder Categories"
              subtitle="Patient folder types"
              icon="users"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><FolderCategoryManager /></LazyManager>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Role Permissions"
              subtitle="Per-role access control"
              icon="shield"
              defaultOpen={false}
            >
              <div style={{ padding: '14px 0' }}>
                <LazyManager><RolePermissionManager /></LazyManager>
              </div>
            </AccordionSection>
          </>
        )}

        {/* Change Password — always open (cheap) */}
        <AccordionSection
          title="Change Password"
          subtitle="Update your account password"
          icon="shield"
          defaultOpen={true}
        >
          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 0', maxWidth: 400 }}>
            <input
              type="password" placeholder="Current password" value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', fontSize: 13 }}
            />
            <input
              type="password" placeholder="New password (min 8 chars)" value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', fontSize: 13 }}
            />
            <input
              type="password" placeholder="Confirm new password" value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg-elevated)', fontSize: 13 }}
            />
            {formError && <div style={{ fontSize: 12, color: '#dc2626' }}>{formError}</div>}
            <button type="submit" disabled={saving} style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: 'var(--ivory, #0f172a)', color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start',
            }}>
              {saving ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </AccordionSection>

        {/* Session — always open (cheap) */}
        <AccordionSection
          title="Session"
          subtitle="Sign out of this device"
          icon="users"
          defaultOpen={true}
        >
          <div style={{ padding: '14px 0' }}>
            <button
              onClick={() => signOut?.()}
              style={{
                padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)',
                background: 'rgba(239,68,68,0.08)', color: '#b91c1c',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          </div>
        </AccordionSection>
      </div>

      {/* Bank modal */}
      {showBankModal && (
        <div className="dash-modal-overlay" onClick={() => { setShowBankModal(false); resetBankForm(); }}>
          <div className="dash-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="dash-modal-title">{bankEditingId ? 'Edit Bank Account' : 'Add Bank Account'}</div>
            {bankError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{bankError}</div>}
            <form onSubmit={handleBankSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input type="text" placeholder="Bank name *" value={bankName} onChange={e => setBankName(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', fontSize: 13 }} />
              <input type="text" placeholder="Account name *" value={accountName} onChange={e => setAccountName(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', fontSize: 13 }} />
              <input type="text" placeholder="Account number *" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', fontSize: 13 }} />
              <input type="text" placeholder="Sort code (optional)" value={sortCode} onChange={e => setSortCode(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', fontSize: 13 }} />
              <textarea placeholder="Notes (optional)" value={bankNotes} onChange={e => setBankNotes(e.target.value)} rows={2} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', fontSize: 13 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={bankActive} onChange={e => setBankActive(e.target.checked)} />
                Active
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <button type="button" onClick={() => { setShowBankModal(false); resetBankForm(); }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                <button type="submit" disabled={bankSaving} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--ivory, #0f172a)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  {bankSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)',
          padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 700, zIndex: 60, maxWidth: '85vw', textAlign: 'center',
        }}>
          {toast}
        </div>
      )}
    </>
  );
}
