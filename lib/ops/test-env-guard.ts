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

const REF = /^[a-z0-9]{20}$/;

/**
 * The production project ref, known and fixed. It is refused even when the
 * PRODUCTION_SUPABASE_REF variable is missing or wrong.
 */
export const KNOWN_PRODUCTION_REF = 'xxnkubcfwabesungeskz';

export type TestTarget = { host: string; user: string };

export function parseDbTarget(connectionString: string): TestTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('SUPABASE_DB_URL is not a valid connection URL.');
  }
  // libpq lets the query string override the host (?host=, ?hostaddr=, ?service=), so a URL that looks
  // local in its authority can still connect somewhere else. Only harmless parameters are accepted.
  for (const key of url.searchParams.keys()) {
    if (!SAFE_URL_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(`The connection string has the parameter "${key.toLowerCase()}", which could change where it connects. Remove it.`);
    }
  }
  if (url.hostname.includes(',')) throw new Error('A list of hosts in the connection string is not accepted.');
  return { host: url.hostname.toLowerCase(), user: decodeURIComponent(url.username).toLowerCase() };
}

const SAFE_URL_PARAMETERS = new Set(['sslmode', 'connect_timeout', 'application_name']);

/**
 * Environment variables libpq reads that can move the connection even when the URL is fine:
 * PGHOSTADDR picks the real address, PGSERVICE / PGSERVICEFILE load a service definition.
 */
export function assertSafeConnectionEnv(env: Record<string, string | undefined>): void {
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) {
    if (env[name]) throw new Error(`${name} is set and can redirect the connection. Unset it and run again.`);
  }
}

/**
 * Read-only server check for a LOCAL database, run before any write. A localhost port that is really
 * an SSH tunnel to a hosted project looks local in the URL; a hosted Supabase server still has its
 * own roles and extensions. Returns the number of hosted markers (0 for a plain local Postgres).
 */
export const HOSTED_MARKER_SQL = `select
    (select count(*) from pg_roles where rolname in ('supabase_admin','supabase_read_only_user','supabase_replication_admin','pgbouncer'))
  + (select count(*) from pg_extension where extname in ('pg_net','pg_cron','supabase_vault','pgsodium','pg_graphql'));`;

/** True when the connection is exactly this project: direct host or pooler user. */
export function connectionIsProject(target: TestTarget, ref: string): boolean {
  if (target.host === `db.${ref}.supabase.co`) return true;
  return target.host.endsWith('.pooler.supabase.com') && target.user === `postgres.${ref}`;
}

function mentionsRef(target: TestTarget, ref: string): boolean {
  return target.host.includes(ref) || target.user.includes(ref);
}

/**
 * Rules, in order:
 *  - `local` is accepted only for a localhost target (unit and scratch tests);
 *  - otherwise TEST_ENV_PROJECT_REF is required and has to be a well-formed ref;
 *  - PRODUCTION_SUPABASE_REF is required too, so a missing variable can never
 *    turn the production check off;
 *  - the known production ref and the supplied one are both refused, as the
 *    test ref and as anything the connection mentions;
 *  - the connection must be exactly the test project (direct host
 *    db.<ref>.supabase.co, or pooler user postgres.<ref>). A ref that merely
 *    appears somewhere inside a longer host or user does not count.
 */
export function assertTestTarget(options: {
  connectionString: string;
  testRef: string | undefined;
  productionRef?: string | undefined;
}): void {
  const testRef = (options.testRef ?? '').trim().toLowerCase();
  const suppliedProduction = (options.productionRef ?? '').trim().toLowerCase();
  const target = parseDbTarget(options.connectionString);

  if (testRef === 'local') {
    if (target.host === 'localhost' || target.host === '127.0.0.1' || target.host === '::1') {
      if (mentionsRef(target, KNOWN_PRODUCTION_REF)) throw new Error('The connection mentions the production project. Refusing.');
      return;
    }
    throw new Error('TEST_ENV_PROJECT_REF=local is only allowed for a localhost database.');
  }

  if (!REF.test(testRef)) {
    throw new Error('Set TEST_ENV_PROJECT_REF to the test project ref (20 lowercase letters and digits).');
  }
  if (!REF.test(suppliedProduction)) {
    throw new Error('Set PRODUCTION_SUPABASE_REF to the production project ref. It is required for any remote database.');
  }

  const productionRefs = new Set([KNOWN_PRODUCTION_REF, suppliedProduction]);
  for (const productionRef of productionRefs) {
    if (testRef === productionRef) throw new Error('TEST_ENV_PROJECT_REF is a production project ref. Refusing.');
    if (mentionsRef(target, productionRef)) throw new Error('The connection mentions a production project. Refusing.');
  }
  if (!connectionIsProject(target, testRef)) {
    throw new Error('The connection is not exactly the project named in TEST_ENV_PROJECT_REF. Refusing.');
  }
}

/** Remove anything that could carry a credential before text is printed. */
export function redactSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[redacted-url]');
  out = out.replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=[redacted]');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
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
