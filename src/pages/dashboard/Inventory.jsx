import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import ImportExcelModal from '../../components/inventory/ImportExcelModal'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import TrashIcon from '../../components/icons/TrashIcon'
import PatientAutocomplete from '../../components/common/PatientAutocomplete'
import AppIcon from '../../components/icons'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import { writeAudit } from '../../lib/audit'

const CATEGORIES = ['Consumables', 'Equipment', 'PPE', 'Drug', 'Office Supplies', 'Cleaning & Hygiene', 'Other']

export default function Inventory() {
  const { profile, hospital } = useAuth()
  const { records: items, loading, isOnline, pendingCount, addRecord, deleteRecord, updateRecord, refreshTable, syncFromServer } = useOfflineTable('inventory_items', hospital?.id)
  const { records: patients } = useOfflineTable('patients', hospital?.id)
  const { addRecord: addStockRecord } = useOfflineTable('patient_stock_records', hospital?.id)
  const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id) // NEW

  const [showModal, setShowModal] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [name, setName] = useState(''); const [category, setCategory] = useState(CATEGORIES[0]); const [quantity, setQuantity] = useState(''); const [unit, setUnit] = useState('units')
  const [supplier, setSupplier] = useState(''); const [reorderLevel, setReorderLevel] = useState('10'); const [costPrice, setCostPrice] = useState(''); const [sellingPrice, setSellingPrice] = useState('')
  const [batchNumber, setBatchNumber] = useState(''); const [expiryDate, setExpiryDate] = useState(''); const [genericName, setGenericName] = useState(''); const [strength, setStrength] = useState(''); const [dosageForm, setDosageForm] = useState(''); const [requiresRx, setRequiresRx] = useState(false)
  const [saving, setSaving] = useState(false); const [formError, setFormError] = useState('')
  const [showDispenseModal, setShowDispenseModal] = useState(false); const [dispensingItem, setDispensingItem] = useState(null); const [dispenseQuantity, setDispenseQuantity] = useState('')
  const [dispensing, setDispensing] = useState(false); const [dispenseError, setDispenseError] = useState(''); const [selectedPatient, setSelectedPatient] = useState(null)

  // ---- "Issue to Department" modal state ------------------------------
  // Lets the storekeeper issue supplies (syringes, needles, reagents,
  // gloves, etc.) to internal departments — Lab, Theatre, Nursing, etc.
  // The stock is decremented (just like a patient dispense) but NO
  // billable charge is generated (internal consumption — not billable
  // to a patient). The audit log records the department + reason.
  const DEPARTMENTS = ['Laboratory', 'Theatre', 'Nursing Station', 'Pharmacy', 'Radiology', 'Records / Admin', 'Maintenance', 'Other']
  const [showIssueModal, setShowIssueModal] = useState(false)
  const [issuingItem, setIssuingItem] = useState(null)
  const [issueQuantity, setIssueQuantity] = useState('')
  const [issueDepartment, setIssueDepartment] = useState(DEPARTMENTS[0])
  const [issueReason, setIssueReason] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState('')

  const openIssue = (item) => {
    setIssuingItem(item); setIssueQuantity(''); setIssueDepartment(DEPARTMENTS[0])
    setIssueReason(''); setIssueError(''); setShowIssueModal(true)
  }
  const closeIssue = () => {
    if (issuing) return
    setShowIssueModal(false); setIssuingItem(null); setIssueQuantity('')
    setIssueDepartment(DEPARTMENTS[0]); setIssueReason(''); setIssueError('')
  }

  const handleIssueToDepartment = async (e) => {
    e.preventDefault(); if (!issuingItem) return; setIssueError('')
    const qty = parseInt(issueQuantity, 10)
    if (isNaN(qty) || qty <= 0) return setIssueError('Enter a valid quantity.')
    if (!issueDepartment.trim()) return setIssueError('Select a department.')
    const currQty = parseInt(issuingItem.quantity, 10) || 0
    if (qty > currQty) return setIssueError(`Insufficient stock. Only ${currQty} left.`)

    setIssuing(true)
    try {
      const newQty = currQty - qty

      // 1. Decrement stock on the inventory item (direct UPDATE).
      await updateRecord(issuingItem.id, { quantity: newQty, updated_at: new Date().toISOString() })

      // 2. NO billable charge — internal consumption, not billable to
      //    a patient. (Pharmacy/Inventory dispenses to patients route
      //    through billable_charges so the cashier collects payment.
      //    Department issues are non-revenue: supplies consumed in
      //    the course of providing care.)
      //
      //    NO patient_stock_records either — that table is patient-
      //    keyed and would skew the "Items Given" tab on a patient
      //    profile. Department issues live only in the audit log.

      // 3. Audit trail — this is the SOLE record of the issue. Captures
      //    the department, reason, quantity, and stock before/after so
      //    anyone reviewing inventory changes can see exactly what was
      //    consumed where and by whom.
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'inventory.issue_department',
        entityType: 'inventory_item', entityId: issuingItem.id,
        patientId: null, // internal issue — no patient
        summary: `Issued ${qty} ${issuingItem.unit || 'units'} of ${issuingItem.name} to ${issueDepartment}`,
        metadata: {
          item_name: issuingItem.name,
          category: issuingItem.category || null,
          department: issueDepartment,
          reason: issueReason.trim() || null,
          quantity: qty,
          unit: issuingItem.unit || 'units',
          cost_price: Number(issuingItem.cost_price || 0),
          // Total cost consumed (for department cost reports):
          total_cost: Number(issuingItem.cost_price || 0) * qty,
          stock_before: currQty,
          stock_after: newQty,
        },
      })

      showToast(`Issued ${qty} ${issuingItem.unit || 'units'} of ${issuingItem.name} to ${issueDepartment}.`)
      closeIssue(); if (refreshTable) await refreshTable()
    } catch (err) {
      setIssueError(err.message || 'Failed to issue.')
    } finally {
      setIssuing(false)
    }
  }

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 3000) }

  // Live alert — a new stock item added from another device (or via bulk import).
  // syncFromServer so the new item is actually pulled down, not just
  // re-read from whatever was already cached locally.
  useRealtimeAlert('inventory_items', hospital?.id, (newRow) => {
    showToast(`New item added: ${newRow.name || 'inventory item'}`)
    syncFromServer()
  })
  const resetForm = () => { setEditingId(null); setName(''); setCategory(CATEGORIES[0]); setQuantity(''); setUnit('units'); setSupplier(''); setReorderLevel('10'); setCostPrice(''); setSellingPrice(''); setBatchNumber(''); setExpiryDate(''); setGenericName(''); setStrength(''); setDosageForm(''); setRequiresRx(false); setFormError('') }
  
  const openEdit = (item) => {
    setEditingId(item.id); setName(item.name || ''); setCategory(item.category || CATEGORIES[0]); setQuantity(String(item.quantity || '')); setUnit(item.unit || 'units'); setSupplier(item.supplier || ''); setReorderLevel(String(item.reorder_level || '10'))
    setCostPrice(String(item.cost_price || '')); setSellingPrice(String(item.selling_price || '')); setBatchNumber(item.batch_number || ''); setExpiryDate(item.expiry_date || ''); setGenericName(item.generic_name || ''); setStrength(item.strength || ''); setDosageForm(item.dosage_form || ''); setRequiresRx(item.requires_prescription === true)
    setFormError(''); setShowModal(true)
  }

  const handleSubmit = async (event) => {
    event.preventDefault(); setFormError('')
    if (!name.trim()) return setFormError('Item name is required.')
    if (quantity === '') return setFormError('Quantity is required.')
    const parsedQty = parseInt(quantity, 10)
    if (Number.isNaN(parsedQty) || parsedQty < 0) return setFormError('Quantity must be valid.')
    if (!hospital || !profile) return setFormError('Loading account...')
    setSaving(true)
    try {
      const payload = { name: name.trim(), category, quantity: parsedQty, unit: unit.trim() || 'units', supplier: supplier.trim(), reorder_level: parseInt(reorderLevel, 10) || 10, cost_price: parseFloat(costPrice) || 0, selling_price: parseFloat(sellingPrice) || 0, batch_number: batchNumber.trim(), expiry_date: expiryDate || null, generic_name: genericName.trim(), strength: strength.trim(), dosage_form: dosageForm.trim(), requires_prescription: requiresRx, updated_at: new Date().toISOString() }
      if (editingId) {
        await updateRecord(editingId, payload)
        writeAudit({
          hospitalId: hospital?.id, actor: profile,
          action: 'inventory.update',
          entityType: 'inventory_item', entityId: editingId,
          summary: `Updated item — ${name.trim()} (${category})`,
          metadata: { name: name.trim(), category, quantity: parsedQty, unit: payload.unit, supplier: payload.supplier, batch_number: payload.batch_number || null, expiry_date: payload.expiry_date, selling_price: payload.selling_price, cost_price: payload.cost_price },
        })
        showToast('Item updated')
      } else {
        payload.hospital_id = hospital.id
        payload.created_by = profile.id
        const saved = await addRecord(payload)
        writeAudit({
          hospitalId: hospital?.id, actor: profile,
          action: 'inventory.create',
          entityType: 'inventory_item', entityId: saved?.id || null,
          summary: `Added new item — ${name.trim()} (${category})`,
          metadata: { name: name.trim(), category, quantity: parsedQty, unit: payload.unit, supplier: payload.supplier, batch_number: payload.batch_number || null, expiry_date: payload.expiry_date },
        })
        showToast('Item added')
      }
      setShowModal(false); resetForm()
    } catch (e) { setFormError(e.message || 'Save failed') } finally { setSaving(false) }
  }

  const handleRestock = async (item) => {
    const input = prompt(`Current stock: ${item.quantity} ${item.unit}\n\nEnter new quantity:`, item.quantity)
    if (input === null) return
    const newQ = parseInt(input, 10)
    if (Number.isNaN(newQ) || newQ < 0) return showToast('Invalid quantity')
    try {
      await updateRecord(item.id, { quantity: newQ, updated_at: new Date().toISOString() })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'inventory.restock',
        entityType: 'inventory_item', entityId: item.id,
        summary: `Inventory restock — ${item.name}: ${item.quantity} → ${newQ} ${item.unit || 'units'}`,
        metadata: { item_name: item.name, category: item.category || null, batch_number: item.batch_number || null, from: item.quantity, to: newQ, unit: item.unit || 'units' },
      })
      showToast('Stock updated')
    } catch (e) {
      showToast(e.message)
    }
  }

  const handleDelete = async (item) => {
    if (!window.confirm(`Remove ${item.name}?`)) return
    try {
      await deleteRecord(item.id)
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'inventory.delete',
        entityType: 'inventory_item', entityId: item.id,
        summary: `Deleted item — ${item.name} (${item.category || 'uncategorized'})`,
        metadata: { item_name: item.name, category: item.category || null, last_quantity: item.quantity, last_batch_number: item.batch_number || null, last_expiry_date: item.expiry_date || null },
      })
      showToast('Removed')
    } catch (e) {
      showToast(e.message)
    }
  }
  const openDispense = (item) => { setDispensingItem(item); setDispenseQuantity(''); setDispenseError(''); setSelectedPatient(null); setShowDispenseModal(true) }
  const closeDispense = () => { if (dispensing) return; setShowDispenseModal(false); setDispensingItem(null); setDispenseQuantity(''); setDispenseError(''); setSelectedPatient(null) }

  const handleDispense = async (e) => {
    e.preventDefault(); if (!dispensingItem) return; setDispenseError('')
    const qty = parseInt(dispenseQuantity, 10)
    if (isNaN(qty) || qty <= 0) return setDispenseError('Enter valid quantity.')
    if (!selectedPatient) return setDispenseError('Select patient.')
    const currQty = parseInt(dispensingItem.quantity, 10) || 0
    if (qty > currQty) return setDispenseError(`Insufficient stock. Only ${currQty} left.`)

    setDispensing(true)
    try {
      const newQty = currQty - qty
      const unitPrice = Number(dispensingItem.selling_price || 0)
      const totalPrice = unitPrice * qty

      await updateRecord(dispensingItem.id, { quantity: newQty, updated_at: new Date().toISOString() })
      await addStockRecord({ patient_id: selectedPatient.id, patient_name: selectedPatient.full_name, item_type: 'inventory', item_id: dispensingItem.id, item_name: dispensingItem.name, quantity_used: qty, unit_price: unitPrice, total_price: totalPrice, created_by: profile?.id })
      
      // AUTOMATIC CHARGE GENERATION
      await addBillableCharge({
        hospital_id: hospital.id, patient_id: selectedPatient.id, patient_name: selectedPatient.full_name,
        source_module: 'Inventory', source_transaction_id: `INV-${Date.now()}`,
        item_name: dispensingItem.name, category: dispensingItem.category, quantity: qty, unit_price: unitPrice, total: totalPrice,
        status: 'pending', created_by: profile?.id
      })

      // Audit trail — inventory dispense / use event.
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'inventory.dispense',
        entityType: 'inventory_item', entityId: dispensingItem.id,
        patientId: selectedPatient.id,
        summary: `Dispensed ${qty} ${dispensingItem.unit || 'units'} of ${dispensingItem.name} to ${selectedPatient.full_name}`,
        metadata: {
          item_name: dispensingItem.name,
          category: dispensingItem.category || null,
          quantity: qty,
          unit: dispensingItem.unit || 'units',
          unit_price: unitPrice,
          total_price: totalPrice,
          stock_before: currQty,
          stock_after: newQty,
        },
      })

      showToast(`${qty} ${dispensingItem.unit || 'units'} of ${dispensingItem.name} sent to Billing Queue.`)
      closeDispense(); if (refreshTable) await refreshTable()
    } catch (err) { setDispenseError(err.message || 'Failed.') } finally { setDispensing(false) }
  }

  const sorted = [...items].filter(item => !searchTerm.trim() || [item.name, item.category, item.supplier, item.batch_number].some(v => String(v || '').toLowerCase().includes(searchTerm.toLowerCase()))).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const lowStockItems = items.filter(item => Number(item.quantity || 0) <= Number(item.reorder_level || 0))

  // Global Pagination Rule — inventory can grow into the hundreds of
  // items; only the current page's rows get rendered into the table.
  const {
    pageItems: pagedItems, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(sorted, { pageSize: 20, resetKey: searchTerm })

  return (
    <>
      <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, marginBottom: 20 }}>
        <div className="dash-stat-card" style={{ minHeight: 120, padding: 18, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="dash-stat-icon" style={{ width: 58, height: 58, minWidth: 58, borderRadius: 14, background: 'var(--teal-soft)', color: 'var(--teal)' }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 30, height: 30 }}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg></div>
          <div><div className="dash-stat-label" style={{ fontSize: 12, marginBottom: 4 }}>Total Items</div><div className="dash-stat-value" style={{ fontSize: 28, lineHeight: 1.1, marginBottom: 4 }}>{items.length}</div></div>
        </div>
        <div className="dash-stat-card" style={{ minHeight: 120, padding: 18, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="dash-stat-icon" style={{ width: 58, height: 58, minWidth: 58, borderRadius: 14, background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 30, height: 30 }}><path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg></div>
          <div><div className="dash-stat-label" style={{ fontSize: 12, marginBottom: 4 }}>Low Stock</div><div className="dash-stat-value" style={{ fontSize: 28, lineHeight: 1.1, marginBottom: 4, color: lowStockItems.length > 0 ? 'var(--danger)' : undefined }}>{lowStockItems.length}</div></div>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel-head">
          <div><div className="dash-panel-title">Inventory & Supplies</div><div className="dash-panel-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: isOnline ? 'var(--teal)' : 'var(--danger)' }} />{isOnline ? 'Online' : 'Offline'}{pendingCount > 0 ? ` · ${pendingCount} syncing` : ''}{' · Auto-sends charges to Billing'}</div></div>
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search item..." style={{ minWidth: 260, maxWidth: 420 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <ModuleHistoryButton moduleKey="inventory" />
            <button className="btn btn-primary" style={{ width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setIsImportModalOpen(true)}><AppIcon name="import" size={14} /> Import Excel</button>
            <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => { resetForm(); setShowModal(true) }}>+ New Item</button>
          </div>
        </div>
        {loading ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div> : sorted.length === 0 ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No items found.</div> : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Item', 'Category', 'Stock', 'Batch', 'Expiry', ''].map(h => <th key={h} style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {pagedItems.map(item => {
                    const q = Number(item.quantity || 0), r = Number(item.reorder_level || 0), low = q <= r
                    return (
                      <tr key={item.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                        <td style={{ padding: 12, fontWeight: 700 }}>{item.name}</td>
                        <td style={{ padding: 12, color: 'var(--muted)', fontSize: 12.5 }}>{item.category}</td>
                        <td style={{ padding: 12 }}><span onClick={() => handleRestock(item)} style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', background: low ? 'rgba(225,104,94,0.14)' : 'var(--teal-soft)', color: low ? 'var(--danger)' : 'var(--teal)' }}>{q} {item.unit}</span></td>
                        <td style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>{item.batch_number || '—'}</td>
                        <td style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>{item.expiry_date || '—'}</td>
                        <td style={{ padding: 12, display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary" style={{ width: 'auto', padding: '7px 12px', fontSize: 11, opacity: q <= 0 ? 0.5 : 1 }} disabled={q <= 0} onClick={() => openDispense(item)}>Dispense</button>
                          <button className="btn btn-ghost" style={{ width: 'auto', padding: '7px 12px', fontSize: 11, color: 'var(--violet)', borderColor: 'rgba(118,87,232,0.4)', opacity: q <= 0 ? 0.5 : 1 }} disabled={q <= 0} onClick={() => openIssue(item)} title="Issue supplies to an internal department (Lab, Theatre, etc.) — no charge, stock only">Issue to Dept</button>
                          <button onClick={() => openEdit(item)} className="btn btn-ghost" style={{ width: 'auto', padding: '7px 12px', fontSize: 11, border: '1px solid var(--line)' }}>Edit</button>
                          <button onClick={() => handleDelete(item)} className="icon-btn-delete" title="Delete"><TrashIcon size={14}/></button>
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
              itemLabel="items"
            />
          </>
        )}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 18 }}>{editingId ? 'Edit Item' : 'New Item'}</div>
            {formError && <div className="error-box">{formError}</div>}
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', columnGap: 12 }}>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Item Name *</label><input value={name} onChange={e => setName(e.target.value)} /></div>
                <div className="field"><label>Category *</label><select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(v => <option key={v} value={v}>{v}</option>)}</select></div>
                <div className="field"><label>Supplier</label><input value={supplier} onChange={e => setSupplier(e.target.value)} /></div>
                <div className="field"><label>Generic Name</label><input value={genericName} onChange={e => setGenericName(e.target.value)} /></div>
                <div className="field"><label>Strength</label><input value={strength} onChange={e => setStrength(e.target.value)} placeholder="e.g. 500mg" /></div>
                <div className="field"><label>Dosage Form</label><input value={dosageForm} onChange={e => setDosageForm(e.target.value)} placeholder="e.g. Tablet, Syrup" /></div>
                <div className="field"><label>Quantity *</label><input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} /></div>
                <div className="field"><label>Unit</label><input value={unit} onChange={e => setUnit(e.target.value)} /></div>
                <div className="field"><label>Reorder Level</label><input type="number" min="0" value={reorderLevel} onChange={e => setReorderLevel(e.target.value)} /></div>
                <div className="field"><label>Cost Price</label><input type="number" step="0.01" value={costPrice} onChange={e => setCostPrice(e.target.value)} /></div>
                <div className="field"><label>Selling Price</label><input type="number" step="0.01" value={sellingPrice} onChange={e => setSellingPrice(e.target.value)} /></div>
                <div className="field"><label>Batch Number</label><input value={batchNumber} onChange={e => setBatchNumber(e.target.value)} /></div>
                <div className="field"><label>Expiry Date</label><input type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} /></div>
              <div className="field" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" id="requires-rx" checked={requiresRx} onChange={e => setRequiresRx(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--teal)' }} />
                <label htmlFor="requires-rx" style={{ margin: 0, fontSize: 13, color: 'var(--ivory)' }}>Requires prescription (hide from walk-in sales)</label>
              </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22 }}><button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
            </form>
          </div>
        </div>
      )}

      {showDispenseModal && dispensingItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 420 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 8 }}>Dispense / Use Item</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>{dispensingItem.name}</div>
            <div style={{ padding: 12, borderRadius: 8, background: 'var(--teal-soft)', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Available Stock & Price</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--teal)', marginTop: 3 }}>{dispensingItem.quantity} {dispensingItem.unit || 'units'}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold)' }}>₦{Number(dispensingItem.selling_price || 0).toFixed(2)}</div>
              </div>
            </div>
            {dispenseError && <div className="error-box" style={{ marginBottom: 12 }}>{dispenseError}</div>}
            <form onSubmit={handleDispense}>
              <div className="field">
                <label>Select Patient</label>
                <PatientAutocomplete
                  patients={patients}
                  value={selectedPatient ? { id: selectedPatient.id, label: selectedPatient.full_name, patient: selectedPatient } : null}
                  onChange={opt => setSelectedPatient(opt?.patient || null)}
                  ariaLabel="Patient"
                />
              </div>
              <div className="field"><label>Quantity</label><input type="number" min="1" max={dispensingItem.quantity} value={dispenseQuantity} onChange={e => setDispenseQuantity(e.target.value)} /></div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22 }}><button type="button" className="btn btn-ghost" onClick={closeDispense} disabled={dispensing}>Cancel</button><button type="submit" className="btn btn-primary" disabled={dispensing}>{dispensing ? 'Dispensing…' : 'Confirm'}</button></div>
            </form>
          </div>
        </div>
      )}

      {/* ---- "Issue to Department" modal --------------------------------
          Lets the storekeeper issue supplies (syringes, needles, gloves,
          reagents) to internal departments — Lab, Theatre, Nursing, etc.
          Stock is decremented but NO billable charge is generated
          (internal consumption — not billable to a patient). The
          audit log records department + reason so anyone reviewing
          inventory changes can see what was consumed where. */}
      {showIssueModal && issuingItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,3,26,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
          <div className="card" style={{ width: '100%', maxWidth: 460 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, marginBottom: 8 }}>Issue to Department</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>{issuingItem.name}</div>
            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(118,87,232,0.08)', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Available Stock</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--violet)', marginTop: 3 }}>{issuingItem.quantity} {issuingItem.unit || 'units'}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                Internal issue — no billable charge is generated.
                The department consumes the supplies for clinical use.
              </div>
            </div>
            {issueError && <div className="error-box" style={{ marginBottom: 12 }}>{issueError}</div>}
            <form onSubmit={handleIssueToDepartment}>
              <div className="field">
                <label>Department</label>
                <select value={issueDepartment} onChange={e => setIssueDepartment(e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line)' }}>
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Quantity</label>
                <input type="number" min="1" max={issuingItem.quantity} value={issueQuantity} onChange={e => setIssueQuantity(e.target.value)} placeholder="1" />
              </div>
              <div className="field">
                <label>Reason / Purpose (optional)</label>
                <input type="text" value={issueReason} onChange={e => setIssueReason(e.target.value)} placeholder="e.g. Lab — daily phlebotomy rounds" />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
                <button type="button" className="btn btn-ghost" onClick={closeIssue} disabled={issuing}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={issuing}>{issuing ? 'Issuing…' : 'Issue to Department'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

     <ImportExcelModal
  isOpen={isImportModalOpen}
  onClose={() => setIsImportModalOpen(false)}
  existingInventory={items || []}
  onImportSuccess={async (item, matchedItemId) => {
    if (!hospital?.id) {
      throw new Error('Please select a hospital before importing inventory.')
    }

    const quantityToAdd = Number(item.quantity) || 0

    const payload = {
      name: item.name?.trim(),
      category: item.category || 'Other',
      quantity: quantityToAdd,
      unit: item.unit || 'units',
      supplier: item.supplier || '',
      reorder_level: Number(item.reorderLevel) || 10,
      selling_price: Number(item.sellingPrice) || 0,
      cost_price: Number(item.costPrice) || 0,
      batch_number: item.batchNumber || '',
      expiry_date: item.expiryDate || null,
      generic_name: item.genericName || '',
      strength: item.strength || '',
      dosage_form: item.dosageForm || '',
    }

    if (!payload.name) {
      throw new Error('An inventory item is missing its name.')
    }

    if (matchedItemId) {
      const existingItem = (items || []).find(
        (record) => record.id === matchedItemId
      )

      if (!existingItem) {
        throw new Error(
          `Could not find the existing item "${payload.name}". Please refresh and try again.`
        )
      }

      await updateRecord(matchedItemId, {
        ...payload,
        quantity:
          (Number(existingItem.quantity) || 0) + quantityToAdd,
      })

      // Audit trail — Excel import matched an existing item (stock increment).
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'inventory.import_match',
        entityType: 'inventory_item', entityId: matchedItemId,
        summary: `Excel import — added ${quantityToAdd} ${payload.unit} to "${payload.name}"`,
        metadata: { item_name: payload.name, category: payload.category, added_quantity: quantityToAdd, previous_quantity: Number(existingItem.quantity) || 0, new_quantity: (Number(existingItem.quantity) || 0) + quantityToAdd, batch_number: payload.batch_number || null, expiry_date: payload.expiry_date },
      })
    } else {
      const saved = await addRecord({
        ...payload,
        hospital_id: hospital.id,
        created_by: profile?.id,
      })

      // Audit trail — Excel import created a new item.
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'inventory.import_create',
        entityType: 'inventory_item', entityId: saved?.id || null,
        summary: `Excel import — added new item "${payload.name}" (${payload.category})`,
        metadata: { item_name: payload.name, category: payload.category, quantity: quantityToAdd, unit: payload.unit, supplier: payload.supplier, batch_number: payload.batch_number || null, expiry_date: payload.expiry_date },
      })
    }

    if (refreshTable) {
      await refreshTable()
    }
  }}
  hospitalId={hospital?.id}
/>
      {toast && <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-elevated)', border: '1px solid var(--teal)', color: 'var(--teal)', padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 700, zIndex: 60 }}>{toast}</div>}
    </>
  )
}
