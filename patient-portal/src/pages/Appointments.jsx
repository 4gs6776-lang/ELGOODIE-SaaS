import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchAppointments } from '../lib/patientDataService'
import { Calendar, ChevronRight, RefreshCw, Clock, CheckCircle2, XCircle, CalendarPlus } from 'lucide-react'

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function formatTime(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function statusBadge(status) {
  const s = (status || '').toLowerCase()
  if (['scheduled', 'confirmed'].includes(s)) return { label: s === 'confirmed' ? 'Confirmed' : 'Scheduled', color: 'text-primary-600', bg: 'bg-primary-50', icon: Clock }
  if (['completed', 'done'].includes(s)) return { label: 'Completed', color: 'text-accent-600', bg: 'bg-accent-50', icon: CheckCircle2 }
  if (['cancelled', 'canceled'].includes(s)) return { label: 'Cancelled', color: 'text-red-500', bg: 'bg-red-50', icon: XCircle }
  if (s === 'pending') return { label: 'Pending', color: 'text-amber-600', bg: 'bg-amber-50', icon: Clock }
  return { label: status || '—', color: 'text-surface-500', bg: 'bg-surface-50', icon: Clock }
}

export default function Appointments() {
  const { patient } = useAuth()
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadData = useCallback(async (isRefresh = false) => {
    if (!patient?.id) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const { data, error } = await fetchAppointments(patient.id, patient.hospital_id)
      if (error) setError(error)
      else setAppointments(data || [])
    } catch (err) {
      setError(err.message || 'Could not load appointments')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [patient?.id, patient?.hospital_id])

  useEffect(() => { loadData() }, [loadData])

  const today = new Date().toISOString().slice(0, 10)
  const upcoming = appointments.filter(a => (a.appointment_date || a.date || '') >= today).reverse()
  const past = appointments.filter(a => (a.appointment_date || a.date || '') < today)

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-7 w-48 bg-surface-100 rounded-lg animate-pulse" />
        {[1, 2].map(i => <div key={i} className="bg-white rounded-2xl p-4 card-shadow h-24 animate-pulse" />)}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-surface-900">Appointments</h1>
        <button onClick={() => loadData(true)} disabled={refreshing} className="p-2 rounded-lg text-surface-400 hover:text-primary-500">
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>}

      {/* Request follow-up button */}
      <a
        href={`https://wa.me/${patient?.phone?.replace(/[^0-9]/g, '').replace(/^0/, '234') || ''}?text=Hello, I would like to request a follow-up appointment.`}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full py-3 rounded-xl bg-primary-50 hover:bg-primary-100 text-primary-600 font-semibold text-sm flex items-center justify-center gap-2 transition-all-smooth"
      >
        <CalendarPlus size={18} /> Request Follow-up (WhatsApp)
      </a>

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-surface-600 mb-2">Upcoming</h2>
          <div className="space-y-2">
            {upcoming.map(apt => {
              const badge = statusBadge(apt.status)
              const StatusIcon = badge.icon
              return (
                <div key={apt.id} className="bg-white rounded-2xl p-4 card-shadow">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className={`w-10 h-10 rounded-xl ${badge.bg} flex items-center justify-center flex-shrink-0`}>
                        <StatusIcon size={18} className={badge.color} />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-surface-900">{formatDate(apt.appointment_date || apt.date)}</div>
                        <div className="text-xs text-surface-400 mt-0.5">
                          {formatTime(apt.appointment_date || apt.date) || 'All day'}
                          {apt.doctor_name && ` · ${apt.doctor_name}`}
                          {apt.department && ` · ${apt.department}`}
                        </div>
                        {apt.reason && <div className="text-xs text-surface-500 mt-1">{apt.reason}</div>}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.bg} ${badge.color}`}>{badge.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Past */}
      {past.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-surface-400 mb-2">Past Appointments</h2>
          <div className="space-y-2">
            {past.map(apt => {
              const badge = statusBadge(apt.status)
              return (
                <div key={apt.id} className="bg-white rounded-xl p-3.5 card-shadow opacity-75">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-surface-700">{formatDate(apt.appointment_date || apt.date)}</div>
                      <div className="text-xs text-surface-400">
                        {apt.doctor_name || apt.department || '—'}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.bg} ${badge.color}`}>{badge.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {appointments.length === 0 && !error && (
        <div className="bg-white rounded-2xl card-shadow p-8 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-surface-100 flex items-center justify-center mb-3">
            <Calendar size={28} className="text-surface-300" />
          </div>
          <p className="text-sm font-semibold text-surface-700">No appointments</p>
          <p className="text-xs text-surface-400 mt-1 max-w-xs">
            Your upcoming and past appointments will appear here.
          </p>
        </div>
      )}
    </div>
  )
}
