import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCostReport,
  cacheNetSavingUsd,
  optimizerMonthlyCeilingUsd,
  riyadhDayKey,
  type OptimizeRunRow,
  type UsageRow,
} from '../lib/platform/cost-insights';
import type { AnthropicCreditReading } from '../lib/platform/cost-config';

// 13:00 in Riyadh on 13 Oct 2026.
const NOW = Date.parse('2026-10-13T10:00:00Z');
const DAY = 86_400_000;

function row(daysAgo: number, cost: number, extra: Partial<UsageRow> = {}): UsageRow {
  return {
    created_at: new Date(NOW - daysAgo * DAY).toISOString(),
    user_id: 'user-a',
    feature: 'optimizer',
    model: 'claude-sonnet-5-5',
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: cost,
    priced: true,
    ...extra,
  };
}

function run(daysAgo: number, details: Record<string, unknown> | null = null, status = 'success'): OptimizeRunRow {
  return { started_at: new Date(NOW - daysAgo * DAY).toISOString(), status, details };
}

const CREDIT: AnthropicCreditReading = {
  balanceUsd: 201.24,
  purchasedUsd: 5.68,
  readAt: '2026-10-13T00:00:00+03:00',
  promoExpiresOn: '2026-11-07',
  autoReload: false,
};

const OPTIONS = { now: NOW, dailyAlertUsd: 5 };

/** A ledger that covers every one of the last 14 days so every window is complete. */
function fullLedger(costPerDay = 1) {
  return Array.from({ length: 14 }, (_, index) => row(index, costPerDay));
}

test('Riyadh day changes at 21:00 UTC', () => {
  assert.equal(riyadhDayKey(Date.parse('2026-10-12T20:59:59Z')), '2026-10-12');
  assert.equal(riyadhDayKey(Date.parse('2026-10-12T21:00:00Z')), '2026-10-13');
});

test('windows add up: today, yesterday, 7 days, previous 7 days, 30 days', () => {
  const report = buildCostReport(fullLedger(1), [], OPTIONS);
  assert.equal(report.todaySpend.costUsd, 1);
  assert.equal(report.yesterday.costUsd, 1);
  assert.equal(report.last7.costUsd, 7);
  assert.equal(report.last7.calls, 7);
  assert.equal(report.prev7?.costUsd, 7);
  assert.equal(report.last30.costUsd, 14);
  assert.equal(report.last7.avgDailyUsd, 1);
});

test('a young ledger averages over the days it covers and hides the previous week', () => {
  const young = [row(0, 2), row(1, 2), row(2, 2)];
  const report = buildCostReport(young, [], OPTIONS);
  assert.equal(report.observedDays7, 3);
  assert.equal(report.last7.avgDailyUsd, 2);
  assert.equal(report.prev7, null);
  assert.equal(report.firstRowDay, '2026-10-11');
});

test('an empty ledger gives zeros and no first day', () => {
  const report = buildCostReport([], [], OPTIONS);
  assert.equal(report.last30.costUsd, 0);
  assert.equal(report.firstRowDay, null);
  assert.equal(report.observedDays7, 1);
  assert.equal(report.cache.hitRatio, null);
  assert.equal(report.monthProjectionUsd, 0);
});

test('month projection is month to date plus the 7 day average for the days left', () => {
  // 13 Oct, October has 31 days, 18 left. Spend 1 a day for the 13 days of the month.
  const rows = Array.from({ length: 13 }, (_, index) => row(index, 1));
  const report = buildCostReport(rows, [], OPTIONS);
  assert.equal(report.monthToDate.costUsd, 13);
  assert.equal(report.monthToDate.dayOfMonth, 13);
  assert.equal(report.monthToDate.daysInMonth, 31);
  assert.equal(report.monthProjectionUsd, 13 + 1 * 18);
  assert.equal(report.next30DaysUsd, 30);
});

test('the daily series has 30 ordered, zero-filled days ending today', () => {
  const report = buildCostReport([row(0, 3, { feature: 'audit' }), row(5, 1)], [], OPTIONS);
  assert.equal(report.daily.length, 30);
  assert.equal(report.daily[29].day, '2026-10-13');
  assert.equal(report.daily[0].day, '2026-09-14');
  assert.equal(report.daily[29].costUsd, 3);
  assert.equal(report.daily[29].optimizerUsd, 0);
  assert.equal(report.daily[24].optimizerUsd, 1);
  assert.equal(report.daily[10].costUsd, 0);
});

test('rows older than 30 days do not enter the windows', () => {
  const report = buildCostReport([row(40, 99), row(0, 1)], [], OPTIONS);
  assert.equal(report.last30.costUsd, 1);
});

test('features and models are ranked by cost with shares that add to one', () => {
  const rows = [
    row(0, 6, { feature: 'optimizer' }),
    row(1, 3, { feature: 'audit', model: 'claude-opus-5-5' }),
    row(2, 1, { feature: 'assistant' }),
  ];
  const report = buildCostReport(rows, [], OPTIONS);
  assert.deepEqual(
    report.byFeature.map((item) => item.key),
    ['optimizer', 'audit', 'assistant']
  );
  assert.ok(Math.abs(report.byFeature.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-9);
  assert.equal(report.byFeature[0].share, 0.6);
  assert.equal(report.byModel[0].key, 'claude-sonnet-5-5');
  assert.equal(report.byModel[1].key, 'claude-opus-5-5');
});

test('cache net saving credits reads and charges the write premium', () => {
  // Sonnet 5.5 per million: input 2, cache read 0.1, cache write 2.5.
  const saving = cacheNetSavingUsd('claude-sonnet-5-5', { input: 0, cacheRead: 9000, cacheWrite: 2000 });
  assert.ok(Math.abs(saving - (9000 * 1.9 - 2000 * 0.5) / 1e6) < 1e-12);
  // Writing without ever reading is a net cost.
  assert.ok(cacheNetSavingUsd('claude-sonnet-5-5', { input: 0, cacheRead: 0, cacheWrite: 1000 }) < 0);
});

test('cache hit ratio is reads over all input tokens of the last 7 days', () => {
  const rows = [
    row(0, 1, { input_tokens: 1000, cache_read_tokens: 6000, cache_write_tokens: 1000 }),
    row(1, 1, { input_tokens: 2000, cache_read_tokens: 0, cache_write_tokens: 0 }),
    row(20, 1, { input_tokens: 99999, cache_read_tokens: 99999 }),
  ];
  const report = buildCostReport(rows, [], OPTIONS);
  assert.equal(report.cache.readTokens, 6000);
  assert.equal(report.cache.writeTokens, 1000);
  assert.equal(report.cache.freshInputTokens, 3000);
  assert.equal(report.cache.hitRatio, 6000 / 10000);
  assert.ok(report.cache.netSavingUsd > 0);
});

test('top users rank by cost and name their most expensive feature', () => {
  const rows = [
    row(0, 2, { user_id: 'u1', feature: 'assistant' }),
    row(0, 1, { user_id: 'u1', feature: 'audit' }),
    row(0, 5, { user_id: 'u2', feature: 'jarvis' }),
    row(0, 0.5, { user_id: null, feature: 'optimizer' }),
  ];
  const report = buildCostReport(rows, [], OPTIONS);
  assert.deepEqual(
    report.topUsers.map((user) => user.userId),
    ['u2', 'u1', null]
  );
  assert.equal(report.topUsers[1].topFeature, 'assistant');
  assert.equal(report.topUsers[1].costUsd, 3);
});

test('optimizer readings: runs, cost per call, guard counts and the avoided estimate', () => {
  const rows = [row(0, 0.5), row(0, 0.5), row(1, 1), row(2, 1, { feature: 'audit' })];
  const runs = [
    run(0, { model_calls: 10, skipped_idle: 4, cooled_down_accounts: 6 }),
    run(1, { model_calls: 8, skipped_idle: 2, cooled_down_accounts: 8 }),
    run(2, { batch_limit: 60 }, 'failed'), // before the guards shipped
    run(40, { model_calls: 99 }),
  ];
  const report = buildCostReport(rows, runs, OPTIONS);
  const optimizer = report.optimizer;
  assert.equal(optimizer.runs7, 3);
  assert.equal(optimizer.runs30, 3);
  assert.equal(optimizer.failedRuns7, 1);
  assert.equal(optimizer.ledgerCalls7, 3);
  assert.equal(optimizer.costUsd7, 2);
  assert.equal(optimizer.costPerCall7, 0.666667);
  assert.equal(optimizer.costPerRun7, 0.666667);
  assert.equal(optimizer.guardRuns7, 2);
  assert.equal(optimizer.skippedIdle7, 6);
  assert.equal(optimizer.cooledDown7, 14);
  assert.equal(optimizer.avoidedUsd7, Math.round(20 * (2 / 3) * 100) / 100);
});

test('the avoided estimate stays null until there is a cost per call to price it with', () => {
  const report = buildCostReport([], [run(0, { model_calls: 0, skipped_idle: 3, cooled_down_accounts: 5 })], OPTIONS);
  assert.equal(report.optimizer.costPerCall7, null);
  assert.equal(report.optimizer.avoidedUsd7, null);
});

test('monthly ceiling follows the cooldown and is absent without one', () => {
  assert.equal(optimizerMonthlyCeilingUsd(30, 12, 0.02), 36);
  assert.equal(optimizerMonthlyCeilingUsd(30, 24, 0.02), 18);
  assert.equal(optimizerMonthlyCeilingUsd(30, 0, 0.02), null);
  assert.equal(optimizerMonthlyCeilingUsd(30, 12, null), null);
  // A cooldown shorter than an hour cannot beat 24 passes a day.
  assert.equal(optimizerMonthlyCeilingUsd(10, 0.5, 0.01), 72);
});

test('credit: estimated balance, runway and the paid credit left when the promo expires', () => {
  // 1.24 spent since the reading (start of 13 Oct Riyadh), 2 a day on average.
  const rows = [row(0, 1.24), ...Array.from({ length: 6 }, (_, i) => row(i + 1, 2.1))];
  const report = buildCostReport(rows, [], { ...OPTIONS, credit: CREDIT });
  const credit = report.credit!;
  assert.equal(credit.spentSinceReadUsd, 1.24);
  assert.equal(credit.estimatedBalanceUsd, 200);
  assert.equal(credit.promoUsd, 195.56);
  assert.equal(credit.daysToPromoExpiry, 25);
  assert.equal(credit.dailyAvgUsd, 1.98);
  assert.equal(credit.runwayDays, Math.floor(200 / report.last7.avgDailyUsd));
  assert.equal(credit.paidAtExpiryUsd, 5.68);
  assert.equal(credit.paidRunwayDays, Math.floor(5.68 / report.last7.avgDailyUsd));
});

test('credit: when the whole balance runs out before the expiry, no paid credit is left', () => {
  const small: AnthropicCreditReading = { ...CREDIT, balanceUsd: 10, purchasedUsd: 5.68 };
  const rows = Array.from({ length: 7 }, (_, i) => row(i, 2));
  const credit = buildCostReport(rows, [], { ...OPTIONS, credit: small }).credit!;
  assert.equal(credit.paidAtExpiryUsd, 0);
  assert.equal(credit.paidRunwayDays, 0);
});

test('credit: no spend means no runway number instead of a division by zero', () => {
  const credit = buildCostReport([], [], { ...OPTIONS, credit: CREDIT }).credit!;
  assert.equal(credit.runwayDays, null);
  assert.equal(credit.paidRunwayDays, null);
  assert.equal(credit.estimatedBalanceUsd, 201.24);
});

test('credit: a promo date in the past is treated as gone', () => {
  const past: AnthropicCreditReading = { ...CREDIT, promoExpiresOn: '2026-10-01' };
  const credit = buildCostReport([], [], { ...OPTIONS, credit: past }).credit!;
  assert.equal(credit.daysToPromoExpiry, null);
  assert.equal(credit.paidAtExpiryUsd, null);
});

test('alerts: a day over the limit is a warning, double the limit is danger, below is quiet', () => {
  const warn = buildCostReport([row(0, 6)], [], OPTIONS).alerts.find((a) => a.code === 'daily_spike');
  assert.equal(warn?.tone, 'warning');
  assert.equal(warn?.values.when, 'today');
  const danger = buildCostReport([row(1, 11)], [], OPTIONS).alerts.find((a) => a.code === 'daily_spike');
  assert.equal(danger?.tone, 'danger');
  assert.equal(danger?.values.when, 'yesterday');
  assert.equal(buildCostReport([row(0, 4.99)], [], OPTIONS).alerts.some((a) => a.code === 'daily_spike'), false);
});

test('alerts: a weekly rise needs two full weeks of ledger and a real jump', () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => row(i, 2)),
    ...Array.from({ length: 7 }, (_, i) => row(i + 7, 1)),
  ];
  const rise = buildCostReport(rows, [], OPTIONS).alerts.find((a) => a.code === 'week_rise');
  assert.equal(rise?.values.risePct, 100);
  const young = buildCostReport(rows.slice(0, 7), [], OPTIONS);
  assert.equal(young.alerts.some((a) => a.code === 'week_rise'), false);
});

test('alerts: unpriced models, a metering gap, thin runway, missing auto-reload and a stale reading', () => {
  const unpriced = buildCostReport([row(0, 1, { priced: false })], [], OPTIONS);
  assert.equal(unpriced.alerts.find((a) => a.code === 'unpriced_calls')?.values.calls, 1);

  const gap = buildCostReport([], [run(0, { model_calls: 12 })], OPTIONS);
  assert.equal(gap.alerts.find((a) => a.code === 'metering_gap')?.tone, 'danger');

  const rows = Array.from({ length: 7 }, (_, i) => row(i, 60));
  const thin = buildCostReport(rows, [], { ...OPTIONS, credit: CREDIT, dailyAlertUsd: 1000 });
  assert.equal(thin.alerts.find((a) => a.code === 'runway_critical')?.tone, 'danger');
  assert.ok(thin.alerts.some((a) => a.code === 'auto_reload_off'));

  const stale = buildCostReport([], [], {
    ...OPTIONS,
    credit: { ...CREDIT, readAt: '2026-09-01T00:00:00+03:00' },
  });
  assert.ok(stale.alerts.some((a) => a.code === 'reading_stale'));
});

test('alerts: the promo expiry notice carries what is left in paid credit', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i, 2));
  const report = buildCostReport(rows, [], { ...OPTIONS, credit: CREDIT });
  const promo = report.alerts.find((a) => a.code === 'promo_expiring');
  // 25 days away is informational; inside 14 days it turns into a warning.
  assert.equal(promo?.tone, 'info');
  assert.equal(promo?.values.days, 25);
  assert.equal(promo?.values.paidAtExpiryUsd, 5.68);
  const close = buildCostReport(rows, [], {
    ...OPTIONS,
    now: Date.parse('2026-10-28T10:00:00Z'),
    credit: CREDIT,
  }).alerts.find((a) => a.code === 'promo_expiring');
  assert.equal(close?.tone, 'warning');
});

test('alerts come back most urgent first', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i, 60));
  const report = buildCostReport(rows, [], { ...OPTIONS, credit: CREDIT });
  const tones = report.alerts.map((a) => a.tone);
  const rank = { danger: 0, warning: 1, info: 2 } as const;
  assert.deepEqual(tones, [...tones].sort((a, b) => rank[a] - rank[b]));
});
