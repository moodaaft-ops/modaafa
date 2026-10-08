-- Free audits per Google Ads account (task 04: free audit, subscription on apply).
--
-- Every Google Ads customer id gets FREE_AUDITS_PER_ACCOUNT full audits (the
-- first run plus one retry) without a subscription. The ledger is keyed by the
-- Google customer id, NOT by google_ads_accounts.id or user id, so deleting the
-- account row, unlinking, relinking or switching the platform user cannot reset
-- the allowance. There is deliberately no foreign key to google_ads_accounts.
--
-- NOT applied to production by this PR. Review, then run through the normal
-- migration process. Additive only: no existing table, price, subscription,
-- trial or charge date is touched.

create table if not exists public.free_audit_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null check (customer_id ~ '^[0-9]{3,20}$'),
  user_id uuid not null,
  account_id uuid,
  status text not null default 'reserved' check (status in ('reserved', 'completed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists free_audit_ledger_customer_idx
  on public.free_audit_ledger (customer_id, created_at);

-- Server-only table: RLS on, no policies. Access goes through the functions below
-- and through the service role.
alter table public.free_audit_ledger enable row level security;
revoke all on public.free_audit_ledger from anon, authenticated;

-- Reserve one free audit. Serialised per customer id with an advisory lock so
-- concurrent requests cannot overshoot the limit. A second run is refused while
-- a first one is still in progress (reserved within the last p_inflight_seconds),
-- which also blocks retry spam; a stuck reservation stops blocking after that.
create or replace function public.consume_free_audit(
  p_user_id uuid,
  p_customer_id text,
  p_account_id uuid,
  p_limit integer,
  p_inflight_seconds integer default 600,
  p_metadata jsonb default '{}'::jsonb
)
returns table (allowed boolean, reason text, used integer, event_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used integer;
  v_inflight integer;
  v_event_id uuid;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;
  if p_limit < 1 or p_customer_id !~ '^[0-9]{3,20}$' then
    raise exception 'invalid free audit request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('free_audit:' || p_customer_id, 0));

  select count(*)::integer into v_used
  from public.free_audit_ledger
  where customer_id = p_customer_id;

  if v_used >= p_limit then
    return query select false, 'free_audits_exhausted'::text, v_used, null::uuid;
    return;
  end if;

  select count(*)::integer into v_inflight
  from public.free_audit_ledger
  where customer_id = p_customer_id
    and status = 'reserved'
    and created_at > now() - make_interval(secs => greatest(p_inflight_seconds, 1));

  if v_inflight > 0 then
    return query select false, 'audit_in_progress'::text, v_used, null::uuid;
    return;
  end if;

  insert into public.free_audit_ledger (customer_id, user_id, account_id, metadata)
  values (p_customer_id, p_user_id, p_account_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_event_id;

  return query select true, null::text, v_used + 1, v_event_id;
end;
$$;

-- Mark a reservation as a finished audit (it keeps counting against the limit).
create or replace function public.complete_free_audit(p_user_id uuid, p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;
  update public.free_audit_ledger
  set status = 'completed', completed_at = now()
  where id = p_event_id and user_id = p_user_id and status = 'reserved'
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- Give the allowance back when the audit itself failed (our fault, not the
-- customer's). Server-owned: only the service role may call it, so a browser
-- session can never delete its own ledger rows.
create or replace function public.refund_free_audit(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  delete from public.free_audit_ledger
  where id = p_event_id and status = 'reserved'
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.consume_free_audit(uuid, text, uuid, integer, integer, jsonb) from public;
grant execute on function public.consume_free_audit(uuid, text, uuid, integer, integer, jsonb) to authenticated;
revoke all on function public.complete_free_audit(uuid, uuid) from public;
grant execute on function public.complete_free_audit(uuid, uuid) to authenticated;
revoke all on function public.refund_free_audit(uuid) from public, anon, authenticated;
grant execute on function public.refund_free_audit(uuid) to service_role;
