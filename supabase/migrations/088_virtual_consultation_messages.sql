-- =====================================================================
-- GOODIE-MEDHUB — 088_virtual_consultation_messages.sql
-- =====================================================================
-- Telemedicine / Virtual Consultation Module — Part 2
-- Text chat messages during a video consultation.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.virtual_consultation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  virtual_consultation_id uuid NOT NULL REFERENCES public.virtual_consultations(id) ON DELETE CASCADE,
  sender_id       uuid,
  sender_type     text NOT NULL CHECK (sender_type IN ('doctor', 'patient', 'system')),
  message_type    text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'file_share', 'prescription', 'lab_request')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vcm_consultation_idx
  ON public.virtual_consultation_messages (virtual_consultation_id, created_at);

ALTER TABLE public.virtual_consultation_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vcm_select" ON public.virtual_consultation_messages;
CREATE POLICY "vcm_select" ON public.virtual_consultation_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.virtual_consultations vc
      WHERE vc.id = virtual_consultation_id
        AND vc.hospital_id = public.current_hospital_id()
    )
  );

DROP POLICY IF EXISTS "vcm_insert" ON public.virtual_consultation_messages;
CREATE POLICY "vcm_insert" ON public.virtual_consultation_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.virtual_consultations vc
      WHERE vc.id = virtual_consultation_id
        AND vc.hospital_id = public.current_hospital_id()
    )
  );

DROP POLICY IF EXISTS "vcm_delete" ON public.virtual_consultation_messages;
CREATE POLICY "vcm_delete" ON public.virtual_consultation_messages
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.virtual_consultations vc
      WHERE vc.id = virtual_consultation_id
        AND vc.hospital_id = public.current_hospital_id()
        AND (public.is_hospital_admin() OR public.is_owner())
    )
  );

GRANT SELECT, INSERT, DELETE ON public.virtual_consultation_messages TO authenticated;

ALTER TABLE public.virtual_consultation_messages REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'virtual_consultation_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.virtual_consultation_messages;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
