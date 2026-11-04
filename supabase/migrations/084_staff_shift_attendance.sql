-- =====================================================================
-- GOODIE-MEDHUB — 084_staff_shift_attendance.sql
-- =====================================================================
-- Staff Performance & Credentialing Module — Part 4: Shift Attendance
-- Tracks scheduled vs actual shift times, late arrivals, absences.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.staff_shift_attendance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id       uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  shift_date        date NOT NULL,
  shift_type        text CHECK (shift_type IN ('morning', 'afternoon', 'night')),
  scheduled_start   time,
  scheduled_end     time,
  actual_start      timestamptz,
  actual_end        timestamptz,
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'present', 'late', 'absent', 'on_leave'
  )),
  minutes_late      integer DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_attendance_hospital_staff_idx
  ON public.staff_shift_attendance (hospital_id, staff_id);
CREATE INDEX IF NOT EXISTS staff_attendance_date_idx
  ON public.staff_shift_attendance (hospital_id, shift_date DESC);

ALTER TABLE public.staff_shift_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_attendance_select" ON public.staff_shift_attendance;
CREATE POLICY "staff_attendance_select" ON public.staff_shift_attendance
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

DROP POLICY IF EXISTS "staff_attendance_insert" ON public.staff_shift_attendance;
CREATE POLICY "staff_attendance_insert" ON public.staff_shift_attendance
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

DROP POLICY IF EXISTS "staff_attendance_update" ON public.staff_shift_attendance;
CREATE POLICY "staff_attendance_update" ON public.staff_shift_attendance
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  ) WITH CHECK (hospital_id = public.current_hospital_id());

DROP POLICY IF EXISTS "staff_attendance_delete" ON public.staff_shift_attendance;
CREATE POLICY "staff_attendance_delete" ON public.staff_shift_attendance
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_shift_attendance TO authenticated;

ALTER TABLE public.staff_shift_attendance REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'staff_shift_attendance') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_shift_attendance;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
