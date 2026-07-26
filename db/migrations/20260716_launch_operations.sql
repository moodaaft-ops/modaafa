-- Usage metering and background-job observability for launch.

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  account_id uuid references public.google_ads_accounts (id) on delete set null,
  feature text not null check (feature in ('assistant', 'campaign_builder', 'audit', 'manual_sync', 'execute_action')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_feature_created_idx
  on public.usage_events (user_id, feature, created_at desc);

create index if not exists usage_events_account_created_idx
  on public.usage_events (account_id, created_at desc);

alter table public.usage_events enable row level security;

drop policy if exists usage_events_owner_select on public.usage_events;
create policy usage_events_owner_select on public.usage_events
  for select using (user_id = auth.uid());

drop policy if exists usage_events_owner_insert on public.usage_events;
create policy usage_events_owner_insert on public.usage_events
  for insert with check (user_id = auth.uid());

create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  processed integer not null default 0,
  error_count integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  error_message text
);

create index if not exists job_runs_name_started_idx
  on public.job_runs (job_name, started_at desc);

-- Scheduled jobs use the service role. Keep browser clients out of this table.
alter table public.job_runs enable row level security;

create table if not exists public.processed_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

-- Webhook handlers use the service role. Browser clients need no policy.
alter table public.processed_webhook_events enable row level security;
