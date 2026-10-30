# GOODIE-MEDHUB — Phase 2: Hardcoded Cleanup

## What this patch does

Moves the hardcoded HMO providers list from `src/lib/hmoProviders.js` into a proper database table (`hmo_providers`) so hospitals can manage their own list. Keeps the hardcoded list as a fallback for offline-first availability + backward compatibility.

Also removes a leftover dead-code `HMO_PROVIDERS` constant from `Reception.jsx` (only 8 entries — was replaced by the `HmoProviderSelect` component long ago but the constant was never deleted).

## Files in this patch (5)

### New files (2)
| File | Purpose |
|------|---------|
| `supabase/migrations/065_hmo_providers_table.sql` | Creates `hmo_providers` table with RLS + seeds 30 default HMOs. System entries (hospital_id IS NULL, is_system=true) are visible to all hospitals. |
| `src/lib/useHmoProviders.js` | New hook: reads from `hmo_providers` table via `useOfflineTable`. Falls back to the hardcoded `HMO_PROVIDERS` constant from `hmoProviders.js` when the DB hasn't loaded yet or migration 065 hasn't been run. Merges both lists (dedupes by name). |

### Modified files (3)
| File | What changed |
|------|--------------|
| `src/components/common/HmoProviderSelect.jsx` | Replaced `import { HMO_PROVIDERS } from '../../lib/hmoProviders'` with `import { useHmoProviders } from '../../lib/useHmoProviders'`. Added `hospitalId` prop. Uses the hook to get the DB-backed provider list with fallback. |
| `src/pages/dashboard/Reception.jsx` | Removed dead-code `const HMO_PROVIDERS = [...]` (line 86, 8 entries — leftover from before HmoProviderSelect was added). Added `hospitalId={hospital?.id}` prop to `<HmoProviderSelect>`. |
| `src/pages/dashboard/Insurance.jsx` | Added `hospitalId={hospital?.id}` prop to `<HmoProviderSelect>`. |

### Unchanged (kept for backward compatibility)
| File | Why it's kept |
|------|---------------|
| `src/lib/hmoProviders.js` | Used as the fallback by `useHmoProviders` when the DB hasn't loaded or migration 065 hasn't been run. Also exports `HMO_PROVIDER_BY_ID`, `findProviderByName()`, `HMO_PROVIDER_NAMES` for any code that still imports them directly. |

## How it works

### The `useHmoProviders` hook

```js
const { providers, loading, isFromDb } = useHmoProviders(hospital?.id)
```

1. Reads from `hmo_providers` table via `useOfflineTable` (offline-first — works even when offline)
2. If the DB has active entries → merges them with any hardcoded entries not in the DB (backward compat)
3. If the DB is empty (migration 065 not run yet) → falls back to the hardcoded `HMO_PROVIDERS` constant
4. Sorts by `sort_order` (Self-Pay first=0, Other last=999, everything else=500)
5. Returns `{ providers, loading, isFromDb }` — `providers` is always an array

### The `hmo_providers` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | |
| `hospital_id` | uuid FK → hospitals | NULL = system-wide entry (visible to all hospitals) |
| `slug` | text | Stable identifier (e.g. 'nhis', 'hygeia') |
| `name` | text | Display name (what the dropdown shows) |
| `type` | text | 'public' or 'private' |
| `is_system` | boolean | true = seeded default (can't be hard-deleted, only deactivated) |
| `is_active` | boolean | false = hidden from the dropdown |
| `sort_order` | integer | Controls display order (0=first, 999=last) |

**Unique constraint:** `(hospital_id, slug)` — one entry per slug per hospital. System entries use `hospital_id IS NULL`.

### RLS policies on `hmo_providers`

| Operation | Who |
|-----------|-----|
| SELECT | Any hospital member (sees system entries + their hospital's custom entries) |
| INSERT | Admin/owner (can add hospital-specific entries) |
| UPDATE | Admin/owner (can rename/deactivate entries — including system entries) |
| DELETE | Admin/owner, but ONLY hospital-specific entries (`is_system = false`) — system entries can't be hard-deleted |

### Backward compatibility

- **Existing patient records** that store `hmo_provider` as a display name string (e.g. "Hygeia HMO") are NOT migrated — they keep working because `HmoProviderSelect` matches by name, not by id.
- **The `hmoProviders.js` file** is kept as the fallback. If a hospital hasn't run migration 065, the app still works with the full 30-provider list.
- **The `useOfflineTable` pattern** is preserved — the hook reads from IndexedDB first, then syncs from Supabase. No changes to the offline-first architecture.

## Build verification
- ✅ `npx vite build` succeeds — 2814 modules, 6.82s, zero warnings
- ✅ No new dependencies added

## Apply steps

1. **Run migration 065** in Supabase SQL Editor:
   ```sql
   \i supabase/migrations/065_hmo_providers_table.sql
   ```
   Or paste the file contents and click Run. This creates the table + seeds 30 HMOs.

2. **Copy the 4 source files** over your existing ones:
   ```bash
   cp src/lib/useHmoProviders.js                    <project>/src/lib/
   cp src/components/common/HmoProviderSelect.jsx   <project>/src/components/common/
   cp src/pages/dashboard/Reception.jsx             <project>/src/pages/dashboard/
   cp src/pages/dashboard/Insurance.jsx             <project>/src/pages/dashboard/
   ```

3. Commit + push to GitHub → Vercel auto-deploys

4. **Verify:**
   - Open Reception → register an HMO patient → the HMO provider dropdown should show all 30 providers (same as before)
   - Open Insurance → New Claim → the provider dropdown should show all providers except "Self-Pay"
   - In Supabase → Table Editor → `hmo_providers` → you should see 30 system entries
   - The dropdown still works even before the DB loads (uses the hardcoded fallback)

## What's NOT changed
- ✅ `hmoProviders.js` still exists — used as the fallback by `useHmoProviders`
- ✅ `HMO_PROVIDER_BY_ID`, `findProviderByName()`, `HMO_PROVIDER_NAMES` still exported from `hmoProviders.js`
- ✅ Offline-first behavior — `useOfflineTable` pattern preserved
- ✅ All existing patient records — `hmo_provider` column on `patients` unchanged
- ✅ `hmo_contracts` table — separate from this (hospital-specific HMO contract configurations)

## Future work (not in this patch)
- Add a Settings UI for hospital admins to manage their own HMO providers (add custom entries, rename, deactivate)
- Add the `hmo_providers` table to the Settings page alongside `hmo_contracts`
- Eventually deprecate `hmoProviders.js` once all hospitals have run migration 065 (remove the fallback)
