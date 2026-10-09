// Refuses to continue when anything points at production or at a remote machine. Runs before the
// first write. It never prints a value, only the NAME of the variable and the rule that failed.
//   node preflight.mjs env                       inherited environment + docker endpoint
//   node preflight.mjs docker-endpoint           prints the ONE local daemon endpoint to use (else refuses)
//   node preflight.mjs envfile <path>            every URL in the generated env file is loopback
//   node preflight.mjs db <url> <expected-port>  loopback URL + server is not a hosted Supabase
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

// Fixed on purpose: a missing or wrong variable can never turn this check off.
const PRODUCTION_REF = 'xxnkubcfwabesungeskz';
const FORBIDDEN = [PRODUCTION_REF, 'ai.modaafa.com', '.supabase.co', '.supabase.com'];
const CONNECTION_VARS = [
  'SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL',
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'PGHOST', 'PGHOSTADDR',
];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// libpq lets the query string override the host, so any of these in a URI could redirect it.
const ALWAYS_REFUSED_VARS = ['PGSERVICE', 'PGSERVICEFILE'];

const problems = [];
const refuse = (what, rule) => problems.push(`${what}: ${rule}`);

function hostOf(value) {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function checkEnv() {
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lower = value.toLowerCase();
    for (const marker of FORBIDDEN) {
      if (lower.includes(marker)) refuse(name, 'mentions production or a hosted Supabase project');
    }
  }
  for (const name of ALWAYS_REFUSED_VARS) {
    if (process.env[name]) refuse(name, 'a service file can redirect the connection; unset it');
  }
  for (const name of CONNECTION_VARS) {
    const value = process.env[name];
    if (!value) continue;
    if (!LOOPBACK.has(hostOf(value))) refuse(name, 'is set and is not a loopback address; unset it');
  }
  resolveDockerEndpoint();
}

const LOCAL_DOCKER = (endpoint) => endpoint.startsWith('unix://') || endpoint.startsWith('npipe://');

// Which Docker daemon will the stack use? DOCKER_HOST wins over DOCKER_CONTEXT, which wins over the
// current context. Only a local socket or named pipe is accepted, and the two variables may not
// disagree. Reading a context's endpoint does not contact any daemon.
function contextEndpoint(name) {
  const args = ['context', 'inspect', ...(name ? [name] : []), '--format', '{{.Endpoints.docker.Host}}'];
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function resolveDockerEndpoint() {
  const host = process.env.DOCKER_HOST || '';
  const named = process.env.DOCKER_CONTEXT || '';
  if (host && !LOCAL_DOCKER(host)) {
    refuse('DOCKER_HOST', 'points at a remote Docker daemon; the stack must run on this machine');
    return null;
  }
  let fromContext = '';
  if (named || !host) {
    fromContext = contextEndpoint(named);
    if (!fromContext) {
      refuse(named ? 'DOCKER_CONTEXT' : 'docker context', 'could not read a Docker endpoint for it');
      return null;
    }
    if (!LOCAL_DOCKER(fromContext)) {
      refuse(named ? 'DOCKER_CONTEXT' : 'docker context', 'endpoint is not a local socket');
      return null;
    }
  }
  if (host && fromContext && host !== fromContext) {
    refuse('DOCKER_HOST and DOCKER_CONTEXT', 'name different daemons; unset one of them');
    return null;
  }
  return host || fromContext;
}

function checkEnvFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    const value = raw.replace(/^"|"$/g, '');
    for (const marker of FORBIDDEN) {
      if (value.toLowerCase().includes(marker)) refuse(name, 'mentions production or a hosted Supabase project');
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !LOOPBACK.has(hostOf(value))) refuse(name, 'URL is not loopback');
  }
}

function checkDb(urlText, expectedPort) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    refuse('database URL', 'is not a valid URL');
    return;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) refuse('database URL', 'is not a postgres URL');
  if (!LOOPBACK.has(url.hostname.toLowerCase())) refuse('database URL', 'host is not loopback');
  if (url.port !== String(expectedPort)) refuse('database URL', 'port is not the local stack port');
  if (url.search) refuse('database URL', 'has query parameters (host, hostaddr and service could redirect it)');
  if (problems.length) return;
  // Server side, read only, before any write: a hosted Supabase carries these roles and extensions.
  const sql = `select
      (select count(*) from pg_roles where rolname in ('supabase_admin','supabase_read_only_user','supabase_replication_admin','pgbouncer'))
    + (select count(*) from pg_extension where extname in ('pg_net','pg_cron','supabase_vault','pgsodium','pg_graphql'));`;
  const result = spawnSync('psql', [urlText, '-w', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (result.status !== 0) {
    refuse('database', 'could not run the read-only server check');
  } else if (result.stdout.trim() !== '0') {
    refuse('database', 'looks like a hosted Supabase server (supabase roles or extensions present)');
  }
}

const [mode, a, b] = process.argv.slice(2);
let printed = null;
if (mode === 'env') checkEnv();
else if (mode === 'docker-endpoint') printed = resolveDockerEndpoint();
else if (mode === 'envfile') checkEnvFile(a);
else if (mode === 'db') checkDb(a, b);
else {
  console.error('usage: preflight.mjs env | docker-endpoint | envfile <path> | db <url> <port>');
  process.exit(2);
}
if (problems.length) {
  console.error('PREFLIGHT REFUSED (nothing was written):');
  for (const line of problems) console.error(`  - ${line}`);
  process.exit(1);
}
if (printed) console.log(printed);
