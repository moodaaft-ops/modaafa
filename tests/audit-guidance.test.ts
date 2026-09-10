import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecommendationActionable,
  orderRecommendationsForGuidance,
} from '../lib/audit/guidance';

test('guidance puts recommendations needing a decision before completed recommendations', () => {
  const recommendations = orderRecommendationsForGuidance([
    { id: 'applied', status: 'applied', severity: 'critical' },
    { id: 'approved', status: 'approved', severity: 'critical' },
    { id: 'pending', status: 'pending', severity: 'medium' },
    { id: 'failed', status: 'failed', severity: 'critical' },
  ]);

  assert.deepEqual(recommendations.map((item) => item.id), ['pending', 'failed', 'approved', 'applied']);
});

test('guidance ranks actionable recommendations by expected monthly impact before severity', () => {
  const recommendations = orderRecommendationsForGuidance([
    { id: 'medium-high-impact', status: 'pending', severity: 'medium', expected_impact: { delta_sar_per_month: 900 } },
    { id: 'critical-low-impact', status: 'pending', severity: 'critical', expected_impact: { delta_sar_per_month: 10 } },
    { id: 'growth-low-impact', status: 'pending', severity: 'growth', expected_impact: { delta_sar_per_month: 50 } },
    { id: 'medium-low-impact', status: 'pending', severity: 'medium', expected_impact: { delta_sar_per_month: 500 } },
  ]);

  assert.deepEqual(recommendations.map((item) => item.id), [
    'medium-high-impact',
    'medium-low-impact',
    'growth-low-impact',
    'critical-low-impact',
  ]);
});

test('only pending and failed recommendations need a customer decision', () => {
  assert.equal(isRecommendationActionable({ status: 'pending' }), true);
  assert.equal(isRecommendationActionable({ status: 'failed' }), true);
  assert.equal(isRecommendationActionable({ status: 'approved' }), false);
  assert.equal(isRecommendationActionable({ status: 'applied' }), false);
});

 test('broken measurement is reviewed before financial opportunities', () => {
  const result = orderRecommendationsForGuidance([
    { id: 'budget', status: 'pending', expected_impact: { delta_sar_per_month: 900 } },
    { id: 'tracking', status: 'pending', action_payload: { operation: 'audit_conversion_tracking' } },
  ]);
  assert.equal(result[0].id, 'tracking');
});
