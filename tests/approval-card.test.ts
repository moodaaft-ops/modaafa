import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalKind,
  buildCampaignNameIndex,
  buildChangePreview,
  canRollback,
  clicksPhrase,
  conversionsPhrase,
  executionConfirmationLines,
  expectedImpact,
  formatRoasPercent,
  groupRecommendations,
  matchTypeLabel,
  microsToAmount,
  recommendationAttention,
  resolveChangeTarget,
  resourceId,
  riskOf,
  rollbackAttention,
  rollbackDeadline,
} from '../lib/guidance/approval-card';

const rec = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  title: 'توصية',
  description: 'وصف',
  expected_impact: { metric: 'cost', delta_pct: 10, delta_sar_per_month: 300 },
  action_payload: payload,
  ...extra,
});

const campaigns = buildCampaignNameIndex([
  { google_campaign_id: 456, name: 'حملة الرياض' },
  { google_campaign_id: '789', name: '  ' },
  { google_campaign_id: null, name: 'بدون رقم' },
]);

const negativePayload = {
  operation: 'add_negative_keyword',
  target_id: '',
  params: { campaign_resource: 'customers/123/campaigns/456', keyword_text: 'مجاني', match_type: 'EXACT' },
};

test('campaign names resolve from the cache instead of showing Google IDs', () => {
  assert.equal(resourceId('customers/123/campaigns/456', 'campaigns'), '456');
  assert.equal(resourceId('customers/123/adGroups/9', 'campaigns'), null);
  assert.equal(campaigns.size, 1);
  const target = resolveChangeTarget(negativePayload, campaigns);
  assert.equal(target.campaignName, 'حملة الرياض');
  assert.deepEqual(target.technicalIds, ['customers/123/campaigns/456']);

  const preview = buildChangePreview(negativePayload, { campaigns });
  assert.ok(preview);
  assert.match(preview.summary, /«حملة الرياض»/);
  assert.match(preview.summary, /مطابقة تامة/);
  assert.ok(!preview.summary.includes('customers/'));
  for (const row of preview.rows) assert.ok(!String(row.value ?? '').includes('customers/'));
});

test('a name stored in the payload wins and a missing name is said plainly', () => {
  const named = resolveChangeTarget({ params: { campaign_name: 'حملة جدة', campaign_resource: 'customers/1/campaigns/456' } }, campaigns);
  assert.equal(named.campaignName, 'حملة جدة');

  const budget = buildChangePreview(
    { operation: 'adjust_budget', params: { budget_resource: 'customers/1/campaignBudgets/7', current_amount_micros: 100_000_000, new_amount_micros: 80_000_000 } },
    { campaigns, currencyCode: 'SAR' }
  );
  assert.ok(budget);
  assert.match(budget.summary, /الاسم غير متوفر/);
  assert.ok(!budget.summary.includes('campaignBudgets'));
  const row = budget.rows.find((item) => item.label === 'الميزانية اليومية');
  assert.ok(row?.current?.includes('100'));
  assert.ok(row?.next?.includes('80'));
  assert.ok(budget.rows.some((item) => item.value === '-20%'));
});

test('delta-only budget payloads still show a direction and percentage', () => {
  const preview = buildChangePreview({ operation: 'adjust_budget', params: { budget_resource: 'customers/1/campaignBudgets/7', delta_pct: 15 } });
  assert.ok(preview);
  assert.match(preview.summary, /ترتفع 15%/);
  const row = preview.rows.find((item) => item.label === 'الميزانية اليومية');
  assert.equal(row?.current, 'تُقرأ من Google Ads لحظة التنفيذ');
  assert.equal(row?.next, '+15% من القيمة الحالية');
});

test('Google terms are translated and ROAS ratios read as percentages', () => {
  assert.equal(matchTypeLabel('EXACT'), 'مطابقة تامة');
  assert.equal(matchTypeLabel('phrase'), 'مطابقة العبارة');
  assert.equal(matchTypeLabel('BROAD'), 'مطابقة واسعة');
  assert.equal(formatRoasPercent(3.5), '350%');
  assert.equal(formatRoasPercent('4'), '400%');
  assert.equal(formatRoasPercent(null), null);
  assert.equal(formatRoasPercent(0), null);
  assert.equal(microsToAmount(12_500_000), 12.5);
  assert.equal(microsToAmount('x'), null);

  const roas = buildChangePreview({
    operation: 'adjust_bid',
    params: { ad_group_resource: 'customers/1/adGroups/5', target_roas: 4, current_target_roas: 3.5, ad_group_name: 'العطور' },
  });
  assert.ok(roas);
  const roasRow = roas.rows.find((row) => row.label === 'العائد المستهدف على الإنفاق');
  assert.equal(roasRow?.current, '350%');
  assert.equal(roasRow?.next, '400%');
  assert.match(roas.summary, /من 350% إلى 400%/);
  assert.match(roas.summary, /«العطور»/);

  const cpa = buildChangePreview(
    { operation: 'adjust_bid', params: { ad_group_resource: 'customers/1/adGroups/5', target_cpa_micros: 45_000_000 } },
    { currencyCode: 'SAR' }
  );
  const cpaRow = cpa?.rows.find((row) => row.label === 'تكلفة التحويل المستهدفة');
  assert.equal(cpaRow?.current, 'تُقرأ من Google Ads لحظة التنفيذ');
  assert.ok(cpaRow?.next?.includes('45'));
  assert.ok(cpaRow?.hint);
});

test('approval kind follows the execute endpoint acceptance rule', () => {
  assert.equal(approvalKind(rec(negativePayload)), 'executable');
  assert.equal(approvalKind(rec({ operation: 'manual_campaign_draft', params: { name: 'حملة' } })), 'campaign_draft');
  assert.equal(approvalKind(rec({ operation: 'build_campaign_opportunity', brief_ar: 'x' })), 'campaign_opportunity');
  assert.equal(approvalKind(rec({ operation: 'review_wasted_search_term', details: {} })), 'manual_review');
  // Invalid match type: the endpoint would dead-end it, so no "تنفيذ".
  assert.equal(approvalKind(rec({ ...negativePayload, params: { ...negativePayload.params, match_type: 'FUZZY' } })), 'manual_review');
});

test('expected impact always carries an explicit saving or growth label', () => {
  assert.deepEqual(expectedImpact(rec(negativePayload)), { label: 'توفير متوقع شهرياً', amount: 300 });
  assert.equal(expectedImpact(rec({ operation: 'add_keyword', params: {} }))?.label, 'زيادة متوقعة شهرياً');
  assert.equal(
    expectedImpact(rec({ operation: 'adjust_budget', params: { delta_pct: 20 } }))?.label,
    'زيادة متوقعة شهرياً'
  );
  assert.equal(
    expectedImpact(rec({ operation: 'adjust_budget', params: { delta_pct: -10 } }, { expected_impact: { metric: 'roas', delta_sar_per_month: 50 } }))?.label,
    'توفير متوقع شهرياً'
  );
  assert.equal(expectedImpact(rec(negativePayload, { expected_impact: { delta_sar_per_month: 0 } })), null);
  assert.equal(expectedImpact(rec(negativePayload, { expected_impact: { delta_sar_per_month: 100, confidence: 'draft' } })), null);
});

test('risk level is derived from the operation and size of the change', () => {
  assert.equal(riskOf(negativePayload, 'executable')?.level, 'low');
  assert.equal(riskOf({ operation: 'adjust_bid', params: {} }, 'executable')?.level, 'medium');
  assert.equal(riskOf({ operation: 'adjust_budget', params: { delta_pct: 10 } }, 'executable')?.level, 'medium');
  assert.equal(riskOf({ operation: 'adjust_budget', params: { delta_pct: -25 } }, 'executable')?.level, 'high');
  assert.equal(riskOf(negativePayload, 'manual_review'), null);
});

test('confirmation restates the summary in two lines', () => {
  const preview = buildChangePreview(negativePayload, { campaigns });
  const [first, second] = executionConfirmationLines(preview, 'عنوان');
  assert.equal(first, preview?.summary);
  assert.match(second, /Google Ads/);
  assert.match(second, /30 يوماً/);
  assert.equal(executionConfirmationLines(null, 'عنوان')[0], 'عنوان');
});

test('recommendations split into pending, approved, attention and history', () => {
  const groups = groupRecommendations([
    { status: 'pending' },
    { status: 'approved' },
    { status: 'executing' },
    { status: 'failed' },
    { status: 'dismissed' },
    { status: 'applied' },
  ]);
  assert.equal(groups.pending.length, 1);
  assert.equal(groups.approved.length, 1);
  assert.equal(groups.attention.length, 2);
  assert.equal(groups.dismissed.length, 1);
  assert.equal(groups.applied.length, 1);
});

test('stuck and failed states carry a reason and a next step', () => {
  const now = Date.parse('2026-10-07T12:00:00.000Z');
  const fresh = recommendationAttention({ status: 'executing', execution_started_at: '2026-10-07T11:59:30.000Z' }, now);
  assert.equal(fresh?.state, 'in_progress');
  const stale = recommendationAttention({ status: 'executing', execution_started_at: '2026-10-07T11:00:00.000Z' }, now);
  assert.equal(stale?.state, 'unconfirmed');
  assert.ok(stale?.reason && stale.nextStep);
  assert.equal(recommendationAttention({ status: 'executing', execution_started_at: null }, now)?.state, 'unconfirmed');
  const failed = recommendationAttention({ status: 'failed', applied_result: { status: 'preflight_failed' } }, now);
  assert.equal(failed?.state, 'failed');
  assert.match(failed?.reason ?? '', /القيمة الحالية/);
  assert.equal(recommendationAttention({ status: 'pending' }, now), null);

  assert.equal(rollbackAttention({ rollback_status: 'failed' }, now)?.state, 'rollback_failed');
  assert.equal(rollbackAttention({ rollback_status: 'executing', rollback_started_at: '2026-10-07T10:00:00.000Z' }, now)?.state, 'rollback_unconfirmed');
  assert.equal(rollbackAttention({ rollback_status: 'failed', reverted_at: '2026-10-07T10:00:00.000Z' }, now), null);
});

test('rollback availability mirrors the 30 day window', () => {
  const now = Date.parse('2026-10-07T12:00:00.000Z');
  const recent = { rollback_payload: { reversible: true }, created_at: '2026-10-01T12:00:00.000Z' };
  assert.equal(canRollback(recent, now), true);
  assert.equal(rollbackDeadline(recent.created_at)?.toISOString(), '2026-10-31T12:00:00.000Z');
  assert.equal(canRollback({ ...recent, created_at: '2026-08-01T12:00:00.000Z' }, now), false);
  assert.equal(canRollback({ ...recent, rollback_status: 'executing' }, now), false);
  assert.equal(canRollback({ ...recent, reverted_at: '2026-10-02T00:00:00.000Z' }, now), false);
  assert.equal(canRollback({ ...recent, rollback_payload: {} }, now), false);
});

test('assistant drafts read as drafts, never as live changes', () => {
  const preview = buildChangePreview(
    { operation: 'manual_campaign_draft', params: { name: 'عطور الشتاء', type: 'SEARCH', daily_budget_sar: 150, bidding_strategy: 'TARGET_CPA' } },
    { currencyCode: 'SAR' }
  );
  assert.ok(preview);
  assert.match(preview.summary, /لم تُنشأ في Google Ads بعد/);
  assert.ok(preview.rows.some((row) => row.value === 'حملة بحث'));
  assert.ok(preview.rows.some((row) => row.value === 'تكلفة التحويل المستهدفة'));
});

test('Arabic counts agree with the number', () => {
  assert.equal(conversionsPhrase(1), 'تحويل واحد');
  assert.equal(conversionsPhrase(2), 'تحويلان');
  assert.equal(conversionsPhrase(5), '5 تحويلات');
  assert.equal(conversionsPhrase(15), '15 تحويلاً');
  assert.equal(conversionsPhrase(100), '100 تحويل');
  assert.equal(conversionsPhrase(2.5), '2.5 تحويل');
  assert.equal(clicksPhrase(5), '5 نقرات');
  assert.equal(clicksPhrase(40), '40 نقرة');
});
