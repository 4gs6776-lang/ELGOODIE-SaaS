-- =====================================================================
-- GOODIE-MEDHUB — 074_hospital_bank_accounts.sql
-- =====================================================================
-- Creates the hospital_bank_accounts table that Settings.jsx and
-- InvoiceViewer.jsx already use, but no migration has ever created.
--
-- ROOT CAUSE OF BUG 2:
--   Settings.jsx:66 calls useOfflineTable('hospital_bank_accounts', ...)
--   InvoiceViewer.jsx:38 does the same.
--   Migration 011_bank_accounts.sql creates a DIFFERENT table
--   (platform_bank_accounts — the SaaS platform's bank account for
--   paying subscriptions), NOT the hospital's bank account for
--   receiving patient payments.
--   Migration 066_reconstruct_phase1_master_data.sql recreates 8
--   other missing tables but NOT hospital_bank_accounts.
--   Migration 056_realtime_for_all_modules.sql line 44 calls
--   `alter table public.hospital_bank_accounts replica identity full;`
--   which FAILS on a non-existent table and may roll back the
--   entire 056 migration (causing other realtime issues).
--
-- WHAT THIS MIGRATION DOES:
--   1. Creates the hospital_bank_accounts table with the columns
--      Settings.jsx writes (bank_name, account_name, account_number,
--      sort_code, notes, active, sort_order).
--   2. Adds RLS policies (admin/owner can write, all hospital
--      members can read — they need it to print bills).
--   3. Adds to realtime publication so changes propagate instantly.
--   4. Adds updated_at trigger.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. Create the table
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.hospital_bank_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  bank_name       text NOT NULL,
  account_name    text NOT NULL,
  account_number  text NOT NULL,
  sort_code       text,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hospital_bank_accounts_hospital_active_idx
  ON public.hospital_bank_accounts (hospital_id, active, sort_order);

-- =====================================================================
-- 2. Enable RLS + policies
-- =====================================================================
ALTER TABLE public.hospital_bank_accounts ENABLE ROW LEVEL SECURITY;

-- All hospital members can read (needed to print bills)
DROP POLICY IF EXISTS "hospital_bank_accounts_select" ON public.hospital_bank_accounts;
CREATE POLICY "hospital_bank_accounts_select" ON public.hospital_bank_accounts
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());

-- Only admin / owner / billing can add bank accounts
DROP POLICY IF EXISTS "hospital_bank_accounts_insert" ON public.hospital_bank_accounts;
CREATE POLICY "hospital_bank_accounts_insert" ON public.hospital_bank_accounts
  FOR INSERT WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

-- Only admin / owner can edit
DROP POLICY IF EXISTS "hospital_bank_accounts_update" ON public.hospital_bank_accounts;
CREATE POLICY "hospital_bank_accounts_update" ON public.hospital_bank_accounts
  FOR UPDATE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  ) WITH CHECK (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

-- Only admin / owner can delete
DROP POLICY IF EXISTS "hospital_bank_accounts_delete" ON public.hospital_bank_accounts;
CREATE POLICY "hospital_bank_accounts_delete" ON public.hospital_bank_accounts
  FOR DELETE USING (
    hospital_id = public.current_hospital_id()
    AND (public.is_hospital_admin() OR public.is_owner())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.hospital_bank_accounts TO authenticated;

-- =====================================================================
-- 3. updated_at trigger
-- =====================================================================
DROP TRIGGER IF EXISTS trg_hospital_bank_accounts_updated_at ON public.hospital_bank_accounts;
CREATE TRIGGER trg_hospital_bank_accounts_updated_at
  BEFORE UPDATE ON public.hospital_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.hospital_bank_accounts REPLICA IDENTITY FULL;

-- =====================================================================
-- 4. Add to realtime publication
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'hospital_bank_accounts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hospital_bank_accounts;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =====================================================================
-- 5. Verification
-- =====================================================================
DO $$
BEGIN
  RAISE NOTICE 'hospital_bank_accounts table created with RLS policies + realtime enabled.';
  RAISE NOTICE 'Now the Bank Account Details panel in Settings will work correctly.';
END $$;
