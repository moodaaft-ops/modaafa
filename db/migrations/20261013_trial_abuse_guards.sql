-- =============================================================================
-- 2026-10-13 - Trial and free-audit abuse guards
--
-- Problem: a user whose 14-day trial ended could register again with another
-- email (or a +tag / dotted Gmail variant of the same inbox) and get a NEW trial
-- on the SAME Google Ads account, because trial eligibility was keyed only on the
-- user id and on sha256(lowercased email). The free audit already uses the right
-- pattern: a durable ledger keyed on the Google customer id.
--
-- What this adds (all additive; no existing price, subscription, trial or charge
-- date is touched):
--   1. trial_customer_ledger  - first user to take a trial on a Google customer id.
--   2. trial_card_ledger      - first user to take a trial with a card fingerprint.
--   3. trial_email_key(text)  - SQL twin of lib/billing/trial-identity.ts
--                               (normalised email -> sha256 hex), used by the backfill.
--   4. Backfill of both the email ledger and the customer ledger from existing
--      trials, earliest trial wins when several users share a customer id. The
--      customer ledger only gets the account each trial actually used (see 4b),
--      never every account the user ever linked.
--   5. consume_free_audit: a user may spend free audits on at most 3 DISTINCT
--      Google customer ids (new reason 'free_accounts_exhausted'). Everything else
--      in the function is unchanged.
--
-- The ledgers have NO foreign keys on purpose: they must survive user deletion,
-- or delete-and-re-register would reset them.
--
-- Privileges (Supabase default privileges): objects created by the migration role
-- in schema public get ALL for anon, authenticated and service_role through
-- ALTER DEFAULT PRIVILEGES, and functions get EXECUTE for PUBLIC by Postgres
-- default. So this file never relies on "grant only what is needed": it first
-- REVOKES everything from PUBLIC, anon, authenticated and service_role on every
-- object it creates, then grants back the minimum. The ledgers are append-only for
-- the service role (SELECT + INSERT): a row can only be removed by an operator
-- running SQL as the owner, which is the intended way to lift a false positive.
--
-- NOT applied to production by this change. Idempotent: safe to run twice. One
-- transaction: it either applies completely or not at all.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Trial per Google customer id
-- ---------------------------------------------------------------------------
create table if not exists public.trial_customer_ledger (
  customer_id text primary key check (customer_id ~ '^[0-9]{3,20}$'),
  first_user_id uuid not null,
  granted_at timestamptz not null default now(),
  source text
);

alter table public.trial_customer_ledger enable row level security;
revoke all on table public.trial_customer_ledger from public, anon, authenticated, service_role;
grant select, insert on table public.trial_customer_ledger to service_role;

-- ---------------------------------------------------------------------------
-- 2. Trial per card fingerprint (Stripe card.fingerprint)
-- ---------------------------------------------------------------------------
create table if not exists public.trial_card_ledger (
  fingerprint text primary key,
  first_user_id uuid not null,
  stripe_subscription_id text,
  granted_at timestamptz default now()
);

alter table public.trial_card_ledger enable row level security;
revoke all on table public.trial_card_ledger from public, anon, authenticated, service_role;
grant select, insert on table public.trial_card_ledger to service_role;

-- ---------------------------------------------------------------------------
-- 3. trial_email_key: normalised email -> sha256 hex
--
-- MUST stay identical to normalizeTrialEmail + normalizedTrialEmailKey in
-- lib/billing/trial-identity.ts: trim + lowercase; split on the LAST '@'; drop
-- everything from the first '+' in the local part (unless that would leave it
-- empty); for gmail.com / googlemail.com also drop every '.' in the local part
-- and use gmail.com. An input with no '@' is hashed as is. Blank or null input
-- returns null (never a shared key for "no email").
-- ---------------------------------------------------------------------------
create or replace function public.trial_email_key(p_email text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_rev_at integer;
  v_at integer;
  v_local text;
  v_domain text;
  v_plus integer;
begin
  v_email := lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g'));
  if v_email = '' then
    return null;
  end if;

  v_rev_at := strpos(reverse(v_email), '@');
  if v_rev_at = 0 then
    return encode(sha256(convert_to(v_email, 'UTF8')), 'hex');
  end if;

  v_at := length(v_email) - v_rev_at + 1;
  v_local := left(v_email, v_at - 1);
  v_domain := substr(v_email, v_at + 1);

  v_plus := strpos(v_local, '+');
  if v_plus > 1 then
    v_local := left(v_local, v_plus - 1);
  end if;

  if v_domain in ('gmail.com', 'googlemail.com') then
    v_local := replace(v_local, '.', '');
    v_domain := 'gmail.com';
  end if;

  return encode(sha256(convert_to(v_local || '@' || v_domain, 'UTF8')), 'hex');
end;
$$;

revoke all on function public.trial_email_key(text) from public, anon, authenticated, service_role;
grant execute on function public.trial_email_key(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Backfill from trials that already happened. Every insert is
--    ON CONFLICT DO NOTHING, so re-running changes nothing and a newer value
--    never replaces an older owner.
--
-- A "trial user" is any user with a billing_trial_grants row, or a subscriptions
-- row with trial_ends_at set (Stripe keeps trial_end after a trial converts, so
-- this includes customers who went on to pay). The user's trial moment is the
-- earliest of those rows.
-- ---------------------------------------------------------------------------

-- 4a. Email ledger, under the NORMALISED key. When several users normalise to the
--     same address (name+1@gmail.com and name+2@gmail.com) the earliest is kept.
--     Ledger rows for users that were already deleted only exist under the old
--     exact-address hash; those cannot be normalised from a hash, so they keep
--     protecting the exact address only.
with trial_events as (
  select g.user_id, g.granted_at as at
  from public.billing_trial_grants g
  union all
  select s.user_id, coalesce(s.created_at, s.trial_ends_at)
  from public.subscriptions s
  where s.trial_ends_at is not null
), first_trial as (
  select user_id, min(at) as first_at
  from trial_events
  where user_id is not null
  group by user_id
)
insert into public.billing_trial_ledger (email_hash, granted_at, source)
select distinct on (public.trial_email_key(u.email))
       public.trial_email_key(u.email),
       coalesce(ft.first_at, now()),
       'backfill_20261013'
from first_trial ft
join auth.users u on u.id = ft.user_id
where public.trial_email_key(u.email) is not null
order by public.trial_email_key(u.email), ft.first_at, ft.user_id
on conflict (email_hash) do nothing;

-- 4b. Customer ledger: only the Google Ads account a trial actually USED.
--
--     Claiming every account a trial user ever linked marked accounts that never
--     had a trial as used, and that blocks other users from trialing on them. So
--     the backfill is deliberately narrower than "everything they linked":
--
--       * Only accounts linked on or before the end of that user's trial, where
--         the trial end is subscriptions.trial_ends_at when there is one and
--         the grant time + 14 days otherwise. An account linked after the trial
--         (typically by a user who already converted to paid) is never claimed.
--         linked_at holds the FIRST link time: connect_job_link does not change it
--         when an account is re-linked.
--       * Of those, only the account the trial used:
--           - the account the business has selected (businesses.
--             selected_google_ads_customer_id), when it is among them;
--           - otherwise, when the user has exactly one such account, that one (a
--             single-account user never has a selected id, and nothing else could
--             have been used);
--           - otherwise the user has several and nothing says which one, so only
--             the accounts linked DURING the trial window (on or after the first
--             trial moment) are claimed. Several accounts linked before the trial
--             with no selection are left unclaimed on purpose: a missed abuser is
--             cheaper than a legitimate customer blocked from their own account.
--       * Whatever its link status today (a revoked or paused link does not undo
--         that the trial ran on it), but never a manager account.
--
--     When several users qualify for one customer id the earliest trial owns it.
--     Only numeric ids pass the check. Idempotent (ON CONFLICT DO NOTHING).
with trial_events as (
  select g.user_id, g.granted_at as at
  from public.billing_trial_grants g
  union all
  select s.user_id, coalesce(s.created_at, s.trial_ends_at)
  from public.subscriptions s
  where s.trial_ends_at is not null
), first_trial as (
  select user_id, min(at) as first_at
  from trial_events
  where user_id is not null
  group by user_id
), trial_window as (
  select ft.user_id,
         ft.first_at,
         coalesce(
           (select max(s.trial_ends_at)
              from public.subscriptions s
             where s.user_id = ft.user_id
               and s.trial_ends_at is not null),
           ft.first_at + interval '14 days'
         ) as window_end
  from first_trial ft
), candidates as (
  select w.user_id,
         w.first_at,
         a.customer_id,
         a.linked_at,
         (a.customer_id = regexp_replace(coalesce(b.selected_google_ads_customer_id, ''), '[^0-9]', '', 'g')) as is_selected
  from trial_window w
  join public.businesses b on b.user_id = w.user_id
  join public.google_ads_accounts a on a.business_id = b.id
  where a.is_manager is not true
    and a.customer_id ~ '^[0-9]{3,20}$'
    and a.linked_at <= w.window_end
), per_user as (
  select user_id,
         count(distinct customer_id) as account_count,
         bool_or(is_selected) as any_selected
  from candidates
  group by user_id
)
insert into public.trial_customer_ledger (customer_id, first_user_id, granted_at, source)
select distinct on (c.customer_id)
       c.customer_id,
       c.user_id,
       coalesce(c.first_at, now()),
       'backfill_20261013'
from candidates c
join per_user p on p.user_id = c.user_id
where case
        when p.any_selected then c.is_selected
        when p.account_count = 1 then true
        else c.linked_at >= c.first_at
      end
order by c.customer_id, c.first_at, c.user_id
on conflict (customer_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. consume_free_audit with a per-user cap on distinct Google customer ids.
--
-- Same signature, return type, ownership derivation, lease sweep, limit of 2
-- completed audits per customer id, one-at-a-time rule and per-customer advisory
-- lock as db/migrations/20261009_free_audit_quota.sql. Added:
--   * a user may use free audits on at most 3 DISTINCT customer ids. The ids that
--     count are the ones the user already has a `completed` row, or a reservation
--     with a LIVE lease, for. Spending on an id already among them is never
--     blocked by this cap.
--   * a per-user advisory lock (taken BEFORE the per-customer one, always in that
--     order) so four concurrent calls on four different ids cannot all pass the
--     count and end at four.
-- The new check runs after the existing ones, so 'free_audits_exhausted' and
-- 'audit_in_progress' keep their precedence.
-- ---------------------------------------------------------------------------
create or replace function public.consume_free_audit(p_account_id uuid)
returns table (allowed boolean, reason text, used integer, event_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_limit constant integer := 2;
  c_account_limit constant integer := 3;
  c_lease constant interval := interval '15 minutes';
  v_user uuid := auth.uid();
  v_customer text;
  v_completed integer;
  v_running integer;
  v_user_accounts integer;
  v_known boolean;
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

  perform pg_advisory_xact_lock(hashtextextended('free_audit_user:' || v_user, 0));
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

  -- Per-user cap on distinct customer ids. A lapsed lease is not live, so it
  -- does not count even before the sweep above reaches that customer.
  select count(distinct l.customer_id)::integer, coalesce(bool_or(l.customer_id = v_customer), false)
  into v_user_accounts, v_known
  from public.free_audit_ledger l
  where l.user_id = v_user
    and (l.status = 'completed' or (l.status = 'reserved' and l.lease_expires_at > now()));

  if not v_known and v_user_accounts >= c_account_limit then
    return query select false, 'free_accounts_exhausted'::text, v_completed, null::uuid;
    return;
  end if;

  insert into public.free_audit_ledger (customer_id, user_id, account_id, lease_expires_at)
  values (v_customer, v_user, p_account_id, now() + c_lease)
  returning id into v_event_id;

  return query select true, null::text, v_completed + 1, v_event_id;
end;
$$;

revoke all on function public.consume_free_audit(uuid) from public, anon, authenticated, service_role;
grant execute on function public.consume_free_audit(uuid) to authenticated;

commit;
