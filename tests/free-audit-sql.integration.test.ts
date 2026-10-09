import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Real-Postgres tests for db/migrations/20261009_free_audit_quota.sql.
 * Skipped unless FREE_AUDIT_PG_URL points at an EMPTY scratch database
 * (never production), e.g. postgres://postgres@localhost:5544/scratch.
 * The suite creates minimal stand-ins for auth.uid(), roles, businesses and
 * google_ads_accounts, then applies the migration twice (idempotency).
 */
const url = process.env.FREE_AUDIT_PG_URL;
const skip = url ? false : 'set FREE_AUDIT_PG_URL to run the SQL integration tests';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ACC_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC_A2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const ACC_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const CUST_A = '1234567890';
const CUST_B = '9876543210';

function psql(sql: string) {
  return execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], { encoding: 'utf8' }).trim();
}
function psqlAs(user: string | null, sql: string, role = 'authenticated') {
  const pre = `set role ${role}; ${user ? `set request.jwt.claim.sub='${user}';` : ''}`;
  try {
    return psql(`${pre} ${sql}`).split('\n').pop()!;
  } catch (error: any) {
    return `ERROR: ${String(error.stderr ?? error.message)}`;
  }
}
/** Completion is server-only: always called as service_role with event, user and account. */
function complete(eventId: string, user: string, acc: string) {
  return psqlAs(null, `select public.complete_free_audit('${eventId}','${user}','${acc}')`, 'service_role');
}
function consume(user: string, acc: string) {
  const out = psqlAs(user, `select allowed||','||coalesce(reason,'-')||','||used||','||coalesce(event_id::text,'') from public.consume_free_audit('${acc}')`);
  const [allowed, reason, used, eventId] = out.split(',');
  return { raw: out, allowed: allowed === 'true', reason, used: Number(used), eventId };
}

test('setup', { skip }, () => {
  psql(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    alter role service_role bypassrls; -- as on Supabase
    create table if not exists public.businesses (id uuid primary key, user_id uuid not null);
    create table if not exists public.google_ads_accounts (id uuid primary key, business_id uuid not null, customer_id text not null, status text not null default 'active', is_manager boolean);
    grant usage on schema public to authenticated, service_role, anon;
    -- Supabase default privileges: new tables and functions in public are open to
    -- anon, authenticated and service_role. Reproduced here so the migration is
    -- proven to close them (functions are also EXECUTE-able by PUBLIC by default).
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    drop table if exists public.free_audit_ledger cascade;
    drop function if exists public.consume_free_audit(uuid), public.complete_free_audit(uuid, uuid, uuid), public.refund_free_audit(uuid);
    grant usage on schema auth to authenticated, service_role, anon;
    truncate public.google_ads_accounts, public.businesses;
    insert into public.businesses values ('${A}'::uuid, '${A}'::uuid), ('${B}'::uuid, '${B}'::uuid);
    insert into public.google_ads_accounts (id, business_id, customer_id) values
      ('${ACC_A}', '${A}', '${CUST_A}'), ('${ACC_A2}', '${A}', '${CUST_A}'), ('${ACC_B}', '${B}', '${CUST_B}');
  `);
  const sql = readFileSync(new URL('../db/migrations/20261009_free_audit_quota.sql', import.meta.url), 'utf8');
  execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql });
  execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql }); // idempotent
  psql('truncate public.free_audit_ledger');
});

test('migration is one explicit transaction', { skip }, () => {
  const sql = readFileSync(new URL('../db/migrations/20261009_free_audit_quota.sql', import.meta.url), 'utf8');
  const lines = sql.split('\n').map((l) => l.trim());
  assert.equal(lines.filter((l) => l === 'begin;').length, 1);
  assert.equal(lines.filter((l) => l === 'commit;').length, 1);
  assert.ok(lines.indexOf('begin;') < lines.indexOf('commit;'));
});

test('privileges after the migration, with Supabase default privileges in place', { skip }, () => {
  const can = (role: string, expr: string) => psql(`select ${expr.replace('$ROLE', `'${role}'`)}`) === 't';
  const ledger = (priv: string) => `has_table_privilege($ROLE, 'public.free_audit_ledger', '${priv}')`;
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
      assert.equal(can(role, ledger(priv)), false, `${role} must not have ${priv} on the ledger`);
    }
  }
  // service_role: SELECT only (the audit page reads the allowance); writes go through the functions.
  assert.equal(can('service_role', ledger('select')), true);
  for (const priv of ['insert', 'update', 'delete', 'truncate']) {
    assert.equal(can('service_role', ledger(priv)), false, `service_role has no direct ${priv}`);
  }
  // PUBLIC (grantee 0) holds nothing on the table or on any of the three functions.
  assert.equal(psql(`select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.free_audit_ledger'::regclass and a.grantee = 0`), '0');
  assert.equal(
    psql(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.pronamespace = 'public'::regnamespace and p.proname in ('consume_free_audit','complete_free_audit','refund_free_audit') and a.grantee = 0`),
    '0'
  );
  const fn = (name: string) => `has_function_privilege($ROLE, 'public.${name}', 'execute')`;
  const consume = 'consume_free_audit(uuid)';
  const complete = 'complete_free_audit(uuid, uuid, uuid)';
  const refund = 'refund_free_audit(uuid)';
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((r) => can(r, fn(consume))), [false, true, false]);
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((r) => can(r, fn(complete))), [false, false, true]);
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((r) => can(r, fn(refund))), [false, false, true]);
  // RLS stays on with no policies.
  assert.equal(psql("select relrowsecurity from pg_class where oid = 'public.free_audit_ledger'::regclass"), 't');
  assert.equal(psql("select count(*) from pg_policies where tablename = 'free_audit_ledger'"), '0');
});

test('anon and PUBLIC get no direct access, complete or refund (real calls)', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const r = consume(A, ACC_A);
  assert.ok(r.allowed);
  assert.match(psqlAs(null, 'select count(*) from public.free_audit_ledger', 'anon'), /permission denied/);
  assert.match(psqlAs(null, `select public.complete_free_audit('${r.eventId}','${A}','${ACC_A}')`, 'anon'), /permission denied/);
  assert.match(psqlAs(null, `select public.refund_free_audit('${r.eventId}')`, 'anon'), /permission denied/);
  assert.match(psqlAs(null, `select * from public.consume_free_audit('${ACC_A}')`, 'anon'), /permission denied/);
  // authenticated: no complete, no refund, no table writes, even for its own reservation
  assert.match(psqlAs(A, `select public.complete_free_audit('${r.eventId}','${A}','${ACC_A}')`), /permission denied/);
  assert.match(psqlAs(A, `select public.refund_free_audit('${r.eventId}')`), /permission denied/);
  assert.match(psqlAs(A, `insert into public.free_audit_ledger (customer_id, user_id) values ('${CUST_A}', '${A}')`), /permission denied/);
  // service_role cannot write the table directly either
  assert.match(psqlAs(null, `delete from public.free_audit_ledger`, 'service_role'), /permission denied/);
  assert.equal(psqlAs(null, 'select count(*) from public.free_audit_ledger', 'service_role'), '1');
  assert.equal(psql(`select status from public.free_audit_ledger where id='${r.eventId}'`), 'reserved');
});

test('user A cannot reserve or burn the allowance of account B', { skip }, () => {
  const out = psqlAs(A, `select * from public.consume_free_audit('${ACC_B}')`);
  assert.match(out, /forbidden/);
  assert.equal(psql(`select count(*) from public.free_audit_ledger where customer_id='${CUST_B}'`), '0');
  assert.match(psqlAs(A, `select * from public.consume_free_audit('${randomUuid()}')`), /forbidden/);
  assert.match(psqlAs(null, `select * from public.consume_free_audit('${ACC_A}')`), /forbidden/);
});

test('limit and lease cannot be overridden: the only parameter is the account id', { skip }, () => {
  assert.match(psqlAs(A, `select * from public.consume_free_audit('${ACC_A}', 100)`), /does not exist/);
  assert.match(psqlAs(A, `select * from public.consume_free_audit(p_account_id => '${ACC_A}', p_limit => 100, p_inflight_seconds => 0)`), /does not exist|not exist/);
  assert.match(psqlAs(A, `select public.complete_free_audit('${A}'::uuid, '${A}'::uuid)`), /does not exist/);
  assert.match(psqlAs(A, `select public.complete_free_audit('${A}'::uuid)`), /does not exist/);
});

test('no direct table access or refund for authenticated users', { skip }, () => {
  assert.match(psqlAs(A, 'select count(*) from public.free_audit_ledger'), /permission denied/);
  assert.match(psqlAs(A, `select public.refund_free_audit('${A}')`), /permission denied/);
  assert.match(psqlAs(A, `delete from public.free_audit_ledger`), /permission denied/);
});

test('authenticated users cannot complete a reservation, not even their own', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const r = consume(A, ACC_A);
  assert.ok(r.allowed);
  const direct = psqlAs(A, `select public.complete_free_audit('${r.eventId}','${A}','${ACC_A}')`);
  assert.match(direct, /permission denied/);
  assert.match(psqlAs(null, `select public.complete_free_audit('${r.eventId}','${A}','${ACC_A}')`, 'anon'), /permission denied/);
  assert.equal(psql(`select status from public.free_audit_ledger where id='${r.eventId}'`), 'reserved');
  // the audit is still running, so a second start stays blocked
  assert.equal(consume(A, ACC_A).reason, 'audit_in_progress');
});

test('server completion verifies event, user and account', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const r = consume(A, ACC_A);
  assert.equal(complete(r.eventId, B, ACC_A), 'not_found', 'wrong user');
  assert.equal(complete(r.eventId, A, ACC_A2), 'not_found', 'wrong account');
  assert.equal(complete(r.eventId, A, ACC_B), 'not_found', 'foreign account');
  assert.equal(complete(randomUuid(), A, ACC_A), 'not_found', 'unknown event');
  assert.equal(psql(`select status from public.free_audit_ledger where id='${r.eventId}'`), 'reserved');
  assert.equal(complete(r.eventId, A, ACC_A), 'completed');
});

test('12 concurrent requests reserve exactly once', { skip }, async () => {
  psql('truncate public.free_audit_ledger');
  const run = () => new Promise<string>((resolve) => {
    const p = spawn('psql', [url!, '-qtA', '-c', `set role authenticated; set request.jwt.claim.sub='${A}'; select allowed||','||coalesce(reason,'-') from public.consume_free_audit('${ACC_A}')`]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim().split('\n').pop()!));
  });
  const results = await Promise.all(Array.from({ length: 12 }, run));
  assert.equal(results.filter((r) => r === 'true,-').length, 1);
  assert.equal(results.filter((r) => r === 'false,audit_in_progress').length, 11);
});

test('two audits max, per Google customer id, across account rows', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const first = consume(A, ACC_A);
  assert.ok(first.allowed);
  assert.equal(complete(first.eventId, A, ACC_A), 'completed');
  assert.equal(complete(first.eventId, A, ACC_A), 'already_completed');
  // a second account row (relink) with the same customer id shares the counter
  const second = consume(A, ACC_A2);
  assert.ok(second.allowed);
  assert.equal(second.used, 2);
  complete(second.eventId, A, ACC_A2);
  const third = consume(A, ACC_A);
  assert.equal(third.reason, 'free_audits_exhausted');
  // unlink + delete the account row: ledger survives, allowance does not reset
  psql(`delete from public.google_ads_accounts where id='${ACC_A2}'`);
  psql(`insert into public.google_ads_accounts (id, business_id, customer_id) values ('${ACC_A2}', '${A}', '${CUST_A}')`);
  assert.equal(consume(A, ACC_A2).reason, 'free_audits_exhausted');
  // another customer is independent
  assert.ok(consume(B, ACC_B).allowed);
});

test('abandoned reservation (server crash) does not burn the audits; completion is lease-bound', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const crashed = consume(A, ACC_A);
  assert.ok(crashed.allowed);
  // still running: blocked
  assert.equal(consume(A, ACC_A).reason, 'audit_in_progress');
  // simulate the lease running out without completion
  psql(`update public.free_audit_ledger set lease_expires_at = now() - interval '1 second' where id='${crashed.eventId}'`);
  const retry = consume(A, ACC_A);
  assert.ok(retry.allowed, 'abandoned reservation stops blocking');
  assert.equal(retry.used, 1, 'and stops counting');
  assert.equal(psql(`select status from public.free_audit_ledger where id='${crashed.eventId}'`), 'abandoned');
  // a late completion of the crashed run must not count
  assert.equal(complete(crashed.eventId, A, ACC_A), 'expired');
  assert.equal(complete(retry.eventId, A, ACC_A), 'completed');
  // another user cannot complete somebody else's reservation
  assert.equal(complete(retry.eventId, B, ACC_A), 'not_found');
});

test('failed audit refund (service role only) restores the allowance', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const r = consume(A, ACC_A);
  assert.equal(psqlAs(null, `select public.refund_free_audit('${r.eventId}')`, 'service_role'), 't');
  assert.ok(consume(A, ACC_A).allowed);
});

function randomUuid() {
  return 'cccccccc-0000-0000-0000-00000000000f';
}
