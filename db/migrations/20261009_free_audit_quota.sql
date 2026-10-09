-- Free audits per Google Ads account (task 04: free audit, subscription on apply).
--
-- Every Google customer id gets 2 full audits (the first run plus one retry)
-- without a subscription. The ledger is keyed by the Google customer id, NOT by
-- google_ads_accounts.id or user id, so deleting the account row, unlinking,
-- relinking or switching the platform user cannot reset the allowance. There is
-- deliberately no foreign key to google_ads_accounts.
--
-- Hardening (review of PR #57): the caller supplies NOTHING but the account id.
-- The customer id is read inside SQL from an account the caller owns
-- (google_ads_accounts -> businesses.user_id = auth.uid()), and the limit (2)
-- and the lease (15 minutes, longer than the 300s audit maxDuration) are
-- constants in the function bodies, not parameters. No RLS or grant is widened:
-- the table stays unreadable to anon and authenticated.
--
-- Privileges (Supabase default privileges): on Supabase, objects created by the
-- migration role in schema public get ALL for anon, authenticated and
-- service_role through ALTER DEFAULT PRIVILEGES, and functions get EXECUTE for
-- PUBLIC by Postgres default. So this file never relies on "grant only what is
-- needed": it first REVOKES everything from PUBLIC, anon, authenticated and
-- service_role on every object it creates, then grants back the minimum.
-- Required minimum: service_role reads the ledger (SELECT, for the allowance
-- shown on the audit page) and runs complete/refund; authenticated runs only
-- consume_free_audit. Nothing else.
--
-- NOT applied to production by this PR. Additive only: no existing table,
-- price, subscription, trial or charge date is touched. One transaction: it
-- either applies completely or not at all.

begin;

create table if not exists public.free_audit_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null check (customer_id ~ '^[0-9]{3,20}$'),
  user_id uuid not null,
  account_id uuid,
  -- reserved: audit running under a lease. completed: finished, counts against
  -- the limit. abandoned: lease expired without completion (server crash), never
  -- counts, so our failure cannot burn a customer's two audits.
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'abandoned')),
  lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists free_audit_ledger_customer_idx
  on public.free_audit_ledger (customer_id, status);

-- Server-only table: RLS on, no policies. Access goes through the functions below
-- and through the service role.
alter table public.free_audit_ledger enable row level security;
revoke all on table public.free_audit_ledger from public, anon, authenticated, service_role;
grant select on table public.free_audit_ledger to service_role;

-- Reserve one free audit for an account the caller owns. Serialised per customer
-- id with an advisory lock so concurrent requests cannot overshoot the limit.
-- Returns (allowed, reason, used, event_id).
create or replace function public.consume_free_audit(p_account_id uuid)
returns table (allowed boolean, reason text, used integer, event_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_limit constant integer := 2;
  c_lease constant interval := interval '15 minutes';
  v_user uuid := auth.uid();
  v_customer text;
  v_completed integer;
  v_running integer;
  v_event_id uuid;
begin
  if v_user is null then
    raise exception 'forbidden';
  end if;

  -- Ownership + customer id come from the database, never from the caller.
  select a.customer_id into v_customer
  from public.google_ads_accounts a
  join public.businesses b on b.id = a.business_id
  where a.id = p_account_id
    and b.user_id = v_user
    and a.status = 'active'
    and a.is_manager is not true;

  if v_customer is null or v_customer !~ '^[0-9]{3,20}$' then
    raise exception 'forbidden';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('free_audit:' || v_customer, 0));

  -- A reservation whose lease ran out was abandoned (crash). It stops counting
  -- and stops blocking.
  update public.free_audit_ledger
  set status = 'abandoned'
  where customer_id = v_customer and status = 'reserved' and lease_expires_at <= now();

  select count(*)::integer into v_completed
  from public.free_audit_ledger
  where customer_id = v_customer and status = 'completed';

  if v_completed >= c_limit then
    return query select false, 'free_audits_exhausted'::text, v_completed, null::uuid;
    return;
  end if;

  select count(*)::integer into v_running
  from public.free_audit_ledger
  where customer_id = v_customer and status = 'reserved';

  if v_running > 0 then
    return query select false, 'audit_in_progress'::text, v_completed, null::uuid;
    return;
  end if;

  insert into public.free_audit_ledger (customer_id, user_id, account_id, lease_expires_at)
  values (v_customer, v_user, p_account_id, now() + c_lease)
  returning id into v_event_id;

  return query select true, null::text, v_completed + 1, v_event_id;
end;
$$;

-- Finish a reservation. SERVER-ONLY (service_role): the audit route calls it
-- after the report is saved, so a customer cannot complete a reservation while
-- the audit is still running and then start the next one (that would defeat the
-- one-audit-at-a-time rule). The caller must name the event, the user and the
-- account, and all three must match the ledger row.
-- Idempotent: completing twice is fine. A reservation whose lease already
-- expired is NOT completed (it was abandoned), so a late or replayed call can
-- never push the count past the limit.
-- Returns 'completed' | 'already_completed' | 'expired' | 'not_found'.
create or replace function public.complete_free_audit(p_event_id uuid, p_user_id uuid, p_account_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.free_audit_ledger%rowtype;
begin
  select * into v_row
  from public.free_audit_ledger
  where id = p_event_id and user_id = p_user_id and account_id = p_account_id;
  if not found then
    return 'not_found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('free_audit:' || v_row.customer_id, 0));
  select * into v_row from public.free_audit_ledger where id = p_event_id;

  if v_row.status = 'completed' then
    return 'already_completed';
  end if;
  if v_row.status = 'abandoned' or v_row.lease_expires_at <= now() then
    update public.free_audit_ledger set status = 'abandoned' where id = p_event_id and status = 'reserved';
    return 'expired';
  end if;

  update public.free_audit_ledger
  set status = 'completed', completed_at = now()
  where id = p_event_id and status = 'reserved';
  return 'completed';
end;
$$;

-- Give the allowance back when the audit itself failed (our fault, not the
-- customer's). Server-owned: only the service role may call it.
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

-- Drop the earlier, wider signatures if a reviewer already ran the first draft.
drop function if exists public.consume_free_audit(uuid, text, uuid, integer, integer, jsonb);
drop function if exists public.complete_free_audit(uuid, uuid);
drop function if exists public.complete_free_audit(uuid);

revoke all on function public.consume_free_audit(uuid) from public, anon, authenticated, service_role;
grant execute on function public.consume_free_audit(uuid) to authenticated;
revoke all on function public.complete_free_audit(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.complete_free_audit(uuid, uuid, uuid) to service_role;
revoke all on function public.refund_free_audit(uuid) from public, anon, authenticated, service_role;
grant execute on function public.refund_free_audit(uuid) to service_role;

commit;
