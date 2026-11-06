-- Migration 095 v3 (FIXED): HMO Claims
--
-- FIX HISTORY:
--   v1: encounter_id REFERENCES public.encounters(id) — encounters table doesn't exist
--   v2: Removed encounters FK (kept plain UUID). But still had `REFERENCES public.users(id)`
--   v3: Replaced `public.users(id)` with `public.profiles(id)` because
--        this project has NO `users` table — it uses `profiles`.
--
-- Run order: AFTER 00_cleanup_v2.sql

BEGIN;

-- ============================================================
-- hmo_claims
-- ============================================================
CREATE TABLE IF NOT EXISTS public.hmo_claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  -- encounter_id is a plain UUID (no FK). Project uses patient_vitals
  -- as its encounters table — see migration 059.
  encounter_id    UUID,
  hmo_provider    TEXT NOT NULL,
  hmo_policy_no   TEXT,
  hmo_member_id   TEXT,
  claim_number    TEXT,
  claim_type      TEXT NOT NULL DEFAULT 'inpatient'
                  CHECK (claim_type IN ('inpatient','outpatient','emergency','day_case')),
  date_of_service DATE NOT NULL DEFAULT CURRENT_DATE,
  admission_date  TIMESTAMPTZ,
  discharge_date  TIMESTAMPTZ,
  diagnosis_codes TEXT[],
  procedure_codes TEXT[],
  total_claimed   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_claimed >= 0),
  pre_auth_code   TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN (
                    'draft','submitted','acknowledged',
                    'processing','approved','partial_approved',
                    'rejected','paid','short_paid'
                  )),
  approved_amount NUMERIC(14,2),
  paid_amount     NUMERIC(14,2) DEFAULT 0,
  rejection_reason TEXT,
  submission_date TIMESTAMPTZ,
  response_date   TIMESTAMPTZ,
  prepared_by     UUID REFERENCES public.profiles(id),  -- FIX v3: profiles, not users
  prepared_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hmo_claims_hospital ON public.hmo_claims(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hmo_claims_patient ON public.hmo_claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_hmo_claims_status ON public.hmo_claims(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_hmo_claims_provider ON public.hmo_claims(hospital_id, hmo_provider);

-- ============================================================
-- hmo_claim_line_items
-- ============================================================
CREATE TABLE IF NOT EXISTS public.hmo_claim_line_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  claim_id        UUID NOT NULL REFERENCES public.hmo_claims(id) ON DELETE CASCADE,
  line_type       TEXT NOT NULL
                  CHECK (line_type IN (
                    'consultation','investigation','procedure',
                    'pharmacy','consumable','accommodation','other'
                  )),
  description     TEXT NOT NULL,
  code            TEXT,
  quantity        NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_price     NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  approved_quantity NUMERIC(10,2),
  approved_unit_price NUMERIC(14,2),
  approved_total  NUMERIC(14,2),
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hmoli_hospital ON public.hmo_claim_line_items(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hmoli_claim ON public.hmo_claim_line_items(claim_id);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.hmo_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hmo_claim_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hmo_claims_select_hospital" ON public.hmo_claims;
CREATE POLICY "hmo_claims_select_hospital" ON public.hmo_claims
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmo_claims_insert_hospital" ON public.hmo_claims;
CREATE POLICY "hmo_claims_insert_hospital" ON public.hmo_claims
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmo_claims_update_hospital" ON public.hmo_claims;
CREATE POLICY "hmo_claims_update_hospital" ON public.hmo_claims
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmo_claims_delete_hospital" ON public.hmo_claims;
CREATE POLICY "hmo_claims_delete_hospital" ON public.hmo_claims
  FOR DELETE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmoli_select_hospital" ON public.hmo_claim_line_items;
CREATE POLICY "hmoli_select_hospital" ON public.hmo_claim_line_items
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmoli_insert_hospital" ON public.hmo_claim_line_items;
CREATE POLICY "hmoli_insert_hospital" ON public.hmo_claim_line_items
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmoli_update_hospital" ON public.hmo_claim_line_items;
CREATE POLICY "hmoli_update_hospital" ON public.hmo_claim_line_items
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "hmoli_delete_hospital" ON public.hmo_claim_line_items;
CREATE POLICY "hmoli_delete_hospital" ON public.hmo_claim_line_items
  FOR DELETE USING (hospital_id = current_hospital_id());

-- ============================================================
-- RPC: generate_claim_number
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_hmo_claim_number(p_hospital_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_prefix TEXT;
  v_seq    INT;
  v_year   TEXT := TO_CHAR(CURRENT_DATE, 'YYYY');
BEGIN
  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq
  FROM (
    SELECT
      COALESCE(
        (regexp_match(claim_number, 'CLM-(\d+)-'))[1]::INT,
        0
      ) AS seq
    FROM public.hmo_claims
    WHERE hospital_id = p_hospital_id
      AND claim_number IS NOT NULL
  ) t;

  SELECT COALESCE(SUBSTRING(name FROM 1 FOR 3), 'HSP') INTO v_prefix
  FROM public.hospitals WHERE id = p_hospital_id;

  RETURN UPPER(v_prefix) || '-CLM-' || v_year || '-' || LPAD(v_seq::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
