/**
 * Guards for bootstrapping a TEST database (separate Supabase project).
 *
 * Two risks this exists for:
 *  1. pointing the bootstrap at the production database by mistake;
 *  2. applying a migration that makes the test database call production, for
 *     example db/migrations/20261005_pg_cron_scheduler.sql, which schedules
 *     HTTP calls to https://ai.modaafa.com/api/cron/... from inside Postgres.
 *
 * Nothing here reads or prints a secret. The connection string is only parsed
 * for its host and user, and never returned.
 */

const REF = /^[a-z0-9]{15,30}$/;

export type TestTarget = { host: string; user: string };

export function parseDbTarget(connectionString: string): TestTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('SUPABASE_DB_URL is not a valid connection URL.');
  }
  return { host: url.hostname.toLowerCase(), user: decodeURIComponent(url.username).toLowerCase() };
}

/**
 * The caller must name the test project's ref on purpose, and it has to show up
 * in the connection's host (direct: db.<ref>.supabase.co) or user (pooler:
 * postgres.<ref>). If the production ref is supplied, the same ref is refused.
 * `local` is accepted only for a localhost or socket target (used in tests).
 */
export function assertTestTarget(options: {
  connectionString: string;
  testRef: string | undefined;
  productionRef?: string | undefined;
}): void {
  const testRef = (options.testRef ?? '').trim().toLowerCase();
  const productionRef = (options.productionRef ?? '').trim().toLowerCase();
  const { host, user } = parseDbTarget(options.connectionString);

  if (testRef === 'local') {
    if (host === 'localhost' || host === '127.0.0.1' || host === '' || host.startsWith('/')) return;
    throw new Error('TEST_ENV_PROJECT_REF=local is only allowed for a localhost database.');
  }
  if (!REF.test(testRef)) {
    throw new Error('Set TEST_ENV_PROJECT_REF to the test project ref (20 lowercase letters and digits).');
  }
  if (productionRef && testRef === productionRef) {
    throw new Error('TEST_ENV_PROJECT_REF equals the production project ref. Refusing.');
  }
  if (!host.includes(testRef) && !user.includes(testRef)) {
    throw new Error('The connection string does not point at the project named in TEST_ENV_PROJECT_REF. Refusing.');
  }
  if (productionRef && (host.includes(productionRef) || user.includes(productionRef))) {
    throw new Error('The connection string points at the production project. Refusing.');
  }
}

/** A migration that reaches outside the database or hard-codes production. */
const PRODUCTION_CALLS = [
  /ai\.modaafa\.com/i,
  /\bmodaafa\.com\/api\//i,
  /\bcron\.schedule\s*\(/i,
  /\bnet\.http_(get|post|delete)\s*\(/i,
];

export function productionCallReason(sql: string): string | null {
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const pattern of PRODUCTION_CALLS) {
    if (pattern.test(code)) return `matches ${pattern}`;
  }
  return null;
}

export function selectSkippedMigrations(files: { name: string; sql: string }[]): { name: string; reason: string }[] {
  const skipped: { name: string; reason: string }[] = [];
  for (const file of files) {
    const reason = productionCallReason(file.sql);
    if (reason) skipped.push({ name: file.name, reason });
  }
  return skipped;
}
