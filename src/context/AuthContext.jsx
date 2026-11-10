import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { setUserRole, clearUserRole } from '../lib/subscriptionLock'
import { clearLocalDataOnLogout } from '../lib/useOfflineTable'

// Exported so the QA harness (qa.html) can mount a mocked provider —
// production code always uses AuthProvider/useAuth; this changes nothing.
export const AuthContext = createContext(null)

function wait(ms){ return new Promise(resolve => setTimeout(resolve, ms)) }

export function AuthProvider({ children }){
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [hospital, setHospital] = useState(null)
  const [loading, setLoading] = useState(true)

  async function loadProfileAndHospital(userId, attempt = 1){
    const { data: profileData, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (profileErr || !profileData) {
      if (attempt < 6) {
        await wait(700)
        return loadProfileAndHospital(userId, attempt + 1)
      }
      setProfile(null)
      setHospital(null)
      return
    }
    setProfile(profileData)

    // Tell the subscription lock layer about the user's role so it can
    // refuse writes for read-only roles (CMD). This must happen BEFORE
    // any component tries to write, so we do it synchronously here.
    setUserRole(profileData.role)

    if (!profileData.hospital_id) {
      setHospital(null)
      return
    }

    const { data: hospitalData } = await supabase
      .from('hospitals')
      .select('*')
      .eq('id', profileData.hospital_id)
      .maybeSingle()

    setHospital(hospitalData || null)
  }
useEffect(() => {
  supabase.auth.getSession().then(async ({ data: { session } }) => {
    setSession(session)
    try {
      if (session?.user) {
        await loadProfileAndHospital(session.user.id)
      }
    } finally {
      setLoading(false)
    }
  })

  const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
    setSession(session)
    if (session?.user) {
      setLoading(true)
      setTimeout(async () => {
        try {
          await loadProfileAndHospital(session.user.id)
        } finally {
          setLoading(false)
        }
      }, 0)
    } else {
      setProfile(null)
      setHospital(null)
      clearUserRole()
      setLoading(false)
    }
  })

  return () => listener.subscription.unsubscribe()
}, [])


  async function signOut(){
    // Upload leftovers and wipe synced patient data from this device first,
    // while the session is still valid. Capped at 6 seconds so a slow
    // network can never trap someone on the logout button.
    try {
      await Promise.race([
        clearLocalDataOnLogout(),
        new Promise(resolve => setTimeout(resolve, 6000)),
      ])
    } catch (err) {
      console.error('Logout cleanup failed:', err)
    }
    clearUserRole()
    await supabase.auth.signOut()
  }

  async function reload(){
    if (session?.user) {
      await loadProfileAndHospital(session.user.id)
    }
  }

  const isOwner = profile?.role === 'owner'

  return (
    <AuthContext.Provider value={{ session, profile, hospital, loading, signOut, reload, isOwner }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(){
  return useContext(AuthContext)
}
