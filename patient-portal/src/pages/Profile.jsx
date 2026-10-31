import { useAuth } from '../context/AuthContext'
import { User, Phone, Mail, Calendar, Users, FileText, LogOut } from 'lucide-react'

export default function Profile() {
  const { patient, hospital, logout } = useAuth()

  const fields = [
    { label: 'Full Name', value: patient?.full_name, icon: User },
    { label: 'Phone Number', value: patient?.phone, icon: Phone },
    { label: 'Email', value: patient?.email, icon: Mail },
    { label: 'Gender', value: patient?.gender, icon: Users },
    { label: 'Date of Birth', value: patient?.date_of_birth, icon: Calendar },
    { label: 'Hospital Number', value: patient?.patient_id || patient?.hospital_number, icon: FileText },
  ]

  return (
    <div className="space-y-5">
      {/* Avatar + name */}
      <div className="flex flex-col items-center py-4">
        <div className="w-20 h-20 rounded-full bg-primary-100 flex items-center justify-center mb-3">
          <span className="text-2xl font-bold text-primary-600">
            {(patient?.full_name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
          </span>
        </div>
        <h1 className="text-lg font-bold text-surface-900">{patient?.full_name || 'Patient'}</h1>
        <p className="text-sm text-surface-500">{hospital?.name || ''}</p>
      </div>

      {/* Info card */}
      <div className="bg-white rounded-2xl card-shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-100">
          <h2 className="text-sm font-bold text-surface-700">Personal Information</h2>
        </div>
        {fields.map((field, i) => {
          const Icon = field.icon
          return (
            <div
              key={field.label}
              className={`flex items-center gap-3 px-4 py-3.5 ${i < fields.length - 1 ? 'border-b border-surface-100' : ''}`}
            >
              <div className="w-9 h-9 rounded-lg bg-surface-50 flex items-center justify-center flex-shrink-0">
                <Icon size={16} className="text-surface-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-surface-400">{field.label}</div>
                <div className="text-sm font-semibold text-surface-700 truncate">
                  {field.value || '—'}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Hospital info */}
      {hospital && (
        <div className="bg-white rounded-2xl card-shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-100">
            <h2 className="text-sm font-bold text-surface-700">Hospital</h2>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-sm font-semibold text-surface-700">{hospital.name}</div>
            {hospital.phone && <div className="text-xs text-surface-400 mt-0.5">{hospital.phone}</div>}
          </div>
        </div>
      )}

      {/* Logout */}
      <button
        onClick={logout}
        className="w-full py-3.5 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 font-semibold text-sm flex items-center justify-center gap-2 transition-all-smooth"
      >
        <LogOut size={18} /> Log Out
      </button>
    </div>
  )
}
