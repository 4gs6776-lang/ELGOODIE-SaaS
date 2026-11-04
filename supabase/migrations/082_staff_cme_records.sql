-- =====================================================================
-- GOODIE-MEDHUB — 082_staff_cme_records.sql
-- =====================================================================
-- Staff Performance & Credentialing Module — Part 2: CME Records
-- Tracks Continuing Medical Education hours + certificates.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.staff_cme_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id       uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  course_title      text NOT NULL,
  provider          text,
  cme_hours         numeric(4,1) NOT NULL DEFAULT 0,
  completion_date   date NOT NULL,
  certificate_path  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_cme_hospital_staff_idx
  ON public.staff_cme_records (hospital_id, staff_id);

ALTER TABLE public.staff_cme_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_cme_select" ON public.staff_cme_records;
CREATE POLICY "staff_cme_select" ON public.staff_cme_records
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "staff_cme_insert" ON public.staff_cme_records;
CREATE POLICY "staff_cme_insert" ON public.staff_cme_records
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

DROP POLICY IF EXISTS "staff_cme_update" ON public.staff_cme_records;
CREATE POLICY "staff_cme_update" ON public.staff_cme_records
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  ) WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "staff_cme_delete" ON public.staff_cme_records;
CREATE POLICY "staff_cme_delete" ON public.staff_cme_records
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_cme_records TO authenticated;

ALTER TABLE public.staff_cme_records REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'staff_cme_records') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_cme_records;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
