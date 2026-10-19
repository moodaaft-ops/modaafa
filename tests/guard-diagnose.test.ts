import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, detectAll, finalize } from '../lib/guard/analyze';
import type { ChangeRow, GuardFinding } from '../lib/guard/types';
import { NOW, baseSignals, campaignInfo, campaignRows, flat } from './support/guard';

const HOUR = 3_600_000;
const find = (findings: GuardFinding[], code: string) => findings.find((f) => f.code === code)!;

const stoppedSpend = () => campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 0 });
const budgetChange = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  at: NOW.getTime() - 20 * HOUR,
  clientType: 'GOOGLE_ADS_WEB_CLIENT',
  resourceType: 'CAMPAIGN_BUDGET',
  operation: 'UPDATE',
  resourceName: 'customers/1/campaignBudgets/9',
  campaignId: '1',
  campaignName: 'بحث عام',
  fields: 'amount_micros',
  ...over,
});

test('zero spend with a cancelled billing setup: billing is the cause and the case goes to a person', () => {
  const findings = analyze(
    baseSignals({
      daily: stoppedSpend(),
      billing: { setupStatuses: ['CANCELLED'], budgets: [] },
      changes: [budgetChange()],
    })
  );
  const spend = find(findings, 'spend_zero');
  assert.equal(spend.cause?.code, 'billing');
  assert.equal(spend.escalation, 'human');
  assert.deepEqual((spend.cause?.evidence as any).also_possible, ['recent_change']);
});

test('zero spend, nothing blocking: the campaign state is named', () => {
  const findings = analyze(
    baseSignals({
      daily: stoppedSpend(),
      campaigns: [campaignInfo('1', 'بحث عام', { primaryStatus: 'NOT_ELIGIBLE', primaryReasons: ['AD_GROUPS_PAUSED'] })],
    })
  );
  const spend = find(findings, 'spend_zero');
  assert.equal(spend.cause?.code, 'campaign_state');
  assert.match(spend.cause!.labelAr, /مجموعاتها الإعلانية موقوفة/);
});

test('tracking comes before recent changes: clicks steady, conversions gone, and someone also edited the budget', () => {
  const conv = [...flat(0, 2), ...flat(2, 12)];
  const findings = analyze(
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv, yesterday: 100, yesterdayConv: 0, yesterdayClicks: 22 }),
      changes: [budgetChange()],
    })
  );
  const conversions = find(findings, 'conversions_zero');
  assert.equal(conversions.cause?.code, 'tracking');
  assert.match(conversions.stepAr, /افحص التتبع أول/);
  assert.deepEqual((conversions.cause?.evidence as any).also_possible, ['recent_change']);
});

test('a spend spike right after someone raised the budget: the change is the cause, and it says who', () => {
  const findings = analyze(
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 260 }),
      changes: [budgetChange()],
    })
  );
  const spike = find(findings, 'spend_spike');
  assert.equal(spike.cause?.code, 'recent_change');
  assert.match(spike.cause!.labelAr, /مستخدم دخل على الحساب/);
  assert.equal((spike.cause!.evidence as any).outside, 1);
});

test('our own approved change is named as ours, not blamed on someone else', () => {
  const at = NOW.getTime() - 20 * HOUR;
  const findings = analyze(
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 260 }),
      changes: [budgetChange({ clientType: 'GOOGLE_ADS_API', at })],
      ownActions: [{ at: [at + 30_000], resources: [] }],
    })
  );
  const spike = find(findings, 'spend_spike');
  assert.equal(spike.cause?.code, 'recent_change');
  assert.match(spike.cause!.labelAr, /تعديلنا اللي اعتمدته/);
  assert.equal((spike.cause!.evidence as any).ours, 1);
  assert.equal(find([...findings, { code: 'x' } as any], 'outside_change'), undefined);
});

test('budget limit, disapproval and auction are found in that order when nothing earlier explains it', () => {
  const sig = (info: Record<string, unknown>, withAds = false) =>
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1, yesterdayClicks: 20 }),
      campaigns: [campaignInfo('1', 'بحث عام', info)],
      ads: withAds ? [{ adId: '1', campaignId: '1', campaignName: 'بحث عام', approval: 'DISAPPROVED', topics: [] }] : [],
    });
  // CPA spike: yesterday 100 for one conversion against a 50 baseline.
  const budget = find(analyze(sig({ budgetLostIs: 0.4, rankLostIs: 0.5 }, true)), 'cpa_spike');
  assert.equal(budget.cause?.code, 'budget_limit');
  assert.match(budget.cause!.labelAr, /40%/);
  assert.deepEqual((budget.cause!.evidence as any).also_possible, ['disapproval', 'auction']);
  assert.equal(find(analyze(sig({}, true)), 'cpa_spike').cause?.code, 'disapproval');
  const auction = find(analyze(sig({ rankLostIs: 0.45 })), 'cpa_spike');
  assert.equal(auction.cause?.code, 'auction');
});

test('bidding strategy still learning is named', () => {
  const findings = analyze(
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 300 }),
      campaigns: [campaignInfo('1', 'بحث عام', { primaryReasons: ['BIDDING_STRATEGY_LEARNING'] })],
    })
  );
  assert.equal(find(findings, 'spend_spike').cause?.code, 'bidding');
});

test('nothing explains it: unknown, with the generic step kept and no cause printed to the owner', () => {
  const findings = analyze(baseSignals({ daily: stoppedSpend() }));
  const spend = find(findings, 'spend_zero');
  assert.equal(spend.cause?.code, 'unknown');
  assert.equal(spend.stepAr, 'افحص الفوترة وحالة الحملات والإعلانات المرفوضة');
});

test('findings that are not anomalies get no diagnosis, and the list is ordered worst first', () => {
  const findings = analyze(
    baseSignals({
      googleStatus: 'SUSPENDED',
      daily: stoppedSpend(),
      ads: [{ adId: '1', campaignId: '1', campaignName: 'a', approval: 'APPROVED_LIMITED', topics: [] }],
    })
  );
  assert.equal(find(findings, 'account_status').cause, null);
  assert.equal(find(findings, 'ad_policy').cause, null);
  const order = findings.map((f) => f.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ['critical', 'high', 'medium', 'info'].indexOf(a) - ['critical', 'high', 'medium', 'info'].indexOf(b)));
  assert.equal(findings[0].severity, 'critical');
});

test('detectAll then finalize equals analyze', () => {
  const signals = baseSignals({ daily: stoppedSpend() });
  assert.deepEqual(finalize(detectAll(signals), signals), analyze(signals));
});
