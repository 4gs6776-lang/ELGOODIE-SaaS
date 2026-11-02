-- =====================================================================
-- GOODIE-MEDHUB — 075_verify_service_catalog.sql  (FIXED)
-- =====================================================================
-- Diagnostic check: verify the service_catalog table exists and has
-- lab tests. Uses `select *` so it works regardless of which columns
-- the table actually has (some installations may be missing sub_category
-- if migration 066's CREATE TABLE IF NOT EXISTS was skipped due to an
-- earlier simpler version of the table existing).
--
-- If sub_category is missing, run migration 076_service_catalog_add_columns.sql
-- to add it.
-- =====================================================================

-- 1. Confirm the table exists
select
  case when to_regclass('public.service_catalog') is not null
       then '✅ service_catalog table EXISTS'
       else '❌ service_catalog table MISSING — run migration 066_reconstruct_phase1_master_data.sql'
  end as status;

-- 2. List ALL columns (no hardcoded column names — works regardless of schema)
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'service_catalog'
 order by ordinal_position;

-- 3. Confirm migration 066 seeded it (basic count)
select count(*) as total_services,
       count(*) filter (where category = 'lab') as lab_tests,
       count(*) filter (where is_active = true) as active_services
  from public.service_catalog;

-- 4. Show the lab tests (using select * to avoid column-not-found errors)
--    Selects only the columns we know exist across all schema versions.
select id, code, name, default_price, category, is_active
  from public.service_catalog
 where category = 'lab'
 order by code;

-- 5. Show sub_category distribution (only if the column exists)
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'service_catalog'
       and column_name = 'sub_category'
  ) then
    raise notice '✅ sub_category column EXISTS — LabTestPicker category filter will work';
  else
    raise notice '❌ sub_category column MISSING — run migration 076_service_catalog_add_columns.sql to add it';
  end if;
end $$;

-- 6. Confirm RLS policies are applied
select policyname, cmd, qual
  from pg_policies
 where schemaname = 'public'
   and tablename = 'service_catalog'
 order by cmd;
