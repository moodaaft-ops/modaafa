import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const databaseUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Set SUPABASE_DB_URL or DATABASE_URL before running migrations.');
  process.exit(1);
}

const versionCheck = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (versionCheck.status !== 0) {
  console.error('psql is required to apply database migrations.');
  process.exit(1);
}

const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort();

runSql(`
  create table if not exists public._modaafa_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  );
`);

for (const name of migrations) {
  const escapedName = name.replaceAll("'", "''");
  const check = runSql(
    `select exists(select 1 from public._modaafa_migrations where name = '${escapedName}');`,
    true
  );
  if (check.trim() === 't') {
    console.log(`skip ${name}`);
    continue;
  }

  const sql = readFileSync(resolve(migrationsDirectory, name), 'utf8');
  runSql(`begin;\n${sql}\ninsert into public._modaafa_migrations(name) values ('${escapedName}');\ncommit;`);
  console.log(`applied ${name}`);
}

console.log(`Database is current (${migrations.length} migrations).`);

function runSql(sql, tuplesOnly = false) {
  const args = ['--dbname', databaseUrl, '--set', 'ON_ERROR_STOP=1', '--no-psqlrc'];
  if (tuplesOnly) args.push('--tuples-only', '--no-align');
  const result = spawnSync('psql', args, {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    console.error(result.stderr.trim() || 'Migration command failed.');
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}
