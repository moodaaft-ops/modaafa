/**
 * Bootstrap a TEST database: db/schema.sql (when empty) plus every migration
 * except the ones that call production, then verify nothing in the database can
 * reach ai.modaafa.com.
 *
 *   SUPABASE_DB_URL=<test project connection string> \
 *   TEST_ENV_PROJECT_REF=<test project ref> \
 *   PRODUCTION_SUPABASE_REF=<production ref, optional but recommended> \
 *   npx tsx scripts/test-env-migrate.ts [--dry-run]
 *
 * It never prints the connection string. It does not create projects or users.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertTestTarget, selectSkippedMigrations } from '../lib/ops/test-env-guard';

const databaseUrl = process.env.SUPABASE_DB_URL;
const dryRun = process.argv.includes('--dry-run');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!databaseUrl) fail('Set SUPABASE_DB_URL to the TEST database connection string.');
try {
  assertTestTarget({
    connectionString: databaseUrl,
    testRef: process.env.TEST_ENV_PROJECT_REF,
    productionRef: process.env.PRODUCTION_SUPABASE_REF,
  });
} catch (error) {
  fail((error as Error).message);
}

const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const files = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(resolve(migrationsDirectory, name), 'utf8') }));
const skipped = selectSkippedMigrations(files);

console.log(`Migrations: ${files.length}, skipped because they call production or schedule jobs: ${skipped.length}`);
for (const item of skipped) console.log(`  skip ${item.name} (${item.reason})`);
if (dryRun) {
  console.log('Dry run: nothing was changed.');
  process.exit(0);
}

function psql(sql: string, tuplesOnly = false): string {
  const args = ['--dbname', databaseUrl as string, '--set', 'ON_ERROR_STOP=1', '--no-psqlrc'];
  if (tuplesOnly) args.push('--tuples-only', '--no-align');
  const result = spawnSync('psql', args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) fail((result.stderr || 'psql failed').trim());
  return result.stdout;
}

if (spawnSync('psql', ['--version'], { encoding: 'utf8' }).status !== 0) fail('psql is required.');

const hasBase = psql(`select to_regclass('public.businesses') is not null;`, true).trim() === 't';
if (!hasBase) {
  console.log('Applying db/schema.sql (empty database).');
  psql(readFileSync(resolve(process.cwd(), 'db/schema.sql'), 'utf8'));
}

psql(`create table if not exists public._modaafa_migrations (name text primary key, applied_at timestamptz not null default now());`);
for (const item of skipped) {
  psql(`insert into public._modaafa_migrations(name) values ('${item.name.replaceAll("'", "''")}') on conflict do nothing;`);
}

const migrate = spawnSync('node', ['scripts/migrate.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, SUPABASE_DB_URL: databaseUrl },
});
if (migrate.status !== 0) fail('Migration run failed.');

// Verify: no scheduled job and no stored function body mentions production.
const hasCron = psql(`select to_regclass('cron.job') is not null;`, true).trim() === 't';
if (hasCron) {
  const jobs = psql(`select count(*) from cron.job;`, true).trim();
  if (jobs !== '0') fail(`cron.job has ${jobs} row(s) in a test database. Remove them before testing.`);
}
const leaks = psql(
  `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog','information_schema') and p.prosrc ilike '%ai.modaafa.com%';`,
  true
).trim();
if (leaks !== '0') fail(`${leaks} function(s) mention ai.modaafa.com.`);
console.log('Test database is current. No scheduled jobs, no function mentions production.');
