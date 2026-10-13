import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Real-Postgres tests for db/migrations/20261012_llm_usage.sql.
 * Skipped unless LLM_USAGE_PG_URL points at an EMPTY scratch database (never
 * production), e.g. postgres://postgres@localhost:5544/scratch.
 * The suite creates stand-ins for the Supabase roles and for the users and
 * google_ads_accounts tables, reproduces Supabase's default privileges, and
 * applies the migration twice (idempotency).
 */
const url = process.env.LLM_USAGE_PG_URL;
const skip = url ? false : 'set LLM_USAGE_PG_URL to run the SQL integration tests';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const ACC = 'aaaaaaaa-0000-0000-0000-000000000001';

const migrationSql = () => readFileSync(new URL('../db/migrations/20261012_llm_usage.sql', import.meta.url), 'utf8');
const applyMigration = () =>
  execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q'], { input: migrationSql() });

function psql(sql: string) {
  return execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], { encoding: 'utf8' }).trim();
}
function psqlAs(role: 'anon' | 'authenticated' | 'service_role', sql: string) {
  try {
    return psql(`set role ${role}; ${sql}`).split('\n').pop()!;
  } catch (error: any) {
    return `ERROR: ${String(error.stderr ?? error.message)}`;
  }
}
const can = (role: string, expr: string) => psql(`select ${expr.replace('$ROLE', `'${role}'`)}`) === 't';

test('setup', { skip }, () => {
  psql(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    alter role service_role bypassrls; -- as on Supabase
    grant usage on schema public to anon, authenticated, service_role;
    -- Supabase default privileges: new tables and functions in public are open to
    -- anon, authenticated and service_role, and functions to PUBLIC. Reproduced here
    -- so the migration is proven to close them.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    drop function if exists public.llm_usage_cost_since(uuid, timestamptz);
    drop table if exists public.llm_usage cascade;
    drop table if exists public.google_ads_accounts, public.users cascade;
    create table public.users (id uuid primary key);
    create table public.google_ads_accounts (id uuid primary key);
    insert into public.users values ('${A}'), ('${B}'), ('${C}');
    insert into public.google_ads_accounts values ('${ACC}');
  `);
  applyMigration();
  applyMigration(); // idempotent
});

test('privileges after the migration, with Supabase default privileges in place', { skip }, () => {
  const table = (priv: string) => `has_table_privilege($ROLE, 'public.llm_usage', '${priv}')`;
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
      assert.equal(can(role, table(priv)), false, `${role} must not have ${priv}`);
    }
  }
  assert.equal(can('service_role', table('select')), true);
  assert.equal(can('service_role', table('insert')), true);
  for (const priv of ['update', 'delete', 'truncate']) {
    assert.equal(can('service_role', table(priv)), false, `service_role has no ${priv}`);
  }
  assert.equal(psql(`select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.llm_usage'::regclass and a.grantee = 0`), '0');

  const fn = `has_function_privilege($ROLE, 'public.llm_usage_cost_since(uuid, timestamptz)', 'execute')`;
  assert.deepEqual(['anon', 'authenticated', 'service_role'].map((r) => can(r, fn)), [false, false, true]);
  assert.equal(
    psql(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.proname = 'llm_usage_cost_since' and a.grantee = 0`),
    '0'
  );

  assert.equal(psql("select relrowsecurity from pg_class where oid = 'public.llm_usage'::regclass"), 't');
  assert.equal(psql("select count(*) from pg_policies where tablename = 'llm_usage'"), '0');
  assert.equal(psql("select obj_description('public.llm_usage'::regclass, 'pg_class') is not null"), 't');
  assert.equal(psql("select prosecdef from pg_proc where proname = 'llm_usage_cost_since'"), 't');
  assert.match(psql("select array_to_string(proconfig, ',') from pg_proc where proname = 'llm_usage_cost_since'"), /search_path=public/);
});

test('anon and authenticated cannot read, write or call the function (real calls)', { skip }, () => {
  for (const role of ['anon', 'authenticated'] as const) {
    assert.match(psqlAs(role, 'select count(*) from public.llm_usage'), /permission denied/i, `${role} select`);
    assert.match(
      psqlAs(role, `insert into public.llm_usage (feature, model) values ('x', 'y')`),
      /permission denied/i,
      `${role} insert`
    );
    assert.match(
      psqlAs(role, `select public.llm_usage_cost_since('${A}', now() - interval '1 day')`),
      /permission denied/i,
      `${role} function`
    );
  }
});

test('service_role appends rows and the function sums per user since a point in time', { skip }, () => {
  psql('truncate public.llm_usage');
  const insert = (user: string | null, cost: string, age: string, feature = 'assistant') =>
    psqlAs(
      'service_role',
      `insert into public.llm_usage (user_id, account_id, feature, channel, model, cost_usd, created_at)
       values (${user ? `'${user}'` : 'null'}, '${ACC}', '${feature}', 'text', 'claude-sonnet-5-5', ${cost}, now() - interval '${age}')`
    );
  insert(A, '0.045000', '1 hour');
  insert(A, '0.010000', '2 hours', 'optimizer');
  insert(A, '0.500000', '40 days'); // outside the window
  insert(B, '1.250000', '1 hour');
  insert(null, '9.000000', '1 hour'); // unattributed rows never count for a user

  const since = (user: string, interval: string) =>
    psqlAs('service_role', `select public.llm_usage_cost_since('${user}', now() - interval '${interval}')`);
  assert.equal(Number(since(A, '1 day')), 0.055);
  assert.equal(Number(since(A, '90 days')), 0.555);
  assert.equal(Number(since(B, '1 day')), 1.25);
  assert.equal(Number(since(C, '1 day')), 0, 'a user with no rows gets 0, not NULL');
  assert.equal(psqlAs('service_role', `select public.llm_usage_cost_since('${C}', now()) is null`), 'f');
  // a window that starts after every row is empty
  assert.equal(Number(psqlAs('service_role', `select public.llm_usage_cost_since('${A}', now() + interval '1 hour')`)), 0);
});

test('defaults and constraints', { skip }, () => {
  psql('truncate public.llm_usage');
  psqlAs('service_role', `insert into public.llm_usage (feature, model) values ('assistant', 'claude-sonnet-5-5')`);
  assert.equal(
    psql(`select concat_ws(',', input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, priced, tool_rounds) from public.llm_usage`),
    '0,0,0,0,0.000000,t,0'
  );
  assert.equal(psql('select id is not null and created_at is not null and latency_ms is null from public.llm_usage'), 't');

  assert.match(
    psqlAs('service_role', `insert into public.llm_usage (feature, model) values ('${'f'.repeat(61)}', 'm')`),
    /violates check constraint/i,
    'feature longer than 60'
  );
  assert.doesNotMatch(
    psqlAs('service_role', `insert into public.llm_usage (feature, model) values ('${'f'.repeat(60)}', 'm')`),
    /ERROR/
  );
  assert.match(
    psqlAs('service_role', `insert into public.llm_usage (feature, model, channel) values ('x', 'm', 'fax')`),
    /violates check constraint/i,
    'unknown channel'
  );
  for (const channel of ['text', 'voice', 'cron']) {
    assert.doesNotMatch(
      psqlAs('service_role', `insert into public.llm_usage (feature, model, channel) values ('x', 'm', '${channel}')`),
      /ERROR/
    );
  }
  assert.match(
    psqlAs('service_role', `insert into public.llm_usage (feature, model, user_id) values ('x', 'm', '${'9'.repeat(8)}-9999-9999-9999-${'9'.repeat(12)}')`),
    /foreign key/i,
    'unknown user'
  );
});

test('deleting a user keeps the ledger row with a null user', { skip }, () => {
  psql('truncate public.llm_usage');
  psql(`insert into public.users values ('44444444-4444-4444-4444-444444444444')`);
  psqlAs('service_role', `insert into public.llm_usage (user_id, feature, model, cost_usd) values ('44444444-4444-4444-4444-444444444444', 'assistant', 'm', 0.1)`);
  psql(`delete from public.users where id = '44444444-4444-4444-4444-444444444444'`);
  assert.equal(psql(`select count(*) from public.llm_usage where user_id is null and cost_usd = 0.1`), '1');
  psql(`delete from public.google_ads_accounts where id = '${ACC}'`);
  psql(`insert into public.google_ads_accounts values ('${ACC}')`);
});

test('re-applying the migration keeps existing rows', { skip }, () => {
  psql('truncate public.llm_usage');
  psqlAs('service_role', `insert into public.llm_usage (user_id, feature, model, cost_usd) values ('${A}', 'assistant', 'm', 0.25)`);
  applyMigration();
  assert.equal(psql('select count(*) from public.llm_usage'), '1');
  assert.equal(Number(psqlAs('service_role', `select public.llm_usage_cost_since('${A}', now() - interval '1 day')`)), 0.25);
  assert.equal(psql(`select count(*) from pg_indexes where tablename = 'llm_usage' and indexname in ('idx_llm_usage_user_created', 'idx_llm_usage_created')`), '2');
});

test('migration is one explicit transaction', { skip }, () => {
  const lines = migrationSql().split('\n').map((l) => l.trim());
  assert.equal(lines.filter((l) => l === 'begin;').length, 1);
  assert.equal(lines.filter((l) => l === 'commit;').length, 1);
  assert.ok(lines.indexOf('begin;') < lines.indexOf('commit;'));
});
