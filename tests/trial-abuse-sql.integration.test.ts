import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { TRIAL_EMAIL_FIXTURES } from './fixtures/trial-email-fixtures';

/**
 * Real-Postgres tests for db/migrations/20261013_trial_abuse_guards.sql.
 * Skipped unless TRIAL_ABUSE_PG_URL points at an EMPTY scratch database on this
 * machine, e.g. postgres://postgres@localhost:5544/trial_scratch. The suite
 * DROPS and recreates the stand-in tables it needs, so it refuses any host that
 * is not localhost (never production).
 *
 * It builds minimal stand-ins for auth.users, auth.uid(), roles and the tables
 * the migration reads, applies the REAL 20261009 free audit migration, seeds a
 * small trial history, then applies the new migration twice (idempotency) and
 * checks the backfill, the privileges and the per-user free audit cap.
 */
const url = process.env.TRIAL_ABUSE_PG_URL;
const isLocal = Boolean(url && /^postgres(ql)?:\/\/[^/@]*@?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url));
const skip = !url
  ? 'set TRIAL_ABUSE_PG_URL to run the SQL integration tests'
  : isLocal
    ? false
    : 'TRIAL_ABUSE_PG_URL must point at localhost (these tests drop tables)';

const U1 = '10000000-0000-0000-0000-000000000001'; // earliest email owner, shares an inbox with U2
const U2 = '10000000-0000-0000-0000-000000000002'; // same inbox as U1, later trial
const U3 = '10000000-0000-0000-0000-000000000003'; // trial via subscription row, earliest overall
const U4 = '10000000-0000-0000-0000-000000000004'; // never trialled
const U5 = '10000000-0000-0000-0000-000000000005'; // trial grant but no email
const U6 = '10000000-0000-0000-0000-000000000006'; // several accounts, one selected: only the selected one was used
const U7 = '10000000-0000-0000-0000-000000000007'; // selected account linked AFTER the trial
const U8 = '10000000-0000-0000-0000-000000000008'; // converted to paid, linked another account afterwards
const U9 = '10000000-0000-0000-0000-000000000009'; // several accounts all linked before the trial, nothing selected
const C = '20000000-0000-0000-0000-00000000000c'; // free audit cap user
const D = '20000000-0000-0000-0000-00000000000d'; // another free audit user

const SHARED = '5555555555';
const CAP_ACCOUNTS = ['9000000001', '9000000002', '9000000003', '9000000004', '9000000005'];
const capAccountId = (index: number) => `c0000000-0000-0000-0000-00000000000${index + 1}`;
const D_ACCOUNT = 'd0000000-0000-0000-0000-000000000001';
const D_CUSTOMER = '9100000001';

const MIGRATION = new URL('../db/migrations/20261013_trial_abuse_guards.sql', import.meta.url);

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
function applyFile(path: URL) {
  execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q'], { input: readFileSync(path, 'utf8') });
}
function consume(user: string, accountId: string) {
  const out = psqlAs(
    user,
    `select allowed||','||coalesce(reason,'-')||','||used||','||coalesce(event_id::text,'') from public.consume_free_audit('${accountId}')`
  );
  const [allowed, reason, used, eventId] = out.split(',');
  return { raw: out, allowed: allowed === 'true', reason, used: Number(used), eventId };
}
function complete(eventId: string, user: string, accountId: string) {
  return psqlAs(null, `select public.complete_free_audit('${eventId}','${user}','${accountId}')`, 'service_role');
}
function can(role: string, expr: string) {
  return psql(`select ${expr.replace('$ROLE', `'${role}'`)}`) === 't';
}

test('setup: stand-ins, real free audit migration, seeded trial history, new migration applied twice', { skip }, () => {
  psql(`
    drop schema if exists public cascade;
    create schema public;
    drop schema if exists auth cascade;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    alter role service_role bypassrls; -- as on Supabase
    grant usage on schema public to authenticated, service_role, anon;
    grant usage on schema auth to authenticated, service_role, anon;
    -- Supabase default privileges: new tables and functions in public are open to
    -- anon, authenticated and service_role. Reproduced so the migration is proven to close them.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

    create table auth.users (id uuid primary key, email text);
    create table public.billing_trial_grants (
      user_id uuid primary key, stripe_subscription_id text, source text, granted_at timestamptz not null default now());
    create table public.subscriptions (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, trial_ends_at timestamptz, created_at timestamptz default now());
    create table public.billing_trial_ledger (
      email_hash text primary key, granted_at timestamptz not null default now(), source text);
    create table public.businesses (
      id uuid primary key, user_id uuid not null unique, selected_google_ads_customer_id text);
    create table public.google_ads_accounts (
      id uuid primary key default gen_random_uuid(), business_id uuid not null, customer_id text not null,
      status text not null default 'active', is_manager boolean not null default false,
      linked_at timestamptz default now());
  `);
  applyFile(new URL('../db/migrations/20261009_free_audit_quota.sql', import.meta.url));

  psql(`
    insert into auth.users (id, email) values
      ('${U1}', 'First.User+a@gmail.com'), ('${U2}', 'firstuser@gmail.com'), ('${U3}', 'third@example.com'),
      ('${U4}', 'nontrial@example.com'), ('${U5}', null),
      ('${C}', 'cap@example.com'), ('${D}', 'dee@example.com');
    insert into public.businesses (id, user_id, selected_google_ads_customer_id) values
      ('${U1}', '${U1}', null), ('${U2}', '${U2}', null), ('${U3}', '${U3}', '${SHARED}'), ('${U4}', '${U4}', null),
      ('${U5}', '${U5}', null),
      ('${U6}', '${U6}', '6100000002'), ('${U7}', '${U7}', '6200000002'), ('${U8}', '${U8}', null), ('${U9}', '${U9}', null),
      ('${C}', '${C}', null), ('${D}', '${D}', null);

    insert into public.billing_trial_grants (user_id, source, granted_at) values
      ('${U1}', 'checkout_complete', '2026-08-01T10:00:00Z'),
      ('${U2}', 'stripe_webhook',    '2026-09-01T10:00:00Z'),
      ('${U5}', 'stripe_webhook',    '2026-09-15T10:00:00Z'),
      ('${U6}', 'stripe_webhook',    '2026-09-10T10:00:00Z'),
      ('${U7}', 'stripe_webhook',    '2026-09-10T10:00:00Z'),
      ('${U9}', 'stripe_webhook',    '2026-09-20T10:00:00Z');
    insert into public.subscriptions (user_id, trial_ends_at, created_at) values
      ('${U3}', '2026-07-15T00:00:00Z', '2026-07-01T00:00:00Z'),
      ('${U4}', null,                   '2026-06-01T00:00:00Z'),
      -- U8: the trial ended 2026-08-10 and Stripe kept trial_end after the conversion to paid.
      ('${U8}', '2026-08-10T00:00:00Z', '2026-08-01T00:00:00Z');

    -- A row an earlier flow already wrote must survive untouched.
    insert into public.billing_trial_ledger (email_hash, granted_at, source) values
      ('${TRIAL_EMAIL_FIXTURES.find((f) => f.input === 'owner+promo@example.com')!.key}', '2026-01-01T00:00:00Z', 'checkout_complete'),
      (encode(sha256(convert_to('third@example.com','UTF8')),'hex'), '2026-07-02T00:00:00Z', 'stripe_webhook');

    -- linked_at is the FIRST link time. Trial windows: U1 2026-08-01 to 08-15, U2 09-01 to 09-15,
    -- U3 07-01 to 07-15 (subscription row), U5 09-15 to 09-29, U6 and U7 09-10 to 09-24,
    -- U8 08-01 to 08-10, U9 09-20 to 10-04.
    insert into public.google_ads_accounts (business_id, customer_id, status, is_manager, linked_at) values
      -- U1: no selection and several candidates, so only the accounts linked DURING the window.
      ('${U1}', '1111111111', 'active', false, '2026-08-03T00:00:00Z'),
      ('${U1}', '${SHARED}',  'active', false, '2026-08-05T00:00:00Z'),
      ('${U1}', '1313131313', 'active', false, '2026-07-10T00:00:00Z'), -- before the trial: not claimed
      ('${U1}', '1212121212', 'active', false, '2026-09-20T00:00:00Z'), -- after the window: not claimed
      ('${U1}', '7777777777', 'active', true,  '2026-08-02T00:00:00Z'), -- manager
      ('${U1}', 'abc-123',    'active', false, '2026-08-02T00:00:00Z'), -- not a numeric id
      ('${U2}', '${SHARED}',  'active', false, '2026-09-02T00:00:00Z'),
      ('${U2}', '2222222222', 'revoked', false, '2026-09-05T00:00:00Z'),
      ('${U2}', '2323232323', 'active', false, '2026-08-20T00:00:00Z'), -- before the trial: not claimed
      -- U3: the selected account (SHARED) is the one the trial used; the other is not claimed.
      ('${U3}', '${SHARED}',  'active', false, '2026-06-01T00:00:00Z'),
      ('${U3}', '3333333333', 'active', false, '2026-06-15T00:00:00Z'),
      ('${U4}', '4444444444', 'active', false, '2026-06-01T00:00:00Z'), -- never trialled
      -- U5: one account linked before the trial, nothing selected: it is the only one the trial can have used.
      ('${U5}', '5000000005', 'active', false, '2026-08-01T00:00:00Z'),
      -- U6: selected 6100000002, linked before 6100000001 and long before 6100000003 (after the window).
      ('${U6}', '6100000001', 'active', false, '2026-09-11T00:00:00Z'),
      ('${U6}', '6100000002', 'active', false, '2026-09-01T00:00:00Z'),
      ('${U6}', '6100000003', 'active', false, '2026-10-05T00:00:00Z'),
      -- U7: the selected account was linked after the trial ended, so it cannot be the one used.
      ('${U7}', '6200000001', 'active', false, '2026-09-02T00:00:00Z'),
      ('${U7}', '6200000002', 'active', false, '2026-10-05T00:00:00Z'),
      -- U8: paid after the trial and linked another account later.
      ('${U8}', '6300000001', 'active', false, '2026-08-02T00:00:00Z'),
      ('${U8}', '6300000002', 'active', false, '2026-09-30T00:00:00Z'),
      -- U9: three accounts, all linked before the trial, no selection: nothing says which was used.
      ('${U9}', '6400000001', 'active', false, '2026-08-01T00:00:00Z'),
      ('${U9}', '6400000002', 'active', false, '2026-08-02T00:00:00Z'),
      ('${U9}', '6400000003', 'active', false, '2026-08-03T00:00:00Z'),
      -- a free-audit account without a trial user, no link date at all
      ('${U4}', '4444444445', 'active', false, null);

    insert into public.google_ads_accounts (id, business_id, customer_id) values
      ${CAP_ACCOUNTS.map((customer, index) => `('${capAccountId(index)}', '${C}', '${customer}')`).join(',')},
      ('${D_ACCOUNT}', '${D}', '${D_CUSTOMER}');
  `);

  applyFile(MIGRATION);
  applyFile(MIGRATION); // idempotent: the second run must not fail or change anything
});

test('migration is one explicit transaction', { skip }, () => {
  const lines = readFileSync(MIGRATION, 'utf8').split('\n').map((line) => line.trim());
  assert.equal(lines.filter((line) => line === 'begin;').length, 1);
  assert.equal(lines.filter((line) => line === 'commit;').length, 1);
  assert.ok(lines.indexOf('begin;') < lines.indexOf('commit;'));
});

test('SQL trial_email_key equals the TypeScript key on every pinned fixture', { skip }, () => {
  for (const fixture of TRIAL_EMAIL_FIXTURES) {
    const quoted = fixture.input.replaceAll("'", "''");
    assert.equal(psql(`select public.trial_email_key('${quoted}')`), fixture.key, fixture.input);
  }
  // Blank or null never yields a shared key.
  assert.equal(psql("select public.trial_email_key('   ') is null"), 't');
  assert.equal(psql('select public.trial_email_key(null) is null'), 't');
});

test('tables exist, RLS is on with no policies, ledgers are append-only for the service role', { skip }, () => {
  for (const table of ['trial_customer_ledger', 'trial_card_ledger']) {
    assert.equal(psql(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`), 't', table);
    assert.equal(psql(`select count(*) from pg_policies where tablename = '${table}'`), '0', table);
    const priv = (role: string, p: string) => can(role, `has_table_privilege($ROLE, 'public.${table}', '${p}')`);
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
        assert.equal(priv(role, p), false, `${role} must not have ${p} on ${table}`);
      }
    }
    assert.equal(priv('service_role', 'select'), true);
    assert.equal(priv('service_role', 'insert'), true);
    for (const p of ['update', 'delete', 'truncate']) assert.equal(priv('service_role', p), false, `service_role ${p} on ${table}`);
    assert.equal(psql(`select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.${table}'::regclass and a.grantee = 0`), '0');
  }
  // No foreign keys: the ledgers must survive user deletion.
  assert.equal(
    psql(`select count(*) from pg_constraint where contype = 'f' and conrelid in ('public.trial_customer_ledger'::regclass, 'public.trial_card_ledger'::regclass)`),
    '0'
  );
  // The customer id check matches the free audit ledger.
  assert.match(psqlAs(null, `insert into public.trial_customer_ledger (customer_id, first_user_id) values ('12', '${U1}')`, 'service_role'), /check constraint|violates/);
  assert.match(psqlAs(null, `insert into public.trial_customer_ledger (customer_id, first_user_id) values ('abc-123456', '${U1}')`, 'service_role'), /check constraint|violates/);
});

test('functions: trial_email_key is service-role only, consume_free_audit keeps its grants', { skip }, () => {
  const fn = (name: string) => `has_function_privilege($ROLE, 'public.${name}', 'execute')`;
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((role) => can(role, fn('trial_email_key(text)'))), [false, false, true]);
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((role) => can(role, fn('consume_free_audit(uuid)'))), [false, true, false]);
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((role) => can(role, fn('complete_free_audit(uuid, uuid, uuid)'))), [false, false, true]);
  assert.equal(
    psql(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.pronamespace = 'public'::regnamespace and p.proname in ('trial_email_key','consume_free_audit') and a.grantee = 0`),
    '0'
  );
  assert.equal(psql("select provolatile from pg_proc where proname = 'trial_email_key'"), 'i', 'IMMUTABLE');
  assert.equal(psql("select prosecdef from pg_proc where proname = 'consume_free_audit'"), 't', 'still SECURITY DEFINER');
  assert.match(psql("select array_to_string(proconfig, ',') from pg_proc where proname = 'consume_free_audit'"), /search_path=public, pg_temp/);
  assert.equal(psqlAs(null, `select public.trial_email_key('a@b.co') is not null`, 'service_role'), 't');
  assert.match(psqlAs(U1, `select public.trial_email_key('a@b.co')`), /permission denied/);
});

test('backfill: email ledger uses the normalised key, earliest user, and never overwrites', { skip }, () => {
  const rows = psql(`select email_hash||'|'||source||'|'||to_char(granted_at at time zone 'UTC','YYYY-MM-DD') from public.billing_trial_ledger order by granted_at`).split('\n');
  const key = (input: string) => TRIAL_EMAIL_FIXTURES.find((fixture) => fixture.input === input)!.key;
  assert.equal(rows.length, 3, `rows: ${rows.join(' ; ')}`);
  // The two rows written before the migration are untouched (source and date).
  assert.ok(rows.includes(`${key('owner+promo@example.com')}|checkout_complete|2026-01-01`));
  const thirdLegacy = psql(`select encode(sha256(convert_to('third@example.com','UTF8')),'hex')`);
  assert.ok(rows.includes(`${thirdLegacy}|stripe_webhook|2026-07-02`), 'existing row for third@example.com keeps its source');
  // U1 (First.User+a@gmail.com) and U2 (firstuser@gmail.com) are one inbox: one row, dated at the EARLIER trial.
  const inbox = psql(`select public.trial_email_key('firstuser@gmail.com')`);
  assert.deepEqual(rows.filter((row) => row.startsWith(`${inbox}|`)), [`${inbox}|backfill_20261013|2026-08-01`]);
  // U4 never trialled and U5 has no email: neither adds a row.
  assert.equal(psql(`select count(*) from public.billing_trial_ledger where source = 'backfill_20261013'`), '1');
});

test('backfill: customer ledger claims only the account each trial used, earliest owner wins', { skip }, () => {
  const rows = Object.fromEntries(
    psql(`select customer_id||'='||first_user_id||'@'||to_char(granted_at at time zone 'UTC','YYYY-MM-DD')||'/'||source from public.trial_customer_ledger order by customer_id`)
      .split('\n')
      .map((line) => line.split('=') as [string, string])
  );
  assert.deepEqual(rows, {
    // U1 has no selection and several accounts: the two linked during the window.
    '1111111111': `${U1}@2026-08-01/backfill_20261013`,
    // U2 likewise: the revoked link still counts (a revoked link does not undo the trial).
    '2222222222': `${U2}@2026-09-01/backfill_20261013`,
    // U5 has a single account linked before the trial.
    '5000000005': `${U5}@2026-09-15/backfill_20261013`,
    // U6 selected 6100000002 among three: only it.
    '6100000002': `${U6}@2026-09-10/backfill_20261013`,
    // U7's selected account came after the trial, so its only possible account is the other one.
    '6200000001': `${U7}@2026-09-10/backfill_20261013`,
    // U8 paid after the trial: the account linked during it, not the one linked since.
    '6300000001': `${U8}@2026-08-01/backfill_20261013`,
    // U1, U2 and U3 all qualify for SHARED; U3's trial is the earliest.
    [SHARED]: `${U3}@2026-07-01/backfill_20261013`,
  });
});

test('backfill: accounts the trial did not use are NOT claimed', { skip }, () => {
  const notClaimed = [
    '3333333333', // U3 selected SHARED, so this one was not the trial's account
    '1313131313', // U1: several accounts, linked before the trial, no selection
    '2323232323', // U2: same
    '1212121212', // U1: linked after the trial window
    '4444444444', '4444444445', // U4 never trialled
    '6100000001', '6100000003', // U6 selected another account; one was linked after the window
    '6200000002', // U7: the selected one was linked after the trial
    '6300000002', // U8: linked after the trial, once already paying
    '6400000001', '6400000002', '6400000003', // U9: cannot tell which, none linked during the window
    '7777777777', 'abc-123', // manager and non-numeric
  ];
  const quoted = notClaimed.map((id) => `'${id}'`).join(',');
  assert.equal(psql(`select count(*) from public.trial_customer_ledger where customer_id in (${quoted})`), '0');
  assert.equal(psql(`select count(*) from public.trial_customer_ledger where first_user_id in ('${U4}', '${U9}')`), '0');
});

test('backfill is idempotent: a third run changes nothing', { skip }, () => {
  const snapshot = () =>
    psql(`select (select md5(string_agg(t::text, '|' order by customer_id)) from public.trial_customer_ledger t) || (select md5(string_agg(t::text, '|' order by email_hash)) from public.billing_trial_ledger t)`);
  const before = snapshot();
  applyFile(MIGRATION);
  assert.equal(snapshot(), before);
});

test('service_role can append and read the ledgers; a duplicate is ignored, never replaced', { skip }, () => {
  const insert = `insert into public.trial_card_ledger (fingerprint, first_user_id, stripe_subscription_id) values ('fp_card_1', '${U1}', 'sub_1') on conflict (fingerprint) do nothing returning fingerprint`;
  assert.equal(psqlAs(null, insert, 'service_role'), 'fp_card_1');
  const again = `insert into public.trial_card_ledger (fingerprint, first_user_id, stripe_subscription_id) values ('fp_card_1', '${U2}', 'sub_2') on conflict (fingerprint) do nothing returning fingerprint`;
  assert.equal(psqlAs(null, again, 'service_role'), '', 'a duplicate inserts nothing');
  assert.equal(psqlAs(null, `select first_user_id||'/'||stripe_subscription_id from public.trial_card_ledger where fingerprint = 'fp_card_1'`, 'service_role'), `${U1}/sub_1`);
  assert.equal(psql("select granted_at is not null from public.trial_card_ledger where fingerprint = 'fp_card_1'"), 't');

  const customer = `insert into public.trial_customer_ledger (customer_id, first_user_id, source) values ('6000000006', '${U1}', 'checkout_complete') on conflict (customer_id) do nothing returning customer_id`;
  assert.equal(psqlAs(null, customer, 'service_role'), '6000000006');
  assert.equal(psqlAs(null, customer.replace(U1, U2), 'service_role'), '', 'a duplicate inserts nothing');
  assert.equal(psql("select first_user_id from public.trial_customer_ledger where customer_id = '6000000006'"), U1);

  // Nobody else can touch them, and the service role cannot rewrite history.
  assert.match(psqlAs(U1, 'select count(*) from public.trial_card_ledger'), /permission denied/);
  assert.match(psqlAs(null, 'select count(*) from public.trial_customer_ledger', 'anon'), /permission denied/);
  assert.match(psqlAs(null, "update public.trial_card_ledger set first_user_id = null", 'service_role'), /permission denied/);
  assert.match(psqlAs(null, "delete from public.trial_customer_ledger", 'service_role'), /permission denied/);
});

test('free audit cap: a user can spend free audits on 3 distinct customer ids, the 4th is refused', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const first = consume(C, capAccountId(0));
  assert.deepEqual([first.allowed, first.used], [true, 1]);
  assert.equal(complete(first.eventId, C, capAccountId(0)), 'completed');

  const second = consume(C, capAccountId(1));
  assert.ok(second.allowed);
  assert.equal(complete(second.eventId, C, capAccountId(1)), 'completed');

  // The third id is still free: its reservation is live while the audit runs.
  const third = consume(C, capAccountId(2));
  assert.ok(third.allowed);

  // 3 distinct ids (two completed, one live reservation): the 4th and 5th are refused.
  const fourth = consume(C, capAccountId(3));
  assert.deepEqual([fourth.allowed, fourth.reason, fourth.used, fourth.eventId], [false, 'free_accounts_exhausted', 0, '']);
  assert.equal(consume(C, capAccountId(4)).reason, 'free_accounts_exhausted');

  assert.equal(complete(third.eventId, C, capAccountId(2)), 'completed');
  assert.equal(consume(C, capAccountId(3)).reason, 'free_accounts_exhausted');
  assert.equal(psql(`select count(*) from public.free_audit_ledger where customer_id = '${CAP_ACCOUNTS[3]}'`), '0', 'a refused call writes nothing');
});

test('free audit cap: ids the user already uses are never blocked by it, and the old rules keep precedence', { skip }, () => {
  // State from the previous test: C completed 1 audit on each of ids 0, 1, 2.
  const retry = consume(C, capAccountId(0));
  assert.deepEqual([retry.allowed, retry.used], [true, 2], 'the retry on a known id is allowed');
  assert.equal(complete(retry.eventId, C, capAccountId(0)), 'completed');

  // Two completed on id 0: the per-customer limit answers, not the cap.
  assert.equal(consume(C, capAccountId(0)).reason, 'free_audits_exhausted');
  // A different user is unaffected by C's cap.
  const other = consume(D, D_ACCOUNT);
  assert.ok(other.allowed);
  assert.equal(complete(other.eventId, D, D_ACCOUNT), 'completed');
});

test('free audit cap: audit_in_progress keeps precedence on a known id', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  assert.ok(consume(C, capAccountId(0)).allowed);
  assert.equal(consume(C, capAccountId(0)).reason, 'audit_in_progress');
});

test('free audit cap: a lapsed reservation and a refunded audit do not count', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  const a = consume(C, capAccountId(0));
  const b = consume(C, capAccountId(1));
  const c = consume(C, capAccountId(2));
  assert.ok(a.allowed && b.allowed && c.allowed);
  assert.equal(consume(C, capAccountId(3)).reason, 'free_accounts_exhausted', 'three live leases fill the cap');

  // Crash: the third lease runs out. It is not live any more, so the slot is free again.
  psql(`update public.free_audit_ledger set lease_expires_at = now() - interval '1 second' where id = '${c.eventId}'`);
  const fourth = consume(C, capAccountId(3));
  assert.ok(fourth.allowed, 'the lapsed lease no longer counts');
  assert.equal(consume(C, capAccountId(2)).reason, 'free_accounts_exhausted', 'and the cap is full again');

  // Refund (service role only) deletes the reservation and frees the slot.
  assert.equal(psqlAs(null, `select public.refund_free_audit('${fourth.eventId}')`, 'service_role'), 't');
  assert.ok(consume(C, capAccountId(2)).allowed);
});

test('free audit cap: other users on the same customer ids do not use up this user\'s cap', { skip }, () => {
  psql('truncate public.free_audit_ledger');
  // D's rows on three customer ids that C does not own do nothing to C.
  psql(`insert into public.free_audit_ledger (customer_id, user_id, status, completed_at) values
    ('9200000001', '${D}', 'completed', now()), ('9200000002', '${D}', 'completed', now()), ('9200000003', '${D}', 'completed', now())`);
  assert.equal(consume(D, D_ACCOUNT).reason, 'free_accounts_exhausted', 'D is at the cap');
  assert.ok(consume(C, capAccountId(0)).allowed, 'C is not');
});

test('free audit cap: four concurrent starts on four different ids let exactly three through', { skip }, async () => {
  psql('truncate public.free_audit_ledger');
  const run = (accountId: string) =>
    new Promise<string>((resolve) => {
      const child = spawn('psql', [
        url!,
        '-qtA',
        '-c',
        `set role authenticated; set request.jwt.claim.sub='${C}'; select allowed||','||coalesce(reason,'-') from public.consume_free_audit('${accountId}')`,
      ]);
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('close', () => resolve(out.trim().split('\n').pop()!));
    });
  const results = await Promise.all([0, 1, 2, 3, 4].map((index) => run(capAccountId(index))));
  assert.equal(results.filter((result) => result === 'true,-').length, 3, results.join(' ; '));
  assert.equal(results.filter((result) => result === 'false,free_accounts_exhausted').length, 2, results.join(' ; '));
});

test('free audit cap: the start waits on a per-user lock, so concurrent starts on different ids are serialised', { skip }, async () => {
  psql('truncate public.free_audit_ledger');
  // Hold the user lock in another session for ~1.5s, then try to start an audit.
  const holder = spawn('psql', [
    url!,
    '-qtA',
    '-c',
    `begin; select pg_advisory_xact_lock(hashtextextended('free_audit_user:${C}', 0)); select pg_sleep(1.5); commit;`,
  ]);
  const holderDone = new Promise<void>((resolve) => holder.on('close', () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const startedAt = Date.now();
  const result = consume(C, capAccountId(0));
  const waitedMs = Date.now() - startedAt;
  await holderDone;
  assert.ok(result.allowed);
  assert.ok(waitedMs >= 700, `consume_free_audit returned after ${waitedMs}ms; it should have waited for the user lock`);
  // A different user is not held up by it.
  assert.ok(consume(D, D_ACCOUNT).allowed);
});
