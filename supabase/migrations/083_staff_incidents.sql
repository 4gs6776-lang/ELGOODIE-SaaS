-- =====================================================================
-- GOODIE-MEDHUB — 083_staff_incidents.sql
-- =====================================================================
-- Staff Performance & Credentialing Module — Part 3: Incidents
-- Tracks staff incidents (absenteeism, protocol violations, commendations).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.staff_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id       uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  incident_type     text NOT NULL CHECK (incident_type IN (
    'absenteeism', 'late_arrival', 'protocol_violation',
    'patient_complaint', 'medication_error', 'equipment_damage',
    'commendation', 'other'
  )),
  severity          text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'moderate', 'major')),
  description       text NOT NULL,
  incident_date     date NOT NULL,
  reported_by       uuid REFERENCES public.profiles(id),
  resolved          boolean NOT NULL DEFAULT false,
  resolution_notes  text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_incidents_hospital_staff_idx
  ON public.staff_incidents (hospital_id, staff_id);
CREATE INDEX IF NOT EXISTS staff_incidents_date_idx
  ON public.staff_incidents (hospital_id, incident_date DESC);

ALTER TABLE public.staff_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_incidents_select" ON public.staff_incidents;
CREATE POLICY "staff_incidents_select" ON public.staff_incidents
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "staff_incidents_insert" ON public.staff_incidents;
CREATE POLICY "staff_incidents_insert" ON public.staff_incidents
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

DROP POLICY IF EXISTS "staff_incidents_update" ON public.staff_incidents;
CREATE POLICY "staff_incidents_update" ON public.staff_incidents
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  ) WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "staff_incidents_delete" ON public.staff_incidents;
CREATE POLICY "staff_incidents_delete" ON public.staff_incidents
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_incidents TO authenticated;

ALTER TABLE public.staff_incidents REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'staff_incidents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_incidents;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
