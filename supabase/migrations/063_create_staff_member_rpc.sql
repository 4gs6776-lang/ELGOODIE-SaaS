-- =====================================================================
-- GOODIE-MEDHUB — 063_create_staff_member_rpc.sql
-- =====================================================================
-- SECURITY DEFINER RPC for creating new staff profiles.
--
-- WHY: The existing `profiles_insert` RLS policy (migration 062) only
-- allows `id = auth.uid()` (self-insert at signup). Hospital admins need
-- to create staff profiles for new employees, but they can't do this
-- directly via INSERT because:
--   1. The RLS policy blocks INSERT where id != auth.uid()
--   2. The trigger from migration 029 blocks INSERTs from non-owner
--      logged-in users
--
-- This RPC runs as SECURITY DEFINER (elevated privileges) so it bypasses
-- RLS. It validates that the caller is an admin/owner of the same
-- hospital, then inserts the new staff profile with the correct
-- hospital_id + role.
--
-- Usage from the frontend:
--   const { data, error } = await supabase.rpc('create_staff_member', {
--     p_email: 'newstaff@hospital.com',
--     p_full_name: 'Dr. Jane Doe',
--     p_role: 'doctor',
--     p_phone: '+2348001234567',
--   })
--
-- The RPC:
--   1. Checks the caller is admin/owner of the current hospital
--   2. Creates a new auth.users entry (via auth.admin.createUser)
--   3. Inserts the profile row with the caller's hospital_id
--   4. Returns the new profile id + a temporary password
--
-- Safe to re-run (CREATE OR REPLACE).
-- =====================================================================

-- DROP first because CREATE OR REPLACE can't change the return type
-- of an existing function (PostgreSQL error 42P13).
drop function if exists public.create_staff_member(text, text, text, text) cascade;

create or replace function public.create_staff_member(
  p_email text,
  p_full_name text,
  p_role text default 'staff',
  p_phone text default null
)
returns table(id uuid, temporary_password text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller_id     uuid := auth.uid();
  v_caller_role   text;
  v_caller_hospital uuid;
  v_new_user_id   uuid;
  v_temp_password text;
  v_valid_roles   text[] := array['admin', 'owner', 'doctor', 'nurse', 'front_desk', 'pharmacist', 'lab', 'billing', 'staff', 'cmd'];
begin
  -- 1. Validate the caller is logged in
  if v_caller_id is null then
    raise exception 'You must be logged in to create staff.' using errcode = '42501';
  end if;

  -- 2. Fetch the caller's role + hospital_id
  select role, hospital_id
    into v_caller_role, v_caller_hospital
    from public.profiles
   where id = v_caller_id;

  -- 3. Only admin/owner can create staff
  if v_caller_role not in ('admin', 'owner') or v_caller_hospital is null then
    raise exception 'Only hospital admins can create staff.' using errcode = '42501';
  end if;

  -- 4. Validate the requested role
  if p_role not in (select unnest(v_valid_roles)) then
    raise exception 'Invalid role "%". Must be one of: admin, owner, doctor, nurse, front_desk, pharmacist, lab, billing, staff, cmd.', p_role using errcode = '23514';
  end if;

  -- 5. Prevent creating owner roles (only the platform owner can do that)
  if p_role = 'owner' and v_caller_role <> 'owner' then
    raise exception 'Only the platform owner can create new owners.' using errcode = '42501';
  end if;

  -- 6. Validate email format (basic check)
  if p_email !~ '^[^@]+@[^@]+\.[^@]+$' then
    raise exception 'Invalid email format.' using errcode = '23514';
  end if;

  -- 7. Check the email isn't already in use
  if exists (select 1 from auth.users where email = lower(p_email)) then
    raise exception 'A user with email % already exists.', p_email using errcode = '23505';
  end if;

  -- 8. Generate a temporary password (12 chars, alphanumeric)
  v_temp_password := substr(encode(gen_random_bytes(12), 'base64'), 1, 12);

  -- 9. Create the auth user (suppresses the "user already exists" error
  --    if there's a race — we already checked above)
  begin
    v_new_user_id := auth.auth_admin_create_user(
      lower(p_email),
      v_temp_password,
      p_email  -- email_confirm: pass the email to auto-confirm
    );
  exception when others then
    raise exception 'Could not create auth user: %', sqlerrm using errcode = 'P0001';
  end;

  -- 10. Insert the profile row (bypasses RLS because SECURITY DEFINER)
  insert into public.profiles (id, email, full_name, role, hospital_id, phone, active, created_at)
  values (
    v_new_user_id,
    lower(p_email),
    p_full_name,
    p_role,
    v_caller_hospital,  -- inherits the admin's hospital
    p_phone,
    true,
    now()
  );

  -- 11. Return the new user id + temporary password (so the admin can
  --    share it with the new staff member)
  return query select v_new_user_id as id, v_temp_password as temporary_password;
end;
$$;

-- Grant execute to authenticated users (the function itself checks
-- that the caller is an admin/owner)
grant execute on function public.create_staff_member(text, text, text, text) to authenticated;
