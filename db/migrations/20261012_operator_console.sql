-- Operator console (مركز التشغيل): access overrides and an audit trail.
--
-- Two tables, both additive. Nothing existing is altered.
--
-- account_access_overrides
--   What an operator changed about a customer's access, outside Stripe:
--   * kind = 'plan_grant'  a free plan (starter / growth / pro), optionally until
--                          expires_at. lib/billing/entitlements.ts treats a live
--                          grant like a live subscription of that plan.
--   * kind = 'suspension'  the account is suspended: entitlements report it as
--                          inactive, the sync and optimizer jobs skip it, and the
--                          dashboard shows a banner.
--   A row is live while revoked_at is null and (expires_at is null or in the
--   future). Only one live row per (user, kind), enforced by a partial unique
--   index, so two operators cannot stack two grants.
--
--   The customer may READ their own rows (the dashboard shows the suspension
--   banner and getSubscriptionAccess runs with the customer's session in pages).
--   The table deliberately holds no free text and no operator identity, so that
--   read exposes nothing beyond "suspended" or "free plan until X". The reason
--   and who did it live in operator_audit_log, which customers cannot read.
--   Writes happen only through the service role, from the operator API.
--
-- operator_audit_log
--   One row per operator action. The API writes the row with status 'started'
--   BEFORE touching Stripe or the overrides, and refuses to act if that insert
--   fails, so there is no unaudited action. It then marks the row 'succeeded' or
--   'failed'. Server-only: RLS on, no policies, service role only. No foreign
--   key to users so the trail survives a deleted account.
--
-- Privileges follow 20261009_free_audit_quota.sql: revoke everything Supabase's
-- default privileges hand out, then grant back the minimum.
--
-- The application tolerates this migration not being applied yet: reads of the
-- missing tables are treated as "no override", and the operator actions return
-- a clear error instead of acting.

begin;

create table if not exists public.account_access_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('suspension', 'plan_grant')),
  plan text check (plan is null or plan in ('starter', 'growth', 'pro')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint account_access_overrides_plan_matches_kind check (
    (kind = 'plan_grant' and plan is not null)
    or (kind = 'suspension' and plan is null)
  )
);

create unique index if not exists account_access_overrides_one_live
  on public.account_access_overrides (user_id, kind)
  where revoked_at is null;

create index if not exists account_access_overrides_user_idx
  on public.account_access_overrides (user_id, created_at desc);

alter table public.account_access_overrides enable row level security;
revoke all on table public.account_access_overrides from public, anon, authenticated, service_role;
grant select on table public.account_access_overrides to authenticated;
grant select, insert, update on table public.account_access_overrides to service_role;

drop policy if exists account_access_overrides_owner_read on public.account_access_overrides;
create policy account_access_overrides_owner_read
  on public.account_access_overrides
  for select
  to authenticated
  using (user_id = auth.uid());

-- Replace a customer's free plan in ONE transaction: revoke the live grant and
-- insert the new one together, so a failed insert can never leave the customer
-- without the grant they already had. Service role only (the operator API).
create or replace function public.operator_replace_plan_grant(
  p_user_id uuid,
  p_plan text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.account_access_overrides
  set revoked_at = now()
  where user_id = p_user_id and kind = 'plan_grant' and revoked_at is null;

  insert into public.account_access_overrides (user_id, kind, plan, expires_at)
  values (p_user_id, 'plan_grant', p_plan, p_expires_at)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.operator_replace_plan_grant(uuid, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.operator_replace_plan_grant(uuid, text, timestamptz) to service_role;

create table if not exists public.operator_audit_log (
  id uuid primary key default gen_random_uuid(),
  operator_user_id uuid not null,
  operator_email text not null,
  action text not null check (
    action in ('extend_trial', 'grant_plan', 'revoke_plan', 'suspend', 'unsuspend')
  ),
  target_user_id uuid,
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed')),
  reason text check (reason is null or char_length(reason) <= 500),
  details jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists operator_audit_log_target_idx
  on public.operator_audit_log (target_user_id, created_at desc);

create index if not exists operator_audit_log_created_idx
  on public.operator_audit_log (created_at desc);

alter table public.operator_audit_log enable row level security;
revoke all on table public.operator_audit_log from public, anon, authenticated, service_role;
grant select, insert, update on table public.operator_audit_log to service_role;

commit;
