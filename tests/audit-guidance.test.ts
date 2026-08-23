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
    { id: 'failed', status: 'failed', severity: 'high' },
  ]);

  assert.deepEqual(recommendations.map((item) => item.id), ['pending', 'failed', 'approved', 'applied']);
});

test('guidance ranks actionable recommendations by severity then expected monthly impact', () => {
  const recommendations = orderRecommendationsForGuidance([
    { id: 'medium-high-impact', status: 'pending', severity: 'medium', expected_impact: { delta_sar_per_month: 900 } },
    { id: 'critical-low-impact', status: 'pending', severity: 'critical', expected_impact: { delta_sar_per_month: 10 } },
    { id: 'high-low-impact', status: 'pending', severity: 'high', expected_impact: { delta_sar_per_month: 50 } },
    { id: 'high-high-impact', status: 'pending', severity: 'high', expected_impact: { delta_sar_per_month: 500 } },
  ]);

  assert.deepEqual(recommendations.map((item) => item.id), [
    'critical-low-impact',
    'high-high-impact',
    'high-low-impact',
    'medium-high-impact',
  ]);
});

test('only pending and failed recommendations need a customer decision', () => {
  assert.equal(isRecommendationActionable({ status: 'pending' }), true);
  assert.equal(isRecommendationActionable({ status: 'failed' }), true);
  assert.equal(isRecommendationActionable({ status: 'approved' }), false);
  assert.equal(isRecommendationActionable({ status: 'applied' }), false);
});
