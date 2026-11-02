-- =====================================================================
-- GOODIE-MEDHUB — 076_service_catalog_add_columns.sql
-- =====================================================================
-- Adds missing columns to public.service_catalog.
--
-- ROOT CAUSE:
--   Migration 066_reconstruct_phase1_master_data.sql creates the
--   service_catalog table with `CREATE TABLE IF NOT EXISTS`. If the
--   table was created earlier (by a previous migration run, manual
--   SQL, or a Supabase dashboard edit) with a SIMPLER schema that
--   did NOT include `sub_category`, then 066's CREATE was silently
--   skipped, and the table kept its old (incomplete) shape.
--
--   The LabTestPicker.jsx uses `s.sub_category` for category filters.
--   With the column missing, the picker falls back to "lab" only
--   (which is acceptable) but the diagnostic SQL fails with
--   `column "sub_category" does not exist`.
--
-- WHAT THIS MIGRATION DOES:
--   1. ADD COLUMN IF NOT EXISTS for every column migration 066
--      expects on service_catalog.
--   2. Backfill `sub_category` for existing lab tests based on
--      their code prefix (LAB-FBC → Hematology, LAB-URINE → Urinalysis,
--      etc.) so the LabTestPicker category filter actually works.
--
-- Safe to re-run. Idempotent. The IF NOT EXISTS clauses make every
-- statement a no-op if the column already exists.
-- =====================================================================

-- =====================================================================
-- 1. Add any missing columns from migration 066's expected schema
-- =====================================================================
-- These match the columns defined in
-- 066_reconstruct_phase1_master_data.sql lines 103-120.
-- If a column already exists, ADD COLUMN IF NOT EXISTS is a no-op.

alter table public.service_catalog add column if not exists description    text;
alter table public.service_catalog add column if not exists sub_category    text;
alter table public.service_catalog add column if not exists default_cost   numeric(14, 2) not null default 0 check (default_cost >= 0);
alter table public.service_catalog add column if not exists unit           text;
alter table public.service_catalog add column if not exists is_taxable     boolean not null default false;
alter table public.service_catalog add column if not exists tax_rate       numeric(5, 2) not null default 0 check (tax_rate >= 0 and tax_rate <= 100);
alter table public.service_catalog add column if not exists sort_order     integer not null default 0;
alter table public.service_catalog add column if not exists is_active     boolean not null default true;
alter table public.service_catalog add column if not exists created_at    timestamptz not null default now();
alter table public.service_catalog add column if not exists updated_at    timestamptz not null default now();

-- Make sure the CHECK constraint on category exists (in case it was
-- missing from the older table). Drop + recreate is safe.
do $$
begin
  -- Drop the old constraint if it exists (any name)
  execute 'alter table public.service_catalog drop constraint if exists service_catalog_category_check';
  -- Re-add it
  execute 'alter table public.service_catalog add constraint service_catalog_category_check
           check (category in (''consultation'', ''lab'', ''procedure'', ''drug'', ''bed'', ''service'', ''anc_package'', ''registration'', ''''))';
exception when others then null;
end $$;

-- =====================================================================
-- 2. Backfill sub_category for existing lab tests by code prefix
-- =====================================================================
-- The default seeds in migration 066 (lines 488-497) include 10 lab
-- tests with codes like LAB-FBC, LAB-URINE, etc. We map each to a
-- sensible sub_category so the LabTestPicker category filter works
-- out of the box.

update public.service_catalog
   set sub_category = case
     when code ilike 'LAB-FBC%'   then 'Hematology'
     when code ilike 'LAB-URINE%' then 'Urinalysis'
     when code ilike 'LAB-STOOL%' then 'Microscopy'
     when code ilike 'LAB-WIDAL%' then 'Serology'
     when code ilike 'LAB-MPS%'   then 'Microscopy'
     when code ilike 'LAB-LFT%'   then 'Chemistry'
     when code ilike 'LAB-RFT%'   then 'Chemistry'
     when code ilike 'LAB-LIP%'   then 'Chemistry'
     when code ilike 'LAB-BSL%'   then 'Chemistry'
     when code ilike 'LAB-HBA1C%' then 'Chemistry'
     when code ilike 'LAB-%'      then 'Lab'
     else sub_category
   end
 where sub_category is null
   and category = 'lab';

-- =====================================================================
-- 3. Make sure indexes + RLS + realtime publication are all in place
-- =====================================================================
create unique index if not exists service_catalog_hospital_code_uniq
  on public.service_catalog (hospital_id, code);
create index if not exists service_catalog_hospital_active_idx
  on public.service_catalog (hospital_id, is_active, sort_order);
create index if not exists service_catalog_hospital_category_idx
  on public.service_catalog (hospital_id, category, is_active);

alter table public.service_catalog enable row level security;

-- Recreate RLS policies defensively (in case they were dropped)
drop policy if exists "service_catalog_select" on public.service_catalog;
create policy "service_catalog_select" on public.service_catalog
  for select using (hospital_id = public.current_hospital_id() or public.is_owner());
drop policy if exists "service_catalog_insert" on public.service_catalog;
create policy "service_catalog_insert" on public.service_catalog
  for insert with check (hospital_id = public.current_hospital_id() and public.is_hospital_admin());
drop policy if exists "service_catalog_update" on public.service_catalog;
create policy "service_catalog_update" on public.service_catalog
  for update using (hospital_id = public.current_hospital_id() and public.is_hospital_admin())
  with check (hospital_id = public.current_hospital_id() and public.is_hospital_admin());
drop policy if exists "service_catalog_delete" on public.service_catalog;
create policy "service_catalog_delete" on public.service_catalog
  for delete using (hospital_id = public.current_hospital_id() and public.is_hospital_admin());

-- updated_at trigger
drop trigger if exists trg_service_catalog_updated_at on public.service_catalog;
create trigger trg_service_catalog_updated_at before update on public.service_catalog
  for each row execute function public.set_updated_at();

alter table public.service_catalog replica identity full;

-- Realtime publication
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'service_catalog'
  ) then
    alter publication supabase_realtime add table public.service_catalog;
  end if;
exception when others then null;
end $$;

-- =====================================================================
-- 4. Verification — show the final state of the table
-- =====================================================================
do $$
declare
  v_count integer;
  v_lab_count integer;
  v_sub_count integer;
begin
  select count(*) into v_count from public.service_catalog;
  select count(*) into v_lab_count from public.service_catalog where category = 'lab';
  select count(*) into v_sub_count from public.service_catalog where sub_category is not null;

  raise notice 'service_catalog: total=%, lab_tests=%, with_sub_category=%', v_count, v_lab_count, v_sub_count;
end $$;
