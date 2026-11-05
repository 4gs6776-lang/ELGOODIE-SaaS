-- Migration 096: Add due_date to invoices
-- Required by the Revenue Cycle suite: aging buckets, reminder dispatch,
-- and overdue calculations all need an explicit due date on each invoice.
-- If absent, defaults to created_at + 30 days (Net-30 terms).

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- Backfill: any invoice without due_date gets Net-30 from creation
UPDATE public.invoices
   SET due_date = (created_at::date + INTERVAL '30 days')
 WHERE due_date IS NULL;

-- Index for aging queries
CREATE INDEX IF NOT EXISTS invoices_hospital_due_date_idx
  ON public.invoices (hospital_id, due_date)
  WHERE due_date IS NOT NULL;

COMMIT;
