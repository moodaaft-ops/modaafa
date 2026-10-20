import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCheckoutSessionParams, PLAN_PRICE_IDS } from '../lib/billing/stripe';
import { refereeGiftLabel } from '../lib/partners/config';

const base = {
  userId: 'u1',
  email: 'a@example.com',
  plan: 'starter' as const,
  period: 'monthly' as const,
  successUrl: 'https://x.test/ok',
  cancelUrl: 'https://x.test/no',
  trialDays: 14,
  customerId: 'cus_1',
};

function withPrice<T>(fn: () => T): T {
  const before = PLAN_PRICE_IDS.starter?.monthly;
  PLAN_PRICE_IDS.starter = { ...(PLAN_PRICE_IDS.starter ?? {}), monthly: 'price_test_1' };
  try {
    return fn();
  } finally {
    PLAN_PRICE_IDS.starter = { ...(PLAN_PRICE_IDS.starter ?? {}), monthly: before };
  }
}

test('no gift: the customer can type their own code', () => {
  const s = withPrice(() => buildCheckoutSessionParams(base));
  assert.equal(s.allow_promotion_codes, true);
  assert.equal(s.discounts, undefined);
});

test('with a gift: the code is applied up front and Stripe is not asked to allow codes too', () => {
  const s = withPrice(() => buildCheckoutSessionParams({ ...base, promotionCodeId: 'promo_123' }));
  assert.deepEqual(s.discounts, [{ promotion_code: 'promo_123' }]);
  assert.equal(s.allow_promotion_codes, undefined);
  assert.equal(s.subscription_data?.trial_period_days, 14);
});

test('the gift label shows only together with the promotion code', () => {
  assert.equal(refereeGiftLabel({ PARTNER_REFEREE_GIFT_LABEL: '20% على أول دفعة' }), null);
  assert.equal(refereeGiftLabel({ PARTNER_REFEREE_PROMO_CODE: 'WELCOME20' }), null);
  assert.equal(
    refereeGiftLabel({ PARTNER_REFEREE_PROMO_CODE: 'WELCOME20', PARTNER_REFEREE_GIFT_LABEL: ' 20% على أول دفعة ' }),
    '20% على أول دفعة',
  );
});
