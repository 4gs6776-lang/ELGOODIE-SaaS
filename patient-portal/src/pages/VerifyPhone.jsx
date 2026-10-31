import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Phone, ArrowRight, ShieldCheck } from 'lucide-react'

export default function VerifyPhone() {
  const { patient, verifyPhone } = useAuth()
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleVerify(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { verified, error: verifyError } = await verifyPhone(phone)
      if (verified) {
        navigate('/')
      } else {
        setError(verifyError || 'Phone number does not match.')
      }
    } catch (err) {
      setError(err.message || 'Verification failed.')
    } finally {
      setLoading(false)
    }
  }

  // Show last 2 digits of the phone as a hint
  const phoneHint = patient?.phone
    ? `Ending in ...${patient.phone.slice(-4)}`
    : 'Use the phone number registered with your hospital'

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary-50 to-white flex flex-col items-center justify-center px-6 safe-top safe-bottom">
      <div className="w-16 h-16 rounded-2xl bg-accent-500 flex items-center justify-center mb-4 shadow-lg shadow-accent-200">
        <ShieldCheck size={32} className="text-white" />
      </div>
      <h1 className="text-xl font-bold text-surface-900 mb-1">Verify Your Phone</h1>
      <p className="text-sm text-surface-500 mb-6 text-center max-w-xs">
        For your security, please enter the phone number registered with your hospital to access your records.
      </p>

      {error && (
        <div className="mb-4 w-full max-w-sm p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">
          {error}
        </div>
      )}

      <form onSubmit={handleVerify} className="w-full max-w-sm space-y-4">
        <div>
          <label className="text-xs font-semibold text-surface-600 mb-1.5 block">Phone Number</label>
          <div className="relative">
            <Phone size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="0803 123 4567"
              className="w-full pl-10 pr-4 py-3 text-sm rounded-xl border border-surface-200 bg-surface-50 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent transition-all-smooth"
              required
              autoFocus
            />
          </div>
          <p className="text-xs text-surface-400 mt-1.5">{phoneHint}</p>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-xl bg-accent-500 hover:bg-accent-600 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all-smooth disabled:opacity-50"
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              Verify & Continue <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
    </div>
  )
}
