import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  PLAN_BILLING_PATH,
  PLAN_CHECKOUT_PATH,
  PLAN_COPY,
  paywallCta,
  paywallCtaFromCheckout,
  ctaLabel,
} from '../lib/plan/plan';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

test('nobody subscribed yet: the trial or the paid start, both through the checkout entry', () => {
  assert.deepEqual(paywallCta({ trialEligible: true }), {
    kind: 'trial',
    href: PLAN_CHECKOUT_PATH,
    label: 'ابدأ 14 يوم مجاناً',
    reason: null,
  });
  assert.deepEqual(paywallCta({ trialEligible: false }), {
    kind: 'subscribe',
    href: PLAN_CHECKOUT_PATH,
    label: 'فعّل اشتراكك',
    reason: null,
  });
  assert.equal(PLAN_CHECKOUT_PATH, '/onboarding/trial');
});

test('a payment that did not go through points to /billing: update the card and carry on', () => {
  for (const status of ['past_due', 'unpaid', 'PAST_DUE']) {
    const cta = paywallCta({ trialEligible: false, hasSubscription: true, subscriptionStatus: status });
    assert.equal(cta.kind, 'billing', status);
    assert.equal(cta.href, '/billing', status);
    assert.equal(cta.label, 'حدّث بطاقتك وكمّل', status);
    assert.equal(cta.reason, 'اشتراكك موقوف لأن آخر دفعة ما مرت.', status);
  }
});

test('a paused or otherwise stopped subscription also goes to /billing, without claiming the payment failed', () => {
  for (const status of ['paused', 'trialing', 'active', 'incomplete', null, undefined, '']) {
    const cta = paywallCta({ trialEligible: false, hasSubscription: true, subscriptionStatus: status });
    assert.equal(cta.kind, 'billing', String(status));
    assert.equal(cta.href, PLAN_BILLING_PATH, String(status));
    assert.equal(cta.label, 'فعّل اشتراكك', String(status));
    assert.equal(cta.reason, 'اشتراكك موقوف. فعّله من صفحة الاشتراك.', String(status));
  }
});

test('an existing subscription wins over trial eligibility: the checkout entry would refuse it', () => {
  // start-trial answers already_subscribed for any live subscription, so even
  // a person the ledger would offer a trial never gets the trial button.
  const cta = paywallCta({ trialEligible: true, hasSubscription: true, subscriptionStatus: 'past_due' });
  assert.equal(cta.href, '/billing');
  assert.doesNotMatch(cta.label + String(cta.reason), /مجان|14/);
});

test('the CTA follows what the checkout policy found, and falls back to the plain checkout when it could not be read', () => {
  assert.equal(paywallCtaFromCheckout(null).href, PLAN_CHECKOUT_PATH);
  assert.equal(paywallCtaFromCheckout(undefined).kind, 'subscribe');
  assert.equal(paywallCtaFromCheckout({ trialEligible: true, activeSubscriptionId: null }).kind, 'trial');
  const stopped = paywallCtaFromCheckout({
    trialEligible: false,
    activeSubscriptionId: 'sub_1',
    activeSubscriptionStatus: 'past_due',
  });
  assert.equal(stopped.href, '/billing');
  assert.equal(stopped.label, PLAN_COPY.ctaUpdateCard);
  assert.equal(paywallCtaFromCheckout({ trialEligible: false, activeSubscriptionId: 'sub_1', activeSubscriptionStatus: 'paused' }).label, ctaLabel(false));
});

test('the new words have no long dash, no Latin comma, and no free days', () => {
  for (const text of [PLAN_COPY.ctaUpdateCard, PLAN_COPY.reasonPastDue, PLAN_COPY.reasonPaused]) {
    assert.doesNotMatch(text, /[–—]/, text);
    assert.doesNotMatch(text, /,/, text);
    assert.doesNotMatch(text, /مجان|14/, text);
  }
});

test('every paywall surface takes the CTA from the same place: /home, the sheet, onboarding and the trial page', () => {
  const paywall = read('lib/plan/plan-paywall.tsx');
  assert.match(paywall, /const target = cta \?\? paywallCta\(\{ trialEligible \}\)/);
  assert.match(paywall, /href=\{target\.href\}/);
  assert.match(paywall, /\{target\.label\}/);
  // A stopped subscription has nothing to cancel: no cancel promise next to «حدّث بطاقتك وكمّل».
  assert.match(paywall, /cta\?\.kind !== 'billing' && <PlanCancelLine/);

  const home = read('app/(dashboard)/home/page.tsx');
  assert.match(home, /cta=\{paywallCtaFromCheckout\(checkout\)\}/);
  const locked = read('app/(dashboard)/home/locked-home.tsx');
  assert.match(locked, /<PlanCtaButton trialEligible=\{trialEligible\} cta=\{cta\}/);
  assert.match(locked, /<PlanSheet[\s\S]*cta=\{cta\}/);
  assert.match(locked, /cta\?\.kind !== 'billing' && <PlanCancelLine/);

  assert.match(read('lib/setup/load.ts'), /cta = paywallCtaFromCheckout\(checkout\)/);
  assert.match(read('app/onboarding/setup/setup-chat.tsx'), /<PlanCta trialEligible=\{state\.trialEligible\} cta=\{state\.cta\} \/>/);
});

test('the trial page sends someone with a stopped subscription to /billing instead of a form that would be refused', () => {
  const trial = read('app/onboarding/trial/page.tsx');
  assert.match(trial, /if \(checkout\.activeSubscriptionId\) redirect\('\/billing'\)/);
  // The refusal this guards against: start-trial answers already_subscribed for a live subscription.
  assert.match(read('app/api/billing/start-trial/route.ts'), /if \(billing\.activeSubscriptionId\)[\s\S]*already_subscribed/);
});
