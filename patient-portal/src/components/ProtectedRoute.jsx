import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children, requirePhoneVerify = true }) {
  const { isAuthenticated, patient, phoneVerified, loading } = useAuth()

  // Still loading — show a spinner
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-50">
        <div className="w-8 h-8 border-3 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
      </div>
    )
  }

  // Not logged in — redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  // Logged in but no patient record — show "no record" page
  if (!patient) {
    return <Navigate to="/no-record" replace />
  }

  // Phone verification required but not done yet
  if (requirePhoneVerify && !phoneVerified) {
    return <Navigate to="/verify-phone" replace />
  }

  return children
}
