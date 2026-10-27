import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isRecommendationExecutable } from '../lib/recommendations/executability';

/**
 * «اعتمد» used to be offered, and accepted, on advice that has no Google Ads
 * change behind it. Production on 27 October 2026 held 82 such rows stuck in
 * `approved` (diagnose_zero_spend_campaigns, sync_campaigns, setup_conversion_tracking,
 * review_* …), each with an `execution_blocked` record and nothing changed on
 * the account. These tests pin the one predicate and the places that use it.
 */

const descriptiveOperations = [
  'diagnose_zero_spend_campaigns',
  'sync_campaigns',
  'setup_conversion_tracking',
  'retry_incomplete_audit',
  'review_low_quality_keyword',
  'review_wasted_search_term',
  'review_paused_winner',
  'review_search_rank_loss',
  'improve_ad_copy_and_assets',
  'audit_conversion_tracking',
  'review_or_reduce_campaign_budget',
];

test('descriptive advice is never executable', () => {
  for (const operation of descriptiveOperations) {
    assert.equal(
      isRecommendationExecutable({ title: 't', action_payload: { operation, params: {} } }),
      false,
      operation
    );
  }
});

test('a row with no payload is not executable', () => {
  assert.equal(isRecommendationExecutable({ title: 't' }), false);
  assert.equal(isRecommendationExecutable(null), false);
});

test('a bounded budget step and a valid negative keyword stay executable', () => {
  assert.equal(
    isRecommendationExecutable({
      title: 'زد الميزانية',
      action_payload: {
        operation: 'adjust_budget',
        params: { budget_resource: 'customers/123/campaignBudgets/9', delta_pct: 10 },
      },
    }),
    true
  );
  assert.equal(
    isRecommendationExecutable({
      title: 'سلبية',
      action_payload: {
        operation: 'add_negative_keyword',
        params: { campaign_resource: 'customers/123/campaigns/7', keyword_text: 'مجاني', match_type: 'PHRASE' },
      },
    }),
    true
  );
});

test('the approve route refuses descriptive advice before it writes `approved`', () => {
  const handler = readFileSync('lib/recommendations/action-handler.ts', 'utf8');
  const guardAt = handler.indexOf('if (!isRecommendationExecutable(recommendation))');
  const approveAt = handler.indexOf('const approvedOk = await approveRecommendation');
  assert.ok(guardAt > -1, 'guard present');
  assert.ok(approveAt > guardAt, 'guard runs before the approval write');
  // The execute intent (an already approved row) is dispatched before the guard,
  // so its existing execution_blocked record still runs.
  assert.ok(handler.indexOf("if (intent === 'execute')") < guardAt);
});

test('every surface that shows «اعتمد» asks the same predicate', () => {
  const home = readFileSync('app/(dashboard)/home/page.tsx', 'utf8');
  const optimizer = readFileSync('app/(dashboard)/optimizer/page.tsx', 'utf8');
  assert.match(home, /executable: isRecommendationExecutable\(row\)/);
  assert.match(home, /decision\.status === 'approved' && decision\.executable/);
  assert.match(optimizer, /item\.status === 'pending' && isRecommendationExecutable\(item\)/);
  assert.match(optimizer, /item\.status === 'approved' && isRecommendationExecutable\(item\)/);
});
