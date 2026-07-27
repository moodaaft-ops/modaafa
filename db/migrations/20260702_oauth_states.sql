-- Server-side OAuth state storage.
-- Fixes recurring `state_mismatch` on Google Ads connect:
-- cookie-only state broke with slow/stuck consent screens (10-min cookie),
-- multi-tab retries, and host/profile mismatches.
-- Apply in Supabase SQL Editor (or via migration tooling).

create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null default 'google_ads_connect',
  return_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists oauth_states_expires_at_idx
  on public.oauth_states (expires_at);

create index if not exists oauth_states_user_id_idx
  on public.oauth_states (user_id);

-- Service-role only: RLS enabled with no policies.
alter table public.oauth_states enable row level security;
