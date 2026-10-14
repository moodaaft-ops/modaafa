import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve('db/migrations/20261012_jarvis_playbook.sql'), 'utf8');
const schema = readFileSync(resolve('db/schema.sql'), 'utf8');
const importScript = readFileSync(resolve('scripts/jarvis/import-playbook.ts'), 'utf8');
const buildScript = readFileSync(resolve('scripts/jarvis/build-playbook.ts'), 'utf8');
const gitignore = readFileSync(resolve('.gitignore'), 'utf8');

test('jarvis_playbook_chunks is server-only: RLS on, no policies, nothing for browser roles', () => {
  assert.match(migration, /ALTER TABLE public\.jarvis_playbook_chunks ENABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(migration, /CREATE POLICY/i);
  assert.match(
    migration,
    /REVOKE ALL ON TABLE public\.jarvis_playbook_chunks FROM PUBLIC, anon, authenticated, service_role/i
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.jarvis_playbook_chunks TO service_role/i
  );
  // The only grant in the file goes to the service role.
  const grants = migration.match(/^GRANT [^;]*;/gim) ?? [];
  assert.equal(grants.length, 1);
  const grantees = grants[0].match(/\bTO\s+([^;]+);/i)?.[1] ?? '';
  assert.equal(grantees.trim(), 'service_role');
  // The revoke comes before the grant.
  assert.ok(migration.search(/REVOKE ALL ON TABLE/i) < migration.search(/GRANT SELECT/i));
});

test('the table has exactly the specified columns and ids that match the retrieval pattern', () => {
  const table = migration.match(/CREATE TABLE IF NOT EXISTS public\.jarvis_playbook_chunks \(([\s\S]*?)\n\);/i)?.[1] ?? '';
  const columns = [...table.matchAll(/^\s{2}([a-z_]+) (TEXT\[\]|TEXT|BOOLEAN|INTEGER|TIMESTAMPTZ)(?=\s|,)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(columns, [
    'id TEXT',
    'version TEXT',
    'file TEXT',
    'section TEXT',
    'title_ar TEXT',
    'summary_ar TEXT',
    'tags TEXT[]',
    'campaign_types TEXT[]',
    'volatile BOOLEAN',
    'tokens INTEGER',
    'body_ar TEXT',
    'updated_at TIMESTAMPTZ',
  ]);
  assert.match(table, /id TEXT PRIMARY KEY\s+CHECK \(id ~ '\^\[a-z\]\{2,6\}-\[0-9\]\{2,3\}\$'\)/);
  assert.match(table, /version TEXT NOT NULL/);
  assert.match(table, /title_ar TEXT NOT NULL/);
  assert.match(table, /summary_ar TEXT NOT NULL/);
  assert.match(table, /tags TEXT\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(table, /campaign_types TEXT\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(table, /volatile BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(table, /tokens INTEGER NOT NULL/);
  assert.match(table, /body_ar TEXT NOT NULL/);
  assert.match(table, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('the migration is idempotent, forward-only and carries no playbook text', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.jarvis_playbook_chunks/i);
  assert.equal((migration.match(/CREATE INDEX IF NOT EXISTS/gi) ?? []).length, 1);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|POLICY)\b/i);
  assert.doesNotMatch(migration, /^\s*(INSERT\s+INTO|COPY\s|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)/im);
  // Comments may be Arabic-free English only: the knowledge base never lands in SQL.
  assert.ok(migration.length < 3000);
});

test('schema.sql mirrors the table, the index and the lockdown', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS jarvis_playbook_chunks \(/);
  assert.match(schema, /id TEXT PRIMARY KEY CHECK \(id ~ '\^\[a-z\]\{2,6\}-\[0-9\]\{2,3\}\$'\)/);
  assert.match(schema, /CREATE INDEX idx_jarvis_playbook_chunks_version ON jarvis_playbook_chunks\(version\)/);
  assert.match(schema, /ALTER TABLE jarvis_playbook_chunks ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /REVOKE ALL ON TABLE jarvis_playbook_chunks FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(schema, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE jarvis_playbook_chunks TO service_role/);
  assert.doesNotMatch(schema, /CREATE POLICY[^;]*ON jarvis_playbook_chunks/);
  assert.doesNotMatch(schema, /GRANT [^;]*ON TABLE jarvis_playbook_chunks TO [^;]*\b(anon|authenticated)\b/);
});

test('the private build output is gitignored and nothing playbook-shaped is committed', () => {
  assert.match(gitignore, /^\.playbook-build\/$/m);
  assert.equal(existsSync(resolve('lib/jarvis/playbook/chunks.json')), false);
  const files = readdirSync(resolve('lib/jarvis/playbook'));
  // core-rules.ts is the dependency-free home of the always-on rules (already public in index.ts), shared with the optimizer.
  assert.deepEqual(files.sort(), ['build.ts', 'core-rules.ts', 'index.ts', 'types.ts']);
  // The scripts write under the ignored folder by default.
  assert.match(buildScript, /\.playbook-build\/chunks\.json/);
  assert.match(importScript, /\.playbook-build\/chunks\.json/);
});

test('the scripts are manual tools: not wired into package.json scripts, CI or cron', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(Object.values(pkg.scripts).every((command) => !/playbook|scripts\/jarvis/.test(command)));
  const workflows = existsSync(resolve('.github/workflows')) ? readdirSync(resolve('.github/workflows')) : [];
  for (const name of workflows) {
    assert.doesNotMatch(readFileSync(resolve('.github/workflows', name), 'utf8'), /playbook|scripts\/jarvis/);
  }
  assert.doesNotMatch(readFileSync(resolve('vercel.json'), 'utf8'), /playbook/);
  assert.doesNotMatch(readFileSync(resolve('scheduled-jobs.yml'), 'utf8'), /playbook/);
});

test('the import script uses the service role only, validates first, and deletes old versions last', () => {
  assert.match(importScript, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(importScript, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(importScript, /ANON_KEY/);
  // Refuses on a denied term before any network call.
  assert.ok(importScript.indexOf('validatePlaybookChunks') < importScript.indexOf('createClient('));
  assert.match(importScript, /Refusing to import/);
  // Upserts every batch, and only then removes rows of other versions.
  assert.ok(importScript.indexOf('.upsert(') < importScript.indexOf('.neq(\'version\', version)'));
  assert.match(importScript, /onConflict: 'id'/);
  assert.match(importScript, /--dry-run/);
});
