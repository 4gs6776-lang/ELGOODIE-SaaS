-- =====================================================================
-- GOODIE-MEDHUB — 067_hospital_role_permissions.sql
-- =====================================================================
-- Customizable Role-Based Access Control (RBAC) per hospital.
--
-- Allows hospital Admins to configure which modules each role can
-- access and what actions (view/create/edit) they can perform.
--
-- Design:
--   - One row per (hospital_id, role, module) combination
--   - Boolean columns for each action: can_view, can_create, can_edit,
--     can_delete
--   - Owner role is ALWAYS full access (enforced by the frontend +
--     a DB constraint that prevents setting can_view=false for owner)
--   - CMD role is ALWAYS read-only (can_create/can_edit/can_delete
--     are forced to false regardless of what the admin sets)
--   - Admin role defaults to very wide access
--   - When no rows exist for a hospital, the frontend falls back to
--     the hardcoded defaults in permissions.js (backward compat)
--
-- Safe to re-run. Run AFTER 066_reconstruct_phase1_master_data.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Table: hospital_role_permissions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hospital_role_permissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,

  role            text NOT NULL CHECK (role IN (
                    'owner', 'admin', 'doctor', 'nurse', 'front_desk',
                    'pharmacist', 'lab', 'billing', 'cmd', 'staff'
                  )),
  module          text NOT NULL CHECK (module IN (
                    'overview', 'patients', 'reception', 'appointments',
                    'doctor', 'nursing', 'ipd', 'admissions', 'handover',
                    'pharmacy', 'laboratory', 'radiology', 'inventory',
                    'billing', 'insurance', 'reports', 'roster',
                    'messages', 'notifications', 'settings',
                    'ai_diagnostics', 'anc_patients', 'hmo_patients', 'staff'
                  )),

  can_view        boolean NOT NULL DEFAULT true,
  can_create      boolean NOT NULL DEFAULT false,
  can_edit        boolean NOT NULL DEFAULT false,
  can_delete      boolean NOT NULL DEFAULT false,

  -- Metadata
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One row per (hospital, role, module)
  CONSTRAINT hospital_role_permissions_unique UNIQUE (hospital_id, role, module)
);

-- Index for fast lookup by hospital + role
CREATE INDEX IF NOT EXISTS hospital_role_permissions_hospital_role_idx
  ON public.hospital_role_permissions (hospital_id, role);

-- ---------------------------------------------------------------------
-- RLS: hospital_role_permissions
-- ---------------------------------------------------------------------
-- READ: any hospital member can see the permissions (so the frontend
-- can build the permission object for the logged-in user).
-- WRITE: admin/owner only (they configure the permissions).
ALTER TABLE public.hospital_role_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hospital_role_permissions_select" ON public.hospital_role_permissions;
CREATE POLICY "hospital_role_permissions_select" ON public.hospital_role_permissions
  FOR SELECT USING (
    hospital_id = public.current_hospital_id() OR public.is_owner()
  );

DROP POLICY IF EXISTS "hospital_role_permissions_insert" ON public.hospital_role_permissions;
CREATE POLICY "hospital_role_permissions_insert" ON public.hospital_role_permissions
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id() AND public.is_hospital_admin()
  );

DROP POLICY IF EXISTS "hospital_role_permissions_update" ON public.hospital_role_permissions;
CREATE POLICY "hospital_role_permissions_update" ON public.hospital_role_permissions
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id() AND public.is_hospital_admin()
  ) WITH CHECK (
    hospital_id = public.current_hospital_id()
  );

DROP POLICY IF EXISTS "hospital_role_permissions_delete" ON public.hospital_role_permissions;
CREATE POLICY "hospital_role_permissions_delete" ON public.hospital_role_permissions
  FOR DELETE USING (
    hospital_id = public.current_hospital_id() AND public.is_hospital_admin()
  );

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_hospital_role_permissions_updated_at ON public.hospital_role_permissions;
CREATE TRIGGER trg_hospital_role_permissions_updated_at
  BEFORE UPDATE ON public.hospital_role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Add to realtime publication
ALTER TABLE public.hospital_role_permissions REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'hospital_role_permissions') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.hospital_role_permissions; END IF; END $$;

-- ---------------------------------------------------------------------
-- Safety constraints (DB-level enforcement)
-- ---------------------------------------------------------------------
-- 1. Owner role: can_view is ALWAYS true (can't be hidden from owner)
CREATE OR REPLACE FUNCTION public.enforce_owner_full_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Owner role: force can_view=true, can_create=true, can_edit=true, can_delete=true
  IF NEW.role = 'owner' THEN
    NEW.can_view := true;
    NEW.can_create := true;
    NEW.can_edit := true;
    NEW.can_delete := true;
  END IF;

  -- CMD role: force can_create=false, can_edit=false, can_delete=false
  -- (read-only, even if admin tries to enable writes)
  IF NEW.role = 'cmd' THEN
    NEW.can_create := false;
    NEW.can_edit := false;
    NEW.can_delete := false;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_owner_full_access ON public.hospital_role_permissions;
CREATE TRIGGER trg_enforce_owner_full_access
  BEFORE INSERT OR UPDATE ON public.hospital_role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_owner_full_access();

-- ---------------------------------------------------------------------
-- Seed: default permissions for every existing hospital
-- ---------------------------------------------------------------------
-- Seeds ONE row per (hospital, role, module) combination for the
-- configurable roles. Owner and admin are not seeded here because:
--   - Owner: the trigger forces full access (no rows needed)
--   - Admin: the frontend treats admin as full-access by default
--
-- For the other 8 roles (doctor, nurse, front_desk, pharmacist, lab,
-- billing, cmd, staff), we seed the EXACT same module access that
-- permissions.js currently hardcodes — so existing hospitals that
-- run this migration see ZERO behavior change.
--
-- Action defaults per role (matching the current BASELINE_MODULE_ACTIONS
-- + ROLE_ACTION_OVERRIDES from permissions.js):
--   - All roles get: can_view=true, can_create=false, can_edit=false, can_delete=false
--   - Plus the baseline: can_create=true, can_edit=true (for accessible modules)
--   - Plus overrides: doctor gets can_delete on 'doctor' module, etc.
--
-- NOTE: The seed is large (8 roles × ~22 modules = ~176 rows per hospital).
-- We use INSERT ... ON CONFLICT DO NOTHING so re-running is safe.
-- If a hospital already has custom rows (from a previous seed or from
-- the Admin UI), they are NOT overwritten.
-- =====================================================================

DO $$
DECLARE
  h RECORD;

  -- The modules each role can access (mirrors ROLE_MODULES from permissions.js)
  v_doctor_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'appointments',
    'doctor', 'ipd', 'admissions', 'handover', 'ai_diagnostics'
  ];
  v_nurse_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'appointments',
    'nursing', 'ipd', 'admissions', 'handover', 'reception',
    'laboratory', 'radiology', 'ai_diagnostics'
  ];
  v_front_desk_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'reception',
    'appointments', 'insurance', 'admissions'
  ];
  v_pharmacist_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'pharmacy',
    'inventory', 'handover'
  ];
  v_lab_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'laboratory',
    'radiology', 'handover'
  ];
  v_billing_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'billing',
    'insurance'
  ];
  v_staff_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings'
  ];
  v_cmd_modules text[] := ARRAY[
    'overview', 'roster', 'notifications', 'messages', 'settings',
    'patients', 'hmo_patients', 'anc_patients', 'reception',
    'appointments', 'doctor', 'nursing', 'ipd', 'admissions',
    'handover', 'pharmacy', 'laboratory', 'radiology', 'inventory',
    'billing', 'insurance', 'reports', 'ai_diagnostics', 'staff'
  ];

  m text;
BEGIN
  FOR h IN SELECT id FROM public.hospitals LOOP

    -- ---- Doctor ----
    -- Baseline: can_view=true, can_create=true, can_edit=true
    -- Override: can_delete=true on 'doctor' module
    FOREACH m IN ARRAY v_doctor_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'doctor', m, true, true, true, (m = 'doctor'))
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- Nurse ----
    -- Baseline: can_view=true, can_create=true, can_edit=true
    -- Override: can_archive on 'nursing' (not in our 4-action model; skip)
    FOREACH m IN ARRAY v_nurse_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'nurse', m, true, true, true, false)
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- Front Desk ----
    -- Baseline: can_view=true, can_create=true, can_edit=true
    -- Override: can_cancel on 'appointments' (not in our 4-action model; skip)
    FOREACH m IN ARRAY v_front_desk_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'front_desk', m, true, true, true, false)
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- Pharmacist ----
    FOREACH m IN ARRAY v_pharmacist_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'pharmacist', m, true, true, true, false)
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- Lab ----
    -- Baseline: can_view=true, can_create=true, can_edit=true
    -- Override: can_delete on 'laboratory' + 'radiology'
    FOREACH m IN ARRAY v_lab_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'lab', m, true, true, true, (m IN ('laboratory', 'radiology')))
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- Billing ----
    FOREACH m IN ARRAY v_billing_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'billing', m, true, true, true, false)
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- Staff ----
    -- Baseline: can_view=true only (no create/edit on most modules)
    FOREACH m IN ARRAY v_staff_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'staff', m, true, false, false, false)
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

    -- ---- CMD (read-only) ----
    -- can_view=true on all modules; can_create=false, can_edit=false,
    -- can_delete=false (the trigger enforces this even if we tried to
    -- set true)
    FOREACH m IN ARRAY v_cmd_modules LOOP
      INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
      VALUES (h.id, 'cmd', m, true, false, false, false)
      ON CONFLICT (hospital_id, role, module) DO NOTHING;
    END LOOP;

  END LOOP;
END $$;

-- =====================================================================
-- Verification queries (run after this migration)
-- =====================================================================
-- -- Count rows per hospital per role
-- SELECT hospital_id, role, COUNT(*) as module_count
--   FROM public.hospital_role_permissions
--  GROUP BY hospital_id, role
--  ORDER BY hospital_id, role;
--
-- -- Check a specific role's permissions
-- SELECT role, module, can_view, can_create, can_edit, can_delete
--   FROM public.hospital_role_permissions
--  WHERE hospital_id = '<your-hospital-id>' AND role = 'doctor'
--  ORDER BY module;
--
-- -- Verify the owner trigger: try to set can_view=false for owner
-- -- (should fail or be forced to true)
-- INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
-- VALUES ('<hospital-id>', 'owner', 'patients', false, false, false, false);
-- -- After insert, SELECT should show can_view=true, can_create=true, etc.
--
-- -- Verify the cmd trigger: try to set can_create=true for cmd
-- INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
-- VALUES ('<hospital-id>', 'cmd', 'patients', true, true, true, true);
-- -- After insert, SELECT should show can_create=false, can_edit=false, can_delete=false
-- =====================================================================
