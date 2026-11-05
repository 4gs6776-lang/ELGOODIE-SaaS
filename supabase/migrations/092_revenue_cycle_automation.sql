-- =====================================================================
-- GOODIE-MEDHUB — 092_revenue_cycle_automation.sql
-- =====================================================================
-- Revenue Cycle Automation & Credit Control
--
-- Creates 3 tables:
--   1. payment_plans — installment schedules for outstanding balances
--   2. invoice_reminders — log of SMS/WhatsApp/in-app reminders sent
--   3. invoice_writeoffs — partial write-offs with approval workflow
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. payment_plans
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.payment_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  invoice_id          uuid REFERENCES public.invoices(id) ON DELETE CASCADE,
  total_amount        numeric(14,2) NOT NULL,
  amount_paid         numeric(14,2) NOT NULL DEFAULT 0,
  installment_count   integer NOT NULL,
  installment_amount  numeric(14,2) NOT NULL,
  frequency           text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
  next_due_date       date NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')),
  created_by          uuid REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_plans_hospital_idx ON public.payment_plans (hospital_id, status);
CREATE INDEX IF NOT EXISTS payment_plans_patient_idx ON public.payment_plans (patient_id);

ALTER TABLE public.payment_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_plans_select" ON public.payment_plans;
CREATE POLICY "payment_plans_select" ON public.payment_plans
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "payment_plans_insert" ON public.payment_plans;
CREATE POLICY "payment_plans_insert" ON public.payment_plans
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND (public.is_hospital_admin() OR public.is_owner()));
DROP POLICY IF EXISTS "payment_plans_update" ON public.payment_plans;
CREATE POLICY "payment_plans_update" ON public.payment_plans
  FOR UPDATE USING (hospital_id = public.current_hospital_id()) WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "payment_plans_delete" ON public.payment_plans;
CREATE POLICY "payment_plans_delete" ON public.payment_plans
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND (public.is_hospital_admin() OR public.is_owner()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_plans TO authenticated;

DROP TRIGGER IF EXISTS trg_payment_plans_updated_at ON public.payment_plans;
CREATE TRIGGER trg_payment_plans_updated_at BEFORE UPDATE ON public.payment_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.payment_plans REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'payment_plans') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_plans;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 2. invoice_reminders
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.invoice_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  reminder_type   text NOT NULL CHECK (reminder_type IN ('sms', 'whatsapp', 'email', 'in_app')),
  days_overdue    integer NOT NULL,
  message_content text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  delivery_status text DEFAULT 'sent' CHECK (delivery_status IN ('queued', 'sent', 'failed', 'delivered'))
);

CREATE INDEX IF NOT EXISTS invoice_reminders_hospital_idx ON public.invoice_reminders (hospital_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS invoice_reminders_invoice_idx ON public.invoice_reminders (invoice_id);

ALTER TABLE public.invoice_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_reminders_select" ON public.invoice_reminders;
CREATE POLICY "invoice_reminders_select" ON public.invoice_reminders
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "invoice_reminders_insert" ON public.invoice_reminders;
CREATE POLICY "invoice_reminders_insert" ON public.invoice_reminders
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id());
GRANT SELECT, INSERT ON public.invoice_reminders TO authenticated;

ALTER TABLE public.invoice_reminders REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'invoice_reminders') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.invoice_reminders;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 3. invoice_writeoffs
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.invoice_writeoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  invoice_id       uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  patient_id       uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by    uuid REFERENCES public.profiles(id),
  requested_by_name text,
  approved_by     uuid REFERENCES public.profiles(id),
  approved_by_name text,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_writeoffs_hospital_idx ON public.invoice_writeoffs (hospital_id, status);

ALTER TABLE public.invoice_writeoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_writeoffs_select" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_select" ON public.invoice_writeoffs
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "invoice_writeoffs_insert" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_insert" ON public.invoice_writeoffs
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND (public.is_hospital_admin() OR public.is_owner()));
DROP POLICY IF EXISTS "invoice_writeoffs_update" ON public.invoice_writeoffs;
CREATE POLICY "invoice_writeoffs_update" ON public.invoice_writeoffs
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND (public.is_hospital_admin() OR public.is_owner()))
  WITH CHECK (hospital_id = public.current_hospital_id());
GRANT SELECT, INSERT, UPDATE ON public.invoice_writeoffs TO authenticated;

ALTER TABLE public.invoice_writeoffs REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'invoice_writeoffs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.invoice_writeoffs;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- Verification
-- =====================================================================
DO $_$
BEGIN
  RAISE NOTICE 'Revenue cycle tables created: payment_plans, invoice_reminders, invoice_writeoffs';
END $_$;
