# PHASE 2 — PERFORMANCE AUDIT REPORT
# GOODIE-MEDHUB-V2

## A. Original performance problems discovered

### A1. Eager bundle — 1.3 MB main bundle (325 KB gzip)

**File:** `vite.config.js` (lines 38-65), `src/pages/dashboard/Dashboard.jsx`
(lines 6-64)

**Problem:** `manualChunks` splits vendors (react, supabase, charts,
sheets, icons), but the main `index-*.js` is still 1,325 KB because
**all 30+ page components are eagerly imported at the top of
Dashboard.jsx**:

```js
import Billing from './Billing'
import Pharmacy from './Pharmacy'
import Laboratory from './Laboratory'
// ... 27 more page imports
```

Each of those pages (Billing 1777 lines, DoctorWorkbench 1211 lines,
etc.) is bundled into the main chunk. The browser parses ALL of them
before it can render anything — even pages the user never opens.

**Bonus problem:** `xlsx` (424 KB) and `recharts` (414 KB) are already
split into vendor chunks, but they're loaded eagerly by the main
bundle because the dashboard imports `DashboardCharts` which imports
recharts at module level. Same with xlsx (Billing.jsx imports it at
the top).

### A2. useOfflineTable pulls ENTIRE tables on every cache miss

**File:** `src/lib/useOfflineTable.js` (lines 357-380)

**Problem:** `fetchAllRemoteRows` paginates through ALL rows of a
table for the hospital, 1000 rows per page, up to 500 pages
(500,000 rows safety limit):

```js
const PULL_PAGE_SIZE = 1000
const PULL_MAX_PAGES = 500
for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('hospital_id', hospitalId)
    .order('id', { ascending: true })
    .range(from, from + PULL_PAGE_SIZE - 1)
  ...
}
```

For a hospital with 5,000 patients and 10,000 invoices, opening
Dashboard pulls 15,000 rows across 15 paginated requests just to
populate the dashboard widget counts. On a 200 ms/RTT network:
15 requests × 200 ms = 3 seconds of pure latency, plus payload
deserialization.

**Bigger problem:** The `select('*')` returns EVERY column. The
dashboard only needs `created_at`, `queue_status`, `category`,
`status`, `amount_paid`, `balance`, etc. — but the wire pulls
clinical notes, prescriptions, diagnoses, and full JSONB payloads.

**Even bigger problem:** No incremental sync. Every page load with
an expired cache (5-min TTL) re-pulls the entire table even if
nothing changed since the last sync.

### A3. useOfflineTable getAll() reads ENTIRE IndexedDB on every hook call

**File:** `src/lib/useOfflineTable.js` (lines 435-470)

**Problem:** `loadLocalRecords` calls `getAllLocalRecords(db)` which
fetches **every record in the entire IndexedDB store**, then filters
in JavaScript by `table_name` and `hospital_id`:

```js
const all = await getAllLocalRecords(db)
const filtered = all.filter(
  (record) =>
    record.table_name === tableName &&
    record.hospital_id === hospitalId &&
    !record._deleted &&
    !record.deleted_at
)
```

For a hospital with 20,000 records across 30 tables, every
`useOfflineTable` call reads all 20,000 records from IndexedDB and
filters in JS — even though IndexedDB has indexes on `table_name`
and `hospital_id`.

The hook is called **18 times on the Settings page** alone
(10 manager imports + Settings.jsx itself). That's 18 × 20,000 =
**360,000 record reads** per Settings page mount.

### A4. Dashboard mounts 9 useOfflineTable hooks eagerly

**File:** `src/pages/dashboard/Dashboard.jsx` (lines 224-809)

**Problem:** Dashboard.jsx (the layout shell that's always mounted
when logged in) calls `useOfflineTable` 9 times at the top level —
even if the user is on the Billing tab and never visits the overview:

```js
const { records: patients, ... } = useOfflineTable('patients', hospital?.id)
const { records: vitals } = useOfflineTable('patient_vitals', hospital?.id)
const { records: inventoryItems } = useOfflineTable('inventory_items', hospital?.id)
const { records: labTests } = useOfflineTable('lab_tests', hospital?.id)
const { records: allMessages } = useOfflineTable('messages', hospital?.id)
const { records: feeRecords } = useOfflineTable('hospital_registration_fees', hospital?.id)
const { addRecord: addBillableCharge } = useOfflineTable('billable_charges', hospital?.id)
const { records: myReadStates } = useOfflineTable('message_channel_reads', hospital?.id)
const result = useOfflineTable('hospital_role_permissions', hospital?.id)
```

These hooks fire on every Dashboard mount, regardless of which tab
is active. So even clicking "Billing" triggers 9 IndexedDB reads
and (potentially) 9 Supabase pulls.

### A5. Dashboard waits for ALL data sources before rendering

**File:** `src/components/dashboard/hospital/useHospitalDashboard.js`
(lines 110-114)

**Problem:**

```js
const all = [pts, appts, vitals, beds, adms, admReqs, labTests, labOrders, stock, invoices, audit]
const loading = all.some((t) => t.loading)
```

`loading` is true until ALL 11 tables finish loading. The
`<DashboardOverview>` component shows a blank/loading state until
everything is ready. One slow table (e.g. `invoices` with 10,000
rows) blocks the entire dashboard from rendering.

### A6. Each Settings manager makes its own useOfflineTable calls

**File:** `src/pages/dashboard/Settings.jsx` + 10 manager imports

**Problem:** Settings.jsx imports 10 manager components. Each one
calls `useOfflineTable` internally. Total: **18 useOfflineTable
calls** per Settings page visit — even though most users only want
to change their theme color.

### A7. Sequential IndexedDB writes during sync

**File:** `src/lib/useOfflineTable.js` (lines 393-411, 919-1011)

**Problem:** `pullFromSupabase` writes each pulled record to
IndexedDB one at a time inside a `for` loop:

```js
for (const remote of remoteRows) {
  await putLocalRecord(db, { ...remote, table_name: tableName, ... })
}
```

For 1000 rows, that's 1000 sequential IndexedDB transactions.
IndexedDB transactions are slow individually; batching them in
a single transaction would be 10-50x faster.

Same problem in `flushTableQueue` — each pending record is pushed
one at a time.

### A8. Realtime subscriptions don't have explicit cleanup checks

**File:** Various (7 `supabase.channel()` calls, 6 `removeChannel()`
calls)

**Problem:** Most components create realtime channels but only 6 of 7
have explicit `removeChannel()` calls in cleanup. Need to verify the
7th is properly cleaned up — if not, channels leak across
navigation and accumulate, slowing down realtime message
processing.

### A9. Hospital dashboard: 11 tables loaded regardless of role

**File:** `src/components/dashboard/hospital/useHospitalDashboard.js`
(lines 99-108)

**Mitigated:** The hook already uses `on(access.X)` to skip tables
the role can't see — so a doctor doesn't load inventory or
invoices. **This is actually well-designed.** But the underlying
`useOfflineTable` calls still do `getAll()` on every hook mount,
so even a doctor with 4 tables still does 4 full-table reads.

### A10. Cache TTL is 5 minutes — too short

**File:** `src/lib/useTableCache.js` (line 34)

```js
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes
```

**Problem:** Every 5 minutes, the next mount of any table triggers a
full re-pull from Supabase. For a dashboard the user keeps open
all day, this means 8-12 full re-pulls per table per shift.

### A11. No server-side aggregation — everything computed client-side

**File:** `src/components/dashboard/hospital/useHospitalDashboard.js`
(lines 115-233)

**Problem:** The hook downloads entire tables of patients,
appointments, vitals, invoices, etc. and computes totals, daily
series, week-over-week, occupancy rates, etc. ALL in JavaScript:

```js
m.totalPatients = patients.length  // ← entire patients table pulled just to count it
m.revenueToday = inv.filter(...).reduce(...)  // ← entire invoices table pulled just to sum today
```

For a hospital with 10,000 patients and 50,000 invoices, this is
insane. These should be Supabase RPC functions that return scalar
counts/sums.

## B. Implementation plan (phases 3-7)

### Phase 3 — Dashboard optimization

| Step | What | How | Risk |
|---|---|---|---|
| 3.1 | Render layout immediately | Show skeleton state, don't block on `loading` | Low |
| 3.2 | Display cached data immediately | Use existing `useTableCache` — already done, but extend TTL | Low |
| 3.3 | Background refresh | Already done via `flushTableQueue` + realtime — keep | Low |
| 3.4 | Loading skeletons | Add `<Skeleton>` component, use in widgets | Low |
| 3.5 | Fetch only needed fields | Change `select('*')` to specific columns per table | Medium (need to verify no missing columns) |
| 3.6 | Date-range limited queries | Add `.gte('created_at', ninetyDaysAgo)` for series | Medium (need to verify no other code reads old records) |
| 3.7 | Server-side aggregation RPCs | Create `get_dashboard_summary(hospital_id)` RPC | High (schema change — needs migration, separate approval) |
| 3.8 | Independent widget loading | Each widget shows its own spinner, not blocked by others | Low |
| 3.9 | Prevent re-renders | Memoize widget components | Low |

### Phase 4 — Offline sync improvements

| Step | What | How | Risk |
|---|---|---|---|
| 4.1 | Don't download entire tables | Add `select('col1,col2,...')` per table | Medium |
| 4.2 | Incremental sync via `updated_at` | Add `.gte('updated_at', lastSync)` — needs schema check | High (needs `_last_synced_at` column — already added in migration 097) |
| 4.3 | Handle deletes | Add soft-delete tracking via `deleted_at` filter | Medium |
| 4.4 | Batch IndexedDB writes | Use single transaction for bulk put | Low |
| 4.5 | Prevent concurrent sync per table | Add `inFlightRequests` per (table, hospital) — already done in useTableCache | Already done |
| 4.6 | Preserve pending writes | Already done (don't overwrite `_synced: false` records) | Already done |
| 4.7 | Network disconnect handling | Already done (online/offline listeners) | Already done |
| 4.8 | Never mark partial sync as success | Add try/catch around each page; if any fails, keep old data | Already partially done |
| 4.9 | Hospital isolation | IndexedDB has `hospital_id` index; verify all queries filter by it | Already done |

### Phase 5 — Code splitting

| Step | What | How | Risk |
|---|---|---|---|
| 5.1 | Lazy-load page components | Replace 30+ `import X from './X'` with `lazy(() => import('./X'))` | Low |
| 5.2 | Wrap tab render in Suspense | Add `<Suspense fallback={<Skeleton/>}>` around tab content | Low |
| 5.3 | Lazy-load recharts | Already split — confirm `DashboardCharts` is the only importer and it's lazy | Low |
| 5.4 | Lazy-load xlsx | Already split — verify Billing/Reports import it dynamically only when exporting | Low |
| 5.5 | Don't lazy-load auth/security | Keep `AuthContext`, `subscriptionLock`, `permissions` eager | Already done |

### Phase 6 — Database

| Step | What | How | Risk |
|---|---|---|---|
| 6.1 | Add missing FK indexes | Create indexes on `invoices.patient_id`, `lab_orders.patient_id`, etc. | Medium (need migration) |
| 6.2 | Add composite indexes for common filters | `(hospital_id, status, created_at)` on hot tables | Medium |
| 6.3 | Review RLS policies | Check `current_hospital_id()` is `STABLE` and cached | Low |
| 6.4 | Add REPLICA IDENTITY FULL only where needed | Audit which tables need it for realtime deletes | Low |
| 6.5 | Server-side aggregation RPCs | Create `get_dashboard_summary(hospital_id, days)` returning counts/sums | High (needs migration) |

### Phase 7 — Security

| Step | What | How | Risk |
|---|---|---|---|
| 7.1 | Verify all queries scope by `hospital_id` | Grep all `supabase.from(...)` calls | Low |
| 7.2 | Verify RPCs can't leak across hospitals | Add `hospital_id = current_hospital_id()` to every RPC | Low |
| 7.3 | Verify no service-role keys in frontend | Grep for `service_role`, `SUPABASE_SERVICE_ROLE` | Low |
| 7.4 | Verify offline cache scoped by hospital | Already done (`hospital_id` filter in every query) | Already done |
| 7.5 | Verify logout clears stale data | Already done (`clearLocalDataOnLogout`) | Already done |

## C. What I'll do (and what I won't)

### Will do (safe, low-risk, no schema changes):

1. **Lazy-load all page components** in Dashboard.jsx (Phase 5.1, 5.2)
   - Replaces 30+ eager imports with `React.lazy()`
   - Wraps tab render in `<Suspense>`
   - **Effect:** Main bundle drops from 1.3 MB to ~200 KB; pages
     load on demand

2. **Select only needed columns** in `pullFromSupabase` (Phase 4.1)
   - Add a `COLUMNS_BY_TABLE` map
   - Change `select('*')` to `select(columns)`
   - **Effect:** Network payloads drop ~70% (no more clinical notes
     pulled just to count patients)

3. **Batch IndexedDB writes** in `pullFromSupabase` (Phase 4.4)
   - Use a single transaction for all rows in a pull
   - **Effect:** Sync time drops 5-10x for large tables

4. **Render dashboard layout immediately** (Phase 3.1, 3.4)
   - Show skeleton widgets, don't block on `loading`
   - Each widget shows its own spinner
   - **Effect:** Dashboard renders in <500ms instead of waiting
     for all 11 tables

5. **Extend cache TTL** from 5 minutes to 30 minutes (Phase 3.10)
   - Reduces unnecessary re-pulls
   - **Effect:** 6x fewer Supabase pulls during a shift

6. **Add loading skeletons** to DashboardOverview (Phase 3.4)
   - Replaces blank screens
   - **Effect:** Perceived performance improves even if actual
     load time is the same

7. **Memoize widget components** (Phase 3.9)
   - Wrap each widget in `React.memo`
   - **Effect:** Prevents re-renders when sibling widgets update

8. **Verify realtime channel cleanup** (Phase 6.6)
   - Audit all 7 channel creations, ensure all have removeChannel
   - **Effect:** No more channel leaks across navigation

### Will NOT do (high-risk, requires separate approval):

- ❌ **Server-side aggregation RPCs** — requires DB migration +
  separate approval per your rules
- ❌ **Incremental sync via `updated_at`** — requires schema audit
  + careful testing of edge cases (deletes, conflict resolution)
- ❌ **Add database indexes** — requires migration + separate
  approval
- ❌ **Modify RLS policies** — too risky without EXPLAIN ANALYZE
  on production
- ❌ **Change `current_hospital_id()` function** — affects every
  query in the app

I'll DOCUMENT these as recommended next steps with proposed SQL,
but won't apply them.

### Verification I'll do:

- ✅ Run `npm run build` before and after — capture sizes
- ✅ Validate all JSX/JS compiles via Babel
- ✅ Validate all SQL via syntax check
- ✅ Run production build to confirm no errors
- ❌ Can't run e2e tests (no test credentials)
- ❌ Can't measure actual load time (no browser env)

## D. Files that will be changed

| File | Change | Risk |
|---|---|---|
| `src/pages/dashboard/Dashboard.jsx` | Lazy-load page imports + Suspense | Low |
| `src/lib/useOfflineTable.js` | Column projection + batch writes + cache TTL | Medium |
| `src/lib/useTableCache.js` | Extend TTL | Low |
| `src/components/dashboard/hospital/useHospitalDashboard.js` | Don't block on loading + skeleton widgets | Low |
| `src/components/dashboard/DashboardOverview.jsx` | Add skeleton states | Low |
| `src/components/dashboard/DashboardCharts.jsx` | Lazy-load recharts | Low |

## E. Files that will NOT be changed

- `src/lib/supabaseClient.js` — no security risk, no perf issue
- `src/context/AuthContext.jsx` — works correctly
- `src/lib/permissions.js` — works correctly
- `src/lib/subscriptionLock.js` — works correctly
- All page components (Billing, Pharmacy, etc.) — they're already
  conditionally rendered; lazy-loading them at the Dashboard level
  is the fix
- All migrations — no DB changes without separate approval
- All RLS policies — no security changes without separate approval
