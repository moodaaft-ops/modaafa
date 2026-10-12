import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * Real-Postgres tests for db/migrations/20261012_registration_tracking.sql.
 * Skipped unless REGISTRATION_PG_URL points at an EMPTY scratch database
 * (never production), e.g. postgres://postgres@localhost:5545/scratch.
 * The suite builds minimal stand-ins for auth.users, public.users and the
 * Supabase roles, then applies the migration twice (idempotency).
 */
const url = process.env.REGISTRATION_PG_URL;
const skip = url ? false : 'set REGISTRATION_PG_URL to run the SQL integration tests';
const run = promisify(execFile);

const OLD1 = '00000000-0000-0000-0000-0000000000a1';
const OLD2 = '00000000-0000-0000-0000-0000000000a2';
const N1 = '11111111-1111-1111-1111-111111111111';
const N2 = '22222222-2222-2222-2222-222222222222';
const N3 = '33333333-3333-3333-3333-333333333333';
const PHONE = '+966501234567';

function psql(sql: string) {
  return execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], { encoding: 'utf8' }).trim();
}
function psqlFile(path: string) {
  return execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path], { encoding: 'utf8' });
}
function asRole(role: string, sql: string) {
  try {
    return psql(`set role ${role}; ${sql}`).split('\n').pop()!;
  } catch (error: any) {
    return `ERROR: ${String(error.stderr ?? error.message)}`;
  }
}
const finalizeSql = (user: string, phone: string) =>
  `set role service_role; select result_status from public.finalize_registration('${user}', 'Test Name', '${phone}', '{"utm_source":"tiktok","ttclid":"E.C.P.abc123"}'::jsonb, 'reg_${user}')`;

test('setup', { skip }, () => {
  psql(`
    create schema if not exists auth;
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    alter role service_role bypassrls;
    create table if not exists auth.users (id uuid primary key);
    create table if not exists public.users (
      id uuid primary key references auth.users(id) on delete cascade,
      email text unique not null, name text, phone text,
      created_at timestamptz default now(), updated_at timestamptz default now());
    grant usage on schema public, auth to authenticated, service_role, anon;
    -- Supabase gives service_role full rights on public tables; the real schema only revokes writes from anon and authenticated.
    grant all on public.users, auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    insert into auth.users values ('${OLD1}'), ('${OLD2}'), ('${N1}'), ('${N2}'), ('${N3}');
    insert into public.users (id, email, created_at) values
      ('${OLD1}', 'old1@x.co', now() - interval '40 days'), ('${OLD2}', 'old2@x.co', now() - interval '10 days');
  `);
  psqlFile('db/migrations/20261012_registration_tracking.sql');
  psqlFile('db/migrations/20261012_registration_tracking.sql');
});

test('existing customers are grandfathered once, new users are not', { skip }, () => {
  assert.equal(psql(`select count(*) from public.users where registered_at is null`), '0');
  psql(`insert into public.users (id, email) values ('${N1}', 'n1@x.co'), ('${N2}', 'n2@x.co'), ('${N3}', 'n3@x.co')`);
  psqlFile('db/migrations/20261012_registration_tracking.sql'); // a third run must not back-fill them
  assert.equal(psql(`select count(*) from public.users where registered_at is null`), '3');
});

test('finalize completes: stage, phone, source and the event row', { skip }, () => {
  assert.equal(psql(finalizeSql(N1, PHONE)).split('\n').pop(), 'completed');
  assert.equal(psql(`select stage||'|'||phone_normalized||'|'||(registration_source->>'utm_source')||'|'||(registered_at is not null) from public.users where id='${N1}'`), `registered|${PHONE}|tiktok|true`);
  assert.equal(psql(`select count(*)||'|'||min(metadata->>'event_id') from public.user_events where user_id='${N1}' and event='registration_completed'`), `1|reg_${N1}`);
});

test('finalize is idempotent: a second call changes nothing and adds no event', { skip }, () => {
  assert.equal(psql(finalizeSql(N1, PHONE)).split('\n').pop(), 'already');
  assert.equal(psql(`select count(*) from public.user_events where user_id='${N1}'`), '1');
});

test('the same phone cannot register twice', { skip }, () => {
  assert.equal(psql(finalizeSql(N2, PHONE)).split('\n').pop(), 'phone_taken');
  assert.equal(psql(`select registered_at is null from public.users where id='${N2}'`), 't');
  assert.equal(psql(`select count(*) from public.user_events where user_id='${N2}'`), '0');
  assert.equal(asRole('service_role', `select public.registration_phone_taken('${PHONE}')`), 't');
});

test('two simultaneous registrations with one phone: exactly one wins', { skip }, async () => {
  const phone = '+966555000111';
  const call = (u: string) => run('psql', [url!, '-qtA', '-c', finalizeSql(u, phone)]).then((r) => r.stdout.trim().split('\n').pop());
  const results = await Promise.all([call(N2), call(N3)]);
  assert.deepEqual([...results].sort(), ['completed', 'phone_taken']);
  assert.equal(psql(`select count(*) from public.users where phone_normalized='${phone}'`), '1');
});

test('unknown user is reported, not created', { skip }, () => {
  const out = psql(`set role service_role; select result_status from public.finalize_registration('99999999-9999-9999-9999-999999999999','x','+966500000000','{}'::jsonb,'e')`);
  assert.equal(out.split('\n').pop(), 'no_user');
});

test('browser roles cannot read events or call the functions', { skip }, () => {
  for (const role of ['anon', 'authenticated']) {
    assert.match(asRole(role, `select public.record_registration_tiktok('${N1}', '{}'::jsonb)`), /ERROR.*permission denied/s, role);
    assert.match(asRole(role, `select count(*) from public.user_events`), /ERROR.*permission denied/s, role);
    assert.match(asRole(role, finalizeSql(N1, PHONE).replace('set role service_role;', '')), /ERROR.*permission denied/s, role);
    assert.match(asRole(role, `select public.registration_phone_taken('${PHONE}')`), /ERROR.*permission denied/s, role);
  }
  assert.equal(asRole('service_role', `select count(*)>0 from public.user_events`), 't');
});

test('constraints reject unknown stages, event names and malformed phones', { skip }, () => {
  assert.match(asRole('service_role', `update public.users set stage='vip' where id='${N1}'`), /ERROR.*users_stage_check/s);
  assert.match(asRole('service_role', `insert into public.user_events (user_id, event) values ('${N1}', 'made_up')`), /ERROR/);
  assert.match(asRole('service_role', `update public.users set phone_normalized='0501234567' where id='${N1}'`), /ERROR.*users_phone_normalized_check/s);
  for (const stage of ['registered', 'connected', 'analysis_viewed', 'subscribed']) {
    assert.doesNotMatch(asRole('service_role', `update public.users set stage='${stage}' where id='${N1}'`), /ERROR/);
  }
  for (const ev of ['welcome_email_sent', 'onboarding_viewed', 'connect_clicked', 'ads_account_connected', 'first_analysis_viewed', 'subscription_paid']) {
    assert.doesNotMatch(asRole('service_role', `insert into public.user_events (user_id, event) values ('${N1}', '${ev}')`), /ERROR/);
  }
});

test('deleting the auth user removes their events', { skip }, () => {
  psql(`delete from auth.users where id='${N1}'`);
  assert.equal(psql(`select count(*) from public.user_events where user_id='${N1}'`), '0');
});

test('works with the welcome-email table: its trigger row is kept and enriched', { skip }, () => {
  const N4 = '44444444-4444-4444-4444-444444444444';
  // Rebuild user_events exactly as 20261012_welcome_email.sql defines it, then re-apply this migration over it.
  psql(`
    drop table public.user_events cascade;
    create table public.user_events (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.users (id) on delete cascade,
      event text not null check (event in ('registration_completed','welcome_email_sent','onboarding_viewed','connect_clicked','ads_account_connected','first_analysis_viewed','subscription_paid')),
      stage text not null default 'registered' check (stage in ('registered','connected','analysis_viewed','subscribed')),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now());
    create unique index user_events_once_per_user on public.user_events (user_id, event) where event in ('registration_completed','welcome_email_sent');
    insert into auth.users values ('${N4}');
    insert into public.users (id, email) values ('${N4}', 'n4@x.co');
    insert into public.user_events (user_id, event, stage) values ('${N4}', 'registration_completed', 'registered');
  `);
  psqlFile('db/migrations/20261012_registration_tracking.sql');
  assert.equal(psql(finalizeSql(N4, '+966500000444')).split('\n').pop(), 'completed');
  assert.equal(psql(`select count(*)||'|'||min(metadata->>'event_id') from public.user_events where user_id='${N4}' and event='registration_completed'`), `1|reg_${N4}`);
  assert.equal(asRole('service_role', `select public.record_registration_tiktok('${N4}', '{"status":"sent"}'::jsonb)`), '');
  assert.equal(psql(`select metadata->'tiktok_server'->>'status' from public.user_events where user_id='${N4}'`), 'sent');
});
