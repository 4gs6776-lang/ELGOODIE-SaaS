import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchDashboardSummary } from '../lib/patientDataService'
import { Calendar, FileText, CreditCard, FolderOpen, ChevronRight, RefreshCw } from 'lucide-react'

export default function Dashboard() {
  const { patient, hospital } = useAuth()
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (!patient?.id) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const { data, error } = await fetchDashboardSummary(patient.id, patient.hospital_id)
      if (!error && data) setSummary(data)
    } catch (err) {
      console.error('Dashboard load error:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [patient?.id, patient?.hospital_id])

  useEffect(() => { loadData() }, [loadData])

  const firstName = patient?.full_name?.split(' ')[0] || 'Patient'
  const formatMoney = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const cards = [
    { label: 'Upcoming Appointments', value: summary?.upcomingAppointments ?? '—', icon: Calendar, bg: 'bg-primary-50', iconColor: 'text-primary-500' },
    { label: 'Pending Lab Results', value: summary?.pendingLabResults ?? '—', icon: FileText, bg: 'bg-accent-50', iconColor: 'text-accent-500' },
    { label: 'Outstanding Balance', value: summary ? formatMoney(summary.outstandingBalance) : '—', icon: CreditCard, bg: 'bg-amber-50', iconColor: 'text-amber-500' },
    { label: 'Outstanding Bills', value: summary?.outstandingInvoiceCount ?? '—', icon: FolderOpen, bg: 'bg-violet-50', iconColor: 'text-violet-500' },
  ]

  // Skeleton loader
  if (loading) {
    return (
      <div className="space-y-5">
        <div className="h-8 w-48 bg-surface-100 rounded-lg animate-pulse" />
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-white rounded-2xl p-4 card-shadow">
              <div className="w-10 h-10 rounded-xl bg-surface-100 animate-pulse mb-3" />
              <div className="h-7 w-16 bg-surface-100 rounded animate-pulse mb-2" />
              <div className="h-3 w-24 bg-surface-50 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Welcome + refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-900">Welcome, {firstName} 👋</h1>
          <p className="text-sm text-surface-500 mt-0.5">{hospital?.name || 'Your Hospital'}</p>
        </div>
        <button
          onClick={() => loadData(true)}
          disabled={refreshing}
          className="p-2.5 rounded-xl bg-white card-shadow text-surface-400 hover:text-primary-500 transition-all-smooth"
          aria-label="Refresh"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        {cards.map((card) => {
          const Icon = card.icon
          const isBalance = card.label === 'Outstanding Balance'
          const hasOutstanding = isBalance && summary?.outstandingBalance > 0.01
          return (
            <div
              key={card.label}
              className="bg-white rounded-2xl p-4 card-shadow transition-all-smooth hover:card-shadow-lg"
            >
              <div className={`w-10 h-10 rounded-xl ${card.bg} flex items-center justify-center mb-3`}>
                <Icon size={20} className={card.iconColor} />
              </div>
              <div className={`text-xl font-bold ${hasOutstanding ? 'text-amber-600' : 'text-surface-900'}`}>
                {card.value}
              </div>
              <div className="text-xs text-surface-500 mt-0.5 leading-tight">{card.label}</div>
            </div>
          )
        })}
      </div>

      {/* Quick actions */}
      <div className="bg-white rounded-2xl card-shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-100">
          <h2 className="text-sm font-bold text-surface-700">Quick Actions</h2>
        </div>
        {[
          { label: 'View Lab Results', to: '/results', icon: FileText },
          { label: 'Pay Bills', to: '/bills', icon: CreditCard },
          { label: 'My Appointments', to: '/appointments', icon: Calendar },
          { label: 'My Documents', to: '/documents', icon: FolderOpen },
        ].map((item, i, arr) => {
          const Icon = item.icon
          return (
            <a
              key={item.label}
              href={item.to}
              className={`w-full flex items-center justify-between px-4 py-3.5 hover:bg-surface-50 transition-all-smooth ${
                i < arr.length - 1 ? 'border-b border-surface-100' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-surface-50 flex items-center justify-center">
                  <Icon size={16} className="text-surface-400" />
                </div>
                <span className="text-sm font-medium text-surface-700">{item.label}</span>
              </div>
              <ChevronRight size={18} className="text-surface-300" />
            </a>
          )
        })}
      </div>

      {/* Health tip */}
      <div className="bg-primary-50 rounded-xl p-4 flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
          <Calendar size={16} className="text-primary-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-primary-700">Health Tip</p>
          <p className="text-xs text-primary-600 mt-1">
            Regular check-ups help detect health issues early. Schedule your next appointment today.
          </p>
        </div>
      </div>
    </div>
  )
}
