import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLocalPath } from '../lib/security/redirect';
import { moneyMetric, metricsCurrency } from '../lib/google-ads/metrics';
import { formatCurrency } from '../lib/utils';
import { googleAdsAuthNeedsReconnect } from '../lib/google-ads/client';
import { readFileSync } from 'node:fs';

test('safe redirects stay on the Modaafa origin', () => {
  assert.equal(safeLocalPath('/dashboard?account=123'), '/dashboard?account=123');
  assert.equal(safeLocalPath('https://evil.example'), '/dashboard');
  assert.equal(safeLocalPath('//evil.example/path'), '/dashboard');
  assert.equal(safeLocalPath('/\\evil.example'), '/dashboard');
});

test('money metrics prefer the generic field and retain legacy cache support', () => {
  assert.equal(moneyMetric({ cost: 125.5, cost_sar: 99 }, 'cost'), 125.5);
  assert.equal(moneyMetric({ cost_sar: 99 }, 'cost'), 99);
  assert.equal(moneyMetric({ cost: 'not-a-number' }, 'cost'), 0);
});

test('currency validation falls back to SAR without forcing valid account currencies', () => {
  assert.equal(metricsCurrency({ currency_code: 'usd' }), 'USD');
  assert.equal(metricsCurrency({}, 'AED'), 'AED');
  assert.equal(metricsCurrency({ currency_code: 'invalid' }), 'SAR');
  assert.match(formatCurrency(100, 'USD', 'en-US'), /\$100/);
});

test('expired or mismatched Google OAuth clients require reconnecting', () => {
  assert.equal(
    googleAdsAuthNeedsReconnect({ response: { data: { error: 'unauthorized_client' } } }),
    true
  );
  assert.equal(googleAdsAuthNeedsReconnect(new Error('USER_PERMISSION_DENIED')), false);
});

test('rate-limit migrations return values through the insert alias', () => {
  for (const migration of [
    'db/migrations/20260721_rate_limits.sql',
    'db/migrations/20260721_fix_rate_limit_function.sql',
  ]) {
    const sql = readFileSync(new URL(`../${migration}`, import.meta.url), 'utf8');
    assert.match(sql, /returning limits\.window_start, limits\.request_count/);
    assert.doesNotMatch(sql, /returning rate_limit_windows\.window_start/);
  }
});

test('rollback remains available after a subscription ends', () => {
  const route = readFileSync(
    new URL('../app/api/actions/rollback/route.ts', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(route, /consumeFeatureUsage|refundFeatureUsage/);
  assert.match(route, /Rollback is a compensating safety operation/);
  assert.match(route, /executeRollback\(rollback, customer, \{ validateOnly: true \}\)/);
});
