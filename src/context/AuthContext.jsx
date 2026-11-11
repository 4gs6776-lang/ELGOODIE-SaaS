import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { setUserRole, clearUserRole } from '../lib/subscriptionLock'
import {
  clearLocalDataOnLogout,
  clearCursorsOnHospitalSwitch,
} from '../lib/useOfflineTable'

// Exported so the QA harness (qa.html) can mount a mocked provider —
// production code always uses AuthProvider/useAuth; this changes nothing.
export const AuthContext = createContext(null)

function wait(ms){ return new Promise(resolve => setTimeout(resolve, ms)) }

// Verified columns on `profiles` (see migration 013 staff roles and
// migration 020 cmd role). We deliberately select ONLY the columns
// the frontend reads; never `select('*')` against profiles again —
// that returned whatever columns happened to exist, including columns
// that the schema-cache had not refreshed yet (PGRST204) and columns
// that did not belong on the profile (email lives on auth.users).
//
// If a future migration adds a column the UI needs, add it here AND
// coordinate the deployment order with the backend owner so the
// column lands BEFORE the frontend ships.
const PROFILE_COLUMNS = [
  'id',
  'hospital_id',
  'full_name',
  'role',
  'active',
  'facility_id',
].join(',')

export function AuthProvider({ children }){
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [hospital, setHospital] = useState(null)
  const [loading, setLoading] = useState(true)
  // Track the previous hospital so we can clear its offline cursors
  // when the user switches (multi-hospital admin / account switching).
  const previousHospitalRef = useState(null)

  async function loadProfileAndHospital(userId, attempt = 1){
    // Use verified columns — `select('*')` against profiles was the
    // source of multiple 400 errors when the schema cache had not
    // refreshed. Email lives on auth.users, not profiles; we read it
    // from the session below.
    const { data: profileData, error: profileErr } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle()

    if (profileErr || !profileData) {
      // PGRST116 / no rows: the profile is being created by a trigger
      // — retry a few times before giving up. Network errors get the
      // same retry, but auth/permission errors should NOT loop
      // forever; we cap at 6 attempts.
      const code = profileErr?.code
      const isRetryable = !code || code === 'PGRST116' || code === '22P02'
      if (attempt < 6 && isRetryable) {
        await wait(700)
        return loadProfileAndHospital(userId, attempt + 1)
      }
      setProfile(null)
      setHospital(null)
      return
    }

    // Email/phone come from the auth session (auth.users.email), not
    // from profiles — the profiles table does not have those columns.
    // We attach them here so existing components that read
    // `profile.email` keep working without a second fetch.
    if (session?.user?.email) {
      profileData.email = session.user.email
    }
    if (session?.user?.phone) {
      profileData.phone = session.user.phone
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

    const { data: hospitalData, error: hospitalErr } = await supabase
      .from('hospitals')
      .select('*')
      .eq('id', profileData.hospital_id)
      .maybeSingle()

    if (hospitalErr) {
      console.error('Could not load hospital:', hospitalErr)
      setHospital(null)
      return
    }

    // Hospital switching: clear cursors for the previous hospital so
    // the new hospital's data is re-bootstrapped. Records for the old
    // hospital stay in IndexedDB but are scoped out by hospital_id
    // on every read (see useOfflineTable.loadLocalRecords).
    const previousHospital = previousHospitalRef.current
    if (previousHospital && previousHospital !== profileData.hospital_id) {
      try {
        await clearCursorsOnHospitalSwitch(previousHospital)
      } catch (err) {
        console.error('Could not clear cursors on hospital switch:', err)
      }
    }
    previousHospitalRef.current = profileData.hospital_id

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
        previousHospitalRef.current = null
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
    previousHospitalRef.current = null
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
