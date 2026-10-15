-- =============================================================================
-- 2026-10-15 - Ad account provisioning («افتحه لي»)
--
-- A registered user with no Google Ads account presses one button; the platform
-- creates the account under a dedicated manager account (MCC), invites the
-- user's email as admin and follows the invitation until it is accepted.
--
-- Two tables, both additive. Nothing existing is altered.
--
-- ads_account_provisions
--   One row per user (user_id is unique): at most one account is ever created
--   for a user. The row is inserted BEFORE Google is called, so two taps (or two
--   tabs) can never create two accounts: the second insert hits the unique key.
--   status:
--     creating  the row exists, Google is being asked (or the request died)
--     invited   the account exists and the invitation is out
--     accepted  the user accepted; the account is theirs to link
--     unlinked  accepted and removed from our manager account (frees the slot)
--     expired   the invitation expired or was declined
--     failed    a step failed; error_code says which. A failed row can be retried.
--   The user may READ their own row (the onboarding screen shows the state).
--   Writes happen only through the service role, from the provisioning routes
--   and the hourly job.
--
-- provisioning_credentials
--   The refresh token of the Google user who owns the dedicated manager account,
--   AES-256-GCM encrypted by the application (lib/crypto.ts). Exactly one row
--   (id is pinned to 1). Service role only: nobody else can read or write it.
--
-- Privileges follow 20261012_operator_console.sql: revoke everything Supabase's
-- default privileges hand out, then grant back the minimum.
--
-- NOT applied to production by this change. Idempotent: safe to run twice. One
-- transaction: it either applies completely or not at all.
-- The application tolerates this migration not being applied yet: the feature
-- stays off and the onboarding screens keep the WhatsApp button.
-- =============================================================================

begin;

create table if not exists public.ads_account_provisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  invited_email text not null,
  account_name text not null,
  customer_id text check (customer_id is null or customer_id ~ '^[0-9]{3,20}$'),
  status text not null default 'creating'
    check (status in ('creating', 'invited', 'accepted', 'unlinked', 'expired', 'failed')),
  error_code text,
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  invited_at timestamptz,
  accepted_at timestamptz,
  unlinked_at timestamptz,
  last_checked_at timestamptz,
  updated_at timestamptz not null default now()
);

-- A Google account belongs to at most one user.
create unique index if not exists ads_account_provisions_customer_uidx
  on public.ads_account_provisions (customer_id)
  where customer_id is not null;

-- The hourly job walks the open rows oldest-check first.
create index if not exists ads_account_provisions_open_idx
  on public.ads_account_provisions (status, last_checked_at nulls first)
  where status in ('creating', 'invited', 'accepted');

alter table public.ads_account_provisions enable row level security;
revoke all on table public.ads_account_provisions from public, anon, authenticated, service_role;
-- The owner may read only what the screen shows: never the Google customer id, error codes or attempts.
grant select (id, user_id, invited_email, status, created_at, invited_at, accepted_at, unlinked_at)
  on table public.ads_account_provisions to authenticated;
grant select, insert, update on table public.ads_account_provisions to service_role;

drop policy if exists ads_account_provisions_owner_read on public.ads_account_provisions;
create policy ads_account_provisions_owner_read
  on public.ads_account_provisions
  for select
  to authenticated
  using (user_id = auth.uid());

create table if not exists public.provisioning_credentials (
  id smallint primary key default 1 check (id = 1),
  mcc_id text not null check (mcc_id ~ '^[0-9]{10}$'),
  google_email text,
  refresh_token_encrypted text not null,
  connected_by uuid,
  connected_at timestamptz not null default now()
);

alter table public.provisioning_credentials enable row level security;
revoke all on table public.provisioning_credentials from public, anon, authenticated, service_role;
grant select, insert, update on table public.provisioning_credentials to service_role;
-- No policy on purpose: RLS on with no policy means no browser role sees a row.

commit;
