-- =============================================================================
-- 2026-10-20 - الحارس الصباحي: guard_findings
--
-- The morning guard (lib/guard, /api/cron/guard) is a rules-only daily check of
-- every connected Google Ads account. Each thing it finds is one row here.
--
--   dedupe_key   same key on the same account = same alert. A row is OPEN while
--                the guard keeps seeing it, RESOLVED once a run that could read
--                its source no longer does, and REOPENED (and told again) if it
--                comes back. Sent once: notified_at.
--   escalation   'human' = suspension, billing or policy. A person handles it
--                (the agency, on WhatsApp); the platform never acts on it.
--   cause        the rule-based root cause (lib/guard/diagnose.ts), json.
--
-- Also adds google_ads_accounts.guard_checked_at: when the guard last finished
-- an account, so the scheduler's second slot of the day skips what is done.
--
-- Owners may READ their own rows (the home page lists the open ones). Writes
-- happen only through the service role, from the cron.
--
-- NOT applied to production by this change. Idempotent: safe to run twice. One
-- transaction. The application tolerates it not being applied: the feature
-- ships off (GUARD_ENABLED).
-- =============================================================================

begin;

alter table public.google_ads_accounts
  add column if not exists guard_checked_at timestamptz;

create table if not exists public.guard_findings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.google_ads_accounts(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  code text not null
    check (code in (
      'account_status', 'billing_setup', 'billing_budget', 'spend_zero', 'spend_spike',
      'cpa_spike', 'conversions_zero', 'ad_policy', 'outside_change'
    )),
  severity text not null check (severity in ('critical', 'high', 'medium', 'info')),
  entity_type text not null check (entity_type in ('account', 'campaign', 'ad_group_ads', 'change')),
  entity_id text not null,
  entity_name text,
  dedupe_key text not null,
  what_ar text not null,
  step_ar text not null,
  evidence jsonb not null default '{}'::jsonb,
  cause jsonb,
  escalation text not null default 'none' check (escalation in ('none', 'human')),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1,
  notified_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, dedupe_key)
);

-- The home page and Jarvis read the open findings of one account.
create index if not exists guard_findings_open_idx
  on public.guard_findings (account_id, severity, first_seen_at desc)
  where status = 'open';

create index if not exists guard_findings_business_idx
  on public.guard_findings (business_id, status);

alter table public.guard_findings enable row level security;
revoke all on table public.guard_findings from public, anon, authenticated, service_role;
grant select on table public.guard_findings to authenticated;
grant select, insert, update on table public.guard_findings to service_role;

drop policy if exists guard_findings_owner_read on public.guard_findings;
create policy guard_findings_owner_read
  on public.guard_findings
  for select
  to authenticated
  using (
    account_id in (
      select id from public.google_ads_accounts
      where business_id in (select id from public.businesses where user_id = (select auth.uid()))
    )
  );

commit;
