-- =====================================================================
-- GOODIE-MEDHUB — 080_hospital_storage_rls_hardening.sql
-- =====================================================================
-- Hardens the storage RLS policies on the `hospital-logos` bucket so
-- that authenticated users can only upload/update/delete files inside
-- THEIR OWN hospital's path prefix.
--
-- BEFORE (migration 028):
--   Any authenticated user could upload to ANY path in hospital-logos.
--   Per-hospital isolation was enforced only at the application layer
--   (the upload path was constructed from hospital.id, which comes
--   from the verified profiles table). This was defense-in-depth only.
--
-- AFTER (this migration):
--   INSERT/UPDATE/DELETE policies now check that the storage path
--   starts with the caller's hospital_id. A user from Hospital A
--   cannot write to Hospital B's path — even if they crafted a
--   malicious request from the browser console.
--
-- The SELECT (public read) policy stays the same — logos and
-- backgrounds are public URLs.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. Drop the permissive write policies
-- =====================================================================
drop policy if exists "hospital_logos_authenticated_upload" on storage.objects;
drop policy if exists "hospital_logos_authenticated_update" on storage.objects;
drop policy if exists "hospital_logos_authenticated_delete" on storage.objects;

-- =====================================================================
-- 2. Create hardened INSERT policy
--    Path must start with the caller's hospital_id followed by '/'
--    e.g., "581c00a9-.../logo" or "581c00a9-.../dashboard-bg"
-- =====================================================================
create policy "hospital_logos_authenticated_upload" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'hospital-logos'
    and (
      -- Path starts with the caller's hospital_id + '/'
      (storage.foldername(name))[1] = (
        select hospital_id::text from public.profiles where id = auth.uid()
      )
    )
  );

-- =====================================================================
-- 3. Create hardened UPDATE policy (same path check)
-- =====================================================================
create policy "hospital_logos_authenticated_update" on storage.objects
  for update to authenticated using (
    bucket_id = 'hospital-logos'
    and (
      (storage.foldername(name))[1] = (
        select hospital_id::text from public.profiles where id = auth.uid()
      )
    )
  ) with check (
    bucket_id = 'hospital-logos'
    and (
      (storage.foldername(name))[1] = (
        select hospital_id::text from public.profiles where id = auth.uid()
      )
    )
  );

-- =====================================================================
-- 4. Create hardened DELETE policy (same path check)
-- =====================================================================
create policy "hospital_logos_authenticated_delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'hospital-logos'
    and (
      (storage.foldername(name))[1] = (
        select hospital_id::text from public.profiles where id = auth.uid()
      )
    )
  );

-- =====================================================================
-- 5. Verification — show the final state of the policies
-- =====================================================================
select policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'storage'
   and tablename = 'objects'
   and policyname like 'hospital_logos%'
 order by cmd;

-- =====================================================================
-- 6. Notice
-- =====================================================================
do $_$
begin
  raise notice 'Storage RLS hardened — hospital-logos bucket now enforces per-hospital path isolation.';
  raise notice 'A user from Hospital A can no longer write to Hospital B path prefix.';
end $_$;
