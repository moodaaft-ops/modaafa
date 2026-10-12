-- user_events: one row per step a person takes on the way from sign-up to paying.
--
-- The seven event names and the table name are a contract shared by several
-- agents (welcome screen, first-login email, connect flow, first analysis,
-- billing), so the CHECK below lists all seven even though the welcome screen
-- itself only writes onboarding_viewed and connect_clicked.
--
-- Server-only table, same pattern as free_audit_ledger: RLS on, no policies,
-- every privilege revoked from public, anon and authenticated. Only the
-- service role reads and writes, through lib/events/user-events.ts. A browser
-- can never insert a fake event for itself or read anyone else's.
--
-- onboarding_viewed is "first time only". That rule lives here as a partial
-- unique index instead of in application code, so two tabs opened together
-- cannot both log it.
--
-- NOT applied to production by the PR that adds it. Additive only: no existing
-- table is touched. If another branch already created public.user_events, the
-- "if not exists" guards make this file a no-op for the table and only add the
-- index.

begin;

create table if not exists public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event text not null check (
    event in (
      'registration_completed',
      'welcome_email_sent',
      'onboarding_viewed',
      'connect_clicked',
      'ads_account_connected',
      'first_analysis_viewed',
      'subscription_paid'
    )
  ),
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_events_user_event_idx
  on public.user_events (user_id, event, created_at desc);

create index if not exists user_events_event_created_idx
  on public.user_events (event, created_at desc);

create unique index if not exists user_events_onboarding_viewed_once
  on public.user_events (user_id)
  where event = 'onboarding_viewed';

alter table public.user_events enable row level security;
revoke all on table public.user_events from public, anon, authenticated, service_role;
grant select, insert on table public.user_events to service_role;

commit;
