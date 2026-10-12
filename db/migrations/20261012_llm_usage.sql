-- =============================================================================
-- 2026-10-12 - LLM usage and cost ledger (PR-J1: cost measurement)
--
-- One row per successful Anthropic call, written from createMessageForAgent.
-- It exists to measure real cost per user, feature and model before any cap is
-- enforced, and to feed the per-subscriber budget (spec sections 8.4 and 8.5).
--
-- Forward-only, non-destructive and safe to run repeatedly.
-- Server-only data: RLS is enabled with NO policies, anon and authenticated
-- hold no privilege at all, and only the service role reads and appends.
--
-- Supabase gives new objects in schema public default privileges for anon,
-- authenticated and service_role (and functions EXECUTE for PUBLIC). So this
-- file never relies on "grant only what is needed": it first revokes
-- everything on every object it creates, then grants back the minimum.
-- =============================================================================

begin;

create table if not exists public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  account_id uuid references public.google_ads_accounts(id) on delete set null,
  feature text not null check (char_length(feature) <= 60),
  channel text check (channel in ('text', 'voice', 'cron')),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  -- false when the model id was not in the price table and the conservative
  -- fallback rate was used, so the number is an upper estimate.
  priced boolean not null default true,
  tool_rounds smallint not null default 0,
  latency_ms integer,
  pricing_version text,
  playbook_version text,
  created_at timestamptz not null default now()
);

create index if not exists idx_llm_usage_user_created
  on public.llm_usage (user_id, created_at desc);
create index if not exists idx_llm_usage_created
  on public.llm_usage (created_at desc);

alter table public.llm_usage enable row level security;

revoke all on table public.llm_usage from public, anon, authenticated, service_role;
grant select, insert on table public.llm_usage to service_role;

comment on table public.llm_usage is
  'Append-only ledger of Anthropic calls with token counts and computed USD cost. Service role only; no browser access.';

-- Spend of one user since a point in time. Used by the budget check, which runs
-- on the service role. It is SECURITY DEFINER so it keeps working if the table
-- privileges are tightened further, and it is not callable by browser roles.
create or replace function public.llm_usage_cost_since(p_user_id uuid, p_since timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(cost_usd), 0)::numeric
  from public.llm_usage
  where user_id = p_user_id
    and created_at >= p_since;
$$;

revoke all on function public.llm_usage_cost_since(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.llm_usage_cost_since(uuid, timestamptz)
  to service_role;

commit;
