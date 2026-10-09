-- Fencing for the Google Ads connect job (task 02, review of PR #62).
--
-- The race this closes: a user consents twice (two tabs, a retry, a slow first
-- run). startConnectJob retired the older job_runs row, but the older
-- runConnectJob kept running and could still (a) overwrite the newer consent's
-- refresh token in google_ads_accounts, (b) change the selected account, (c) run
-- its sync and (d) flip its own row back to success. Checking the job state in
-- application code and then writing is check-then-write: not safe when the
-- write is a credential.
--
-- Every effectful step is now one SQL function that takes a row lock on the
-- caller's job_runs row (FOR UPDATE) and refuses unless that row is still
-- 'running'. Starting a newer job needs the same row lock to retire the old one,
-- so exactly one of "old write lands" or "old write is refused" happens, and an
-- old job that arrives after its replacement can never touch credentials.
--
-- Ordering rule (be precise about it): two jobs are ordered by the time the
-- user CONSENTED (oauth_states.created_at, passed as p_consent_at), not by
-- when the callback happened to reach the server. A callback that arrives late
-- for an older consent is refused (connect_job_start returns null) and never
-- opens a job. When no consent time is available (state storage down, cookie
-- fallback) ordering falls back to job start time, i.e. callback arrival order.
--
-- Everything below runs in ONE transaction, so no function is ever visible with
-- the default PUBLIC execute grant between create and revoke.
--
-- Permissions: nothing is widened. The functions are executable by service_role
-- only (the app calls them through createAdminClient); anon, authenticated and
-- public are revoked. No table, policy or grant changes.
--
-- NOT applied to production by this PR. Additive only (create or replace).

begin;

-- Retire any live connect job for the user and open a new one, atomically.
-- The advisory lock serialises concurrent callbacks for the same user, so two
-- simultaneous consents cannot trip job_runs_one_running_per_job: the later one
-- retires the earlier one and wins.
create or replace function public.connect_job_start(
  p_user_id uuid,
  p_consent_at timestamptz default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_name text := 'google_ads_connect:' || p_user_id::text;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_name, 0));

  -- A newer consent already has (or had) a job: this callback is stale.
  if p_consent_at is not null and exists (
    select 1 from public.job_runs
     where job_name = v_name
       and details ? 'consent_at'
       and (details ->> 'consent_at')::timestamptz > p_consent_at
  ) then
    return null;
  end if;

  update public.job_runs
     set status = 'failed',
         finished_at = now(),
         error_message = 'superseded: a newer Google Ads consent started'
   where job_name = v_name and status = 'running';

  insert into public.job_runs (job_name, status, started_at, details)
  values (v_name, 'running', now(), jsonb_build_object('stage', 'discover', 'consent_at', p_consent_at))
  returning id into v_id;

  return v_id;
end;
$$;

-- Lock the caller's job row and report whether it is still the live one.
create or replace function public.connect_job_lock_live(p_job_id uuid, p_user_id uuid)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform 1
    from public.job_runs
   where id = p_job_id
     and job_name = 'google_ads_connect:' || p_user_id::text
     and status = 'running'
   for update;
  return found;
end;
$$;

-- Link (upsert) the discovered accounts with this consent's encrypted token.
-- Returns {"status":"linked","rows":[...]} or {"status":"superseded"} /
-- {"status":"forbidden"}; in the last two nothing is written.
create or replace function public.connect_job_link(
  p_job_id uuid,
  p_user_id uuid,
  p_business_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if not public.connect_job_lock_live(p_job_id, p_user_id) then
    return jsonb_build_object('status', 'superseded');
  end if;

  perform 1 from public.businesses where id = p_business_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('status', 'forbidden');
  end if;

  with incoming as (
    select * from jsonb_populate_recordset(null::public.google_ads_accounts, p_rows)
  ), saved as (
    insert into public.google_ads_accounts (
      business_id, customer_id, customer_name, manager_id, refresh_token_encrypted,
      permissions_scope, status, currency_code, time_zone, is_manager, google_status
    )
    select p_business_id, customer_id, customer_name, manager_id, refresh_token_encrypted,
           permissions_scope, status, currency_code, time_zone, is_manager, google_status
      from incoming
    on conflict (business_id, customer_id) do update set
      customer_name = excluded.customer_name,
      manager_id = excluded.manager_id,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      permissions_scope = excluded.permissions_scope,
      status = excluded.status,
      currency_code = excluded.currency_code,
      time_zone = excluded.time_zone,
      is_manager = excluded.is_manager,
      google_status = excluded.google_status
    returning id, customer_id, manager_id, currency_code
  )
  select coalesce(jsonb_agg(to_jsonb(saved)), '[]'::jsonb) into v_rows from saved;

  return jsonb_build_object('status', 'linked', 'rows', v_rows);
end;
$$;

-- Select the account for the user, only if this job is still live and the user
-- has not chosen one in the meantime.
create or replace function public.connect_job_select_account(
  p_job_id uuid,
  p_user_id uuid,
  p_business_id uuid,
  p_customer_id text
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not public.connect_job_lock_live(p_job_id, p_user_id) then
    return 'superseded';
  end if;

  update public.businesses
     set selected_google_ads_customer_id = p_customer_id
   where id = p_business_id
     and user_id = p_user_id
     and selected_google_ads_customer_id is null;

  return case when found then 'selected' else 'kept' end;
end;
$$;

-- Record the login (manager) customer id the first sync discovered.
create or replace function public.connect_job_set_manager(
  p_job_id uuid,
  p_user_id uuid,
  p_account_id uuid,
  p_manager_id text
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not public.connect_job_lock_live(p_job_id, p_user_id) then
    return 'superseded';
  end if;

  update public.google_ads_accounts a
     set manager_id = p_manager_id
    from public.businesses b
   where a.id = p_account_id
     and b.id = a.business_id
     and b.user_id = p_user_id;

  return case when found then 'updated' else 'forbidden' end;
end;
$$;

revoke all on function public.connect_job_start(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.connect_job_lock_live(uuid, uuid) from public, anon, authenticated;
revoke all on function public.connect_job_link(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.connect_job_select_account(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.connect_job_set_manager(uuid, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.connect_job_start(uuid, timestamptz) to service_role;
grant execute on function public.connect_job_lock_live(uuid, uuid) to service_role;
grant execute on function public.connect_job_link(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.connect_job_select_account(uuid, uuid, uuid, text) to service_role;
grant execute on function public.connect_job_set_manager(uuid, uuid, uuid, text) to service_role;

commit;
