-- Migration 094 v4 (FINAL FIX): Invoice Write-offs
--
-- FIX HISTORY:
--   v1: CREATE POLICY IF EXISTS — invalid PostgreSQL syntax
--   v2: Removed IF EXISTS, but still had `REFERENCES public.users(id)`
--   v3: Replaced `public.users` with `public.profiles`
--   v4: ALSO fixes the parameter ordering in request_writeoff RPC.
--       PostgreSQL requires that once a parameter has a default value,
--       all following parameters must also have defaults.
--
--       v3 had:
--         p_writeoff_type   TEXT DEFAULT 'bad_debt',  -- has default
--         p_reason          TEXT,                      -- NO default ❌
--         p_justification   TEXT DEFAULT NULL,
--         p_user_id         UUID,
--         p_threshold       NUMERIC DEFAULT 50000.00
--
--       v4 fixes by giving defaults to ALL parameters after the first
--       one with a default:
--         p_writeoff_type   TEXT DEFAULT 'bad_debt',
--         p_reason          TEXT DEFAULT NULL,         -- ✅
--         p_justification   TEXT DEFAULT NULL,
--         p_user_id         UUID DEFAULT NULL,         -- ✅
--         p_threshold       NUMERIC DEFAULT 50000.00
--
-- Run order: AFTER 00_cleanup_v3.sql

BEGIN;

-- ============================================================
-- invoice_writeoffs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invoice_writeoffs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  payment_plan_id UUID REFERENCES public.payment_plans(id) ON DELETE SET NULL,
  writeoff_amount NUMERIC(14,2) NOT NULL CHECK (writeoff_amount > 0),
  writeoff_type   TEXT NOT NULL DEFAULT 'bad_debt'
                  CHECK (writeoff_type IN (
                    'bad_debt','charity_care','administrative',
                    'insurance_shortfall','courtesy_adjustment'
                  )),
  reason          TEXT NOT NULL,
  justification   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN (
                    'pending_approval','approved','rejected',
                    'applied','cancelled'
                  )),
  requested_by    UUID NOT NULL REFERENCES public.profiles(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by     UUID REFERENCES public.profiles(id),
  approved_at     TIMESTAMPTZ,
  rejected_reason TEXT,
  applied_at      TIMESTAMPTZ,
  approval_threshold NUMERIC(14,2) NOT NULL DEFAULT 50000.00,
  requires_admin_approval BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_writeoffs_hospital ON public.invoice_writeoffs(hospital_id);
CREATE INDEX IF NOT EXISTS idx_invoice_writeoffs_patient ON public.invoice_writeoffs(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoice_writeoffs_status ON public.invoice_writeoffs(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_invoice_writeoffs_pending ON public.invoice_writeoffs(status, requested_at);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.invoice_writeoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_writeoffs_select_hospital" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_select_hospital" ON public.invoice_writeoffs
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "invoice_writeoffs_insert_hospital" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_insert_hospital" ON public.invoice_writeoffs
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "invoice_writeoffs_update_hospital" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_update_hospital" ON public.invoice_writeoffs
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "invoice_writeoffs_delete_hospital" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_delete_hospital" ON public.invoice_writeoffs
  FOR DELETE USING (hospital_id = current_hospital_id());

-- ============================================================
-- Trigger: auto-flag for admin approval if above threshold
-- ============================================================
CREATE OR REPLACE FUNCTION public.flag_writeoff_for_approval()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'pending_approval' AND NEW.requires_admin_approval IS FALSE THEN
    IF NEW.writeoff_amount >= NEW.approval_threshold THEN
      NEW.requires_admin_approval := TRUE;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_flag_writeoff_for_approval ON public.invoice_writeoffs;
CREATE TRIGGER trg_flag_writeoff_for_approval
  BEFORE INSERT OR UPDATE OF status ON public.invoice_writeoffs
  FOR EACH ROW EXECUTE FUNCTION public.flag_writeoff_for_approval();

-- ============================================================
-- RPC: request_writeoff
-- FIX v4: ALL parameters after p_writeoff_type now have defaults.
-- PostgreSQL requires this: once a parameter has a default, all
-- subsequent parameters must also have defaults.
--
-- The JS client (WriteOffManager.jsx) calls this RPC with named
-- parameters, so adding defaults doesn't break the calling code.
-- ============================================================
CREATE OR REPLACE FUNCTION public.request_writeoff(
  p_hospital_id    UUID,
  p_patient_id      UUID,
  p_invoice_id      UUID DEFAULT NULL,
  p_amount          NUMERIC DEFAULT 0,        -- FIX v4: was NUMERIC (no default) — gave it a default to keep the chain valid
  p_writeoff_type   TEXT DEFAULT 'bad_debt',
  p_reason          TEXT DEFAULT NULL,         -- FIX v4: was TEXT (no default)
  p_justification   TEXT DEFAULT NULL,
  p_user_id         UUID DEFAULT NULL,         -- FIX v4: was UUID (no default)
  p_threshold       NUMERIC DEFAULT 50000.00
) RETURNS UUID AS $$
DECLARE
  v_writeoff_id  UUID;
  v_requires_admin BOOLEAN := FALSE;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Write-off amount must be greater than zero';
  END IF;

  -- Sanity: p_reason is required by business logic even though it
  -- has a default of NULL at the SQL level (so the RPC signature
  -- is valid). Enforce here.
  IF p_reason IS NULL OR p_reason = '' THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;

  v_requires_admin := (p_amount >= p_threshold);

  INSERT INTO public.invoice_writeoffs(
    hospital_id, patient_id, invoice_id,
    writeoff_amount, writeoff_type,
    reason, justification,
    status, requested_by, approval_threshold, requires_admin_approval
  ) VALUES (
    p_hospital_id, p_patient_id, p_invoice_id,
    p_amount, p_writeoff_type,
    p_reason, p_justification,
    'pending_approval', p_user_id, p_threshold, v_requires_admin
  ) RETURNING id INTO v_writeoff_id;

  IF NOT v_requires_admin THEN
    UPDATE public.invoice_writeoffs
       SET status = 'approved',
           approved_by = p_user_id,
           approved_at = now()
     WHERE id = v_writeoff_id;
  END IF;

  RETURN v_writeoff_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: approve_writeoff
-- (already correct — all parameters after p_decision have defaults)
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_writeoff(
  p_writeoff_id UUID,
  p_approver_id UUID,
  p_decision    TEXT,
  p_reject_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_invoice_id UUID;
  v_amount     NUMERIC;
BEGIN
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  UPDATE public.invoice_writeoffs
     SET status = p_decision,
         approved_by = p_approver_id,
         approved_at = now(),
         rejected_reason = p_reject_reason,
         updated_at = now()
   WHERE id = p_writeoff_id
     AND status = 'pending_approval'
  RETURNING invoice_id, writeoff_amount INTO v_invoice_id, v_amount;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF p_decision = 'approved' AND v_invoice_id IS NOT NULL THEN
    UPDATE public.invoices
       SET amount_paid = COALESCE(amount_paid, 0) + v_amount,
           updated_at = now()
     WHERE id = v_invoice_id;

    UPDATE public.invoice_writeoffs
       SET status = 'applied',
           applied_at = now(),
           updated_at = now()
     WHERE id = p_writeoff_id;
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- View: pending writeoffs dashboard
-- ============================================================
CREATE OR REPLACE VIEW public.v_pending_writeoffs AS
SELECT
  w.id,
  w.hospital_id,
  w.patient_id,
  p.full_name AS patient_name,
  p.hospital_number,
  w.invoice_id,
  w.writeoff_amount,
  w.writeoff_type,
  w.reason,
  w.requires_admin_approval,
  w.status,
  w.requested_by,
  pr.full_name AS requested_by_name,
  w.requested_at
FROM public.invoice_writeoffs w
JOIN public.patients p ON p.id = w.patient_id
LEFT JOIN public.profiles pr ON pr.id = w.requested_by
WHERE w.status = 'pending_approval';

COMMIT;
