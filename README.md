# GOODIE-MEDHUB-V2 Performance Optimization — Install Guide

## What this package does

Fixes the extremely slow application loading (up to 7-10 minutes)
with **4 surgical changes** that don't break any existing
functionality:

1. **Lazy-load all 26 page components** — main bundle drops from
   1,325 KB to 419 KB (-68%)
2. **Lazy-load recharts** — 414 KB only fetched when user visits
   the dashboard overview
3. **Batch IndexedDB writes** — sync time drops from ~10s to ~200ms
   per 1000-row table (-98%)
4. **Don't block dashboard on slowest table** — renders as soon as
   the first table arrives, with per-widget skeletons
5. **Extend cache TTL** from 5 min to 30 min — 83% fewer re-pulls

**No database migrations. No RLS changes. No breaking changes.**

## Files in this package

```
perf-branch/
├── README.md                                              ← this file
├── docs/
│   ├── 01_BASELINE_BUILD_SIZES.txt                        ← before measurements
│   ├── 02_AUDIT_AND_PLAN.md                              ← full audit + plan
│   └── 03_PERFORMANCE_REPORT.md                          ← after measurements + report
├── lib/
│   ├── useOfflineTable.js                                ← batch writes
│   └── useTableCache.js                                  ← TTL extended
├── components/dashboard/
│   ├── DashboardOverview.jsx                              ← unchanged (already uses Skeleton)
│   └── hospital/
│       └── useHospitalDashboard.js                        ← per-table loading states
└── pages/dashboard/
    └── Dashboard.jsx                                      ← lazy-load all pages
```

## How to apply (3 steps)

### Step 1 — Backup your existing files

```bash
cd GOODIE-MEDHUB-V2-main

cp src/pages/dashboard/Dashboard.jsx \
   src/pages/dashboard/Dashboard.backup.jsx

cp src/lib/useOfflineTable.js \
   src/lib/useOfflineTable.backup.js

cp src/lib/useTableCache.js \
   src/lib/useTableCache.backup.js

cp src/components/dashboard/hospital/useHospitalDashboard.js \
   src/components/dashboard/hospital/useHospitalDashboard.backup.js
```

### Step 2 — Copy the patched files

```bash
# From this package:
cp lib/useOfflineTable.js                GOODIE-MEDHUB-V2-main/src/lib/
cp lib/useTableCache.js                  GOODIE-MEDHUB-V2-main/src/lib/
cp components/dashboard/hospital/useHospitalDashboard.js \
   GOODIE-MEDHUB-V2-main/src/components/dashboard/hospital/
cp pages/dashboard/Dashboard.jsx         GOODIE-MEDHUB-V2-main/src/pages/dashboard/
```

### Step 3 — Build and verify

```bash
cd GOODIE-MEDHUB-V2-main
npm run build
```

You should see the main `index-*.js` drop from ~1,325 KB to ~419 KB.

## Verification

After applying the changes:

1. **Build succeeds** — `npm run build` completes with no errors
2. **Main bundle is smaller** — check `dist/assets/index-*.js` is ~419 KB (was 1,325 KB)
3. **Pages are lazy-loaded** — check `dist/assets/` has 26+ page chunks (Billing-*.js, Pharmacy-*.js, etc.)
4. **App loads faster** — initial page render should be visibly faster
5. **Dashboard renders progressively** — widgets appear one-by-one instead of all-at-once-after-7-minutes
6. **All existing functionality preserved** — login, patient registration, billing, pharmacy, lab, etc. all work

## What changed (technical summary)

### `Dashboard.jsx` — lazy-load all pages

```js
// BEFORE: 26 eager imports (all bundled into main chunk)
import Billing from './Billing'
import Pharmacy from './Pharmacy'
// ... 24 more

// AFTER: 26 lazy imports (each in its own chunk)
const Billing  = lazy(() => import('./Billing'))
const Pharmacy = lazy(() => import('./Pharmacy'))
// ... 24 more

// Wrap tab content in Suspense
<Suspense fallback={<div>Loading…</div>}>
  {tab === 'billing' && <Billing />}
  {/* ... */}
</Suspense>
```

Also lazy-loaded `DashboardOverview` (which imports recharts) — this
alone removed 414 KB from the main bundle.

### `useOfflineTable.js` — batch IndexedDB writes

```js
// BEFORE: 1000 sequential transactions
for (const remote of remoteRows) {
  await putLocalRecord(db, { ...remote, ... })
}

// AFTER: 1 batched transaction
const batch = remoteRows.map(remote => ({ ...remote, ... }))
await putLocalRecordsBatch(db, batch)
```

New `putLocalRecordsBatch` function writes all records in a single
IndexedDB transaction. Atomic — if any put fails, the entire
transaction rolls back. `notifyLocalChange()` called once instead of
1000 times, reducing re-render storms.

### `useTableCache.js` — extend cache TTL

```js
// BEFORE: re-pull every 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000

// AFTER: re-pull every 30 minutes (realtime still pushes instantly)
const CACHE_TTL_MS = 30 * 60 * 1000
```

### `useHospitalDashboard.js` — don't block on slowest table

```js
// BEFORE: waits for ALL 11 tables
const loading = all.some(t => t.loading)

// AFTER: renders as soon as first table arrives + per-table loading states
const loadingByTable = {
  patients: pts.loading,
  appointments: appts.loading,
  // ... 9 more
}
const loading = all.every(t => t.loading) // only blocks if NOTHING loaded yet
```

## Performance results

| Metric | Before | After | Improvement |
|---|---|---|---|
| Main bundle size | 1,325 KB | 419 KB | **-68%** |
| Main bundle (gzip) | 325 KB | 119 KB | **-63%** |
| Initial JS download | ~2,200 KB | ~840 KB | **-62%** |
| IndexedDB write time (1000 rows) | ~10s | ~200ms | **-98%** |
| Cache re-pull frequency | every 5 min | every 30 min | **-83%** |
| Dashboard render blocking | waits for all 11 tables | renders as first table arrives | **major** |

## What's NOT changed (for safety)

- ❌ No database migrations applied (require separate approval)
- ❌ No RLS policy changes
- ❌ No `useOfflineTable` architecture rewrite (only added batch writes)
- ❌ No `select('*')` → column projection (too risky without full audit)
- ❌ No incremental sync via `updated_at` (requires schema audit)
- ❌ No server-side aggregation RPCs (require DB migration)
- ❌ No changes to AuthContext, permissions, subscriptionLock
- ❌ No changes to existing page components (Billing, Pharmacy, etc.)

## Recommended next steps (require separate approval)

These are documented in `docs/02_AUDIT_AND_PLAN.md` but NOT applied:

1. **Server-side aggregation RPC** — `get_dashboard_summary(hospital_id, days)`
   Drops dashboard network payload by ~99%.

2. **Missing FK indexes** — `invoices(patient_id)`, `lab_orders(patient_id)`,
   `patient_vitals(patient_id)`. Speeds up joins and RLS evaluation.

3. **Incremental sync via `updated_at`** — fetch only changed records.
   Requires schema audit + `sync_cursor` table.

4. **Column projection** — `select('col1,col2')` instead of `select('*')`.
   Requires auditing every `.from(table).select()` call.

5. **IndexedDB index usage** — use `store.index('table_name').getAll(tableName)`
   instead of `getAll()` + JS filter. Faster reads for large stores.

## If something breaks

**Most likely issue:** A page component doesn't have a default export.
`React.lazy()` requires default exports. Check:

```bash
grep -L "export default" GOODIE-MEDHUB-V2-main/src/pages/dashboard/*.jsx
```

If any of them DON'T have `export default`, either:
- Add `export default` to that component, OR
- Change the matching `lazy()` import in `Dashboard.jsx` to extract
  the named export:
  ```js
  const Billing = lazy(() =>
    import('./Billing').then(m => ({ default: m.Billing }))
  );
  ```

**Second most likely:** Build cache. Run:
```bash
rm -rf node_modules/.vite dist
npm run build
```

**If all else fails:** Restore from backup:
```bash
cp src/pages/dashboard/Dashboard.backup.jsx src/pages/dashboard/Dashboard.jsx
cp src/lib/useOfflineTable.backup.js src/lib/useOfflineTable.js
cp src/lib/useTableCache.backup.js src/lib/useTableCache.js
cp src/components/dashboard/hospital/useHospitalDashboard.backup.js \
   src/components/dashboard/hospital/useHospitalDashboard.js
```

## Full documentation

- `docs/01_BASELINE_BUILD_SIZES.txt` — before measurements
- `docs/02_AUDIT_AND_PLAN.md` — full audit + implementation plan
- `docs/03_PERFORMANCE_REPORT.md` — after measurements + complete report
