-- Checks for db/migrations/20261012_operator_console.sql on a throwaway Postgres 16.
-- Run: setup section, then the migration (twice, to prove it is re-runnable), then the checks.
-- Every line printed must start with 'ok' or be a count line; any 'FAIL' is a regression.

-- ---- setup (Supabase-like roles and auth.uid) ----
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase default privileges: everything new in public goes to these roles
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.users (id uuid primary key, email text);
insert into public.users values ('11111111-1111-1111-1111-111111111111','a@x.com'),('22222222-2222-2222-2222-222222222222','b@x.com');

-- ---- checks ----
\set A '11111111-1111-1111-1111-111111111111'
\set B '22222222-2222-2222-2222-222222222222'
-- service role writes
set role service_role;
insert into account_access_overrides (user_id, kind, plan) values (:'A','plan_grant','pro');
insert into account_access_overrides (user_id, kind) values (:'B','suspension');
do $$ begin
  begin insert into account_access_overrides (user_id, kind, plan) values ('11111111-1111-1111-1111-111111111111','plan_grant','growth'); raise notice 'FAIL second live grant allowed';
  exception when unique_violation then raise notice 'ok: second live grant blocked'; end;
  begin insert into account_access_overrides (user_id, kind) values ('11111111-1111-1111-1111-111111111111','plan_grant'); raise notice 'FAIL grant without plan';
  exception when check_violation then raise notice 'ok: grant needs plan'; end;
  begin insert into account_access_overrides (user_id, kind, plan) values ('11111111-1111-1111-1111-111111111111','suspension','pro'); raise notice 'FAIL suspension with plan';
  exception when check_violation then raise notice 'ok: suspension has no plan'; end;
end $$;
update account_access_overrides set revoked_at = now() where user_id = :'A' and kind = 'plan_grant';
insert into account_access_overrides (user_id, kind, plan) values (:'A','plan_grant','growth');
select 'ok: regrant after revoke' where (select count(*) from account_access_overrides where user_id = :'A') = 2;
insert into operator_audit_log (operator_user_id, operator_email, action, target_user_id) values (:'A','op@x.com','suspend',:'B');
reset role;
-- customer A reads
set role authenticated; select set_config('request.jwt.claim.sub', :'A', false);
select 'A sees own rows: ' || count(*) from account_access_overrides;
select 'A sees B rows: ' || count(*) from account_access_overrides where user_id = :'B';
do $$ begin
  begin insert into account_access_overrides (user_id, kind) values ('11111111-1111-1111-1111-111111111111','suspension'); raise notice 'FAIL authenticated insert';
  exception when insufficient_privilege then raise notice 'ok: authenticated cannot insert'; end;
  begin update account_access_overrides set revoked_at = now(); raise notice 'FAIL authenticated update';
  exception when insufficient_privilege then raise notice 'ok: authenticated cannot update'; end;
  begin perform 1 from operator_audit_log; raise notice 'FAIL authenticated reads audit log';
  exception when insufficient_privilege then raise notice 'ok: authenticated cannot read audit log'; end;
end $$;
reset role;
set role service_role;
do $$ begin
  begin delete from operator_audit_log; raise notice 'FAIL service role can delete audit';
  exception when insufficient_privilege then raise notice 'ok: audit log is not deletable'; end;
end $$;
reset role;
set role anon;
do $$ begin
  begin perform 1 from account_access_overrides; raise notice 'FAIL anon reads overrides';
  exception when insufficient_privilege then raise notice 'ok: anon cannot read overrides'; end;
end $$;

-- ---- atomic grant replacement (operator_replace_plan_grant) ----
set role service_role;
select operator_replace_plan_grant('11111111-1111-1111-1111-111111111111','pro', null) is not null as granted;
select count(*) filter (where revoked_at is null) as live, count(*) as total from account_access_overrides where user_id='11111111-1111-1111-1111-111111111111' and kind='plan_grant';
do $$ begin
  begin perform operator_replace_plan_grant('11111111-1111-1111-1111-111111111111','enterprise', null); raise notice 'FAIL bad plan accepted';
  exception when check_violation then raise notice 'ok: bad plan rolls back'; end;
end $$;
select count(*) filter (where revoked_at is null) as live_after_failed from account_access_overrides where user_id='11111111-1111-1111-1111-111111111111' and kind='plan_grant';
reset role;
set role authenticated;
do $$ begin
  begin perform operator_replace_plan_grant('11111111-1111-1111-1111-111111111111','pro', null); raise notice 'FAIL authenticated can call';
  exception when insufficient_privilege then raise notice 'ok: authenticated cannot call'; end;
end $$;
