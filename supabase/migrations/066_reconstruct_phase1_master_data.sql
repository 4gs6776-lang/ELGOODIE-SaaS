-- =====================================================================
-- GOODIE-MEDHUB — 066_reconstruct_phase1_master_data.sql
-- =====================================================================
-- Reconstructs the 9 empty migration files (031-040) that were supposed
-- to create the Phase 1 Billing Master Data tables but were committed
-- with 0 bytes. The tables ARE referenced by the React codebase and
-- downstream ALTER migrations (045, 049, 051, 052, 053, 054, 060, 062)
-- — so they must exist in production. This migration creates them all.
--
-- Tables created:
--   1. hospital_registration_fees  (was 031)
--   2. message_channel_reads       (was 033)
--   3. service_catalog              (was 034)
--   4. price_lists + price_list_items (was 035)
--   5. hmo_contracts                (was 036)
--   6. hospital_payment_methods     (was 037)
--   7. expense_vendors             (was 038)
--   8. document_sequences + next_document_number() RPC (was 039)
--   9. Seed data (was 040): 5 reg fees + 6 payment methods + 1 default
--      price list + 33 services + 33 price list items per hospital
--
-- Safe to re-run (IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- Run AFTER 065_hmo_providers_table.sql.
-- =====================================================================

-- =====================================================================
-- 1. hospital_registration_fees  (was 031)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.hospital_registration_fees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  category        text NOT NULL CHECK (category IN ('personal', 'family', 'emergency', 'anc', 'hmo')),
  amount          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  is_active       boolean NOT NULL DEFAULT true,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hospital_registration_fees_hospital_category_uniq
  ON public.hospital_registration_fees (hospital_id, category);
CREATE INDEX IF NOT EXISTS hospital_registration_fees_hospital_active_idx
  ON public.hospital_registration_fees (hospital_id, is_active);
ALTER TABLE public.hospital_registration_fees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hospital_registration_fees_select" ON public.hospital_registration_fees;
CREATE POLICY "hospital_registration_fees_select" ON public.hospital_registration_fees
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "hospital_registration_fees_insert" ON public.hospital_registration_fees;
CREATE POLICY "hospital_registration_fees_insert" ON public.hospital_registration_fees
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "hospital_registration_fees_update" ON public.hospital_registration_fees;
CREATE POLICY "hospital_registration_fees_update" ON public.hospital_registration_fees
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "hospital_registration_fees_delete" ON public.hospital_registration_fees;
CREATE POLICY "hospital_registration_fees_delete" ON public.hospital_registration_fees
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_hospital_registration_fees_updated_at ON public.hospital_registration_fees;
CREATE TRIGGER trg_hospital_registration_fees_updated_at BEFORE UPDATE ON public.hospital_registration_fees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.hospital_registration_fees REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'hospital_registration_fees') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.hospital_registration_fees; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 2. message_channel_reads  (was 033)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.message_channel_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  channel_type    text NOT NULL,
  channel_key     text NOT NULL,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS message_channel_reads_user_channel_uniq
  ON public.message_channel_reads (hospital_id, user_id, channel_type, channel_key);
CREATE INDEX IF NOT EXISTS message_channel_reads_user_idx
  ON public.message_channel_reads (hospital_id, user_id);
ALTER TABLE public.message_channel_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "message_channel_reads_select" ON public.message_channel_reads;
CREATE POLICY "message_channel_reads_select" ON public.message_channel_reads
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "message_channel_reads_insert" ON public.message_channel_reads;
CREATE POLICY "message_channel_reads_insert" ON public.message_channel_reads
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND user_id = auth.uid());
DROP POLICY IF EXISTS "message_channel_reads_update" ON public.message_channel_reads;
CREATE POLICY "message_channel_reads_update" ON public.message_channel_reads
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND user_id = auth.uid())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "message_channel_reads_delete" ON public.message_channel_reads;
CREATE POLICY "message_channel_reads_delete" ON public.message_channel_reads
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND user_id = auth.uid());
DROP TRIGGER IF EXISTS trg_message_channel_reads_updated_at ON public.message_channel_reads;
CREATE TRIGGER trg_message_channel_reads_updated_at BEFORE UPDATE ON public.message_channel_reads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.message_channel_reads REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'message_channel_reads') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.message_channel_reads; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 3. service_catalog  (was 034)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.service_catalog (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,
  category        text NOT NULL CHECK (category IN ('consultation', 'lab', 'procedure', 'drug', 'bed', 'service', 'anc_package', 'registration', 'other')),
  sub_category    text,
  default_price   numeric(14, 2) NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  default_cost    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (default_cost >= 0),
  unit            text,
  is_taxable      boolean NOT NULL DEFAULT false,
  tax_rate        numeric(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  sort_order      integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_hospital_code_uniq
  ON public.service_catalog (hospital_id, code);
CREATE INDEX IF NOT EXISTS service_catalog_hospital_active_idx
  ON public.service_catalog (hospital_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS service_catalog_hospital_category_idx
  ON public.service_catalog (hospital_id, category, is_active);
ALTER TABLE public.service_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_catalog_select" ON public.service_catalog;
CREATE POLICY "service_catalog_select" ON public.service_catalog
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "service_catalog_insert" ON public.service_catalog;
CREATE POLICY "service_catalog_insert" ON public.service_catalog
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "service_catalog_update" ON public.service_catalog;
CREATE POLICY "service_catalog_update" ON public.service_catalog
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "service_catalog_delete" ON public.service_catalog;
CREATE POLICY "service_catalog_delete" ON public.service_catalog
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_service_catalog_updated_at ON public.service_catalog;
CREATE TRIGGER trg_service_catalog_updated_at BEFORE UPDATE ON public.service_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.service_catalog REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'service_catalog') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.service_catalog; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 4. price_lists + price_list_items  (was 035)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.price_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,
  type            text NOT NULL DEFAULT 'standard' CHECK (type IN ('standard', 'hmo', 'staff', 'corporate', 'charity', 'custom')),
  is_default      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  effective_from  date,
  effective_to    date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS price_lists_hospital_code_uniq
  ON public.price_lists (hospital_id, code);
CREATE INDEX IF NOT EXISTS price_lists_hospital_active_idx
  ON public.price_lists (hospital_id, is_active);
CREATE INDEX IF NOT EXISTS price_lists_hospital_default_idx
  ON public.price_lists (hospital_id, is_default) WHERE is_default = true;
ALTER TABLE public.price_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "price_lists_select" ON public.price_lists;
CREATE POLICY "price_lists_select" ON public.price_lists
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "price_lists_insert" ON public.price_lists;
CREATE POLICY "price_lists_insert" ON public.price_lists
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "price_lists_update" ON public.price_lists;
CREATE POLICY "price_lists_update" ON public.price_lists
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "price_lists_delete" ON public.price_lists;
CREATE POLICY "price_lists_delete" ON public.price_lists
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_price_lists_updated_at ON public.price_lists;
CREATE TRIGGER trg_price_lists_updated_at BEFORE UPDATE ON public.price_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.price_lists REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'price_lists') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.price_lists; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.price_list_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  price_list_id       uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
  service_catalog_id  uuid NOT NULL REFERENCES public.service_catalog(id) ON DELETE CASCADE,
  price               numeric(14, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  coverage_percent    numeric(5, 2) NOT NULL DEFAULT 0 CHECK (coverage_percent >= 0 AND coverage_percent <= 100),
  copay_percent       numeric(5, 2) NOT NULL DEFAULT 0 CHECK (copay_percent >= 0 AND copay_percent <= 100),
  copay_amount        numeric(14, 2) NOT NULL DEFAULT 0 CHECK (copay_amount >= 0),
  is_excluded         boolean NOT NULL DEFAULT false,
  prior_auth_required boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_pl_service_uniq
  ON public.price_list_items (price_list_id, service_catalog_id);
CREATE INDEX IF NOT EXISTS price_list_items_service_idx
  ON public.price_list_items (service_catalog_id);
ALTER TABLE public.price_list_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "price_list_items_select" ON public.price_list_items;
CREATE POLICY "price_list_items_select" ON public.price_list_items
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "price_list_items_insert" ON public.price_list_items;
CREATE POLICY "price_list_items_insert" ON public.price_list_items
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "price_list_items_update" ON public.price_list_items;
CREATE POLICY "price_list_items_update" ON public.price_list_items
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "price_list_items_delete" ON public.price_list_items;
CREATE POLICY "price_list_items_delete" ON public.price_list_items
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_price_list_items_updated_at ON public.price_list_items;
CREATE TRIGGER trg_price_list_items_updated_at BEFORE UPDATE ON public.price_list_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.price_list_items REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'price_list_items') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.price_list_items; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 5. hmo_contracts  (was 036)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.hmo_contracts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id                 uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  payer_name                  text NOT NULL,
  payer_type                  text NOT NULL DEFAULT 'hmo' CHECK (payer_type IN ('hmo', 'insurance', 'corporate', 'government')),
  contract_code               text NOT NULL,
  policy_prefix               text,
  contact_name                text,
  contact_phone               text,
  contact_email               text,
  address                     text,
  default_coverage_percent    numeric(5, 2) NOT NULL DEFAULT 0 CHECK (default_coverage_percent >= 0 AND default_coverage_percent <= 100),
  requires_pre_auth           boolean NOT NULL DEFAULT false,
  pre_auth_phone              text,
  pre_auth_email               text,
  price_list_id               uuid REFERENCES public.price_lists(id) ON DELETE SET NULL,
  effective_from              date,
  effective_to                date,
  is_active                   boolean NOT NULL DEFAULT true,
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hmo_contracts_hospital_code_uniq
  ON public.hmo_contracts (hospital_id, contract_code);
CREATE INDEX IF NOT EXISTS hmo_contracts_hospital_active_idx
  ON public.hmo_contracts (hospital_id, is_active, payer_name);
CREATE INDEX IF NOT EXISTS hmo_contracts_price_list_idx
  ON public.hmo_contracts (price_list_id) WHERE price_list_id IS NOT NULL;
ALTER TABLE public.hmo_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hmo_contracts_select" ON public.hmo_contracts;
CREATE POLICY "hmo_contracts_select" ON public.hmo_contracts
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "hmo_contracts_insert" ON public.hmo_contracts;
CREATE POLICY "hmo_contracts_insert" ON public.hmo_contracts
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "hmo_contracts_update" ON public.hmo_contracts;
CREATE POLICY "hmo_contracts_update" ON public.hmo_contracts
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "hmo_contracts_delete" ON public.hmo_contracts;
CREATE POLICY "hmo_contracts_delete" ON public.hmo_contracts
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_hmo_contracts_updated_at ON public.hmo_contracts;
CREATE TRIGGER trg_hmo_contracts_updated_at BEFORE UPDATE ON public.hmo_contracts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.hmo_contracts REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'hmo_contracts') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.hmo_contracts; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 6. hospital_payment_methods  (was 037)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.hospital_payment_methods (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id                 uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  code                        text NOT NULL,
  label                       text NOT NULL,
  requires_reference          boolean NOT NULL DEFAULT false,
  reconciles_to_cash_drawer   boolean NOT NULL DEFAULT false,
  sort_order                  integer NOT NULL DEFAULT 0,
  is_active                   boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hospital_payment_methods_hospital_code_uniq
  ON public.hospital_payment_methods (hospital_id, code);
CREATE INDEX IF NOT EXISTS hospital_payment_methods_hospital_active_idx
  ON public.hospital_payment_methods (hospital_id, is_active, sort_order);
ALTER TABLE public.hospital_payment_methods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hospital_payment_methods_select" ON public.hospital_payment_methods;
CREATE POLICY "hospital_payment_methods_select" ON public.hospital_payment_methods
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "hospital_payment_methods_insert" ON public.hospital_payment_methods;
CREATE POLICY "hospital_payment_methods_insert" ON public.hospital_payment_methods
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "hospital_payment_methods_update" ON public.hospital_payment_methods;
CREATE POLICY "hospital_payment_methods_update" ON public.hospital_payment_methods
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "hospital_payment_methods_delete" ON public.hospital_payment_methods;
CREATE POLICY "hospital_payment_methods_delete" ON public.hospital_payment_methods
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_hospital_payment_methods_updated_at ON public.hospital_payment_methods;
CREATE TRIGGER trg_hospital_payment_methods_updated_at BEFORE UPDATE ON public.hospital_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.hospital_payment_methods REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'hospital_payment_methods') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.hospital_payment_methods; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 7. expense_vendors  (was 038)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.expense_vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  name                text NOT NULL,
  vendor_type         text NOT NULL DEFAULT 'supplier' CHECK (vendor_type IN ('supplier', 'utility', 'contractor', 'staff', 'government', 'other')),
  contact_name        text,
  phone               text,
  email               text,
  address             text,
  bank_name           text,
  account_name        text,
  account_number      text,
  sort_code           text,
  tax_id              text,
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_vendors_hospital_name_uniq
  ON public.expense_vendors (hospital_id, name);
CREATE INDEX IF NOT EXISTS expense_vendors_hospital_active_idx
  ON public.expense_vendors (hospital_id, is_active, vendor_type);
ALTER TABLE public.expense_vendors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "expense_vendors_select" ON public.expense_vendors;
CREATE POLICY "expense_vendors_select" ON public.expense_vendors
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
DROP POLICY IF EXISTS "expense_vendors_insert" ON public.expense_vendors;
CREATE POLICY "expense_vendors_insert" ON public.expense_vendors
  FOR INSERT WITH CHECK (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP POLICY IF EXISTS "expense_vendors_update" ON public.expense_vendors;
CREATE POLICY "expense_vendors_update" ON public.expense_vendors
  FOR UPDATE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin())
  WITH CHECK (hospital_id = public.current_hospital_id());
DROP POLICY IF EXISTS "expense_vendors_delete" ON public.expense_vendors;
CREATE POLICY "expense_vendors_delete" ON public.expense_vendors
  FOR DELETE USING (hospital_id = public.current_hospital_id() AND public.is_hospital_admin());
DROP TRIGGER IF EXISTS trg_expense_vendors_updated_at ON public.expense_vendors;
CREATE TRIGGER trg_expense_vendors_updated_at BEFORE UPDATE ON public.expense_vendors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.expense_vendors REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'expense_vendors') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.expense_vendors; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =====================================================================
-- 8. document_sequences + next_document_number() RPC  (was 039)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.document_sequences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  doc_type        text NOT NULL,
  fiscal_year     integer NOT NULL,
  prefix          text NOT NULL DEFAULT '',
  next_value      integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_sequences_hospital_type_year_uniq
  ON public.document_sequences (hospital_id, doc_type, fiscal_year);
ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_sequences_select" ON public.document_sequences;
CREATE POLICY "document_sequences_select" ON public.document_sequences
  FOR SELECT USING (hospital_id = public.current_hospital_id() OR public.is_owner());
-- No INSERT/UPDATE/DELETE policies — mutations happen ONLY through the
-- SECURITY DEFINER next_document_number() RPC below.
DROP TRIGGER IF EXISTS trg_document_sequences_updated_at ON public.document_sequences;
CREATE TRIGGER trg_document_sequences_updated_at BEFORE UPDATE ON public.document_sequences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.document_sequences REPLICA IDENTITY FULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'document_sequences') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.document_sequences; END IF; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- next_document_number() — atomic, concurrency-safe sequential numbering
-- DROP first because CREATE OR REPLACE can't change the return type
-- of an existing function (PostgreSQL error 42P13). This happens when
-- the function was created during a previous partial run of this migration.
DROP FUNCTION IF EXISTS public.next_document_number(uuid, text, integer) CASCADE;

CREATE OR REPLACE FUNCTION public.next_document_number(
  p_hospital_id  uuid,
  p_doc_type     text,
  p_fiscal_year  integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix      text;
  v_next_value  integer;
  v_doc_number  text;
BEGIN
  v_prefix := CASE p_doc_type
    WHEN 'invoice'     THEN 'INV-'
    WHEN 'receipt'     THEN 'RCT-'
    WHEN 'credit_note' THEN 'CN-'
    WHEN 'claim'       THEN 'CLM-'
    WHEN 'expense'     THEN 'EXP-'
    WHEN 'statement'   THEN 'STMT-'
    WHEN 'deposit'     THEN 'DEP-'
    WHEN 'sale'        THEN 'SALE-'
    ELSE UPPER(p_doc_type) || '-'
  END;

  INSERT INTO public.document_sequences (hospital_id, doc_type, fiscal_year, prefix, next_value)
  VALUES (p_hospital_id, p_doc_type, p_fiscal_year, v_prefix, 1)
  ON CONFLICT (hospital_id, doc_type, fiscal_year)
  DO UPDATE SET next_value = public.document_sequences.next_value + 1,
                updated_at = now()
  RETURNING next_value INTO v_next_value;

  v_doc_number := v_prefix || LPAD(v_next_value::text, 6, '0');
  RETURN v_doc_number;
END;
$$;
GRANT EXECUTE ON FUNCTION public.next_document_number(uuid, text, integer) TO authenticated;

-- =====================================================================
-- 9. SEED DEFAULTS  (was 040)
-- =====================================================================
DO $$
DECLARE
  h RECORD;
  v_pl_id uuid;
BEGIN
  FOR h IN SELECT id FROM public.hospitals LOOP
    -- (a) Registration fees
    INSERT INTO public.hospital_registration_fees (hospital_id, category, amount, is_active)
    VALUES
      (h.id, 'personal',  5000, true),
      (h.id, 'family',    10000, true),
      (h.id, 'emergency',  8000, true),
      (h.id, 'anc',       30000, true),
      (h.id, 'hmo',          0, true)
    ON CONFLICT (hospital_id, category) DO NOTHING;

    -- (b) Payment methods
    INSERT INTO public.hospital_payment_methods (hospital_id, code, label, requires_reference, reconciles_to_cash_drawer, is_active, sort_order)
    VALUES
      (h.id, 'cash',     'Cash',                  false, true,  true, 1),
      (h.id, 'pos',      'POS Terminal',          true,  true,  true, 2),
      (h.id, 'transfer', 'Bank Transfer',         true,  false, true, 3),
      (h.id, 'cheque',   'Cheque',                true,  false, true, 4),
      (h.id, 'wallet',   'Patient Wallet',        false, false, true, 5),
      (h.id, 'hmo',      'HMO / Insurance',        false, false, true, 6)
    ON CONFLICT (hospital_id, code) DO NOTHING;

    -- (c) Default price list (STD — Standard Tariff)
    INSERT INTO public.price_lists (hospital_id, code, name, description, type, is_default, is_active)
    VALUES (h.id, 'STD', 'Standard Tariff',
            'Default walk-in tariff. Edit per-service prices below or create additional tariffs (HMO, staff, corporate).',
            'standard', true, true)
    ON CONFLICT (hospital_id, code) DO NOTHING
    RETURNING id INTO v_pl_id;
    IF v_pl_id IS NULL THEN
      SELECT id INTO v_pl_id FROM public.price_lists WHERE hospital_id = h.id AND code = 'STD';
    END IF;

    -- (d) Service catalog (33 services)
    INSERT INTO public.service_catalog (hospital_id, code, name, description, category, default_price, default_cost, unit, sort_order, is_active)
    VALUES
      -- Consultations (4)
      (h.id, 'CONS-GEN',  'General Consultation',         'Standard doctor consultation',                       'consultation', 5000,  0, 'session',  1, true),
      (h.id, 'CONS-SPC',  'Specialist Consultation',      'Specialist referral consultation',                  'consultation', 10000, 0, 'session',  2, true),
      (h.id, 'CONS-FOL',  'Follow-up Consultation',       'Follow-up visit within 14 days',                    'consultation', 3000,  0, 'session',  3, true),
      (h.id, 'CONS-EMG',  'Emergency Consultation',       'After-hours emergency consultation',                'consultation', 8000,  0, 'session',  4, true),
      -- Laboratory (10)
      (h.id, 'LAB-FBC',  'Full Blood Count',                'CBC with differential',                        'lab', 3000, 0, 'test', 11, true),
      (h.id, 'LAB-URINE','Urinalysis',                      'Routine urine analysis',                       'lab', 1500, 0, 'test', 12, true),
      (h.id, 'LAB-STOOL','Stool Analysis',                  'Routine stool microscopy',                     'lab', 1500, 0, 'test', 13, true),
      (h.id, 'LAB-WIDAL','Widal Test',                      'Typhoid serology',                              'lab', 2500, 0, 'test', 14, true),
      (h.id, 'LAB-MPS',  'Malaria Parasite Screen',        'Blood film for malaria parasites',              'lab', 1000, 0, 'test', 15, true),
      (h.id, 'LAB-LFT',  'Liver Function Test',            'Bilirubin, ALT, AST, ALP, albumin',            'lab', 5000, 0, 'test', 16, true),
      (h.id, 'LAB-RFT',  'Renal Function Test',             'Urea, creatinine, electrolytes',                'lab', 5000, 0, 'test', 17, true),
      (h.id, 'LAB-LIP',  'Lipid Profile',                   'Cholesterol, HDL, LDL, triglycerides',          'lab', 4500, 0, 'test', 18, true),
      (h.id, 'LAB-BSL',  'Blood Glucose (Fasting)',         'Fasting blood sugar',                          'lab', 1000, 0, 'test', 19, true),
      (h.id, 'LAB-HBA1C','HbA1c',                            'Glycated haemoglobin (3-month average)',       'lab', 6000, 0, 'test', 20, true),
      -- Procedures (5)
      (h.id, 'PROC-IVC',  'IV Cannulation',                'Peripheral IV line insertion',                  'procedure', 2000,  0, 'procedure', 31, true),
      (h.id, 'PROC-SUT',  'Suturing (Simple)',              'Wound closure, up to 5cm',                      'procedure', 5000,  0, 'procedure', 32, true),
      (h.id, 'PROC-INC',  'Incision & Drainage',            'Abscess drainage',                              'procedure', 7000,  0, 'procedure', 33, true),
      (h.id, 'PROC-CAT',  'Urinary Catheterisation',        'Urethral catheter placement',                   'procedure', 4000,  0, 'procedure', 34, true),
      (h.id, 'PROC-WND',  'Wound Dressing',                 'Simple wound dressing change',                  'procedure', 1500,  0, 'procedure', 35, true),
      -- Drugs (4)
      (h.id, 'DRG-PAR',  'Paracetamol 500mg',              'Strip of 20 tablets',                            'drug', 500,  0, 'pack', 41, true),
      (h.id, 'DRG-AMO',  'Amoxicillin 500mg',              'Strip of 10 capsules',                          'drug', 1000, 0, 'pack', 42, true),
      (h.id, 'DRG-ART',  'Artemether/Lumefantrine',         'ACT antimalarial, full course',                  'drug', 1500, 0, 'pack', 43, true),
      (h.id, 'DRG-ORS',  'Oral Rehydration Salts',          'Sachet, WHO formula',                            'drug', 300,  0, 'pack', 44, true),
      -- Bed charges (4)
      (h.id, 'BED-GEN',  'General Ward (per day)',         'Shared ward, standard bed',                      'bed', 5000,  0, 'day', 51, true),
      (h.id, 'BED-PRV',  'Private Ward (per day)',          'Single private room',                            'bed', 15000, 0, 'day', 52, true),
      (h.id, 'BED-ICU',  'ICU Bed (per day)',               'Intensive care, full monitoring',                'bed', 50000, 0, 'day', 53, true),
      (h.id, 'BED-NUR',  'Nursing Care Charge',             'Hourly nursing observation',                     'bed', 1000,  0, 'hour', 54, true),
      -- ANC packages (2)
      (h.id, 'ANC-REG',   'ANC Registration Package',       'Booking visit: history, examination, baseline labs', 'anc_package', 15000, 0, 'package', 61, true),
      (h.id, 'ANC-DEL',   'Normal Delivery Package',        'Vaginal delivery incl. episiotomy + 24h observation', 'anc_package', 75000, 0, 'package', 62, true),
      -- Registration fees in catalog (4)
      (h.id, 'REG-PER',  'Personal Folder Registration',   'New personal patient folder fee',                'registration', 5000,  0, 'session', 71, true),
      (h.id, 'REG-FAM',  'Family Folder Registration',      'New family folder fee',                          'registration', 10000, 0, 'session', 72, true),
      (h.id, 'REG-EMG',  'Emergency Folder Registration',   'Emergency case folder fee',                      'registration', 8000,  0, 'session', 73, true),
      (h.id, 'REG-ANC',  'ANC Folder Registration',          'ANC booking folder fee',                         'registration', 30000, 0, 'session', 74, true)
    ON CONFLICT (hospital_id, code) DO NOTHING;

    -- (e) Price list items — one override per service in STD
    INSERT INTO public.price_list_items (hospital_id, price_list_id, service_catalog_id, price, coverage_percent, copay_percent, copay_amount, is_excluded, prior_auth_required)
    SELECT h.id, v_pl_id, sc.id, sc.default_price, 0, 100, 0, false, false
      FROM public.service_catalog sc
     WHERE sc.hospital_id = h.id AND sc.is_active = true
    ON CONFLICT (price_list_id, service_catalog_id) DO NOTHING;
  END LOOP;
END $$;
