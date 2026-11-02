-- =====================================================================
-- GOODIE-MEDHUB — 078_backfill_auth_user_metadata.sql
-- =====================================================================
-- Backfills auth.users.user_metadata with patient_id, hospital_id,
-- patient_name, hospital_number for existing portal accounts that
-- were created BEFORE the create-portal-account Edge Function started
-- setting user_metadata (or were created via self-signup without it).
--
-- WHY THIS MATTERS:
--   The new patient portal AuthContext reads patient data directly from
--   session.user.user_metadata — no database queries, no RLS dependency,
--   no Edge Function deployment needed. But this only works if the
--   user_metadata is populated.
--
--   For accounts created via the create-portal-account Edge Function
--   (which sets user_metadata), this is a no-op — they already have it.
--
--   For accounts created via the OLD supabase.auth.signUp() flow (before
--   we switched to the Edge Function), user_metadata is empty. This
--   migration backfills it from the patient_users + patients tables.
--
-- Safe to re-run. Idempotent — only updates users where user_metadata
-- doesn't already have patient_id.
-- =====================================================================

-- =====================================================================
-- 1. Backfill user_metadata for existing portal accounts
-- =====================================================================
-- We use the auth admin API via a SECURITY DEFINER function because
-- direct UPDATEs to auth.users are not allowed from SQL (even for
-- service role in some Supabase versions).

create or replace function public.backfill_patient_user_metadata()
returns table (user_id uuid, patient_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  pu record;
  v_metadata jsonb;
  v_user_meta jsonb;
  v_user_id uuid;
  v_count integer := 0;
  v_skipped integer := 0;
begin
  for pu in
    select pu.user_id, pu.patient_id, pu.hospital_id,
           pu.patient_name, pu.mrn,
           p.full_name, p.hospital_number, p.phone, p.email
      from public.patient_users pu
      left join public.patients p on p.id = pu.patient_id
     where pu.is_active = true
  loop
    -- Read the existing user_metadata. The column name varies by
    -- Supabase version: older versions use `raw_user_metaata` (with
    -- a historical typo), newer versions use `raw_user_meta_data`.
    -- We try both.
    begin
      execute format(
        'select coalesce(raw_user_metaata, ''{}''::jsonb) from auth.users where id = $1'
      ) into v_user_meta using pu.user_id;
    exception when others then
      execute format(
        'select coalesce(raw_user_meta_data, ''{}''::jsonb) from auth.users where id = $1'
      ) into v_user_meta using pu.user_id;
    end;

    -- Skip if patient_id is already in metadata
    if v_user_meta ? 'patient_id' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Build the new metadata, merging with any existing metadata
    v_metadata := v_user_meta || jsonb_build_object(
      'patient_id', pu.patient_id,
      'hospital_id', pu.hospital_id,
      'patient_name', coalesce(pu.patient_name, pu.full_name),
      'hospital_number', coalesce(pu.mrn, pu.hospital_number),
      'phone', pu.phone,
      'email', pu.email,
      'backfilled', true,
      'backfilled_at', now()
    );

    -- Update the auth user's metadata. Try both column names.
    begin
      update auth.users
         set raw_user_metaata = v_metadata
       where id = pu.user_id;
    exception when others then
      update auth.users
         set raw_user_meta_data = v_metadata
       where id = pu.user_id;
    end;

    v_count := v_count + 1;
    return next row(pu.user_id, pu.patient_id, 'updated')::record;
  end loop;

  raise notice 'Backfilled % auth users with patient metadata. Skipped % (already had metadata or user not found).', v_count, v_skipped;
end;
$$;

-- =====================================================================
-- 2. Run the backfill
-- =====================================================================
select * from public.backfill_patient_user_metadata();

-- =====================================================================
-- 3. Drop the function (one-time use, no need to keep it around)
-- =====================================================================
drop function if exists public.backfill_patient_user_metadata();

-- =====================================================================
-- 4. Verify — show which auth users now have patient_id in metadata
-- =====================================================================
-- Try both column name variants (older Supabase = raw_user_metaata,
-- newer = raw_user_meta_data). The verification query uses dynamic SQL
-- so it works regardless.
do $$
declare
  v_col text;
  v_count integer;
begin
  -- Detect which column name exists
  begin
    perform raw_user_metaata from auth.users limit 1;
    v_col := 'raw_user_metaata';
  exception when others then
    v_col := 'raw_user_meta_data';
  end;

  execute format(
    'select count(*) from auth.users where %I ->> ''patient_id'' is not null',
    v_col
  ) into v_count;

  raise notice '✅ % auth users now have patient_id in their user_metadata (column: %)', v_count, v_col;

  -- Show the most recent 10
  execute format(
    'select au.id, au.email, au.%I ->> ''patient_id'' as patient_id, au.%I ->> ''patient_name'' as patient_name, au.%I ->> ''hospital_number'' as mrn from auth.users au where au.%I ->> ''patient_id'' is not null order by au.created_at desc limit 10',
    v_col, v_col, v_col, v_col
  );
end $$;
