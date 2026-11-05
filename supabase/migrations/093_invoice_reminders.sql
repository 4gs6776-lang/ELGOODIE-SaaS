-- Migration 093: Invoice Reminders
-- Tracks SMS/email reminders sent to patients about outstanding invoices.
-- Designed for Termii SMS gateway integration.

BEGIN;

-- ============================================================
-- invoice_reminders
-- One row per reminder dispatch (immutable log).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invoice_reminders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  payment_plan_id UUID REFERENCES public.payment_plans(id) ON DELETE SET NULL,
  reminder_type   TEXT NOT NULL DEFAULT 'invoice'
                  CHECK (reminder_type IN ('invoice','payment_plan','deposit_due','final_demand')),
  channel         TEXT NOT NULL DEFAULT 'sms'
                  CHECK (channel IN ('sms','email','both')),
  phone_number    TEXT,
  email_address   TEXT,
  message_body    TEXT NOT NULL,
  amount_outstanding NUMERIC(14,2) NOT NULL,
  days_overdue    INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','delivered','failed','cancelled')),
  gateway_message_id TEXT,
  gateway_response  JSONB,
  error_message   TEXT,
  sent_by         UUID REFERENCES public.users(id),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_reminders_hospital ON public.invoice_reminders(hospital_id);
CREATE INDEX IF NOT EXISTS idx_invoice_reminders_patient ON public.invoice_reminders(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoice_reminders_status ON public.invoice_reminders(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_invoice_reminders_sent_at ON public.invoice_reminders(sent_at);

-- ============================================================
-- invoice_reminder_templates
-- Reusable message templates with placeholders.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invoice_reminder_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  reminder_type   TEXT NOT NULL DEFAULT 'invoice'
                  CHECK (reminder_type IN ('invoice','payment_plan','deposit_due','final_demand')),
  template_body   TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, name)
);

-- Seed default templates (placeholders: {{patient_name}}, {{invoice_no}},
-- {{amount}}, {{due_date}}, {{hospital_name}}, {{phone}})
INSERT INTO public.invoice_reminder_templates
  (hospital_id, name, reminder_type, template_body)
SELECT
  id,
  'Default Invoice Reminder',
  'invoice',
  'Dear {{patient_name}}, your invoice {{invoice_no}} of {{amount}} is now due. Kindly pay at {{hospital_name}} or call {{phone}}. Thank you.'
FROM public.hospitals
ON CONFLICT DO NOTHING;

INSERT INTO public.invoice_reminder_templates
  (hospital_id, name, reminder_type, template_body)
SELECT
  id,
  'Payment Plan Installment',
  'payment_plan',
  'Dear {{patient_name}}, your installment of {{amount}} for your payment plan is due on {{due_date}}. Please pay at {{hospital_name}}. Thank you.'
FROM public.hospitals
ON CONFLICT DO NOTHING;

INSERT INTO public.invoice_reminder_templates
  (hospital_id, name, reminder_type, template_body)
SELECT
  id,
  'Final Demand',
  'final_demand',
  'FINAL NOTICE: Dear {{patient_name}}, invoice {{invoice_no}} of {{amount}} is {{days_overdue}} days overdue. Please pay immediately to avoid service restrictions. {{hospital_name}}.'
FROM public.hospitals
ON CONFLICT DO NOTHING;

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.invoice_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_reminder_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_reminders_select_hospital" ON public.invoice_reminders;
CREATE POLICY "invoice_reminders_select_hospital" ON public.invoice_reminders
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "invoice_reminders_insert_hospital" ON public.invoice_reminders;
CREATE POLICY "invoice_reminders_insert_hospital" ON public.invoice_reminders
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "invoice_reminders_update_hospital" ON public.invoice_reminders;
CREATE POLICY "invoice_reminders_update_hospital" ON public.invoice_reminders
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "invoice_reminders_delete_hospital" ON public.invoice_reminders;
CREATE POLICY "invoice_reminders_delete_hospital" ON public.invoice_reminders
  FOR DELETE USING (hospital_id = current_hospital_id());

-- Templates
DROP POLICY IF EXISTS "irt_select_hospital" ON public.invoice_reminder_templates;
CREATE POLICY "irt_select_hospital" ON public.invoice_reminder_templates
  FOR SELECT USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "irt_insert_hospital" ON public.invoice_reminder_templates;
CREATE POLICY "irt_insert_hospital" ON public.invoice_reminder_templates
  FOR INSERT WITH CHECK (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "irt_update_hospital" ON public.invoice_reminder_templates;
CREATE POLICY "irt_update_hospital" ON public.invoice_reminder_templates
  FOR UPDATE USING (hospital_id = current_hospital_id());

DROP POLICY IF EXISTS "irt_delete_hospital" ON public.invoice_reminder_templates;
CREATE POLICY "irt_delete_hospital" ON public.invoice_reminder_templates
  FOR DELETE USING (hospital_id = current_hospital_id());

-- ============================================================
-- RPC: queue_reminder_for_invoice
-- Auto-creates reminder row using default template
-- ============================================================
CREATE OR REPLACE FUNCTION public.queue_reminder_for_invoice(
  p_hospital_id    UUID,
  p_invoice_id     UUID,
  p_reminder_type  TEXT DEFAULT 'invoice',
  p_channel        TEXT DEFAULT 'sms',
  p_user_id        UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_invoice   RECORD;
  v_patient   RECORD;
  v_hospital  RECORD;
  v_template  TEXT;
  v_message   TEXT;
  v_amount    NUMERIC;
  v_reminder_id UUID;
  v_days_overdue INT;
BEGIN
  SELECT i.*, COALESCE(i.total_amount, 0) - COALESCE(i.amount_paid, 0) AS outstanding
  INTO v_invoice
  FROM public.invoices i
  WHERE i.id = p_invoice_id AND i.hospital_id = p_hospital_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.outstanding <= 0 THEN
    RETURN NULL;  -- Nothing to remind
  END IF;

  SELECT * INTO v_patient FROM public.patients WHERE id = v_invoice.patient_id;
  SELECT * INTO v_hospital FROM public.hospitals WHERE id = p_hospital_id;

  SELECT template_body INTO v_template
  FROM public.invoice_reminder_templates
  WHERE hospital_id = p_hospital_id
    AND reminder_type = p_reminder_type
    AND is_active = TRUE
  ORDER BY created_at LIMIT 1;

  IF v_template IS NULL THEN
    v_template := 'Dear {{patient_name}}, your invoice {{invoice_no}} of {{amount}} is due. {{hospital_name}}.';
  END IF;

  v_days_overdue := CASE
    WHEN v_invoice.due_date IS NOT NULL AND v_invoice.due_date < CURRENT_DATE
    THEN CURRENT_DATE - v_invoice.due_date
    ELSE 0
  END;

  v_message := v_template;
  v_message := REPLACE(v_message, '{{patient_name}}', COALESCE(v_patient.full_name, 'Patient'));
  v_message := REPLACE(v_message, '{{invoice_no}}', COALESCE(v_invoice.invoice_number::TEXT, 'N/A'));
  v_message := REPLACE(v_message, '{{amount}}', TO_CHAR(v_invoice.outstanding, 'FM999,999,999.00'));
  v_message := REPLACE(v_message, '{{due_date}}', COALESCE(v_invoice.due_date::TEXT, 'N/A'));
  v_message := REPLACE(v_message, '{{hospital_name}}', COALESCE(v_hospital.name, 'Hospital'));
  v_message := REPLACE(v_message, '{{phone}}', COALESCE(v_hospital.phone, ''));
  v_message := REPLACE(v_message, '{{days_overdue}}', v_days_overdue::TEXT);

  INSERT INTO public.invoice_reminders(
    hospital_id, patient_id, invoice_id,
    reminder_type, channel,
    phone_number, email_address,
    message_body, amount_outstanding, days_overdue,
    sent_by, status
  ) VALUES (
    p_hospital_id, v_invoice.patient_id, p_invoice_id,
    p_reminder_type, p_channel,
    v_patient.phone, v_patient.email,
    v_message, v_invoice.outstanding, v_days_overdue,
    p_user_id, 'queued'
  ) RETURNING id INTO v_reminder_id;

  RETURN v_reminder_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
