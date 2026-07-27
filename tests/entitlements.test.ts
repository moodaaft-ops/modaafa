import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAN_LIMITS,
  featureAccessMessage,
  featureAccessStatus,
  usageWindow,
} from '../lib/billing/entitlements';

test('paid plans keep every metered feature explicitly bounded', () => {
  for (const plan of ['starter', 'growth', 'pro'] as const) {
    for (const feature of ['assistant', 'campaign_builder', 'audit', 'manual_sync', 'execute_action'] as const) {
      assert.ok(PLAN_LIMITS[plan][feature].limit > 0, `${plan}.${feature} should have a positive limit`);
    }
  }
});

test('higher plans never reduce a feature limit', () => {
  for (const feature of ['assistant', 'campaign_builder', 'audit', 'manual_sync', 'execute_action'] as const) {
    assert.ok(PLAN_LIMITS.growth[feature].limit >= PLAN_LIMITS.starter[feature].limit);
    assert.ok(PLAN_LIMITS.pro[feature].limit >= PLAN_LIMITS.growth[feature].limit);
  }
});

test('daily usage window resets at UTC midnight', () => {
  const { start, end } = usageWindow('day', new Date('2026-07-16T14:35:00.000Z'));
  assert.equal(start.toISOString(), '2026-07-16T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-07-17T00:00:00.000Z');
});

test('weekly usage window follows the Saudi work week from Saturday', () => {
  const { start, end } = usageWindow('week', new Date('2026-07-16T14:35:00.000Z'));
  assert.equal(start.toISOString(), '2026-07-11T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-07-18T00:00:00.000Z');
});

test('monthly usage window resets on the first day of the month', () => {
  const { start, end } = usageWindow('month', new Date('2026-12-31T23:59:59.000Z'));
  assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('entitlement errors map to stable HTTP semantics and Arabic guidance', () => {
  assert.equal(featureAccessStatus('subscription_required'), 402);
  assert.equal(featureAccessStatus('quota_exceeded'), 429);
  assert.equal(featureAccessStatus('usage_storage_unavailable'), 503);
  assert.match(featureAccessMessage('subscription_required'), /اشتراك/);
  assert.match(featureAccessMessage('quota_exceeded'), /حد الاستخدام/);
});
