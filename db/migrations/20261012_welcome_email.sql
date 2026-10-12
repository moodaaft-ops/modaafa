-- Immediate follow-up email after sign-up (welcome_ads_connect) - 2026-10-12
--
-- Adds the tracking tables and the opt-out flag the email needs:
--   * public.user_events   one row per funnel event (shared names across agents)
--   * public.message_log   one row per message attempt, unique per
--                          (user, channel, template) so nobody gets it twice
--   * public.users.messages_opt_out   set by the unsubscribe link
--   * trigger on auth.users   writes registration_completed the moment an
--                          address is confirmed (email link or Google sign-in)
--   * public.claim_message()  atomic "may I send this?" check used by the app
--
-- Existing users are NOT back-filled: only sign-ups after this file runs get a
-- registration_completed event, so nobody already registered receives a
-- "welcome" mail.
--
-- Privileges follow 20261009_free_audit_quota.sql: everything is revoked from
-- PUBLIC, anon, authenticated and service_role first, then the minimum is
-- granted back. Both tables are readable only by service_role.
--
-- NOT applied to production by this PR. Additive only. One transaction.

begin;

-- 1. Opt-out flag ---------------------------------------------------------
alter table public.users
  add column if not exists messages_opt_out boolean not null default false,
  add column if not exists messages_opt_out_at timestamptz;

-- 2. user_events ----------------------------------------------------------
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

-- These two happen exactly once per user; a duplicate insert is a no-op.
create unique index if not exists user_events_once_per_user
  on public.user_events (user_id, event)
  where event in ('registration_completed', 'welcome_email_sent');

-- 3. message_log ----------------------------------------------------------
create table if not exists public.message_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp')),
  template text not null,
  -- sending: claimed, provider call in flight. sent: provider accepted.
  -- failed: provider refused or threw, may retry (see attempts).
  -- skipped: deliberately not sent (opted out, already connected).
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 1,
  provider_id text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint message_log_once unique (user_id, channel, template)
);

create index if not exists message_log_status_idx on public.message_log (status, updated_at);

-- 4. claim_message --------------------------------------------------------
-- Returns true only for the caller that wins the right to send. A row is
-- (re)claimed when it is brand new, when a previous attempt failed with fewer
-- than 3 attempts, or when a 'sending' claim is older than 10 minutes (the
-- process died between claiming and recording the outcome).
create or replace function public.claim_message(
  p_user_id uuid,
  p_channel text,
  p_template text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.message_log (user_id, channel, template)
  values (p_user_id, p_channel, p_template)
  on conflict on constraint message_log_once do update
    set status = 'sending',
        attempts = public.message_log.attempts + 1,
        updated_at = now()
    where (public.message_log.status = 'failed' and public.message_log.attempts < 3)
       or (public.message_log.status = 'sending'
           and public.message_log.updated_at < now() - interval '10 minutes'
           and public.message_log.attempts < 3)
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- 5. registration_completed trigger --------------------------------------
-- Fires when an auth user is created already confirmed (Google) or when the
-- address is confirmed later (email link). Never blocks sign-up: any error is
-- downgraded to a warning. Trigger name sorts after on_auth_user_created so the
-- public.users row already exists.
create or replace function public.record_registration_completed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email_confirmed_at is not null
     and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    insert into public.user_events (user_id, event, stage)
    select new.id, 'registration_completed', 'registered'
    where exists (select 1 from public.users u where u.id = new.id)
    on conflict do nothing;
  end if;
  return new;
exception when others then
  raise warning 'record_registration_completed failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_auth_user_registered on auth.users;
create trigger on_auth_user_registered
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.record_registration_completed();

-- 6. Privileges -----------------------------------------------------------
alter table public.user_events enable row level security;
alter table public.message_log enable row level security;

revoke all on table public.user_events from public, anon, authenticated, service_role;
revoke all on table public.message_log from public, anon, authenticated, service_role;
grant select, insert on table public.user_events to service_role;
grant select, insert, update on table public.message_log to service_role;

revoke all on function public.claim_message(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_message(uuid, text, text) to service_role;
revoke all on function public.record_registration_completed() from public, anon, authenticated, service_role;

commit;

-- Verification (run manually after applying):
--   select tgname from pg_trigger where tgname = 'on_auth_user_registered';
--   select count(*) from public.user_events;   -- 0 until the next sign-up
