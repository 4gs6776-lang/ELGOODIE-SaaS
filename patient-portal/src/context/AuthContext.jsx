import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [patient, setPatient] = useState(null)
  const [hospital, setHospital] = useState(null)
  const [loading, setLoading] = useState(true)
  const [phoneVerified, setPhoneVerified] = useState(false)

  // Load patient profile + hospital from the database after login
  const loadPatientData = useCallback(async (email) => {
    if (!email) return
    try {
      // Search the patients table by email
      const { data: patientData, error: patientErr } = await supabase
        .from('patients')
        .select('*')
        .eq('email', email)
        .maybeSingle()

      if (patientErr) {
        console.error('Error loading patient:', patientErr)
        return
      }

      if (!patientData) {
        console.warn('No patient record found for email:', email)
        setPatient(null)
        setHospital(null)
        return
      }

      setPatient(patientData)
      setPhoneVerified(false) // Reset phone verification on each load

      // Load the hospital
      if (patientData.hospital_id) {
        const { data: hospitalData, error: hospitalErr } = await supabase
          .from('hospitals')
          .select('*')
          .eq('id', patientData.hospital_id)
          .maybeSingle()

        if (!hospitalErr && hospitalData) {
          setHospital(hospitalData)
        }
      }
    } catch (err) {
      console.error('loadPatientData error:', err)
    }
  }, [])

  // Listen for auth state changes
  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      setSession(initialSession)
      setUser(initialSession?.user || null)
      if (initialSession?.user?.email) {
        loadPatientData(initialSession.user.email)
      }
      setLoading(false)
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        setSession(newSession)
        setUser(newSession?.user || null)
        if (newSession?.user?.email) {
          await loadPatientData(newSession.user.email)
        } else {
          setPatient(null)
          setHospital(null)
          setPhoneVerified(false)
        }
        setLoading(false)
      }
    )

    return () => subscription.unsubscribe()
  }, [loadPatientData])

  // Login with email + password
  const login = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    return { data, error }
  }, [])

  // Sign up (self-registration) — patient creates their own account
  const signup = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signUp({ email, password })
    return { data, error }
  }, [])

  // Verify phone number matches the patient record
  const verifyPhone = useCallback(async (phone) => {
    if (!patient) return { verified: false, error: 'No patient record loaded' }

    const patientPhone = (patient.phone || '').replace(/\s+/g, '').replace(/-/g, '')
    const inputPhone = (phone || '').replace(/\s+/g, '').replace(/-/g, '')

    // Check if the last 10 digits match (handles +234 vs 0 prefix differences)
    const normalizePhone = (p) => p.replace(/^\+?234/, '0').replace(/^0+/, '0')
    const normalized1 = normalizePhone(patientPhone)
    const normalized2 = normalizePhone(inputPhone)

    if (normalized1 === normalized2 || patientPhone === inputPhone) {
      setPhoneVerified(true)
      return { verified: true }
    }

    return { verified: false, error: 'Phone number does not match our records. Please use the phone number registered with your hospital.' }
  }, [patient])

  // Logout
  const logout = useCallback(async () => {
    await supabase.auth.signOut()
    setSession(null)
    setUser(null)
    setPatient(null)
    setHospital(null)
    setPhoneVerified(false)
  }, [])

  const value = {
    session,
    user,
    patient,
    hospital,
    loading,
    phoneVerified,
    login,
    signup,
    verifyPhone,
    logout,
    isAuthenticated: !!session,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
