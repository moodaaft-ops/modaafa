import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CARD_TRIAL_USED_MESSAGE,
  TRIAL_CHECK_FAILED_MESSAGE,
  trialIneligibleNotice,
} from '../lib/billing/trial-copy';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the check_failed copy is the agreed sentence, with the Arabic comma and no dashes', () => {
  assert.equal(TRIAL_CHECK_FAILED_MESSAGE, 'صار خلل مؤقت في التحقق من التجربة، جرّب بعد دقيقة.');
  assert.ok(TRIAL_CHECK_FAILED_MESSAGE.includes('،') && !TRIAL_CHECK_FAILED_MESSAGE.includes(','));
  assert.doesNotMatch(TRIAL_CHECK_FAILED_MESSAGE, /[\u2012-\u2015\u2212]|\s-\s/);
  assert.equal(trialIneligibleNotice('check_failed'), TRIAL_CHECK_FAILED_MESSAGE);
  assert.notEqual(TRIAL_CHECK_FAILED_MESSAGE, CARD_TRIAL_USED_MESSAGE);
});

for (const file of ['app/(dashboard)/billing/page.tsx', 'app/onboarding/trial/page.tsx']) {
  test(`${file} maps trial_check_failed to the copy`, () => {
    assert.match(read(file), /trial_check_failed: TRIAL_CHECK_FAILED_MESSAGE/);
  });
}

// Both entry points that create a Checkout session must stop on check_failed BEFORE
// they touch Stripe, and must pass the decided trial days (never recompute them).
for (const file of ['app/api/billing/checkout/route.ts', 'app/api/billing/start-trial/route.ts']) {
  test(`${file} refuses a check_failed instead of creating a paid session`, () => {
    const src = read(file);
    const decision = src.indexOf('checkoutTrialDecision(billing)');
    const blocked = src.indexOf("trialDecision.action === 'blocked'");
    const customer = src.indexOf('ensureStripeCustomer({');
    const session = src.indexOf('createCheckoutSession({');
    assert.ok(decision > 0 && blocked > decision, 'the decision is taken');
    assert.ok(blocked < customer && customer < session, 'and acted on before Stripe is called');
    assert.match(src, /trialDays: trialDecision\.trialDays,/);
    assert.ok(!/trialEligible \? TRIAL_DAYS/.test(src), 'trial days are not recomputed');
    assert.match(src, /error=\$\{trialDecision\.error\}/);
  });
}

test('the onboarding variant redirects to /onboarding/trial and the billing variant to /billing', () => {
  assert.match(read('app/api/billing/start-trial/route.ts'), /new URL\(`\$\{errorBase\}\?error=\$\{trialDecision\.error\}`/);
  assert.match(read('app/api/billing/checkout/route.ts'), /new URL\(`\/billing\?error=\$\{trialDecision\.error\}`/);
});

test('the pages say a retry, never a paid start, when the check failed', () => {
  for (const file of ['app/(dashboard)/billing/page.tsx', 'app/onboarding/trial/page.tsx']) {
    const src = read(file);
    assert.match(src, /checkout\.trialIneligibleReason === 'check_failed'/);
    assert.match(src, /checkFailed \? 'حاول من جديد'/);
  }
});
