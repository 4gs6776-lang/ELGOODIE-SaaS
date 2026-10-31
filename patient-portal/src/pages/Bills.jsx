import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchInvoices, fetchPayments } from '../lib/patientDataService'
import { CreditCard, ChevronRight, RefreshCw, X, Clock, CheckCircle2, Receipt } from 'lucide-react'

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function formatMoney(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function statusBadge(status) {
  const s = (status || '').toLowerCase()
  if (s === 'paid') return { label: 'Paid', color: 'text-accent-600', bg: 'bg-accent-50', icon: CheckCircle2 }
  if (s === 'partial') return { label: 'Partial', color: 'text-amber-600', bg: 'bg-amber-50', icon: Clock }
  if (s === 'unpaid') return { label: 'Unpaid', color: 'text-red-500', bg: 'bg-red-50', icon: Clock }
  return { label: status || '—', color: 'text-surface-500', bg: 'bg-surface-50', icon: Receipt }
}

export default function Bills() {
  const { patient } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedInvoice, setSelectedInvoice] = useState(null)
  const [payments, setPayments] = useState([])
  const [loadingPayments, setLoadingPayments] = useState(false)
  const [error, setError] = useState('')

  const loadData = useCallback(async (isRefresh = false) => {
    if (!patient?.id) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const { data, error } = await fetchInvoices(patient.id, patient.hospital_id)
      if (error) setError(error)
      else setInvoices(data || [])
    } catch (err) {
      setError(err.message || 'Could not load invoices')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [patient?.id, patient?.hospital_id])

  useEffect(() => { loadData() }, [loadData])

  // Load payments when an invoice is selected
  useEffect(() => {
    if (!selectedInvoice?.id) return
    setLoadingPayments(true)
    fetchPayments(selectedInvoice.id, patient.hospital_id)
      .then(({ data }) => setPayments(data || []))
      .catch(() => setPayments([]))
      .finally(() => setLoadingPayments(false))
  }, [selectedInvoice?.id, patient?.hospital_id])

  // Skeleton
  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-7 w-40 bg-surface-100 rounded-lg animate-pulse" />
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-white rounded-2xl p-4 card-shadow h-20 animate-pulse" />
        ))}
      </div>
    )
  }

  // Detail view
  if (selectedInvoice) {
    const badge = statusBadge(selectedInvoice.status)
    const StatusIcon = badge.icon
    const grandTotal = Number(selectedInvoice.grand_total || selectedInvoice.amount || 0)
    const amountPaid = Number(selectedInvoice.amount_paid || 0)
    const balance = Number(selectedInvoice.balance || 0)

    return (
      <div className="space-y-4">
        <button onClick={() => setSelectedInvoice(null)} className="flex items-center gap-2 text-sm text-primary-500 font-medium">
          <ChevronRight size={16} className="rotate-180" /> Back to Bills
        </button>

        <div className="bg-white rounded-2xl card-shadow overflow-hidden">
          <div className="p-4 border-b border-surface-100">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-surface-900">{selectedInvoice.invoice_number || 'Invoice'}</h2>
                <p className="text-xs text-surface-400 mt-0.5">{formatDate(selectedInvoice.created_at)}</p>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1 ${badge.bg} ${badge.color}`}>
                <StatusIcon size={12} /> {badge.label}
              </span>
            </div>
          </div>

          <div className="p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-surface-400">Total Amount</span>
              <span className="font-bold text-surface-900">{formatMoney(grandTotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-surface-400">Amount Paid</span>
              <span className="font-bold text-accent-600">{formatMoney(amountPaid)}</span>
            </div>
            <div className="border-t border-surface-100 pt-3 flex justify-between">
              <span className="text-sm font-semibold text-surface-600">Balance Due</span>
              <span className={`text-lg font-bold ${balance > 0.01 ? 'text-red-500' : 'text-accent-600'}`}>{formatMoney(balance)}</span>
            </div>
            {selectedInvoice.payment_method && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Payment Method</span>
                <span className="font-medium text-surface-700">{selectedInvoice.payment_method}</span>
              </div>
            )}
          </div>
        </div>

        {/* Payment history */}
        <div className="bg-white rounded-2xl card-shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-100">
            <h3 className="text-sm font-bold text-surface-700">Payment History</h3>
          </div>
          {loadingPayments ? (
            <div className="p-4 space-y-2">
              {[1, 2].map(i => <div key={i} className="h-12 bg-surface-50 rounded-lg animate-pulse" />)}
            </div>
          ) : payments.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-surface-400">No payments recorded yet</p>
            </div>
          ) : (
            payments.map(p => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3 border-b border-surface-100 last:border-0">
                <div>
                  <div className="text-sm font-semibold text-surface-700">{formatMoney(p.amount)}</div>
                  <div className="text-xs text-surface-400">{formatDate(p.created_at)} · {p.method || 'Cash'}</div>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-accent-50 text-accent-600">
                  {p.status || 'confirmed'}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Pay button (placeholder for Phase 3) */}
        {balance > 0.01 && (
          <button
            disabled
            className="w-full py-3.5 rounded-xl bg-surface-100 text-surface-400 font-semibold text-sm cursor-not-allowed"
          >
            Online Payment Coming Soon
          </button>
        )}
      </div>
    )
  }

  // List view
  const totalOutstanding = invoices.reduce((s, i) => s + Number(i.balance || 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-surface-900">Bills & Invoices</h1>
        <button onClick={() => loadData(true)} disabled={refreshing} className="p-2 rounded-lg text-surface-400 hover:text-primary-500">
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Outstanding balance banner */}
      {totalOutstanding > 0.01 && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
          <div className="text-xs text-amber-600 font-semibold">Total Outstanding</div>
          <div className="text-2xl font-bold text-amber-700 mt-0.5">{formatMoney(totalOutstanding)}</div>
        </div>
      )}

      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>}

      {invoices.length === 0 && !error ? (
        <div className="bg-white rounded-2xl card-shadow p-8 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-surface-100 flex items-center justify-center mb-3">
            <CreditCard size={28} className="text-surface-300" />
          </div>
          <p className="text-sm font-semibold text-surface-700">No bills yet</p>
          <p className="text-xs text-surface-400 mt-1 max-w-xs">
            Your invoices and payment history will appear here once they are generated.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {invoices.map(inv => {
            const badge = statusBadge(inv.status)
            const StatusIcon = badge.icon
            const balance = Number(inv.balance || 0)
            const grandTotal = Number(inv.grand_total || inv.amount || 0)
            return (
              <button
                key={inv.id}
                onClick={() => setSelectedInvoice(inv)}
                className="w-full bg-white rounded-2xl p-4 card-shadow text-left transition-all-smooth hover:card-shadow-lg active:scale-[0.98]"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-surface-900">{inv.invoice_number || 'Invoice'}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${badge.bg} ${badge.color}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="text-xs text-surface-400 mt-0.5">{formatDate(inv.created_at)}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-bold text-surface-900">{formatMoney(grandTotal)}</div>
                    {balance > 0.01 ? (
                      <div className="text-xs text-red-500 font-semibold">Bal: {formatMoney(balance)}</div>
                    ) : (
                      <div className="text-xs text-accent-500 font-semibold">Fully Paid</div>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
