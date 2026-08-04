import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutableAction, validGoogleAdsResource } from '../lib/ai/executable-action';

const rec = { title: 'توصية', description: 'وصف', expected_impact: { metric: 'cost', delta_pct: 10, delta_sar_per_month: 100 } };

test('a delta-only budget payload (the optimizer prompt format) is executable', () => {
  const action = buildExecutableAction(
    {
      operation: 'adjust_budget',
      target_id: '',
      params: { budget_resource: 'customers/123/campaignBudgets/9', delta_pct: 20 },
    },
    rec
  );
  assert.ok(action, 'delta-only budget action must not dead-end in manual_review_required');
  assert.equal(action?.type, 'adjust_budget');
});

test('an absolute-amount budget payload is executable', () => {
  const action = buildExecutableAction(
    {
      operation: 'adjust_budget',
      target_id: '',
      params: { budget_resource: 'customers/123/campaignBudgets/9', new_amount_micros: 50_000_000 },
    },
    rec
  );
  assert.ok(action);
});

test('a budget payload with neither amount nor delta stays manual-review', () => {
  const action = buildExecutableAction(
    { operation: 'adjust_budget', target_id: '', params: { budget_resource: 'customers/123/campaignBudgets/9' } },
    rec
  );
  assert.equal(action, null);
});

test('a delta outside the guardrail bounds is rejected up front', () => {
  for (const delta_pct of [26, -31, 0, Number.NaN]) {
    const action = buildExecutableAction(
      { operation: 'adjust_budget', target_id: '', params: { budget_resource: 'customers/123/campaignBudgets/9', delta_pct } },
      rec
    );
    assert.equal(action, null, `delta_pct=${delta_pct} must be rejected`);
  }
});

test('resource names outside the selected account are rejected', () => {
  const action = buildExecutableAction(
    {
      operation: 'adjust_budget',
      target_id: '',
      params: { budget_resource: 'customers/999/campaignBudgets/9', new_amount_micros: 50_000_000 },
    },
    rec,
    '123'
  );
  assert.equal(action, null);
});

test('adjust_bid requires an ad group resource and at least one target', () => {
  assert.equal(
    buildExecutableAction(
      { operation: 'adjust_bid', target_id: '', params: { ad_group_resource: 'customers/123/adGroups/5' } },
      rec
    ),
    null
  );
  assert.ok(
    buildExecutableAction(
      {
        operation: 'adjust_bid',
        target_id: '',
        params: { ad_group_resource: 'customers/123/adGroups/5', target_cpa_micros: 4_000_000 },
      },
      rec
    )
  );
});

test('add_negative_keyword requires a campaign resource in the selected account', () => {
  assert.equal(
    buildExecutableAction(
      {
        operation: 'add_negative_keyword',
        target_id: '',
        params: { campaign_resource: 'customers/999/campaigns/7', keyword_text: 'مجاني', match_type: 'PHRASE' },
      },
      rec,
      '123'
    ),
    null
  );
  assert.ok(
    buildExecutableAction(
      {
        operation: 'add_negative_keyword',
        target_id: '',
        params: { campaign_resource: 'customers/123/campaigns/7', keyword_text: 'مجاني', match_type: 'PHRASE' },
      },
      rec,
      '123'
    )
  );
});

test('unknown operations are never executable', () => {
  assert.equal(buildExecutableAction({ operation: 'delete_account', target_id: '', params: {} }, rec), null);
});

test('validGoogleAdsResource pins the customer id when provided', () => {
  assert.ok(validGoogleAdsResource('customers/123/campaigns/7', 'campaigns', '1-2-3'));
  assert.ok(!validGoogleAdsResource('customers/124/campaigns/7', 'campaigns', '123'));
  assert.ok(!validGoogleAdsResource('customers/123/campaigns/7/extra', 'campaigns', '123'));
  assert.ok(validGoogleAdsResource('customers/999/campaigns/7', 'campaigns'));
});
