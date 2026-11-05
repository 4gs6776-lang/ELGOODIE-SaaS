-- Migration 098: Sync Resolution Log + RPCs
-- Logs every conflict resolution action so we have an audit trail
-- of who picked what when merging conflicts.

BEGIN;

-- ============================================================
-- sync_resolution_log
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sync_resolution_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  conflict_id     UUID NOT NULL REFERENCES public.sync_conflicts(id) ON DELETE CASCADE,
  table_name      TEXT NOT NULL,
  record_id       UUID NOT NULL,
  resolution_type TEXT NOT NULL
                  CHECK (resolution_type IN ('theirs','mine','merge','discard')),
  field_decisions JSONB NOT NULL,  -- { "field_name": "client"|"server"|"custom_value", ... }
  final_data      JSONB NOT NULL,
  resolved_by     UUID REFERENCES public.users(id),
  resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_srl_hospital ON public.sync_resolution_log(hospital_id);
CREATE INDEX IF NOT EXISTS idx_srl_conflict ON public.sync_resolution_log(conflict_id);
CREATE INDEX IF NOT EXISTS idx_srl_table ON public.sync_resolution_log(table_name, resolved_at);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.sync_resolution_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "srl_select_hospital" ON public.sync_resolution_log;
CREATE POLICY "srl_select_hospital" ON public.sync_resolution_log
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "srl_insert_hospital" ON public.sync_resolution_log;
CREATE POLICY "srl_insert_hospital" ON public.sync_resolution_log
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

-- ============================================================
-- RPC: record_conflict_resolution
-- Writes the resolution + applies the merged data to the target row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_conflict_resolution(
  p_conflict_id   UUID,
  p_resolution    TEXT,
  p_field_decisions JSONB,
  p_final_data    JSONB,
  p_resolved_by   UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_conflict RECORD;
  v_payload JSONB;
BEGIN
  SELECT * INTO v_conflict FROM public.sync_conflicts WHERE id = p_conflict_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF p_resolution NOT IN ('theirs','mine','merge','discard') THEN
    RAISE EXCEPTION 'Invalid resolution type: %', p_resolution;
  END IF;

  -- Update the conflict row
  UPDATE public.sync_conflicts
     SET status = CASE p_resolution
        WHEN 'theirs' THEN 'resolved_theirs'
        WHEN 'mine'   THEN 'resolved_mine'
        WHEN 'merge'  THEN 'resolved_merge'
        WHEN 'discard' THEN 'discarded'
     END,
     resolution_data = p_final_data,
     resolved_by = p_resolved_by,
     resolved_at = now()
   WHERE id = p_conflict_id;

  -- If discarded, leave the server row alone
  IF p_resolution = 'discard' THEN
    -- Still log it
    INSERT INTO public.sync_resolution_log(
      hospital_id, conflict_id, table_name, record_id,
      resolution_type, field_decisions, final_data, resolved_by
    ) VALUES (
      v_conflict.hospital_id, p_conflict_id, v_conflict.table_name, v_conflict.record_id,
      p_resolution, p_field_decisions, p_final_data, p_resolved_by
    );
    RETURN TRUE;
  END IF;

  -- Build the actual UPDATE payload from p_final_data
  -- Strip metadata columns — those are managed by the trigger
  v_payload := p_final_data - '_version' - '_last_editor' - '_last_synced_at' - 'created_at' - 'updated_at';

  -- Apply the resolved data to the target row
  -- (dynamic SQL because we don't know the table name at compile time)
  -- Only UPDATE if there are fields to set; otherwise just log the resolution.
  IF v_payload IS NOT NULL AND v_payload != '{}'::jsonb THEN
    EXECUTE format(
      'UPDATE public.%I SET %s WHERE id = $1',
      v_conflict.table_name,
      (
        SELECT string_agg(format('%I = ($2)->%L', key, key), ', ')
        FROM jsonb_object_keys(v_payload) AS key
      )
    )
    USING v_conflict.record_id, v_payload;
  END IF;

  -- Log the resolution
  INSERT INTO public.sync_resolution_log(
    hospital_id, conflict_id, table_name, record_id,
    resolution_type, field_decisions, final_data, resolved_by
  ) VALUES (
    v_conflict.hospital_id, p_conflict_id, v_conflict.table_name, v_conflict.record_id,
    p_resolution, p_field_decisions, p_final_data, p_resolved_by
  );

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: fetch_pending_conflicts
-- Returns conflicts with computed conflicting_fields for the UI.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fetch_pending_conflicts(
  p_hospital_id UUID,
  p_limit INT DEFAULT 50
) RETURNS TABLE (
  id UUID,
  table_name TEXT,
  record_id UUID,
  client_version INT,
  server_version INT,
  client_data JSONB,
  server_data JSONB,
  conflicting_fields TEXT[],
  created_at TIMESTAMPTZ
) AS $$
  SELECT
    id, table_name, record_id,
    client_version, server_version,
    client_data, server_data,
    public.detect_conflicting_fields(client_data, server_data) AS conflicting_fields,
    created_at
  FROM public.sync_conflicts
  WHERE hospital_id = p_hospital_id
    AND status = 'pending'
  ORDER BY created_at DESC
  LIMIT p_limit;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

COMMIT;
