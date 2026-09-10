import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendationReadiness } from '../lib/ai/recommendation-readiness';
import { loadCampaignsForDateRange } from '../lib/analytics/campaign-performance';
import { resolveDateRange } from '../lib/analytics/date-range';
import { auditSnapshotWindows } from '../lib/audit/report';
import { summarizeOperationalState } from '../lib/platform/health';
import { getEntitledUserIds, getEligibleAccountHealth } from '../lib/platform/jobs';

const now = Date.parse('2026-09-10T12:00:00Z');
const validRecommendation = {
  created_at: '2026-09-10T11:00:00Z', title: 'Budget',
  action_payload: { operation: 'adjust_budget', params: { budget_resource: 'customers/1234567890/campaignBudgets/42', delta_pct: -10 } },
};
test('approval requires complete, recent and account-scoped execution details', () => {
  assert.equal(recommendationReadiness(validRecommendation, '1234567890', now).ready, true);
  assert.equal(recommendationReadiness(validRecommendation, '9999999999', now).code, 'recommendation_incomplete');
  assert.equal(recommendationReadiness({ ...validRecommendation, action_payload: { operation: 'adjust_budget' } }, null, now).code, 'recommendation_incomplete');
  assert.equal(recommendationReadiness({ ...validRecommendation, action_payload: { operation: 'review_low_quality_keyword' } }, null, now).code, 'manual_review_required');
  for (const created_at of ['2026-08-20T00:00:00Z', '', 'invalid', '2026-09-11T00:00:00Z']) {
    assert.equal(recommendationReadiness({ ...validRecommendation, created_at }, null, now).code, 'recommendation_stale');
  }
});

for (const preset of ['7d', '30d'] as const) {
  test(`${preset} uses the actual selected dates even when old snapshots exist`, async () => {
    const range = resolveDateRange({ range: preset }, preset, new Date(now));
    const calls: any[] = [];
    const result = await loadCampaignsForDateRange({
      supabase: {} as any, userId: `range-${preset}`, selectedAccount: { id: preset, customer_id: '1234567890', currency_code: 'SAR' } as any,
      campaigns: [{ google_campaign_id: 1, metrics_7d: { cost: 999 }, metrics_30d: { cost: 999 } }], range,
    }, {
      getLinkedAccount: async () => ({ account: { id: preset, customer_id: '1234567890', refresh_token_encrypted: 'fake', currency_code: 'SAR' }, error: null }) as any,
      decryptToken: () => 'test',
      queryRange: async (input) => { calls.push(input); return [{ google_campaign_id: 1, metrics: { cost: 125 } }] as any; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].from, range.from);
    assert.equal(calls[0].to, range.to);
    assert.equal(result[0].range_metrics.cost, 125);
  });
}

test('a live range failure is propagated and is retried instead of returning a stale snapshot', async () => {
  let attempts = 0;
  const input = { supabase: {} as any, userId: 'failure-case', selectedAccount: { customer_id: '1234567890' } as any,
    campaigns: [{ metrics_7d: { cost: 999 } }], range: resolveDateRange({ range: '7d' }, '7d', new Date(now)) };
  const dependencies = {
    getLinkedAccount: async () => ({ account: { id: 'failure', refresh_token_encrypted: 'fake' }, error: null }) as any,
    decryptToken: () => 'test', queryRange: async () => { attempts++; throw new Error('Google unavailable'); },
  };
  await assert.rejects(loadCampaignsForDateRange(input, dependencies), /Google unavailable/);
  await assert.rejects(loadCampaignsForDateRange(input, dependencies), /Google unavailable/);
  assert.equal(attempts, 2);
});

test('audit periods use the account calendar and do not invent missing historical windows', () => {
  const windows = auditSnapshotWindows('2026-09-10T22:00:00Z', 'Asia/Riyadh');
  assert.deepEqual(windows?.last_7_days, { from: '2026-09-04', to: '2026-09-10' });
  assert.deepEqual(windows?.last_30_days, { from: '2026-08-12', to: '2026-09-10' });
  assert.equal(auditSnapshotWindows('2026-09-10T22:00:00Z', null), null);
  assert.equal(auditSnapshotWindows('invalid', 'Asia/Riyadh'), null);
});

test('operations distinguishes idle jobs, missing work and actual processing', () => {
  const jobs = ['sync-google-ads', 'optimize'].map((job_name) => ({ job_name, status: 'success', started_at: '2026-09-10T11:00:00Z', processed: 0 }));
  assert.equal(summarizeOperationalState(jobs, 0, now).state, 'idle');
  assert.equal(summarizeOperationalState(jobs, 4, now).state, 'no_work');
  assert.equal(summarizeOperationalState(jobs.map((job) => ({ ...job, processed: 4 })), 4, now).state, 'healthy');
  assert.equal(summarizeOperationalState([], 0, now).state, 'attention');
  assert.equal(summarizeOperationalState(jobs, 0, now + 24 * 3600000).state, 'attention');
});

test('operator eligibility excludes expired trials, unpaid and malformed periods', async () => {
  const rows = [
    { user_id: 'expired', status: 'trialing', trial_ends_at: '2020-01-01T00:00:00Z' },
    { user_id: 'paid', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
    { user_id: 'bad-date', status: 'active', current_period_end: 'bad' },
    { user_id: 'unpaid', status: 'paused', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  const query: any = { from: () => query, select: () => query, in: () => query, order: () => query, range: async () => ({ data: rows, error: null }) };
  assert.deepEqual(await getEntitledUserIds(query), ['paid']);
});

test('delivery health checks stale snapshots only within billable linked accounts and fails closed on read errors', async () => {
  const seen: any[] = [];
  function database(fail = false) {
    return { from(table: string) {
      const filters: any[] = [['from', table]];
      const query: any = {
        select: (...args: any[]) => { filters.push(['select', ...args]); return query; },
        eq: (...args: any[]) => { filters.push(['eq', ...args]); return query; },
        not: (...args: any[]) => { filters.push(['not', ...args]); return query; },
        in: (...args: any[]) => { filters.push(['in', ...args]); return query; },
        lt: (...args: any[]) => { filters.push(['lt', ...args]); return query; },
        or: (...args: any[]) => { filters.push(['or', ...args]); return query; },
        then: (resolve: any) => { seen.push(filters); return Promise.resolve({ count: filters.some((f) => f[0] === 'or') ? 1 : 5, error: fail ? new Error('database unavailable') : null }).then(resolve); },
      }; return query;
    } };
  }
  assert.deepEqual(await getEligibleAccountHealth(database(), [], now), { ok: true, total: 0, stale: 0, max_age_hours: 24 });
  assert.equal(seen.length, 0);
  const result = await getEligibleAccountHealth(database(), ['paid-business'], now);
  assert.equal(result.ok, false);
  assert.equal(result.stale, 1);
  assert.equal(result.total, 5);
  assert.ok(seen.every((filters) => filters.some((f: any) => f[0] === 'in' && f[1] === 'business_id' && f[2][0] === 'paid-business')));
  assert.ok(seen[1].some((f: any) => f[0] === 'lt' && f[1] === 'linked_at' && f[2] === '2026-09-09T12:00:00.000Z'));
  await assert.rejects(getEligibleAccountHealth(database(true), ['paid-business'], now), /database unavailable/);
});
