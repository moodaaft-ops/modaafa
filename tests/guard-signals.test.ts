import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleAdsRestError } from '../lib/google-ads/client';
import {
  ADS_QUERY,
  CAMPAIGN_INFO_QUERY,
  loadSignals,
  mergeImpressionShare,
  parseAds,
  parseBilling,
  parseCampaignInfo,
  parseChanges,
  parseDaily,
  toOwnActions,
  withImpressionShare,
} from '../lib/guard/signals';
import { addDaysYmd, ymdInZone, zonedStringToEpoch } from '../lib/guard/time';
import { NOW, YESTERDAY, baseSignals } from './support/guard';

test('time: yesterday is read in the account zone, not UTC', () => {
  // 21:30 UTC on 18 Oct is already 19 Oct in Riyadh and still 18 Oct in Los Angeles.
  const at = new Date('2026-10-18T21:30:00Z');
  assert.equal(ymdInZone(at, 'Asia/Riyadh'), '2026-10-19');
  assert.equal(ymdInZone(at, 'America/Los_Angeles'), '2026-10-18');
  assert.equal(ymdInZone(at, 'Not/AZone'), '2026-10-19');
  assert.equal(addDaysYmd('2026-10-01', -1), '2026-09-30');
});

test('time: change_date_time strings are wall-clock in the account zone', () => {
  assert.equal(new Date(zonedStringToEpoch('2026-10-19 05:30:00.123456', 'Asia/Riyadh')!).toISOString(), '2026-10-19T02:30:00.000Z');
  // Los Angeles is UTC-7 in October (daylight time), UTC-8 after the change in November.
  assert.equal(new Date(zonedStringToEpoch('2026-10-19 05:30:00', 'America/Los_Angeles')!).toISOString(), '2026-10-19T12:30:00.000Z');
  assert.equal(new Date(zonedStringToEpoch('2026-11-19 05:30:00', 'America/Los_Angeles')!).toISOString(), '2026-11-19T13:30:00.000Z');
  assert.equal(zonedStringToEpoch('garbage', 'Asia/Riyadh'), null);
});

test('parsers read REST camelCase rows', () => {
  const daily = parseDaily([
    { campaign: { id: '5', name: 'بحث' }, segments: { date: '2026-10-17' }, metrics: { costMicros: '12500000', conversions: 2.5, clicks: '30', impressions: '400' } },
    { campaign: {}, segments: { date: '2026-10-17' }, metrics: {} },
  ]);
  assert.deepEqual(daily, [{ campaignId: '5', campaignName: 'بحث', date: '2026-10-17', cost: 12.5, conversions: 2.5, clicks: 30, impressions: 400 }]);

  const info = parseCampaignInfo([
    { campaign: { id: '5', name: 'بحث', status: 'ENABLED', primaryStatus: 'LIMITED', primaryStatusReasons: ['BUDGET_CONSTRAINED'] }, campaignBudget: { amountMicros: '150000000' } },
  ]);
  assert.equal(info[0].dailyBudget, 150);
  assert.deepEqual(info[0].primaryReasons, ['BUDGET_CONSTRAINED']);

  const ads = parseAds([
    { adGroupAd: { ad: { id: '11' }, policySummary: { approvalStatus: 'DISAPPROVED', policyTopicEntries: [{ topic: 'TRADEMARKS', type: 'PROHIBITED' }] } }, campaign: { id: '5', name: 'بحث' } },
    { adGroupAd: { ad: { id: '12' }, policySummary: { approvalStatus: 'APPROVED' } }, campaign: { id: '5', name: 'بحث' } },
  ]);
  assert.deepEqual(ads, [{ adId: '11', campaignId: '5', campaignName: 'بحث', approval: 'DISAPPROVED', topics: ['TRADEMARKS'] }]);

  const billing = parseBilling(
    [{ billingSetup: { status: 'APPROVED' } }],
    [
      { accountBudget: { name: 'b', status: 'APPROVED', approvedSpendingLimitMicros: '1000000000', adjustedSpendingLimitMicros: '0', amountServedMicros: '250000000', approvedEndTimeType: 'FOREVER' } },
      { accountBudget: { name: 'c', status: 'APPROVED', adjustedSpendingLimitMicros: '2000000000', amountServedMicros: '1', approvedEndDateTime: '2026-10-21 23:59:59' } },
    ],
    'Asia/Riyadh'
  );
  assert.deepEqual(billing.setupStatuses, ['APPROVED']);
  assert.equal(billing.budgets[0].limit, 1000);
  assert.equal(billing.budgets[0].served, 250);
  assert.equal(billing.budgets[0].endsAt, null);
  assert.equal(billing.budgets[1].limit, 2000);
  assert.equal(new Date(billing.budgets[1].endsAt!).toISOString(), '2026-10-21T20:59:59.000Z');

  const changes = parseChanges(
    [
      {
        changeEvent: { changeDateTime: '2026-10-19 04:00:00.5', clientType: 'GOOGLE_ADS_WEB_CLIENT', changeResourceType: 'CAMPAIGN_BUDGET', resourceChangeOperation: 'UPDATE', changeResourceName: 'customers/1/campaignBudgets/9', campaign: 'customers/1/campaigns/77', changedFields: 'amount_micros' },
        campaign: { name: 'بحث' },
      },
    ],
    'Asia/Riyadh'
  );
  assert.equal(changes[0].campaignId, '77');
  assert.equal(new Date(changes[0].at).toISOString(), '2026-10-19T01:00:00.000Z');
});

test('own actions: queued approvals are not executions; rollback payload resources are kept', () => {
  const own = toOwnActions([
    { action_type: 'approval_queued', created_at: '2026-10-18T10:00:00Z' },
    { action_type: 'add_negatives', created_at: '2026-10-18T11:00:00Z', reverted_at: '2026-10-18T12:00:00Z', rollback_payload: { resource_names: ['customers/1/campaignCriteria/1~2'], budget_resource: 'customers/1/campaignBudgets/9' } },
  ]);
  assert.equal(own.length, 1);
  assert.equal(own[0].at.length, 2);
  assert.deepEqual(own[0].resources.sort(), ['customers/1/campaignBudgets/9', 'customers/1/campaignCriteria/1~2']);
});

test('impression share: yesterday goes to the lost shares, the other days to the baseline', () => {
  const merged = mergeImpressionShare(
    parseCampaignInfo([{ campaign: { id: '5', name: 'a', status: 'ENABLED' } }]),
    [
      { campaign: { id: '5' }, segments: { date: YESTERDAY }, metrics: { searchImpressionShare: 0.4, searchBudgetLostImpressionShare: 0.25, searchRankLostImpressionShare: 0.1 } },
      { campaign: { id: '5' }, segments: { date: '2026-10-10' }, metrics: { searchImpressionShare: 0.8 } },
      { campaign: { id: '5' }, segments: { date: '2026-10-11' }, metrics: { searchImpressionShare: 0.6 } },
    ],
    YESTERDAY
  );
  assert.equal(merged[0].budgetLostIs, 0.25);
  assert.equal(merged[0].impressionShare, 0.4);
  assert.ok(Math.abs((merged[0].baselineImpressionShare as number) - 0.7) < 1e-9);
});

function fakeCustomer(handlers: Record<string, () => any[] | Error>) {
  const calls: string[] = [];
  return {
    calls,
    async query(gaql: string) {
      calls.push(gaql);
      const key = Object.keys(handlers).find((k) => gaql.includes(k));
      if (!key) return [];
      const out = handlers[key]();
      if (out instanceof Error) throw out;
      return out;
    },
  };
}
const account = { id: 'acc-1', customerId: '1234567890', currency: 'SAR', timeZone: 'Asia/Riyadh', storedGoogleStatus: null };
const emptySupabase = (rows: any[] = []) => ({
  from: () => {
    const b: any = { select: () => b, eq: () => b, gte: () => b, order: () => b, limit: async () => ({ data: rows, error: null }) };
    return b;
  },
});

test('loader: a failing read marks only its own source unknown', async () => {
  const customer = fakeCustomer({
    'FROM customer': () => [{ customer: { status: 'ENABLED' } }],
    'FROM ad_group_ad': () => new Error('boom'),
    'FROM billing_setup': () => new Error('permission'),
    'FROM account_budget': () => new Error('permission'),
  });
  const signals = await loadSignals({ account, customer, supabase: emptySupabase(), now: NOW });
  assert.equal(signals.yesterday, YESTERDAY);
  assert.deepEqual(signals.ok, { status: true, daily: true, campaigns: true, ads: false, billing: false, changes: true });
});

test('loader: an account Google says is not enabled stops after the status read', async () => {
  const customer = fakeCustomer({ 'FROM customer': () => new GoogleAdsRestError(403, 'denied', ['CUSTOMER_NOT_ENABLED']) });
  const signals = await loadSignals({ account, customer, supabase: emptySupabase(), now: NOW });
  assert.equal(signals.googleStatus, 'CUSTOMER_NOT_ENABLED');
  assert.equal(signals.ok.status, true);
  assert.equal(signals.ok.daily, false);
  assert.equal(customer.calls.length, 1);
});

test('loader: a suspended account is read once and nothing else is asked of Google', async () => {
  const customer = fakeCustomer({ 'FROM customer': () => [{ customer: { status: 'SUSPENDED' } }] });
  const signals = await loadSignals({ account, customer, supabase: emptySupabase(), now: NOW });
  assert.equal(signals.googleStatus, 'SUSPENDED');
  assert.equal(customer.calls.length, 1);
});

test('loader: with the execution log unreadable, outside changes stay unknown instead of blaming us', async () => {
  const customer = fakeCustomer({ 'FROM customer': () => [{ customer: { status: 'ENABLED' } }] });
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'x' } }) }) }) }) }) }) };
  const signals = await loadSignals({ account, customer, supabase, now: NOW });
  assert.equal(signals.ok.changes, false);
});

test('phase two: the impression-share read is fail-soft and skipped without campaign info', async () => {
  const base = baseSignals({ campaigns: parseCampaignInfo([{ campaign: { id: '5', name: 'a', status: 'ENABLED' } }]) });
  const failing = fakeCustomer({ search_impression_share: () => new Error('x') });
  assert.equal(await withImpressionShare(base, failing), base);
  const skipped = fakeCustomer({});
  await withImpressionShare({ ...base, ok: { ...base.ok, campaigns: false } }, skipped);
  assert.equal(skipped.calls.length, 0);
});

test('queries are bounded: every read has a LIMIT and only enabled things', () => {
  for (const query of [ADS_QUERY, CAMPAIGN_INFO_QUERY]) {
    assert.match(query, /LIMIT \d+/);
    assert.match(query, /'ENABLED'/);
  }
});
