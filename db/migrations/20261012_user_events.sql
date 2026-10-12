-- user_events: one row per step a person takes on the way from sign-up to paying.
--
-- The seven event names, the four stage names and the table shape are a
-- contract shared by several agents (welcome email, welcome screen, connect
-- flow, first analysis, billing). The table definition below is IDENTICAL to
-- the one in db/migrations/20261012_welcome_email.sql (PR #81): same columns
-- (stage, metadata), same foreign key (public.users), same index names. So it
-- does not matter which of the two files is run first: the second one finds the
-- table and does nothing to it. The welcome screen itself writes only
-- onboarding_viewed and connect_clicked, always with stage 'registered'.
--
-- Server-only table: RLS on, no policies, every privilege revoked from public,
-- anon, authenticated and service_role, then select and insert granted back to
-- service_role. A browser can never insert a fake event or read anyone else's.
--
-- onboarding_viewed is "first time only". That rule lives here as a partial
-- unique index instead of in application code, so two tabs opened together
-- cannot both log it.
--
-- NOT applied to production by the PR that adds it. Additive only: no existing
-- table is touched.

begin;

create table if not exists public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  event text not null check (event in (
    'registration_completed',
    'welcome_email_sent',
    'onboarding_viewed',
    'connect_clicked',
    'ads_account_connected',
    'first_analysis_viewed',
    'subscription_paid'
  )),
  -- Funnel stage the user was in when the event happened.
  stage text not null default 'registered' check (stage in (
    'registered', 'connected', 'analysis_viewed', 'subscribed'
  )),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_events_user_idx on public.user_events (user_id, created_at desc);
create index if not exists user_events_event_idx on public.user_events (event, created_at desc);

create unique index if not exists user_events_onboarding_viewed_once
  on public.user_events (user_id)
  where event = 'onboarding_viewed';

alter table public.user_events enable row level security;
revoke all on table public.user_events from public, anon, authenticated, service_role;
grant select, insert on table public.user_events to service_role;

commit;

-- Verification (run manually after applying):
--   select indexname from pg_indexes where tablename = 'user_events';
--   select event, count(*) from public.user_events group by 1;
