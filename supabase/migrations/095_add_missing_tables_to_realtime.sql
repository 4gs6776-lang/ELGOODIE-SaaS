-- =====================================================================
-- GOODIE-MEDHUB — 095_add_missing_tables_to_realtime.sql
--
-- Adds 13 tables (the ones the app reads/writes via useOfflineTable
-- and useRealtimeAlert that were NOT in your supabase_realtime
-- publication) to the publication, and sets REPLICA IDENTITY FULL on
-- the hospital-scoped ones so UPDATE events carry the full row.
--
-- SYMPTOM THIS FIXES
--   "Why do I have to refresh my browser before seeing the doctor's
--    changes?" — for billing, nursing, pharmacy, audit, and the
--    doctor's drug-interaction reference data.
--
-- ROOT CAUSE
--   The app subscribes to Supabase Realtime for these tables (some via
--   useRealtimeAlert, three of them — payment_plans, invoice_reminders,
--   invoice_writeoffs — explicitly with { realtime: true } inside
--   useOfflineTable), but the tables were never added to the
--   supabase_realtime publication. Postgres therefore never broadcast
--   any events for them, the subscriptions sat silently, and the
--   only way to see new data was F5.
--
--   This is the publication-side complement to the code patch in
--   useOfflineTable.js (options B + C). Together they make the app
--   live-updating.
--
-- WHAT THIS MIGRATION DOES
--   1. Sets REPLICA IDENTITY FULL on every hospital-scoped table so
--      UPDATE events include the whole row (needed by realtime handlers
--      that read patient_id / status / etc. from the payload).
--      Global reference tables (drug_interactions, drug_allergy_classes,
--      notifiable_diseases) are left at DEFAULT because they have no
--      hospital_id and the app only ever SELECTs them.
--   2. Adds each table to the supabase_realtime publication.
--
--   We DO NOT add `cashier_reconciliations` because that table does
--   not exist in the live schema (see EndOfDayReconciliationModal.jsx:83
--   — "cashier_reconciliations table doesn't exist yet (Phase 4+ would
--   add it)"). Adding a non-existent table to a publication throws
--   `relation "public.cashier_reconciliations" does not exist`. The
--   app's schema-gap layer silently no-ops writes to it; live updates
--   are irrelevant until the table is created.
--
-- SAFE TO RE-RUN. Idempotent on every line (each ADD TABLE is wrapped
-- in an IF NOT EXISTS check).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. REPLICA IDENTITY FULL (hospital-scoped clinical tables only)
--
--    Why: by default Postgres only emits the changed columns in an
--    UPDATE event. Our realtime handlers (useRealtimeAlert, and the
--    useOfflineTable { realtime: true } path) read fields like
--    patient_id, hospital_id, status from the payload — if those
--    fields weren't changed in the UPDATE, they'd be missing without
--    REPLICA IDENTITY FULL, and the filter `hospital_id=eq.X` would
--    silently drop the event.
-- ---------------------------------------------------------------------

-- Wrapped in a DO block because ALTER TABLE ... REPLICA IDENTITY FULL
-- doesn't support IF EXISTS, and several of these tables may not exist
-- on this DB yet (their CREATE TABLE migrations may not have run).
do $$
declare
  t text;
  hospital_tables text[] := array[
    'audit_events','medication_administrations','messages',
    'pharmacy_items','pharmacy_orders','prescription_templates',
    'profiles','invoice_reminders','invoice_writeoffs','payment_plans'
  ];
begin
  foreach t in array hospital_tables loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('alter table public.%I replica identity full', t);
    else
      raise notice 'Skipping REPLICA IDENTITY on % — table does not exist', t;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. ADD TABLES TO supabase_realtime PUBLICATION
--
--    All 13 tables the app uses that are missing from your current
--    publication. Each wrapped in IF NOT EXISTS so re-running is safe.
--
--    Note: profiles is added even though it rarely changes — doctors
--    and nurses need to see a colleague's role/status flip without
--    refreshing.
-- ---------------------------------------------------------------------

do $$
declare
  t text;
  -- 13 tables. cashier_reconciliations deliberately omitted (does not
  -- exist in the live schema; app code itself flags it as Phase 4+).
  tables text[] := array[
    'audit_events',
    'medication_administrations',
    'messages',
    'pharmacy_items',
    'pharmacy_orders',
    'prescription_templates',
    'profiles',
    'drug_interactions',
    'drug_allergy_classes',
    'notifiable_diseases',
    'invoice_reminders',
    'invoice_writeoffs',
    'payment_plans'
  ];
begin
  foreach t in array tables loop
    -- GUARD: only add tables that actually exist on this DB.
    -- Adding a non-existent table to a publication throws
    -- `relation "public.X" does not exist` (42P01) and aborts the
    -- whole migration. Some of these tables (e.g. invoice_reminders,
    -- invoice_writeoffs, payment_plans) come from migrations
    -- (092_revenue_cycle_automation.sql, 094_invoice_writeoffs_v2.sql,
    -- 092_payment_plans_v2.sql) that may not have been applied to the
    -- live project yet. Skip them here; they'll be picked up by a
    -- re-run of this migration after their source migrations run.
    if to_regclass('public.' || quote_ident(t)) is not null then
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    else
      raise notice 'Skipping % — table does not exist on this DB (run the migration that creates it first)', t;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- After running, optionally check which tables actually got added vs.
-- skipped (the SKIPPED ones are reported via RAISE NOTICE above, which
-- shows up in the Supabase SQL editor's Messages tab):
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename in (
--        'audit_events','medication_administrations','messages',
--        'pharmacy_items','pharmacy_orders','prescription_templates',
--        'profiles','drug_interactions','drug_allergy_classes',
--        'notifiable_diseases','invoice_reminders','invoice_writeoffs',
--        'payment_plans'
--      )
--    order by tablename;
--
-- If you see fewer than 13 rows, the missing ones are tables whose
-- CREATE TABLE migration hasn't been applied yet. Find the source
-- migration in your repo (supabase/migrations/), run it, then re-run
-- THIS migration — the skipped tables will now get added.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- VERIFY (run in the Supabase SQL editor after applying):
--
--   -- Should now return 88 rows (your 75 + these 13).
--   -- If it returns fewer, one of the ADD TABLE statements failed
--   -- (likely because the table doesn't exist on your DB yet —
--   -- check the Supabase logs / migration history).
--   select count(*) from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public';
--
--   -- Confirm the three billing tables that were the main pain point
--   -- are now in the publication:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename in ('payment_plans','invoice_reminders','invoice_writeoffs')
--    order by tablename;
--   -- should return 3 rows
--
--   -- Confirm replica identity is FULL on the hospital-scoped tables:
--   select relname, relreplident
--     from pg_class
--    where relname in (
--      'audit_events','medication_administrations','messages',
--      'pharmacy_items','pharmacy_orders','prescription_templates',
--      'profiles','invoice_reminders','invoice_writeoffs','payment_plans'
--    ) and relkind = 'r';
--   -- relreplident = 'f' means FULL (the value we want).
-- ---------------------------------------------------------------------
