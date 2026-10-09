import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { assertTestTarget, productionCallReason, selectSkippedMigrations } from '../lib/ops/test-env-guard';

const REF = 'abcdefghijklmnopqrst';
const PROD = 'zyxwvutsrqponmlkjihg';
const direct = (ref: string) => `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
const pooler = (ref: string) => `postgresql://postgres.${ref}:pw@aws-0-eu.pooler.supabase.com:6543/postgres`;

test('the test ref must be named and present in the connection', () => {
  assert.doesNotThrow(() => assertTestTarget({ connectionString: direct(REF), testRef: REF, productionRef: PROD }));
  assert.doesNotThrow(() => assertTestTarget({ connectionString: pooler(REF), testRef: REF, productionRef: PROD }));
  assert.throws(() => assertTestTarget({ connectionString: direct(REF), testRef: undefined }), /TEST_ENV_PROJECT_REF/);
  assert.throws(() => assertTestTarget({ connectionString: direct(PROD), testRef: REF }), /does not point/);
});

test('the production project is refused whichever way it is named', () => {
  assert.throws(() => assertTestTarget({ connectionString: direct(PROD), testRef: PROD, productionRef: PROD }), /production/);
  assert.throws(() => assertTestTarget({ connectionString: pooler(PROD), testRef: REF, productionRef: PROD }), /does not point|production/);
});

test('local is only accepted for a localhost database', () => {
  assert.doesNotThrow(() => assertTestTarget({ connectionString: 'postgresql://pgt@localhost:5432/x', testRef: 'local' }));
  assert.throws(() => assertTestTarget({ connectionString: direct(PROD), testRef: 'local' }), /localhost/);
});

test('an invalid connection string fails without echoing it', () => {
  assert.throws(
    () => assertTestTarget({ connectionString: 'not a url with secret-pw', testRef: REF }),
    (error: Error) => !/secret-pw/.test(error.message)
  );
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
