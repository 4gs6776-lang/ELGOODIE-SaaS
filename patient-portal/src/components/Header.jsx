import { useAuth } from '../context/AuthContext'
import { Stethoscope, LogOut, Phone } from 'lucide-react'

export default function Header({ title }) {
  const { hospital, logout } = useAuth()

  return (
    <header className="safe-top bg-white border-b border-surface-200 sticky top-0 z-30">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {/* Hospital logo or fallback icon */}
          {hospital?.logo_url ? (
            <img
              src={hospital.logo_url}
              alt={hospital?.name || 'Hospital'}
              className="w-9 h-9 rounded-lg object-contain flex-shrink-0"
            />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
              <Stethoscope size={20} className="text-primary-500" />
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm font-bold text-surface-900 truncate">
              {title || hospital?.name || 'GOODIE-MEDHUB'}
            </div>
            <div className="text-[10px] text-surface-400">Patient Portal</div>
          </div>
        </div>
        <button
          onClick={logout}
          className="p-2 rounded-lg text-surface-400 hover:text-red-500 hover:bg-red-50 transition-all-smooth"
          aria-label="Logout"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  )
}
