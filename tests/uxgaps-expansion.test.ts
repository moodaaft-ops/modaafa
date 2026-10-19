import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExpansionRecommendation,
  clusterConvertingTerms,
  detectExpansionIdeas,
  expansionIdeasEnabled,
  findSaturatedCampaigns,
  objectiveFromGoal,
  suggestNewGeos,
  EXPANSION_OPERATION,
  type GeoRow,
} from '../lib/ai/expansion';
import { computeBreakEven } from '../lib/economics/break-even';
import { buildSnapshotEconomics } from '../lib/ai/optimizer-snapshot';
import type { OptimizerSnapshot } from '../lib/ai/optimizer-agent';

const CID = '123';
const economics = buildSnapshotEconomics(
  computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 } } }),
  null
);
function row(id: string, name: string, over: { type?: string; searchIs?: number; lostRank?: number; lostBudget?: number; conv?: number; value?: number; status?: string } = {}) {
  return {
    campaign: { id, name, resourceName: `customers/${CID}/campaigns/${id}` },
    campaignBudget: { id, amountMicros: '100000000', resourceName: `customers/${CID}/campaignBudgets/${id}` },
    diag: {
      type: over.type ?? 'SEARCH',
      bidding: 'MAXIMIZE_CONVERSION_VALUE',
      primary_status: over.status ?? 'ELIGIBLE',
      status_reasons: [],
      impressions_7d: 5000,
      search_is: over.searchIs ?? 0.6,
      lost_budget_is: over.lostBudget ?? 0.02,
      lost_rank_is: over.lostRank ?? 0.05,
    },
    last_30d: { cost_micros: 300_000_000, conversions: over.conv ?? 80, conversions_value: over.value ?? 2400 },
  };
}
function snap(rows: any[], tracking = 'healthy'): OptimizerSnapshot {
  return {
    account_id: 'acc',
    customer_id: CID,
    campaigns: rows,
    underperforming_keywords: [],
    high_performing_keywords: [],
    wasted_search_terms: [],
    budget_utilization: [],
    poor_ads: [],
    keyword_count: 10,
    currency_code: 'SAR',
    conversion_tracking: { status: tracking, enabled_actions: 2 },
    economics,
    ad_group_bid_targets: [],
    target_roas: 5,
    target_cpa: null,
  } as unknown as OptimizerSnapshot;
}

test('flag: exact "true" only', () => {
  assert.equal(expansionIdeasEnabled({}), false);
  assert.equal(expansionIdeasEnabled({ EXPANSION_IDEAS_ENABLED: 'TRUE' }), false);
  assert.equal(expansionIdeasEnabled({ EXPANSION_IDEAS_ENABLED: '1' }), false);
  assert.equal(expansionIdeasEnabled({ EXPANSION_IDEAS_ENABLED: 'true' }), true);
});

test('saturated and profitable: found; every other shape is not', () => {
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح')])).length, 1);
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { lostRank: 0.4 })])).length, 0, 'still losing to rank');
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { lostBudget: 0.3 })])).length, 0, 'budget still the limit: scale, not expand');
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { searchIs: 0.2 })])).length, 0, 'little of the demand captured');
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { conv: 5 })])).length, 0, 'too few conversions');
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { value: 100 })])).length, 0, 'below break-even');
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { type: 'PERFORMANCE_MAX' })])).length, 0);
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح', { status: 'LEARNING' })])).length, 0);
  assert.equal(findSaturatedCampaigns(snap([row('1', 'ح')], 'broken_recently')).length, 0, 'tracking not healthy');
  assert.equal(findSaturatedCampaigns({ ...snap([row('1', 'ح')]), economics: null } as any).length, 0, 'no economics');
});

const geoRows: GeoRow[] = [
  { resource: 'geoTargetConstants/1', name: 'جدة', cost: 100, clicks: 50, conversions: 5, value: 1000 },
  { resource: 'geoTargetConstants/2', name: 'الدمام', cost: 100, clicks: 50, conversions: 1, value: 1000 },
  { resource: 'geoTargetConstants/3', name: 'الرياض', cost: 100, clicks: 50, conversions: 5, value: 1000 },
  { resource: 'geoTargetConstants/4', name: 'أبها', cost: 900, clicks: 50, conversions: 3, value: 900 },
];
test('geo: converting, under the limit, not covered; unknown ancestry is not suggested', () => {
  const targeted = new Set(['geoTargetConstants/3']);
  const parents = new Map<string, string[]>([
    ['geoTargetConstants/1', ['geoTargetConstants/900']],
    ['geoTargetConstants/2', ['geoTargetConstants/900']],
    ['geoTargetConstants/4', ['geoTargetConstants/900']],
  ]);
  const out = suggestNewGeos({ rows: geoRows, targeted, parents, economics });
  assert.deepEqual(out.map((g) => g.name), ['جدة'], 'Dammam has 1 conversion, Abha is too costly, Riyadh is targeted');
  const covered = suggestNewGeos({ rows: geoRows, targeted: new Set(['geoTargetConstants/900']), parents, economics });
  assert.equal(covered.length, 0, 'a targeted province covers its cities');
  assert.equal(suggestNewGeos({ rows: geoRows, targeted, parents: new Map(), economics }).length, 0, 'unknown ancestry');
  assert.equal(suggestNewGeos({ rows: geoRows, targeted, parents, economics: null }).length, 0);
});

test('clusters: a shared word with two converting terms', () => {
  const t = (term: string, conversions: number, cost: number) => ({ term, clicks: 10, conversions, cost, conversion_value: cost * 10 });
  const clusters = clusterConvertingTerms([t('تنظيف بشرة جدة', 2, 40), t('تنظيف بشرة عميق', 2, 30), t('مساج استرخاء', 1, 10)]);
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].terms.length >= 2);
  assert.equal(clusterConvertingTerms([t('مساج', 5, 10)]).length, 0);
});

test('ideas: new ad group from clusters; geo only with geo input; type only with gates and a sales goal', () => {
  const t = (term: string, conversions: number, cost: number) => ({ term, clicks: 10, conversions, cost, conversion_value: cost * 10 });
  const terms = [t('كريم ترطيب وجه', 3, 20), t('كريم ترطيب يدين', 3, 20)];
  const base = { snapshot: snap([row('1', 'ح')]), geo: null, terms, signals: null, objective: null } as const;
  const ideas = detectExpansionIdeas(base);
  assert.deepEqual(ideas.map((i) => i.kind), ['new_ad_group']);

  const gated = detectExpansionIdeas({ ...base, signals: { conversions_30d: 80, tracking_healthy: true, merchant_center_linked: false }, objective: 'SALES' });
  assert.ok(!gated.some((i) => i.kind === 'new_campaign_type'), 'no Merchant Center, no type idea');
  const open = detectExpansionIdeas({ ...base, signals: { conversions_30d: 80, tracking_healthy: true, merchant_center_linked: true }, objective: 'SALES' });
  assert.ok(open.some((i) => i.kind === 'new_campaign_type'));
  const leads = detectExpansionIdeas({ ...base, signals: { conversions_30d: 80, tracking_healthy: true, merchant_center_linked: true }, objective: 'LEADS' });
  assert.ok(!leads.some((i) => i.kind === 'new_campaign_type'), 'leads never get Shopping or PMax');

  assert.deepEqual(detectExpansionIdeas({ ...base, snapshot: snap([row('1', 'ح', { lostBudget: 0.4 })]) }), []);
});

test('recommendation row: brief for the assistant, Najdi copy rules, no mutation payload', () => {
  const t = (term: string, conversions: number, cost: number) => ({ term, clicks: 10, conversions, cost, conversion_value: cost * 10 });
  const geoIdea = {
    kind: 'new_geo' as const,
    key: 'k',
    geos: [geoRows[0]],
    from: findSaturatedCampaigns(snap([row('1', 'حملة البحث')]))[0],
  };
  const adGroup = detectExpansionIdeas({ snapshot: snap([row('1', 'ح')]), geo: null, terms: [t('كريم ترطيب وجه', 3, 20), t('كريم ترطيب يدين', 3, 20)], signals: null, objective: null })[0];
  const type = { kind: 'new_campaign_type' as const, key: 'PMAX', campaign_type: 'PMAX' as const, from: geoIdea.from };
  for (const idea of [geoIdea, adGroup, type]) {
    const r = buildExpansionRecommendation(idea);
    assert.equal(r.action_payload.operation, EXPANSION_OPERATION);
    assert.equal(r.action_payload.source, 'optimizer_cron');
    assert.ok(r.action_payload.brief_ar.length > 20);
    const text = [r.title, r.description, r.action_payload.brief_ar].join(' ');
    assert.ok(!/[—–,]/.test(text), `no dash and no Latin comma: ${text}`);
    assert.ok(!/ليس مجرد/.test(text));
    assert.ok(!('params' in r.action_payload), 'recommendation only: nothing executable');
  }
});

test('objectiveFromGoal', () => {
  assert.equal(objectiveFromGoal('مبيعات المتجر'), 'SALES');
  assert.equal(objectiveFromGoal('حجز مواعيد'), 'LEADS');
  assert.equal(objectiveFromGoal(null), null);
  assert.equal(objectiveFromGoal('وعي'), null);
});
