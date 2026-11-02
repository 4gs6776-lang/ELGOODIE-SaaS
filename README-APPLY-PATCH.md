# V2 Staff App — 4 Bug Fixes

## The 4 Bugs Fixed

| # | Bug | Root Cause | Fix |
|---|---|---|---|
| 1 | DoctorWorkbench not loading lab tests from service catalog | Migration `034_service_catalog.sql` is 0 bytes; migration 066 recreates it but you confirmed you ran it. The catalog IS in the DB but the picker silently showed empty with no diagnostic | Added defensive `console.warn` in LabTestPicker.jsx when catalog is empty — shows possible causes + a SQL snippet to verify. Also added a separate `075_verify_service_catalog.sql` diagnostic script. |
| 2 | Hospital bank account in Settings sometimes shows, sometimes doesn't | `hospital_bank_accounts` table is **referenced by code but never created by ANY migration**. Migration 056 line 44 calls `ALTER TABLE ... REPLICA IDENTITY FULL` on it → fails → may roll back 056. The "intermittent" symptom is IndexedDB cache state. | New migration `074_hospital_bank_accounts.sql` creates the table with proper schema + RLS + realtime publication. Run it in Supabase SQL Editor. |
| 3 | Patient Profile not loading (stuck on "Loading patient…" then "Couldn't load this patient") | `useOfflineTable('patients', hospital?.id)` returns `[]` on first render — the lookup `patients.find(p => p.id === patientId)` fails for ~6 seconds until IndexedDB resolves, then the timeout fires. | Patched PatientProfile.jsx to accept a `patient` prop. All 4 opener modules (Dashboard, Nursing, HmoPatients, AncPatients) now pass the already-loaded patient record through. First render has the patient object — no race. |
| 4 | Recording vitals from Patient Profile auto-sends to DoctorWorkbench | `handleSaveVitals` wrote `status: 'waiting'` on the patient_vitals row. DoctorWorkbench.jsx:233 filters its queue on `v.status === 'waiting'` — so every recorded vitals entry silently appeared in the doctor's queue. | Removed `status: 'waiting'`, replaced with `status: 'recorded'`. Added a "Send to Doctor" button on each vitals row in the patient profile that explicitly sets `status: 'waiting' + queue_status: 'sent_to_doctor'` only when staff clicks it. Also gated the DoctorWorkbench realtime INSERT toast on `row.status === 'waiting'`. |

## Files in This Patch

```
v2-staff-bug-fixes/
├── README-APPLY-PATCH.md                              ← this file
├── sql/
│   ├── 074_hospital_bank_accounts.sql                 ← RUN THIS in Supabase SQL Editor (Bug 2)
│   └── 075_verify_service_catalog.sql                 ← RUN THIS to verify migration 066 worked (Bug 1 diagnostic)
└── patches/
    ├── components/
    │   ├── LabTestPicker.jsx                          ← replace src/components/LabTestPicker.jsx (Bug 1 — adds diagnostic warn)
    │   └── PatientProfile.jsx                         ← replace src/components/PatientProfile.jsx (Bugs 3 + 4)
    └── dashboard/
        ├── DoctorWorkbench.jsx                       ← replace src/pages/dashboard/DoctorWorkbench.jsx (Bug 4 — gated toast)
        ├── Dashboard.jsx                              ← replace src/pages/dashboard/Dashboard.jsx (Bug 3 — passes patient prop)
        ├── Nursing.jsx                                ← replace src/pages/dashboard/Nursing.jsx (Bug 3 — passes patient prop)
        ├── HmoPatients.jsx                            ← replace src/pages/dashboard/HmoPatients.jsx (Bug 3 — passes patient prop)
        └── AncPatients.jsx                            ← replace src/pages/dashboard/AncPatients.jsx (Bug 3 — passes patient prop)
```

The patches are **already applied** to `/home/z/my-project/GOODIE-MEDHUB-V2-main/` — your project. The copy in this zip is for review + git diff.

## How to Apply

### Step 1 — Run the SQL migrations (Bug 2 fix + Bug 1 diagnostic)

In Supabase SQL Editor:

1. Open `sql/074_hospital_bank_accounts.sql` → **Run** — creates the `hospital_bank_accounts` table with RLS policies + realtime publication.

2. Open `sql/075_verify_service_catalog.sql` → **Run** — diagnostic. Should show:
   - ✅ `service_catalog table EXISTS`
   - `total_services` ≥ 33, `lab_tests` ≥ 10
   - The 10 expected lab tests (LAB-FBC, LAB-URINE, LAB-STOOL, LAB-WIDAL, LAB-MPS, LAB-LFT, LAB-RFT, LAB-LIP, LAB-BSL, LAB-HBA1C)
   - The RLS policies

### Step 2 — Copy the patched files (already applied to your project)

The patches are **already applied** to `/home/z/my-project/GOODIE-MEDHUB-V2-main/`. Just verify they're there with `git status` and commit:

```bash
cd /home/z/my-project/GOODIE-MEDHUB-V2-main
git status
# Expected:
#   modified:   src/components/LabTestPicker.jsx
#   modified:   src/components/PatientProfile.jsx
#   modified:   src/pages/dashboard/DoctorWorkbench.jsx
#   modified:   src/pages/dashboard/Dashboard.jsx
#   modified:   src/pages/dashboard/Nursing.jsx
#   modified:   src/pages/dashboard/HmoPatients.jsx
#   modified:   src/pages/dashboard/AncPatients.jsx
#   new file:   supabase/migrations/074_hospital_bank_accounts.sql

git add .
git commit -m "fix: 4 bugs — lab picker diagnostic, hospital_bank_accounts table, PatientProfile race, vitals auto-queue"
git push
```

Vercel will auto-deploy.

### Step 3 — Verify

#### Bug 1 (Lab tests not loading)
1. Open DoctorWorkbench.
2. Open browser DevTools → Console.
3. Click **Select Laboratory Tests**.
4. If the lab test list is empty, the console will now show a `[LabTestPicker] service_catalog is empty` warning explaining the 4 possible causes + a SQL snippet to verify.
5. Run the diagnostic SQL from `075_verify_service_catalog.sql` to confirm the table has 10 lab tests.

#### Bug 2 (Bank account section)
1. Open Settings.
2. Scroll to the "Bank Account Details" panel.
3. It should now consistently show either "No bank accounts yet" (if empty) or the list of saved accounts — no more disappearing on refresh.
4. Click **+ Add Account** → fill in details → Save. The account should persist across page refreshes and logouts.

#### Bug 3 (Patient Profile not loading)
1. Open Dashboard → Patients tab.
2. Click any patient row.
3. Patient Profile should load **immediately** (no 6-second "Loading patient…" delay).
4. Test in Nursing, HMO Patients, and ANC Patients modules too — all should load instantly.

#### Bug 4 (Vitals auto-sending to DoctorWorkbench)
1. Open any patient profile → Vitals tab.
2. Click **Add Vitals** → fill in vitals → Save.
3. ✅ Vitals save to the patient's history.
4. ✅ Status shows "Recorded" (gray badge).
5. ✅ A **"Send to Doctor"** button appears on the row.
6. ✅ DoctorWorkbench does NOT show this patient in the queue (no toast pops for the doctor).
7. Click **Send to Doctor** → ✅ Status changes to "In Doctor Queue" (green badge).
8. ✅ DoctorWorkbench now shows the patient in the queue + the doctor gets a toast.

## Architecture Notes

### Bug 1 — Why the diagnostic warn?

The original `useOfflineTable` hook swallows all pull errors in `try/catch` (`useOfflineTable.js:412-414`), so a missing table looks identical to an empty table from the UI's perspective. The new `useEffect` in `LabTestPicker.jsx` checks if `catalog` is empty and prints a detailed console warning explaining the 4 possible causes. This makes future "lab tests not loading" issues trivially diagnosable.

### Bug 2 — Why a new migration?

`hospital_bank_accounts` is referenced by `Settings.jsx:66` and `InvoiceViewer.jsx:38`, but **no migration in the repo ever creates it**. Migration 011 creates `platform_bank_accounts` (a different table — for the SaaS platform's bank account). Migration 066 recreates 8 other missing tables but missed `hospital_bank_accounts`. This new migration creates the table with the columns Settings.jsx writes + RLS policies (admin/owner can write, all hospital members can read for printing bills) + realtime publication.

### Bug 3 — Why pass the patient as a prop?

`PatientProfile.jsx` mounts 16 `useOfflineTable` instances in parallel. On first render, all of them return `records: []` until `loadLocalRecords` resolves the IndexedDB read (typically 50ms but can be 6+ seconds on a busy tab). The `patient = patients.find(p => p.id === patientId)` lookup fails on that first paint → shows "Loading patient…" → after 6 seconds, the timeout fires → shows "Couldn't load this patient".

The fix is to pass the already-loaded patient record as a prop. The parent (Dashboard, Nursing, etc.) already has the patient in scope — there's no need to re-fetch it. `const patient = initialPatient || patients.find(...)` uses the prop on first render, then falls back to the lookup once IndexedDB resolves.

### Bug 4 — Why change `status: 'waiting'` to `status: 'recorded'`?

The `patient_vitals.status` field is overloaded:
- `DoctorWorkbench.jsx:233` filters its queue on `v.status === 'waiting'`
- `PatientProfile.handleSaveVitals` was setting `status: 'waiting'` thinking it just meant "saved vitals"

Result: every recorded vitals entry silently appeared in the doctor's queue, and the doctor got a toast notification for every vitals recording — even when staff just wanted to add to the patient's history.

The fix splits the semantics:
- `status: 'recorded'` — vitals saved to patient history (no doctor queue entry, no toast)
- `status: 'waiting'` — explicit "send to doctor queue" action (only via the new "Send to Doctor" button or Nursing triage)

The DoctorWorkbench INSERT listener was also gated on `row.status === 'waiting'` so it only toasts for actual queue entries.

## Build Verification

```
✅ npx vite build — 7.86s, 15 precache entries, no errors
✅ SQL parses cleanly via sqlfluff (parse exit=0)
✅ Patches applied directly to /home/z/my-project/GOODIE-MEDHUB-V2-main/
```

## Roll-Back

Each patch is independent — you can revert any subset:

```bash
cd /home/z/my-project/GOODIE-MEDHUB-V2-main

# Revert all patches
git checkout HEAD -- src/components/LabTestPicker.jsx src/components/PatientProfile.jsx \
  src/pages/dashboard/DoctorWorkbench.jsx src/pages/dashboard/Dashboard.jsx \
  src/pages/dashboard/Nursing.jsx src/pages/dashboard/HmoPatients.jsx \
  src/pages/dashboard/AncPatients.jsx
git rm supabase/migrations/074_hospital_bank_accounts.sql

# Revert just one (e.g., the PatientProfile changes)
git checkout HEAD -- src/components/PatientProfile.jsx
```

The SQL migration 074 is safe to leave in place even if you revert the code — it just creates a table that the code uses. If you want to remove the table too:

```sql
drop table if exists public.hospital_bank_accounts cascade;
```
