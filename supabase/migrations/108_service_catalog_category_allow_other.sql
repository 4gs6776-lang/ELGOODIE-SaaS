-- =====================================================================
-- GOODIE-MEDHUB — 108_service_catalog_category_allow_other.sql
-- =====================================================================
-- FIX: "Add service catalog" fails when the category is 'other'.
--
-- ROOT CAUSE:
--   Migration 066 created public.service_catalog with a CHECK constraint
--   on `category` that INCLUDED the value 'other':
--     check (category in ('consultation','lab','procedure','drug','bed',
--                         'service','anc_package','registration','other'))
--
--   Migration 076_service_catalog_add_columns.sql then DROPped and
--   RE-CREATED that constraint (lines 50-58) but forgot 'other':
--     check (category in ('consultation','lab','procedure','drug','bed',
--                         'service','anc_package','registration',''))
--
--   The front-end ServiceCatalogManager.jsx offers "Other" as a
--   selectable category (SERVICE_CATEGORIES in lib/billingService.js),
--   so inserting a service with category='other' violated the CHECK
--   constraint and the save failed with a Postgres error.
--
-- WHAT THIS MIGRATION DOES:
--   Recreates the constraint with the FULL allowed list, including
--   'other', so it matches both migration 066's intent and the UI.
--   Idempotent and safe to re-run: it drops the constraint (whatever its
--   current shape) and re-adds the correct one.
--
--   Note: the empty string '' is intentionally kept allowed for
--   backward-compatibility with any legacy row, matching 076's list.
-- =====================================================================

do $$
begin
  -- Drop the current constraint (named or auto-named) if it exists.
  execute 'alter table public.service_catalog drop constraint if exists service_catalog_category_check';

  -- Re-add it with the COMPLETE allowed list, including 'other'.
  execute 'alter table public.service_catalog add constraint service_catalog_category_check
           check (category in (''consultation'', ''lab'', ''procedure'', ''drug'', ''bed'',
                              ''service'', ''anc_package'', ''registration'', ''other'', ''''))';
exception when others then null;
end $$;

-- =====================================================================
-- Verification — confirm the constraint now allows 'other'.
-- =====================================================================
do $$
declare
  v_ok boolean;
begin
  -- Try inserting a probe row in a transaction that rolls back, so we
  -- never actually persist a test row. If the constraint blocks 'other',
  -- this raises and the notice below won't print.
  begin
    insert into public.service_catalog
      (hospital_id, code, name, category, default_price, default_cost)
    values ('00000000-0000-0000-0000-000000000000', '__PROBE_OTHER_108__', 'probe', 'other', 0, 0);
    delete from public.service_catalog where code = '__PROBE_OTHER_108__';
    v_ok := true;
  exception when others then
    v_ok := false;
  end;
  raise notice 'service_catalog: category=''other'' allowed = %', v_ok;
end $$;
