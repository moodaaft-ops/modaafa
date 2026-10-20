import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CPA_SPIKE_FACTOR,
  buildSeries,
  changeActor,
  detectAccountStatus,
  detectAdPolicy,
  detectBilling,
  detectConversionsZero,
  detectCpaSpike,
  detectOutsideChanges,
  detectSpend,
  isOwnChange,
  median,
} from '../lib/guard/detectors';
import type { ChangeRow } from '../lib/guard/types';
import { NOW, YESTERDAY, baseSignals, campaignRows, flat } from './support/guard';

const HOUR = 3_600_000;

test('median of an even and an odd list', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('series: days without a row count as zero and the baseline is the 14 days before yesterday', () => {
  const series = buildSeries(campaignRows('1', 'a', { baseline: [...flat(0, 6), ...flat(100, 8)], yesterday: 40 }), YESTERDAY);
  assert.equal(series.baseline.length, 14);
  assert.equal(series.activeDays, 8);
  assert.equal(series.medianCost, 100);
  assert.equal(series.yesterday.cost, 40);
});

// ---------------------------------------------------------------------------
// Spend: zero
// ---------------------------------------------------------------------------
test('spend zero: the whole account that normally spends stops, critical, one account finding', () => {
  const signals = baseSignals({
    daily: [
      ...campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 0 }),
      ...campaignRows('2', 'ماركة', { baseline: flat(40), yesterday: 0 }),
    ],
  });
  const findings = detectSpend(signals);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'spend_zero');
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].entityType, 'account');
  assert.equal(findings[0].evidence.median_daily_spend_14d, 140);
  assert.match(findings[0].whatAr, /ما صرف شي أمس/);
  assert.equal(findings[0].dedupeKey, 'spend_zero:account');
});

test('spend zero: one campaign stops while the account still spends, high, campaign finding', () => {
  const signals = baseSignals({
    daily: [
      ...campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 0 }),
      ...campaignRows('2', 'ماركة', { baseline: flat(40), yesterday: 45 }),
    ],
  });
  const findings = detectSpend(signals);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].entityType, 'campaign');
  assert.equal(findings[0].entityId, '1');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].whatAr, /"بحث عام" ما صرفت/);
  assert.equal(findings[0].dedupeKey, 'spend_zero:campaign:1');
});

test('spend zero: a campaign that rarely spends, or just started, is not "normally spends"', () => {
  const signals = baseSignals({
    daily: [
      ...campaignRows('1', 'جديدة', { baseline: [...flat(0, 10), ...flat(80, 4)], yesterday: 0 }),
      ...campaignRows('2', 'ثابتة', { baseline: flat(60), yesterday: 60 }),
    ],
  });
  assert.deepEqual(detectSpend(signals), []);
});

test('spend: unreadable daily data says nothing', () => {
  const signals = baseSignals({ daily: campaignRows('1', 'a', { baseline: flat(100), yesterday: 0 }), ok: { ...baseSignals().ok, daily: false } });
  assert.deepEqual(detectSpend(signals), []);
});

// ---------------------------------------------------------------------------
// Spend: spike
// ---------------------------------------------------------------------------
test('spend spike: exactly twice the median fires, just under does not', () => {
  const at = (yesterday: number) =>
    detectSpend(baseSignals({ daily: campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday }) }));
  assert.equal(at(199).length, 0);
  const fired = at(200);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].code, 'spend_spike');
  assert.equal(fired[0].entityType, 'account');
  assert.equal(fired[0].severity, 'high');
  assert.equal(fired[0].evidence.ratio, 2);
  assert.match(fired[0].whatAr, /ضعف/);
});

test('spend spike: a small absolute jump is noise whatever the ratio', () => {
  const signals = baseSignals({ daily: campaignRows('1', 'a', { baseline: flat(5), yesterday: 14 }) });
  assert.deepEqual(detectSpend(signals), []);
});

test('spend spike: a campaign over twice its daily budget is high, within it medium', () => {
  const signals = baseSignals({
    daily: [
      ...campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 260 }),
      ...campaignRows('2', 'ماركة', { baseline: flat(100), yesterday: 100 }),
    ],
    campaigns: [
      { id: '1', name: 'بحث عام', status: 'ENABLED', dailyBudget: 100, primaryStatus: null, primaryReasons: [], budgetLostIs: null, rankLostIs: null, impressionShare: null, baselineImpressionShare: null },
    ],
  });
  // Account total (360) against a median of 200 is under twice, so the campaign says it.
  const findings = detectSpend(signals);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].entityType, 'campaign');
  assert.equal(findings[0].severity, 'high');
  const withinBudget = detectSpend(
    baseSignals({
      daily: [
        ...campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 230 }),
        ...campaignRows('2', 'ماركة', { baseline: flat(100), yesterday: 100 }),
      ],
      campaigns: [
        { id: '1', name: 'بحث عام', status: 'ENABLED', dailyBudget: 150, primaryStatus: null, primaryReasons: [], budgetLostIs: null, rankLostIs: null, impressionShare: null, baselineImpressionShare: null },
      ],
    })
  );
  assert.equal(withinBudget[0].severity, 'medium');
});

// ---------------------------------------------------------------------------
// Tracking suspicion
// ---------------------------------------------------------------------------
const convDays = (n: number) => [...flat(0, 14 - n), ...flat(2, n)];

test('conversions zero: converts 12 of 14 days, spent and clicked yesterday, no conversion: says check tracking first', () => {
  const signals = baseSignals({
    daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv: convDays(12), yesterday: 100, yesterdayConv: 0, yesterdayClicks: 25 }),
  });
  const { finding, campaignIds } = detectConversionsZero(signals);
  assert.ok(finding);
  assert.deepEqual(campaignIds, ['1']);
  assert.equal(finding.code, 'conversions_zero');
  assert.equal(finding.severity, 'high');
  assert.match(finding.stepAr, /افحص التتبع أول/);
  assert.equal((finding.evidence.campaigns as any[])[0].converting_days_14d, 12);
  assert.equal(finding.dedupeKey, 'conversions_zero:account');
});

test('conversions zero: a campaign that converts only some days, or barely clicked, is not suspicious', () => {
  const sometimes = baseSignals({
    daily: campaignRows('1', 'a', { baseline: flat(100), conv: convDays(9), yesterday: 100, yesterdayConv: 0 }),
  });
  assert.equal(detectConversionsZero(sometimes).finding, null);
  const fewClicks = baseSignals({
    daily: campaignRows('1', 'a', { baseline: flat(100), conv: convDays(13), yesterday: 100, yesterdayConv: 0, yesterdayClicks: 2 }),
  });
  assert.equal(detectConversionsZero(fewClicks).finding, null);
  const converted = baseSignals({
    daily: campaignRows('1', 'a', { baseline: flat(100), conv: convDays(13), yesterday: 100, yesterdayConv: 1 }),
  });
  assert.equal(detectConversionsZero(converted).finding, null);
});

test('conversions zero: a small campaign is medium, the one that carries the account is high', () => {
  const signals = baseSignals({
    daily: [
      ...campaignRows('1', 'صغيرة', { baseline: flat(30), conv: [...flat(0, 2), ...flat(1, 12)], yesterday: 30, yesterdayConv: 0 }),
      ...campaignRows('2', 'كبيرة', { baseline: flat(200), conv: flat(5), yesterday: 200, yesterdayConv: 5 }),
    ],
  });
  assert.equal(detectConversionsZero(signals).finding?.severity, 'medium');
});

// ---------------------------------------------------------------------------
// CPA
// ---------------------------------------------------------------------------
test('cpa spike: twice the 14 day CPA with enough history fires; too little history does not', () => {
  const fired = detectCpaSpike(
    baseSignals({ daily: campaignRows('1', 'a', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1 }) })
  );
  assert.ok(fired);
  assert.equal(fired.code, 'cpa_spike');
  assert.equal(fired.evidence.ratio, 2);
  assert.ok((fired.evidence.ratio as number) >= CPA_SPIKE_FACTOR);
  assert.equal(
    detectCpaSpike(baseSignals({ daily: campaignRows('1', 'a', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1.5 }) })),
    null
  );
  assert.equal(
    detectCpaSpike(baseSignals({ daily: campaignRows('1', 'a', { baseline: flat(100), conv: [...flat(0, 11), 1, 1, 1], yesterday: 100, yesterdayConv: 1 }) })),
    null
  );
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------
test('ad policy: disapproved ads group per campaign, high, human escalation, with the topic in words', () => {
  const signals = baseSignals({
    ads: [
      { adId: '11', campaignId: '1', campaignName: 'بحث عام', approval: 'DISAPPROVED', topics: ['DESTINATION_NOT_WORKING'] },
      { adId: '12', campaignId: '1', campaignName: 'بحث عام', approval: 'DISAPPROVED', topics: ['DESTINATION_NOT_WORKING'] },
      { adId: '21', campaignId: '2', campaignName: 'ماركة', approval: 'APPROVED_LIMITED', topics: ['TRADEMARKS'] },
    ],
  });
  const findings = detectAdPolicy(signals);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].escalation, 'human');
  assert.match(findings[0].whatAr, /إعلانين انرفض في حملة "بحث عام" بسبب الرابط ما يفتح/);
  assert.match(findings[0].stepAr, /واتساب/);
  assert.equal(findings[1].severity, 'medium');
});

test('ad policy: the same ads give the same key, one more ad gives a new one (newly disapproved)', () => {
  const ad = (adId: string) => ({ adId, campaignId: '1', campaignName: 'a', approval: 'DISAPPROVED' as const, topics: [] });
  const key = (ids: string[]) => detectAdPolicy(baseSignals({ ads: ids.map(ad) }))[0].dedupeKey;
  assert.equal(key(['11', '12']), key(['12', '11']));
  assert.notEqual(key(['11', '12']), key(['11', '12', '13']));
});

test('ad policy: unreadable ads say nothing', () => {
  const signals = baseSignals({
    ads: [{ adId: '1', campaignId: '1', campaignName: 'a', approval: 'DISAPPROVED', topics: [] }],
    ok: { ...baseSignals().ok, ads: false },
  });
  assert.deepEqual(detectAdPolicy(signals), []);
});

// ---------------------------------------------------------------------------
// Account status and billing
// ---------------------------------------------------------------------------
test('account status: suspended, canceled and closed are critical and go to a person', () => {
  for (const status of ['SUSPENDED', 'CANCELED', 'CLOSED', 'CUSTOMER_NOT_ENABLED']) {
    const finding = detectAccountStatus(baseSignals({ googleStatus: status }));
    assert.ok(finding, status);
    assert.equal(finding.severity, 'critical');
    assert.equal(finding.escalation, 'human');
    assert.equal(finding.dedupeKey, `account_status:${status}`);
    assert.match(finding.stepAr, /واتساب/);
  }
  assert.equal(detectAccountStatus(baseSignals({ googleStatus: 'ENABLED' })), null);
  assert.equal(detectAccountStatus(baseSignals({ googleStatus: 'SUSPENDED', ok: { ...baseSignals().ok, status: false } })), null);
});

test('billing: every setup cancelled is a finding, one approved or pending is not, none at all is not', () => {
  const run = (setupStatuses: string[]) => detectBilling(baseSignals({ billing: { setupStatuses, budgets: [] } }));
  assert.equal(run(['CANCELLED', 'CANCELLED']).length, 1);
  assert.equal(run(['CANCELLED', 'APPROVED']).length, 0);
  assert.equal(run(['PENDING']).length, 0);
  assert.equal(run([]).length, 0);
  assert.equal(run(['CANCELLED'])[0].code, 'billing_setup');
});

test('billing: an approved account budget that is spent is high, nearly spent medium, plenty left nothing', () => {
  const budget = (served: number, limit: number | null = 1000, endsAt: number | null = null, status = 'APPROVED') => ({
    name: 'b1',
    status,
    limit,
    served,
    endsAt,
  });
  const run = (b: ReturnType<typeof budget>) => detectBilling(baseSignals({ billing: { setupStatuses: ['APPROVED'], budgets: [b] } }));
  assert.equal(run(budget(1000))[0].severity, 'high');
  assert.match(run(budget(1000))[0].dedupeKey, /exhausted/);
  assert.equal(run(budget(900))[0].severity, 'medium');
  assert.match(run(budget(900))[0].whatAr, /90%/);
  assert.equal(run(budget(500)).length, 0);
  assert.equal(run(budget(2000, 1000, null, 'CANCELLED')).length, 0);
  assert.equal(run(budget(2000, null)).length, 0);
  assert.equal(run(budget(2000, 1000, NOW.getTime() - HOUR)).length, 0);
  const ending = run(budget(100, 1000, NOW.getTime() + 2 * 86_400_000));
  assert.equal(ending.length, 1);
  assert.match(ending[0].dedupeKey, /ends/);
});

test('billing: unreadable billing says nothing', () => {
  const signals = baseSignals({ billing: { setupStatuses: ['CANCELLED'], budgets: [] }, ok: { ...baseSignals().ok, billing: false } });
  assert.deepEqual(detectBilling(signals), []);
});

// ---------------------------------------------------------------------------
// Changes from outside
// ---------------------------------------------------------------------------
const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  at: NOW.getTime() - 5 * HOUR,
  clientType: 'GOOGLE_ADS_WEB_CLIENT',
  resourceType: 'CAMPAIGN_BUDGET',
  operation: 'UPDATE',
  resourceName: 'customers/1234567890/campaignBudgets/9',
  campaignId: '1',
  campaignName: 'بحث عام',
  fields: 'amount_micros',
  ...over,
});

test('outside change: what our own execution log explains is excluded, what it does not is reported', () => {
  const executedAt = NOW.getTime() - 10 * HOUR;
  const own = [{ at: [executedAt], resources: ['customers/1234567890/campaigns/5'] }];

  // Ours: the API, right next to our executed action.
  assert.equal(isOwnChange(change({ clientType: 'GOOGLE_ADS_API', at: executedAt + 60_000 }), own), true);
  // Ours: the API, a resource named in our rollback payload, a few hours later.
  assert.equal(
    isOwnChange(change({ clientType: 'GOOGLE_ADS_API', at: executedAt + 2 * HOUR, resourceName: 'customers/1234567890/campaigns/5' }), own),
    true
  );
  // Not ours: the API but nowhere near anything we logged.
  assert.equal(isOwnChange(change({ clientType: 'GOOGLE_ADS_API', at: executedAt + 5 * HOUR }), own), false);
  // Not ours: a person in the web client, even at the same minute.
  assert.equal(isOwnChange(change({ at: executedAt }), own), false);

  const signals = baseSignals({
    ownActions: own,
    changes: [change({ clientType: 'GOOGLE_ADS_API', at: executedAt + 60_000 }), change({ at: NOW.getTime() - 3 * HOUR })],
  });
  const findings = detectOutsideChanges(signals);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.count, 1);
  assert.equal(findings[0].evidence.actor, 'user');
});

test('outside change: only the last 24 hours, grouped by who, severity by what changed', () => {
  const signals = baseSignals({
    changes: [
      change({ at: NOW.getTime() - 30 * HOUR }),
      change({ clientType: 'GOOGLE_ADS_RECOMMENDATIONS', resourceType: 'CAMPAIGN', at: NOW.getTime() - 2 * HOUR, resourceName: 'customers/1/campaigns/1' }),
      change({ clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'AD_GROUP_CRITERION', at: NOW.getTime() - 3 * HOUR, resourceName: 'customers/1/adGroupCriteria/1' }),
    ],
  });
  const findings = detectOutsideChanges(signals);
  assert.equal(findings.length, 2);
  const google = findings.find((f) => f.evidence.actor === 'google_auto')!;
  const user = findings.find((f) => f.evidence.actor === 'user')!;
  assert.equal(google.severity, 'medium');
  assert.equal(user.severity, 'info');
  assert.match(google.whatAr, /قوقل نفسه/);
  assert.equal(user.evidence.count, 1);
});

test('outside change: the same changes give the same key on the next run, so they are not told twice', () => {
  const rows = [change({ at: NOW.getTime() - 2 * HOUR })];
  const key = () => detectOutsideChanges(baseSignals({ changes: rows }))[0].dedupeKey;
  assert.equal(key(), key());
});

test('outside change: unreadable log says nothing; API actors map to tools, web to people', () => {
  assert.deepEqual(detectOutsideChanges(baseSignals({ changes: [change()], ok: { ...baseSignals().ok, changes: false } })), []);
  assert.equal(changeActor('GOOGLE_ADS_API'), 'tool');
  assert.equal(changeActor('GOOGLE_ADS_SCRIPTS'), 'tool');
  assert.equal(changeActor('GOOGLE_ADS_MOBILE_APP'), 'user');
  assert.equal(changeActor('GOOGLE_ADS_AUTOMATED_RULE'), 'google_auto');
});
