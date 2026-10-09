import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { KNOWN_PRODUCTION_REF, assertTestTarget, productionCallReason, redactSecrets, selectSkippedMigrations } from '../lib/ops/test-env-guard';

const REF = 'abcdefghijklmnopqrst';
const PROD = 'zyxwvutsrqponmlkjihg';
const direct = (ref: string) => `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
const pooler = (ref: string) => `postgresql://postgres.${ref}:pw@aws-0-eu.pooler.supabase.com:6543/postgres`;

test('the test ref must be named, and the connection must be exactly that project', () => {
  assert.doesNotThrow(() => assertTestTarget({ connectionString: direct(REF), testRef: REF, productionRef: PROD }));
  assert.doesNotThrow(() => assertTestTarget({ connectionString: pooler(REF), testRef: REF, productionRef: PROD }));
  assert.throws(() => assertTestTarget({ connectionString: direct(REF), testRef: undefined, productionRef: PROD }), /TEST_ENV_PROJECT_REF/);
  assert.throws(() => assertTestTarget({ connectionString: direct('qqqqqqqqqqqqqqqqqqqq'), testRef: REF, productionRef: PROD }), /not exactly/);
});

test('PRODUCTION_SUPABASE_REF is mandatory for a remote database', () => {
  assert.throws(() => assertTestTarget({ connectionString: direct(REF), testRef: REF }), /PRODUCTION_SUPABASE_REF/);
  assert.throws(() => assertTestTarget({ connectionString: direct(REF), testRef: REF, productionRef: '' }), /PRODUCTION_SUPABASE_REF/);
  assert.throws(() => assertTestTarget({ connectionString: direct(REF), testRef: REF, productionRef: 'short' }), /PRODUCTION_SUPABASE_REF/);
});

test('the known production ref is refused even when the variable is missing or wrong', () => {
  for (const connectionString of [direct(KNOWN_PRODUCTION_REF), pooler(KNOWN_PRODUCTION_REF)]) {
    assert.throws(() => assertTestTarget({ connectionString, testRef: KNOWN_PRODUCTION_REF, productionRef: PROD }), /production/);
    assert.throws(() => assertTestTarget({ connectionString, testRef: KNOWN_PRODUCTION_REF, productionRef: KNOWN_PRODUCTION_REF }), /production/);
    assert.throws(() => assertTestTarget({ connectionString, testRef: REF, productionRef: PROD }), /production/);
  }
  // prod used as the test ref with no productionRef at all stops on the missing variable, never passes.
  assert.throws(() => assertTestTarget({ connectionString: direct(KNOWN_PRODUCTION_REF), testRef: KNOWN_PRODUCTION_REF }));
});

test('a supplied production ref is refused too', () => {
  assert.throws(() => assertTestTarget({ connectionString: direct(PROD), testRef: PROD, productionRef: PROD }), /production/);
  assert.throws(() => assertTestTarget({ connectionString: pooler(PROD), testRef: REF, productionRef: PROD }), /production/);
});

test('a ref that only appears inside a longer host or user does not match', () => {
  const cases = [
    `postgresql://postgres:pw@db.${REF}.evil.com:5432/postgres`,
    `postgresql://postgres:pw@evil-${REF}.supabase.co:5432/postgres`,
    `postgresql://postgres:pw@db.${REF}x.supabase.co:5432/postgres`,
    `postgresql://postgres:pw@xdb.${REF}.supabase.co:5432/postgres`,
    `postgresql://postgres.${REF}x:pw@aws-0-eu.pooler.supabase.com:6543/postgres`,
    `postgresql://xpostgres.${REF}:pw@aws-0-eu.pooler.supabase.com:6543/postgres`,
    `postgresql://postgres.${REF}:pw@pooler.supabase.com.evil.com:6543/postgres`,
    `postgresql://postgres.${REF}:pw@db.example.com:6543/postgres`,
    `postgresql://postgres:pw@db.example.com:5432/${REF}`,
  ];
  for (const connectionString of cases) {
    assert.throws(() => assertTestTarget({ connectionString, testRef: REF, productionRef: PROD }), /not exactly/, connectionString.replace('pw', '***'));
  }
});

test('local is only accepted for a localhost database', () => {
  assert.doesNotThrow(() => assertTestTarget({ connectionString: 'postgresql://pgt@localhost:5432/x', testRef: 'local' }));
  assert.throws(() => assertTestTarget({ connectionString: direct(PROD), testRef: 'local' }), /localhost/);
  assert.throws(() => assertTestTarget({ connectionString: direct(KNOWN_PRODUCTION_REF), testRef: 'local' }), /localhost/);
});

test('an invalid connection string fails without echoing it', () => {
  assert.throws(
    () => assertTestTarget({ connectionString: 'not a url with secret-pw', testRef: REF, productionRef: PROD }),
    (error: Error) => !/secret-pw/.test(error.message)
  );
});

test('redaction removes URLs, passwords and listed secrets', () => {
  const out = redactSecrets('psql: error connecting postgresql://u:hunter2@h:5432/db password=abc123 token zzz-secret-zzz', ['zzz-secret-zzz']);
  assert.ok(!/hunter2|abc123|zzz-secret-zzz|postgresql:/.test(out), out);
});

test('migrations that call production or schedule jobs are detected', () => {
  assert.ok(productionCallReason(`select cron.schedule('x','* * * * *',$$select 1$$);`));
  assert.ok(productionCallReason(`select net.http_get(url := 'https://ai.modaafa.com/api/cron/a');`));
  assert.equal(productionCallReason(`-- see https://ai.modaafa.com for docs\ncreate table t(id int);`), null);
  assert.equal(productionCallReason(`create table t(id int);`), null);
});

test('the real migrations skip exactly the pg_cron scheduler today', () => {
  const dir = resolve(process.cwd(), 'db/migrations');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
  const skipped = selectSkippedMigrations(files).map((item) => item.name);
  assert.deepEqual(skipped, ['20261005_pg_cron_scheduler.sql']);
});

test('db/schema.sql itself does not call production', () => {
  assert.equal(productionCallReason(readFileSync(resolve(process.cwd(), 'db/schema.sql'), 'utf8')), null);
});
