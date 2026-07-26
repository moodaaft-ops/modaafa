-- 2026-07-22 — launch hardening
--
-- 1) Guarantee tenant data cannot be orphaned when the Supabase auth identity
--    is deleted outside the app (dashboard, admin tooling, GDPR scripts).
--    public.users previously had no FK to auth.users, so an out-of-band
--    auth.users delete left businesses, encrypted Google refresh tokens,
--    chats and invoices behind forever.
--
-- 2) Re-assert the canonical consume_rate_limit function. The 20260721
--    migration pair sorts alphabetically as (fix..., rate_limits...), so a
--    fresh environment applies the "fix" before the table exists. Function
--    bodies are not validated at CREATE time, so that works by accident;
--    this migration makes the final state deterministic regardless of order.

begin;

-- 1a) Remove any already-orphaned profiles (their auth identity is gone, so
--     the retention policy says their tenant data must go too). Cascades take
--     care of child rows.
delete from public.users u
where not exists (select 1 from auth.users a where a.id = u.id);

-- 1b) Add the FK so future auth deletions cascade through the whole tree.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_id_auth_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_id_auth_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- 2) Canonical rate-limit function (identical to 20260721_rate_limits.sql /
--    20260721_fix_rate_limit_function.sql, re-created so the final applied
--    definition never depends on migration file ordering).
create or replace function public.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit configuration';
  end if;

  insert into public.rate_limit_windows as limits (key, window_start, request_count, updated_at)
  values (p_key, v_now, 1, v_now)
  on conflict (key) do update
    set window_start = case
          when limits.window_start + make_interval(secs => p_window_seconds) <= v_now then v_now
          else limits.window_start
        end,
        request_count = case
          when limits.window_start + make_interval(secs => p_window_seconds) <= v_now then 1
          else limits.request_count + 1
        end,
        updated_at = v_now
  returning limits.window_start, limits.request_count
    into v_window_start, v_count;

  return query select
    v_count <= p_limit,
    greatest(0, p_limit - v_count),
    v_window_start + make_interval(secs => p_window_seconds);
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

commit;
