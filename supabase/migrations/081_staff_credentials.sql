-- =====================================================================
-- GOODIE-MEDHUB — 081_staff_credentials.sql
-- =====================================================================
-- Staff Performance & Credentialing Module — Part 1: Credentials
-- Tracks professional licenses, certifications, and their expiry dates.
-- Enables license expiry reminders and credential verification.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.staff_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id       uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  credential_type   text NOT NULL CHECK (credential_type IN (
    'medical_license', 'nursing_license', 'pharmacy_license',
    'lab_scientist_license', 'specialist_registration', 'cpr_certification',
    'other'
  )),
  credential_number text NOT NULL,
  issuing_body      text,
  issue_date        date,
  expiry_date       date NOT NULL,
  document_path     text,
  is_verified       boolean NOT NULL DEFAULT false,
  verified_by       uuid REFERENCES public.profiles(id),
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_credentials_hospital_staff_idx
  ON public.staff_credentials (hospital_id, staff_id);
CREATE INDEX IF NOT EXISTS staff_credentials_expiry_idx
  ON public.staff_credentials (hospital_id, expiry_date);

ALTER TABLE public.staff_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_credentials_select" ON public.staff_credentials;
CREATE POLICY "staff_credentials_select" ON public.staff_credentials
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "staff_credentials_insert" ON public.staff_credentials;
CREATE POLICY "staff_credentials_insert" ON public.staff_credentials
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

DROP POLICY IF EXISTS "staff_credentials_update" ON public.staff_credentials;
CREATE POLICY "staff_credentials_update" ON public.staff_credentials
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  ) WITH CHECK (
    hospital_id = public.current_hospital_id()
  );

DROP POLICY IF EXISTS "staff_credentials_delete" ON public.staff_credentials;
CREATE POLICY "staff_credentials_delete" ON public.staff_credentials
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_credentials TO authenticated;

DROP TRIGGER IF EXISTS trg_staff_credentials_updated_at ON public.staff_credentials;
CREATE TRIGGER trg_staff_credentials_updated_at
  BEFORE UPDATE ON public.staff_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.staff_credentials REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'staff_credentials') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_credentials;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
