import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import LiquidLoader from './common/LiquidLoader'

export default function OwnerRoute({ children }){
  const { session, loading, isOwner } = useAuth()

  if (loading) {
    return <LiquidLoader variant="screen" label="Loading" />
  }

  if (!session) return <Navigate to="/login" replace />
  if (!isOwner) return <Navigate to="/dashboard" replace />

  return children
}
