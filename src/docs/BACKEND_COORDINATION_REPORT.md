# Backend Coordination Report — Offline Sync, Conflict, Deletion, Dashboard RPC

This report lists every backend change the frontend audit identified
as required but **did not perform**. Each item is gated behind the
backend owner's approval: the frontend stops short of executing any
SQL, RLS, or RPC modification per the strict rules.

---

## 1. Per-device cursor — no shared server cursor

### Current backend state

The `sync_cursor` table has a UNIQUE constraint on
`(hospital_id, table_name)`. This means every device that logs in
for the same hospital shares one cursor. The bug: when device A
advances the cursor to T1, device B comes online and asks "give me
rows since the cursor", the server only returns rows newer than T1
— device B silently misses every row that was committed between
device B's own previous sync and T1.

### Frontend decision (already implemented)

The frontend no longer reads or writes the backend `sync_cursor`
table. Each browser installation gets its own UUID
(`src/lib/installationId.js`), and cursors are stored locally in
IndexedDB keyed by
`${installationId}|${hospitalId}|${tableName}`
(`src/lib/useOfflineTable.js`, `CURSOR_STORE`).

### What the backend owner should do

1. **Either** drop the UNIQUE constraint on `(hospital_id, table_name)`
   and add `device_id` to the key — so the frontend CAN use the
   backend cursor if it wants to.
2. **Or** leave the constraint in place; the frontend will simply
   ignore the table. **No coordination required** for this option.

The frontend is safe under either option. Recommendation: option 2
(leave it alone) — the device-local cursor is simpler, never leaks
across devices, and survives `sync_cursor` outages.

---

## 2. Tombstones for hard deletes

### Current backend state

`updated_at`-only incremental sync cannot detect hard deletes. A row
deleted server-side never appears in subsequent incremental pulls,
so the local copy stays forever — lists show rows that no longer
exist on the server.

### Frontend decision (already implemented)

The frontend NEVER hard-deletes a local row on its own. The only
deletions it performs are:

* User-initiated deletes (which go through the queue and only
  remove the local row AFTER the server confirms the delete).
* `clearLocalDataOnLogout()` — only deletes rows already marked
  `_synced = true`.

For server-initiated deletes, the frontend waits for a
**backend-approved tombstone event**. Without one, the local row
stays (visible in lists). The frontend does not invent a
frontend-only deletion mechanism.

### Tombstone format proposal (for backend owner to confirm)

```sql
-- Reuse deleted_at on every clinical/business table.
ALTER TABLE public.patients           ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.appointments       ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.admissions         ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.beds               ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.inventory_items    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.invoices           ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.invoice_items      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.payments           ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.prescriptions      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.pharmacy_orders    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.medication_administrations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.admission_requests ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.admission_timeline_events ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.billable_charges   ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.audit_events       ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.encounters         ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.patient_vitals     ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Replace every hard-delete trigger with a soft-delete trigger
-- that stamps deleted_at = now() instead of DELETE.
-- (Coordinate with the existing triggers before replacing.)
```

### Why this is the safest design

* **No data loss** — every "delete" becomes an update; the row
  stays in place for child references and audit.
* **Incremental sync detects it** — `updated_at` is bumped by the
  same trigger, so the next incremental pull fetches the row and
  the frontend marks it `_deleted = true`.
* **Lists hide it automatically** — the frontend already filters
  `!record._deleted && !record.deleted_at`.
* **Auditability** — the row is preserved with `deleted_at`, so the
  audit log can show "deleted at X by Y".

### Backend coordinator decision needed

* Confirm the column name (`deleted_at` vs `archived_at` vs `is_deleted`).
* Confirm the trigger approach (a single BEFORE DELETE trigger
  that converts DELETE → UPDATE, vs app-layer changes).
* Confirm rollback semantics (can a deleted row be undeleted by
  setting `deleted_at = NULL`?).

The frontend already reads `deleted_at` if present and treats it
as a tombstone — no further frontend change needed once the column
ships.

---

## 3. `_version` column for conflict detection

### Current backend state

There is no `_version` (or `version`) column on any clinical or
business table. Conflict detection currently uses `updated_at`
only, which is vulnerable to clock skew and clock rollback on
client devices.

### Frontend decision (already implemented)

The frontend conflict detector uses `updated_at` with a 1-second
tolerance. If the backend adds a monotonic `_version` integer
column (Postgres `version`), the detector automatically prefers it
(`src/lib/useOfflineTable.js`, `isRemoteNewer()`):

```js
if (local?._version != null && remote?._version != null) {
  return Number(remote._version) > Number(local._version)
}
```

### Proposed backend change (for approval)

```sql
ALTER TABLE public.patients           ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
ALTER TABLE public.appointments       ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
ALTER TABLE public.admissions         ADD COLUMN IF NOT EXISTS _version integer NOT NULL DEFAULT 1;
-- ... and so on for every clinical table.

CREATE OR REPLACE FUNCTION public.bump_version()
RETURNS trigger AS $$
BEGIN
  NEW._version := COALESCE(OLD._version, 0) + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER patients_version_trigger
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.bump_version();
-- ... one trigger per table.
```

### Why `_version` is better than `updated_at` alone

* Monotonic — immune to clock skew.
* Comparable across replicas — even if a read replica lags, the
  version is unambiguous.
* Survives timestamp truncation — `updated_at` is sometimes
  truncated to seconds in older PostgREST configs; `_version` is
  always exact.

The frontend already supports `_version`; no further frontend work
is required once the column ships.

---

## 4. `get_dashboard_summary()` RPC — verified JSON contract

### Current frontend state

The frontend calls `get_dashboard_summary(p_hospital_id uuid,
p_day date, p_tz text)` and expects the keys listed in
`src/lib/dashboardSummary.js` (EXPECTED_RPC_KEYS). If a key is
absent, the frontend falls back to local computation and logs a
one-time warning.

### What the frontend needs from the backend owner

1. Confirm the RPC exists in production. (It is not in any of the
   migration files we audited — the file `src/lib/dashboardSummary.js`
   was created in this audit assuming the RPC exists per the user's
   task description. If it does NOT exist, the frontend gracefully
   falls back to 100% local computation; the call simply errors
   out and the local path takes over.)
2. Confirm the parameter names (`p_hospital_id`, `p_day`, `p_tz`).
3. Confirm the return shape (single object vs single-element
   array). The frontend handles both.
4. Confirm the JSON keys. The frontend expects:

| Snake-case key (RPC)        | CamelCase key (frontend)   | Type    |
|-----------------------------|----------------------------|---------|
| `total_patients`            | `totalPatients`            | integer |
| `registered_today`          | `registeredToday`          | integer |
| `waiting_list`              | `waitingList`              | integer |
| `in_consultation`           | `consultList`              | integer |
| `discharged_today`          | `queueDischargedToday`     | integer |
| `anc_count`                 | `ancCount`                 | integer |
| `appointments_today`        | `apptToday`                | integer |
| `appt_scheduled_today`      | `apptScheduledToday`       | integer |
| `appt_completed_today`     | `apptCompletedToday`       | integer |
| `appt_cancelled_today`      | `apptCancelledToday`       | integer |
| `beds_total`                | `bedsTotal`                | integer |
| `beds_occupied`             | `bedsOccupied`             | integer |
| `beds_available`            | `bedsAvailable`            | integer |
| `beds_cleaning`             | `bedsCleaning`             | integer |
| `beds_reserved`             | `bedsReserved`             | integer |
| `admitted_today`            | `admittedToday`            | integer |
| `pending_admission_requests`| `pendingAdmissionRequests` | integer |
| `lab_pending`               | `labPending`               | integer |
| `lab_completed_today`       | `labCompletedToday`        | integer |
| `stock_out`                 | `stockOut`                 | integer |
| `stock_low`                 | `stockLow`                 | integer |
| `stock_expired`             | `stockExpired`             | integer |
| `stock_expiring`            | `stockExpiring`            | integer |
| `stock_alerts`              | `stockAlerts`              | integer |
| `revenue_today`             | `revenueToday`             | numeric |
| `outstanding`               | `outstanding`              | numeric |
| `outstanding_count`         | `outstandingCount`         | integer |
| `invoices_today`            | `invoicesToday`            | integer |

5. Confirm timezone semantics. The frontend sends `p_tz` as the
   hospital's configured timezone (`hospitals.timezone`, default
   `Africa/Lagos`). The RPC MUST compute `registered_today`,
   `revenue_today`, etc. in that timezone — NOT in UTC. A patient
   registered at 23:30 Lagos time on Monday must count toward
   Monday's total, not Tuesday's.

6. Confirm zero semantics. A legitimate zero (e.g. "no pending
   labs today") MUST come back as `0`, not `null`. The frontend
   handles `null` by falling back to local computation, but that
   defeats the purpose of the RPC.

### Why not just rewrite the RPC

Per the strict rules, the frontend does not modify RPC definitions.
The frontend can only consume what the backend exposes. The
defensive shape-mapping in `dashboardSummary.js` ensures the
frontend never breaks if the RPC returns a different shape — but
the frontend coordinator should still confirm the contract so we
get the RPC's speed benefit.

---

## 5. Verified column list — for re-enabling column projection

### Current frontend state

The frontend uses `select('*')` against every table because we
could not verify which columns exist in production. This pulls
unnecessary bytes over the wire (especially on `audit_events`,
which can have very large `summary` text) and prevents the
PostgREST schema cache from optimizing.

### What the frontend needs from the backend owner

A verified list of columns for each table the frontend reads. The
frontend will then re-enable column projection (e.g.
`select('id,full_name,mrn,created_at,updated_at')` for `patients`)
and re-test. The list of tables the frontend touches:

```
patients, profiles, hospitals, facilities, appointments,
patient_vitals, encounters, prescriptions, pharmacy_orders,
pharmacy_requests, medication_administrations, lab_orders,
lab_tests, radiology_scans, admissions, admission_requests,
admission_timeline_events, beds, inventory_items, invoices,
invoice_items, payments, billable_charges, audit_events,
ai_assessments, patient_wallets, patient_wallet_transactions,
hospital_registration_fees, hmo_providers, hmo_contracts,
insurance_claims, expense_vendors, hospital_expenses,
recurring_expenses, hospital_bank_accounts, hospital_payment_methods,
price_lists, service_catalog, document_sequences, rosters,
roster_entries, messages, message_channel_reads, shift_handovers,
patient_drug_charts, patient_stock_records, prescription_templates,
patient_folder_expirations, credit_control_rules, statement_runs,
deposits, credit_notes, approval_requests, payment_allocations,
claim_status_histories, staff_role_permissions, hospital_role_permissions
```

For each table we need:

* The exact column names that exist in production (including any
  added by migrations that have run since the last frontend audit).
* The NULL/NOT NULL status (so we can decide whether to filter
  `null` on reads).
* Whether the column is a foreign key (so we can decide whether to
  join or fetch separately).

### Specific known-missing columns

These columns were referenced in earlier frontend iterations but
are NOT present in any migration file we audited. The frontend
needs the backend owner to either add them or confirm they are
not needed:

| Table               | Column           | Purpose                                 |
|---------------------|------------------|-----------------------------------------|
| `appointments`      | `patient_id`     | Link appointment to patient (currently the frontend joins by patient_name string, fragile). |
| `lab_tests`         | `patient_id`     | Direct patient link for lab tests.      |
| `beds`              | `patient_id`     | Direct patient link for occupied beds.  |
| `admissions`        | `patient_name`   | Denormalized name for fast list rendering. |
| `admission_requests`| `patient_name`   | Denormalized name for fast list rendering. |

The frontend does NOT introduce these columns on its own — they
require a migration and the backend owner's approval.

---

## 6. RPC timezone correction (already covered by item 4.5)

Reiterating because it has been a source of bugs in production:
every dashboard count (`registered_today`, `revenue_today`,
`appointments_today`, `admitted_today`, `discharged_today`,
`invoices_today`, `lab_completed_today`) MUST be computed in the
hospital's timezone, not UTC. The frontend passes `p_tz` to the
RPC; please confirm the RPC uses it in the `WHERE` clauses
(`date_trunc('day', some_timestamptz AT TIME ZONE p_tz)`).

---

## 7. Realtime subscription scope

The frontend opens one realtime subscription per
`useOfflineTable({ realtime: true })` call. Each subscription is
filtered by `hospital_id=eq.<uuid>` so cross-hospital rows do not
leak. The backend owner should confirm:

* Realtime is enabled for every table the frontend subscribes to.
  (Migration `047_realtime_for_doctor_workbench.sql` and
  `056_realtime_for_all_modules.sql` exist; please confirm both
  are applied in production.)
* The RLS policy on each realtime channel correctly enforces
  hospital scoping — the subscription filter is a convenience, not
  a security boundary.

---

## Summary of what the frontend did NOT do (per strict rules)

* Did not run any SQL migration.
* Did not modify any RLS policy.
* Did not modify any RPC definition.
* Did not modify any trigger.
* Did not deploy anything.
* Did not guess any database column name.
* Did not touch the backend `sync_cursor` table.

Each item above requires explicit backend-owner approval before
execution.
