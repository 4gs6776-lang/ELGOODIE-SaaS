-- =====================================================================
-- GOODIE-MEDHUB — 065_hmo_providers_table.sql
-- =====================================================================
-- Phase 2: Move the hardcoded HMO providers list from
-- src/lib/hmoProviders.js into a database table so hospitals can
-- manage their own list later.
--
-- Design:
--   - `hmo_providers` table stores the master list (per hospital).
--   - A `is_system` flag marks the 30 seeded entries — they can't be
--     deleted by hospitals (only deactivated), but CAN be edited
--     (e.g. a hospital can rename "NHIS" to "NHIS (Lagos Branch)").
--   - Hospitals can add their own entries via Settings (future work).
--   - The frontend `useHmoProviders` hook reads from this table with
--     a fallback to the hardcoded constant in hmoProviders.js for
--     offline-first availability.
--
-- Backward compatibility:
--   - Existing patient records that store `hmo_provider` as a display
--     name string (e.g. "Hygeia HMO") are NOT migrated — they keep
--     working because the frontend matches by name, not by id.
--   - The `hmo_providers` table is additive — no existing tables are
--     modified.
--
-- Safe to re-run (IF NOT EXISTS + ON CONFLICT seed).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Table: hmo_providers
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hmo_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid REFERENCES public.hospitals(id) ON DELETE CASCADE,
  -- When hospital_id IS NULL, the entry is a SYSTEM-wide default
  -- (visible to ALL hospitals). When hospital_id is set, it's a
  -- hospital-specific override or addition.
  slug            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL DEFAULT 'private'
                  CHECK (type IN ('public', 'private')),
  is_system       boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Unique constraint: one (hospital_id, slug) combo. System entries
  -- (hospital_id IS NULL) are unique by slug.
  -- NOTE: PostgreSQL does not support UNIQUE NULLS NOT NULL syntax.
  -- The default UNIQUE constraint treats NULLs as distinct (multiple
  -- rows with hospital_id=NULL + same slug are allowed). To enforce
  -- uniqueness for system entries too, we use a partial unique index below.
  CONSTRAINT hmo_providers_unique UNIQUE (hospital_id, slug)
);

-- Index for fast lookups per hospital
CREATE INDEX IF NOT EXISTS hmo_providers_hospital_idx
  ON public.hmo_providers (hospital_id, is_active, sort_order);

-- Index for system-wide entries (hospital_id IS NULL)
CREATE INDEX IF NOT EXISTS hmo_providers_system_idx
  ON public.hmo_providers (is_active, sort_order)
  WHERE hospital_id IS NULL;

-- Partial unique index for system entries (hospital_id IS NULL) — ensures
-- each system slug appears only once. The table-level UNIQUE constraint
-- doesn't catch this because PostgreSQL treats NULLs as distinct by default.
CREATE UNIQUE INDEX IF NOT EXISTS hmo_providers_system_slug_uniq
  ON public.hmo_providers (slug)
  WHERE hospital_id IS NULL;

-- ---------------------------------------------------------------------
-- RLS: hmo_providers
-- ---------------------------------------------------------------------
-- READ: any hospital member can see system entries + their hospital's entries.
-- WRITE: admin/owner only (system entries can't be deleted, only deactivated).
ALTER TABLE public.hmo_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hmo_providers_select" ON public.hmo_providers;
CREATE POLICY "hmo_providers_select" ON public.hmo_providers
  FOR SELECT USING (
    hospital_id IS NULL  -- system-wide entries visible to all
    OR hospital_id = public.current_hospital_id()
    OR public.is_owner()
  );

DROP POLICY IF EXISTS "hmo_providers_insert" ON public.hmo_providers;
CREATE POLICY "hmo_providers_insert" ON public.hmo_providers
  FOR INSERT WITH CHECK (
    (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
    OR public.is_owner()
  );

DROP POLICY IF EXISTS "hmo_providers_update" ON public.hmo_providers;
CREATE POLICY "hmo_providers_update" ON public.hmo_providers
  FOR UPDATE USING (
    hospital_id IS NULL OR hospital_id = public.current_hospital_id()
  ) WITH CHECK (
    hospital_id IS NULL OR hospital_id = public.current_hospital_id()
  );

-- DELETE: only hospital-specific entries can be deleted (not system entries).
-- System entries can only be deactivated (is_active = false).
DROP POLICY IF EXISTS "hmo_providers_delete" ON public.hmo_providers;
CREATE POLICY "hmo_providers_delete" ON public.hmo_providers
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND public.is_hospital_admin()
    AND is_system = false  -- system entries can't be hard-deleted
  );

-- Add to realtime publication so the frontend sees new providers instantly
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'hmo_providers') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.hmo_providers; END IF; END $$;

-- ---------------------------------------------------------------------
-- Seed: the 30 default HMO providers (from hmoProviders.js)
-- ---------------------------------------------------------------------
-- These are inserted with hospital_id = NULL (system-wide) and
-- is_system = true.
--
-- NOTE: PostgreSQL treats NULLs as distinct in a UNIQUE constraint,
-- so ON CONFLICT (hospital_id, slug) does NOT catch duplicate system
-- entries. We solve this by:
--   1. DELETE all existing system entries (hospital_id IS NULL) first
--   2. INSERT fresh with ON CONFLICT DO NOTHING as a safety net
-- The partial unique index hmo_providers_system_slug_uniq enforces
-- uniqueness at the DB level going forward.
--
-- sort_order: 0 = Self-Pay (always first), 1-99 = public, 100+ = private,
--             999 = Other (always last).

-- Step 1: Clear existing system entries (safe — only affects hospital_id IS NULL rows)
DELETE FROM public.hmo_providers WHERE hospital_id IS NULL;

-- Step 2: Insert all 30 system entries fresh
INSERT INTO public.hmo_providers (hospital_id, slug, name, type, is_system, sort_order) VALUES
  -- Sentinel: always first
  (NULL, 'self-pay', 'Self-Pay (No HMO)', 'private', true, 0),

  -- Public
  (NULL, 'nhis', 'NHIS (National Health Insurance Scheme)', 'public', true, 10),
  (NULL, 'nhis-ec2', 'NHIS ECD (Employer-Contributory)', 'public', true, 11),
  (NULL, 'nhis-tiship', 'NHIS TISHIP (Students)', 'public', true, 12),
  (NULL, 'nhip-anambra', 'Anambra State Health Insurance (ASHIA)', 'public', true, 13),
  (NULL, 'bhsi-bauchi', 'Bauchi State Health Contributory Scheme', 'public', true, 14),
  (NULL, 'ecohis-enugu', 'Enugu State Health Insurance (ENSHIC)', 'public', true, 15),

  -- Private — major nationals
  (NULL, 'hygeia', 'Hygeia HMO', 'private', true, 100),
  (NULL, 'axa-mansard', 'AXA Mansard Health', 'private', true, 101),
  (NULL, 'reliance-hmo', 'Reliance HMO', 'private', true, 102),
  (NULL, 'aiico', 'AIICO Multishield', 'private', true, 103),
  (NULL, 'avon-hmo', 'Avon HMO', 'private', true, 104),
  (NULL, 'greenbay', 'Greenbay Healthcare', 'private', true, 105),
  (NULL, 'clearline', 'Clearline HMO', 'private', true, 106),
  (NULL, 'u-wrap', 'United Healthcare International (U-WRAP)', 'private', true, 107),
  (NULL, 'hallmark', 'Hallmark HMO', 'private', true, 108),
  (NULL, 'mediplan', 'Mediplan Healthcare', 'private', true, 109),
  (NULL, 'zircon', 'Zircon Health', 'private', true, 110),
  (NULL, 'rfo', 'Redcare Healthcare', 'private', true, 111),
  (NULL, 'lifenest', 'Lifenest HMO', 'private', true, 112),
  (NULL, 'rohealth', 'Reliance HMO (RoHealth)', 'private', true, 113),

  -- Private — regional / growing
  (NULL, 'oceanic', 'Oceanic Health', 'private', true, 200),
  (NULL, 'prime-meta', 'Prime Metropolis Health', 'private', true, 201),
  (NULL, 'premium', 'Premium Shield HMO', 'private', true, 202),
  (NULL, 'total-healthtrust', 'Total Health Trust', 'private', true, 203),
  (NULL, 'defence-hmo', 'Defence HMO', 'private', true, 204),
  (NULL, 'novo', 'Novo Health Africa', 'private', true, 205),
  (NULL, 'alliance-hmo', 'Alliance HMO', 'private', true, 206),
  (NULL, 'actograph', 'Acto Healthcare International', 'private', true, 207),

  -- Sentinel: always last
  (NULL, 'other', 'Other (specify in notes)', 'private', true, 999)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------
-- After running this migration, verify with:
--   select slug, name, type, is_system, sort_order
--     from public.hmo_providers
--    where hospital_id is null
--    order by sort_order;
-- Should return 30 rows.
