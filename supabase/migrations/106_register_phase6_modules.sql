-- =====================================================================
-- GOODIE-MEDHUB — 106_register_phase6_modules.sql
-- ---------------------------------------------------------------------
-- Registers the three new Phase 6 modules (delivery, operating_theatre,
-- discharge) in the hospital_role_permissions table so they show up in
-- the admin RBAC UI and can be granted to roles per-hospital.
--
-- The hospital_role_permissions.module column has a CHECK constraint
-- that lists allowed values; we must first relax that constraint to
-- accept the three new module keys, then seed default permissions
-- matching what permissions.js declares as the fallback defaults.
--
-- Safe to re-run: every statement is guarded / idempotent.
-- =====================================================================

-- -----------------------------------------------------------------
-- 1. Relax the CHECK constraint on hospital_role_permissions.module
--    to accept the three new module values.
-- -----------------------------------------------------------------
ALTER TABLE public.hospital_role_permissions
  DROP CONSTRAINT IF EXISTS hospital_role_permissions_module_check;

ALTER TABLE public.hospital_role_permissions
  ADD CONSTRAINT hospital_role_permissions_module_check CHECK (module IN (
    'overview', 'patients', 'reception', 'appointments',
    'doctor', 'nursing', 'ipd', 'admissions', 'handover',
    'pharmacy', 'laboratory', 'radiology', 'inventory',
    'billing', 'insurance', 'reports', 'roster',
    'messages', 'notifications', 'settings',
    'ai_diagnostics', 'anc_patients', 'hmo_patients', 'staff',
    -- Phase 6: clinical workflow modules
    'delivery', 'operating_theatre', 'discharge'
  ));

-- -----------------------------------------------------------------
-- 2. Seed default permissions for the new modules.
--    Each role gets can_view=true for the modules they should see by
--    default (matching the ROLE_MODULES map in permissions.js).
--    Doctors + nurses can also create/edit; only admin/owner can
--    delete.
-- -----------------------------------------------------------------

-- Helper: insert-or-skip — only inserts if no row exists yet for the
-- (hospital, role, module) tuple, so existing per-hospital overrides
-- are preserved.

-- Delivery module defaults:
--   doctor  → view + create + edit
--   nurse   → view + create + edit
--   cmd     → view only
INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
SELECT h.id, r.role, 'delivery',
       true,
       r.role IN ('doctor', 'nurse'),
       r.role IN ('doctor', 'nurse'),
       false
  FROM public.hospitals h
  CROSS JOIN (VALUES
    ('doctor'), ('nurse'), ('cmd')
  ) AS r(role)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.hospital_role_permissions p
    WHERE p.hospital_id = h.id AND p.role = r.role AND p.module = 'delivery'
 );

-- Operating Theatre defaults:
--   doctor → view + create + edit
--   nurse  → view + create + edit
--   cmd    → view only
INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
SELECT h.id, r.role, 'operating_theatre',
       true,
       r.role IN ('doctor', 'nurse'),
       r.role IN ('doctor', 'nurse'),
       false
  FROM public.hospitals h
  CROSS JOIN (VALUES
    ('doctor'), ('nurse'), ('cmd')
  ) AS r(role)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.hospital_role_permissions p
    WHERE p.hospital_id = h.id AND p.role = r.role AND p.module = 'operating_theatre'
 );

-- Discharge workflow defaults:
--   doctor, nurse, front_desk, pharmacist, billing → view + create + edit
--   (each signs off their own step)
--   cmd → view only
INSERT INTO public.hospital_role_permissions (hospital_id, role, module, can_view, can_create, can_edit, can_delete)
SELECT h.id, r.role, 'discharge',
       true,
       r.role IN ('doctor', 'nurse', 'front_desk', 'pharmacist', 'billing'),
       r.role IN ('doctor', 'nurse', 'front_desk', 'pharmacist', 'billing'),
       false
  FROM public.hospitals h
  CROSS JOIN (VALUES
    ('doctor'), ('nurse'), ('front_desk'), ('pharmacist'), ('billing'), ('cmd')
  ) AS r(role)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.hospital_role_permissions p
    WHERE p.hospital_id = h.id AND p.role = r.role AND p.module = 'discharge'
 );

-- -----------------------------------------------------------------
-- 3. Verification:
--   SELECT role, module, can_view, can_create, can_edit, can_delete
--     FROM public.hospital_role_permissions
--    WHERE module IN ('delivery','operating_theatre','discharge')
--    ORDER BY module, role;
-- -----------------------------------------------------------------
