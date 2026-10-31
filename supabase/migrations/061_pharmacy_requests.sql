-- =====================================================================
-- GOODIE-MEDHUB — 061_pharmacy_requests.sql
-- =====================================================================
-- Free-text medication requests from staff (nurses, doctors) to the
-- pharmacy. Staff types a plain-text request like "I need 1 tab
-- metronidazole 200mg for Amari" — the patient is auto-attached from
-- the open patient tab. The pharmacist sees it as plain text with
-- the requesting staff name, patient name, time, date, and priority.
--
-- The pharmacist can then:
--   1. Dispense via catalog picker (creates billable_charges) + free-text
--      notes about what was actually given
--   2. Mark the request as dispensed + cleared
--
-- Safe to re-run (IF NOT EXISTS). Run AFTER 060.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.pharmacy_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      uuid REFERENCES public.patients(id) ON DELETE CASCADE,
  patient_name    text,
  request_text    text NOT NULL,
  priority        text NOT NULL DEFAULT 'routine'
                  CHECK (priority IN ('routine', 'urgent', 'stat')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'dispensed', 'cancelled')),
  requested_by    uuid,
  requested_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Dispense documentation (filled by pharmacist)
  dispensed_at    timestamptz,
  dispensed_by    uuid,
  dispensed_by_name text,
  dispensed_items jsonb DEFAULT '[]'::jsonb,
  dispensed_notes text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pharmacy_requests_hospital_status_idx
  ON public.pharmacy_requests (hospital_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS pharmacy_requests_patient_idx
  ON public.pharmacy_requests (patient_id, created_at DESC);

ALTER TABLE public.pharmacy_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pharmacy_requests_select_own" ON public.pharmacy_requests FOR SELECT
  USING (hospital_id = current_hospital_id());
CREATE POLICY "pharmacy_requests_insert_own" ON public.pharmacy_requests FOR INSERT
  WITH CHECK (hospital_id = current_hospital_id());
CREATE POLICY "pharmacy_requests_update_own" ON public.pharmacy_requests FOR UPDATE
  USING (hospital_id = current_hospital_id());
CREATE POLICY "pharmacy_requests_delete_own" ON public.pharmacy_requests FOR DELETE
  USING (hospital_id = current_hospital_id());

-- Add to realtime publication so pharmacy sees new requests instantly
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pharmacy_requests') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.pharmacy_requests; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;
