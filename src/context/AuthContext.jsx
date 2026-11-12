import { createContext, useContext, useEffect, useState, useRef } from 'react'
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

// =====================================================================
// AUTH PROVIDER
//
// FIXES:
//   1. previousHospitalRef was created with `useState(null)` — that
//      returns a tuple `[value, setter]`, not a ref. `previousHospitalRef.current`
//      was always `undefined` and the cursor-clearing logic NEVER fired.
//      Now uses `useRef(null)`.
//
//   2. Owner hospital selection: an owner profile may have
//      `hospital_id = null`. The previous code set `setHospital(null)`
//      and the dashboard showed "No patients found" — wrong. Now the
//      AuthContext loads the list of hospitals the owner is authorized
//      to manage, exposes them via `ownerHospitals`, and the owner
//      must explicitly select one via `selectOwnerHospital(id)`.
//      The selected hospital is persisted in localStorage so it
//      survives refresh. The selection is cleared on logout.
//
//   3. The hospital context is now consistent across the dashboard
//      and all modules — they all read `hospital` from useAuth(),
//      which is either the profile's hospital (for non-owners) or
//      the owner-selected hospital (for owners).
// =====================================================================
export function AuthProvider({ children }){
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [hospital, setHospital] = useState(null)
  const [loading, setLoading] = useState(true)
  // FIX: useRef, NOT useState. This is a mutable reference to the
  // last hospital_id we successfully loaded — used only to detect
  // hospital switching for cursor clearing.
  const previousHospitalRef = useRef(null)
  // FIX: owner hospital selection. When an owner logs in, their
  // profile.hospital_id is null. We load the list of hospitals they
  // can manage and let them pick one.
  const [ownerHospitals, setOwnerHospitals] = useState([])
  const [ownerSelectedHospitalId, setOwnerSelectedHospitalId] = useState(null)

  // Closure that captures `session` for use inside async retries.
  const sessionRef = useRef(session)
  sessionRef.current = session

  async function loadProfileAndHospital(userId, attempt = 1){
    const { data: profileData, error: profileErr } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle()

    if (profileErr || !profileData) {
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

    const currentSession = sessionRef.current
    if (currentSession?.user?.email) {
      profileData.email = currentSession.user.email
    }
    if (currentSession?.user?.phone) {
      profileData.phone = currentSession.user.phone
    }

    setProfile(profileData)
    setUserRole(profileData.role)

    // FIX: owner hospital selection. If the profile is an owner
    // with no hospital_id, load the list of hospitals they can
    // manage. The owner must explicitly select one before the
    // dashboard loads hospital-specific data.
    if (profileData.role === 'owner' && !profileData.hospital_id) {
      await loadOwnerHospitals()
      // If the owner previously selected a hospital, restore it.
      const savedId = typeof localStorage !== 'undefined'
        ? localStorage.getItem('gmh.owner.selectedHospitalId')
        : null
      if (savedId) {
        await selectOwnerHospital(savedId)
      } else {
        // No hospital selected — the dashboard will show the
        // hospital-picker, NOT "No patients found".
        setHospital(null)
      }
      return
    }

    if (!profileData.hospital_id) {
      setHospital(null)
      return
    }

    // Non-owner: load the profile's hospital.
    await loadHospitalById(profileData.hospital_id)
  }

  // Load a hospital by ID and set it as the active context. Also
  // handles hospital-switching cursor cleanup.
  async function loadHospitalById(hospitalId){
    const { data: hospitalData, error: hospitalErr } = await supabase
      .from('hospitals')
      .select('*')
      .eq('id', hospitalId)
      .maybeSingle()

    if (hospitalErr) {
      console.error('Could not load hospital:', hospitalErr)
      setHospital(null)
      return
    }

    // Hospital switching: clear cursors for the previous hospital so
    // the new hospital's data is re-bootstrapped.
    const previousHospital = previousHospitalRef.current
    if (previousHospital && previousHospital !== hospitalId) {
      try {
        await clearCursorsOnHospitalSwitch(previousHospital)
      } catch (err) {
        console.error('Could not clear cursors on hospital switch:', err)
      }
    }
    previousHospitalRef.current = hospitalId
    setHospital(hospitalData || null)
  }

  // FIX: owner hospital selection — load the list of hospitals the
  // owner is authorized to manage. The backend's RLS policies on
  // `hospitals` already restrict this to hospitals the owner can
  // see; we trust RLS, not a local check.
  async function loadOwnerHospitals(){
    try {
      const { data, error } = await supabase
        .from('hospitals')
        .select('id, name, mrn_prefix')
        .order('name', { ascending: true })
      if (!error && Array.isArray(data)) {
        setOwnerHospitals(data)
      }
    } catch (err) {
      console.error('Could not load owner hospitals:', err)
    }
  }

  // FIX: owner hospital selection — the owner picks a hospital from
  // the list. The selection is persisted in localStorage so it
  // survives refresh. The actual authorization is enforced by RLS —
  // if the owner tries to select a hospital they cannot manage, the
  // subsequent data loads will return empty (RLS blocks the read).
  async function selectOwnerHospital(hospitalId){
    if (!hospitalId) {
      setOwnerSelectedHospitalId(null)
      setHospital(null)
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('gmh.owner.selectedHospitalId')
      }
      return
    }
    setOwnerSelectedHospitalId(hospitalId)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('gmh.owner.selectedHospitalId', hospitalId)
    }
    await loadHospitalById(hospitalId)
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
        setOwnerHospitals([])
        setOwnerSelectedHospitalId(null)
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('gmh.owner.selectedHospitalId')
        }
        clearUserRole()
        setLoading(false)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])


  async function signOut(){
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
    setOwnerHospitals([])
    setOwnerSelectedHospitalId(null)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('gmh.owner.selectedHospitalId')
    }
    await supabase.auth.signOut()
  }

  async function reload(){
    if (session?.user) {
      await loadProfileAndHospital(session.user.id)
    }
  }

  const isOwner = profile?.role === 'owner'

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        hospital,
        loading,
        signOut,
        reload,
        isOwner,
        // FIX: owner hospital selection — exposed so the dashboard
        // can render the hospital-picker when the owner has not
        // selected a hospital.
        ownerHospitals,
        ownerSelectedHospitalId,
        selectOwnerHospital,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(){
  return useContext(AuthContext)
}
