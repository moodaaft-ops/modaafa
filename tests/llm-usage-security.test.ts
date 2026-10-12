import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeLlmUsage } from '../lib/ai/usage-report';

const migration = readFileSync(resolve('db/migrations/20261012_llm_usage.sql'), 'utf8');
const schema = readFileSync(resolve('db/schema.sql'), 'utf8');
const route = readFileSync(resolve('app/api/operations/llm-usage/route.ts'), 'utf8');

test('llm_usage is server-only: RLS on, no policies, nothing for browser roles', () => {
  assert.match(migration, /alter table public\.llm_usage enable row level security/i);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(migration, /revoke all on table public\.llm_usage from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant select, insert on table public\.llm_usage to service_role/i);
  assert.doesNotMatch(migration, /grant [^;]*\bto\b[^;]*\b(anon|authenticated)\b/i);
});

test('the cost function is SECURITY DEFINER with a pinned search_path and is service-role only', () => {
  assert.match(migration, /create or replace function public\.llm_usage_cost_since\(p_user_id uuid, p_since timestamptz\)/i);
  assert.match(migration, /security definer\s+set search_path = public/i);
  assert.match(migration, /coalesce\(sum\(cost_usd\), 0\)/i);
  assert.match(
    migration,
    /revoke all on function public\.llm_usage_cost_since\(uuid, timestamptz\)\s+from public, anon, authenticated, service_role/i
  );
  assert.match(
    migration,
    /grant execute on function public\.llm_usage_cost_since\(uuid, timestamptz\)\s+to service_role/i
  );
});

test('the migration is idempotent and runs as one transaction', () => {
  assert.match(migration, /create table if not exists public\.llm_usage/i);
  assert.equal((migration.match(/create index if not exists/gi) ?? []).length, 2);
  assert.doesNotMatch(migration, /\bdrop\s+(table|column|index|function)\b/i);
  assert.equal(migration.match(/^begin;$/gim)?.length, 1);
  assert.equal(migration.match(/^commit;$/gim)?.length, 1);
});

test('schema.sql mirrors the table, the function and the lockdown', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS llm_usage \(/);
  assert.match(schema, /feature TEXT NOT NULL CHECK \(char_length\(feature\) <= 60\)/);
  assert.match(schema, /channel TEXT CHECK \(channel IN \('text', 'voice', 'cron'\)\)/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.llm_usage_cost_since/);
  assert.match(schema, /ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /REVOKE ALL ON TABLE llm_usage FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(schema, /GRANT EXECUTE ON FUNCTION public\.llm_usage_cost_since\(UUID, TIMESTAMPTZ\)\s+TO service_role/);
  assert.doesNotMatch(schema, /CREATE POLICY[^;]*ON llm_usage/);
});

test('the operator usage route answers 404 unless the signed-in user is an operator', () => {
  assert.match(route, /isModaafaOperator\(user\.email\)/);
  assert.match(route, /if \(!user \|\| !isModaafaOperator\(user\.email\)\) return notFound\(\)/);
  assert.match(route, /status: 404/);
  // The check comes before any database read with the service role.
  assert.ok(route.indexOf('isModaafaOperator(user.email)') < route.indexOf('createAdminClient()'));
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
});

test('usage summary groups by user and feature, most expensive first', () => {
  const row = (user_id: string | null, feature: string, cost_usd: number, priced = true) => ({
    user_id,
    feature,
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 1000,
    cache_write_tokens: 0,
    cost_usd,
    priced,
  });
  const summary = summarizeLlmUsage([
    row('a', 'assistant', 0.01),
    row('a', 'assistant', 0.02),
    row('a', 'optimizer', 0.005),
    row('b', 'assistant', 0.5, false),
    row(null, 'optimizer', 0.001),
  ]);
  assert.deepEqual(
    summary.rows.map((r) => [r.userId, r.feature, r.calls, r.costUsd]),
    [
      ['b', 'assistant', 1, 0.5],
      ['a', 'assistant', 2, 0.03],
      ['a', 'optimizer', 1, 0.005],
      [null, 'optimizer', 1, 0.001],
    ]
  );
  assert.equal(summary.totals.calls, 5);
  assert.equal(summary.totals.costUsd, 0.536);
  assert.equal(summary.totals.unpricedCalls, 1);
  assert.equal(summary.totals.cacheReadTokens, 5000);
  // numeric columns can arrive as strings
  assert.equal(summarizeLlmUsage([{ ...row('a', 'x', 0), cost_usd: '0.000250' as any }]).totals.costUsd, 0.00025);
  assert.deepEqual(summarizeLlmUsage([]).rows, []);
});
