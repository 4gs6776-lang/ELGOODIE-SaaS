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
// BUGFIX (requirement 1): `previousHospitalRef` was created with
// `useState(null)` — but useState returns a 2-tuple `[value, setter]`,
// not a ref object. So `previousHospitalRef.current` was always
// `undefined` (the tuple has no `.current` property), and the line
// `previousHospitalRef.current = profileData.hospital_id` silently
// set index 1 (the setter function) to the hospital UUID — meaning
// the hospital-switch cursor-clearing logic NEVER fired. The user
// could switch from Hospital A to Hospital B and the local cursor
// for A would remain, so the next login to A would skip rows added
// during the visit to B.
//
// FIX: use `useRef(null)` instead. `useRef` returns a stable object
// with a `.current` property; assignment works as expected and
// never triggers a re-render.
//
// INVARIANTS enforced by this file:
//   * `previousHospitalRef.current` is set to the new hospital_id
//     AFTER `clearCursorsOnHospitalSwitch(previous)` runs, so a
//     switch from A → B clears A's cursors.
//   * On logout, `previousHospitalRef.current` is reset to null so
//     a subsequent login as a DIFFERENT user does not think it is
//     "switching" from the previous user's hospital.
//   * On initial mount, `previousHospitalRef.current` starts null,
//     so the first login does not trigger a hospital-switch clear
//     (there is nothing to clear).
// =====================================================================
export function AuthProvider({ children }){
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [hospital, setHospital] = useState(null)
  const [loading, setLoading] = useState(true)
  // FIX: useRef, NOT useState. This is a mutable reference to the
  // last hospital_id we successfully loaded — used only to detect
  // hospital switching for cursor clearing. It must NEVER trigger
  // a re-render on its own.
  const previousHospitalRef = useRef(null)
  // The currently-authenticated user id, used by the offline queue
  // to assert that any record being uploaded still belongs to the
  // signed-in user. This is the security anchor for requirement 3
  // (cross-hospital queue processing) and requirement 9 (security).
  const currentUserIdRef = useRef(null)

  // Closure that captures `session` for use inside async retries
  // (loadProfileAndHospital is recursive and needs the latest
  // session, not the one captured at function-definition time).
  // We refresh this ref on every render so retries always see the
  // latest session.
  const sessionRef = useRef(session)
  sessionRef.current = session

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
      // Do NOT touch previousHospitalRef here — we may still be the
      // same user as before; clearing it would mask a real hospital
      // switch on the next successful load.
      return
    }

    // Email/phone come from the auth session (auth.users.email), not
    // from profiles — the profiles table does not have those columns.
    // We attach them here so existing components that read
    // `profile.email` keep working without a second fetch. We use
    // sessionRef.current (the latest) instead of `session` (which
    // may be stale inside a recursive retry).
    const currentSession = sessionRef.current
    if (currentSession?.user?.email) {
      profileData.email = currentSession.user.email
    }
    if (currentSession?.user?.phone) {
      profileData.phone = currentSession.user.phone
    }

    setProfile(profileData)
    // Record the authenticated user id for the offline queue's
    // security check (requirement 3 + 9).
    currentUserIdRef.current = userId

    // Tell the subscription lock layer about the user's role so it can
    // refuse writes for read-only roles (CMD). This must happen BEFORE
    // any component tries to write, so we do it synchronously here.
    setUserRole(profileData.role)

    if (!profileData.hospital_id) {
      // User has no hospital — set hospital to null but DO NOT clear
      // previousHospitalRef. If they acquire a hospital later (via
      // owner-admin action), the next load will see the difference
      // and clear the old cursors.
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

    // -----------------------------------------------------------------
    // HOSPITAL SWITCHING — clear the previous hospital's offline
    // cursors so the new hospital re-bootstraps on next login.
    //
    // Conditions for a "real" switch (all must be true):
    //   1. We had a previous hospital_id (not null).
    //   2. The new hospital_id is different from the previous.
    //   3. The previous hospital_id is not null (avoids clearing on
    //      the very first login of a brand-new device).
    //
    // We deliberately do NOT clear records — only cursors. Records
    // for the old hospital stay in IndexedDB but are scoped out by
    // `hospital_id === current` on every read (see useOfflineTable).
    //
    // SECURITY: hospital switching is a SIGNAL to clear local
    // optimization state, not an authorization boundary. The actual
    // authorization is enforced by Supabase RLS — the frontend can
    // never read or write another hospital's rows from Supabase, and
    // the IndexedDB cache is filtered by hospital_id on every read.
    // -----------------------------------------------------------------
    const previousHospital = previousHospitalRef.current
    if (previousHospital && previousHospital !== profileData.hospital_id) {
      try {
        await clearCursorsOnHospitalSwitch(previousHospital)
      } catch (err) {
        // Never crash the auth flow on cursor cleanup failure —
        // the next sync will just be slightly stale, not broken.
        console.error('Could not clear cursors on hospital switch:', err)
      }
    }
    // Always update the ref to the latest hospital_id, even on the
    // first login (so the next switch detects the change).
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
        // SIGN OUT / session expired.
        // Reset the previous-hospital ref so a subsequent login as
        // a different user (or the same user in a different hospital)
        // does not think it is "switching" from the previous user's
        // hospital — there is no previous user anymore.
        setProfile(null)
        setHospital(null)
        previousHospitalRef.current = null
        currentUserIdRef.current = null
        clearUserRole()
        setLoading(false)
      }
    })

    return () => listener.subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  async function signOut(){
    // Upload leftovers and wipe synced patient data from this device first,
    // while the session is still valid. Capped at 6 seconds so a slow
    // network can never trap someone on the logout button.
    //
    // SECURITY (requirement 3): clearLocalDataOnLogout() preserves
    // unsynced clinical records — they are NOT deleted. They will be
    // uploaded the next time someone with access to the same hospital
    // logs in. This is the safe account-aware recovery path.
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
    currentUserIdRef.current = null
    await supabase.auth.signOut()
  }

  async function reload(){
    if (session?.user) {
      await loadProfileAndHospital(session.user.id)
    }
  }

  const isOwner = profile?.role === 'owner'

  // Expose currentUserIdRef via the context so the offline queue
  // (useOfflineTable.flushTableQueue) can verify that a record about
  // to be uploaded still belongs to the currently-authenticated user.
  // This is the SECURITY ANCHOR for requirement 3.
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
        // Read-only accessor for the offline queue. NEVER use this as
        // authorization on its own — Supabase RLS is the real
        // authority. This is only a frontend guard so we do not
        // accidentally send records to the wire that no longer belong
        // to the current user.
        getCurrentUserId: () => currentUserIdRef.current,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(){
  return useContext(AuthContext)
}
