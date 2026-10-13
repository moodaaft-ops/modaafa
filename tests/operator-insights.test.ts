import assert from 'node:assert/strict';
import test from 'node:test';

import {
  biggestLeak,
  buildAttentionQueue,
  buildCustomerProfiles,
  computeEngineHealth,
  computeFunnel,
  computeRevenue,
  headline,
  riyadhDay,
  type OperatorDataset,
} from '../lib/platform/operator-insights';

const NOW = Date.parse('2026-10-12T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

function dataset(partial: Partial<OperatorDataset>): OperatorDataset {
  return {
    users: [],
    auth: {},
    businesses: [],
    accounts: [],
    subscriptions: [],
    audits: [],
    overrides: [],
    invoices: [],
    usage: [],
    recommendations: [],
    actions: [],
    jobs: [],
    webhooks: [],
    auditLog: [],
    operatorEmails: ['owner@modaafa.com'],
    monthlyPrices: { starter: 500, growth: 1200, pro: 2500 },
    unavailable: [],
    ...partial,
  };
}

/**
 * Seven customers, one per stage, plus the owner:
 *   u1 signed up 3 days ago, never opened the email link
 *   u2 confirmed, no business
 *   u3 business, no ad account (2 days)
 *   u4 connected, no audit
 *   u5 audited 4 days ago, no trial
 *   u6 trialing growth, trial ends tomorrow, ad account paused by Google
 *   u7 paying pro
 */
function sample() {
  return dataset({
    users: [
      { id: 'u1', email: 'u1@x.sa', created_at: iso(-3) },
      { id: 'u2', email: 'u2@x.sa', created_at: iso(-3) },
      { id: 'u3', email: 'u3@x.sa', created_at: iso(-3), phone: '0551234567' },
      { id: 'u4', email: 'u4@x.sa', created_at: iso(-5) },
      { id: 'u5', email: 'u5@x.sa', created_at: iso(-6) },
      { id: 'u6', email: 'u6@x.sa', created_at: iso(-13) },
      { id: 'u7', email: 'u7@x.sa', created_at: iso(-40) },
      { id: 'op', email: 'owner@modaafa.com', created_at: iso(-60) },
    ],
    auth: {
      u1: { email_confirmed_at: null, last_sign_in_at: null },
      u2: { email_confirmed_at: iso(-3), last_sign_in_at: iso(-3) },
      u3: { email_confirmed_at: iso(-3), last_sign_in_at: iso(-3) },
      u4: { email_confirmed_at: iso(-5), last_sign_in_at: iso(-5) },
      u5: { email_confirmed_at: iso(-6), last_sign_in_at: iso(-4) },
      u6: { email_confirmed_at: iso(-13), last_sign_in_at: iso(-1) },
      u7: { email_confirmed_at: iso(-40), last_sign_in_at: iso(-1) },
    },
    businesses: [
      { id: 'b3', user_id: 'u3', name: 'ورد', created_at: iso(-2) },
      { id: 'b4', user_id: 'u4', name: 'عسل', created_at: iso(-5) },
      { id: 'b5', user_id: 'u5', name: 'قهوة', created_at: iso(-6) },
      { id: 'b6', user_id: 'u6', name: 'نظارات', created_at: iso(-13) },
      { id: 'b7', user_id: 'u7', name: 'كفرات', created_at: iso(-40) },
    ],
    accounts: [
      { id: 'a4', business_id: 'b4', status: 'active', is_manager: false, linked_at: iso(-4), last_synced_at: iso(0) },
      { id: 'a5', business_id: 'b5', status: 'active', is_manager: false, linked_at: iso(-6), last_synced_at: iso(0) },
      { id: 'a6', business_id: 'b6', status: 'paused', google_status: 'CUSTOMER_NOT_ENABLED', is_manager: false, linked_at: iso(-12) },
      { id: 'a7', business_id: 'b7', status: 'active', is_manager: false, linked_at: iso(-39), last_synced_at: iso(0) },
      { id: 'm7', business_id: 'b7', status: 'active', is_manager: true, linked_at: iso(-39) },
    ],
    audits: [
      { account_id: 'a5', ran_at: iso(-4) },
      { account_id: 'a6', ran_at: iso(-12) },
      { account_id: 'a7', ran_at: iso(-30) },
    ],
    subscriptions: [
      { user_id: 'u6', plan: 'growth', status: 'trialing', trial_ends_at: iso(1), created_at: iso(-13), stripe_subscription_id: 'sub_6' },
      { user_id: 'u7', plan: 'pro', status: 'active', current_period_end: iso(20), created_at: iso(-39), stripe_subscription_id: 'sub_7' },
    ],
    invoices: [{ user_id: 'u7', status: 'paid', amount_sar: 2500 }],
    usage: [{ user_id: 'u7', feature: 'assistant', created_at: iso(-1) }],
  });
}

test('each customer lands on their furthest stage, and the owner is flagged', () => {
  const profiles = buildCustomerProfiles(sample(), NOW);
  const stage = Object.fromEntries(profiles.map((p) => [p.id, p.stage]));
  assert.deepEqual(stage, {
    u1: 'signed_up',
    u2: 'confirmed',
    u3: 'business',
    u4: 'connected',
    u5: 'audited',
    u6: 'trial',
    u7: 'paying',
    op: 'signed_up',
  });
  assert.equal(profiles.find((p) => p.id === 'op')!.isOperator, true);
  // The manager account does not count as an ad account.
  assert.equal(profiles.find((p) => p.id === 'u7')!.accounts.total, 1);
});

test('the funnel counts each milestone and the drop between steps, owner excluded', () => {
  const steps = computeFunnel(buildCustomerProfiles(sample(), NOW), 'all', NOW);
  assert.deepEqual(
    steps.map((s) => s.reached),
    [7, 6, 5, 4, 3, 2, 1]
  );
  assert.equal(steps[1].dropped, 1);
  assert.equal(steps[0].fromPrevious, null);
  assert.ok(Math.abs((steps[2].fromPrevious ?? 0) - 5 / 6) < 1e-9);
  // The 7-day cohort drops the two older signups.
  assert.equal(computeFunnel(buildCustomerProfiles(sample(), NOW), '7d', NOW)[0].reached, 5);
  // Paying is not treated as a leak.
  assert.notEqual(biggestLeak(steps)?.stage, 'paying');
});

test('revenue: paying MRR, trial pipeline, and tomorrow on the charge calendar flagged at risk', () => {
  const revenue = computeRevenue(buildCustomerProfiles(sample(), NOW), NOW);
  assert.equal(revenue.mrr, 2500);
  assert.equal(revenue.payingCustomers, 1);
  assert.equal(revenue.trialPipeline, 1200);
  assert.equal(revenue.collectedTotal, 2500);
  const tomorrow = revenue.upcoming.find((day) => day.date === riyadhDay(iso(1)))!;
  assert.equal(tomorrow.count, 1);
  assert.equal(tomorrow.atRisk, 1);
});

test('who needs you: the expiring trial with no working account comes first', () => {
  const queue = buildAttentionQueue(buildCustomerProfiles(sample(), NOW), NOW);
  assert.equal(queue[0].profile.id, 'u6');
  assert.equal(queue[0].reason, 'trial_ending_no_account');
  assert.equal(queue[0].severity, 'critical');
  const reasons = Object.fromEntries(queue.map((item) => [item.profile.id, item.reason]));
  assert.equal(reasons.u1, 'never_logged_in');
  assert.equal(reasons.u3, 'no_ads_account');
  assert.equal(reasons.u4, 'connected_no_audit');
  assert.equal(reasons.u5, 'audited_no_trial');
  // Owner, the paying active customer and the confirmed-only user are not on it.
  assert.equal(reasons.op, undefined);
  assert.equal(reasons.u7, undefined);
  assert.equal(reasons.u2, undefined);
  // u6 is also Google-disabled; it is listed once with the extra reason noted.
  assert.equal(queue.filter((item) => item.profile.id === 'u6').length, 1);
  assert.ok(queue[0].more.length >= 1);
});

test('a suspended customer is off the follow-up list, but still counts in MRR while Stripe bills', () => {
  const data = sample();
  data.overrides = [{ user_id: 'u7', kind: 'suspension', plan: null, revoked_at: null, created_at: iso(-1) }];
  const profiles = buildCustomerProfiles(data, NOW);
  const u7 = profiles.find((p) => p.id === 'u7')!;
  assert.equal(u7.access, 'suspended');
  assert.equal(u7.stripeStatus, 'active');
  assert.equal(u7.mrr, 2500);
  assert.equal(buildAttentionQueue(profiles, NOW).some((item) => item.profile.id === 'u7'), false);
});

test('a higher free plan over a Stripe trial shows as comp, and the trial still sits on the charge calendar', () => {
  const data = sample();
  data.overrides = [{ user_id: 'u6', kind: 'plan_grant', plan: 'pro', expires_at: null, revoked_at: null, created_at: iso(-1) }];
  const profiles = buildCustomerProfiles(data, NOW);
  const u6 = profiles.find((p) => p.id === 'u6')!;
  assert.equal(u6.access, 'comp');
  assert.equal(u6.stripeStatus, 'trialing');
  assert.equal(computeRevenue(profiles, NOW).upcoming.find((day) => day.date === riyadhDay(iso(1)))!.count, 1);
});

test('a lower free plan does not hide a paid plan', () => {
  const data = sample();
  data.overrides = [{ user_id: 'u7', kind: 'plan_grant', plan: 'starter', expires_at: null, revoked_at: null, created_at: iso(-1) }];
  assert.equal(buildCustomerProfiles(data, NOW).find((p) => p.id === 'u7')!.access, 'active');
});

test('a free plan grant shows as comp and is not revenue', () => {
  const data = sample();
  data.overrides = [{ user_id: 'u5', kind: 'plan_grant', plan: 'pro', expires_at: null, revoked_at: null, created_at: iso(-1) }];
  const profiles = buildCustomerProfiles(data, NOW);
  const u5 = profiles.find((p) => p.id === 'u5')!;
  assert.equal(u5.access, 'comp');
  assert.equal(u5.mrr, 0);
  assert.equal(computeRevenue(profiles, NOW).compCustomers, 1);
});

test('engine health: a sync with no success for 6 hours is failing and leads the headline', () => {
  const data = sample();
  data.jobs = [
    { job_name: 'sync-google-ads', status: 'failed', started_at: iso(-0.05), error_message: 'OPERATOR_FIELD_MISMATCH' },
    { job_name: 'sync-google-ads', status: 'success', started_at: iso(-0.25), processed: 20 },
    { job_name: 'optimize', status: 'success', started_at: iso(-0.1), processed: 22, error_count: 0 },
  ];
  const health = computeEngineHealth(data, NOW);
  const sync = health.jobs.find((job) => job.key === 'sync')!;
  assert.equal(sync.state, 'failing');
  assert.equal(sync.lastError, 'OPERATOR_FIELD_MISMATCH');
  assert.equal(health.jobs.find((job) => job.key === 'optimize')!.state, 'ok');
  assert.equal(health.jobs.find((job) => job.key === 'connect')!.state, 'idle');

  const profiles = buildCustomerProfiles(data, NOW);
  const top = headline({ attention: buildAttentionQueue(profiles, NOW), health, revenue: computeRevenue(profiles, NOW) });
  assert.equal(top.tone, 'danger');
  assert.match(top.text, /تحديث بيانات الحسابات/);
});

test('engine health: optimizer accounts resting in their cooldown do not read as errors', () => {
  const data = sample();
  data.jobs = [
    { job_name: 'sync-google-ads', status: 'success', started_at: iso(-0.1), processed: 20 },
    { job_name: 'optimize', status: 'partial', started_at: iso(-0.1), processed: 1, error_count: 1, details: { cooled_down_accounts: 28 } },
  ];
  assert.equal(computeEngineHealth(data, NOW).jobs.find((job) => job.key === 'optimize')!.state, 'ok');

  // The same run without the resting accounts is one failure in two: a warning.
  data.jobs[1] = { job_name: 'optimize', status: 'partial', started_at: iso(-0.1), processed: 1, error_count: 1 };
  assert.equal(computeEngineHealth(data, NOW).jobs.find((job) => job.key === 'optimize')!.state, 'warning');
});

test('stuck executions count when older than 30 minutes', () => {
  const data = sample();
  data.recommendations = [
    { account_id: 'a7', status: 'executing', created_at: iso(-1), execution_started_at: new Date(NOW - 45 * 60 * 1000).toISOString() },
    { account_id: 'a7', status: 'executing', created_at: iso(0), execution_started_at: new Date(NOW - 5 * 60 * 1000).toISOString() },
  ];
  assert.equal(computeEngineHealth(data, NOW).recommendations.stuck, 1);
  const queue = buildAttentionQueue(buildCustomerProfiles(data, NOW), NOW);
  assert.equal(queue.find((item) => item.profile.id === 'u7')?.reason, 'execution_failed');
});

test('a 0 SAR invoice at trial start is not a payment', () => {
  const data = sample();
  data.invoices.push({ user_id: 'u6', status: 'paid', amount_sar: 0 });
  const u6 = buildCustomerProfiles(data, NOW).find((p) => p.id === 'u6')!;
  assert.equal(u6.milestones.paying, false);
  assert.equal(u6.paidInvoices, 0);
});

test('yearly plans count a twelfth of the yearly price when Stripe has one', () => {
  const data = sample();
  data.subscriptions[1] = { ...data.subscriptions[1], billing_period: 'yearly' };
  data.yearlyPrices = { pro: 24000 };
  assert.equal(buildCustomerProfiles(data, NOW).find((p) => p.id === 'u7')!.mrr, 2000);
});

test('the funnel is cumulative: a trial without an audit still counts as past the audit step', () => {
  const data = sample();
  data.audits = data.audits.filter((audit) => audit.account_id !== 'a6');
  const steps = computeFunnel(buildCustomerProfiles(data, NOW), 'all', NOW);
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].reached <= steps[i - 1].reached);
  assert.equal(steps.find((s) => s.stage === 'audited')!.reached, 3);
});
