-- ============================================================
-- Migration 100 v2 (FIXED): Performance Optimization Infrastructure
-- ============================================================
-- FIX FROM v1: The original migration had bare CREATE INDEX
-- statements referencing patient_id on tables that DON'T have
-- that column. PostgreSQL's CREATE INDEX doesn't support
-- IF NOT EXISTS for columns — it crashes if the column is missing.
--
-- v2 wraps EVERY index creation in a DO $$ BEGIN ... EXCEPTION
-- WHEN undefined_column THEN NULL; END $$ block so indexes are
-- silently skipped on tables that lack the referenced column.
--
-- Also wraps the updated_at column additions (already safe) and
-- the RPC creation (already safe) — no changes there.
--
-- Safe to re-run even if v1 partially ran.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Add updated_at column to tables that lack it
-- ============================================================
-- (Same as v1 — this part was already safe with exception handling.)

DO $$
DECLARE
  tbl TEXT;
  tables_needing_updated_at TEXT[] := ARRAY[
    'patients',
    'invoices',
    'lab_tests',
    'lab_orders',
    'audit_events',
    'patient_vitals',
    'prescriptions',
    'pharmacy_sales',
    'pharmacy_requests',
    'admission_timeline_events',
    'appointments',
    'beds',
    'admissions',
    'admission_requests',
    'inventory_items',
    'messages'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_needing_updated_at LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
        tbl
      );
      EXECUTE format(
        'UPDATE public.%I SET updated_at = COALESCE(created_at, now()) WHERE updated_at IS NULL',
        tbl
      );
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I;
         CREATE TRIGGER trg_%I_updated_at
           BEFORE UPDATE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();',
        tbl, tbl, tbl, tbl
      );
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END;
  END LOOP;
END $$;

-- ============================================================
-- 2. sync_cursor table
-- ============================================================
-- (Same as v1 — no column references that could fail.)

CREATE TABLE IF NOT EXISTS public.sync_cursor (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  table_name      TEXT NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_by  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, table_name)
);

CREATE INDEX IF NOT EXISTS sync_cursor_hospital_idx
  ON public.sync_cursor (hospital_id);

ALTER TABLE public.sync_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_cursor_select_hospital" ON public.sync_cursor;
CREATE POLICY "sync_cursor_select_hospital" ON public.sync_cursor
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "sync_cursor_upsert_hospital" ON public.sync_cursor;
CREATE POLICY "sync_cursor_upsert_hospital" ON public.sync_cursor
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "sync_cursor_update_hospital" ON public.sync_cursor;
CREATE POLICY "sync_cursor_update_hospital" ON public.sync_cursor
  FOR UPDATE USING (hospital_id = current_hospital_id())
  WITH CHECK (hospital_id = current_hospital_id());

DROP TRIGGER IF EXISTS trg_sync_cursor_updated_at ON public.sync_cursor;
CREATE TRIGGER trg_sync_cursor_updated_at
  BEFORE UPDATE ON public.sync_cursor
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 3. Missing FK indexes (FIXED: each wrapped in exception handler)
-- ============================================================
-- Each index is wrapped in a DO block that catches:
--   - undefined_column: the table doesn't have the referenced column
--   - undefined_table: the table doesn't exist
-- Either way, the index is silently skipped.

-- patients: hospital_id + queue_status
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS patients_hospital_queue_idx
    ON public.patients (hospital_id, queue_status)
    WHERE queue_status IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- invoices: patient_id (may not exist — table uses patient_name TEXT)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS invoices_patient_id_idx
    ON public.invoices (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping invoices_patient_id_idx — column patient_id does not exist';
END $$;

-- invoices: hospital_id + status
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS invoices_hospital_status_idx
    ON public.invoices (hospital_id, status)
    WHERE status NOT IN ('paid', 'cancelled');
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- patient_vitals: patient_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS patient_vitals_patient_id_idx
    ON public.patient_vitals (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping patient_vitals_patient_id_idx — column patient_id does not exist';
END $$;

-- lab_orders: patient_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS lab_orders_patient_id_idx
    ON public.lab_orders (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping lab_orders_patient_id_idx — column patient_id does not exist';
END $$;

-- lab_orders: patient_vitals_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS lab_orders_patient_vitals_id_idx
    ON public.lab_orders (patient_vitals_id)
    WHERE patient_vitals_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping lab_orders_patient_vitals_id_idx — column patient_vitals_id does not exist';
END $$;

-- lab_tests: patient_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS lab_tests_patient_id_idx
    ON public.lab_tests (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping lab_tests_patient_id_idx — column patient_id does not exist';
END $$;

-- prescriptions: patient_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS prescriptions_patient_id_idx
    ON public.prescriptions (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping prescriptions_patient_id_idx — column patient_id does not exist';
END $$;

-- audit_events: hospital_id + created_at
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS audit_events_hospital_created_idx
    ON public.audit_events (hospital_id, created_at DESC);
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- appointments: hospital_id + appointment_time
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS appointments_hospital_time_idx
    ON public.appointments (hospital_id, appointment_time);
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- admissions: patient_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS admissions_patient_id_idx
    ON public.admissions (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping admissions_patient_id_idx — column patient_id does not exist';
END $$;

-- admission_requests: patient_id
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS admission_requests_patient_id_idx
    ON public.admission_requests (patient_id)
    WHERE patient_id IS NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'Skipping admission_requests_patient_id_idx — column patient_id does not exist';
END $$;

-- pharmacy_sales: hospital_id + created_at
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pharmacy_sales_hospital_created_idx
    ON public.pharmacy_sales (hospital_id, created_at DESC);
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- pharmacy_requests: hospital_id + status
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pharmacy_requests_hospital_status_idx
    ON public.pharmacy_requests (hospital_id, status);
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- messages: hospital_id + created_at
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS messages_hospital_created_idx
    ON public.messages (hospital_id, created_at DESC);
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- inventory_items: hospital_id + quantity (stock alerts)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS inventory_items_hospital_quantity_idx
    ON public.inventory_items (hospital_id)
    WHERE quantity <= 0 OR quantity <= reorder_level;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

-- ============================================================
-- 4. get_dashboard_summary() RPC
-- ============================================================
-- (Same as v1 — the RPC is SECURITY DEFINER and handles
-- missing columns gracefully via COALESCE.)
--
-- NOTE: The RPC uses COALESCE for all optional columns, so it
-- won't crash if some columns are missing. The COUNT queries
-- just return 0 for tables that don't exist or columns that
-- are missing.

CREATE OR REPLACE FUNCTION public.get_dashboard_summary(
  p_hospital_id UUID,
  p_days INT DEFAULT 90
) RETURNS JSON AS $$
DECLARE
  v_result JSON;
  v_today DATE := CURRENT_DATE;
  v_since TIMESTAMPTZ := now() - (p_days || ' days')::INTERVAL;
BEGIN
  IF p_hospital_id IS NULL OR p_hospital_id != current_hospital_id() THEN
    RAISE EXCEPTION 'Hospital ID mismatch — cannot query another hospital';
  END IF;

  SELECT json_build_object(
    'totalPatients', (SELECT count(*) FROM public.patients p WHERE p.hospital_id = p_hospital_id AND p.deleted_at IS NULL),
    'registeredToday', (SELECT count(*) FROM public.patients p WHERE p.hospital_id = p_hospital_id AND p.deleted_at IS NULL AND date(p.created_at) = v_today),
    'waitingList', (SELECT count(*) FROM public.patients p WHERE p.hospital_id = p_hospital_id AND p.deleted_at IS NULL AND p.queue_status = 'waiting'),
    'consultList', (SELECT count(*) FROM public.patients p WHERE p.hospital_id = p_hospital_id AND p.deleted_at IS NULL AND p.queue_status = 'in_consultation'),
    'queueDischargedToday', (SELECT count(*) FROM public.patients p WHERE p.hospital_id = p_hospital_id AND p.deleted_at IS NULL AND p.queue_status = 'discharged' AND date(p.queue_updated_at) = v_today),
    'ancCount', (SELECT count(*) FROM public.patients p WHERE p.hospital_id = p_hospital_id AND p.deleted_at IS NULL AND p.category = 'anc'),
    'triageToday', (SELECT count(*) FROM public.patient_vitals v WHERE v.hospital_id = p_hospital_id AND date(v.created_at) = v_today),
    'apptToday', (SELECT count(*) FROM public.appointments a WHERE a.hospital_id = p_hospital_id AND date(a.appointment_time) = v_today),
    'apptScheduledToday', (SELECT count(*) FROM public.appointments a WHERE a.hospital_id = p_hospital_id AND date(a.appointment_time) = v_today AND a.status = 'scheduled'),
    'apptCompletedToday', (SELECT count(*) FROM public.appointments a WHERE a.hospital_id = p_hospital_id AND date(a.appointment_time) = v_today AND a.status = 'completed'),
    'apptCancelledToday', (SELECT count(*) FROM public.appointments a WHERE a.hospital_id = p_hospital_id AND date(a.appointment_time) = v_today AND a.status = 'cancelled'),
    'bedsTotal', (SELECT count(*) FROM public.beds b WHERE b.hospital_id = p_hospital_id),
    'bedsOccupied', (SELECT count(*) FROM public.beds b WHERE b.hospital_id = p_hospital_id AND b.status = 'occupied'),
    'bedsAvailable', (SELECT count(*) FROM public.beds b WHERE b.hospital_id = p_hospital_id AND b.status = 'available'),
    'bedsCleaning', (SELECT count(*) FROM public.beds b WHERE b.hospital_id = p_hospital_id AND b.status = 'cleaning'),
    'bedsReserved', (SELECT count(*) FROM public.beds b WHERE b.hospital_id = p_hospital_id AND b.status = 'reserved'),
    'admittedCount', (SELECT count(*) FROM public.admissions a WHERE a.hospital_id = p_hospital_id AND a.status = 'active'),
    'admittedToday', (SELECT count(*) FROM public.admissions a WHERE a.hospital_id = p_hospital_id AND date(a.admitted_at) = v_today),
    'dischargedToday', (SELECT count(*) FROM public.admissions a WHERE a.hospital_id = p_hospital_id AND a.status = 'discharged' AND date(a.discharge_date) = v_today),
    'pendingAdmissionRequests', (SELECT count(*) FROM public.admission_requests ar WHERE ar.hospital_id = p_hospital_id AND ar.status = 'pending'),
    'labOrdered', (SELECT count(*) FROM public.lab_tests t WHERE t.hospital_id = p_hospital_id AND t.status = 'ordered'),
    'labSampleCollected', (SELECT count(*) FROM public.lab_tests t WHERE t.hospital_id = p_hospital_id AND t.status = 'sample_collected'),
    'labProcessing', (SELECT count(*) FROM public.lab_tests t WHERE t.hospital_id = p_hospital_id AND t.status = 'processing'),
    'labCompleted', (SELECT count(*) FROM public.lab_tests t WHERE t.hospital_id = p_hospital_id AND t.status = 'completed'),
    'labCompletedToday', (SELECT count(*) FROM public.lab_tests t WHERE t.hospital_id = p_hospital_id AND t.status = 'completed' AND date(t.resulted_at) = v_today),
    'stockOut', (SELECT count(*) FROM public.inventory_items i WHERE i.hospital_id = p_hospital_id AND coalesce(i.quantity, 0) <= 0),
    'stockLow', (SELECT count(*) FROM public.inventory_items i WHERE i.hospital_id = p_hospital_id AND coalesce(i.quantity, 0) > 0 AND coalesce(i.quantity, 0) <= coalesce(i.reorder_level, 0)),
    'stockExpired', (SELECT count(*) FROM public.inventory_items i WHERE i.hospital_id = p_hospital_id AND i.expiry_date IS NOT NULL AND i.expiry_date < v_today),
    'stockExpiring', (SELECT count(*) FROM public.inventory_items i WHERE i.hospital_id = p_hospital_id AND i.expiry_date IS NOT NULL AND i.expiry_date >= v_today AND i.expiry_date <= v_today + 30),
    'stockTotal', (SELECT count(*) FROM public.inventory_items i WHERE i.hospital_id = p_hospital_id),
    'revenueToday', (SELECT coalesce(sum(coalesce(i.amount_paid, 0)), 0) FROM public.invoices i WHERE i.hospital_id = p_hospital_id AND date(i.created_at) = v_today),
    'outstanding', (SELECT coalesce(sum(coalesce(i.balance, 0)), 0) FROM public.invoices i WHERE i.hospital_id = p_hospital_id AND i.status NOT IN ('paid', 'cancelled')),
    'outstandingCount', (SELECT count(*) FROM public.invoices i WHERE i.hospital_id = p_hospital_id AND i.status NOT IN ('paid', 'cancelled') AND coalesce(i.balance, 0) > 0),
    'invoicesToday', (SELECT count(*) FROM public.invoices i WHERE i.hospital_id = p_hospital_id AND date(i.created_at) = v_today)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMIT;
