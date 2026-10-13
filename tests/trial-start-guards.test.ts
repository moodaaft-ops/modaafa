import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runTrialStartGuards } from '../lib/billing/trial-start-guards';
import type { TrialCardSubscription } from '../lib/billing/trial-card-guard';

const USER = '11111111-1111-1111-1111-111111111111';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const live: TrialCardSubscription = { id: 'sub_1', status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 3600 };

test('a card block short-circuits: the account lock is not run for a trial that was already cancelled', async () => {
  const order: string[] = [];
  const result = await runTrialStartGuards({
    admin: {},
    userId: USER,
    subscription: live,
    enforceCard: async () => (order.push('card'), { blocked: true, outcome: 'duplicate_card' as const }),
    enforceAccountLock: async () => {
      order.push('accounts');
      return { blocked: false, outcome: 'claimed' as const, pausedAccountIds: [], claimedCustomerId: null };
    },
  });
  assert.deepEqual(result, { blocked: true, error: 'card_trial_used' });
  assert.deepEqual(order, ['card']);
});

test('an account block reports ads_account_trial_used, and a clean pass reports nothing', async () => {
  const lock = (blocked: boolean) => async () => ({
    blocked,
    outcome: (blocked ? 'blocked' : 'claimed') as 'blocked' | 'claimed',
    pausedAccountIds: [],
    claimedCustomerId: null,
  });
  const card = async () => ({ blocked: false, outcome: 'first_use' as const });
  assert.deepEqual(
    await runTrialStartGuards({ admin: {}, userId: USER, subscription: live, enforceCard: card, enforceAccountLock: lock(true) }),
    { blocked: true, error: 'ads_account_trial_used' }
  );
  assert.deepEqual(
    await runTrialStartGuards({ admin: {}, userId: USER, subscription: live, enforceCard: card, enforceAccountLock: lock(false) }),
    { blocked: false, error: null }
  );
});

test('a guard that throws propagates, so the webhook returns a retryable 500', async () => {
  await assert.rejects(
    runTrialStartGuards({
      admin: {},
      userId: USER,
      subscription: live,
      enforceCard: async () => ({ blocked: false, outcome: 'first_use' as const }),
      enforceAccountLock: async () => {
        throw new Error('stripe cancel failed');
      },
    }),
    /stripe cancel failed/
  );
});


// ---------------------------------------------------------------------------
// Where the start lock is wired
// ---------------------------------------------------------------------------

test('the start lock runs at all three trial-start points and the redirect uses the guard reason', () => {
  const webhook = read('lib/billing/stripe-webhook-handler.ts');
  assert.equal((webhook.match(/runTrialStartGuards\(/g) ?? []).length, 2, 'session.completed and subscription.created');
  assert.match(webhook, /enforceTrialStartAccountLock: enforceTrialStartAccountLockLive/);
  // customer.subscription.updated and .deleted never run it.
  assert.match(webhook, /event\.type === 'customer\.subscription\.created' && userId/);

  const complete = read('app/api/billing/checkout/complete/route.ts');
  assert.match(complete, /runTrialStartGuards\(/);
  assert.match(complete, /enforceAccountLock: enforceTrialStartAccountLockLive/);
  assert.match(complete, /billingError\(req, trialGuards\.error,/);
  assert.match(read('lib/billing/trial-start-guards.ts'), /'ads_account_trial_used'/);
});

test('a blocked trial gets no welcome email on the webhook path', () => {
  const webhook = read('lib/billing/stripe-webhook-handler.ts');
  assert.match(webhook, /subscriptionEventWasApplied\(writeResult\) && !trialBlocked/);
});

test('the checkout-complete error code is mapped by both billing pages with copy that follows the rules', async () => {
  const { ADS_ACCOUNT_TRIAL_USED_MESSAGE } = await import('../lib/billing/trial-copy');
  assert.equal(
    ADS_ACCOUNT_TRIAL_USED_MESSAGE,
    'حسابات الإعلانات المربوطة أخذت تجربتها المجانية قبل، فما فعّلنا لك تجربة وما انخصم شي. تقدر تشترك وتربطها مباشرة.'
  );
  assert.doesNotMatch(ADS_ACCOUNT_TRIAL_USED_MESSAGE, /[‒–—―−]|\s-\s/);
  assert.ok(ADS_ACCOUNT_TRIAL_USED_MESSAGE.includes('،') && !ADS_ACCOUNT_TRIAL_USED_MESSAGE.includes(','));
  for (const page of ['app/(dashboard)/billing/page.tsx', 'app/onboarding/trial/page.tsx']) {
    assert.match(read(page), /ads_account_trial_used: ADS_ACCOUNT_TRIAL_USED_MESSAGE/, page);
  }
});
