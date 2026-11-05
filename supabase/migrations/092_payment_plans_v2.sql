-- Migration 092 v2 (FIXED): Payment Plans
--
-- FIX from v1: The original used `balance_amount GENERATED ALWAYS AS
-- (subquery)` which PostgreSQL REJECTS — generated columns can only
-- reference columns on the same row, never subqueries on other tables.
-- This version uses a regular column + a trigger that updates it
-- whenever an installment changes.
--
-- Run order: AFTER 00_cleanup_failed_revenue_cycle.sql

BEGIN;

-- ============================================================
-- payment_plans
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payment_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  total_amount    NUMERIC(14,2) NOT NULL CHECK (total_amount > 0),
  deposit_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- balance_amount is maintained by a trigger (see below).
  -- We can't use GENERATED ALWAYS AS because the value depends on a
  -- subquery against payment_plan_installments.
  balance_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- installment_amount is fine as GENERATED — only references same-row columns
  installment_amount NUMERIC(14,2) GENERATED ALWAYS AS (
    CASE WHEN installment_count > 0
         THEN ROUND(((total_amount - deposit_amount) / installment_count)::numeric, 2)
         ELSE 0
    END
  ) STORED,
  installment_count INT NOT NULL CHECK (installment_count > 0),
  frequency       TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (frequency IN ('weekly','biweekly','monthly')),
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date        DATE NOT NULL,
  next_due_date   DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','completed','defaulted','cancelled')),
  approved_by     UUID REFERENCES public.users(id),
  approved_at     TIMESTAMPTZ,
  notes           TEXT,
  created_by      UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_hospital
  ON public.payment_plans(hospital_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_patient
  ON public.payment_plans(patient_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_status
  ON public.payment_plans(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_plans_next_due
  ON public.payment_plans(next_due_date);

-- ============================================================
-- payment_plan_installments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payment_plan_installments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  plan_id         UUID NOT NULL REFERENCES public.payment_plans(id) ON DELETE CASCADE,
  installment_no  INT NOT NULL,
  due_date        DATE NOT NULL,
  amount_due      NUMERIC(14,2) NOT NULL,
  amount_paid     NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_id      UUID REFERENCES public.payments(id) ON DELETE SET NULL,
  paid_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','partial','paid','overdue')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, installment_no)
);

CREATE INDEX IF NOT EXISTS idx_ppi_hospital ON public.payment_plan_installments(hospital_id);
CREATE INDEX IF NOT EXISTS idx_ppi_plan ON public.payment_plan_installments(plan_id);
CREATE INDEX IF NOT EXISTS idx_ppi_status ON public.payment_plan_installments(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_ppi_due ON public.payment_plan_installments(due_date);

-- ============================================================
-- RLS policies
-- ============================================================
ALTER TABLE public.payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_plan_installments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_plans_select_hospital" ON public.payment_plans;
CREATE POLICY "payment_plans_select_hospital" ON public.payment_plans
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "payment_plans_insert_hospital" ON public.payment_plans;
CREATE POLICY "payment_plans_insert_hospital" ON public.payment_plans
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "payment_plans_update_hospital" ON public.payment_plans;
CREATE POLICY "payment_plans_update_hospital" ON public.payment_plans
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "payment_plans_delete_hospital" ON public.payment_plans;
CREATE POLICY "payment_plans_delete_hospital" ON public.payment_plans
  FOR DELETE USING (hospital_id = current_hospital_id());

-- Installments policies
DROP POLICY IF EXISTS "ppi_select_hospital" ON public.payment_plan_installments;
CREATE POLICY "ppi_select_hospital" ON public.payment_plan_installments
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "ppi_insert_hospital" ON public.payment_plan_installments;
CREATE POLICY "ppi_insert_hospital" ON public.payment_plan_installments
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "ppi_update_hospital" ON public.payment_plan_installments;
CREATE POLICY "ppi_update_hospital" ON public.payment_plan_installments
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "ppi_delete_hospital" ON public.payment_plan_installments;
CREATE POLICY "ppi_delete_hospital" ON public.payment_plan_installments
  FOR DELETE USING (hospital_id = current_hospital_id());

-- ============================================================
-- RPC: create_payment_plan
-- Creates a plan + auto-generates installments based on frequency
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_payment_plan(
  p_hospital_id        UUID,
  p_patient_id         UUID,
  p_invoice_id         UUID,
  p_total_amount       NUMERIC,
  p_deposit_amount     NUMERIC DEFAULT 0,
  p_installment_count  INT DEFAULT 3,
  p_frequency          TEXT DEFAULT 'monthly',
  p_start_date         DATE DEFAULT CURRENT_DATE,
  p_notes              TEXT DEFAULT NULL,
  p_user_id            UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_plan_id     UUID;
  v_installment NUMERIC(14,2);
  v_due_date    DATE := p_start_date;
  v_end_date    DATE;
  i             INT;
BEGIN
  IF p_deposit_amount >= p_total_amount THEN
    RAISE EXCEPTION 'Deposit cannot exceed total amount';
  END IF;

  v_installment := ROUND(
    (p_total_amount - p_deposit_amount) / p_installment_count,
    2
  );

  IF p_frequency = 'weekly' THEN
    v_end_date := p_start_date + (p_installment_count * 7);
  ELSIF p_frequency = 'biweekly' THEN
    v_end_date := p_start_date + (p_installment_count * 14);
  ELSE
    v_end_date := p_start_date + (p_installment_count * INTERVAL '1 month');
  END IF;

  INSERT INTO public.payment_plans(
    hospital_id, patient_id, invoice_id,
    total_amount, deposit_amount,
    balance_amount, -- initialised to total - deposit, will be maintained by trigger
    installment_count, frequency,
    start_date, end_date, next_due_date,
    notes, created_by
  ) VALUES (
    p_hospital_id, p_patient_id, p_invoice_id,
    p_total_amount, p_deposit_amount,
    p_total_amount - p_deposit_amount,
    p_installment_count, p_frequency,
    p_start_date, v_end_date, p_start_date,
    p_notes, p_user_id
  ) RETURNING id INTO v_plan_id;

  FOR i IN 1..p_installment_count LOOP
    IF p_frequency = 'weekly' THEN
      v_due_date := p_start_date + (i * 7);
    ELSIF p_frequency = 'biweekly' THEN
      v_due_date := p_start_date + (i * 14);
    ELSE
      v_due_date := p_start_date + (i * INTERVAL '1 month');
    END IF;

    INSERT INTO public.payment_plan_installments(
      hospital_id, plan_id, installment_no,
      due_date, amount_due
    ) VALUES (
      p_hospital_id, v_plan_id, i,
      v_due_date, v_installment
    );
  END LOOP;

  RETURN v_plan_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Trigger: recalc_balance_after_installment_change
-- Maintains payment_plans.balance_amount whenever an installment
-- is inserted/updated/deleted.
-- ============================================================
CREATE OR REPLACE FUNCTION public.recalc_plan_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_id UUID;
  v_total  NUMERIC;
  v_deposit NUMERIC;
  v_paid   NUMERIC;
BEGIN
  v_plan_id := COALESCE(NEW.plan_id, OLD.plan_id);
  IF v_plan_id IS NULL THEN RETURN NULL; END IF;

  SELECT total_amount, deposit_amount INTO v_total, v_deposit
  FROM public.payment_plans WHERE id = v_plan_id;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_paid
  FROM public.payment_plan_installments WHERE plan_id = v_plan_id;

  UPDATE public.payment_plans
     SET balance_amount = GREATEST(0, v_total - v_deposit - v_paid),
         updated_at = now()
   WHERE id = v_plan_id;

  RETURN NULL; -- AFTER trigger, result ignored
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_recalc_plan_balance ON public.payment_plan_installments;
CREATE TRIGGER trg_recalc_plan_balance
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION public.recalc_plan_balance();

-- ============================================================
-- Trigger: auto-mark installment overdue + auto-complete plan
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_overdue_installments()
RETURNS TRIGGER AS $$
BEGIN
  -- Mark overdue installments
  UPDATE public.payment_plan_installments
     SET status = 'overdue', updated_at = now()
   WHERE status IN ('pending','partial')
     AND due_date < CURRENT_DATE;

  -- Auto-complete plans where all installments are paid
  UPDATE public.payment_plans p
     SET status = 'completed', updated_at = now()
   WHERE p.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.payment_plan_installments i
        WHERE i.plan_id = p.id AND i.status <> 'paid'
     );

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_mark_overdue_installments ON public.payment_plan_installments;
CREATE TRIGGER trg_mark_overdue_installments
  AFTER INSERT OR UPDATE ON public.payment_plan_installments
  EXECUTE FUNCTION public.mark_overdue_installments();

-- ============================================================
-- RPC: get_payment_plan_aging
-- Returns payment plans grouped by aging bucket for dashboard.
-- Now computes balance inline (no dependency on the column).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_payment_plan_aging(
  p_hospital_id UUID
) RETURNS TABLE (
  bucket        TEXT,
  plan_count    BIGINT,
  total_outstanding NUMERIC
) AS $$
  WITH plan_balances AS (
    SELECT
      p.id,
      p.next_due_date,
      p.total_amount - p.deposit_amount - COALESCE(
        (SELECT SUM(amount_paid) FROM public.payment_plan_installments WHERE plan_id = p.id),
        0
      ) AS outstanding
    FROM public.payment_plans p
    WHERE p.hospital_id = p_hospital_id
      AND p.status = 'active'
  )
  SELECT
    CASE
      WHEN next_due_date >= CURRENT_DATE THEN 'current'
      WHEN next_due_date >= CURRENT_DATE - INTERVAL '7 days' THEN '1-7_days'
      WHEN next_due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '8-30_days'
      WHEN next_due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '31-60_days'
      ELSE 'over_60_days'
    END AS bucket,
    COUNT(*)::BIGINT,
    COALESCE(SUM(outstanding), 0)
  FROM plan_balances
  GROUP BY 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

COMMIT;
