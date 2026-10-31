-- =====================================================================
-- GOODIE-MEDHUB — 068_patient_hospital_number.sql
-- =====================================================================
-- Adds a `hospital_number` (MRN - Medical Record Number) column to
-- the patients table if it doesn't exist, and backfills it for all
-- existing patients using the format: HOSP-CATEGORY-YYYY-XXXX
--
-- The hospital_number is the patient's unique identifier within the
-- hospital. It's shown on the patient profile, used by the patient
-- portal for self-signup, and used by the Dashboard search.
--
-- Safe to re-run. Run AFTER all other migrations.
-- =====================================================================

-- 1. Add the column if it doesn't exist
alter table public.patients add column if not exists hospital_number text;

-- 2. Create an index for fast lookups (especially by the patient portal signup)
create index if not exists patients_hospital_number_idx
  on public.patients (hospital_id, hospital_number)
  where hospital_number is not null;

-- 3. Backfill: generate a hospital_number for all existing patients
--    Format: HOSP-{CATEGORY}-{YEAR}-{SEQUENCE}
--    Example: HOSP-PER-2026-0001
--    Only fills patients that don't already have a hospital_number
do $$
declare
  p record;
  v_counter integer := 0;
  v_year integer;
  v_category_code text;
  v_hospital_short text;
  v_number text;
begin
  v_year := extract(year from now());

  for p in
    select id, hospital_id, category, created_at
    from public.patients
    where hospital_number is null or hospital_number = ''
    order by created_at asc
  loop
    v_counter := v_counter + 1;

    -- Category code (first 3 letters, uppercase)
    v_category_code := upper(substr(coalesce(p.category, 'PER'), 1, 3));

    -- Hospital short ID (first 8 chars of UUID)
    v_hospital_short := substr(p.hospital_id::text, 1, 8);

    -- Format: HOSP-{CATEGORY}-{YEAR}-{4-digit sequence}
    v_number := 'GMH-' || v_category_code || '-' || v_year::text || '-' || lpad(v_counter::text, 4, '0');

    update public.patients
       set hospital_number = v_number
     where id = p.id;
  end loop;

  raise notice 'Backfilled % patient hospital numbers', v_counter;
end $$;

-- 4. Verification
-- select id, full_name, hospital_number, category from public.patients limit 10;
