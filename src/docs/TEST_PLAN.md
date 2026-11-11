# Test Plan — Offline Sync, Conflict, Deletion, Dashboard

This document lists every test the frontend audit identified as
required to validate the changes. Tests are grouped by area; each
test lists the scenario, the expected outcome, and the actual result
of the audit (which is **code-review only** — no runtime testing
was performed per the strict rules).

## Strict limitation

> "Do not claim implementation or testing that did not happen."

The tests below describe WHAT MUST HAPPEN once the code is deployed.
None of them were executed in this audit because there is no
browser, no Supabase staging environment, and no credentials. The
"Result" column records what the code review confirms would happen
if the test were run; it is not a pass/fail result.

---

## 1. Two devices syncing existing patient records

| Step | Action | Expected |
|------|--------|----------|
| 1.1  | Device A and Device B both sign in to hospital H1. | Both fetch the same set of patients. |
| 1.2  | Device A creates patient P1 (online). | Device A's `patients` table includes P1; Device B receives a realtime event and pulls P1 down. |
| 1.3  | Device A creates patient P2 (online). | Device B's local count matches Device A's count within 1s. |
| 1.4  | Device B's cursor for `patients` is its OWN — not the same as Device A's cursor. | Verified by inspecting `IndexedDB > sync_cursors` — each device has a different `installationId` in the cursor key. |

**Audit result:** Code review confirms each device generates its own
installationId in `installationId.js`, and cursors are keyed by
`${installationId}|${hospitalId}|${tableName}`. The shared backend
`sync_cursor` is never read. ✅ (code-review only)

---

## 2. Offline patient creation

| Step | Action | Expected |
|------|--------|----------|
| 2.1  | Device A goes offline (DevTools → Network → Offline). | `isOnline` becomes false. |
| 2.2  | Device A creates patient P3. | Record is saved locally with `_synced = false`; `pendingCount` increments to 1. |
| 2.3  | Device A goes back online. | `flushTableQueue()` runs automatically on the `online` event; P3 is upserted to Supabase; `_synced = true`; `pendingCount` returns to 0. |
| 2.4  | Device A reloads the page. | P3 is still present (it was persisted in IndexedDB) and still shows `_synced = true`. |

**Audit result:** `addRecord()` correctly stamps `_synced = false`
and queues the record. The 60-second `setInterval` retry timer and
the `online` event listener both call `flushTableQueue()`. ✅
(code-review only)

---

## 3. Cross-device patient delivery (nurse → doctor)

| Step | Action | Expected |
|------|--------|----------|
| 3.1  | Nurse on Device A creates patient P4 with vitals. | Record appears in Device A's `patients` and `patient_vitals` tables. |
| 3.2  | Doctor on Device B has the Patients tab open. | Within ~1s, the realtime subscription fires; `pullFromSupabase()` pulls P4 down; the patient appears in Device B's list. |
| 3.3  | Doctor clicks P4. | The PatientProfile shows the vitals entered by the nurse. |

**Audit result:** `useOfflineTable({ realtime: true })` is the
opt-in path. The current `useHospitalDashboard.js` does not pass
`realtime: true`; the dashboard relies on the initial pull + the
`online` event. For real-time cross-device updates, callers MUST
opt in by passing `{ realtime: true }`. ✅ (code-review only)
**Risk:** Without `realtime: true`, cross-device updates only land
on page reload or reconnect. The dashboard tab relies on this; if
the user expects live updates, the caller must opt in.

---

## 4. Nurse vitals reaching doctors after sync

| Step | Action | Expected |
|------|--------|----------|
| 4.1  | Nurse on Device A (offline) records vitals for patient P5. | Vitals row saved locally with `_synced = false`. |
| 4.2  | Device A reconnects. | Vitals are flushed and pushed to Supabase. |
| 4.3  | Doctor on Device B has `patient_vitals` mounted with `realtime: true`. | The vitals appear on Device B within ~1s. |
| 4.4  | Doctor opens P5's profile. | The vitals chart shows the new reading. |

**Audit result:** Same as test 3 — works if the consumer opts in
to realtime. The sync queue correctly orders parents (patients)
before children (patient_vitals), so a vitals row created for an
offline-registered patient reaches the server only AFTER the
patient. ✅ (code-review only)

---

## 5. Simultaneous edits and conflicts

| Step | Action | Expected |
|------|--------|----------|
| 5.1  | Doctor A edits prescription Rx1 (changes dosage) on Device A. | Local row gets `_synced = false`, `updated_at = T1`. |
| 5.2  | Doctor B edits prescription Rx1 (changes frequency) on Device B. | Local row gets `_synced = false`, `updated_at = T2` where T2 > T1. |
| 5.3  | Device A pushes Rx1 to server (online). | Server row's `updated_at` = T1. |
| 5.4  | Device B pulls the server change (realtime or incremental). | `mergeRemoteRows()` detects `_synced = false` locally AND `isRemoteNewer()` returns false (server T1 < local T2). Local row is preserved; no conflict marker. |
| 5.5  | Device B pushes Rx1 to server. | Server row's `updated_at` = T2. Doctor A's local copy is now stale. |
| 5.6  | Device A pulls the server change. | `mergeRemoteRows()` detects `_synced = true` locally AND `isRemoteNewer()` returns true (server T2 > local T1). For `prescriptions` (in CONFLICT_SENSITIVE_TABLES), local row gets `_conflict = true`, `_conflictReason = 'remote_newer'`; remote row is staged under `${id}__remote_${ts}`. The conflict appears in the queue panel. |
| 5.7  | Doctor A clicks "Resolve" → "Keep local". | `resolveConflictAcceptLocal()` clears the conflict marker, re-queues the local row, deletes the shadow. |
| 5.8  | Doctor A clicks "Resolve" → "Accept remote". | `resolveConflictAcceptRemote()` saves an audit copy of the local row, replaces the local row with the remote version, deletes the shadow. |

**Audit result:** Code review confirms the conflict detection
logic in `mergeRemoteRows()` and the two resolution functions.
**Clinical records (prescriptions, vitals, encounters, invoices,
payments, billable_charges, medication_administrations, lab_orders,
lab_tests, radiology_scans, admissions, admission_requests) are
NEVER auto-resolved.** The user must explicitly choose. ✅
(code-review only)
**Risk:** Without the backend `_version` column, conflict detection
relies on `updated_at` timestamps with a 1s tolerance. Clock skew
> 1s could cause false negatives. See BACKEND_COORDINATION_REPORT
§3.

---

## 6. First-time full sync

| Step | Action | Expected |
|------|--------|----------|
| 6.1  | Brand new browser, never used. `localStorage` has no `gmh.installation.id.v1`. | `getInstallationId()` generates a UUID and persists it. |
| 6.2  | User signs in to hospital H1 for the first time. | `pullFromSupabase()` is called for every table. `isTableBootstrapped()` returns false, so `fetchAllRemoteRows()` is used (full pull, no cursor). |
| 6.3  | Each table is paginated (1000 rows/page) and merged into IndexedDB. | After the last page of each table, `markTableBootstrapped()` is called and a cursor is set to `syncStart`. |
| 6.4  | On next sync attempt, `isTableBootstrapped()` returns true and `fetchIncrementalRemoteRows()` is used. | Only rows with `updated_at >= (cursor - 5min)` are fetched. |
| 6.5  | Reload the page. | Cursor survives; the next sync is incremental. |

**Audit result:** Code review confirms the bootstrap gate works.
If the bootstrap pull is interrupted (network error, max pages
exceeded), `complete = false` and the cursor is NOT advanced — the
next sync retries the full pull. ✅ (code-review only)

---

## 7. Interrupted sync

| Step | Action | Expected |
|------|--------|----------|
| 7.1  | Device A is mid-pull of `patients` (page 3 of 5). Network drops. | `fetchIncrementalRemoteRows()` returns `{ rows: null, error, complete: false }`. The cursor is NOT advanced. |
| 7.2  | Network returns. | `online` event fires; `pullFromSupabase()` runs again. Because the cursor was not advanced, the pull starts from the same `since` and re-pulls the rows that were already merged (idempotent upsert). |
| 7.3  | Pull completes successfully. | Cursor advances; next sync is incremental from the new `syncStart`. |

**Audit result:** ✅ (code-review only) The 5-minute overlap window
ensures rows committed during the failed pull are caught on retry.

---

## 8. Failed page requests

| Step | Action | Expected |
|------|--------|----------|
| 8.1  | A page request returns a Supabase error (e.g. RLS denies the read, code 42501). | `fetchAllRemoteRows()` returns `{ rows: null, error, complete: false }`. The original error object is preserved (code, message, details, hint). |
| 8.2  | The error is logged with `code=42501`. | Console shows the full error. |
| 8.3  | The cursor is NOT advanced. | Next sync retries from the same point. |
| 8.4  | Records already merged from previous pages remain in IndexedDB. | No data loss. |

**Audit result:** ✅ (code-review only) The error path in
`pullFromSupabase()` does NOT advance the cursor and does NOT
delete already-merged rows. The original error object is preserved
in the console (we do not yet surface it in the UI — see Risks in
the final report).

---

## 9. Hospital switching

| Step | Action | Expected |
|------|--------|----------|
| 9.1  | Admin user is signed in to hospital H1 with cached patients P1, P2, P3. | IndexedDB has rows with `hospital_id = H1`. |
| 9.2  | Admin switches to hospital H2 (via account switching or multi-hospital admin). | `AuthContext.loadProfileAndHospital` detects `previousHospital !== newHospital` and calls `clearCursorsOnHospitalSwitch(H1)`. |
| 9.3  | The dashboard loads. | `useHospitalDashboard` calls `useOfflineTable('patients', H2)`. `loadLocalRecords()` uses the compound index `IDBKeyRange.only(['patients', H2, 0])` — H1's rows are filtered out. |
| 9.4  | Pull runs. | Cursors for H2 are absent; full pull of H2's data. H1's cursors are cleared; if the user logs back into H1, a fresh full pull re-bootstraps. |
| 9.5  | H1's records stay in IndexedDB. | They are scoped out of every read by `hospital_id === H2`. The user cannot see them. |

**Audit result:** ✅ (code-review only) The hospital-scoped read
uses the compound index when available, and falls back to a full
scan + JS filter. The `hospitalIdRef` change detector in
`useOfflineTable.js` triggers `clearAllCursorsForHospital()` on
hospital switch.

---

## 10. Dashboard accuracy around local midnight

| Step | Action | Expected |
|------|--------|----------|
| 10.1 | Time is 23:55 on Monday in hospital timezone (Africa/Lagos). | `todayKeyInZone(tz)` returns `2024-XX-XX` (Monday). |
| 10.2 | A patient is registered at 23:58 Lagos time. | `dayKeyInZone(p.created_at, tz)` returns Monday's key. The patient counts toward Monday's `registeredToday`. |
| 10.3 | Time crosses midnight; it is now 00:02 Tuesday Lagos time. | `todayKeyInZone(tz)` returns Tuesday's key. The RPC `p_day` parameter is recomputed. The next RPC fetch uses Tuesday. |
| 10.4 | `registeredToday` (local fallback) recomputes. | The patient registered at 23:58 Monday is no longer in Monday's count — correct, since "today" is now Tuesday. |
| 10.5 | The RPC was last called with `p_day = Monday`. The new effect fires because `todayKey` changed. | The RPC is called with `p_day = Tuesday`; returns Tuesday's count. |

**Audit result:** ✅ (code-review only) The `useEffect` dependency
on `todayKey` ensures the RPC refetches when local midnight rolls
over. The `isToday` helper uses `dayKeyInZone(iso, tz) === today`,
so a patient registered at 23:58 Lagos on Monday counts toward
Monday until midnight Lagos, then toward Tuesday's count after.

---

## 11. Zero-value preservation (the `||` vs `??` bug)

| Step | Action | Expected |
|------|--------|----------|
| 11.1 | Hospital has 0 pending labs today (real zero). | RPC returns `lab_pending = 0`. |
| 11.2 | The dashboard reads `m.labPending`. | `pick('labPending', localLabPending)` returns `0` (RPC value), NOT the local count. |
| 11.3 | Local computation also returns 0 (no pending labs locally). | `pick` still returns 0 (RPC value wins). |
| 11.4 | The KPI tile shows "0 pending labs". | Correct. |

**Audit result:** ✅ (code-review only) The `pick` helper uses
`!= null` (loose nullish check), so `0` from the RPC survives. The
old `||` would have collapsed `0` to `localLabPending` (which was
also `0` in this case — by luck). The fix matters when RPC and
local disagree (e.g. RPC=0, local=2 because of a pending offline
write): `pick` returns `0`, the dashboard shows the server truth.

---

## 12. Pending count is hospital-scoped

| Step | Action | Expected |
|------|--------|----------|
| 12.1 | Device has unsynced rows for H1 (3 rows) and H2 (2 rows). | IndexedDB has 5 unsynced rows total. |
| 12.2 | User is signed in to H1. | `loadLocalRecords()` filters by `hospital_id === H1`. |
| 12.3 | `pendingCount` shown on the dashboard. | Should be 3 (H1's unsynced rows), NOT 5. |

**Audit result:** ✅ (code-review only) The hook's pendingCount is
computed from `scopedRows` (the hospital-scoped subset), not the
full IndexedDB. H2's unsynced rows are invisible to H1's dashboard.

---

## 13. Tombstone-driven deletion

| Step | Action | Expected |
|------|--------|----------|
| 13.1 | Server stamps `deleted_at = now()` on patient P10. | Next incremental pull fetches P10; `mergeRemoteRows()` sets `_deleted = true`. |
| 13.2 | P10 disappears from the dashboard list. | Correct — `filtered = scopedRows.filter(r => !r._deleted && !r.deleted_at)`. |
| 13.3 | P10 stays in IndexedDB. | Correct — for audit and child references. |

**Audit result:** ✅ (code-review only) — assuming the backend
adds the `deleted_at` column (see BACKEND_COORDINATION_REPORT §2).
Without that column, hard-deletes on the server remain invisible
to the frontend; rows would stay in lists indefinitely. **This is
a backend coordination item.**

---

## 14. Discard / skip protection for clinical rows

| Step | Action | Expected |
|------|--------|----------|
| 14.1 | A prescription is stuck in conflict. User clicks "Discard" in the queue panel. | `skipStuckSyncItem()` checks `CONFLICT_SENSITIVE_TABLES.has('prescriptions')` and `record._conflict === true`. Throws: "Clinical records in conflict cannot be discarded. Resolve the conflict instead." |
| 14.2 | The UI shows the error. | The row is NOT discarded. |

**Audit result:** ✅ (code-review only) The hard guardrail in
`skipStuckSyncItem()` prevents silent clinical data loss.

---

## Summary

| Test | Result |
|------|--------|
| 1. Two devices syncing existing patient records | ✅ (code-review) |
| 2. Offline patient creation | ✅ (code-review) |
| 3. Cross-device patient delivery | ✅ with `realtime: true` (code-review) |
| 4. Nurse vitals reaching doctors | ✅ with `realtime: true` (code-review) |
| 5. Simultaneous edits and conflicts | ✅ (code-review) |
| 6. First-time full sync | ✅ (code-review) |
| 7. Interrupted sync | ✅ (code-review) |
| 8. Failed page requests | ✅ (code-review) |
| 9. Hospital switching | ✅ (code-review) |
| 10. Dashboard accuracy around midnight | ✅ (code-review) |
| 11. Zero-value preservation | ✅ (code-review) |
| 12. Hospital-scoped pending count | ✅ (code-review) |
| 13. Tombstone-driven deletion | ⚠️ requires backend tombstones |
| 14. Discard protection for clinical rows | ✅ (code-review) |

**All tests are code-review only. No runtime verification was
performed.** The frontend coordinator should run these tests in
a staging environment with two real devices before promoting to
production.
