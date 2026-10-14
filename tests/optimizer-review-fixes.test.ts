import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  checkGuardrails,
  type GuardrailRejection,
  type OptimizerAction,
  type OptimizerSnapshot,
} from '../lib/ai/optimizer-agent';
import {
  bidChangeCollidesWithBudget,
  budgetChangeCollidesWithBid,
  CROSS_LOCK_DAYS,
  evaluateBidGate,
  evaluateBudgetGate,
} from '../lib/ai/optimizer-gates';
import {
  evaluateAddKeyword,
  evaluateAddNegativeKeyword,
  evaluatePauseAd,
  evaluatePauseKeyword,
  evaluateProposalEvidence,
} from '../lib/ai/optimizer-proposal-gates';
import { buildSnapshotEconomics } from '../lib/ai/optimizer-snapshot';
import { computeBreakEven } from '../lib/economics/break-even';
import { createRecommendationActionHandler } from '../lib/recommendations/action-handler';
import { holdsTargetLock, isExpiredOptimizerMoneyMove } from '../lib/recommendations/staleness';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

const CAMPAIGN = 'customers/123/campaigns/789';
const CAMPAIGN_2 = 'customers/123/campaigns/790';
const BUDGET = 'customers/123/campaignBudgets/456';
const AD_GROUP = 'customers/123/adGroups/55';
const AD_GROUP_2 = 'customers/123/adGroups/56';

// ---------------------------------------------------------------------------
// Fixtures (the same shapes as tests/optimizer-titan-guardrails.test.ts)
// ---------------------------------------------------------------------------

/** A store whose margin is 20-40%: scale ROAS 5, CUT ROAS 2.5. */
const store = () =>
  buildSnapshotEconomics(
    computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 } } }),
    null
  );

/** Lead business 10k-50k x margin 20-40% x close 2-3 of 10: scale CPA 400, CUT CPA 6000. */
const leads = () =>
  buildSnapshotEconomics(
    computeBreakEven({
      facts: {
        type: { choice: 'services' },
        deal_value: { choice: '10k_50k', min_sar: 10000, max_sar: 50000 },
        close_rate: { choice: '2_3', min_of_10: 2, max_of_10: 3 },
        margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 },
      },
    }),
    null
  );

const unknownEconomics = () => buildSnapshotEconomics(computeBreakEven({ facts: { type: { choice: 'ecommerce' } } }), null);

function campaign(
  overrides: { diag?: Record<string, unknown>; last_30d?: Record<string, unknown> | null; budget?: string; resource?: string } = {}
) {
  const row: Record<string, any> = {
    campaign: { id: '789', name: 'بحث', resourceName: overrides.resource ?? CAMPAIGN },
    campaignBudget: { id: '456', amountMicros: '10000000', resourceName: overrides.budget ?? BUDGET },
    metrics: { costMicros: '70000000', clicks: 400, conversions: 20, conversionsValue: 700 },
    diag: {
      type: 'SEARCH',
      bidding: 'MAXIMIZE_CONVERSION_VALUE',
      primary_status: 'ELIGIBLE',
      status_reasons: [],
      impressions_7d: 5000,
      search_is: 0.35,
      lost_budget_is: 0.25,
      lost_rank_is: 0.1,
      ...overrides.diag,
    },
  };
  // 30 days: 300 SAR spent, 80 conversions, 2,400 SAR value: ROAS 8, CPA 3.75.
  if (overrides.last_30d !== null) {
    row.last_30d = { cost_micros: 300_000_000, conversions: 80, conversions_value: 2400, ...overrides.last_30d };
  }
  return row;
}

function snapshot(overrides: Partial<OptimizerSnapshot> = {}): OptimizerSnapshot {
  return {
    account_id: 'account-1',
    customer_id: '123',
    campaigns: [campaign()],
    underperforming_keywords: [],
    high_performing_keywords: [],
    wasted_search_terms: [],
    converting_search_terms: [],
    budget_utilization: [],
    poor_ads: [],
    keyword_count: 10,
    currency_code: 'SAR',
    conversion_tracking: { status: 'healthy', enabled_actions: 2 },
    economics: store(),
    ad_group_bid_targets: [
      {
        adGroup: { resourceName: AD_GROUP, campaign: CAMPAIGN, targetRoas: 6 },
        metrics: { conversions: 40 },
      },
    ],
    target_roas: 5,
    target_cpa: null,
    ...overrides,
  };
}

function budgetAction(params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'adjust_budget',
    target_id: BUDGET,
    params: { budget_resource: BUDGET, current_amount_micros: 10_000_000, new_amount_micros: 11_500_000, delta_pct: 15, ...params },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'conversions', delta_pct: 5, delta_sar_per_month: 100 },
  };
}

function bidAction(params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'adjust_bid',
    target_id: AD_GROUP,
    params: { ad_group_resource: AD_GROUP, current_target_roas: 6, target_roas: 6.6, ...params },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'roas', delta_pct: 5, delta_sar_per_month: 100 },
  };
}

type Row = Record<string, any>;

/** A filter-aware in-memory client: `.eq`, `.in` and `.gte` really narrow the rows (the shared test stub ignores them). */
function memoryDb(tables: Record<string, Row[]> = {}, failing: string[] = []) {
  return {
    from(table: string) {
      const predicates: Array<(row: Row) => boolean> = [];
      const result = () =>
        failing.includes(table)
          ? { data: null, error: { message: 'boom' } }
          : { data: (tables[table] ?? []).filter((row) => predicates.every((p) => p(row))), error: null };
      const builder: any = {
        select: () => builder,
        eq: (key: string, value: unknown) => (predicates.push((row) => row[key] === value), builder),
        in: (key: string, values: unknown[]) => (predicates.push((row) => values.includes(row[key])), builder),
        gte: (key: string, value: string) => (predicates.push((row) => String(row[key] ?? '') >= String(value)), builder),
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const { data, error } = result();
          return { data: data?.[0] ?? null, error };
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
}

const accountRow = { id: 'account-1', business_id: null, currency_code: 'SAR' };

/** An executed change in ai_actions (what the approval handler and Jarvis write). */
const executedRow = (type: 'adjust_budget' | 'adjust_bid', params: Record<string, unknown>, at: string, recommendationId: string | null = null): Row => ({
  account_id: 'account-1',
  action_type: type,
  created_at: at,
  recommendation_id: recommendationId,
  payload: { action: { type, params } },
});

/** A card in the recommendations table. */
const cardRow = (
  operation: string,
  params: Record<string, unknown>,
  status: string,
  at: string,
  extra: Row = {}
): Row => ({
  account_id: 'account-1',
  status,
  created_at: at,
  action_payload: { source: 'optimizer_cron', operation, params },
  ...extra,
});

function rejections() {
  const seen: GuardrailRejection[] = [];
  return { seen, onReject: (rejection: GuardrailRejection) => void seen.push(rejection) };
}

// ---------------------------------------------------------------------------
// MINOR (a): impression share fails CLOSED. Learning campaigns are not scaled.
// ---------------------------------------------------------------------------

test('a Search campaign that does not report lost-to-budget impression share is not budget-constrained', () => {
  const gate = (diag: Record<string, unknown>, campaigns = [campaign({ diag })]) =>
    evaluateBudgetGate(budgetAction(), { snapshot: snapshot({ campaigns }) }, null);
  const refused = { ok: false, code: 'budget_not_constrained' };

  // Control: the same campaign WITH the number passes.
  assert.equal(gate({ lost_budget_is: 0.25 }).ok, true);

  // Missing in every way a Google Ads row can be missing.
  assert.deepEqual(gate({ lost_budget_is: undefined }), refused);
  assert.deepEqual(gate({ lost_budget_is: null }), refused);
  assert.deepEqual(gate({ lost_budget_is: 'n/a' }), refused);
  // The other shares being known does not excuse it.
  assert.deepEqual(gate({ lost_budget_is: null, search_is: 0.2, lost_rank_is: 0.5 }), refused);
  // A Search campaign with no share fields at all (a failed field query) is refused as well.
  assert.deepEqual(gate({ search_is: null, lost_budget_is: null, lost_rank_is: null }), refused);

  // A budget shared by two campaigns: one hiding its lost share makes the whole budget unproven.
  const shown = campaign({ resource: CAMPAIGN, diag: { lost_budget_is: 0.3 } });
  const hidden = campaign({ resource: CAMPAIGN_2, diag: { lost_budget_is: null } });
  assert.deepEqual(gate({}, [shown, hidden]), refused);
  assert.equal(gate({}, [shown, campaign({ resource: CAMPAIGN_2, diag: { lost_budget_is: 0.3 } })]).ok, true);
});

test('through checkGuardrails the missing impression share is reported with its reason code', async () => {
  const { seen, onReject } = rejections();
  const snap = snapshot({ campaigns: [campaign({ diag: { lost_budget_is: undefined } })] });
  const db = memoryDb({ ai_actions: [], recommendations: [], google_ads_accounts: [accountRow] });
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', db, { snapshot: snap, now: NOW, onReject }), null);
  assert.deepEqual(seen, [{ code: 'budget_not_constrained', action_type: 'adjust_budget' }]);
});

test('a campaign in learning gets no budget increase and no bid change (titan 5.3)', () => {
  const learning = snapshot({ campaigns: [campaign({ diag: { primary_status: 'LEARNING' } })] });
  assert.deepEqual(evaluateBudgetGate(budgetAction(), { snapshot: learning }, null), { ok: false, code: 'campaign_in_learning' });
  assert.deepEqual(evaluateBidGate(bidAction(), { snapshot: learning }), { ok: false, code: 'campaign_in_learning' });
  // Control: the same proposals pass once the campaign has left learning.
  assert.equal(evaluateBudgetGate(budgetAction(), { snapshot: snapshot() }, null).ok, true);
  assert.equal(evaluateBidGate(bidAction(), { snapshot: snapshot() }).ok, true);
});

// ---------------------------------------------------------------------------
// MAJOR 1: SCALE vs CUT thresholds, with real margins
// ---------------------------------------------------------------------------

test('margin 20-40%: ROAS 3.2 is never cut, ROAS 2.0 may be, and nothing is raised in between', async () => {
  const cut = budgetAction({ delta_pct: -15, new_amount_micros: 8_500_000 });
  const withRoas = (value: number) =>
    snapshot({ campaigns: [campaign({ last_30d: { cost_micros: 300_000_000, conversions: 20, conversions_value: value } })] });
  const db = () => memoryDb({ ai_actions: [], recommendations: [], google_ads_accounts: [accountRow] });

  const middle = rejections();
  assert.equal(await checkGuardrails(cut, 'account-1', db(), { snapshot: withRoas(960), now: NOW, onReject: middle.onReject }), null);
  assert.deepEqual(middle.seen, [{ code: 'cut_gate_not_met', action_type: 'adjust_budget' }]);

  assert.equal(await checkGuardrails(cut, 'account-1', db(), { snapshot: withRoas(600), now: NOW }), cut); // ROAS 2.0

  // ROAS 3.2 is under the pessimistic break-even 5 but above the optimistic 2.5: no raise either.
  const raise = budgetAction();
  assert.equal(evaluateBudgetGate(raise, { snapshot: withRoas(960) }, 15).ok, false);
});

// ---------------------------------------------------------------------------
// MAJOR 3: the prompt-only thresholds are code checks against the snapshot row
// ---------------------------------------------------------------------------

const KEYWORD = 'customers/123/adGroupCriteria/55~9';

function pauseKeyword(targetId = KEYWORD, params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'pause_keyword',
    target_id: targetId,
    params,
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'cost', delta_pct: -2, delta_sar_per_month: 10 },
  };
}

const keywordRow = (metrics: Record<string, unknown> = {}): Row => ({
  ad_group_criterion: { resource_name: KEYWORD, keyword: { text: 'كلمة' } },
  metrics: { clicks: 40, impressions: 900, cost_micros: 20_000_000, conversions: 0, ...metrics },
});

test('pause_keyword: needs the snapshot row, 0 conversions, 20 clicks and 2 allowable CPAs of cost', () => {
  const check = (row: Row | null, extra: Partial<OptimizerSnapshot> = {}, target = KEYWORD) =>
    evaluatePauseKeyword(pauseKeyword(target), { snapshot: snapshot({ underperforming_keywords: row ? [row] : [], ...extra }) });

  // The account's own CPA is 3.75 here (the store's CUT CPA is unknown), so the cost floor is 7.5 SAR.
  assert.deepEqual(check(keywordRow()), { ok: true });
  assert.deepEqual(check(null), { ok: false, code: 'pause_keyword_not_in_snapshot' });
  assert.deepEqual(check(keywordRow(), {}, 'customers/123/adGroupCriteria/55~10'), { ok: false, code: 'pause_keyword_not_in_snapshot' });
  assert.deepEqual(check(keywordRow({ conversions: 1 })), { ok: false, code: 'pause_keyword_has_conversions' });
  assert.deepEqual(check(keywordRow({ clicks: 19 })), { ok: false, code: 'pause_keyword_few_clicks' });
  assert.deepEqual(check(keywordRow({ clicks: 20 })), { ok: true });
  assert.deepEqual(check(keywordRow({ cost_micros: 7_400_000 })), { ok: false, code: 'pause_keyword_cost_below_floor' });
  assert.deepEqual(check(keywordRow({ cost_micros: 7_500_000 })), { ok: true });

  // No yardstick at all (unknown economics and no conversions in the account): never pause.
  const blind = check(keywordRow(), { economics: unknownEconomics(), campaigns: [campaign({ last_30d: null })] });
  assert.deepEqual(blind, { ok: false, code: 'pause_keyword_no_cost_reference' });
});

test('pause_keyword: the cost is compared in whole currency units against the CUT allowable CPA', () => {
  const check = (costSar: number) =>
    evaluatePauseKeyword(pauseKeyword(), {
      snapshot: snapshot({ economics: leads(), underperforming_keywords: [keywordRow({ cost_micros: costSar * 1_000_000 })] }),
    });
  // CUT CPA 6000: pausing needs 12,000 SAR of cost, not 12,000 micros and not the pessimistic 2 x 400.
  assert.deepEqual(check(11_999), { ok: false, code: 'pause_keyword_cost_below_floor' });
  assert.deepEqual(check(12_000), { ok: true });
  assert.deepEqual(check(1_000), { ok: false, code: 'pause_keyword_cost_below_floor' });
});

test('pause_keyword: a camelCase Google Ads row and a numeric string cost are read the same way', () => {
  const row = { adGroupCriterion: { resourceName: KEYWORD }, metrics: { clicks: '40', costMicros: '20000000', conversions: '0' } };
  assert.deepEqual(evaluatePauseKeyword(pauseKeyword(), { snapshot: snapshot({ underperforming_keywords: [row] }) }), { ok: true });
});

test('numbers the model writes into the proposal are never trusted: the snapshot row decides', () => {
  const lie = pauseKeyword(KEYWORD, { clicks: 999, cost_micros: 999_000_000_000, conversions: 0 });
  const thin = snapshot({ underperforming_keywords: [keywordRow({ clicks: 2, cost_micros: 1_000_000 })] });
  assert.equal(evaluatePauseKeyword(lie, { snapshot: thin }).ok, false);
});

const AD = 'customers/123/adGroupAds/55~77';
const adRow = (over: { metrics?: Record<string, unknown>; group?: Record<string, unknown> } = {}): Row => ({
  ad_group_ad: { resource_name: AD },
  metrics: { impressions: 2000, clicks: 20, ctr: 0.01, cost_micros: 30_000_000, conversions: 0, ...over.metrics },
  ad_group: { ctr_30d: 0.05, cpa_30d: 10, enabled_ads: 3, ...over.group },
});

function pauseAd(target = AD): OptimizerAction {
  return {
    type: 'pause_ad',
    target_id: target,
    params: {},
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'ctr', delta_pct: 1, delta_sar_per_month: 0 },
  };
}

test('pause_ad: 1000+ impressions, CTR under half of the group, two other enabled ads, and no real conversions', () => {
  const check = (over: Parameters<typeof adRow>[0] = {}, row: Row | null = adRow(over)) =>
    evaluatePauseAd(pauseAd(), { snapshot: snapshot({ poor_ads: row ? [row] : [] }) });

  assert.deepEqual(check(), { ok: true });
  assert.deepEqual(check({}, null), { ok: false, code: 'pause_ad_not_in_snapshot' });
  assert.deepEqual(check({ metrics: { impressions: 999 } }), { ok: false, code: 'pause_ad_few_impressions' });
  assert.deepEqual(check({ metrics: { ctr: 0.03 } }), { ok: false, code: 'pause_ad_ctr_not_low' });
  assert.deepEqual(check({ group: { ctr_30d: null } }), { ok: false, code: 'pause_ad_group_unknown' });
  // enabled_ads counts the ad itself: 2 means only ONE other ad would keep serving.
  assert.deepEqual(check({ group: { enabled_ads: 2 } }), { ok: false, code: 'pause_ad_not_enough_siblings' });
  assert.deepEqual(check({ group: { enabled_ads: null } }), { ok: false, code: 'pause_ad_not_enough_siblings' });
  assert.deepEqual(check({ group: { enabled_ads: 4 } }), { ok: true });

  // An ad that converts at close to the group's CPA is not the problem; at twice the CPA it is.
  assert.deepEqual(check({ metrics: { conversions: 2, cost_micros: 30_000_000 } }), { ok: false, code: 'pause_ad_converts' }); // CPA 15
  assert.deepEqual(check({ metrics: { conversions: 1, cost_micros: 30_000_000 } }), { ok: true }); // CPA 30 >= 2 x 10
  assert.deepEqual(check({ metrics: { conversions: 1 }, group: { cpa_30d: null } }), { ok: false, code: 'pause_ad_converts' });
});

const TERM_AD_GROUP = AD_GROUP;
const termRow = (term: string, over: Row = {}): Row => ({
  search_term_view: { search_term: term, ad_group: TERM_AD_GROUP, status: 'NONE' },
  campaign: { resource_name: CAMPAIGN },
  metrics: { conversions: 3, cost_micros: 30_000_000, clicks: 12 },
  ...over,
});

function addKeyword(text: string, params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type: 'add_keyword',
    target_id: AD_GROUP,
    params: { ad_group_resource: AD_GROUP, keyword_text: text, match_type: 'EXACT', ...params },
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'conversions', delta_pct: 3, delta_sar_per_month: 10 },
  };
}

test('add_keyword: the term must be a converting search term of that ad group and not already handled', () => {
  const check = (text: string, rows: Row[], extra: Partial<OptimizerSnapshot> = {}, params: Record<string, unknown> = {}) =>
    evaluateAddKeyword(addKeyword(text, params), { snapshot: snapshot({ converting_search_terms: rows, ...extra }) });

  assert.deepEqual(check('عيادة أسنان', [termRow('عيادة اسنان')]), { ok: true }); // Arabic spelling variants match
  assert.deepEqual(check('عيادة اسنان', []), { ok: false, code: 'add_keyword_term_not_converting' });
  assert.deepEqual(check('عيادة اسنان', [termRow('عيادة اسنان', { metrics: { conversions: 0, cost_micros: 1, clicks: 1 } })]), {
    ok: false,
    code: 'add_keyword_term_not_converting',
  });
  // A term captured by another ad group does not justify a keyword in this one.
  const other = termRow('عيادة اسنان');
  other.search_term_view.ad_group = AD_GROUP_2;
  assert.deepEqual(check('عيادة اسنان', [other]), { ok: false, code: 'add_keyword_term_not_converting' });

  // Already added / excluded / added-and-excluded (string and numeric enum), or among the keywords the snapshot lists.
  for (const status of ['ADDED', 'EXCLUDED', 'ADDED_EXCLUDED', 2, 3, 4]) {
    const row = termRow('عيادة اسنان');
    row.search_term_view.status = status;
    assert.deepEqual(check('عيادة اسنان', [row]), { ok: false, code: 'add_keyword_already_exists' }, String(status));
  }
  const known = [{ ad_group_criterion: { keyword: { text: 'عيادة أسنان' } }, metrics: {} }];
  assert.deepEqual(check('عيادة اسنان', [termRow('عيادة اسنان')], { high_performing_keywords: known }), {
    ok: false,
    code: 'add_keyword_already_exists',
  });
});

test('add_keyword: the term\'s own CPA must be within the client\'s scale CPA when it is known', () => {
  const check = (costSar: number) =>
    evaluateAddKeyword(addKeyword('عيادة اسنان'), {
      snapshot: snapshot({ economics: leads(), converting_search_terms: [termRow('عيادة اسنان', { metrics: { conversions: 3, cost_micros: costSar * 1_000_000, clicks: 30 } })] }),
    });
  // Scale CPA 400: 3 conversions at 1,200 SAR is exactly 400.
  assert.deepEqual(check(1200), { ok: true });
  assert.deepEqual(check(1500), { ok: false, code: 'add_keyword_cpa_above_limit' });
});

const wastedRow = (term: string, metrics: Record<string, unknown> = {}): Row => ({
  search_term_view: { search_term: term },
  campaign: { resource_name: CAMPAIGN },
  metrics: { clicks: 9, conversions: 0, cost_micros: 20_000_000, ...metrics },
});

function negative(text: string, matchType = 'PHRASE', relevance?: 'clearly_irrelevant' | 'uncertain'): OptimizerAction {
  return {
    type: 'add_negative_keyword',
    target_id: CAMPAIGN,
    params: { campaign_resource: CAMPAIGN, keyword_text: text, match_type: matchType },
    ...(relevance
      ? { evidence: { window_days: 30, clicks: 9, conversions: 0, cost_micros: 20_000_000, source_resource: null, relevance } }
      : {}),
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'cost', delta_pct: -1, delta_sar_per_month: 10 },
  };
}

test('add_negative_keyword: a wasted term of that campaign that cost one allowable CPA, or is clearly irrelevant', () => {
  const check = (action: OptimizerAction, rows: Row[], extra: Partial<OptimizerSnapshot> = {}) =>
    evaluateAddNegativeKeyword(action, { snapshot: snapshot({ wasted_search_terms: rows, ...extra }) });

  // Cost 20 SAR against the account's own CPA 3.75: waste.
  assert.deepEqual(check(negative('مجاني'), [wastedRow('مجاني')]), { ok: true });
  assert.deepEqual(check(negative('مجاني'), []), { ok: false, code: 'negative_term_not_wasted' });
  assert.deepEqual(check(negative('مجاني'), [wastedRow('مجاني', { conversions: 1 })]), { ok: false, code: 'negative_term_not_wasted' });
  assert.deepEqual(check(negative('مجاني'), [wastedRow('مجاني', { cost_micros: 3_000_000 })]), { ok: false, code: 'negative_below_waste_floor' });

  // With broken tracking zero conversions prove nothing: cost alone never justifies a negative...
  const broken: Partial<OptimizerSnapshot> = { conversion_tracking: { status: 'broken_recently', enabled_actions: 2 } };
  assert.deepEqual(check(negative('مجاني'), [wastedRow('مجاني')], broken), { ok: false, code: 'negative_below_waste_floor' });
  // ...but a clearly irrelevant term on 5+ clicks still does.
  assert.deepEqual(check(negative('مجاني', 'PHRASE', 'clearly_irrelevant'), [wastedRow('مجاني', { clicks: 5, cost_micros: 1_000_000 })], broken), { ok: true });
  assert.deepEqual(
    check(negative('مجاني', 'PHRASE', 'clearly_irrelevant'), [wastedRow('مجاني', { clicks: 4, cost_micros: 1_000_000 })], broken),
    { ok: false, code: 'negative_below_waste_floor' }
  );
  // 'uncertain' relevance is not a reason.
  assert.deepEqual(check(negative('مجاني', 'PHRASE', 'uncertain'), [wastedRow('مجاني', { cost_micros: 1_000_000 })]), {
    ok: false,
    code: 'negative_below_waste_floor',
  });
});

test('add_negative_keyword: never blocks a converting search term or an enabled keyword (Arabic-normalized)', () => {
  const check = (action: OptimizerAction, extra: Partial<OptimizerSnapshot>) =>
    evaluateAddNegativeKeyword(action, { snapshot: snapshot({ wasted_search_terms: [wastedRow('أسنان')], ...extra }) });

  assert.deepEqual(check(negative('أسنان', 'PHRASE'), {}), { ok: true });
  // «أسنان» as a phrase blocks the converting query «اسنان رخيصة» (hamza and spelling variants normalize).
  assert.deepEqual(check(negative('أسنان', 'PHRASE'), { converting_search_terms: [termRow('اسنان رخيصة')] }), {
    ok: false,
    code: 'negative_blocks_converting_term',
  });
  // An EXACT negative blocks only the identical query.
  assert.deepEqual(check(negative('أسنان', 'EXACT'), { converting_search_terms: [termRow('اسنان رخيصة')] }), { ok: true });
  assert.deepEqual(check(negative('أسنان', 'EXACT'), { converting_search_terms: [termRow('اسنان')] }), {
    ok: false,
    code: 'negative_blocks_converting_term',
  });
  // It must not sit inside an enabled keyword either.
  const enabled = [{ ad_group_criterion: { keyword: { text: 'عيادة اسنان' } }, metrics: {} }];
  assert.deepEqual(check(negative('أسنان', 'PHRASE'), { high_performing_keywords: enabled }), {
    ok: false,
    code: 'negative_matches_enabled_keyword',
  });
});

test('checkGuardrails runs the evidence gate at queue time only, and reports the reason', async () => {
  const db = memoryDb({ ai_actions: [], recommendations: [], google_ads_accounts: [accountRow] });
  const { seen, onReject } = rejections();

  // At queue time the model's pause with no snapshot row is refused...
  assert.equal(await checkGuardrails(pauseKeyword(), 'account-1', db, { snapshot: snapshot(), now: NOW, onReject }), null);
  assert.deepEqual(seen, [{ code: 'pause_keyword_not_in_snapshot', action_type: 'pause_keyword' }]);
  // ...with the row it passes...
  const withRow = snapshot({ underperforming_keywords: [keywordRow()] });
  const action = pauseKeyword();
  assert.equal(await checkGuardrails(action, 'account-1', db, { snapshot: withRow, now: NOW }), action);
  // ...and at execution (no snapshot) the owner's own approved card is not re-judged here.
  assert.equal(await checkGuardrails(action, 'account-1', db), action);

  // Every covered type goes through the dispatcher; the others pass it.
  assert.deepEqual(evaluateProposalEvidence(pauseAd(), { snapshot: snapshot() }), { ok: false, code: 'pause_ad_not_in_snapshot' });
  assert.deepEqual(evaluateProposalEvidence(addKeyword('x'), { snapshot: snapshot() }), { ok: false, code: 'add_keyword_term_not_converting' });
  assert.deepEqual(evaluateProposalEvidence(negative('x'), { snapshot: snapshot() }), { ok: false, code: 'negative_term_not_wasted' });
  assert.deepEqual(evaluateProposalEvidence(budgetAction(), { snapshot: snapshot() }), { ok: true });
});

// ---------------------------------------------------------------------------
// MAJOR 4: budget <-> bid cross-lock
// ---------------------------------------------------------------------------

test('a budget change is refused while a target change on its campaign ran or waits inside 7 days', async () => {
  assert.equal(CROSS_LOCK_DAYS, 7);
  const run = async (tables: Record<string, Row[]>) => {
    const { seen, onReject } = rejections();
    const action = budgetAction();
    const result = await checkGuardrails(action, 'account-1', memoryDb({ google_ads_accounts: [accountRow], ...tables }), {
      snapshot: snapshot(),
      now: NOW,
      onReject,
    });
    return { passed: result === action, code: seen[0]?.code ?? null };
  };

  assert.deepEqual(await run({ ai_actions: [], recommendations: [] }), { passed: true, code: null });
  // Executed target change on an ad group of the campaign.
  assert.deepEqual(await run({ ai_actions: [executedRow('adjust_bid', { ad_group_resource: AD_GROUP }, daysAgo(3))] }), {
    passed: false,
    code: 'budget_locked_by_bid_change',
  });
  // The same change 8 days ago has left the 7-day window.
  assert.deepEqual(await run({ ai_actions: [executedRow('adjust_bid', { ad_group_resource: AD_GROUP }, daysAgo(8))] }), {
    passed: true,
    code: null,
  });
  // A target change waiting for the owner, or approved and not yet run.
  for (const status of ['pending', 'approved']) {
    assert.deepEqual(await run({ recommendations: [cardRow('adjust_bid', { ad_group_resource: AD_GROUP }, status, daysAgo(1))] }), {
      passed: false,
      code: 'budget_locked_by_bid_change',
    });
  }
  // A target change on an unrelated ad group (not in the snapshot) cannot be matched and does not collide.
  assert.deepEqual(await run({ ai_actions: [executedRow('adjust_bid', { ad_group_resource: 'customers/123/adGroups/999' }, daysAgo(1))] }), {
    passed: true,
    code: null,
  });
});

test('a target change is refused while a budget change on its campaign ran or waits inside 7 days', async () => {
  const run = async (tables: Record<string, Row[]>) => {
    const { seen, onReject } = rejections();
    const action = bidAction();
    const result = await checkGuardrails(action, 'account-1', memoryDb({ google_ads_accounts: [accountRow], ...tables }), {
      snapshot: snapshot(),
      now: NOW,
      onReject,
    });
    return { passed: result === action, code: seen[0]?.code ?? null };
  };

  assert.deepEqual(await run({ ai_actions: [], recommendations: [] }), { passed: true, code: null });
  assert.deepEqual(await run({ ai_actions: [executedRow('adjust_budget', { budget_resource: BUDGET }, daysAgo(2))] }), {
    passed: false,
    code: 'bid_locked_by_budget_change',
  });
  assert.deepEqual(await run({ ai_actions: [executedRow('adjust_budget', { budget_resource: BUDGET }, daysAgo(9))] }), {
    passed: true,
    code: null,
  });
  assert.deepEqual(await run({ recommendations: [cardRow('adjust_budget', { budget_resource: BUDGET }, 'pending', daysAgo(1))] }), {
    passed: false,
    code: 'bid_locked_by_budget_change',
  });
  // A change of some other budget is not this campaign's.
  assert.deepEqual(
    await run({ recommendations: [cardRow('adjust_budget', { budget_resource: 'customers/123/campaignBudgets/999' }, 'pending', daysAgo(1))] }),
    { passed: true, code: null }
  );
});

test('two proposals in the same run: the first card, already a pending row, locks the second', async () => {
  const tables: Record<string, Row[]> = { ai_actions: [], recommendations: [], google_ads_accounts: [accountRow] };
  const context = (onReject?: (r: GuardrailRejection) => void) => ({ snapshot: snapshot(), now: NOW, onReject });

  const first = budgetAction();
  assert.equal(await checkGuardrails(first, 'account-1', memoryDb(tables), context()), first);
  // The cron queues the first proposal: it is a pending row from now on.
  tables.recommendations.push(cardRow('adjust_budget', { budget_resource: BUDGET }, 'pending', NOW.toISOString()));

  const { seen, onReject } = rejections();
  assert.equal(await checkGuardrails(bidAction(), 'account-1', memoryDb(tables), context(onReject)), null);
  assert.deepEqual(seen, [{ code: 'bid_locked_by_budget_change', action_type: 'adjust_bid' }]);

  // And the other order: the bid first, then the budget.
  const mirror: Record<string, Row[]> = { ai_actions: [], recommendations: [], google_ads_accounts: [accountRow] };
  const bid = bidAction();
  assert.equal(await checkGuardrails(bid, 'account-1', memoryDb(mirror), context()), bid);
  mirror.recommendations.push(cardRow('adjust_bid', { ad_group_resource: AD_GROUP }, 'pending', NOW.toISOString()));
  const second = rejections();
  assert.equal(await checkGuardrails(budgetAction(), 'account-1', memoryDb(mirror), context(second.onReject)), null);
  assert.deepEqual(second.seen, [{ code: 'budget_locked_by_bid_change', action_type: 'adjust_budget' }]);
});

test('a budget shared by two campaigns collides with a target change on either campaign', () => {
  const snap = snapshot({
    campaigns: [campaign({ resource: CAMPAIGN }), campaign({ resource: CAMPAIGN_2 })],
    ad_group_bid_targets: [
      { adGroup: { resourceName: AD_GROUP, campaign: CAMPAIGN, targetRoas: 6 }, metrics: { conversions: 40 } },
      { adGroup: { resourceName: AD_GROUP_2, campaign: CAMPAIGN_2, targetRoas: 6 }, metrics: { conversions: 40 } },
    ],
  });
  const bidOn = (adGroup: string, at: string) => [{ operation: 'adjust_bid', resource: adGroup, at }];
  assert.equal(budgetChangeCollidesWithBid(snap, BUDGET, bidOn(AD_GROUP_2, daysAgo(2)), NOW.getTime()), true);
  assert.equal(budgetChangeCollidesWithBid(snap, BUDGET, bidOn(AD_GROUP, daysAgo(2)), NOW.getTime()), true);
  assert.equal(budgetChangeCollidesWithBid(snap, BUDGET, bidOn(AD_GROUP, daysAgo(8)), NOW.getTime()), false);
  assert.equal(budgetChangeCollidesWithBid(snap, 'customers/123/campaignBudgets/999', bidOn(AD_GROUP, daysAgo(1)), NOW.getTime()), false);
  assert.equal(
    bidChangeCollidesWithBudget(snap, AD_GROUP_2, [{ operation: 'adjust_budget', resource: BUDGET, at: daysAgo(3) }], NOW.getTime()),
    true
  );
  assert.equal(bidChangeCollidesWithBudget(snap, 'customers/123/adGroups/999', [{ operation: 'adjust_budget', resource: BUDGET, at: daysAgo(3) }], NOW.getTime()), false);
});

// ---------------------------------------------------------------------------
// MAJOR 2 (part 1): executed-history locks at execution time (ExecutionGuard)
// ---------------------------------------------------------------------------

test('execution time: an approved optimizer budget card is refused when the budget changed since, its own rows excepted', async () => {
  const action = budgetAction();
  const history = (rows: Row[]) => memoryDb({ ai_actions: rows, recommendations: [], google_ads_accounts: [accountRow] });
  const guard = (onReject?: (r: GuardrailRejection) => void) => ({ recommendationId: 'rec-1', now: NOW, onReject });

  // Someone (Jarvis, the owner, another card) changed this budget 2 days ago.
  const other = executedRow('adjust_budget', { budget_resource: BUDGET }, daysAgo(2), 'rec-other');
  const { seen, onReject } = rejections();
  assert.equal(await checkGuardrails(action, 'account-1', history([other]), undefined, guard(onReject)), null);
  assert.deepEqual(seen, [{ code: 'budget_locked_recent_change', action_type: 'adjust_budget' }]);

  // The row this very card wrote (an earlier attempt that was recorded) never locks it.
  const own = executedRow('adjust_budget', { budget_resource: BUDGET }, daysAgo(2), 'rec-1');
  assert.equal(await checkGuardrails(action, 'account-1', history([own]), undefined, guard()), action);

  // A change older than 7 days, and a change of a different budget, do not lock.
  assert.equal(await checkGuardrails(action, 'account-1', history([executedRow('adjust_budget', { budget_resource: BUDGET }, daysAgo(8))]), undefined, guard()), action);
  const otherBudget = executedRow('adjust_budget', { budget_resource: 'customers/123/campaignBudgets/999' }, daysAgo(1));
  assert.equal(await checkGuardrails(action, 'account-1', history([otherBudget]), undefined, guard()), action);

  // No execution guard (Jarvis-prepared changes, autopilot): the owner may change a budget again.
  assert.equal(await checkGuardrails(action, 'account-1', history([other]), undefined, undefined), action);

  // The pending-card locks and the cross-lock are queue-time only: the approved card IS the pending row.
  const selfPending = memoryDb({
    ai_actions: [],
    recommendations: [cardRow('adjust_budget', { budget_resource: BUDGET }, 'approved', daysAgo(1)), cardRow('adjust_bid', { ad_group_resource: AD_GROUP }, 'pending', daysAgo(1))],
    google_ads_accounts: [accountRow],
  });
  assert.equal(await checkGuardrails(action, 'account-1', selfPending, undefined, guard()), action);

  // An unreadable history fails closed.
  const unreadable = memoryDb({ google_ads_accounts: [accountRow] }, ['ai_actions']);
  const failed = rejections();
  assert.equal(await checkGuardrails(action, 'account-1', unreadable, undefined, guard(failed.onReject)), null);
  assert.deepEqual(failed.seen, [{ code: 'budget_history_unreadable', action_type: 'adjust_budget' }]);
});

test('execution time: the 14-day target lock applies to an approved optimizer bid card the same way', async () => {
  const action = bidAction();
  const history = (rows: Row[]) => memoryDb({ ai_actions: rows, recommendations: [], google_ads_accounts: [accountRow] });
  const guard = { recommendationId: 'rec-1', now: NOW };
  const recent = executedRow('adjust_bid', { ad_group_resource: AD_GROUP }, daysAgo(10), 'rec-other');

  const { seen, onReject } = rejections();
  assert.equal(await checkGuardrails(action, 'account-1', history([recent]), undefined, { ...guard, onReject }), null);
  assert.deepEqual(seen, [{ code: 'bid_locked_recent_change', action_type: 'adjust_bid' }]);

  assert.equal(await checkGuardrails(action, 'account-1', history([{ ...recent, recommendation_id: 'rec-1' }]), undefined, guard), action);
  assert.equal(await checkGuardrails(action, 'account-1', history([executedRow('adjust_bid', { ad_group_resource: AD_GROUP }, daysAgo(15))]), undefined, guard), action);
  assert.equal(await checkGuardrails(action, 'account-1', history([recent]), undefined, undefined), action);
});

// ---------------------------------------------------------------------------
// MINOR (d): locks must not hold forever
// ---------------------------------------------------------------------------

test('holdsTargetLock: a stuck executing or approved card and an old pending card stop holding a target', () => {
  const now = NOW.getTime();
  const row = (status: string, extra: Row = {}) => ({ status, created_at: daysAgo(1), action_payload: { source: 'optimizer_cron' }, ...extra });

  // executing: 24 hours from the claim (else from creation).
  assert.equal(holdsTargetLock(row('executing', { execution_started_at: hoursAgo(23) }), now), true);
  assert.equal(holdsTargetLock(row('executing', { execution_started_at: hoursAgo(25) }), now), false);
  assert.equal(holdsTargetLock(row('executing', { created_at: hoursAgo(30), execution_started_at: null }), now), false);
  assert.equal(holdsTargetLock(row('executing', { created_at: daysAgo(20), execution_started_at: hoursAgo(1) }), now), true);
  // approved: 7 days from creation.
  assert.equal(holdsTargetLock(row('approved', { created_at: daysAgo(6) }), now), true);
  assert.equal(holdsTargetLock(row('approved', { created_at: daysAgo(8) }), now), false);
  // pending: 14 days, whoever made the card.
  assert.equal(holdsTargetLock(row('pending', { created_at: daysAgo(13) }), now), true);
  assert.equal(holdsTargetLock(row('pending', { created_at: daysAgo(15) }), now), false);
  assert.equal(holdsTargetLock(row('pending', { created_at: daysAgo(15), action_payload: { source: 'jarvis' } }), now), false);
  assert.equal(holdsTargetLock(row('pending', { created_at: daysAgo(15), action_payload: { operation: 'adjust_budget' } }), now), false);
  // Unreadable times and unknown statuses keep holding (nothing proves they are old).
  assert.equal(holdsTargetLock(row('pending', { created_at: 'garbage' }), now), true);
  assert.equal(holdsTargetLock(row('approved', { created_at: null }), now), true);
  assert.equal(holdsTargetLock(row('something_else', { created_at: daysAgo(90) }), now), true);
  assert.equal(holdsTargetLock(null, now), false);
});

test('a card stuck in executing or approved no longer locks a budget or a bid at queue time', async () => {
  const run = async (action: OptimizerAction, card: Row) => {
    const { seen, onReject } = rejections();
    const result = await checkGuardrails(
      action,
      'account-1',
      memoryDb({ ai_actions: [], recommendations: [card], google_ads_accounts: [accountRow] }),
      { snapshot: snapshot(), now: NOW, onReject }
    );
    return { passed: result === action, code: seen[0]?.code ?? null };
  };
  const budgetCard = (status: string, at: string, extra: Row = {}) => cardRow('adjust_budget', { budget_resource: BUDGET }, status, at, extra);

  // Control: a fresh card of each state holds the budget.
  assert.equal((await run(budgetAction(), budgetCard('approved', daysAgo(2)))).code, 'budget_locked_pending');
  assert.equal((await run(budgetAction(), budgetCard('executing', daysAgo(2), { execution_started_at: hoursAgo(2) }))).code, 'budget_locked_pending');
  // Released: executing for 25 hours, approved for 7 days and more.
  assert.deepEqual(await run(budgetAction(), budgetCard('executing', daysAgo(2), { execution_started_at: hoursAgo(25) })), { passed: true, code: null });
  assert.deepEqual(await run(budgetAction(), budgetCard('approved', daysAgo(6.9))), { passed: false, code: 'budget_locked_pending' });
  // A bid card approved 6 days ago still holds its ad group, one stuck for 8 days (created 8 days ago, outside the 7 day window of the query) does not.
  const bidCard = (status: string, at: string, extra: Row = {}) => cardRow('adjust_bid', { ad_group_resource: AD_GROUP }, status, at, extra);
  assert.equal((await run(bidAction(), bidCard('approved', daysAgo(6)))).code, 'bid_locked_pending');
  assert.deepEqual(await run(bidAction(), bidCard('executing', daysAgo(3), { execution_started_at: hoursAgo(30) })), { passed: true, code: null });
});

// ---------------------------------------------------------------------------
// MAJOR 2 (part 2): the approval handler
// ---------------------------------------------------------------------------

test('isExpiredOptimizerMoneyMove: only optimizer budget and bid cards older than 7 days', () => {
  const now = NOW.getTime();
  const optimizer = (age: number) => ({ status: 'approved', created_at: daysAgo(age), action_payload: { source: 'optimizer_cron' } });
  assert.equal(isExpiredOptimizerMoneyMove(optimizer(8), 'adjust_budget', now), true);
  assert.equal(isExpiredOptimizerMoneyMove(optimizer(8), 'adjust_bid', now), true);
  assert.equal(isExpiredOptimizerMoneyMove(optimizer(6), 'adjust_budget', now), false);
  // Other operations keep their old shelf life.
  for (const operation of ['pause_keyword', 'add_keyword', 'add_negative_keyword', 'pause_ad', 'pause_campaign']) {
    assert.equal(isExpiredOptimizerMoneyMove(optimizer(30), operation, now), false, operation);
  }
  // A Jarvis or assistant card is the owner's own request.
  const jarvis = { status: 'approved', created_at: daysAgo(30), action_payload: { source: 'jarvis' } };
  assert.equal(isExpiredOptimizerMoneyMove(jarvis, 'adjust_budget', now), false);
  // No readable time: nothing proves it is old.
  assert.equal(isExpiredOptimizerMoneyMove({ ...optimizer(0), created_at: null }, 'adjust_budget', now), false);
});

const CID = '1234567890';
const HANDLER_BUDGET = `customers/${CID}/campaignBudgets/456`;
const HANDLER_CAMPAIGN = `customers/${CID}/campaigns/555`;

type HandlerWorld = {
  rec: Row;
  history: Row[];
  aiActions: Row[];
  mutations: number;
  consumed: number;
};

function handlerWorld(options: {
  source?: string;
  operation?: string;
  ageDays: number;
  status?: string;
  history?: Row[];
  params?: Record<string, unknown>;
}): HandlerWorld {
  const operation = options.operation ?? 'adjust_budget';
  const params =
    options.params ??
    (operation === 'adjust_budget' ? { budget_resource: HANDLER_BUDGET, delta_pct: 15 } : {});
  return {
    rec: {
      id: 'rec-1',
      account_id: 'account-1',
      title: 'عنوان',
      description: 'وصف',
      expected_impact: { metric: 'conversions', delta_pct: 5, delta_sar_per_month: 100 },
      action_payload: {
        source: options.source ?? 'optimizer_cron',
        operation,
        target_id: operation === 'adjust_budget' ? HANDLER_BUDGET : HANDLER_CAMPAIGN,
        params,
      },
      status: options.status ?? 'approved',
      created_at: daysAgo(options.ageDays),
    },
    history: options.history ?? [],
    aiActions: [],
    mutations: 0,
    consumed: 0,
  };
}

function handler(world: HandlerWorld) {
  const account = { id: 'account-1', customer_id: CID, manager_id: null, currency_code: 'SAR', refresh_token_encrypted: 'enc' };
  const client = () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'u@example.com' } } }) },
    from(table: string) {
      const op = { kind: 'select' as 'select' | 'insert' | 'update', values: null as any, filters: [] as Array<[string, string, unknown]> };
      const run = () => {
        if (table === 'recommendations') {
          if (op.kind === 'update') {
            const eqStatus = op.filters.find((f) => f[0] === 'eq' && f[1] === 'status');
            if (eqStatus && eqStatus[2] !== world.rec.status) return { data: null, error: null };
            if (op.values.status) world.rec.status = op.values.status;
            if (op.values.applied_result) world.rec.applied_result = op.values.applied_result;
            return { data: { id: world.rec.id }, error: null };
          }
          return { data: world.rec, error: null };
        }
        if (table === 'google_ads_accounts') return { data: account, error: null };
        if (table === 'ai_actions') {
          if (op.kind === 'insert') {
            world.aiActions.push(op.values);
            return { data: { id: `log-${world.aiActions.length}` }, error: null };
          }
          const type = op.filters.find((f) => f[0] === 'eq' && f[1] === 'action_type')?.[2];
          return { data: world.history.filter((row) => !type || row.action_type === type), error: null };
        }
        return { data: [], error: null };
      };
      const builder: any = {
        select: () => builder,
        insert: (values: unknown) => ((op.kind = 'insert'), (op.values = values), builder),
        update: (values: unknown) => ((op.kind = 'update'), (op.values = values), builder),
        eq: (k: string, v: unknown) => (op.filters.push(['eq', k, v]), builder),
        in: (k: string, v: unknown) => (op.filters.push(['in', k, v]), builder),
        is: (k: string, v: unknown) => (op.filters.push(['is', k, v]), builder),
        gte: () => builder,
        lte: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => run(),
        maybeSingle: async () => run(),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });

  const route = createRecommendationActionHandler({
    createServerClient: (async () => client()) as any,
    createAdminClient: (() => client()) as any,
    checkRateLimit: (async () => ({ allowed: true, remaining: 10, resetAt: '', retryAfterSeconds: 0 })) as any,
    decrypt: () => 'refresh-token',
    getCustomer: (() => ({})) as any,
    getSubscriptionAccess: (async () => ({ active: true, plan: 'pro', status: 'active', trialEndsAt: null, currentPeriodEnd: null })) as any,
    consumeFeatureUsage: (async () => {
      world.consumed += 1;
      return { ok: true, plan: 'pro', limit: 100, used: 1, remaining: 99, resetsAt: '', usageEventId: 'usage-1' };
    }) as any,
    refundFeatureUsage: (async () => true) as any,
    sendOpsAlert: (async () => ({ sent: true, id: 'ops' })) as any,
    randomUUID: () => 'exec-key-1' as `${string}-${string}-${string}-${string}-${string}`,
    // The preflight reads the live budget from Google Ads; here it just fills in the amounts.
    prepareActionForExecution: (async (action: OptimizerAction) => ({
      action:
        action.type === 'adjust_budget'
          ? { ...action, params: { ...action.params, current_amount_micros: 10_000_000, new_amount_micros: 11_500_000 } }
          : action,
      rollbackPayload: {},
      measurement: null,
    })) as any,
    executeAction: (async () => {
      world.mutations += 1;
      return { results: [] };
    }) as any,
  });

  return async (intent = 'execute') => {
    const body = new URLSearchParams({ recommendation_id: 'rec-1', intent, next: '/optimizer' });
    const response = await route(
      new NextRequest('http://localhost/api/recommendations/action', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    );
    return { status: response.status, location: response.headers.get('location') ?? '' };
  };
}

test('handler: an optimizer budget card older than 7 days is not executed and says why', async () => {
  const world = handlerWorld({ ageDays: 8 });
  const result = await handler(world)();
  assert.equal(result.status, 303);
  assert.match(result.location, /\/optimizer\?error=recommendation_expired$/);
  assert.equal(world.rec.status, 'failed');
  assert.equal(world.rec.applied_result.status, 'recommendation_expired');
  assert.equal(world.mutations, 0);
  assert.equal(world.consumed, 0, 'no quota is spent on an expired card');
  assert.ok(world.aiActions.some((row) => row.action_type === 'recommendation_expired'));
});

test('handler: an expired optimizer bid card is refused the same way, through approve_execute too', async () => {
  const world = handlerWorld({
    ageDays: 9,
    operation: 'adjust_bid',
    status: 'pending',
    params: { ad_group_resource: `customers/${CID}/adGroups/55`, target_roas: 6.6, current_target_roas: 6 },
  });
  world.rec.action_payload.target_id = `customers/${CID}/adGroups/55`;
  const result = await handler(world)('approve_execute');
  assert.match(result.location, /error=recommendation_expired$/);
  assert.equal(world.mutations, 0);
});

test('handler: a 6-day-old optimizer budget card whose budget changed since is routed to review', async () => {
  const world = handlerWorld({
    ageDays: 6,
    history: [executedRow('adjust_budget', { budget_resource: HANDLER_BUDGET }, daysAgo(2), 'rec-other')],
  });
  const result = await handler(world)();
  assert.match(result.location, /\/optimizer\?error=recent_change_lock$/);
  assert.equal(world.rec.status, 'failed');
  assert.equal(world.rec.applied_result.status, 'recent_change_lock');
  assert.equal(world.mutations, 0);
  assert.equal(world.consumed, 0);
});

test('handler: a 6-day-old optimizer budget card executes when nothing else touched the budget, or only the card itself did', async () => {
  const clean = handlerWorld({ ageDays: 6 });
  assert.match((await handler(clean)()).location, /\/optimizer\?executed=1$/);
  assert.equal(clean.rec.status, 'applied');
  assert.equal(clean.mutations, 2, 'validate-only, then the live mutate');

  const own = handlerWorld({ ageDays: 6, history: [executedRow('adjust_budget', { budget_resource: HANDLER_BUDGET }, daysAgo(1), 'rec-1')] });
  assert.match((await handler(own)()).location, /executed=1$/);
});

test('handler: a Jarvis card is the owner\'s own request: no expiry and no recent-change lock', async () => {
  const world = handlerWorld({
    source: 'jarvis_exec',
    ageDays: 12,
    history: [executedRow('adjust_budget', { budget_resource: HANDLER_BUDGET }, daysAgo(1), 'rec-other')],
  });
  const result = await handler(world)();
  assert.match(result.location, /\/optimizer\?executed=1$/);
  assert.equal(world.rec.status, 'applied');
  assert.equal(world.mutations, 2);
});

test('handler: other optimizer operations keep their old shelf life (a 20-day-old campaign pause still runs)', async () => {
  const world = handlerWorld({ ageDays: 20, operation: 'pause_campaign', params: {} });
  world.rec.action_payload.target_id = HANDLER_CAMPAIGN;
  const result = await handler(world)();
  assert.match(result.location, /\/optimizer\?executed=1$/);
  assert.equal(world.rec.status, 'applied');
});
