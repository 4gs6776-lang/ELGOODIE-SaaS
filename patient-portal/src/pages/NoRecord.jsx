import { Link } from 'react-router-dom'
import { AlertCircle, LogIn } from 'lucide-react'

export default function NoRecord() {
  return (
    <div className="min-h-screen bg-surface-50 flex flex-col items-center justify-center px-6 safe-top safe-bottom">
      <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center mb-4">
        <AlertCircle size={32} className="text-amber-500" />
      </div>
      <h1 className="text-xl font-bold text-surface-900 mb-2">No Patient Record Found</h1>
      <p className="text-sm text-surface-500 mb-6 text-center max-w-xs">
        We couldn't find a patient record linked to your email. Please contact your hospital to register, or try logging in with a different email.
      </p>
      <Link
        to="/login"
        className="px-6 py-3 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-semibold text-sm flex items-center gap-2 transition-all-smooth"
      >
        <LogIn size={18} /> Back to Login
      </Link>
    </div>
  )
}
