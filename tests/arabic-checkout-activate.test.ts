import assert from 'node:assert/strict';
import test from 'node:test';

import { activateArabicSubscription, type ActivateDependencies } from '../lib/billing/arabic-checkout/activate';
import {
  isArabicCheckoutSubscription,
  isArabicWelcomeMoment,
  isUnactivatedArabicSubscription,
} from '../lib/billing/arabic-checkout/source';

const START = 1_790_000_000;

function sub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'trialing',
    customer: 'cus_1',
    trial_end: START + 14 * 86400,
    current_period_start: START,
    current_period_end: START + 14 * 86400,
    canceled_at: null,
    metadata: { userId: 'user-1', source: 'arabic_checkout' },
    ...overrides,
  };
}

function deps(options: { blocked?: 'card_trial_used' | 'ads_account_trial_used' | null } = {}) {
  const writes: any[] = [];
  const grants: any[] = [];
  const dependencies: ActivateDependencies = {
    planFromSubscription: () => ({ plan: 'growth', period: 'monthly', source: 'price' }) as any,
    runTrialStartGuards: async () => ({ blocked: Boolean(options.blocked), error: options.blocked ?? null }),
    applySubscriptionEvent: async (_admin: any, row: any) => {
      writes.push(row);
      return 'inserted';
    },
    recordTrialGrant: async (input: any) => {
      grants.push(input);
    },
    enforceCard: async () => ({ blocked: false }) as any,
    enforceAccountLock: async () => ({ blocked: false }) as any,
  } as ActivateDependencies;
  return { dependencies, writes, grants };
}

test('a live trial is written one second before it started, so the real webhook always wins', async () => {
  const { dependencies, writes, grants } = deps();
  const result = await activateArabicSubscription({ admin: {}, userId: 'user-1', subscription: sub() }, dependencies);
  assert.deepEqual(result, { ok: true, status: 'trialing', trialEnd: new Date((START + 14 * 86400) * 1000).toISOString() });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'trialing');
  assert.equal(writes[0].user_id, 'user-1');
  assert.equal(writes[0].last_event_at, new Date((START - 1) * 1000).toISOString());
  assert.equal(grants.length, 1);
  assert.equal(grants[0].source, 'checkout_complete');
});

test('a paid start has no trial grant', async () => {
  const { dependencies, grants, writes } = deps();
  const result = await activateArabicSubscription(
    { admin: {}, userId: 'user-1', subscription: sub({ status: 'active', trial_end: null }) },
    dependencies,
  );
  assert.equal(result.ok, true);
  assert.equal(writes[0].status, 'active');
  assert.equal(grants.length, 0);
});

test('a card that already had a trial: the row is written canceled, the trial still counts as used, and the customer is told', async () => {
  const { dependencies, writes, grants } = deps({ blocked: 'card_trial_used' });
  const result = await activateArabicSubscription({ admin: {}, userId: 'user-1', subscription: sub() }, dependencies);
  assert.deepEqual(result, { ok: false, error: 'card_trial_used' });
  assert.equal(writes[0].status, 'canceled');
  assert.ok(writes[0].canceled_at);
  assert.equal(grants.length, 1);
});

test('the ads-account lock blocks the same way', async () => {
  const { dependencies, writes } = deps({ blocked: 'ads_account_trial_used' });
  const result = await activateArabicSubscription({ admin: {}, userId: 'user-1', subscription: sub() }, dependencies);
  assert.deepEqual(result, { ok: false, error: 'ads_account_trial_used' });
  assert.equal(writes[0].status, 'canceled');
});

test('a subscription that is not live is never written as live', async () => {
  for (const status of ['incomplete', 'incomplete_expired', 'past_due', 'canceled', 'unpaid']) {
    const { dependencies, writes } = deps();
    await assert.rejects(
      activateArabicSubscription({ admin: {}, userId: 'user-1', subscription: sub({ status }) }, dependencies),
      /Refusing to activate/,
      status,
    );
    assert.equal(writes.length, 0, status);
  }
});

test("someone else's subscription is never activated for this user", async () => {
  const { dependencies, writes } = deps();
  await assert.rejects(
    activateArabicSubscription({ admin: {}, userId: 'user-2', subscription: sub() }, dependencies),
    /does not belong/,
  );
  assert.equal(writes.length, 0);
});

test('source helpers: only unpaid Arabic-checkout subscriptions are held back from the table', () => {
  assert.ok(isArabicCheckoutSubscription(sub()));
  assert.ok(!isArabicCheckoutSubscription({ metadata: { userId: 'u' } }));
  assert.ok(isUnactivatedArabicSubscription(sub({ status: 'incomplete' })));
  assert.ok(isUnactivatedArabicSubscription(sub({ status: 'incomplete_expired' })));
  assert.ok(!isUnactivatedArabicSubscription(sub({ status: 'trialing' })));
  assert.ok(!isUnactivatedArabicSubscription(sub({ status: 'past_due' })), 'a failed renewal is a normal past_due');
  // A hosted-checkout subscription is untouched by this rule.
  assert.ok(!isUnactivatedArabicSubscription({ status: 'incomplete', metadata: { userId: 'u' } }));
});

test('the welcome goes out when the subscription first goes live, and not on later updates', () => {
  const trialing = sub();
  assert.ok(isArabicWelcomeMoment({ eventType: 'customer.subscription.created', subscription: trialing }));
  assert.ok(
    isArabicWelcomeMoment({
      eventType: 'customer.subscription.updated',
      subscription: sub({ status: 'active' }),
      previousAttributes: { status: 'incomplete' },
    }),
  );
  assert.ok(!isArabicWelcomeMoment({ eventType: 'customer.subscription.updated', subscription: trialing }));
  assert.ok(
    !isArabicWelcomeMoment({
      eventType: 'customer.subscription.updated',
      subscription: sub({ status: 'active' }),
      previousAttributes: { status: 'trialing' },
    }),
  );
  assert.ok(!isArabicWelcomeMoment({ eventType: 'customer.subscription.created', subscription: sub({ status: 'incomplete' }) }));
  assert.ok(!isArabicWelcomeMoment({ eventType: 'customer.subscription.deleted', subscription: sub({ status: 'canceled' }) }));
  assert.ok(!isArabicWelcomeMoment({ eventType: 'customer.subscription.created', subscription: { status: 'trialing', metadata: { userId: 'u' } } }));
});
