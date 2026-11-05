// src/lib/useCurrentHospital.js
// Adapter that bridges the existing AuthContext (exposes { hospital, profile })
// to the shape the Revenue Cycle components expect: { hospitalId, userId, userRole }.
//
// Drop this file into src/lib/. If you already have a useCurrentHospital hook
// with the same shape, you can safely skip this file — the Revenue Cycle
// components only read hospitalId / userId / userRole.

import { useAuth } from '../context/AuthContext';

export function useCurrentHospital() {
  const { hospital, profile, session } = useAuth() || {};
  return {
    hospitalId: hospital?.id || session?.user?.user_metadata?.hospital_id || null,
    userId: profile?.id || session?.user?.id || null,
    userRole: profile?.role || session?.user?.user_metadata?.role || 'staff',
    hospital,
    profile,
  };
}
