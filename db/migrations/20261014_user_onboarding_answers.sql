-- First-login questions (business type, monthly ad spend, who manages the
-- account) - 2026-10-14
--
-- One row per user, written by /api/onboarding/answers from the /welcome screen
-- BEFORE the Google Ads link. The agency-lead flag in /operations is computed
-- from these columns when the page opens, so changing the owner's threshold
-- never needs a data change.
--
-- Server-only: RLS on, no policies, every privilege revoked from public, anon,
-- authenticated and service_role, then select/insert/update granted back to
-- service_role. A browser can neither read nor write this table.
--
-- Additive only. NOT applied to production by the PR that adds it: Ayman runs
-- it. Until it is run, /welcome shows the connect screen straight away and the
-- answers API answers 503 without losing anything.

begin;

create table if not exists public.user_onboarding_answers (
  user_id uuid primary key references public.users (id) on delete cascade,
  business_type text check (business_type in (
    'ecommerce', 'local_services', 'real_estate', 'education', 'other'
  )),
  spend_band text check (spend_band in (
    'under_3k', '3k_10k', '10k_30k', 'over_30k', 'unknown'
  )),
  account_manager text check (account_manager in (
    'self', 'employee', 'agency', 'nobody'
  )),
  -- true when the person pressed "skip": we do not ask again on every sign-in.
  skipped boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Either all three answers, or a skip with none of them.
  constraint onboarding_answers_all_or_skipped check (
    (skipped = false and business_type is not null and spend_band is not null and account_manager is not null)
    or (skipped = true and business_type is null and spend_band is null and account_manager is null)
  )
);

alter table public.user_onboarding_answers enable row level security;
revoke all on table public.user_onboarding_answers from public, anon, authenticated, service_role;
grant select, insert, update on table public.user_onboarding_answers to service_role;

commit;

-- Verification (run manually after applying):
--   select count(*) from public.user_onboarding_answers;            -- 0
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'user_onboarding_answers';                  -- service_role only
