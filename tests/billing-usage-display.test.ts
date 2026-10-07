import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PLAN_LIMITS } from '../lib/billing/entitlements';
import {
  FEATURE_ORDER,
  TRIAL_DAYS,
  buildUsageMeter,
  describePlanLimit,
  featureLabel,
  formatResetAr,
  planFeatureLines,
  quotaExceededMessage,
  trialDaysLeft,
  usageDeniedMessage,
} from '../lib/billing/usage-display';

test('every enforced limit has exactly one line on every plan card', () => {
  for (const plan of ['starter', 'growth', 'pro'] as const) {
    const lines = planFeatureLines(plan);
    assert.equal(lines.length, FEATURE_ORDER.length);
    for (const feature of FEATURE_ORDER) {
      const { limit } = PLAN_LIMITS[plan][feature];
      const line = lines.find((entry) => entry.startsWith(featureLabel(feature)));
      assert.ok(line, `${plan}.${feature} is missing`);
      // The number on the card is the enforced number, unless it is spelled out (1, 2).
      if (limit > 2) assert.ok(line.includes(String(limit)), `${plan}.${feature}: ${line}`);
    }
  }
});

test('plan card copy uses correct plurals and the enforced periods', () => {
  assert.equal(describePlanLimit('starter', 'audit'), 'فحصان أسبوعياً');
  assert.equal(describePlanLimit('starter', 'execute_action'), '3 عمليات يومياً');
  assert.equal(describePlanLimit('growth', 'audit'), '7 فحوصات أسبوعياً');
  assert.equal(describePlanLimit('pro', 'audit'), '70 فحصاً أسبوعياً');
  assert.equal(describePlanLimit('starter', 'manual_sync'), '5 تحديثات يومياً');
  assert.equal(describePlanLimit('starter', 'campaign_builder'), '5 طلبات شهرياً');
});

test('the card no longer claims execution and refresh share one limit', () => {
  // The old growth card read "20 تنفيذاً ومزامنة يومياً" while the server
  // meters execute_action and manual_sync separately.
  for (const plan of ['starter', 'growth', 'pro'] as const) {
    assert.ok(!planFeatureLines(plan).some((line) => line.includes('ومزامنة')));
  }
});

test('limit-reached message names the limit, the plan size and the reset time', () => {
  const message = quotaExceededMessage({
    feature: 'audit',
    plan: 'starter',
    resetsAt: '2026-10-10T00:00:00.000Z',
  });
  assert.ok(message.includes('فحص الحساب'));
  assert.ok(message.includes('فحصان أسبوعياً'));
  assert.ok(message.includes('يتجدد الحد'));
  assert.ok(message.includes('10 أكتوبر'));
  assert.ok(message.includes('03:00') || message.includes('3:00'));
  assert.ok(message.includes('بتوقيت الرياض'));
});

test('without a reset time passed in, the window the server enforces supplies it', () => {
  const now = new Date('2026-10-07T10:00:00.000Z');
  const message = quotaExceededMessage({ feature: 'manual_sync', now });
  assert.ok(message.includes('تحديث البيانات'));
  assert.ok(message.includes('8 أكتوبر'));
});

test('usageDeniedMessage only specializes the quota case', () => {
  const quota = usageDeniedMessage(
    { ok: false, reason: 'quota_exceeded', plan: 'growth', limit: 100, used: 100, resetsAt: '2026-10-08T00:00:00.000Z' },
    'assistant'
  );
  assert.ok(quota.includes('رسائل المساعد'));
  assert.ok(quota.includes('100 رسالة يومياً'));
  const sub = usageDeniedMessage({ ok: false, reason: 'subscription_required', plan: null }, 'assistant');
  assert.match(sub, /اشتراك/);
});

test('usage meter reflects the enforced limit and flags near and full states', () => {
  const now = new Date('2026-10-07T10:00:00.000Z');
  const ok = buildUsageMeter('assistant', 'growth', 10, now);
  assert.equal(ok.limit, PLAN_LIMITS.growth.assistant.limit);
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.percent, 10);
  const near = buildUsageMeter('assistant', 'growth', 85, now);
  assert.equal(near.tone, 'near');
  const full = buildUsageMeter('assistant', 'growth', 100, now);
  assert.equal(full.tone, 'full');
  assert.equal(full.resetsAt.toISOString(), '2026-10-08T00:00:00.000Z');
  const over = buildUsageMeter('assistant', 'growth', 140, now);
  assert.equal(over.percent, 100);
});

test('reset time is shown in Riyadh time', () => {
  const text = formatResetAr('2026-10-08T00:00:00.000Z');
  assert.ok(text?.includes('8 أكتوبر'));
  assert.ok(text?.includes('بتوقيت الرياض'));
  assert.equal(formatResetAr('garbage'), null);
});

test('trial days left count a started day as a day and never go negative', () => {
  const now = new Date('2026-10-07T10:00:00.000Z');
  assert.equal(trialDaysLeft('2026-10-21T10:00:00.000Z', now), 14);
  assert.equal(trialDaysLeft('2026-10-08T00:00:00.000Z', now), 1);
  assert.equal(trialDaysLeft('2026-10-01T00:00:00.000Z', now), 0);
  assert.equal(trialDaysLeft(null, now), null);
});

test('the displayed trial length matches what checkout sends to Stripe', () => {
  for (const file of ['app/api/billing/checkout/route.ts', 'app/api/billing/start-trial/route.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(
      source.includes(`trialDays: billing.trialEligible ? ${TRIAL_DAYS} : 0`),
      `${file} no longer starts a ${TRIAL_DAYS} day trial; update TRIAL_DAYS`
    );
  }
});
