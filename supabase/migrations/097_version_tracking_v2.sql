-- Migration 097 v2 (FIXED): Version Tracking + Sync Conflicts
--
-- FIX FROM v1:
--   v1 used `FOREACH tbl SLICE 1 IN ARRAY tables_to_track LOOP`
--   PostgreSQL error: "FOREACH ... SLICE loop variable must be of an array type"
--
--   When `SLICE 1` is used, the loop variable must be an ARRAY type
--   (because SLICE 1 iterates over sub-arrays of dimension 1, not over
--   individual elements). To iterate over individual TEXT elements of
--   a TEXT[] array, you must omit `SLICE 1`:
--     `FOREACH tbl IN ARRAY tables_to_track LOOP`
--
--   This is the v2 fix.
--
-- Also: replaced `public.users(id)` with `public.profiles(id)` for the
--   sync_conflicts table's `resolved_by` column.
--
-- Run order: AFTER 00_cleanup_v2.sql

BEGIN;

-- ============================================================
-- 1. Add version columns to all synced tables
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
  tables_to_track TEXT[] := ARRAY[
    'patients', 'profiles', 'hospitals', 'facilities',
    'admission_requests', 'admission_timeline_events',
    'patient_vitals', 'prescriptions', 'pharmacy_requests',
    'pharmacy_orders', 'medication_administrations',
    'lab_orders', 'lab_tests', 'radiology_scans',
    'invoices', 'invoice_items', 'payments',
    'inventory_items', 'billable_charges',
    'audit_events', 'ai_assessments',
    'payment_plans', 'payment_plan_installments',
    'invoice_reminders', 'invoice_writeoffs',
    'hmo_claims', 'hmo_claim_line_items',
    'shift_handovers',
    'credentials', 'staff_cme', 'incident_reports',
    'virtual_consultations', 'consultation_messages',
    'regulatory_reports', 'medication_safety_alerts',
    'drug_interactions', 'drug_allergy_classes'
  ];
BEGIN
  -- FIX v2: removed SLICE 1 — iterate over individual TEXT elements
  FOREACH tbl IN ARRAY tables_to_track LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.%I
           ADD COLUMN IF NOT EXISTS _version INT NOT NULL DEFAULT 1,
           ADD COLUMN IF NOT EXISTS _last_editor UUID,
           ADD COLUMN IF NOT EXISTS _last_synced_at TIMESTAMPTZ DEFAULT now()',
        tbl
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (_version)',
        tbl || '_version_idx', tbl
      );
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END;
  END LOOP;
END $$;

-- ============================================================
-- 2. Trigger: auto-increment _version on UPDATE
-- ============================================================
CREATE OR REPLACE FUNCTION public.bump_version()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW._version = OLD._version THEN
    NEW._version := OLD._version + 1;
  END IF;
  NEW._last_synced_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach the trigger to every tracked table
DO $$
DECLARE
  tbl TEXT;
  tables_to_track TEXT[] := ARRAY[
    'patients', 'profiles', 'hospitals', 'facilities',
    'admission_requests', 'admission_timeline_events',
    'patient_vitals', 'prescriptions', 'pharmacy_requests',
    'pharmacy_orders', 'medication_administrations',
    'lab_orders', 'lab_tests', 'radiology_scans',
    'invoices', 'invoice_items', 'payments',
    'inventory_items', 'billable_charges',
    'audit_events', 'ai_assessments',
    'payment_plans', 'payment_plan_installments',
    'invoice_reminders', 'invoice_writeoffs',
    'hmo_claims', 'hmo_claim_line_items',
    'shift_handovers',
    'credentials', 'staff_cme', 'incident_reports',
    'virtual_consultations', 'consultation_messages',
    'regulatory_reports', 'medication_safety_alerts',
    'drug_interactions', 'drug_allergy_classes'
  ];
BEGIN
  -- FIX v2: removed SLICE 1
  FOREACH tbl IN ARRAY tables_to_track LOOP
    BEGIN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_%I_version ON public.%I;
         CREATE TRIGGER trg_%I_version
           BEFORE UPDATE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.bump_version();',
        tbl, tbl, tbl, tbl
      );
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END;
  END LOOP;
END $$;

-- ============================================================
-- 3. sync_conflicts table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sync_conflicts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  table_name      TEXT NOT NULL,
  record_id       UUID NOT NULL,
  client_version  INT NOT NULL,
  server_version  INT NOT NULL,
  client_data     JSONB NOT NULL,
  server_data     JSONB NOT NULL,
  base_data       JSONB,
  conflicting_fields TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','resolved_theirs','resolved_mine','resolved_merge','discarded')),
  resolution_data JSONB,
  resolved_by     UUID REFERENCES public.profiles(id),  -- FIX v3: profiles, not users
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_hospital ON public.sync_conflicts(hospital_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON public.sync_conflicts(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_record ON public.sync_conflicts(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_pending ON public.sync_conflicts(status, created_at);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.sync_conflicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_conflicts_select_hospital" ON public.sync_conflicts;
CREATE POLICY "sync_conflicts_select_hospital" ON public.sync_conflicts
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "sync_conflicts_insert_hospital" ON public.sync_conflicts;
CREATE POLICY "sync_conflicts_insert_hospital" ON public.sync_conflicts
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "sync_conflicts_update_hospital" ON public.sync_conflicts;
CREATE POLICY "sync_conflicts_update_hospital" ON public.sync_conflicts
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "sync_conflicts_delete_hospital" ON public.sync_conflicts;
CREATE POLICY "sync_conflicts_delete_hospital" ON public.sync_conflicts
  FOR DELETE USING (hospital_id = current_hospital_id());

-- ============================================================
-- RPC: detect_conflicting_fields
-- ============================================================
CREATE OR REPLACE FUNCTION public.detect_conflicting_fields(
  p_client JSONB,
  p_server JSONB
) RETURNS TEXT[] AS $$
DECLARE
  keys TEXT[];
  k TEXT;
  result TEXT[] := '{}';
BEGIN
  keys := ARRAY(
    SELECT DISTINCT key
    FROM (
      SELECT jsonb_object_keys(p_client) AS key
      UNION
      SELECT jsonb_object_keys(p_server) AS key
    ) t
    WHERE key NOT LIKE '\_%'
      AND key NOT IN ('created_at','updated_at','_version','_last_editor','_last_synced_at')
  );

  FOREACH k IN ARRAY keys LOOP
    IF COALESCE(p_client->>k, '__null__') IS DISTINCT FROM COALESCE(p_server->>k, '__null__') THEN
      result := array_append(result, k);
    END IF;
  END LOOP;

  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER;

COMMIT;
