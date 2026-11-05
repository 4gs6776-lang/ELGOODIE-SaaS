-- Migration 097: Version Tracking + Sync Conflicts
-- Adds version columns to all synced tables so clients can detect
-- concurrent edits and resolve field-level conflicts.
-- Creates sync_conflicts table to capture pending conflicts.

BEGIN;

-- ============================================================
-- 1. Add version columns to all synced tables
-- ============================================================
-- Each table gets:
--   _version       INT (monotonic, starts at 1, +1 per update)
--   _last_editor   UUID (the user_id of the last writer)
--   _last_synced_at TIMESTAMPTZ (when the server last accepted a write)
--
-- These are metadata columns prefixed with _ to avoid colliding with
-- any existing domain column names.
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
  tables_to_track TEXT[] := ARRAY[
    'patients', 'profiles', 'hospitals', 'facilities',
    'encounters', 'admission_requests', 'admission_timeline_events',
    'patient_vitals', 'prescriptions', 'pharmacy_requests',
    'pharmacy_orders', 'medication_administrations',
    'lab_orders', 'lab_tests', 'radiology_scans',
    'invoices', 'invoice_items', 'payments',
    'inventory_items', 'billable_charges',
    'audit_events', 'ai_assessments',
    -- Tier 1 / Tier 3 tables
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
  FOREACH tbl SLICE 1 IN ARRAY tables_to_track LOOP
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
      -- Table doesn't exist in this tenant yet — skip silently.
      NULL;
    END;
  END LOOP;
END $$;

-- ============================================================
-- 2. Trigger: auto-increment _version on UPDATE
-- ============================================================
-- A single trigger function that bumps _version by 1 each time the
-- row is updated, and stamps _last_synced_at.
-- ============================================================

CREATE OR REPLACE FUNCTION public.bump_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only bump if the version wasn't already manually set this turn
  -- (clients send their expected version for optimistic concurrency).
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
    'encounters', 'admission_requests', 'admission_timeline_events',
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
  FOREACH tbl SLICE 1 IN ARRAY tables_to_track LOOP
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
-- When a client push fails because the server row's _version is
-- higher than the client expected (concurrent edit), the Edge
-- Function records a conflict here. The user resolves it via the
-- UI (take theirs / take mine / merge).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sync_conflicts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  table_name      TEXT NOT NULL,
  record_id       UUID NOT NULL,
  client_version  INT NOT NULL,           -- what the client thought it was editing
  server_version  INT NOT NULL,           -- what the server actually had
  client_data     JSONB NOT NULL,         -- the entire row the client tried to write
  server_data     JSONB NOT NULL,         -- the entire row the server currently has
  base_data       JSONB,                  -- the row as it was when the client last synced (if known)
  conflicting_fields TEXT[] NOT NULL DEFAULT '{}',  -- computed diff
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','resolved_theirs','resolved_mine','resolved_merge','discarded')),
  resolution_data JSONB,                  -- the merged row that was actually written
  resolved_by     UUID REFERENCES public.users(id),
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
-- 4. RPC: detect_conflicting_fields
-- Given two JSONB rows, returns the array of field names that differ.
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
    WHERE key NOT LIKE '\_%'  -- skip metadata columns
      AND key NOT IN ('created_at','updated_at','_version','_last_editor','_last_synced_at')
  );

  FOREACH k SLICE 1 IN ARRAY keys LOOP
    IF COALESCE(p_client->>k, '__null__') IS DISTINCT FROM COALESCE(p_server->>k, '__null__') THEN
      result := array_append(result, k);
    END IF;
  END LOOP;

  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER;

COMMIT;
