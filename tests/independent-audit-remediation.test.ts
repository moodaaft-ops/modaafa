import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildAuditReportRow } from '../lib/audit/report';

test('quota refunds are service-role-only in the production hardening migration', () => {
  const migration = readFileSync(
    resolve('db/migrations/20260812_independent_audit_hardening.sql'),
    'utf8'
  );

  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.refund_feature_usage\(UUID, UUID\) FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.refund_feature_usage\(UUID, UUID\) TO service_role/i
  );
  assert.match(migration, /auth\.role\(\) IS DISTINCT FROM 'service_role'/i);
  assert.match(migration, /usage_refund_browser_execute/i);
  assert.match(migration, /has_function_privilege\('authenticated', 'public\.refund_feature_usage\(uuid,uuid\)'/i);
});

test('campaign cache writes are service-owned in the production hardening migration', () => {
  const migration = readFileSync(
    resolve('db/migrations/20260812_independent_audit_hardening.sql'),
    'utf8'
  );

  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON public\.campaigns_cache FROM anon, authenticated/i
  );
  assert.match(migration, /CREATE POLICY campaigns_owner_only[\s\S]*FOR SELECT USING/i);
  assert.match(migration, /campaign_cache_browser_write/i);
});

test('audit summaries cannot collide with the weekly performance report index', () => {
  const row = buildAuditReportRow({
    accountId: 'account-1',
    auditId: 'audit-1',
    summaryAr: 'ملخص',
    summaryEn: 'Summary',
    healthScore: 88,
    recommendationsCount: 3,
    estimatedMonthlyWasteSar: 125,
    currencyCode: 'SAR',
  });

  assert.equal(row.period_type, 'custom');
  assert.equal(row.period_start, null);
  assert.equal(row.period_end, null);
  assert.equal(row.metrics.kind, 'audit_summary');
  assert.equal(row.metrics.audit_id, 'audit-1');
});
