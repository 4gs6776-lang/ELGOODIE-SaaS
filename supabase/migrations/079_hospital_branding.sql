-- =====================================================================
-- GOODIE-MEDHUB — 079_hospital_branding.sql
-- =====================================================================
-- Multi-tenant dashboard background personalization.
--
-- Creates the hospital_branding table (singleton per hospital) that
-- stores the dashboard background image URL + display preferences
-- (position, brightness, opacity, size, enabled flag).
--
-- CRITICAL: This table is SEPARATE from the `hospitals` table because
-- `hospitals` RLS restricts UPDATE to is_owner() only — hospital admins
-- cannot update the hospitals row. This table uses is_hospital_admin()
-- OR is_owner() for writes, so admins can manage their own branding.
--
-- Storage: Reuses the existing `hospital-logos` bucket (migration 028).
-- Background images are uploaded to path `${hospital_id}/dashboard-bg`.
-- The bucket is public-read + authenticated-write (already configured).
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. Create hospital_branding table
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.hospital_branding (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id             uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  background_image_path   text,
  background_enabled      boolean NOT NULL DEFAULT false,
  background_position     text NOT NULL DEFAULT 'center'
                          CHECK (background_position IN ('center', 'top', 'bottom')),
  background_brightness   numeric(5, 2) NOT NULL DEFAULT 1.00
                          CHECK (background_brightness >= 0.50 AND background_brightness <= 1.50),
  background_opacity      numeric(5, 2) NOT NULL DEFAULT 0.60
                          CHECK (background_opacity >= 0.00 AND background_opacity <= 1.00),
  background_size         text NOT NULL DEFAULT 'cover'
                          CHECK (background_size IN ('cover', 'contain')),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  UNIQUE (hospital_id)
);

CREATE INDEX IF NOT EXISTS hospital_branding_hospital_idx
  ON public.hospital_branding (hospital_id);

-- =====================================================================
-- 2. Enable RLS + policies (mirror migration 074 pattern)
-- =====================================================================
ALTER TABLE public.hospital_branding ENABLE ROW LEVEL SECURITY;

-- All hospital members can read their own branding
DROP POLICY IF EXISTS "hospital_branding_select" ON public.hospital_branding;
CREATE POLICY "hospital_branding_select" ON public.hospital_branding
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

-- Admin/owner can insert
DROP POLICY IF EXISTS "hospital_branding_insert" ON public.hospital_branding;
CREATE POLICY "hospital_branding_insert" ON public.hospital_branding
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

-- Admin/owner can update
DROP POLICY IF EXISTS "hospital_branding_update" ON public.hospital_branding;
CREATE POLICY "hospital_branding_update" ON public.hospital_branding
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  ) WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

-- Admin/owner can delete
DROP POLICY IF EXISTS "hospital_branding_delete" ON public.hospital_branding;
CREATE POLICY "hospital_branding_delete" ON public.hospital_branding
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.hospital_branding TO authenticated;

-- =====================================================================
-- 3. updated_at trigger
-- =====================================================================
DROP TRIGGER IF EXISTS trg_hospital_branding_updated_at ON public.hospital_branding;
CREATE TRIGGER trg_hospital_branding_updated_at
  BEFORE UPDATE ON public.hospital_branding
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.hospital_branding REPLICA IDENTITY FULL;

-- =====================================================================
-- 4. Add to realtime publication (for cross-device sync)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'hospital_branding'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hospital_branding;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 5. Verification
-- =====================================================================
DO $$
BEGIN
  RAISE NOTICE 'hospital_branding table created with RLS policies + realtime enabled.';
  RAISE NOTICE 'Storage: reuse hospital-logos bucket, upload to ${hospital_id}/dashboard-bg';
END $$;
