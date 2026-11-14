import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import LiquidLoader from './common/LiquidLoader'

export default function ProtectedRoute({ children }){
  const { session, loading } = useAuth()

  if (loading) {
    return <LiquidLoader variant="screen" label="Loading" />
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return children
}
