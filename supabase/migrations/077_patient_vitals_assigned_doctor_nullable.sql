-- =====================================================================
-- GOODIE-MEDHUB — 077_patient_vitals_assigned_doctor_nullable.sql
-- =====================================================================
-- Makes patient_vitals.assigned_doctor nullable.
--
-- ROOT CAUSE OF BUG 4 PATCH FAILURE:
--   The patient_vitals table was created (in an early bootstrap not
--   shipped in this repo) with `assigned_doctor text NOT NULL`. The
--   Nursing triage flow always sets assigned_doctor (because it
--   explicitly assigns to a doctor), so the NOT NULL constraint was
--   fine in that context.
--
--   But Bug 4's fix added a "Record Vitals from Patient Profile" flow
--   that saves vitals to the patient's HISTORY only — without sending
--   to a doctor queue. There's no doctor to assign in that flow.
--   So the INSERT fails with:
--     "null value in column \"assigned_doctor\" of relation
--      \"patient_vitals\" violates not-null constraint"
--
-- FIX:
--   Drop the NOT NULL constraint on patient_vitals.assigned_doctor.
--   This is safe because:
--     - DoctorWorkbench filters its queue on `v.status === 'waiting'`,
--       NOT on `assigned_doctor IS NULL`. NULL assigned_doctor rows
--       won't appear in the doctor queue.
--     - The "Send to Doctor" button in PatientProfile explicitly
--       sets `status: 'waiting' + queue_status: 'sent_to_doctor'`,
--       and the doctor can pick up the patient even with NULL
--       assigned_doctor (they self-assign when they click "Pick up").
--     - The Nursing triage flow still sets assigned_doctor when
--       triaging — that path is unchanged.
--
-- Safe to re-run. Idempotent.
-- =====================================================================

-- 1. Drop the NOT NULL constraint on assigned_doctor
alter table public.patient_vitals
  alter column assigned_doctor drop not null;

-- 2. Verify (shows the column's nullability)
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'patient_vitals'
   and column_name = 'assigned_doctor';

-- 3. Notice to confirm
do $$
begin
  raise notice 'patient_vitals.assigned_doctor is now nullable.';
  raise notice 'Vitals recorded from the Patient Profile (history-only, status=recorded) can now be saved without a doctor assignment.';
end $$;
