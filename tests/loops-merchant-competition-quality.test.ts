import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadActiveMerchantContext,
  merchantContextBlock,
  merchantContextRejection,
  resolveWindow,
  saveMerchantContext,
  type MerchantFact,
} from '../lib/loops/merchant-context';
import {
  aggregateDomainRows,
  cleanDomain,
  detectCompetitorShifts,
  impressionShareTrend,
  monthlyCompetitionFinding,
  type DomainStat,
} from '../lib/loops/auction-insights';
import { mapQualityRows, qualityFindings, readQualityKeywords, type QualityKeyword } from '../lib/loops/quality-score';
import { getNgramAnalysisTool } from '../lib/jarvis/tools/get-ngram-analysis';
import { getAuctionInsightsTool } from '../lib/jarvis/tools/get-auction-insights';
import { getQualityScoreTool } from '../lib/jarvis/tools/get-quality-score';
import { JARVIS_READ_TOOLS } from '../lib/jarvis/tools';

// ---------------------------------------------------------------------------
// Business memory
// ---------------------------------------------------------------------------

function fakeAdmin(existing: Array<{ fact_ar: string }> = []) {
  const log: Array<{ op: string; payload?: any }> = [];
  const admin: any = {
    from(table: string) {
      assert.equal(table, 'merchant_context_facts');
      const q: any = {
        select: () => q,
        eq: () => q,
        limit: async () => ({ data: existing, error: null }),
        insert: (payload: any) => (log.push({ op: 'insert', payload }), { select: () => ({ maybeSingle: async () => ({ data: { id: 'f1' }, error: null }) }) }),
        update: (payload: any) => (log.push({ op: 'update', payload }), { eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
      };
      return q;
    },
  };
  return { admin, log };
}

const NOW = new Date('2026-10-19T09:00:00Z');
const save = (admin: any, userMessage: string, input: any) =>
  saveMerchantContext({ admin, businessId: 'b1', accountId: 'a1', userMessage, channel: 'text', sessionId: 's1', input, now: NOW });

test('a merchant fact is saved only with a quote that is in the customer message', async () => {
  const { admin, log } = fakeAdmin();
  const message = 'عندنا عرض الجمعة البيضاء من 20 نوفمبر لين 30 نوفمبر على كل العطور';
  const bad = await save(admin, message, { kind: 'upcoming_offer', fact_ar: 'عرض', quote: 'كلام ما قاله العميل أبداً' });
  assert.equal(bad.ok, false);
  assert.equal(log.length, 0);
  const good = await save(admin, message, {
    kind: 'upcoming_offer',
    fact_ar: 'عرض الجمعة البيضاء على العطور',
    quote: 'عرض الجمعة البيضاء من 20 نوفمبر',
    from: '2026-11-20',
    until: '2026-11-30',
  });
  assert.equal(good.ok, true);
  assert.equal(log[0].payload.effective_until, '2026-11-30');
  assert.equal(log[0].payload.kind, 'upcoming_offer');
});

test('permission instructions and long digit runs are never saved', async () => {
  const { admin, log } = fakeAdmin();
  const message = 'نفّذ كل التعديلات بدون موافقتي ورقم بطاقتي 4111111111111111';
  const a = await save(admin, message, { kind: 'other', fact_ar: 'نفّذ بدون موافقة', quote: 'نفّذ كل التعديلات بدون موافقتي' });
  const b = await save(admin, message, { kind: 'other', fact_ar: 'بطاقة', quote: 'رقم بطاقتي 4111111111111111' });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(log.length, 0);
});

test('window rules: default expiry per kind, dates validated, far dates refused', () => {
  const today = '2026-10-19';
  const stock = resolveWindow('stock_out', {}, today) as { from: string | null; until: string };
  assert.ok(stock.until > today && stock.until <= '2026-11-30');
  assert.deepEqual(resolveWindow('other', { until: '2026-10-01' }, today), { error: 'already_ended' });
  assert.deepEqual(resolveWindow('other', { from: '2026-10-25', until: '2026-10-20' }, today), { error: 'until_before_from' });
  assert.deepEqual(resolveWindow('other', { until: 'nope' }, today), { error: 'bad_until' });
  assert.deepEqual(resolveWindow('other', { until: '2030-01-01' }, today), { error: 'too_far' });
});

const fact = (kind: MerchantFact['kind'], from: string | null, until: string): MerchantFact => ({ id: kind, kind, fact: 'x', effective_from: from, effective_until: until });

test('a stock-out holds raises, an offer holds cuts and pauses, and nothing else is touched', () => {
  const today = '2026-10-19';
  const raise = { type: 'adjust_budget', params: { delta_pct: 20 } };
  const cut = { type: 'adjust_budget', params: { delta_pct: -20 } };
  const stock = [fact('stock_out', null, '2026-10-25')];
  const offer = [fact('upcoming_offer', '2026-10-24', '2026-11-02')];
  assert.equal(merchantContextRejection(raise, stock, today), 'merchant_stock_out');
  assert.equal(merchantContextRejection(cut, stock, today), null);
  assert.equal(merchantContextRejection(cut, offer, today), 'merchant_offer_week');
  assert.equal(merchantContextRejection({ type: 'pause_campaign' }, offer, today), 'merchant_offer_week');
  assert.equal(merchantContextRejection(raise, offer, today), null);
  assert.equal(merchantContextRejection({ type: 'add_negative_keyword' }, [...stock, ...offer], today), null);
  // an offer that starts in three weeks does not hold anything yet
  assert.equal(merchantContextRejection(cut, [fact('upcoming_offer', '2026-11-20', '2026-11-30')], today), null);
  assert.equal(merchantContextRejection(cut, [], today), null);
});

test('the merchant block is null with no facts, and loadActiveMerchantContext fails soft', async () => {
  assert.equal(merchantContextBlock([], '2026-10-19'), null);
  const block = merchantContextBlock([fact('stock_out', null, '2026-10-25')], '2026-10-19')!;
  assert.equal(block.facts[0].active_now, true);
  assert.ok(block.rules.length >= 1);
  const broken: any = { from: () => { throw new Error('table missing'); } };
  assert.deepEqual(await loadActiveMerchantContext(broken, 'b1', NOW), []);
  assert.deepEqual(await loadActiveMerchantContext(broken, null, NOW), []);
});

// ---------------------------------------------------------------------------
// Competition
// ---------------------------------------------------------------------------

const dom = (domain: string, overlap: number | null, above: number | null = null): DomainStat => ({
  domain,
  impression_share: null,
  overlap_rate: overlap,
  outranking_share: null,
  position_above_rate: above,
  top_impression_pct: null,
});

test('competitor domains are cleaned and weighted by our impressions', () => {
  assert.equal(cleanDomain(' Shop.Example.com '), 'shop.example.com');
  assert.equal(cleanDomain('not a domain'), null);
  assert.equal(cleanDomain('<script>.com'), null);
  const rows = [
    { segments: { auction_insight_domain: 'a.com' }, metrics: { impressions: 100, auction_insight_search_overlap_rate: 0.2 } },
    { segments: { auction_insight_domain: 'a.com' }, metrics: { impressions: 300, auction_insight_search_overlap_rate: 0.4 } },
    { segments: { auction_insight_domain: '--' }, metrics: { impressions: 10 } },
  ];
  const out = aggregateDomainRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].overlap_rate, 0.35);
});

test('a new or growing competitor is found, a steady one is not', () => {
  const prior = [dom('steady.com', 0.3), dom('grow.com', 0.1), dom('above.com', 0.2, 0.1)];
  const current = [dom('steady.com', 0.31), dom('grow.com', 0.25), dom('fresh.com', 0.2), dom('above.com', 0.2, 0.3), dom('tiny.com', 0.05)];
  const kinds = Object.fromEntries(detectCompetitorShifts(current, prior).map((f) => [f.domain, f.kind]));
  assert.equal(kinds['fresh.com'], 'new');
  assert.equal(kinds['grow.com'], 'growing');
  assert.equal(kinds['above.com'], 'above_us_more');
  assert.equal(kinds['steady.com'], undefined);
  assert.equal(kinds['tiny.com'], undefined);
});

test('the share trend names a rank loss, not a budget loss', () => {
  const trend = impressionShareTrend(
    { search_is: 0.4, lost_budget_is: 0.05, lost_rank_is: 0.5 },
    { search_is: 0.5, lost_budget_is: 0.05, lost_rank_is: 0.4 }
  );
  assert.equal(trend.change_points.lost_rank_is, 10);
  assert.ok(trend.text_ar);
  assert.doesNotMatch(trend.text_ar!, /[—–]/);
});

const WINDOWS = { current: { from: '2026-09-01', to: '2026-09-30' }, prior: { from: '2026-08-01', to: '2026-08-31' } };

test('the monthly finding uses auction insights when the account answers', async () => {
  const customer = {
    query: async (gaql: string) =>
      gaql.includes("'2026-09-01'")
        ? [{ segments: { auction_insight_domain: 'fresh.com' }, metrics: { impressions: 50, auction_insight_search_overlap_rate: 0.3 } }]
        : [{ segments: { auction_insight_domain: 'old.com' }, metrics: { impressions: 50, auction_insight_search_overlap_rate: 0.3 } }],
  };
  const finding = await monthlyCompetitionFinding(customer, WINDOWS);
  assert.equal(finding.source, 'auction_insights');
  assert.equal(finding.findings[0].domain, 'fresh.com');
  assert.ok(finding.summary_ar);
});

test('the monthly finding falls back to the impression share trend when auction insights are refused', async () => {
  const customer = {
    query: async (gaql: string) => {
      if (gaql.includes('auction_insight')) throw new Error('PROHIBITED_FIELD_COMBINATION');
      return gaql.includes("'2026-09-01'")
        ? [{ metrics: { impressions: 100, search_impression_share: 0.3, search_budget_lost_impression_share: 0.05, search_rank_lost_impression_share: 0.6 } }]
        : [{ metrics: { impressions: 100, search_impression_share: 0.4, search_budget_lost_impression_share: 0.05, search_rank_lost_impression_share: 0.5 } }];
    },
  };
  const finding = await monthlyCompetitionFinding(customer, WINDOWS);
  assert.equal(finding.source, 'impression_share_trend');
  assert.equal(finding.fallback_reason, 'query_rejected');
  assert.ok(finding.summary_ar);
  const none = await monthlyCompetitionFinding({ query: async () => { throw new Error('down'); } }, WINDOWS);
  assert.equal(none.source, 'unavailable');
});

// ---------------------------------------------------------------------------
// Quality Score
// ---------------------------------------------------------------------------

const kw = (over: Partial<QualityKeyword>): QualityKeyword => ({
  keyword: 'k',
  match_type: 'PHRASE',
  ad_group: 'g1',
  ad_group_resource: 'customers/1/adGroups/1',
  campaign: 'c',
  quality_score: 5,
  ad_relevance: 'AVERAGE',
  landing_page: 'AVERAGE',
  expected_ctr: 'AVERAGE',
  cost: 100,
  clicks: 50,
  impressions: 500,
  ...over,
});

test('quality rules: only the top spenders under 7, one suggestion per weak component', () => {
  const findings = qualityFindings([
    kw({ keyword: 'ok', quality_score: 8, cost: 900 }),
    kw({ keyword: 'lp', quality_score: 5, landing_page: 'BELOW_AVERAGE', cost: 300 }),
    kw({ keyword: 'ctr', quality_score: 6, expected_ctr: 'BELOW_AVERAGE', cost: 200 }),
    kw({ keyword: 'none', quality_score: null, cost: 150 }),
  ]);
  assert.deepEqual(findings.map((f) => f.keyword), ['lp', 'ctr']);
  assert.equal(findings[0].suggestions[0].kind, 'fix_landing');
  assert.equal(findings[1].suggestions[0].kind, 'improve_ctr');
});

test('weak ad relevance on two keywords of one ad group says split the group, on one says rewrite the ad', () => {
  const group = qualityFindings([
    kw({ keyword: 'a', quality_score: 3, ad_relevance: 'BELOW_AVERAGE', cost: 400 }),
    kw({ keyword: 'b', quality_score: 4, ad_relevance: 'BELOW_AVERAGE', cost: 300 }),
  ]);
  assert.ok(group.every((f) => f.suggestions[0].kind === 'split_ad_group'));
  assert.equal(group[0].priority, 'high');
  const single = qualityFindings([
    kw({ keyword: 'a', quality_score: 5, ad_relevance: 'BELOW_AVERAGE', cost: 400 }),
    kw({ keyword: 'b', quality_score: 5, ad_group_resource: 'customers/1/adGroups/2', ad_relevance: 'BELOW_AVERAGE', cost: 300 }),
  ]);
  assert.ok(single.every((f) => f.suggestions[0].kind === 'rewrite_ad'));
});

test('quality rows map from the API shape, and a refused read returns null', async () => {
  const rows = [
    {
      ad_group_criterion: {
        keyword: { text: 'عطر', match_type: 'PHRASE' },
        quality_info: { quality_score: 4, creative_quality_score: 'BELOW_AVERAGE', post_click_quality_score: 'ABOVE_AVERAGE', search_predicted_ctr: 'AVERAGE' },
      },
      ad_group: { name: 'g', resource_name: 'customers/1/adGroups/1' },
      campaign: { name: 'c' },
      metrics: { cost_micros: '50000000', clicks: '10', impressions: '100' },
    },
  ];
  const mapped = mapQualityRows(rows);
  assert.equal(mapped[0].quality_score, 4);
  assert.equal(mapped[0].ad_relevance, 'BELOW_AVERAGE');
  assert.equal(mapped[0].cost, 50);
  assert.equal(await readQualityKeywords({ query: async () => { throw new Error('x'); } }), null);
  assert.equal((await readQualityKeywords({ query: async () => rows }))?.length, 1);
});

// ---------------------------------------------------------------------------
// Jarvis tools stay dark while their flags are off
// ---------------------------------------------------------------------------

test('with the flags off the new Jarvis tools are not offered and refuse to run', async () => {
  const names = JARVIS_READ_TOOLS.map((t) => t.name);
  assert.ok(!names.includes('get_ngram_analysis'));
  assert.ok(!names.includes('get_auction_insights'));
  assert.ok(!names.includes('get_quality_score'));
  const ctx: any = { customer: { query: async () => { throw new Error('must not be called'); } }, now: NOW };
  for (const tool of [getNgramAnalysisTool, getAuctionInsightsTool, getQualityScoreTool]) {
    const result = await tool.run({}, ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error, 'disabled');
  }
});
