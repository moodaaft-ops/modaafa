-- Atomic usage metering and one-time trial records.

create table if not exists public.billing_trial_grants (
  user_id uuid primary key references public.users (id) on delete cascade,
  stripe_subscription_id text,
  source text not null check (source in ('checkout_complete', 'stripe_webhook')),
  granted_at timestamptz not null default now()
);

alter table public.billing_trial_grants enable row level security;

drop policy if exists billing_trial_grants_owner_select on public.billing_trial_grants;
create policy billing_trial_grants_owner_select on public.billing_trial_grants
  for select using (user_id = auth.uid());

create or replace function public.consume_feature_usage(
  p_user_id uuid,
  p_feature text,
  p_account_id uuid,
  p_limit integer,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns table (allowed boolean, used integer, event_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used integer;
  v_event_id uuid;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;
  if p_limit < 1 or p_window_end <= p_window_start then
    raise exception 'invalid usage window';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_feature || ':' || p_window_start::text, 0)
  );

  select count(*)::integer into v_used
  from public.usage_events
  where user_id = p_user_id
    and feature = p_feature
    and created_at >= p_window_start
    and created_at < p_window_end;

  if v_used >= p_limit then
    return query select false, v_used, null::uuid;
    return;
  end if;

  insert into public.usage_events (user_id, account_id, feature, metadata)
  values (p_user_id, p_account_id, p_feature, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_event_id;

  return query select true, v_used + 1, v_event_id;
end;
$$;

create or replace function public.refund_feature_usage(
  p_user_id uuid,
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted uuid;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;

  delete from public.usage_events
  where id = p_event_id and user_id = p_user_id
  returning id into v_deleted;

  return v_deleted is not null;
end;
$$;

revoke all on function public.consume_feature_usage(uuid, text, uuid, integer, timestamptz, timestamptz, jsonb) from public;
grant execute on function public.consume_feature_usage(uuid, text, uuid, integer, timestamptz, timestamptz, jsonb) to authenticated;
revoke all on function public.refund_feature_usage(uuid, uuid) from public;
grant execute on function public.refund_feature_usage(uuid, uuid) to authenticated;

alter table public.processed_webhook_events
  add column if not exists status text not null default 'completed',
  add column if not exists attempts integer not null default 1,
  add column if not exists last_attempt_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz,
  add column if not exists error_message text;

alter table public.processed_webhook_events
  drop constraint if exists processed_webhook_events_status_check;
alter table public.processed_webhook_events
  add constraint processed_webhook_events_status_check
  check (status in ('processing', 'completed', 'failed'));

update public.processed_webhook_events
set completed_at = coalesce(completed_at, processed_at)
where status = 'completed';
