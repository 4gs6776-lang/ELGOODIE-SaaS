-- =====================================================================
-- GOODIE-MEDHUB — 091_fix_patient_drug_charts_chart_status.sql
--
-- Adds the `chart_status` column that the app already reads/writes but
-- that no migration has ever created.
--
-- SYMPTOM
--   The QA Sync panel shows "patient_drug_charts — N records waiting
--   Retry / Skip" that never clear. Clicking Retry fails immediately.
--
-- ROOT CAUSE
--   src/lib/drugChartWorkflow.js writes `chart_status` ('pending' on
--   insert, 'given' after administration) and SQL queries in the same
--   file filter on `chart_status`. But no migration creates this column.
--   Migration 004_drug_chart_columns.sql added `next_dose`, `sign` and
--   `prescription_id` — but missed `chart_status`. Every insert/upsert
--   on patient_drug_charts fails with PGRST204 ("Could not find the
--   'chart_status' column in the schema cache"), the row is stamped
--   _syncErrorKind='schema', and it jams in the sync queue forever.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds the chart_status column (text, default 'pending').
--   2. Backfills existing rows: NULL or missing -> 'pending' (so the
--      nurse's chart still shows them as awaiting administration, not
--      silently dropped).
--   3. Adds the table to the supabase_realtime publication and sets
--      replica identity full so UPDATE events (e.g. chart_status
--      flipping from 'pending' to 'given') broadcast to all clients.
--      This is the "why do I have to refresh to see the doctor's
--      changes" fix for the drug chart specifically.
--
-- SAFE TO RE-RUN. Idempotent on every line.
-- =====================================================================

-- 1. Add the column if missing.
alter table public.patient_drug_charts
  add column if not exists chart_status text not null default 'pending';

-- 2. Backfill any NULLs (only possible if the column existed as
--    nullable before this migration; the NOT NULL DEFAULT above makes
--    new rows always carry a value).
update public.patient_drug_charts
   set chart_status = 'pending'
 where chart_status is null;

-- 3. Replica identity full so UPDATE events include the full row
--    (required for the realtime handlers in drugChartWorkflow.js and
--    Nursing.jsx to read chart_status / patient_id from the payload).
alter table public.patient_drug_charts replica identity full;

-- 4. Add to supabase_realtime publication so Postgres broadcasts
--    INSERT / UPDATE / DELETE events to every subscribed client.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'patient_drug_charts'
  ) then
    alter publication supabase_realtime add table public.patient_drug_charts;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VERIFY (run in the SQL editor after applying):
--
--   -- column exists with the right default
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'patient_drug_charts'
--    order by ordinal_position;
--
--   -- table is in the realtime publication
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime'
--      and schemaname = 'public'
--      and tablename = 'patient_drug_charts';
--    -- should return 1 row
--
-- AFTER APPLYING:
--   1. In the app, open the QA Sync panel and click Retry. The 3
--      (or however many) stuck patient_drug_charts rows should flush.
--   2. From now on, every new drug chart entry syncs immediately, and
--      the nurse sees the doctor's chart updates live (no refresh
--      needed) once the useOfflineTable realtime patch is also
--      deployed.
-- ---------------------------------------------------------------------
