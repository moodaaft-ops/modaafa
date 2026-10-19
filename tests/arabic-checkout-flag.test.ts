import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARABIC_CHECKOUT_PATH,
  isArabicCheckoutAvailable,
  isArabicCheckoutFlagOn,
  stripePublishableKey,
} from '../lib/billing/arabic-checkout/flag';
import { buildContentSecurityPolicy } from '../lib/security/csp';

test('the flag is off unless it says true or 1', () => {
  assert.equal(isArabicCheckoutFlagOn({}), false);
  assert.equal(isArabicCheckoutFlagOn({ ARABIC_CHECKOUT_ENABLED: '' }), false);
  assert.equal(isArabicCheckoutFlagOn({ ARABIC_CHECKOUT_ENABLED: 'false' }), false);
  assert.equal(isArabicCheckoutFlagOn({ ARABIC_CHECKOUT_ENABLED: 'yes' }), false);
  assert.equal(isArabicCheckoutFlagOn({ ARABIC_CHECKOUT_ENABLED: 'true' }), true);
  assert.equal(isArabicCheckoutFlagOn({ ARABIC_CHECKOUT_ENABLED: ' TRUE ' }), true);
  assert.equal(isArabicCheckoutFlagOn({ ARABIC_CHECKOUT_ENABLED: '1' }), true);
});

test('only a publishable key is accepted for the browser, never a secret key', () => {
  assert.equal(stripePublishableKey({}), null);
  assert.equal(stripePublishableKey({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'sk_test_abc' }), null);
  assert.equal(stripePublishableKey({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'rk_test_abc' }), null);
  assert.equal(stripePublishableKey({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }), 'pk_test_abc');
});

test('the page is offered only with the flag AND the key; otherwise the old path stays', () => {
  assert.equal(isArabicCheckoutAvailable({ ARABIC_CHECKOUT_ENABLED: 'true' }), false);
  assert.equal(isArabicCheckoutAvailable({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }), false);
  assert.equal(
    isArabicCheckoutAvailable({ ARABIC_CHECKOUT_ENABLED: 'true', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }),
    true,
  );
});

test('the existing server-side publishable key name works without a NEXT_PUBLIC copy', () => {
  assert.equal(stripePublishableKey({ STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }), 'pk_test_abc');
  assert.equal(stripePublishableKey({ STRIPE_PUBLISHABLE_KEY: 'sk_test_abc' }), null);
});

test('on a Vercel Preview the page needs test keys on both sides, never live ones', () => {
  const on = { ARABIC_CHECKOUT_ENABLED: 'true', VERCEL_ENV: 'preview' };
  assert.equal(isArabicCheckoutAvailable({ ...on, STRIPE_PUBLISHABLE_KEY: 'pk_test_a', STRIPE_SECRET_KEY: 'sk_test_a' }), true);
  assert.equal(isArabicCheckoutAvailable({ ...on, STRIPE_PUBLISHABLE_KEY: 'pk_live_a', STRIPE_SECRET_KEY: 'sk_live_a' }), false);
  assert.equal(isArabicCheckoutAvailable({ ...on, STRIPE_PUBLISHABLE_KEY: 'pk_test_a', STRIPE_SECRET_KEY: 'sk_live_a' }), false);
  assert.equal(isArabicCheckoutAvailable({ ...on, STRIPE_PUBLISHABLE_KEY: 'pk_test_a' }), false);
  // Production is not restricted here: turning it on there is a separate, explicit decision.
  assert.equal(
    isArabicCheckoutAvailable({ ARABIC_CHECKOUT_ENABLED: 'true', VERCEL_ENV: 'production', STRIPE_PUBLISHABLE_KEY: 'pk_live_a' }),
    true,
  );
});

test('the payment page is the only place the policy opens to Stripe', () => {
  assert.equal(ARABIC_CHECKOUT_PATH, '/billing/pay');
  const closed = buildContentSecurityPolicy('n');
  const open = buildContentSecurityPolicy('n', { stripe: true });

  assert.doesNotMatch(closed, /js\.stripe\.com|api\.stripe\.com|hooks\.stripe\.com/);
  for (const host of ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://api.stripe.com', 'https://*.stripe.com']) {
    assert.ok(open.includes(host), host);
    assert.ok(!closed.includes(host), `${host} must not be open elsewhere`);
  }
  // Everything that makes the nonce meaningful is unchanged on the widened page.
  assert.ok(open.includes("script-src 'self' 'nonce-n' 'strict-dynamic'"));
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(open));
  assert.ok(open.includes("frame-ancestors 'none'"));
  assert.ok(open.includes("object-src 'none'"));
  assert.ok(open.includes("default-src 'self'"));
});
