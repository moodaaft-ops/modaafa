create table if not exists public.rate_limit_windows (
  key text primary key,
  window_start timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.rate_limit_windows enable row level security;
revoke all on table public.rate_limit_windows from anon, authenticated;

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

create index if not exists rate_limit_windows_updated_idx
  on public.rate_limit_windows (updated_at);
