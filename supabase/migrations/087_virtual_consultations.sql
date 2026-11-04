-- =====================================================================
-- GOODIE-MEDHUB — 087_virtual_consultations.sql
-- =====================================================================
-- Telemedicine / Virtual Consultation Module — Part 1
-- Creates the virtual_consultations table for managing video + chat
-- consultations between doctors and patients.
--
-- Uses WebRTC (peer-to-peer video/audio) with Supabase Realtime as
-- the signaling channel. No separate signaling server needed.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.virtual_consultations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  appointment_id  uuid,
  patient_id      uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  patient_name    text,
  doctor_id       uuid NOT NULL REFERENCES public.profiles(id),
  doctor_name     text,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'waiting', 'in_progress', 'completed',
    'cancelled', 'technical_failure'
  )),
  room_id         text NOT NULL,
  scheduled_start timestamptz,
  actual_start    timestamptz,
  actual_end      timestamptz,
  duration_seconds integer,
  is_recorded     boolean NOT NULL DEFAULT false,
  recording_path  text,
  session_summary text,
  connection_quality jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS virtual_consultations_hospital_idx
  ON public.virtual_consultations (hospital_id);
CREATE INDEX IF NOT EXISTS virtual_consultations_doctor_idx
  ON public.virtual_consultations (doctor_id, status);
CREATE INDEX IF NOT EXISTS virtual_consultations_patient_idx
  ON public.virtual_consultations (patient_id, status);
CREATE INDEX IF NOT EXISTS virtual_consultations_room_idx
  ON public.virtual_consultations (room_id);

ALTER TABLE public.virtual_consultations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "virtual_consultations_select" ON public.virtual_consultations;
CREATE POLICY "virtual_consultations_select" ON public.virtual_consultations
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "virtual_consultations_insert" ON public.virtual_consultations;
CREATE POLICY "virtual_consultations_insert" ON public.virtual_consultations
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "virtual_consultations_update" ON public.virtual_consultations;
CREATE POLICY "virtual_consultations_update" ON public.virtual_consultations
  FOR UPDATE USING (hospital_id = public.current_hospital_id())
  WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "virtual_consultations_delete" ON public.virtual_consultations;
CREATE POLICY "virtual_consultations_delete" ON public.virtual_consultations
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.virtual_consultations TO authenticated;

DROP TRIGGER IF EXISTS trg_virtual_consultations_updated_at ON public.virtual_consultations;
CREATE TRIGGER trg_virtual_consultations_updated_at
  BEFORE UPDATE ON public.virtual_consultations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.virtual_consultations REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'virtual_consultations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.virtual_consultations;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
