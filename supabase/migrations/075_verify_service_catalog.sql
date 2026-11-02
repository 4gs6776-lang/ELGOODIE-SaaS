-- =====================================================================
-- GOODIE-MEDHUB — 075_verify_service_catalog.sql
-- =====================================================================
-- Diagnostic check: verify migration 066 ran and seeded lab tests
-- =====================================================================

-- 1. Confirm the table exists
select
  case when to_regclass('public.service_catalog') is not null
       then '✅ service_catalog table EXISTS'
       else '❌ service_catalog table MISSING — run migration 066'
  end as status;

-- 2. Confirm migration 066 seeded it
select count(*) as total_services,
       count(*) filter (where category = 'lab') as lab_tests,
       count(*) filter (where is_active = true) as active_services
  from public.service_catalog;

-- 3. Show the 10 expected lab tests
select code, name, default_price, sub_category, is_active
  from public.service_catalog
 where category = 'lab'
 order by code;

-- 4. Confirm RLS policies are applied
select policyname, cmd, qual
  from pg_policies
 where schemaname = 'public'
   and tablename = 'service_catalog'
 order by cmd;
