import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useOfflineTable } from '../../lib/useOfflineTable'
import { useRealtimeAlert } from '../../lib/useRealtimeAlert'
import { supabase } from '../../lib/supabaseClient'
import CashierWorkspace from '../../components/CashierWorkspace'
import InvoiceViewer from '../../components/InvoiceViewer'
import PatientAutocomplete from '../../components/common/PatientAutocomplete'
import ModuleHistoryButton from '../../components/ModuleHistoryButton'
import CreditNoteModal from '../../components/CreditNoteModal'
import MultiInvoicePaymentModal from '../../components/MultiInvoicePaymentModal'
import ApprovalQueueModal from '../../components/ApprovalQueueModal'
import EndOfDayReconciliationModal from '../../components/EndOfDayReconciliationModal'
import { usePagination } from '../../lib/usePagination'
import Pagination from '../../components/common/Pagination'
import SearchInput from '../../components/common/SearchInput'
import AppIcon from '../../components/icons'
import { writeAudit } from '../../lib/audit'
import { formatDateTimeSec, getTimezone } from '../../lib/datetime'
import {
  finalizeDraftInvoice,
  cancelDraftInvoice,
  writeOffInvoice,
  createCreditNote,
  DRAFT_STATUSES,
  CREDIT_NOTE_REASONS,
} from '../../lib/billingService'
import { nextDocumentNumber } from '../../lib/billingService'

function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
  const paths = {
    billing: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
    users: <><circle cx="9" cy="8" r="3.5" /><path d="M2 20c0-3.6 3-6.5 7-6.5s7 2.9 7 6.5" /><path d="M16 5.5a3.2 3.2 0 0 1 0 6.2M18 14c2.4.8 4 2.9 4 6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    arrowUp: <path d="m6 15 6-6 6 6" />,
    arrowRight: <path d="m9 18 6-6-6-6" />,
  }
  return <svg {...common}>{paths[name] || paths.billing}</svg>
}

const SPARK = "M2 27 C12 22 15 10 25 18 S38 29 48 16 S61 8 70 22 S80 24 88 11"

export default function Billing({ initialSearch = '' }) {
  const { profile, hospital } = useAuth()
  const timezone = getTimezone(hospital)
  const { records: invoices, updateRecord: updateInvoice, loading, isOnline, pendingCount } = useOfflineTable('invoices', hospital?.id)
  const { records: billableCharges, syncFromServer: syncCharges } = useOfflineTable('billable_charges', hospital?.id)
  // Wallet transactions — for the Transactions tab + wallet credit on reversal
  const { records: walletTxns, addRecord: addWalletTxn, loading: txnsLoading } = useOfflineTable('patient_wallet_transactions', hospital?.id)
  // Payments — for the Payments tab
  const { records: payments, updateRecord: updatePayment } = useOfflineTable('payments', hospital?.id)
  // Patient wallets — needed for wallet credit on reversal
  const { records: walletRecords } = useOfflineTable('patient_wallets', hospital?.id)
  // Patients — needed to resolve patient names for wallet txns + payments
  // AND for the "Create Invoice" patient picker
  const { records: patients, loading: patientsLoading } = useOfflineTable('patients', hospital?.id)
  // Staff — to resolve "received_by" and "reversed_by" names
  const { records: staff } = useOfflineTable('profiles', hospital?.id)
  // ---- Hospital expenses (Expenses tab) -----------------------------
  // Admin + owner + billing can record expenses. Everyone else with
  // access to Billing can view them.
  const { records: expenses, addRecord: addExpense, updateRecord: updateExpense, deleteRecord: deleteExpense } = useOfflineTable('hospital_expenses', hospital?.id)

  // ---- Credit notes (Credit Notes tab — Phase 2) -------------------
  // Each credit note references an original invoice + records the
  // reason and refund method. Posted credit notes reduce the invoice
  // balance or trigger a cash/wallet refund.
  const { records: creditNotes, addRecord: addCreditNote, updateRecord: updateCreditNote } = useOfflineTable('credit_notes', hospital?.id)
  const { addRecord: addAllocation } = useOfflineTable('payment_allocations', hospital?.id)

  // ---- Phase 2 modal state -----------------------------------------
  const [showCreditNoteModal, setShowCreditNoteModal] = useState(false)
  const [creditNoteInvoice, setCreditNoteInvoice] = useState(null)  // the invoice being credited
  const [showMultiPayModal, setShowMultiPayModal] = useState(false)
  const [multiPayPatient, setMultiPayPatient] = useState(null)
  const [showApprovals, setShowApprovals] = useState(false)
  const [showEndOfDay, setShowEndOfDay] = useState(false)
  const [cnSearch, setCnSearch] = useState('')  // credit notes tab search

  const [toast, setToast] = useState(null)
  const [search, setSearch] = useState(initialSearch)
  useEffect(() => { if (initialSearch) setSearch(initialSearch) }, [initialSearch])
  const [selectedPatient, setSelectedPatient] = useState(null)
  // ---- "Create Invoice" picker ---------------------------------------
  // Lets the cashier open the CashierWorkspace for ANY registered
  // patient (one with a personal folder at the hospital), even if no
  // other module has produced a billable charge yet. They can then add
  // manual charges (consultation, procedure, etc.) directly.
  const [showCreateInvoice, setShowCreateInvoice] = useState(false)

  const [activeTab, setActiveTab] = useState('queue')  // 'queue' | 'unpaid' | 'drafts' | 'transactions' | 'payments' | 'expenses' | 'credit_notes'
  const [unpaidSearch, setUnpaidSearch] = useState('')
  // ---- "View Invoice" modal (lets the cashier reopen an unpaid invoice to
  // take a payment on it). This is the FIX for the bug where clicking
  // "Generate Invoice" by mistake — without entering an amount — leaves the
  // invoice stuck in 'unpaid' state with no obvious way to access it.
  // Now the cashier can find it on the Unpaid tab and click "Take Payment"
  // to reopen the InvoiceViewer (which has the Record Payment form).
  const [viewInvoice, setViewInvoice] = useState(null)
  const [txnTypeFilter, setTxnTypeFilter] = useState('all')  // 'all' | 'deposit' | 'charge' | 'refund' | 'adjustment'
  const [txnSearch, setTxnSearch] = useState('')
  const [payMethodFilter, setPayMethodFilter] = useState('all')
  const [paySearch, setPaySearch] = useState('')
  const [payStatusFilter, setPayStatusFilter] = useState('active')  // 'active' | 'reversed' | 'all'

  // ---- Expense tab state -------------------------------------------
  const canManageExpenses = profile && ['admin', 'owner', 'billing'].includes(profile.role)
  const [showExpenseModal, setShowExpenseModal] = useState(false)
  const [expenseCategoryFilter, setExpenseCategoryFilter] = useState('all')
  const [expenseSearch, setExpenseSearch] = useState('')
  const [expenseDateFrom, setExpenseDateFrom] = useState('')
  const [expenseDateTo, setExpenseDateTo] = useState('')
  const [editingExpenseId, setEditingExpenseId] = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }
  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  // Live alert — the instant Pharmacy, Lab, or any module sends a new
  // charge, the cashier sees it immediately without refreshing.
  useRealtimeAlert('billable_charges', hospital?.id, (newRow) => {
    showToast(`New ${newRow.category || 'charge'} added for ${newRow.patient_name || 'a patient'} (${formatMoney(newRow.total)})`)
    syncCharges()
  })

  const kpis = useMemo(() => {
    const tStr = new Date().toDateString()
    const tRev = invoices.filter(i => new Date(i.created_at).toDateString() === tStr).reduce((s, i) => s + Number(i.amount_paid || 0), 0)
    const out = invoices.filter(i => i.status !== 'paid' && i.status !== 'cancelled').reduce((s, i) => s + Number(i.balance || 0), 0)

    const pendingCharges = billableCharges.filter(c => c.status === 'pending')
    const pendingTotal = pendingCharges.reduce((s, c) => s + Number(c.total || 0), 0)

    return { tRev, out, pendingTotal, pendingCount: pendingCharges.length }
  }, [invoices, billableCharges])

  const patientQueue = useMemo(() => {
    const pendingCharges = billableCharges.filter(c => c.status === 'pending')
    const queue = {}

    pendingCharges.forEach(c => {
      if (!queue[c.patient_id]) {
        queue[c.patient_id] = { id: c.patient_id, name: c.patient_name, items: 0, total: 0 }
      }
      queue[c.patient_id].items += 1
      queue[c.patient_id].total += Number(c.total || 0)
    })

    let queueArr = Object.values(queue).sort((a, b) => b.total - a.total)

    if (search.trim()) {
      queueArr = queueArr.filter(p => String(p.name || '').toLowerCase().includes(search.toLowerCase()))
    }

    return queueArr
  }, [billableCharges, search])

  // Global Pagination Rule — the patient billing queue can grow past a
  // screenful during busy periods (many patients with pending charges
  // waiting for cashier review at once), so only the current page's
  // rows are rendered into the table. Page size 10 to match Insurance,
  // the other billing-adjacent module.
  const {
    pageItems: pagedQueue, currentPage, setCurrentPage, pageSize, setPageSize,
    totalPages, totalItems, startIndex, endIndex,
  } = usePagination(patientQueue, { pageSize: 10, resetKey: search })

  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()

  // ---- Unpaid invoices (the FIX for the "stuck awaiting bill" bug) ----------
  // Any finalized invoice with a balance > 0 — including ones created by
  // mistake (cashier clicked Generate Invoice without entering an amount).
  // The cashier can find them on the Unpaid tab, click "Take Payment",
  // and reopen the InvoiceViewer to record a payment against the balance.
  const unpaidInvoicesList = useMemo(() => {
    const list = invoices
      .filter(i =>
        i.draft_status !== 'draft' &&
        i.status !== 'cancelled' &&
        i.status !== 'paid' &&
        Number(i.balance || 0) > 0.001
      )
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    if (!unpaidSearch.trim()) return list
    const q = unpaidSearch.trim().toLowerCase()
    return list.filter(i =>
      String(i.invoice_number || '').toLowerCase().includes(q) ||
      String(i.patient_name || '').toLowerCase().includes(q) ||
      String(i.payment_method || '').toLowerCase().includes(q)
    )
  }, [invoices, unpaidSearch])

  // ---- Unpaid invoices pagination --------------------------------------
  const {
    pageItems: pagedUnpaid, currentPage: unpaidPage, setCurrentPage: setUnpaidPage, pageSize: unpaidPageSize, setPageSize: setUnpaidPageSize,
    totalPages: unpaidTotalPages, totalItems: unpaidTotalItems, startIndex: unpaidStart, endIndex: unpaidEnd,
  } = usePagination(unpaidInvoicesList, { pageSize: 15, resetKey: unpaidSearch })

  // ---- Wallet transactions filter + pagination ----------------------
  const filteredTxns = useMemo(() => {
    let arr = [...walletTxns].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    if (txnTypeFilter !== 'all') {
      arr = arr.filter(t => t.type === txnTypeFilter)
    }
    if (txnSearch.trim()) {
      const q = txnSearch.trim().toLowerCase()
      arr = arr.filter(t => {
        const pName = patients.find(p => p.id === t.patient_id)?.full_name || t.performed_by_name || ''
        return (
          String(t.patient_id || '').toLowerCase().includes(q) ||
          pName.toLowerCase().includes(q) ||
          String(t.reference || '').toLowerCase().includes(q) ||
          String(t.notes || '').toLowerCase().includes(q) ||
          String(t.method || '').toLowerCase().includes(q)
        )
      })
    }
    return arr
  }, [walletTxns, txnTypeFilter, txnSearch, patients])

  const txnStats = useMemo(() => {
    const todayStr = new Date().toDateString()
    const today = walletTxns.filter(t => new Date(t.created_at).toDateString() === todayStr)
    const depositsToday = today.filter(t => t.type === 'deposit').reduce((s, t) => s + Number(t.amount || 0), 0)
    const chargesToday = today.filter(t => t.type === 'charge').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
    const refundsToday = today.filter(t => t.type === 'refund').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
    return { depositsToday, chargesToday, refundsToday, totalToday: walletTxns.length }
  }, [walletTxns])

  const {
    pageItems: pagedTxns, currentPage: txnPage, setCurrentPage: setTxnPage, pageSize: txnPageSize, setPageSize: setTxnPageSize,
    totalPages: txnTotalPages, totalItems: txnTotalItems, startIndex: txnStart, endIndex: txnEnd,
  } = usePagination(filteredTxns, { pageSize: 20, resetKey: `${txnTypeFilter}|${txnSearch}` })

  // ---- Payments filter + pagination -----------------------------------
  const filteredPayments = useMemo(() => {
    let arr = [...payments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    // Status filter
    if (payStatusFilter === 'active') {
      arr = arr.filter(p => p.status !== 'reversed')
    } else if (payStatusFilter === 'reversed') {
      arr = arr.filter(p => p.status === 'reversed')
    }
    // Method filter
    if (payMethodFilter !== 'all') {
      arr = arr.filter(p => (p.method || 'Cash') === payMethodFilter)
    }
    // Search
    if (paySearch.trim()) {
      const q = paySearch.trim().toLowerCase()
      arr = arr.filter(p => {
        const pName = patients.find(pt => pt.id === p.patient_id)?.full_name || p.patient_name || ''
        const inv = invoices.find(i => i.id === p.invoice_id)
        return (
          pName.toLowerCase().includes(q) ||
          String(p.reference_number || '').toLowerCase().includes(q) ||
          String(p.method || '').toLowerCase().includes(q) ||
          (inv?.invoice_number || '').toLowerCase().includes(q)
        )
      })
    }
    return arr
  }, [payments, payStatusFilter, payMethodFilter, paySearch, patients, invoices])

  const payStats = useMemo(() => {
    const active = payments.filter(p => p.status !== 'reversed')
    const reversed = payments.filter(p => p.status === 'reversed')
    const todayStr = new Date().toDateString()
    const todayActive = active.filter(p => new Date(p.created_at).toDateString() === todayStr)
    const todayTotal = todayActive.reduce((s, p) => s + Number(p.amount || 0), 0)
    return {
      activeCount: active.length,
      reversedCount: reversed.length,
      todayCount: todayActive.length,
      todayTotal,
    }
  }, [payments])

  const {
    pageItems: pagedPayments, currentPage: payPage, setCurrentPage: setPayPage, pageSize: payPageSize, setPageSize: setPayPageSize,
    totalPages: payTotalPages, totalItems: payTotalItems, startIndex: payStart, endIndex: payEnd,
  } = usePagination(filteredPayments, { pageSize: 20, resetKey: `${payStatusFilter}|${payMethodFilter}|${paySearch}` })

  // ---- Expenses filter + pagination ---------------------------------
  const EXPENSE_CATEGORIES = [
    'Salaries & Wages', 'Rent', 'Utilities', 'Medical Supplies', 'Office Supplies',
    'Equipment Purchase', 'Equipment Maintenance', 'Cleaning & Hygiene',
    'Transport / Fuel', 'Bank Charges', 'Marketing', 'Miscellaneous',
  ]
  const EXPENSE_METHODS = ['Cash', 'Bank Transfer', 'POS', 'Cheque', 'Other']

  const filteredExpenses = useMemo(() => {
    let arr = [...expenses].sort((a, b) => new Date(b.paid_at || b.created_at) - new Date(a.paid_at || a.created_at))
    if (expenseCategoryFilter !== 'all') {
      arr = arr.filter(e => e.category === expenseCategoryFilter)
    }
    if (expenseDateFrom) {
      arr = arr.filter(e => e.paid_at && new Date(e.paid_at) >= new Date(expenseDateFrom))
    }
    if (expenseDateTo) {
      const end = new Date(expenseDateTo); end.setHours(23, 59, 59, 999)
      arr = arr.filter(e => e.paid_at && new Date(e.paid_at) <= end)
    }
    if (expenseSearch.trim()) {
      const q = expenseSearch.trim().toLowerCase()
      arr = arr.filter(e =>
        (e.description || '').toLowerCase().includes(q) ||
        (e.category || '').toLowerCase().includes(q) ||
        (e.reference_number || '').toLowerCase().includes(q) ||
        (e.recorded_by_name || '').toLowerCase().includes(q)
      )
    }
    return arr
  }, [expenses, expenseCategoryFilter, expenseDateFrom, expenseDateTo, expenseSearch])

  const expenseStats = useMemo(() => {
    const todayStr = new Date().toDateString()
    const today = expenses.filter(e => new Date(e.paid_at || e.created_at).toDateString() === todayStr)
    const todayTotal = today.reduce((s, e) => s + Number(e.amount || 0), 0)
    // This week (last 7 days)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const weekTotal = expenses
      .filter(e => new Date(e.paid_at || e.created_at).getTime() >= weekAgo)
      .reduce((s, e) => s + Number(e.amount || 0), 0)
    // This month
    const now = new Date()
    const monthTotal = expenses
      .filter(e => {
        const d = new Date(e.paid_at || e.created_at)
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      })
      .reduce((s, e) => s + Number(e.amount || 0), 0)
    // By category breakdown (this month)
    const byCategory = {}
    expenses.forEach(e => {
      const d = new Date(e.paid_at || e.created_at)
      if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0)
      }
    })
    return { todayCount: today.length, todayTotal, weekTotal, monthTotal, byCategory }
  }, [expenses])

  const {
    pageItems: pagedExpenses, currentPage: expPage, setCurrentPage: setExpPage, pageSize: expPageSize, setPageSize: setExpPageSize,
    totalPages: expTotalPages, totalItems: expTotalItems, startIndex: expStart, endIndex: expEnd,
  } = usePagination(filteredExpenses, { pageSize: 20, resetKey: `${expenseCategoryFilter}|${expenseSearch}|${expenseDateFrom}|${expenseDateTo}` })

  // ---- Expense form state (used by the modal) -----------------------
  const [expCategory, setExpCategory] = useState(EXPENSE_CATEGORIES[0])
  const [expDescription, setExpDescription] = useState('')
  const [expAmount, setExpAmount] = useState('')
  const [expMethod, setExpMethod] = useState('Cash')
  const [expReference, setExpReference] = useState('')
  const [expPaidAt, setExpPaidAt] = useState('')
  const [expSaving, setExpSaving] = useState(false)
  const [expError, setExpError] = useState('')

  function resetExpenseForm() {
    setEditingExpenseId(null)
    setExpCategory(EXPENSE_CATEGORIES[0])
    setExpDescription('')
    setExpAmount('')
    setExpMethod('Cash')
    setExpReference('')
    setExpPaidAt('')
    setExpError('')
  }

  function openExpenseModal(expense = null) {
    if (expense) {
      setEditingExpenseId(expense.id)
      setExpCategory(expense.category || EXPENSE_CATEGORIES[0])
      setExpDescription(expense.description || '')
      setExpAmount(String(expense.amount || ''))
      setExpMethod(expense.payment_method || 'Cash')
      setExpReference(expense.reference_number || '')
      // Format paid_at to yyyy-MM-dd for the date input
      try {
        const d = new Date(expense.paid_at || expense.created_at)
        if (!isNaN(d.getTime())) {
          const yyyy = d.getFullYear()
          const mm = String(d.getMonth() + 1).padStart(2, '0')
          const dd = String(d.getDate()).padStart(2, '0')
          setExpPaidAt(`${yyyy}-${mm}-${dd}`)
        }
      } catch { setExpPaidAt('') }
    } else {
      resetExpenseForm()
    }
    setShowExpenseModal(true)
  }

  async function handleSaveExpense(e) {
    e?.preventDefault?.()
    setExpError('')
    const amount = parseFloat(expAmount)
    if (isNaN(amount) || amount <= 0) { setExpError('Enter a valid amount (greater than 0).'); return }
    if (!expDescription.trim()) { setExpError('Description is required.'); return }
    setExpSaving(true)
    try {
      const paidAtIso = expPaidAt ? new Date(expPaidAt + 'T12:00:00').toISOString() : new Date().toISOString()
      const payload = {
        hospital_id: hospital.id,
        category: expCategory,
        description: expDescription.trim(),
        amount,
        payment_method: expMethod,
        reference_number: expReference.trim() || null,
        paid_at: paidAtIso,
        recorded_by: profile?.id || null,
        recorded_by_name: profile?.full_name || null,
      }
      let saved
      if (editingExpenseId) {
        saved = await updateExpense(editingExpenseId, payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hospital_expense.updated',
          entityType: 'hospital_expense', entityId: editingExpenseId,
          summary: `Updated expense "${expDescription.trim()}" (${expCategory}) — ${formatMoney(amount)} (${expMethod})`,
          metadata: { ...payload, expense_id: editingExpenseId },
        })
        showToast(`Expense updated`)
      } else {
        saved = await addExpense(payload)
        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'hospital_expense.created',
          entityType: 'hospital_expense', entityId: saved?.id || null,
          summary: `Recorded expense "${expDescription.trim()}" (${expCategory}) — ${formatMoney(amount)} (${expMethod})`,
          metadata: { ...payload, expense_id: saved?.id || null },
        })
        showToast(`Expense of ${formatMoney(amount)} recorded`)
      }
      setShowExpenseModal(false)
      resetExpenseForm()
    } catch (err) {
      setExpError(err.message || 'Could not save the expense.')
    } finally {
      setExpSaving(false)
    }
  }

  async function handleDeleteExpense(expense) {
    if (!confirm(`Delete this expense?\n\n${expense.description} (${expense.category})\n${formatMoney(expense.amount)}\n\nThis cannot be undone.`)) return
    try {
      await deleteExpense(expense.id)
      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'hospital_expense.deleted',
        entityType: 'hospital_expense', entityId: expense.id,
        summary: `Deleted expense "${expense.description}" (${expense.category}) — ${formatMoney(expense.amount)}`,
        metadata: { expense_id: expense.id, category: expense.category, amount: expense.amount },
      })
      showToast(`Expense deleted`)
    } catch (err) {
      showToast(err.message || 'Could not delete the expense.')
    }
  }

  // ---- Reverse a payment ----------------------------------------------
  // Q1=a: void the payment (status = 'reversed'), keep the row for audit.
  // Q2=b: any billing-role user (billing + admin + owner) can reverse.
  // Q4=a: if the payment was from the wallet, credit the wallet back.
  // Q5=a: require a reason.
  async function handleReversePayment(payment) {
    const canReverse = profile && ['admin', 'owner', 'billing'].includes(profile.role)
    if (!canReverse) {
      showToast('Your role cannot reverse payments.')
      return
    }

    // Resolve names for the confirmation dialog
    const patientName = patients.find(p => p.id === payment.patient_id)?.full_name || payment.patient_name || 'patient'
    const inv = invoices.find(i => i.id === payment.invoice_id)

    const reason = prompt(
      `Reverse this payment?\n\n` +
      `Patient: ${patientName}\n` +
      `Amount: ${formatMoney(payment.amount)}\n` +
      `Method: ${payment.method || 'Cash'}\n` +
      `Reference: ${payment.reference_number || '—'}\n` +
      (inv ? `Invoice: ${inv.invoice_number || '—'}\n` : '') +
      `\nThis will mark the payment as reversed and adjust the invoice.\n` +
      `The payment record is kept for audit — it is NOT deleted.\n\n` +
      `Enter a reason (required):`
    )
    if (!reason || !reason.trim()) return

    try {
      // 1. Void the payment
      await updatePayment(payment.id, {
        status: 'reversed',
        reversed_by: profile.id,
        reversed_by_name: profile.full_name,
        reversed_at: new Date().toISOString(),
        reversal_reason: reason.trim(),
      })

      // 2. Adjust the invoice: amount_paid -= payment.amount, balance += payment.amount
      if (inv) {
        const newPaid = Math.max(0, Number(inv.amount_paid || 0) - Number(payment.amount || 0))
        const newBal = Math.max(0, Number(inv.grand_total || inv.amount || 0) - newPaid)
        const newStatus = newBal <= 0.001 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid')
        await updateInvoice(inv.id, {
          amount_paid: newPaid,
          balance: newBal,
          status: newStatus,
        })

        // 3. If the payment was from the wallet, credit the wallet back (Q4=a)
        if (payment.method === 'Wallet') {
          const wallet = walletRecords.find(w => w.patient_id === payment.patient_id)
          if (wallet) {
            const newWalletBalance = Number(wallet.balance || 0) + Number(payment.amount || 0)
            await addWalletTxn({
              hospital_id: hospital.id,
              patient_id: payment.patient_id,
              wallet_id: wallet.id,
              type: 'adjustment',
              amount: Number(payment.amount || 0),
              balance_after: newWalletBalance,
              method: 'Wallet',
              invoice_id: inv.id,
              performed_by: profile.id,
              performed_by_name: profile.full_name,
              notes: `Reversal of wallet payment — ${reason.trim()}`,
            })
          }
        }
      }

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'payment.reversed',
        entityType: 'payment', entityId: payment.id,
        patientId: payment.patient_id || null,
        summary: `Reversed payment of ${formatMoney(payment.amount)} (${payment.method || 'Cash'}) for ${patientName} — reason: ${reason.trim()}`,
        metadata: {
          payment_id: payment.id,
          invoice_id: inv?.id || null,
          amount: payment.amount,
          method: payment.method,
          reason: reason.trim(),
        },
      })

      showToast(`Payment of ${formatMoney(payment.amount)} reversed for ${patientName}`)
    } catch (err) {
      showToast(err.message || 'Could not reverse the payment.')
    }
  }

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div className="billing-header-badge"><Icon name="billing" size={21} /></div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-display)' }}>Cashier Dashboard</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className={`billing-live-dot ${isOnline ? '' : 'offline'}`} />
            {isOnline ? 'System Online' : 'Offline Mode'}{pendingCount > 0 ? ` · ${pendingCount} syncing` : ''}
          </div>
        </div>
      </div>

      {/* ---- Tab switcher: Queue / Drafts / Wallet Transactions / Payments / Expenses / Credit Notes ---- */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { key: 'queue', label: 'Patient Queue', icon: 'users' },
          { key: 'unpaid', label: 'Unpaid Invoices', icon: 'billing', badge: unpaidInvoicesList.length },
          { key: 'drafts', label: 'Drafts', icon: 'billing' },
          { key: 'transactions', label: 'Wallet Transactions', icon: 'billing' },
          { key: 'payments', label: 'Payments', icon: 'billing' },
          { key: 'expenses', label: 'Expenses', icon: 'billing' },
          { key: 'credit_notes', label: 'Credit Notes', icon: 'billing' },
        ].map(t => (
          <button
            key={t.key}
            type="button"
            className={`btn ${activeTab === t.key ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
            {t.badge > 0 && (
              <span style={{
                background: activeTab === t.key ? 'rgba(255,255,255,0.2)' : 'var(--danger)',
                color: activeTab === t.key ? '#fff' : '#fff',
                fontSize: 10.5, fontWeight: 700,
                padding: '1px 7px', borderRadius: 10, minWidth: 18, textAlign: 'center',
              }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {profile && ['admin', 'owner', 'billing'].includes(profile.role) && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--gold)', borderColor: 'var(--gold)' }}
              onClick={() => setShowApprovals(true)}
              title="View pending approval requests"
            >
              <AppIcon name="shield" size={14} /> Approvals
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => setShowEndOfDay(true)}
            title="End-of-day cashier reconciliation — count cash, verify totals"
          >
            <AppIcon name="clock" size={14} /> End of Day
          </button>
          <ModuleHistoryButton moduleKey="billing" />
        </div>
      </div>

      {/* KPI stats — same premium system as the main dashboard */}
      <section className="dash-stats premium-stats" style={{ marginBottom: 20 }}>
        <div className="dash-stat-card premium-stat teal-stat">
          <div className="dash-stat-top">
            <div className="dash-stat-icon money-icon">₦</div>
            <svg className="dash-mini-chart" viewBox="0 0 90 38"><path d={SPARK} /></svg>
          </div>
          <div className="dash-stat-label">Today's Collections</div>
          <div className="dash-stat-value">{formatMoney(kpis.tRev)}</div>
          <div className="dash-stat-delta positive"><Icon name="arrowUp" size={12} /> Collected today</div>
        </div>

        <div className="dash-stat-card premium-stat gold-stat">
          <div className="dash-stat-top">
            <div className="dash-stat-icon"><Icon name="clock" size={20} /></div>
            <svg className="dash-mini-chart" viewBox="0 0 90 38"><path d={SPARK} /></svg>
          </div>
          <div className="dash-stat-label">Pending Charges</div>
          <div className="dash-stat-value">{formatMoney(kpis.pendingTotal)}</div>
          <div className="dash-stat-delta positive">{kpis.pendingCount} awaiting billing</div>
        </div>

        <div className="dash-stat-card premium-stat red-stat" style={{ cursor: 'pointer' }} onClick={() => setActiveTab('unpaid')} title="Click to view all unpaid invoices">
          <div className="dash-stat-top">
            <div className="dash-stat-icon"><Icon name="alert" size={20} /></div>
            <svg className="dash-mini-chart" viewBox="0 0 90 38"><path d={SPARK} /></svg>
          </div>
          <div className="dash-stat-label">Outstanding Invoices <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>(click to view)</span></div>
          <div className="dash-stat-value">{formatMoney(kpis.out)}</div>
          <div className="dash-stat-delta negative">{unpaidInvoicesList.length} unpaid invoice{unpaidInvoicesList.length === 1 ? '' : 's'}</div>
        </div>

        <div className="dash-stat-card premium-stat violet-stat">
          <div className="dash-stat-top">
            <div className="dash-stat-icon"><Icon name="users" size={20} /></div>
            <svg className="dash-mini-chart" viewBox="0 0 90 38"><path d={SPARK} /></svg>
          </div>
          <div className="dash-stat-label">Patients in Queue</div>
          <div className="dash-stat-value">{patientQueue.length}</div>
          <div className="dash-stat-delta positive">Ready for checkout</div>
        </div>
      </section>

      {/* Queue (only shown when activeTab === 'queue') */}
      {activeTab === 'queue' && (
      <div className="dash-panel">
        <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="dash-panel-title">Patient Billing Queue</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>Patients with automatically generated charges waiting for review.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => setShowCreateInvoice(true)}
              title="Open the billing workspace for any registered patient and add manual charges (e.g. consultation, procedure)"
            >
              <AppIcon name="plus" size={14} /> Create Invoice
            </button>
            <div className="dash-search" style={{ maxWidth: 260 }}>
              <Icon name="search" size={15} />
              <input placeholder="Search patient name…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>Loading billing queue…</div>
        ) : patientQueue.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>
            No pending charges. When Pharmacy or Inventory dispenses an item, the patient will appear here automatically.
          </div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table className="dash-full-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Pending Items</th>
                    <th>Pending Total</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedQueue.map(p => (
                    <tr key={p.id}>
                      <td>
                        <div className="dash-patient-name">
                          <span>{initials(p.name)}</span>
                          {p.name}
                        </div>
                      </td>
                      <td>{p.items} item{p.items !== 1 ? 's' : ''}</td>
                      <td style={{ fontWeight: 700, color: 'var(--gold)' }}>{formatMoney(p.total)}</td>
                      <td>
                        <span className="dash-status" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>
                          AWAITING REVIEW
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn btn-primary"
                          style={{ width: 'auto', padding: '7px 14px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                          onClick={() => setSelectedPatient({ id: p.id, name: p.name })}
                        >
                          Open Billing <Icon name="arrowRight" size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
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
              itemLabel="patients in queue"
            />
          </>
        )}
      </div>
      )}

      {/* ---- Unpaid Invoices tab (FIX for the "stuck awaiting bill" bug) ---------
          Shows every finalized invoice with an outstanding balance. Each
          row has a "Take Payment" button that reopens the InvoiceViewer so
          the cashier can record a payment — including against invoices
          that were created by mistake (Generate Invoice clicked with no
          amount entered). */}
      {activeTab === 'unpaid' && (
        <div className="dash-panel">
          <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="dash-panel-title">Unpaid Invoices</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                Invoices with outstanding balances. Click <strong>Take Payment</strong> to record a payment, <strong>View</strong> to print the receipt, or use Credit Note / Write Off for adjustments.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => setShowMultiPayModal(true)}
                title="Record one payment and split it across multiple invoices"
              >
                <AppIcon name="billing" size={14} /> Multi-Invoice Payment
              </button>
              <div className="dash-search" style={{ maxWidth: 260 }}>
                <Icon name="search" size={15} />
                <input placeholder="Search invoice #, patient name…" value={unpaidSearch} onChange={e => setUnpaidSearch(e.target.value)} />
              </div>
            </div>
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>Loading invoices…</div>
          ) : unpaidInvoicesList.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>
              No unpaid invoices. Every finalized invoice has been fully paid or cancelled. 🎉
            </div>
          ) : (
            <>
              <div className="dash-table-wrap">
                <table className="dash-full-table">
                  <thead>
                    <tr>
                      <th>Invoice #</th>
                      <th>Patient</th>
                      <th>Created</th>
                      <th>Total</th>
                      <th>Paid</th>
                      <th>Balance</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedUnpaid.map(inv => {
                      const ageDays = Math.floor((Date.now() - new Date(inv.created_at).getTime()) / (24 * 60 * 60 * 1000))
                      const ageLabel = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`
                      const ageColor = ageDays >= 90 ? 'var(--danger)' : ageDays >= 30 ? 'var(--gold)' : 'var(--muted)'
                      const statusColor = inv.status === 'partial' ? 'var(--gold)' : 'var(--danger)'
                      const statusBg = inv.status === 'partial' ? 'rgba(232,184,46,0.14)' : 'rgba(225,104,94,0.14)'
                      return (
                        <tr key={inv.id}>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, color: 'var(--blue)', fontWeight: 700 }}>{inv.invoice_number || inv.id.slice(0,8)}</td>
                          <td style={{ fontWeight: 600 }}>{inv.patient_name || '—'}</td>
                          <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                            {formatDateTimeSec(inv.created_at, timezone)}
                            <div style={{ fontSize: 10.5, color: ageColor, marginTop: 2 }}>{ageLabel}</div>
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatMoney(inv.grand_total || inv.amount)}</td>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--teal)' }}>{formatMoney(inv.amount_paid)}</td>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--danger)' }}>{formatMoney(inv.balance)}</td>
                          <td>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: statusBg, color: statusColor, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                              {inv.status}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <button
                                className="btn btn-primary"
                                style={{ width: 'auto', padding: '5px 12px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                                onClick={() => {
                                  // Reopen InvoiceViewer with the latest invoice state
                                  // (re-find to pick up any updates since the table rendered)
                                  const fresh = invoices.find(i => i.id === inv.id)
                                  setViewInvoice(fresh || inv)
                                }}
                                title="Open this invoice to record a payment against the balance"
                              >
                                <AppIcon name="billing" size={13} /> Take Payment
                              </button>
                              <button
                                className="btn btn-ghost"
                                style={{ width: 'auto', padding: '5px 10px', fontSize: 11 }}
                                onClick={() => {
                                  const fresh = invoices.find(i => i.id === inv.id)
                                  setViewInvoice(fresh || inv)
                                }}
                                title="View invoice details and print receipt"
                              >
                                View
                              </button>
                              <button
                                className="btn btn-ghost"
                                style={{ width: 'auto', padding: '5px 10px', fontSize: 11, color: 'var(--violet)', borderColor: 'var(--violet)' }}
                                onClick={() => { setCreditNoteInvoice(inv); setShowCreditNoteModal(true) }}
                                title="Issue a credit note against this invoice"
                              >
                                Credit Note
                              </button>
                              <button
                                className="btn btn-ghost"
                                style={{ width: 'auto', padding: '5px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                                onClick={async () => {
                                  const reason = prompt(`Write off invoice ${inv.invoice_number} for ${inv.patient_name}?\n\nBalance: ${formatMoney(inv.balance)}\n\nEnter a reason (required):`)
                                  if (!reason?.trim()) return
                                  const result = await writeOffInvoice({ hospital, profile, invoice: inv, reason, updateInvoice, writeAudit })
                                  if (result.success) showToast(`Invoice ${inv.invoice_number} written off`)
                                  else showToast(result.error || 'Could not write off')
                                }}
                                title="Mark as bad debt — requires reason"
                              >
                                Write Off
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <Pagination
                currentPage={unpaidPage}
                totalPages={unpaidTotalPages}
                totalItems={unpaidTotalItems}
                startIndex={unpaidStart}
                endIndex={unpaidEnd}
                pageSize={unpaidPageSize}
                onPageChange={setUnpaidPage}
                onPageSizeChange={setUnpaidPageSize}
                itemLabel="unpaid invoices"
              />
            </>
          )}
        </div>
      )}

      {/* ---- Transactions tab ---- */}
      {activeTab === 'transactions' && (
        <>
          {/* Mini-stats */}
          <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}><AppIcon name="arrowUp" size={18} /></div>
              <div>
                <div className="dash-stat-label">Deposits Today</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(txnStats.depositsToday)}</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}><AppIcon name="arrowDown" size={18} /></div>
              <div>
                <div className="dash-stat-label">Charges Today</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(txnStats.chargesToday)}</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(201,169,97,0.14)', color: 'var(--gold)' }}><AppIcon name="arrowDown" size={18} /></div>
              <div>
                <div className="dash-stat-label">Refunds Today</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(txnStats.refundsToday)}</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}><AppIcon name="billing" size={18} /></div>
              <div>
                <div className="dash-stat-label">Total Transactions</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{walletTxns.length}</div>
              </div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="dash-panel-title">Wallet Transactions</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>Every deposit, charge, refund, and adjustment — append-only ledger.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select value={txnTypeFilter} onChange={e => setTxnTypeFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, var(--line))', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}>
                  <option value="all">All types</option>
                  <option value="deposit">Deposits</option>
                  <option value="charge">Charges</option>
                  <option value="refund">Refunds</option>
                  <option value="adjustment">Adjustments</option>
                </select>
                <SearchInput value={txnSearch} onChange={setTxnSearch} placeholder="Search patient, ref, notes…" style={{ minWidth: 200, maxWidth: 320 }} />
              </div>
            </div>

            {txnsLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>Loading transactions…</div>
            ) : filteredTxns.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>
                {txnSearch || txnTypeFilter !== 'all' ? 'No transactions match these filters.' : 'No wallet transactions yet. Deposits made on the patient profile will appear here.'}
              </div>
            ) : (
              <>
                <div className="dash-table-wrap">
                  <table className="dash-full-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Patient</th>
                        <th>Type</th>
                        <th>Method</th>
                        <th>Reference</th>
                        <th>Amount</th>
                        <th>Balance After</th>
                        <th>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedTxns.map(t => {
                        const amount = Number(t.amount || 0)
                        const isCredit = amount > 0
                        const patientName = patients.find(p => p.id === t.patient_id)?.full_name || '—'
                        const typeColor = t.type === 'deposit' ? 'var(--teal)' :
                                          t.type === 'refund' ? 'var(--gold)' :
                                          t.type === 'charge' ? 'var(--danger)' :
                                          'var(--violet)'
                        return (
                          <tr key={t.id}>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDateTimeSec(t.created_at, timezone)}</td>
                            <td style={{ fontWeight: 700 }}>{patientName}</td>
                            <td>
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                background: `${typeColor}22`, color: typeColor,
                                textTransform: 'uppercase', letterSpacing: 0.5,
                              }}>
                                {t.type}
                              </span>
                            </td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.method || '—'}</td>
                            <td style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)' }}>{t.reference || '—'}</td>
                            <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: isCredit ? 'var(--teal)' : 'var(--danger)' }}>
                              {isCredit ? '+' : ''}{formatMoney(amount)}
                            </td>
                            <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--muted)' }}>{formatMoney(t.balance_after)}</td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.performed_by_name || '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  currentPage={txnPage}
                  totalPages={txnTotalPages}
                  totalItems={txnTotalItems}
                  startIndex={txnStart}
                  endIndex={txnEnd}
                  pageSize={txnPageSize}
                  onPageChange={setTxnPage}
                  onPageSizeChange={setTxnPageSize}
                  itemLabel="transactions"
                />
              </>
            )}
          </div>
        </>
      )}

      {/* ---- Payments tab ---- */}
      {activeTab === 'payments' && (
        <>
          {/* Mini-stats */}
          <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}><AppIcon name="billing" size={18} /></div>
              <div>
                <div className="dash-stat-label">Active Payments</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{payStats.activeCount}</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}><AppIcon name="arrowDown" size={18} /></div>
              <div>
                <div className="dash-stat-label">Reversed Payments</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{payStats.reversedCount}</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(0,199,199,0.10)', color: 'var(--teal)' }}><AppIcon name="clock" size={18} /></div>
              <div>
                <div className="dash-stat-label">Today's Collections</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(payStats.todayTotal)}</div>
                <div className="dash-stat-delta">{payStats.todayCount} payment(s) today</div>
              </div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="dash-panel-title">Payment Records</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>Every payment recorded — cash, POS, bank transfer, wallet, and reversed entries.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select value={payStatusFilter} onChange={e => setPayStatusFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}>
                  <option value="active">Active only</option>
                  <option value="reversed">Reversed only</option>
                  <option value="all">All payments</option>
                </select>
                <select value={payMethodFilter} onChange={e => setPayMethodFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}>
                  <option value="all">All methods</option>
                  <option value="Cash">Cash</option>
                  <option value="POS">POS</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Card">Card</option>
                  <option value="Wallet">Wallet</option>
                  <option value="HMO">HMO</option>
                </select>
                <SearchInput value={paySearch} onChange={setPaySearch} placeholder="Search patient, ref, invoice…" style={{ minWidth: 200, maxWidth: 320 }} />
              </div>
            </div>

            {filteredPayments.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>
                {paySearch || payMethodFilter !== 'all' || payStatusFilter !== 'active' ? 'No payments match these filters.' : 'No payments recorded yet. When the cashier records a payment via an invoice, it will appear here.'}
              </div>
            ) : (
              <>
                <div className="dash-table-wrap">
                  <table className="dash-full-table">
                    <thead>
                      <tr>
                        <th>Date / Time</th>
                        <th>Patient</th>
                        <th>Invoice #</th>
                        <th>Amount</th>
                        <th>Method</th>
                        <th>Reference</th>
                        <th>Received By</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedPayments.map(p => {
                        const patientName = patients.find(pt => pt.id === p.patient_id)?.full_name || p.patient_name || '—'
                        const inv = invoices.find(i => i.id === p.invoice_id)
                        const receivedBy = staff.find(s => s.id === p.received_by)?.full_name || '—'
                        const reversedBy = staff.find(s => s.id === p.reversed_by)?.full_name
                        const isReversed = p.status === 'reversed'
                        return (
                          <tr key={p.id} style={{ opacity: isReversed ? 0.5 : 1 }}>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDateTimeSec(p.created_at, timezone)}</td>
                            <td style={{ fontWeight: 700 }}>{patientName}</td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)' }}>{inv?.invoice_number || '—'}</td>
                            <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: isReversed ? 'var(--muted)' : 'var(--teal)' }}>{formatMoney(p.amount)}</td>
                            <td>
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                background: p.method === 'Cash' ? 'rgba(0,199,199,0.14)' :
                                            p.method === 'POS' ? 'rgba(59,130,246,0.14)' :
                                            p.method === 'Bank Transfer' ? 'rgba(118,87,232,0.14)' :
                                            p.method === 'Wallet' ? 'rgba(0,199,199,0.10)' :
                                            'rgba(154,170,183,0.14)',
                                color: p.method === 'Cash' ? 'var(--teal)' :
                                       p.method === 'POS' ? 'var(--blue)' :
                                       p.method === 'Bank Transfer' ? 'var(--violet)' :
                                       p.method === 'Wallet' ? 'var(--teal)' :
                                       'var(--muted)',
                              }}>
                                {p.method || 'Cash'}
                              </span>
                            </td>
                            <td style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)' }}>{p.reference_number || '—'}</td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{receivedBy}</td>
                            <td>
                              {isReversed ? (
                                <span style={{
                                  fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                  background: 'rgba(240,79,95,0.14)', color: 'var(--danger)',
                                  textTransform: 'uppercase', letterSpacing: 0.5,
                                }} title={`Reversed by ${reversedBy || '—'} on ${p.reversed_at ? new Date(p.reversed_at).toLocaleString('en-NG') : '—'}\nReason: ${p.reversal_reason || '—'}`}>
                                  Reversed
                                </span>
                              ) : (
                                <span style={{
                                  fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                  background: 'rgba(0,199,199,0.14)', color: 'var(--teal)',
                                  textTransform: 'uppercase', letterSpacing: 0.5,
                                }}>
                                  Active
                                </span>
                              )}
                            </td>
                            <td>
                              {!isReversed && profile && ['admin', 'owner', 'billing'].includes(profile.role) && (
                                <button
                                  className="btn btn-ghost"
                                  style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                                  onClick={() => handleReversePayment(p)}
                                  title="Reverse this payment"
                                >
                                  Reverse
                                </button>
                              )}
                              {isReversed && (
                                <span style={{ fontSize: 10, color: 'var(--muted-dim)', fontStyle: 'italic' }}>
                                  {p.reversal_reason ? `"${p.reversal_reason}"` : ''}
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  currentPage={payPage}
                  totalPages={payTotalPages}
                  totalItems={payTotalItems}
                  startIndex={payStart}
                  endIndex={payEnd}
                  pageSize={payPageSize}
                  onPageChange={setPayPage}
                  onPageSizeChange={setPayPageSize}
                  itemLabel="payments"
                />
              </>
            )}
          </div>
        </>
      )}

      {/* ---- Expenses tab ---- */}
      {activeTab === 'expenses' && (
        <>
          {/* Mini-stats */}
          <div className="dash-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(225,104,94,0.14)', color: 'var(--danger)' }}><AppIcon name="arrowDown" size={18} /></div>
              <div>
                <div className="dash-stat-label">Today's Expenses</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(expenseStats.todayTotal)}</div>
                <div className="dash-stat-delta">{expenseStats.todayCount} expense{expenseStats.todayCount === 1 ? '' : 's'} today</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(232,184,46,0.14)', color: 'var(--gold)' }}><AppIcon name="billing" size={18} /></div>
              <div>
                <div className="dash-stat-label">This Week</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(expenseStats.weekTotal)}</div>
                <div className="dash-stat-delta">Last 7 days</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(118,87,232,0.14)', color: 'var(--violet)' }}><AppIcon name="billing" size={18} /></div>
              <div>
                <div className="dash-stat-label">This Month</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{formatMoney(expenseStats.monthTotal)}</div>
                <div className="dash-stat-delta">{new Date().toLocaleString('en-NG', { month: 'long' })}</div>
              </div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon" style={{ background: 'rgba(0,199,199,0.14)', color: 'var(--teal)' }}><AppIcon name="users" size={18} /></div>
              <div>
                <div className="dash-stat-label">Total Records</div>
                <div className="dash-stat-value" style={{ fontSize: 16 }}>{expenses.length}</div>
                <div className="dash-stat-delta">All expenses</div>
              </div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="dash-panel-title">Hospital Expenses</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>Salaries, rent, utilities, supplies, equipment, and other outgoing payments.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select value={expenseCategoryFilter} onChange={e => setExpenseCategoryFilter(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}>
                  <option value="all">All categories</option>
                  {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input type="date" value={expenseDateFrom} onChange={e => setExpenseDateFrom(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }} title="From date" />
                <input type="date" value={expenseDateTo} onChange={e => setExpenseDateTo(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }} title="To date" />
                <SearchInput value={expenseSearch} onChange={setExpenseSearch} placeholder="Search description, ref, recorded by…" style={{ minWidth: 200, maxWidth: 320 }} />
                {canManageExpenses && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={() => openExpenseModal(null)}
                  >
                    <AppIcon name="plus" size={14} /> Record Expense
                  </button>
                )}
              </div>
            </div>

            {filteredExpenses.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>
                {expenseSearch || expenseCategoryFilter !== 'all' || expenseDateFrom || expenseDateTo ? 'No expenses match these filters.' : 'No expenses recorded yet. Click "Record Expense" to add the first one.'}
              </div>
            ) : (
              <>
                <div className="dash-table-wrap">
                  <table className="dash-full-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Category</th>
                        <th>Description</th>
                        <th>Amount</th>
                        <th>Method</th>
                        <th>Reference</th>
                        <th>Recorded By</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedExpenses.map(e => (
                        <tr key={e.id}>
                          <td style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDateTimeSec(e.paid_at || e.created_at, timezone)}</td>
                          <td>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                              background: 'rgba(118,87,232,0.14)', color: 'var(--violet)',
                              textTransform: 'uppercase', letterSpacing: 0.5,
                            }}>
                              {e.category}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600, fontSize: 12.5 }}>{e.description}</td>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--danger)' }}>{formatMoney(e.amount)}</td>
                          <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.payment_method || 'Cash'}</td>
                          <td style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)' }}>{e.reference_number || '—'}</td>
                          <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.recorded_by_name || '—'}</td>
                          <td>
                            {canManageExpenses && (
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button
                                  className="btn btn-ghost"
                                  style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }}
                                  onClick={() => openExpenseModal(e)}
                                  title="Edit expense"
                                >
                                  Edit
                                </button>
                                {profile && ['admin', 'owner'].includes(profile.role) && (
                                  <button
                                    className="btn btn-ghost"
                                    style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                                    onClick={() => handleDeleteExpense(e)}
                                    title="Delete expense"
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  currentPage={expPage}
                  totalPages={expTotalPages}
                  totalItems={expTotalItems}
                  startIndex={expStart}
                  endIndex={expEnd}
                  pageSize={expPageSize}
                  onPageChange={setExpPage}
                  onPageSizeChange={setExpPageSize}
                  itemLabel="expenses"
                />
              </>
            )}
          </div>
        </>
      )}

      {/* ---- Expense modal ---- */}
      {showExpenseModal && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setShowExpenseModal(false); resetExpenseForm() } }}>
          <div className="card dash-modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
              <div className="dash-modal-title" style={{ paddingBottom: 0 }}>{editingExpenseId ? 'Edit Expense' : 'Record Expense'}</div>
              <button className="dash-icon-btn" onClick={() => { setShowExpenseModal(false); resetExpenseForm() }} aria-label="Close"><AppIcon name="close" size={18} /></button>
            </div>
            <div className="dash-modal-body">
              <form id="expense-form" onSubmit={handleSaveExpense}>
                {expError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{expError}</div>}
                <div className="field">
                  <label>Category *</label>
                  <select value={expCategory} onChange={e => setExpCategory(e.target.value)}>
                    {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Description *</label>
                  <input value={expDescription} onChange={e => setExpDescription(e.target.value)} placeholder="e.g. April staff salaries, NEPA bill, surgical gloves restock" autoFocus required />
                </div>
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Amount (₦) *</label>
                    <input type="number" min="0.01" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} placeholder="e.g. 50000" required style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }} />
                  </div>
                  <div className="field">
                    <label>Payment Method</label>
                    <select value={expMethod} onChange={e => setExpMethod(e.target.value)}>
                      {EXPENSE_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                </div>
                <div className="dash-field-grid">
                  <div className="field">
                    <label>Date Paid</label>
                    <input type="date" value={expPaidAt} onChange={e => setExpPaidAt(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Reference (optional)</label>
                    <input value={expReference} onChange={e => setExpReference(e.target.value)} placeholder="transfer ref, cheque no., receipt no." />
                  </div>
                </div>
              </form>
            </div>
            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setShowExpenseModal(false); resetExpenseForm() }} disabled={expSaving}>Cancel</button>
              <button type="submit" form="expense-form" className="btn btn-primary" disabled={expSaving}>{expSaving ? 'Saving…' : (editingExpenseId ? 'Save Changes' : 'Record Expense')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Drafts tab (Phase 2) ---- */}
      {activeTab === 'drafts' && (
        <>
          <div className="dash-panel">
            <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="dash-panel-title">Draft Invoices</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  Invoices saved as drafts — review and finalize to assign sequential invoice numbers (INV-000001, INV-000002, …).
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setShowMultiPayModal(true)}
                  title="Record one payment and split it across multiple invoices"
                >
                  <AppIcon name="billing" size={14} /> Multi-Invoice Payment
                </button>
              </div>
            </div>

            {(() => {
              const draftInvoices = invoices.filter(i => i.draft_status === 'draft')
              if (draftInvoices.length === 0) {
                return (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12.5 }}>
                    No draft invoices. When you click "Save as Draft" in the billing workspace, the invoice will appear here for review.
                  </div>
                )
              }
              return (
                <div className="dash-table-wrap">
                  <table className="dash-full-table">
                    <thead>
                      <tr>
                        <th>Draft #</th>
                        <th>Patient</th>
                        <th>Created</th>
                        <th>Total</th>
                        <th>Type</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {draftInvoices.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(inv => (
                        <tr key={inv.id}>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, color: 'var(--gold)' }}>{inv.invoice_number}</td>
                          <td style={{ fontWeight: 600 }}>{inv.patient_name}</td>
                          <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{formatDateTimeSec(inv.created_at, timezone)}</td>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--ivory)' }}>{formatMoney(inv.grand_total || inv.amount)}</td>
                          <td>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(232,184,46,0.14)', color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                              {inv.invoice_type || 'outpatient'}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                className="btn btn-primary"
                                style={{ width: 'auto', padding: '4px 10px', fontSize: 11 }}
                                onClick={async () => {
                                  const result = await finalizeDraftInvoice({
                                    hospital, profile, invoice: inv, updateInvoice, writeAudit,
                                  })
                                  if (result.success) {
                                    showToast(`Finalized → ${result.invoiceNumber}`)
                                  } else {
                                    showToast(result.error || 'Could not finalize')
                                  }
                                }}
                                title="Assign sequential invoice number and mark as finalized"
                              >
                                Finalize
                              </button>
                              <button
                                className="btn btn-ghost"
                                style={{ width: 'auto', padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                                onClick={async () => {
                                  if (!confirm(`Cancel draft ${inv.invoice_number} for ${inv.patient_name}?`)) return
                                  const result = await cancelDraftInvoice({ hospital, profile, invoice: inv, updateInvoice, writeAudit })
                                  if (result.success) showToast('Draft cancelled')
                                  else showToast(result.error || 'Could not cancel')
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </div>

          {/* Pointer to the Unpaid tab — outstanding invoices used to be
              listed here but are now on their own dedicated tab so they're
              easy to find (the "Generate Invoice by mistake" bug fix). */}
          <div style={{
            marginTop: 20, padding: '14px 18px', borderRadius: 10,
            background: 'rgba(225,104,94,0.08)', border: '1px solid rgba(225,104,94,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12.5, color: 'var(--ivory)' }}>
              <strong style={{ color: 'var(--danger)' }}>Outstanding invoices moved.</strong>
              <span style={{ color: 'var(--muted)' }}> Invoices with unpaid balances now live on the </span>
              <strong style={{ color: 'var(--ivory)' }}>Unpaid Invoices</strong>
              <span style={{ color: 'var(--muted)' }}> tab — where you can take a payment, view the receipt, issue a credit note, or write off bad debt.</span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: 'auto', padding: '7px 14px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => setActiveTab('unpaid')}
              title="Switch to the Unpaid Invoices tab"
            >
              <Icon name="arrowRight" size={14} /> Go to Unpaid Invoices
            </button>
          </div>
        </>
      )}

      {/* ---- Credit Notes tab (Phase 2) ---- */}
      {activeTab === 'credit_notes' && (
        <>
          <div className="dash-panel">
            <div className="dash-panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="dash-panel-title">Credit Notes</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  Formal credit notes issued against finalized invoices. Each reduces the invoice balance or triggers a refund.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <SearchInput
                  value={cnSearch}
                  onChange={setCnSearch}
                  placeholder="Search by number, patient, reason…"
                  style={{ minWidth: 220 }}
                />
              </div>
            </div>

            {(() => {
              const filtered = (creditNotes || [])
                .filter(cn => {
                  if (!cnSearch.trim()) return true
                  const q = cnSearch.trim().toLowerCase()
                  const inv = invoices.find(i => i.id === cn.original_invoice_id)
                  return (
                    (cn.credit_note_number || '').toLowerCase().includes(q) ||
                    (cn.reason_code || '').toLowerCase().includes(q) ||
                    (cn.reason_text || '').toLowerCase().includes(q) ||
                    (inv?.patient_name || '').toLowerCase().includes(q)
                  )
                })
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

              if (filtered.length === 0) {
                return (
                  <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)', fontSize: 12.5 }}>
                    No credit notes issued yet. Click "Credit Note" on an outstanding invoice in the Unpaid Invoices tab to issue one.
                  </div>
                )
              }
              return (
                <div className="dash-table-wrap">
                  <table className="dash-full-table">
                    <thead>
                      <tr>
                        <th>CN #</th>
                        <th>Original Invoice</th>
                        <th>Patient</th>
                        <th>Amount</th>
                        <th>Reason</th>
                        <th>Refund Method</th>
                        <th>Posted At</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(cn => {
                        const inv = invoices.find(i => i.id === cn.original_invoice_id)
                        const reasonLabel = CREDIT_NOTE_REASONS.find(r => r.value === cn.reason_code)?.label || cn.reason_code
                        return (
                          <tr key={cn.id}>
                            <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, color: 'var(--violet)' }}>{cn.credit_note_number}</td>
                            <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{inv?.invoice_number || '—'}</td>
                            <td style={{ fontWeight: 600 }}>{inv?.patient_name || '—'}</td>
                            <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--danger)' }}>{formatMoney(cn.amount)}</td>
                            <td style={{ fontSize: 11.5 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(225,104,94,0.14)', color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{reasonLabel}</span>
                              {cn.reason_text && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{cn.reason_text}</div>}
                            </td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{cn.refund_method || 'none'}{cn.refund_reference ? ` · ${cn.refund_reference}` : ''}</td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{cn.posted_at ? formatDateTimeSec(cn.posted_at, timezone) : '—'}</td>
                            <td>
                              <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                background: cn.status === 'posted' ? 'rgba(0,199,199,0.14)' : cn.status === 'reversed' ? 'rgba(154,170,183,0.14)' : 'rgba(232,184,46,0.14)',
                                color: cn.status === 'posted' ? 'var(--teal)' : cn.status === 'reversed' ? 'var(--muted)' : 'var(--gold)',
                                textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                {cn.status}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </div>
        </>
      )}

      {/* ---- Credit Note modal ---- */}
      {showCreditNoteModal && creditNoteInvoice && (
        <CreditNoteModal
          invoice={creditNoteInvoice}
          hospital={hospital}
          profile={profile}
          onIssue={async ({ amount, reasonCode, reasonText, refundMethod, refundReference }) => {
            const result = await createCreditNote({
              hospital, profile,
              invoice: creditNoteInvoice,
              amount, reasonCode, reasonText,
              refundMethod, refundReference,
              addCreditNote, updateInvoice, writeAudit,
            })
            if (result.success) {
              showToast(`Credit note ${result.creditNote?.credit_note_number} posted`)
              setShowCreditNoteModal(false)
              setCreditNoteInvoice(null)
            } else {
              alert(result.error || 'Could not issue credit note')
            }
          }}
          onClose={() => { setShowCreditNoteModal(false); setCreditNoteInvoice(null) }}
        />
      )}

      {/* ---- Multi-Invoice Payment modal ---- */}
      {showMultiPayModal && (
        <MultiInvoicePaymentModal
          hospital={hospital}
          profile={profile}
          invoices={invoices}
          patients={patients}
          addPayment={undefined}
          addAllocation={addAllocation}
          updateInvoice={updateInvoice}
          writeAudit={writeAudit}
          onClose={() => setShowMultiPayModal(false)}
          onAllocated={() => { setShowMultiPayModal(false); showToast('Payment allocated across invoices') }}
        />
      )}

      {/* ---- Phase 4: Approval Queue + End of Day Reconciliation modals ---- */}
      {showApprovals && (
        <ApprovalQueueModal onClose={() => setShowApprovals(false)} />
      )}
      {showEndOfDay && (
        <EndOfDayReconciliationModal onClose={() => setShowEndOfDay(false)} />
      )}

      {selectedPatient && (
        <CashierWorkspace
          patientId={selectedPatient.id}
          patientName={selectedPatient.name}
          hospital={hospital}
          profile={profile}
          onClose={() => setSelectedPatient(null)}
        />
      )}

      {/* ---- "Create Invoice" patient picker -------------------------------
          Lets the cashier pick any registered patient (a personal folder
          holder at the hospital) and open the billing workspace for them.
          Inside the workspace they can add custom charges (consultation,
          procedure, etc.) and generate an invoice. Wallet auto-deduction
          and HMO claim filing work the same as the existing flow. */}
      {showCreateInvoice && (
        <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowCreateInvoice(false) }}>
          <div className="card dash-modal" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14 }}>
              <div>
                <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Create Invoice</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  Pick a patient with a personal folder at the hospital to begin billing.
                </div>
              </div>
              <button className="dash-icon-btn" onClick={() => setShowCreateInvoice(false)} aria-label="Close patient picker">
                <AppIcon name="close" size={18} />
              </button>
            </div>

            <div className="dash-modal-body">
              <div className="field">
                <label>Select Patient *</label>
                <PatientAutocomplete
                  patients={patients}
                  value={null}
                  loading={loading || patientsLoading}
                  onChange={(option) => {
                    if (!option || !option.patient) return
                    setSelectedPatient({ id: option.patient.id, name: option.patient.full_name })
                    setShowCreateInvoice(false)
                    writeAudit({
                      hospitalId: hospital?.id, actor: profile,
                      action: 'billing.create_invoice_opened',
                      entityType: 'patient', entityId: option.patient.id,
                      patientId: option.patient.id,
                      summary: `Opened billing workspace to create a manual invoice for ${option.patient.full_name || 'patient'}`,
                      metadata: { patient_id: option.patient.id, patient_name: option.patient.full_name, source: 'create_invoice_button' },
                    })
                  }}
                  placeholder="Search patient by name, MRN or phone…"
                  emptyText="No matching patient — register them at Reception first"
                  ariaLabel="Patient"
                />
              </div>

              <div style={{
                marginTop: 14, padding: '10px 12px', borderRadius: 8,
                background: 'rgba(0,199,199,0.06)', border: '1px solid var(--line-soft)',
                fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6,
              }}>
                <strong style={{ color: 'var(--teal)' }}>Tip:</strong> After selecting a patient you'll be able to
                add custom charges (consultation, lab, procedure), apply discounts, and generate an invoice.
                If the patient has a wallet balance, it will be{' '}
                <strong style={{ color: 'var(--teal)' }}>auto-deducted first</strong>{' '}
                before any remaining balance is due.
              </div>
            </div>

            <div className="dash-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowCreateInvoice(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- InvoiceViewer modal (reopen an unpaid invoice) ---------------
          Rendered when the cashier clicks "Take Payment" or "View" on any
          row in the Unpaid Invoices tab. The InvoiceViewer shows the
          invoice details, lets the cashier record a payment against the
          balance, and print the receipt. This is the FIX that lets the
          cashier come back to an invoice that was generated without a
          payment amount entered. */}
      {viewInvoice && (
        <InvoiceViewer
          invoice={viewInvoice}
          hospital={hospital}
          profile={profile}
          onClose={() => setViewInvoice(null)}
        />
      )}

      {toast && <div className="billing-toast">{toast}</div>}
    </>
  )
}
