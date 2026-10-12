-- Registration before value (12 Oct 2026).
--
-- A visitor now registers with name, email and phone before reaching the
-- platform. This migration adds what that needs:
--   * users.phone_normalized (E.164, unique) so a phone number cannot register twice
--   * users.registered_at   NULL means "has not completed registration yet"
--   * users.stage           funnel stage, first value 'registered'
--   * users.registration_source  UTM / ttclid / gclid captured at signup
--   * user_events           the shared event log (names are fixed across agents)
--   * finalize_registration the one atomic function that completes a registration
--
-- Existing users are grandfathered exactly once: registered_at is back-filled
-- to created_at when the column is first added, so nobody already using the
-- platform is sent through the form. Their stage stays NULL; the funnel/stage
-- work owns back-filling it.
--
-- Idempotent and additive. Nothing is applied to production by this PR.

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'registered_at'
  ) then
    alter table public.users add column registered_at timestamptz;
    update public.users set registered_at = coalesce(created_at, now());
  end if;
end $$;

alter table public.users
  add column if not exists phone_normalized text,
  add column if not exists stage text,
  add column if not exists registration_source jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_stage_check') then
    alter table public.users add constraint users_stage_check
      check (stage is null or stage in ('registered', 'connected', 'analysis_viewed', 'subscribed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_phone_normalized_check') then
    alter table public.users add constraint users_phone_normalized_check
      check (phone_normalized is null or phone_normalized ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;

-- The real backstop for "same phone, two accounts". Two requests racing on the
-- same number cannot both win; the loser gets unique_violation.
create unique index if not exists users_phone_normalized_key
  on public.users (phone_normalized) where phone_normalized is not null;

-- ---------------------------------------------------------------------------
-- user_events: one row per funnel event. The name list is a contract shared by
-- every agent working on the funnel, so a typo is rejected here instead of
-- silently creating a new event nobody reads.
-- ---------------------------------------------------------------------------
-- Shape and index names match the welcome-email migration (20261012_welcome_email.sql)
-- on purpose: both files say "create ... if not exists", so they can be applied
-- in either order and end up with one table that serves both.
create table if not exists public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  event text not null check (event in (
    'registration_completed', 'welcome_email_sent', 'onboarding_viewed',
    'connect_clicked', 'ads_account_connected', 'first_analysis_viewed',
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

-- Server-only: RLS on, no policies. Supabase default privileges open new
-- objects to anon/authenticated/service_role, so close everything first and
-- grant back the minimum. Same grant as the welcome-email file, so the order
-- the two are applied in does not change who can do what. Writes that need more
-- than insert go through the security-definer functions below.
alter table public.user_events enable row level security;
revoke all on table public.user_events from public, anon, authenticated, service_role;
grant select, insert on table public.user_events to service_role;

-- ---------------------------------------------------------------------------
-- finalize_registration: complete a registration atomically.
--   completed   first time: user updated, stage set, event written
--   already     registered earlier: nothing changes (idempotent)
--   phone_taken another account owns this phone: nothing changes
--   no_user     unknown user id
-- The caller supplies already-validated values; the phone uniqueness is
-- enforced by the unique index, not by a prior SELECT, so races are safe.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_registration(
  p_user_id uuid,
  p_name text,
  p_phone_normalized text,
  p_attribution jsonb,
  p_event_id text
)
returns table (result_status text, result_registered_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_registered timestamptz;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    return query select 'no_user'::text, null::timestamptz;
    return;
  end if;

  select u.registered_at into v_registered from public.users u where u.id = p_user_id;
  if v_registered is not null then
    return query select 'already'::text, v_registered;
    return;
  end if;

  begin
    update public.users u
       set name = coalesce(nullif(btrim(p_name), ''), u.name),
           phone = p_phone_normalized,
           phone_normalized = p_phone_normalized,
           registered_at = now(),
           stage = 'registered',
           registration_source = coalesce(p_attribution, '{}'::jsonb),
           updated_at = now()
     where u.id = p_user_id
    returning u.registered_at into v_registered;
  exception when unique_violation then
    return query select 'phone_taken'::text, null::timestamptz;
    return;
  end;

  -- The welcome-email trigger may already have written this row when the address
  -- was confirmed. Keep that row and add the attribution to it.
  insert into public.user_events (user_id, event, stage, metadata)
  values (
    p_user_id, 'registration_completed', 'registered',
    jsonb_build_object('event_id', p_event_id, 'attribution', coalesce(p_attribution, '{}'::jsonb))
  )
  on conflict (user_id, event) where event in ('registration_completed', 'welcome_email_sent')
  do update set metadata = public.user_events.metadata || excluded.metadata;

  return query select 'completed'::text, v_registered;
end;
$$;

revoke all on function public.finalize_registration(uuid, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_registration(uuid, text, text, jsonb, text) to service_role;

-- Leaves a trace of what TikTok answered on the event row, so "did TikTok get
-- it?" is answerable from SQL.
create or replace function public.record_registration_tiktok(p_user_id uuid, p_outcome jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.user_events
     set metadata = metadata || jsonb_build_object('tiktok_server', coalesce(p_outcome, '{}'::jsonb))
   where user_id = p_user_id and event = 'registration_completed';
$$;

revoke all on function public.record_registration_tiktok(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_registration_tiktok(uuid, jsonb) to service_role;

-- Early, advisory phone check for the form (the unique index stays the judge).
create or replace function public.registration_phone_taken(p_phone_normalized text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users where phone_normalized = p_phone_normalized);
$$;

revoke all on function public.registration_phone_taken(text) from public, anon, authenticated, service_role;
grant execute on function public.registration_phone_taken(text) to service_role;

commit;
