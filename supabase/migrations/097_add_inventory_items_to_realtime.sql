-- =====================================================================
-- GOODIE-MEDHUB / ELGOODIE-SaaS — add inventory_items to realtime
--
-- SYMPTOM
--   Drugs added in the Inventory page don't appear in the Pharmacy page
--   until the user does a full browser refresh.
--
-- ROOT CAUSE
--   Pharmacy.jsx reads inventory_items via useLazyTable (line 33), which
--   caches the records after the first fetch. Migration 095 added 13
--   tables to supabase_realtime but inventory_items was not on the
--   list — so Postgres never broadcast INSERT/UPDATE events for it.
--   When Inventory.jsx adds a new drug, the Pharmacy page's cached
--   copy stays stale until the next hard refresh.
--
--   (Confirmed: 141 'Drug' items exist in inventory, so the
--    category === 'drug' filter at Pharmacy.jsx:71 is NOT the cause.
--    It's purely a Realtime subscription gap.)
--
-- WHAT THIS MIGRATION DOES
--   1. Sets REPLICA IDENTITY FULL so UPDATE events include the full
--      row (needed for the { realtime: true } path in useOfflineTable,
--      which reads patient_id / category / etc. from the payload).
--   2. Adds inventory_items to the supabase_realtime publication.
--
-- SAFE TO RE-RUN. Idempotent.
-- =====================================================================

-- 1. Replica identity full (so UPDATE payloads carry the whole row).
--    Wrapped in DO because the table should exist (Inventory writes
--    to it), but a guard is cheap insurance.
do $$
begin
  if to_regclass('public.inventory_items') is not null then
    execute 'alter table public.inventory_items replica identity full';
  else
    raise notice 'Skipping — public.inventory_items does not exist';
  end if;
end $$;

-- 2. Add to the realtime publication if not already there.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'inventory_items'
  ) then
    alter publication supabase_realtime add table public.inventory_items;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VERIFY (run in the Supabase SQL editor after applying):
--
--   -- Should return 1 row.
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime'
--      and schemaname = 'public'
--      and tablename = 'inventory_items';
--
--   -- Should return relreplident = 'f' (FULL).
--   select relname, relreplident
--     from pg_class
--    where relname = 'inventory_items' and relkind = 'r';
--
-- AFTER APPLYING:
--   1. Add a new drug in the Inventory page.
--   2. Open the Pharmacy page in another tab (or just switch tabs) —
--      the new drug should appear WITHOUT a refresh.
--   3. If the app already had Pharmacy open, you may need ONE refresh
--      to establish the realtime subscription; subsequent writes
--      will stream live.
-- ---------------------------------------------------------------------
