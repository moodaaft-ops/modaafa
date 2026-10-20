-- =============================================================================
-- 2026-10-20 - guard_findings: allow the 'product_disapprovals' code
--
-- SHOPPING_HEALTH_ENABLED adds one morning-guard rule: a large share of the
-- Merchant Center feed is not eligible to show (lib/shopping/guard.ts). Its
-- findings are stored in guard_findings like every other, so the code check
-- must accept the new value. RLS and grants are unchanged (set by
-- 20261020_guard_findings.sql).
--
-- NOT applied to production by this change. Idempotent: safe to run twice. One
-- transaction. Requires 20261020_guard_findings.sql to have run. The
-- application tolerates it not being applied: with SHOPPING_HEALTH_ENABLED off
-- the new code is never written.
-- =============================================================================

begin;

do $$
declare
  existing text;
begin
  -- The original check was declared inline, so its name is generated: find every check on column "code".
  for existing in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'guard_findings'
      and c.contype = 'c'
      and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = t.oid and a.attname = 'code')]
      and c.conname <> 'guard_findings_code_allowed'
  loop
    execute format('alter table public.guard_findings drop constraint %I', existing);
  end loop;
end $$;

alter table public.guard_findings drop constraint if exists guard_findings_code_allowed;
alter table public.guard_findings
  add constraint guard_findings_code_allowed
  check (code in (
    'account_status', 'billing_setup', 'billing_budget', 'spend_zero', 'spend_spike',
    'cpa_spike', 'conversions_zero', 'ad_policy', 'outside_change', 'product_disapprovals'
  ));

commit;
