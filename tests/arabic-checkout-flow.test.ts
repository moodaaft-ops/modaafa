import assert from 'node:assert/strict';
import test from 'node:test';

import { PLAN_PRICE_IDS } from '../lib/billing/stripe';
import {
  ArabicCheckoutError,
  createArabicSetupIntent,
  finalizeArabicSubscription,
  firstChargeAfterDiscount,
  resolvePromotionCode,
  settleControl,
  startArabicSubscription,
  type ArabicCheckoutStripeApi,
} from '../lib/billing/arabic-checkout/flow';

PLAN_PRICE_IDS.growth.monthly = 'price_growth_monthly_test';
settleControl.delaysMs = [0, 0, 0];
settleControl.wait = async () => {};

const USER = 'user-1';
const CUSTOMER = 'cus_1';
const SETUP = 'seti_1';

type Calls = {
  created: Array<{ params: any; key: string }>;
  canceled: string[];
  setupIntents: any[];
};

function fakeStripe(overrides: Partial<Record<keyof ArabicCheckoutStripeApi, any>> & { setup?: any; sub?: any; existing?: any[] } = {}) {
  const calls: Calls = { created: [], canceled: [], setupIntents: [] };
  const setup = {
    id: SETUP,
    status: 'succeeded',
    customer: CUSTOMER,
    payment_method: 'pm_1',
    metadata: { userId: USER, plan: 'growth', period: 'monthly', trial_days: '14', source: 'arabic_checkout' },
    ...overrides.setup,
  };
  const live = overrides.sub ?? subscription();
  const stripe: ArabicCheckoutStripeApi = {
    createSetupIntent: async (params) => {
      calls.setupIntents.push(params);
      return { id: SETUP, client_secret: 'seti_1_secret' };
    },
    retrieveSetupIntent: async () => setup,
    createSubscription: async (params, key) => {
      calls.created.push({ params, key });
      return { id: live.id };
    },
    retrieveSubscription: async () => live,
    listCustomerSubscriptions: async () => overrides.existing ?? [],
    cancelSubscription: async (id) => {
      calls.canceled.push(id);
      return { id, status: 'canceled' };
    },
    findPromotionCode: async () => null,
    ...overrides,
  } as ArabicCheckoutStripeApi;
  return { stripe, calls };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'trialing',
    customer: CUSTOMER,
    metadata: { userId: USER, plan: 'growth', period: 'monthly', source: 'arabic_checkout', setup_intent: SETUP },
    ...overrides,
  };
}

const start = (stripe: ArabicCheckoutStripeApi, extra: Record<string, unknown> = {}) =>
  startArabicSubscription(stripe, { userId: USER, customerId: CUSTOMER, setupIntentId: SETUP, trialDays: 14, ...extra });

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ArabicCheckoutError, `expected ArabicCheckoutError, got ${String(error)}`);
    return { code: error.code, decline: error.declineCode };
  }
  assert.fail('expected a rejection');
}

test('the setup intent is card only and records what the customer was shown', async () => {
  const { stripe, calls } = fakeStripe();
  const result = await createArabicSetupIntent(stripe, {
    userId: USER, customerId: CUSTOMER, plan: 'growth', period: 'monthly', trialDays: 14,
  });
  assert.equal(result.clientSecret, 'seti_1_secret');
  const params = calls.setupIntents[0];
  assert.deepEqual(params.payment_method_types, ['card']);
  assert.equal(params.usage, 'off_session');
  assert.deepEqual(params.metadata, {
    userId: USER, plan: 'growth', period: 'monthly', trial_days: '14', source: 'arabic_checkout',
  });
});

test('a plan with no configured price fails before a card is asked for', async () => {
  const { stripe } = fakeStripe();
  const previous = PLAN_PRICE_IDS.pro.monthly;
  PLAN_PRICE_IDS.pro.monthly = undefined;
  try {
    const failure = await codeOf(createArabicSetupIntent(stripe, {
      userId: USER, customerId: CUSTOMER, plan: 'pro', period: 'monthly', trialDays: 14,
    }));
    assert.equal(failure.code, 'checkout_failed');
  } finally {
    PLAN_PRICE_IDS.pro.monthly = previous;
  }
});

test('a trial subscription carries the trial, the metadata and the saved card, and is keyed on the setup intent', async () => {
  const { stripe, calls } = fakeStripe();
  const outcome = await start(stripe);
  assert.equal(outcome.kind, 'ready');
  const { params, key } = calls.created[0];
  assert.equal(key, `modaafa-arabic-sub:${SETUP}`);
  assert.equal(params.trial_period_days, 14);
  assert.equal(params.default_payment_method, 'pm_1');
  assert.deepEqual(params.payment_settings, { payment_method_types: ['card'] });
  assert.deepEqual(params.items, [{ price: 'price_growth_monthly_test', quantity: 1 }]);
  assert.equal(params.metadata.userId, USER);
  assert.equal(params.metadata.source, 'arabic_checkout');
  assert.equal(params.metadata.setup_intent, SETUP);
  assert.equal(params.discounts, undefined);
});

test('a customer who already used the trial is charged now: no trial days are sent', async () => {
  const { stripe, calls } = fakeStripe({
    setup: { metadata: { userId: USER, plan: 'growth', period: 'monthly', trial_days: '0', source: 'arabic_checkout' } },
    sub: subscription({ status: 'active' }),
  });
  const outcome = await start(stripe, { trialDays: 0 });
  assert.equal(outcome.kind, 'ready');
  assert.equal('trial_period_days' in calls.created[0].params, false);
});

test('a second trial is refused: the page promised 14 days, the server now says 0', async () => {
  const { stripe, calls } = fakeStripe();
  const failure = await codeOf(start(stripe, { trialDays: 0 }));
  assert.equal(failure.code, 'terms_changed');
  assert.equal(calls.created.length, 0);
});

test('the reverse also stops: a charge-now page cannot silently become a trial', async () => {
  const { stripe, calls } = fakeStripe({
    setup: { metadata: { userId: USER, plan: 'growth', period: 'monthly', trial_days: '0', source: 'arabic_checkout' } },
  });
  const failure = await codeOf(start(stripe, { trialDays: 14 }));
  assert.equal(failure.code, 'terms_changed');
  assert.equal(calls.created.length, 0);
});

test('a validated promotion code is attached as a discount', async () => {
  const { stripe, calls } = fakeStripe();
  await start(stripe, { promotionCodeId: 'promo_1' });
  assert.deepEqual(calls.created[0].params.discounts, [{ promotion_code: 'promo_1' }]);
});

test('a setup intent from someone else, from elsewhere, or unfinished is never charged', async () => {
  const cases: Array<[string, any]> = [
    ['another user', { metadata: { userId: 'user-2', plan: 'growth', period: 'monthly', trial_days: '14', source: 'arabic_checkout' } }],
    ['another source', { metadata: { userId: USER, plan: 'growth', period: 'monthly', trial_days: '14', source: 'something_else' } }],
    ['another customer', { customer: 'cus_other' }],
    ['not finished', { status: 'requires_payment_method' }],
    ['no card', { payment_method: null }],
  ];
  for (const [name, setup] of cases) {
    const { stripe, calls } = fakeStripe({ setup });
    const failure = await codeOf(start(stripe));
    assert.equal(failure.code, 'setup_not_completed', name);
    assert.equal(calls.created.length, 0, name);
  }
});

test('a live subscription already on Stripe blocks a second one, whatever our table says', async () => {
  for (const status of ['trialing', 'active', 'past_due', 'unpaid', 'paused']) {
    const { stripe, calls } = fakeStripe({ existing: [{ id: 'sub_old', status, metadata: {} }] });
    const failure = await codeOf(start(stripe));
    assert.equal(failure.code, 'already_subscribed', status);
    assert.equal(calls.created.length, 0, status);
  }
});

test('a canceled subscription from before does not block a new one', async () => {
  const { stripe, calls } = fakeStripe({ existing: [{ id: 'sub_old', status: 'canceled', metadata: {} }] });
  await start(stripe);
  assert.equal(calls.created.length, 1);
});

test('double click: the same card submitted twice returns the first subscription and makes no second one', async () => {
  const first = subscription({ id: 'sub_first' });
  const { stripe, calls } = fakeStripe({ sub: first, existing: [first] });
  const outcome = await start(stripe);
  assert.equal(outcome.kind, 'ready');
  assert.equal(calls.created.length, 0);
});

test('a leftover abandoned 3D Secure subscription is closed before the new one is made', async () => {
  const leftover = { id: 'sub_leftover', status: 'incomplete', metadata: { source: 'arabic_checkout', setup_intent: 'seti_older' } };
  const { stripe, calls } = fakeStripe({ existing: [leftover] });
  await start(stripe);
  assert.deepEqual(calls.canceled, ['sub_leftover']);
  assert.equal(calls.created.length, 1);
});

test('pay now with a 3D Secure prompt hands the browser a secret and writes nothing', async () => {
  const pending = subscription({
    status: 'incomplete',
    latest_invoice: { payment_intent: { status: 'requires_action', client_secret: 'pi_secret' } },
  });
  const { stripe, calls } = fakeStripe({ sub: pending });
  const outcome = await start(stripe);
  assert.deepEqual(outcome, { kind: 'requires_action', subscriptionId: 'sub_1', clientSecret: 'pi_secret' });
  assert.deepEqual(calls.canceled, []);
});

test('a declined first payment cancels the half-made subscription and says why', async () => {
  const declined = subscription({
    status: 'incomplete',
    latest_invoice: {
      payment_intent: {
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
      },
    },
  });
  const { stripe, calls } = fakeStripe({ sub: declined });
  const failure = await codeOf(start(stripe));
  assert.deepEqual(failure, { code: 'card_declined', decline: 'insufficient_funds' });
  assert.deepEqual(calls.canceled, ['sub_1']);
});

test('a payment still processing is neither cancelled nor activated', async () => {
  const processing = subscription({ status: 'incomplete', latest_invoice: { payment_intent: { status: 'processing' } } });
  const { stripe, calls } = fakeStripe({ sub: processing });
  const failure = await codeOf(start(stripe));
  assert.equal(failure.code, 'payment_processing');
  assert.deepEqual(calls.canceled, []);
});

test('a subscription that is past_due or paused straight after creation is not treated as live', async () => {
  for (const status of ['past_due', 'paused', 'unpaid']) {
    const { stripe } = fakeStripe({ sub: subscription({ status }) });
    const failure = await codeOf(start(stripe));
    assert.equal(failure.code, 'processing_error', status);
  }
});

test('finalize: only the owner of an Arabic-checkout subscription can read its result', async () => {
  const live = subscription({ status: 'active' });
  const { stripe } = fakeStripe({ sub: live });
  const input = { userId: USER, customerId: CUSTOMER, subscriptionId: 'sub_1' };
  assert.equal((await finalizeArabicSubscription(stripe, input)).status, 'active');

  assert.equal((await codeOf(finalizeArabicSubscription(stripe, { ...input, userId: 'user-2' }))).code, 'setup_not_completed');
  assert.equal((await codeOf(finalizeArabicSubscription(stripe, { ...input, customerId: 'cus_other' }))).code, 'setup_not_completed');

  const hosted = fakeStripe({ sub: subscription({ status: 'active', metadata: { userId: USER } }) }).stripe;
  assert.equal((await codeOf(finalizeArabicSubscription(hosted, input))).code, 'setup_not_completed');
});

test('finalize after a failed 3D Secure check cancels and reports the authentication failure', async () => {
  const stuck = subscription({
    status: 'incomplete',
    latest_invoice: { payment_intent: { status: 'requires_payment_method' } },
  });
  const { stripe, calls } = fakeStripe({ sub: stuck });
  const failure = await codeOf(
    finalizeArabicSubscription(stripe, { userId: USER, customerId: CUSTOMER, subscriptionId: 'sub_1' }),
  );
  assert.equal(failure.code, 'payment_intent_authentication_failure');
  assert.deepEqual(calls.canceled, ['sub_1']);
});

test('finalize never asks for a second 3D Secure round', async () => {
  const again = subscription({
    status: 'incomplete',
    latest_invoice: { payment_intent: { status: 'requires_action', client_secret: 'pi_secret' } },
  });
  const { stripe, calls } = fakeStripe({ sub: again });
  const failure = await codeOf(
    finalizeArabicSubscription(stripe, { userId: USER, customerId: CUSTOMER, subscriptionId: 'sub_1' }),
  );
  assert.equal(failure.code, 'payment_intent_authentication_failure');
  assert.deepEqual(calls.canceled, ['sub_1']);
});

test('promotion codes: shape, existence, expiry, limits and ownership are checked on the server', async () => {
  const lookup = (promotion: any) => ({ findPromotionCode: async () => promotion }) as unknown as ArabicCheckoutStripeApi;
  const good = { id: 'promo_1', active: true, coupon: { valid: true, percent_off: 20, duration: 'once' } };

  const view = await resolvePromotionCode(lookup(good), ' SAVE20 ');
  assert.equal(view.id, 'promo_1');
  assert.equal(view.label, 'خصم 20% على أول دفعة');

  const bad = async (code: string, promotion: any, options: Record<string, unknown> = {}) =>
    (await codeOf(resolvePromotionCode(lookup(promotion), code, options as any))).code;
  assert.equal(await bad('x', good), 'promo_invalid');
  assert.equal(await bad('has space', good), 'promo_invalid');
  assert.equal(await bad('MISSING', null), 'promo_invalid');
  assert.equal(await bad('OFF', { ...good, active: false }), 'promo_expired');
  assert.equal(await bad('OLD', { ...good, expires_at: 100 }, { now: 200 }), 'promo_expired');
  assert.equal(await bad('FULL', { ...good, max_redemptions: 5, times_redeemed: 5 }), 'promo_expired');
  assert.equal(await bad('DEAD', { ...good, coupon: { ...good.coupon, valid: false } }), 'promo_expired');
  assert.equal(await bad('MINE', { ...good, customer: 'cus_other' }, { customerId: CUSTOMER }), 'promo_invalid');
  assert.equal(await bad('EMPTY', { ...good, coupon: { valid: true } }), 'promo_not_applicable');
});

test('a code made for this customer works, and the first charge after a discount is computed', async () => {
  const mine = { id: 'promo_2', active: true, customer: CUSTOMER, coupon: { valid: true, amount_off: 10000, currency: 'sar', duration: 'repeating', duration_in_months: 3 } };
  const view = await resolvePromotionCode({ findPromotionCode: async () => mine } as unknown as ArabicCheckoutStripeApi, 'MINE', { customerId: CUSTOMER });
  assert.equal(view.label, 'خصم 100 ريال لمدة 3 أشهر');

  assert.equal(firstChargeAfterDiscount(500, 'sar', view), 400);
  assert.equal(firstChargeAfterDiscount(500, 'sar', { percentOff: 20, amountOff: null, currency: null }), 400);
  assert.equal(firstChargeAfterDiscount(500, 'sar', { percentOff: 100, amountOff: null, currency: null }), 0);
  assert.equal(firstChargeAfterDiscount(50, 'sar', { percentOff: null, amountOff: 100, currency: 'sar' }), 0);
  assert.equal(firstChargeAfterDiscount(500, 'sar', { percentOff: null, amountOff: 10, currency: 'usd' }), 500);
  assert.equal(firstChargeAfterDiscount(500, 'sar', null), 500);
});

// ---- Independent review findings --------------------------------------------

test('paid but not yet active: finalize waits for Stripe and never cancels a payment that went through', async () => {
  const paidButIncomplete = subscription({
    status: 'incomplete',
    latest_invoice: { status: 'paid', payment_intent: { status: 'succeeded' } },
  });
  let reads = 0;
  const { stripe, calls } = fakeStripe({
    retrieveSubscription: async () => {
      reads += 1;
      // The first read is the early one; the second already shows the activation.
      return reads >= 2 ? subscription({ status: 'active' }) : paidButIncomplete;
    },
  });
  const result = await finalizeArabicSubscription(stripe, { userId: USER, subscriptionId: 'sub_1' });
  assert.equal(result.status, 'active');
  assert.deepEqual(calls.canceled, []);
});

test('paid but still not active after the waits: told to wait, never cancelled, never "declined"', async () => {
  const stuck = subscription({
    status: 'incomplete',
    latest_invoice: { status: 'paid', payment_intent: { status: 'succeeded' } },
  });
  const { stripe, calls } = fakeStripe({ sub: stuck });
  const failure = await codeOf(finalizeArabicSubscription(stripe, { userId: USER, subscriptionId: 'sub_1' }));
  assert.equal(failure.code, 'payment_processing');
  assert.deepEqual(calls.canceled, []);
});

test('the same state straight after creating the subscription is also left alone', async () => {
  const stuck = subscription({
    status: 'incomplete',
    latest_invoice: { status: 'paid', payment_intent: { status: 'succeeded' } },
  });
  const { stripe, calls } = fakeStripe({ sub: stuck });
  assert.equal((await codeOf(start(stripe))).code, 'payment_processing');
  assert.deepEqual(calls.canceled, []);
});

test('an unknown payment state is not cancelled either', async () => {
  const odd = subscription({ status: 'incomplete', latest_invoice: { payment_intent: { status: 'requires_capture' } } });
  const { stripe, calls } = fakeStripe({ sub: odd });
  assert.equal((await codeOf(start(stripe))).code, 'payment_processing');
  assert.deepEqual(calls.canceled, []);
});

test('closing an unpaid subscription voids its open invoice first', async () => {
  const voided: string[] = [];
  const declined = subscription({
    status: 'incomplete',
    latest_invoice: { id: 'in_1', status: 'open', payment_intent: { status: 'requires_payment_method' } },
  });
  const { stripe, calls } = fakeStripe({
    sub: declined,
    voidInvoice: async (id: string) => {
      voided.push(id);
      return {};
    },
  });
  await codeOf(start(stripe));
  assert.deepEqual(voided, ['in_1']);
  assert.deepEqual(calls.canceled, ['sub_1']);
});

test('a failed void does not stop the cancel', async () => {
  const declined = subscription({
    status: 'incomplete',
    latest_invoice: { id: 'in_1', status: 'open', payment_intent: { status: 'requires_payment_method' } },
  });
  const { stripe, calls } = fakeStripe({
    sub: declined,
    voidInvoice: async () => {
      throw new Error('already void');
    },
  });
  await codeOf(start(stripe));
  assert.deepEqual(calls.canceled, ['sub_1']);
});

test('another tab in the middle of 3D Secure is not cancelled, and no second subscription is made', async () => {
  const other = {
    id: 'sub_other',
    status: 'incomplete',
    created: Math.floor(Date.now() / 1000) - 60,
    metadata: { source: 'arabic_checkout', setup_intent: 'seti_other' },
    latest_invoice: { payment_intent: { status: 'requires_action' } },
  };
  const { stripe, calls } = fakeStripe({ existing: [other] });
  assert.equal((await codeOf(start(stripe))).code, 'payment_in_progress');
  assert.deepEqual(calls.canceled, []);
  assert.equal(calls.created.length, 0);
});

test('an old abandoned 3D Secure (hours ago) is closed as before', async () => {
  const old = {
    id: 'sub_old',
    status: 'incomplete',
    created: Math.floor(Date.now() / 1000) - 5 * 3600,
    metadata: { source: 'arabic_checkout', setup_intent: 'seti_old' },
    latest_invoice: { payment_intent: { status: 'requires_action' } },
  };
  const { stripe, calls } = fakeStripe({ existing: [old] });
  await start(stripe);
  assert.deepEqual(calls.canceled, ['sub_old']);
});

test('a leftover whose payment already went through blocks a new subscription instead of being cancelled', async () => {
  const paid = {
    id: 'sub_paid',
    status: 'incomplete',
    created: Math.floor(Date.now() / 1000) - 120,
    metadata: { source: 'arabic_checkout', setup_intent: 'seti_other' },
    latest_invoice: { status: 'paid', payment_intent: { status: 'succeeded' } },
  };
  const { stripe, calls } = fakeStripe({ existing: [paid] });
  assert.equal((await codeOf(start(stripe))).code, 'payment_processing');
  assert.deepEqual(calls.canceled, []);
  assert.equal(calls.created.length, 0);
});

test('a lost connection while creating the subscription says the state is unknown, not "nothing charged"', async () => {
  const { stripe } = fakeStripe({
    createSubscription: async () => {
      throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
    },
  });
  assert.equal((await codeOf(start(stripe))).code, 'payment_status_unknown');
});

test('a rejected request or a card error while creating is passed through as before', async () => {
  const cardError = Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined' });
  const { stripe } = fakeStripe({
    createSubscription: async () => {
      throw cardError;
    },
  });
  await assert.rejects(start(stripe), (error) => error === cardError);
});

test('a failure reading the subscription after it was created also says the state is unknown', async () => {
  let reads = 0;
  const { stripe } = fakeStripe({
    retrieveSubscription: async () => {
      reads += 1;
      throw new Error('timeout');
    },
  });
  assert.equal((await codeOf(start(stripe))).code, 'payment_status_unknown');
  assert.equal(reads, 1);
});

test('finalize does not depend on a second customer lookup', async () => {
  const { stripe } = fakeStripe({ sub: subscription({ status: 'active', customer: 'cus_made_on_other_record' }) });
  const result = await finalizeArabicSubscription(stripe, { userId: USER, subscriptionId: 'sub_1' });
  assert.equal(result.status, 'active');
});
