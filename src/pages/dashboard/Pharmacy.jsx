import { useState, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useLazyTable } from '../../lib/useLazyTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import AppIcon from '../../components/icons'
import ConnectionState from '../../components/common/ConnectionState'
import PatientAutocomplete from '../../components/common/PatientAutocomplete'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import WalkInSaleModal from '../../components/pharmacy/WalkInSaleModal'
import useMediaQuery from '../../lib/useMediaQuery'
import { getTimezone, formatDate as formatDateTz, formatDateTime } from '../../lib/datetime'
import { writeAudit } from '../../lib/audit'
import { ROLE_LABELS } from '../../lib/permissions'

export default function Pharmacy() {
  const { profile, hospital } = useAuth()
  const timezone = getTimezone(hospital)
  // Batch-2 QA: phones re-flow both tables into record cards instead of
  // force-scrolling 5–7 nowrap columns inside a 320–430px screen.
  const isPhone = useMediaQuery('(max-width: 767px)')

  // PERFORMANCE: pharmTab state declared early so we can gate the
  // heavy table loads on it. Before this change, ALL tables loaded
  // on every Pharmacy mount — even if the pharmacist was only on
  // the "queue" tab and didn't need inventory/sales data.
  const [pharmTab, setPharmTab] = useState('queue') // 'requests' | 'queue' | 'inventory' | 'sales'

  // inventory_items: needed on inventory + queue tabs (queue needs stock info)
  const { records: inventoryItems, loading, isOnline, pendingCount, updateRecord, refreshTable } = useLazyTable('inventory_items', hospital?.id, { enabled: pharmTab === 'inventory' || pharmTab === 'queue' })
  // patients: needed on all tabs (for dispense modal)
  const { records: patients } = useOfflineTable('patients', hospital?.id)
  // Write-only tables — keep eager (write path doesn't depend on `enabled`)
  const { addRecord: addStockRecord } = useOfflineTable('patient_stock_records', hospital?.id)
  const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id)

  // prescriptions: needed on queue + requests tabs
  const { records: prescriptions, updateRecord: updatePrescriptions, syncFromServer: syncPrescriptions } = useLazyTable('prescriptions', hospital?.id, { enabled: pharmTab === 'queue' || pharmTab === 'requests' })
  // pharmRequests: needed on requests tab
  const { records: pharmRequests, updateRecord: updatePharmRequest } = useLazyTable('pharmacy_requests', hospital?.id, { enabled: pharmTab === 'requests' })
  // pharmacySales: needed on sales tab only
  const { records: pharmacySales, syncFromServer: syncPharmacySales } = useLazyTable('pharmacy_sales', hospital?.id, { enabled: pharmTab === 'sales' })
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [showDispenseModal, setShowDispenseModal] = useState(false)
  const [dispensingItem, setDispensingItem] = useState(null)
  const [dispenseQuantity, setDispenseQuantity] = useState('')
  const [dispensing, setDispensing] = useState(false)
  const [dispenseError, setDispenseError] = useState('')
  const [selectedPatient, setSelectedPatient] = useState(null)
  const [activeRx, setActiveRx] = useState(null) // Tracks if dispensing from a doctor's order
  const [activeReq, setActiveReq] = useState(null) // Tracks if dispensing a staff request
  // pharmTab was moved up to line 30 (needed for lazy-table gating)
  const [showWalkInModal, setShowWalkInModal] = useState(false)
  const [salesRefreshKey, setSalesRefreshKey] = useState(0)
  // ---- Pharmacy request dispense modal state ----
  const [showRequestDispenseModal, setShowRequestDispenseModal] = useState(false)
  const [dispensingRequest, setDispensingRequest] = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  // Live alert — the instant a doctor finalizes a prescription anywhere
  // in the hospital, show a toast here and pull the fresh record down.
  useRealtimeAlert('prescriptions', hospital?.id, (newRow) => {
    if (newRow.status === 'active') {
      // Plain text — no emoji as icons (unified icon system, req. #12).
      showToast(`New prescription received for ${newRow.patient_name || 'a patient'}`)
      syncPrescriptions()
    }
  })
  
  // Doctor's Prescription Queue
  const pendingRx = prescriptions.filter(p => p.status === 'active').sort((a,b) => new Date(a.prescribed_at) - new Date(b.prescribed_at))
  
  const drugs = inventoryItems.filter(item => String(item.category || '').trim().toLowerCase() === 'drug')
  const visibleItems = searchTerm.trim() ? drugs.filter(item => [item.name, item.generic_name, item.strength, item.batch_number].some(v => String(v || '').toLowerCase().includes(searchTerm.toLowerCase()))) : drugs
  const lowStockCount = drugs.filter(item => Number(item.quantity || 0) <= Number(item.reorder_level || 0)).length
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const expiredCount = drugs.filter(item => { if (!item.expiry_date) return false; const e = new Date(item.expiry_date); e.setHours(0,0,0,0); return e < today }).length
  const expiringSoonCount = drugs.filter(item => { if (!item.expiry_date) return false; const e = new Date(item.expiry_date); e.setHours(0,0,0,0); const d = (e.getTime() - today.getTime()) / (1000*60*60*24); return d >= 0 && d <= 30 }).length

  const formatMoney = (v) => '₦' + Number(v || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // Delegates to the centralized date utility with the hospital timezone (req. #11)
  const formatDate = (v) => formatDateTz(v, timezone)
  const isExpired = (item) => { if (!item.expiry_date) return false; const e = new Date(item.expiry_date); e.setHours(0,0,0,0); return e < today }
  const isExpiringSoon = (item) => { if (!item.expiry_date) return false; const e = new Date(item.expiry_date); e.setHours(0,0,0,0); const d = (e.getTime() - today.getTime()) / (1000*60*60*24); return d >= 0 && d <= 30 }

  const handleRestock = async (item) => {
    const input = prompt(`Current stock: ${item.quantity} ${item.unit}\n\nEnter new quantity:`, item.quantity)
    if (input === null) return
    const newQ = parseInt(input, 10)
    if (isNaN(newQ) || newQ < 0) return showToast('Invalid quantity')
    try {
      await updateRecord(item.id, { quantity: newQ, updated_at: new Date().toISOString() })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'pharmacy.restock',
        entityType: 'inventory_item', entityId: item.id,
        summary: `Pharmacy restock — ${item.name}: ${item.quantity} → ${newQ} ${item.unit || 'units'}`,
        metadata: { item_name: item.name, batch_number: item.batch_number || null, from: item.quantity, to: newQ, unit: item.unit || 'units' },
      })
      showToast('Stock updated')
    } catch (e) {
      showToast(e.message)
    }
  }

  /* ---- Phone card layouts (Batch-2 QA) ------------------------------
     Same information as the desktop tables, re-flowed for 320–430px.
     Rendered only when isPhone — no duplicated hidden DOM. */
  function RxCard({ rx }) {
    return (
      <div className="appt-card">
        <div className="appt-card-top">
          <span className="appt-card-time" style={{ background: 'rgba(139,124,246,0.14)', color: 'var(--violet)', fontSize: 10 }}>RX</span>
          <div className="appt-card-id-block">
            <div className="appt-card-name">{rx.patient_name}</div>
            <div className="appt-card-meta">{rx.drug_name} · {rx.dosage} · {rx.frequency}</div>
            {rx.doctor_name && <div className="appt-card-meta">Dr. {rx.doctor_name.replace(/^Dr\.?\s*/i, '')}</div>}
          </div>
        </div>
        <div className="appt-card-foot">
          <button className="btn btn-primary" style={{ width: 'auto', padding: '8px 16px', fontSize: 12 }} onClick={() => openDispenseRx(rx)}>Dispense</button>
          <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 14px', fontSize: 12, color: 'var(--danger)', border: '1px solid var(--danger)' }} onClick={() => handleCancelRx(rx)}>Cancel</button>
        </div>
      </div>
    )
  }

  function DrugCard({ item }) {
    const q = Number(item.quantity || 0), r = Number(item.reorder_level || 0), low = q <= r, exp = isExpired(item), soon = isExpiringSoon(item)
    const statusNode = exp
      ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger)' }}>EXPIRED</span>
      : low ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger)' }}>LOW STOCK</span>
      : soon ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gold)' }}>EXPIRING</span>
      : <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--teal)' }}>AVAILABLE</span>
    return (
      <div className="appt-card">
        <div className="appt-card-top">
          <span
            className="appt-card-time"
            style={{ background: low ? 'rgba(225,104,94,0.14)' : 'var(--teal-soft)', color: low ? 'var(--danger)' : 'var(--teal)', fontSize: 10, cursor: 'pointer' }}
            onClick={() => handleRestock(item)}
            role="button"
            aria-label={`Stock ${q} ${item.unit || 'units'}. Tap to restock ${item.name}`}
            title="Tap to restock"
          >{q}</span>
          <div className="appt-card-id-block">
            <div className="appt-card-name">{item.name}</div>
            <div className="appt-card-meta">
              Batch {item.batch_number || '—'} · Exp {formatDate(item.expiry_date)}
            </div>
            <div className="appt-card-meta">{formatMoney(item.selling_price)} · {item.unit || 'units'}</div>
          </div>
        </div>
        <div className="appt-card-foot">
          {statusNode}
          <button
            className="btn btn-primary"
            style={{ width: 'auto', padding: '8px 16px', fontSize: 12, opacity: exp || q <= 0 ? 0.5 : 1 }}
            disabled={exp || q <= 0}
            onClick={() => openDispense(item)}
          >Dispense</button>
        </div>
      </div>
    )
  }

  // Manual Dispense (Over the counter)
  const openDispense = (item) => { 
    setDispensingItem(item); setDispenseQuantity(''); setDispenseError(''); setSelectedPatient(null); setActiveRx(null); setShowDispenseModal(true) 
  }

  // NEW: Cancel Prescription from Doctor's Queue
  async function handleCancelRx(rx) {
    if (!confirm(`Cancel prescription for ${rx.drug_name}?`)) return
    try {
      await updatePrescription(rx.id, { status: 'cancelled' })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'prescription.cancelled',
        entityType: 'prescription', entityId: rx.id, patientId: rx.patient_id || null,
        summary: `Cancelled prescription — ${rx.drug_name} for ${rx.patient_name || 'patient'}`,
        metadata: {
          drug_name: rx.drug_name, dosage: rx.dosage || null, frequency: rx.frequency || null,
          patient_name: rx.patient_name || null, doctor_name: rx.doctor_name || null,
          prescribed_at: rx.prescribed_at || null,
        },
      })
      showToast('Prescription cancelled')
    } catch (err) {
      showToast(err.message || 'Failed to cancel')
    }
  }

  // ---- Staff medication requests (sent from patient profiles + nursing) ----
  // openRequests = pending requests (status === 'requested'), newest first
  const openRequests = useMemo(() => {
    return (pharmRequests || [])
      .filter(r => r.status === 'requested')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [pharmRequests])

  // rxSummary: for a prescription + its requests, return how many were
  // prescribed, how many were requested across all open requests, and
  // how many remain available to dispense.
  function rxSummary(rx, allRequests) {
    if (!rx) return null
    const prescribed = Number(rx.quantity || 0)
    const requested = (allRequests || [])
      .filter(r => r.prescription_id === rx.id && r.status !== 'cancelled')
      .reduce((s, r) => s + Number(r.quantity || 0), 0)
    return { total: prescribed, requested, remaining: prescribed - requested }
  }

  // openDispenseRequest: when pharmacist clicks "Dispense" on a staff
  // request — find the matching drug in inventory, find the patient,
  // open the standard dispense modal pre-filled.
  function openDispenseRequest(req) {
    const matchedDrug = inventoryItems.find(it =>
      String(it.name || '').toLowerCase() === String(req.drug_name || '').toLowerCase() ||
      String(it.generic_name || '').toLowerCase() === String(req.drug_name || '').toLowerCase()
    )
    const matchedPatient = patients.find(p => p.id === req.patient_id)
    if (!matchedPatient) {
      showToast('Patient record not found.')
      return
    }
    if (!matchedDrug) {
      setDispensingItem({
        id: null,
        name: req.drug_name,
        quantity: 9999,
        unit: 'units',
        selling_price: 0,
        expiry_date: null,
      })
      showToast(`"${req.drug_name}" is not in inventory. Enter price manually.`)
    } else {
      setDispensingItem(matchedDrug)
    }
    setDispenseQuantity(String(req.quantity || '1'))
    setDispenseError('')
    setSelectedPatient(matchedPatient)
    setActiveRx(null)  // not from a prescription directly
    setActiveReq(req)  // track this staff request for completion
    setShowDispenseModal(true)
  }

  // handleRejectRequest: pharmacist declines a staff request
  async function handleRejectRequest(req) {
    const reason = prompt(`Reject request for ${req.quantity} × ${req.drug_name}?\n\nReason (required):`)
    if (!reason?.trim()) return
    try {
      await updatePharmRequest(req.id, {
        status: 'cancelled',
        notes: (req.notes ? req.notes + ' | ' : '') + `Rejected by pharmacy: ${reason.trim()}`,
      })
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: 'pharmacy_request.rejected',
        entityType: 'pharmacy_request', entityId: req.id,
        patientId: req.patient_id || null,
        summary: `Rejected medication request — ${req.quantity} × ${req.drug_name} for ${req.patient_name || 'patient'} — reason: ${reason.trim()}`,
        metadata: {
          request_id: req.id, drug_name: req.drug_name, quantity: req.quantity,
          patient_id: req.patient_id, requested_by: req.requested_by_name,
          reason: reason.trim(),
        },
      })
      showToast('Request rejected')
    } catch (err) {
      showToast(err.message || 'Failed to reject request')
    }
  }

  // Automatic Dispense (From Doctor's Queue)
  const openDispenseRx = (rx) => {
    // Find matching drug in inventory
    const matchedDrug = inventoryItems.find(it => 
      String(it.name || '').toLowerCase() === String(rx.drug_name || '').toLowerCase() || 
      String(it.generic_name || '').toLowerCase() === String(rx.drug_name || '').toLowerCase()
    )

    // Find patient
    const matchedPatient = patients.find(p => p.id === rx.patient_id)
    if (!matchedPatient) {
      return showToast(`Patient record not found.`)
    }

    if (!matchedDrug) {
      // NEW: If not in inventory, create a mock item so the pharmacist can still dispense it
      setDispensingItem({
        id: null,
        name: rx.drug_name,
        quantity: 9999, // Don't restrict stock
        unit: 'units',
        selling_price: 0, // Will prompt for price during dispense
        expiry_date: null
      })
      showToast(`"${rx.drug_name}" is not in inventory. Please enter price manually.`)
    } else {
      setDispensingItem(matchedDrug)
    }

    setDispenseQuantity(rx.quantity || '1')
    setDispenseError('')
    setSelectedPatient(matchedPatient)
    setActiveRx(rx) // Link this dispense to the doctor's prescription
    setShowDispenseModal(true)
  }

  const closeDispense = () => {
    if (dispensing) return
    setShowDispenseModal(false); setDispensingItem(null); setDispenseQuantity(''); setDispenseError(''); setSelectedPatient(null); setActiveRx(null); setActiveReq(null)
  }

  const handleDispense = async (e) => {
    e.preventDefault()
    if (!dispensingItem) return
    setDispenseError('')
    const qty = parseInt(dispenseQuantity, 10)
    if (isNaN(qty) || qty <= 0) return setDispenseError('Enter valid quantity.')
    if (!selectedPatient) return setDispenseError('Please select a patient.')
    
    const currQty = parseInt(dispensingItem.quantity, 10) || 0
    // Only enforce stock limits if the drug is actually in inventory
    if (dispensingItem.id && qty > currQty) return setDispenseError(`Insufficient stock. Only ${currQty} left.`)
    if (dispensingItem.id && isExpired(dispensingItem)) return setDispenseError('This drug has expired.')

    setDispensing(true)
    try {
      let unitPrice = Number(dispensingItem.selling_price || 0)
      
      // NEW: If the drug is not in inventory (no ID), prompt for the price
      if (!dispensingItem.id) {
        const priceStr = prompt(`Enter price for ${dispensingItem.name} (₦):`, '0')
        unitPrice = parseFloat(priceStr) || 0
      }

      const newQty = dispensingItem.id ? (currQty - qty) : null
      const totalPrice = unitPrice * qty

      // 1. Reduce Stock (ONLY if it exists in inventory)
      if (dispensingItem.id) {
        await updateRecord(dispensingItem.id, { quantity: newQty, updated_at: new Date().toISOString() })
      }
      
      // 2. Record in Patient Profile
      await addStockRecord({ 
        patient_id: selectedPatient.id, patient_name: selectedPatient.full_name, 
        item_type: 'pharmacy', item_id: dispensingItem.id, item_name: dispensingItem.name, 
        quantity_used: qty, unit_price: unitPrice, total_price: totalPrice, created_by: profile?.id 
      })
      
      // 3. AUTOMATIC CHARGE GENERATION (Sent to Cashier Queue)
      await addBillableCharge({
        hospital_id: hospital.id, patient_id: selectedPatient.id, patient_name: selectedPatient.full_name,
        source_module: 'Pharmacy', source_transaction_id: `PHARM-${Date.now()}`,
        item_name: dispensingItem.name, category: 'Drug', quantity: qty, unit_price: unitPrice, total: totalPrice,
        status: 'pending', created_by: profile?.id
      })

      // 4. If this was from a Doctor's Order, mark prescription as dispensed
      if (activeRx) {
        await updatePrescription(activeRx.id, { status: 'dispensed' })
      }

      // 4b. If this was from a staff medication request, mark it dispensed
      if (activeReq) {
        await updatePharmRequest(activeReq.id, {
          status: 'dispensed',
          dispensed_quantity: qty,
          dispensed_by: profile?.id || null,
          dispensed_by_name: profile?.full_name || null,
          dispensed_at: new Date().toISOString(),
        })
        writeAudit({
          hospitalId: hospital?.id, actor: profile,
          action: 'pharmacy_request.dispensed',
          entityType: 'pharmacy_request', entityId: activeReq.id,
          patientId: selectedPatient.id,
          summary: `Dispensed ${qty} × ${dispensingItem.name} for staff request by ${activeReq.requested_by_name || 'staff'} — for ${selectedPatient.full_name}`,
          metadata: {
            request_id: activeReq.id, drug_name: dispensingItem.name, quantity: qty,
            requested_by: activeReq.requested_by_name,
          },
        })
      }

      // 5. Audit trail — dispense event.
      //    One audit row regardless of whether this was an OTC dispense or
      //    a doctor's-order dispense; the `from_prescription` flag and the
      //    optional `prescription_id` in metadata distinguish the two.
      writeAudit({
        hospitalId: hospital?.id, actor: profile,
        action: activeRx ? 'prescription.dispensed' : 'pharmacy.dispense_otc',
        entityType: activeRx ? 'prescription' : 'inventory_item',
        entityId: activeRx?.id || dispensingItem.id || null,
        patientId: selectedPatient.id,
        summary: `Dispensed ${qty} ${dispensingItem.unit || 'units'} of ${dispensingItem.name} to ${selectedPatient.full_name}`,
        metadata: {
          item_name: dispensingItem.name,
          item_id: dispensingItem.id || null,
          quantity: qty,
          unit: dispensingItem.unit || 'units',
          unit_price: unitPrice,
          total_price: totalPrice,
          from_prescription: Boolean(activeRx),
          prescription_id: activeRx?.id || null,
          doctor_name: activeRx?.doctor_name || null,
          stock_before: dispensingItem.id ? currQty : null,
          stock_after: dispensingItem.id ? newQty : null,
        },
      })

      showToast(`${qty} ${dispensingItem.unit || 'units'} of ${dispensingItem.name} sent to Billing Queue.`)
      closeDispense()
      if (refreshTable) await refreshTable()
    } catch (err) { 
      setDispenseError(err.message || 'Failed to dispense.') 
    } finally { setDispensing(false) }
  }

  // Global Pagination Rule — the pharmacy drug catalogue can run into
  // the hundreds of SKUs; only the current page of the search results
  // gets rendered (both desktop table and phone card list use this).
  const {
    pageItems: pagedItems, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(visibleItems, { pageSize: 20, resetKey: searchTerm })

  return (
    <>
      {/* Stats — shared .dash-stats grid */}
      <div className="dash-stats glass-scope" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}><AppIcon name="pill" size={20} /></div>
          <div>
            <div className="dash-stat-label">Total Drugs</div>
            <div className="dash-stat-value">{drugs.length}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}><AppIcon name="arrowDown" size={20} /></div>
          <div>
            <div className="dash-stat-label">Low Stock</div>
            <div className="dash-stat-value" style={{ color: lowStockCount > 0 ? 'var(--danger)' : 'var(--text)' }}>{lowStockCount}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}><AppIcon name="clock" size={20} /></div>
          <div>
            <div className="dash-stat-label">Expired</div>
            <div className="dash-stat-value" style={{ color: expiredCount > 0 ? 'var(--danger)' : 'var(--text)' }}>{expiredCount}</div>
          </div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(212,175,55,0.14)', color: 'var(--gold)' }}><AppIcon name="calendar" size={20} /></div>
          <div>
            <div className="dash-stat-label">Expiring Soon</div>
            <div className="dash-stat-value">{expiringSoonCount}</div>
          </div>
        </div>
      </div>

      {/* DOCTOR'S PRESCRIPTION QUEUE — an actionable work queue, not a
          browsable record list, so it is intentionally left unpaginated
          per the "don't apply pagination where it hurts the workflow"
          rule. If this queue starts running into the hundreds in
          practice, it should get pagination too — flag it if so. */}
      {/* ---- Tab switcher: Queue / Walk-in Sale / Inventory / Sales History
            + History button (always visible, right-aligned) ---- */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { key: 'requests', label: 'Requests', badge: pharmRequests.filter(r => r.status === 'pending').length },
          { key: 'queue', label: 'Prescription Queue' },
          { key: 'walkin', label: 'Walk-in Sale' },
          { key: 'inventory', label: 'Pharmacy Inventory' },
          { key: 'sales', label: 'Sales History' },
        ].map(t => (
          <button
            key={t.key}
            type="button"
            className={`btn ${pharmTab === t.key ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => { setPharmTab(t.key); if (t.key === 'walkin') setShowWalkInModal(true) }}
          >
            {t.label}
            {t.badge > 0 && (
              <span style={{
                background: pharmTab === t.key ? 'rgba(255,255,255,0.2)' : 'var(--danger)',
                color: '#fff', fontSize: 10.5, fontWeight: 700,
                padding: '1px 7px', borderRadius: 10, minWidth: 18, textAlign: 'center',
              }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <ModuleHistoryButton moduleKey="pharmacy" />
        </div>
      </div>

      {/* ---- REQUESTS TAB — free-text med requests from staff ---- */}
      {pharmTab === 'requests' && (
        <PharmacyRequestsTab
          pharmRequests={pharmRequests}
          updatePharmRequest={updatePharmRequest}
          hospital={hospital}
          profile={profile}
          timezone={timezone}
          showToast={showToast}
          onDispense={(req) => { setDispensingRequest(req); setShowRequestDispenseModal(true) }}
        />
      )}

      {/* DOCTOR'S PRESCRIPTION QUEUE */}
      {pharmTab === 'queue' && (
      <>
      {/* Staff medication requests: who asked for what, for which patient */}
      {openRequests.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 20 }}>
          <div className="dash-panel-head">
            <div>
              <div className="dash-panel-title">Staff Medication Requests ({openRequests.length})</div>
              <div className="dash-panel-sub">Sent from patient profiles and the nursing station</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {openRequests.map(req => {
              const rx = prescriptions.find(p => p.id === req.prescription_id)
              const sum = rx ? rxSummary(rx, pharmRequests) : null
              const when = req.created_at ? new Date(req.created_at).toLocaleString('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
              const badge = { fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--warning-soft)', color: 'var(--warning)' }
              return (
                <div key={req.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{req.quantity} × {req.drug_name}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>for {req.patient_name || 'patient'}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      Requested by <b style={{ color: 'var(--ivory)' }}>{req.requested_by_name || 'Staff'}</b>
                      {req.requested_by_role ? ` (${ROLE_LABELS[req.requested_by_role] || req.requested_by_role})` : ''}{when ? ` · ${when}` : ''}
                    </div>
                    {sum && sum.total != null && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                        Prescription: {sum.total} prescribed · {sum.requested} requested · {Math.max(0, sum.remaining)} left
                      </div>
                    )}
                    {req.notes && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Note: {req.notes}</div>}
                    {(req.not_prescribed || req.exceeds_remaining) && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        {req.not_prescribed && <span style={badge}>Not prescribed</span>}
                        {req.exceeds_remaining && <span style={badge}>More than prescribed</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" style={{ width: 'auto', padding: '8px 16px', fontSize: 12 }} onClick={() => openDispenseRequest(req)}>Dispense</button>
                    <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 14px', fontSize: 12, color: 'var(--danger)', border: '1px solid var(--danger)' }} onClick={() => handleRejectRequest(req)}>Reject</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="dash-panel" style={{ marginBottom: 20, borderColor: 'var(--teal)' }}>
        <div className="dash-panel-head">
          <div>
            <div className="dash-panel-title" style={{ color: 'var(--teal)' }}>Doctor's Prescription Queue</div>
            <div className="dash-panel-sub">Prescriptions automatically sent from the Doctor Workbench</div>
          </div>
        </div>
        {pendingRx.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>No pending prescriptions from doctors.</div>
        ) : isPhone ? (
          <div className="appt-list" style={{ padding: '4px 0 12px' }}>
            {pendingRx.map(rx => <RxCard key={rx.id} rx={rx} />)}
          </div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-full-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Drug Prescribed</th>
                  <th>Dosage / Frequency</th>
                  <th>Doctor</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingRx.map(rx => (
                  <tr key={rx.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                    <td style={{ padding: 12, fontWeight: 700 }}>{rx.patient_name}</td>
                    <td style={{ padding: 12 }}>{rx.drug_name}</td>
                    <td style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>{rx.dosage} · {rx.frequency}</td>
                    <td style={{ padding: 12, fontSize: 12 }}>{rx.doctor_name || '—'}</td>
                    <td style={{ padding: 12 }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }} onClick={() => openDispenseRx(rx)}>
                          Dispense
                        </button>
                        <button className="btn btn-ghost" style={{ width: 'auto', padding: '6px 14px', fontSize: 12, color: 'var(--danger)', border: '1px solid var(--danger)' }} onClick={() => handleCancelRx(rx)}>
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}

      {/* EXISTING INVENTORY TABLE — shown when pharmTab === 'inventory' */}
      {pharmTab === 'inventory' && (
      <div className="dash-panel">
        <div className="dash-panel-head">
          <div><div className="dash-panel-title">Pharmacy Inventory</div><div className="dash-panel-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><ConnectionState isOnline={isOnline} pendingCount={pendingCount} />{' · Auto-sends charges to Billing'}</div></div>
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search drug..." style={{ minWidth: 260, maxWidth: 420 }} />
        </div>
        {loading ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div> : visibleItems.length === 0 ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No drugs found.</div> : (
          <>
            {isPhone ? (
              <div className="appt-list" style={{ padding: '4px 0 12px' }}>
                {pagedItems.map(item => <DrugCard key={item.id} item={item} />)}
              </div>
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-full-table">
                  <thead><tr>{['Drug', 'Batch', 'Expiry', 'Stock', 'Price', 'Status', ''].map(h => <th key={h} style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '0 12px 12px', textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {pagedItems.map(item => {
                      const q = Number(item.quantity || 0), r = Number(item.reorder_level || 0), low = q <= r, exp = isExpired(item), soon = isExpiringSoon(item)
                      return (
                        <tr key={item.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                          <td style={{ padding: 12, fontWeight: 700 }}>{item.name}</td>
                          <td style={{ padding: 12, fontSize: 11.5, color: 'var(--muted)' }}>{item.batch_number || '—'}</td>
                          <td style={{ padding: 12, fontSize: 12 }}><span style={{ color: exp ? 'var(--danger)' : soon ? 'var(--gold)' : 'var(--muted)', fontWeight: exp || soon ? 700 : 400 }}>{formatDate(item.expiry_date)}</span></td>
                          <td style={{ padding: 12 }}>
                            <button
                              type="button"
                              onClick={() => handleRestock(item)}
                              className="appt-status-btn"
                              style={{ fontSize: 11, fontWeight: 700, background: low ? 'rgba(225,104,94,0.14)' : 'var(--teal-soft)', color: low ? 'var(--danger)' : 'var(--teal)' }}
                              title="Tap to restock"
                              aria-label={`Stock ${q} ${item.unit || 'units'}. Tap to restock ${item.name}`}
                            >{q} {item.unit || 'units'}</button>
                          </td>
                          <td style={{ padding: 12, fontSize: 12.5, color: 'var(--muted)' }}>{formatMoney(item.selling_price)}</td>
                          <td style={{ padding: 12 }}>{exp ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger)' }}>EXPIRED</span> : low ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger)' }}>LOW STOCK</span> : soon ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gold)' }}>EXPIRING</span> : <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--teal)' }}>AVAILABLE</span>}</td>
                          <td style={{ padding: 12 }}>
                            <button className="btn btn-primary" style={{ width: 'auto', padding: '7px 12px', fontSize: 11, opacity: exp || q <= 0 ? 0.5 : 1 }} disabled={exp || q <= 0} onClick={() => openDispense(item)}>Dispense</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              startIndex={startIndex}
              endIndex={endIndex}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
              itemLabel="drugs"
            />
          </>
        )}
      </div>
      )}

      {/* ---- Sales History tab ---- */}
      {pharmTab === 'sales' && <SalesHistory hospital={hospital} timezone={timezone} refreshKey={salesRefreshKey} />}

      {/* ---- Walk-in Sale modal ---- */}
      {showWalkInModal && (
        <WalkInSaleModal
          hospital={hospital}
          profile={profile}
          onClose={() => setShowWalkInModal(false)}
          onSaleComplete={() => { setSalesRefreshKey(k => k + 1); setPharmTab('sales') }}
        />
      )}

      {showDispenseModal && dispensingItem && (
        /* Shared modal chrome → bottom sheet with pinned actions on phones */
        <div className="dash-modal-backdrop">
          <div className="card dash-modal" style={{ maxWidth: 420 }}>
            <div className="dash-modal-title">Dispense Medication</div>
            <form onSubmit={handleDispense}>
              <div className="dash-modal-body">
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>{dispensingItem.name}</div>
            <div style={{ padding: 12, borderRadius: 8, background: 'var(--teal-soft)', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{dispensingItem.id ? 'Available Stock & Price' : 'Not in Inventory (Manual Entry)'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--teal)', marginTop: 3 }}>
                  {dispensingItem.id ? `${dispensingItem.quantity} ${dispensingItem.unit || 'units'}` : 'Enter Price on Confirm'}
                </div>
                {dispensingItem.id && <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold)' }}>{formatMoney(dispensingItem.selling_price)} each</div>}
              </div>
            </div>
            {dispenseError && <div className="error-box" style={{ marginBottom: 12 }}>{dispenseError}</div>}
            <div className="field">
                <label>Select Patient</label>
                <PatientAutocomplete
                  patients={patients}
                  value={selectedPatient ? { id: selectedPatient.id, label: selectedPatient.full_name, patient: selectedPatient } : null}
                  onChange={opt => setSelectedPatient(opt?.patient || null)}
                  placeholder="Search patient name…"
                  ariaLabel="Patient"
                />
              </div>
              <div className="field"><label>Quantity to Dispense</label><input type="number" min="1" value={dispenseQuantity} onChange={e => setDispenseQuantity(e.target.value)} placeholder="Enter quantity" /></div>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeDispense} disabled={dispensing}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={dispensing}>{dispensing ? 'Dispensing…' : 'Confirm Dispense'}</button>
            </div>
          </form>
          </div>
        </div>
      )}

      {/* ---- Pharmacy Request Dispense modal ---- */}
      {showRequestDispenseModal && dispensingRequest && (
        <PharmacyRequestDispenseModal
          request={dispensingRequest}
          hospital={hospital}
          profile={profile}
          timezone={timezone}
          onDispense={async ({ dispensedItems, dispensedNotes, chargeAmount }) => {
            try {
              // Create billable charge if the pharmacist entered a charge amount
              if (chargeAmount > 0) {
                await addBillableCharge({
                  hospital_id: hospital.id,
                  patient_id: dispensingRequest.patient_id,
                  patient_name: dispensingRequest.patient_name,
                  source_module: 'Pharmacy',
                  source_transaction_id: `PHARMREQ-${dispensingRequest.id.slice(0, 8)}`,
                  item_name: `Pharmacy: ${dispensedNotes || dispensingRequest.request_text.slice(0, 50)}`,
                  category: 'Drug',
                  quantity: 1,
                  unit_price: chargeAmount,
                  total: chargeAmount,
                  status: 'pending',
                  created_by: profile?.id,
                })
              }
              await updatePharmRequest(dispensingRequest.id, {
                status: 'dispensed',
                dispensed_at: new Date().toISOString(),
                dispensed_by: profile?.id || null,
                dispensed_by_name: profile?.full_name || null,
                dispensed_items: dispensedItems,
                dispensed_notes: dispensedNotes || null,
              })
              writeAudit({
                hospitalId: hospital.id, actor: profile,
                action: 'pharmacy_request.dispensed',
                entityType: 'pharmacy_request', entityId: dispensingRequest.id,
                patientId: dispensingRequest.patient_id,
                summary: `Dispensed pharmacy request for ${dispensingRequest.patient_name || 'patient'}${chargeAmount > 0 ? ` — charged ${formatMoney(chargeAmount)}` : ''}`,
                metadata: { request_id: dispensingRequest.id, dispensed_items: dispensedItems, dispensed_notes: dispensedNotes, charge_amount: chargeAmount },
              })
              showToast(`Request dispensed for ${dispensingRequest.patient_name || 'patient'}`)
              setShowRequestDispenseModal(false)
              setDispensingRequest(null)
            } catch (err) {
              showToast(err.message || 'Could not save dispense record')
            }
          }}
          onClose={() => { setShowRequestDispenseModal(false); setDispensingRequest(null) }}
        />
      )}

      {toast && <div className="dash-toast dash-toast-success">{toast}</div>}
    </>
  )
}

// =====================================================================
// SalesHistory — paginated list of pharmacy_sales
// =====================================================================
function SalesHistory({ hospital, timezone, refreshKey }) {
  const { records: sales, loading } = useOfflineTable('pharmacy_sales', hospital?.id)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')

  const filtered = useMemo(() => {
    let arr = [...sales].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    if (typeFilter !== 'all') arr = arr.filter(s => s.sale_type === typeFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      arr = arr.filter(s =>
        String(s.sale_number || '').toLowerCase().includes(q) ||
        String(s.customer_name || '').toLowerCase().includes(q) ||
        String(s.payment_method || '').toLowerCase().includes(q)
      )
    }
    return arr
  }, [sales, typeFilter, search, refreshKey])

  const todayStr = new Date().toDateString()
  const todaySales = filtered.filter(s => new Date(s.created_at).toDateString() === todayStr)
  const todayRevenue = todaySales.reduce((sum, s) => sum + Number(s.total || 0), 0)

  const {
    pageItems: pagedSales, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(filtered, { pageSize: 15, resetKey: `${search}|${typeFilter}|${refreshKey}` })

  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <>
      {/* Mini stats */}
      <div className="dash-stats glass-scope" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}><AppIcon name="billing" size={18} /></div>
          <div><div className="dash-stat-label">Today's Sales</div><div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(todayRevenue)}</div><div className="dash-stat-delta">{todaySales.length} sale(s)</div></div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}><AppIcon name="users" size={18} /></div>
          <div><div className="dash-stat-label">Total Sales</div><div className="dash-stat-value" style={{ fontSize: 16 }}>{filtered.length}</div></div>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div><div className="dash-panel-title">Pharmacy Sales History</div><div className="dash-panel-sub">Walk-in sales and prescription dispensing records</div></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}>
              <option value="all">All types</option>
              <option value="walk_in">Walk-in</option>
              <option value="prescription">Prescription</option>
            </select>
            <SearchInput value={search} onChange={setSearch} placeholder="Search sale #, customer…" style={{ minWidth: 200, maxWidth: 320 }} />
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>Loading sales…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>No sales recorded yet. Click "Walk-in Sale" to make your first sale.</div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead><tr><th>Sale #</th><th>Date / Time</th><th>Customer</th><th>Type</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Staff</th></tr></thead>
                <tbody>
                  {pagedSales.map(s => (
                    <tr key={s.id} style={{ borderTop: '1px solid var(--line-soft)' }}>
                      <td style={{ padding: 12, fontWeight: 700, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{s.sale_number || '—'}</td>
                      <td style={{ padding: 12, fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.created_at ? formatDateTime(s.created_at, timezone) : '—'}</td>
                      <td style={{ padding: 12, fontWeight: 700 }}>{s.customer_name || '—'}</td>
                      <td style={{ padding: 12 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: s.sale_type === 'walk_in' ? 'rgba(0,199,199,0.14)' : 'rgba(118,87,232,0.14)', color: s.sale_type === 'walk_in' ? 'var(--teal)' : 'var(--violet)', textTransform: 'uppercase' }}>
                          {s.sale_type === 'walk_in' ? 'Walk-in' : 'Rx'}
                        </span>
                      </td>
                      <td style={{ padding: 12, fontSize: 12.5 }}>{Array.isArray(s.items) ? s.items.length : 0} item(s)</td>
                      <td style={{ padding: 12, fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--teal)' }}>{formatMoney(s.total)}</td>
                      <td style={{ padding: 12, fontSize: 11.5, color: 'var(--muted)' }}>{s.payment_method || '—'}</td>
                      <td style={{ padding: 12 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: s.status === 'completed' ? 'rgba(24,217,155,0.14)' : s.status === 'refunded' ? 'rgba(240,79,95,0.14)' : 'rgba(154,170,183,0.14)', color: s.status === 'completed' ? 'var(--mint)' : s.status === 'refunded' ? 'var(--danger)' : 'var(--muted)', textTransform: 'uppercase' }}>
                          {s.status}
                        </span>
                      </td>
                      <td style={{ padding: 12, fontSize: 11.5, color: 'var(--muted)' }}>{s.dispensed_by_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={currentPage} totalPages={totalPages} totalItems={totalItems}
              startIndex={startIndex} endIndex={endIndex} pageSize={pageSize}
              onPageChange={setCurrentPage} onPageSizeChange={setPageSize}
              itemLabel="sales"
            />
          </>
        )}
      </div>
    </>
  )
}

// =====================================================================
// PharmacyRequestsTab — shows all pharmacy_requests (pending + dispensed)
// Staff send free-text med requests from PatientProfile → they appear here
// as plain text with patient name, staff name, time, date, priority.
// Pharmacist can dispense (catalog + notes) or clear after dispensing.
// =====================================================================
function PharmacyRequestsTab({ pharmRequests, updatePharmRequest, hospital, profile, timezone, showToast, onDispense }) {
  const [filter, setFilter] = useState('pending')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    let arr = (pharmRequests || []).filter(r => {
      if (filter === 'pending') return r.status === 'pending'
      if (filter === 'dispensed') return r.status === 'dispensed'
      return true
    })
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(r =>
        (r.request_text || '').toLowerCase().includes(q) ||
        (r.patient_name || '').toLowerCase().includes(q) ||
        (r.requested_by_name || '').toLowerCase().includes(q)
      )
    }
    return arr.sort((a, b) => {
      // STAT first, then urgent, then routine; within same priority, newest first
      const pOrder = { stat: 0, urgent: 1, routine: 2 }
      const pa = pOrder[a.priority] ?? 2
      const pb = pOrder[b.priority] ?? 2
      if (pa !== pb) return pa - pb
      return new Date(b.created_at) - new Date(a.created_at)
    })
  }, [pharmRequests, filter, search])

  const pendingCount = (pharmRequests || []).filter(r => r.status === 'pending').length
  const dispensedCount = (pharmRequests || []).filter(r => r.status === 'dispensed').length

  async function handleClear(req) {
    if (!confirm(`Clear this request?\n\n"${req.request_text}"\n\nThis marks it as dispensed without recording dispensed items.`)) return
    try {
      await updatePharmRequest(req.id, {
        status: 'dispensed',
        dispensed_at: new Date().toISOString(),
        dispensed_by: profile?.id || null,
        dispensed_by_name: profile?.full_name || null,
        dispensed_notes: 'Cleared without documentation',
      })
      showToast('Request cleared')
    } catch (err) {
      showToast(err.message || 'Could not clear request')
    }
  }

  async function handleCancel(req) {
    if (!confirm(`Cancel this request?\n\n"${req.request_text}"`)) return
    try {
      await updatePharmRequest(req.id, { status: 'cancelled' })
      showToast('Request cancelled')
    } catch (err) {
      showToast(err.message || 'Could not cancel request')
    }
  }

  const priorityColor = { routine: 'var(--teal)', urgent: 'var(--gold)', stat: 'var(--danger)' }
  const priorityBg = { routine: 'rgba(0,199,199,0.14)', urgent: 'rgba(232,184,46,0.14)', stat: 'rgba(240,79,95,0.14)' }

  return (
    <div className="dash-panel">
      <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="dash-panel-title">Pharmacy Requests</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
            Free-text medication requests from staff. Each shows patient, requester, time, and priority.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={filter} onChange={e => setFilter(e.target.value)} style={{ padding: '7px 10px', fontSize: 12, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)' }}>
            <option value="pending">Pending ({pendingCount})</option>
            <option value="dispensed">Dispensed ({dispensedCount})</option>
            <option value="all">All</option>
          </select>
          <div className="dash-search" style={{ maxWidth: 220 }}>
            <input placeholder="Search request, patient, staff…" value={search} onChange={e => setSearch(e.target.value)} style={{ fontSize: 12 }} />
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
          {filter === 'pending' ? 'No pending pharmacy requests. When staff send a request from a patient profile, it will appear here.' : 'No requests match these filters.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
          {filtered.map(r => (
            <div key={r.id} style={{
              padding: '14px 16px', borderRadius: 12,
              background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)',
              opacity: r.status === 'dispensed' ? 0.7 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  {/* The request text — shown prominently as plain text */}
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ivory)', lineHeight: 1.5, marginBottom: 8 }}>
                    "{r.request_text}"
                  </div>
                  {/* Patient + requester + time */}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--muted)' }}>
                    <span>👤 <strong style={{ color: 'var(--teal)' }}>{r.patient_name || '—'}</strong></span>
                    <span>✏️ {r.requested_by_name || 'Unknown staff'}</span>
                    <span>🕒 {formatDateTime(r.created_at, timezone)}</span>
                    <span style={{
                      padding: '2px 8px', borderRadius: 10, fontWeight: 700,
                      background: priorityBg[r.priority] || priorityBg.routine,
                      color: priorityColor[r.priority] || priorityColor.routine,
                      textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10,
                    }}>
                      {r.priority || 'routine'}
                    </span>
                  </div>
                  {/* Dispense documentation (if dispensed) */}
                  {r.status === 'dispensed' && r.dispensed_notes && (
                    <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(24,217,155,0.06)', border: '1px solid rgba(24,217,155,0.15)', fontSize: 12.5, color: 'var(--success)' }}>
                      <strong>Dispensed:</strong> {r.dispensed_notes}
                      {r.dispensed_by_name && <span style={{ color: 'var(--muted)', marginLeft: 8 }}>by {r.dispensed_by_name} · {formatDateTime(r.dispensed_at, timezone)}</span>}
                    </div>
                  )}
                </div>
                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {r.status === 'pending' && (
                    <>
                      <button
                        className="btn btn-primary"
                        style={{ width: 'auto', padding: '6px 14px', fontSize: 11.5 }}
                        onClick={() => onDispense(r)}
                      >
                        Dispense
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ width: 'auto', padding: '6px 10px', fontSize: 11.5, color: 'var(--success)', borderColor: 'var(--success)' }}
                        onClick={() => handleClear(r)}
                        title="Mark as dispensed without recording items"
                      >
                        Clear
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ width: 'auto', padding: '6px 10px', fontSize: 11.5, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                        onClick={() => handleCancel(r)}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {r.status === 'dispensed' && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 10, background: 'rgba(24,217,155,0.14)', color: 'var(--success)', textTransform: 'uppercase' }}>
                      ✓ Dispensed
                    </span>
                  )}
                  {r.status === 'cancelled' && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 10, background: 'rgba(154,170,183,0.14)', color: 'var(--muted)', textTransform: 'uppercase' }}>
                      Cancelled
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// =====================================================================
// PharmacyRequestDispenseModal — pharmacist documents what they dispensed
// Shows the original request, lets pharmacist enter:
//   - Free-text dispense notes (what was actually given)
//   - Optional charge amount (creates a billable_charge for the patient)
// On submit: updates the request status to 'dispensed' + saves documentation
// =====================================================================
function PharmacyRequestDispenseModal({ request, hospital, profile, timezone, onDispense, onClose }) {
  const [dispensedNotes, setDispensedNotes] = useState('')
  const [chargeAmount, setChargeAmount] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!dispensedNotes.trim()) return
    setSaving(true)
    try {
      await onDispense({
        dispensedItems: [],
        dispensedNotes: dispensedNotes.trim(),
        chargeAmount: Number(chargeAmount) || 0,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
          <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Dispense & Document</div>
          <button className="dash-icon-btn" onClick={onClose} aria-label="Close"><AppIcon name="close" size={18} /></button>
        </div>
        <div className="dash-modal-body">
          {/* Original request — shown for reference */}
          <div style={{ padding: 12, borderRadius: 10, background: 'rgba(0,199,199,0.06)', border: '1px solid var(--teal-border)', marginBottom: 16 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Original Request</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ivory)', lineHeight: 1.5 }}>"{request.request_text}"</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap' }}>
              <span>👤 {request.patient_name || '—'}</span>
              <span>✏️ {request.requested_by_name || '—'}</span>
              <span>🕒 {formatDateTime(request.created_at, timezone)}</span>
              <span style={{ color: request.priority === 'stat' ? 'var(--danger)' : request.priority === 'urgent' ? 'var(--gold)' : 'var(--teal)', fontWeight: 700 }}>
                {request.priority?.toUpperCase()}
              </span>
            </div>
          </div>

          <form id="dispense-form" onSubmit={handleSubmit}>
            <div className="field">
              <label>What was dispensed *</label>
              <textarea
                rows={3}
                value={dispensedNotes}
                onChange={e => setDispensedNotes(e.target.value)}
                placeholder="e.g. Gave 14 tabs metronidazole 200mg + 6 tabs paracetamol 500mg"
                autoFocus
                required
                style={{ width: '100%', padding: '10px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', resize: 'vertical' }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                Document exactly what was given to the patient. This is the dispense record.
              </div>
            </div>
            <div className="field">
              <label>Charge amount (₦) — optional</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={chargeAmount}
                onChange={e => setChargeAmount(e.target.value)}
                placeholder="e.g. 2500 — leave blank if no charge"
                style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                If entered, a billable charge is created for {request.patient_name || 'the patient'} and appears in the Billing queue.
              </div>
            </div>
          </form>
        </div>
        <div className="dash-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="dispense-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Mark as Dispensed'}</button>
        </div>
      </div>
    </div>
  )
}
