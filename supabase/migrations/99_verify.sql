-- ============================================================
-- VERIFICATION SCRIPT — run this AFTER applying the v2 migrations.
-- Each SELECT returns a count; expected value shown in the comment.
-- ============================================================

-- 1. payment_plans table exists with all expected columns
-- Expected: 1 row, columns_count = 17
SELECT
  'payment_plans columns' AS check_name,
  COUNT(*) AS columns_count
FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'payment_plans'
   AND column_name IN (
     'id','hospital_id','patient_id','invoice_id',
     'total_amount','deposit_amount','balance_amount',
     'installment_amount','installment_count','frequency',
     'start_date','end_date','next_due_date','status',
     'approved_by','approved_at','notes','created_by',
     'created_at','updated_at'
   );

-- 2. payment_plan_installments has all expected columns
-- Expected: 1 row, columns_count = 12
SELECT
  'installments columns' AS check_name,
  COUNT(*) AS columns_count
FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'payment_plan_installments'
   AND column_name IN (
     'id','hospital_id','plan_id','installment_no',
     'due_date','amount_due','amount_paid','payment_id',
     'paid_at','status','created_at','updated_at'
   );

-- 3. balance_amount is a regular column (NOT generated)
-- Expected: 1 row with is_generated = 'NO'
SELECT
  'balance_amount not generated' AS check_name,
  is_generated
FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'payment_plans'
   AND column_name = 'balance_amount';

-- 4. installment_amount IS generated (only same-row columns)
-- Expected: 1 row with is_generated = 'ALWAYS'
SELECT
  'installment_amount generated' AS check_name,
  is_generated
FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'payment_plans'
   AND column_name = 'installment_amount';

-- 5. Triggers attached
-- Expected: 2 rows (trg_recalc_plan_balance + trg_mark_overdue_installments)
SELECT
  'triggers on installments' AS check_name,
  string_agg(tgname, ', ') AS triggers
FROM pg_trigger
 WHERE tgrelid = 'public.payment_plan_installments'::regclass
   AND tgname LIKE 'trg_%';

-- 6. RPCs created
-- Expected: 1 row, rpc_count = 2 (create_payment_plan + get_payment_plan_aging)
SELECT
  'payment_plans RPCs' AS check_name,
  COUNT(*) AS rpc_count
FROM pg_proc
 WHERE proname IN ('create_payment_plan','get_payment_plan_aging')
   AND pronamespace = 'public'::regnamespace;

-- 7. invoice_writeoffs table + policies
-- Expected: 1 row, policy_count = 4
SELECT
  'writeoffs policies' AS check_name,
  COUNT(*) AS policy_count
FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'invoice_writeoffs';

-- 8. NO invoice_writeoffs policy named "CREATE POLICY IF EXISTS"
-- Expected: 0 rows
SELECT
  'no IF EXISTS policy' AS check_name,
  COUNT(*) AS bad_count
FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'invoice_writeoffs'
   AND policyname LIKE '%IF EXISTS%';

-- 9. hmo_claims table exists; encounter_id has NO FK
-- Expected: 1 row, fk_count = 0
SELECT
  'hmo_claims encounter_id no FK' AS check_name,
  COUNT(*) AS fk_count
FROM information_schema.table_constraints
 WHERE table_schema = 'public'
   AND table_name = 'hmo_claims'
   AND constraint_type = 'FOREIGN KEY'
   AND constraint_name LIKE '%encounter%';

-- 10. v_pending_writeoffs view exists
-- Expected: 1 row
SELECT
  'pending_writeoffs view' AS check_name,
  COUNT(*) AS view_count
FROM information_schema.views
 WHERE table_schema = 'public' AND table_name = 'v_pending_writeoffs';

-- 11. generate_hmo_claim_number RPC exists
-- Expected: 1 row
SELECT
  'hmo claim RPC' AS check_name,
  COUNT(*) AS rpc_count
FROM pg_proc
 WHERE proname = 'generate_hmo_claim_number'
   AND pronamespace = 'public'::regnamespace;

-- 12. SMOKE TEST: create a tiny payment plan, verify balance trigger fires
-- (Commented out — uncomment to actually run.)
--
-- DO $$
-- DECLARE v_id UUID;
-- BEGIN
--   SELECT id INTO v_id FROM public.hospitals LIMIT 1;
--   IF v_id IS NULL THEN RAISE EXCEPTION 'No hospital found'; END IF;
--   -- (Use a real patient id from your DB)
--   -- SELECT public.create_payment_plan(
--   --   v_id, '00000000-0000-0000-0000-000000000000'::uuid, NULL,
--   --   1000, 100, 3, 'monthly', CURRENT_DATE, 'smoke test', NULL
--   -- );
-- END $$;
