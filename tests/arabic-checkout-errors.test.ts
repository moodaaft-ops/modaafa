import assert from 'node:assert/strict';
import test from 'node:test';

import { arabicCheckoutError, isNetworkFailure } from '../lib/billing/arabic-checkout/errors';
import { ADS_ACCOUNT_TRIAL_USED_MESSAGE, CARD_TRIAL_USED_MESSAGE } from '../lib/billing/trial-copy';

const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{4,}/;

test('every Stripe card decline code resolves to Arabic, with the card to fix', () => {
  const declines = [
    'insufficient_funds',
    'lost_card',
    'stolen_card',
    'expired_card',
    'incorrect_cvc',
    'incorrect_number',
    'invalid_expiry_year',
    'card_velocity_exceeded',
    'do_not_honor',
    'generic_decline',
    'try_again_later',
    'processing_error',
  ];
  for (const decline of declines) {
    const view = arabicCheckoutError({ code: 'card_declined', decline_code: decline });
    assert.match(view.message, ARABIC, decline);
    assert.equal(view.code, `card_declined:${decline}`);
    assert.equal(view.action, 'edit_card');
  }
});

test('insufficient funds names the reason and says nothing was charged', () => {
  const view = arabicCheckoutError({ code: 'card_declined', decline_code: 'insufficient_funds' });
  assert.match(view.message, /الرصيد/);
  assert.match(view.message, /ما انخصم شي/);
});

test('lost and stolen cards are never named to the customer', () => {
  for (const decline of ['lost_card', 'stolen_card', 'pickup_card', 'fraudulent']) {
    const { message } = arabicCheckoutError({ code: 'card_declined', decline_code: decline });
    assert.doesNotMatch(message, /مسروق|مفقود|احتيال/);
  }
});

test('field errors from Stripe Elements are in Arabic', () => {
  for (const code of ['incomplete_number', 'incomplete_cvc', 'incomplete_expiry', 'invalid_expiry_year_past', 'incorrect_cvc', 'expired_card']) {
    assert.match(arabicCheckoutError({ code }).message, ARABIC, code);
  }
});

test('a failed 3D Secure check is its own message, and the card can be changed', () => {
  for (const code of ['payment_intent_authentication_failure', 'setup_intent_authentication_failure']) {
    const view = arabicCheckoutError({ code });
    assert.match(view.message, /3D Secure/);
    assert.match(view.message, /ما انخصم شي/);
  }
});

test('network failures are told apart and can be retried', () => {
  assert.equal(arabicCheckoutError('network_error').action, 'retry');
  assert.equal(arabicCheckoutError('api_connection_error').action, 'retry');
  assert.ok(isNetworkFailure(new TypeError('Failed to fetch')));
  assert.ok(isNetworkFailure(new Error('Load failed')));
  assert.ok(!isNetworkFailure(new Error('card declined')));
});

test('an unknown code never leaks English text', () => {
  const view = arabicCheckoutError({ code: 'some_new_stripe_code_we_never_saw', type: 'card_error' });
  assert.equal(view.code, 'checkout_failed');
  assert.match(view.message, ARABIC);
  assert.doesNotMatch(view.message, LATIN_WORD);
  assert.match(arabicCheckoutError(undefined).message, ARABIC);
  assert.match(arabicCheckoutError(null).message, ARABIC);
});

test('a payment still with the bank says do not pay again and sends the customer on', () => {
  const view = arabicCheckoutError('payment_processing');
  assert.equal(view.action, 'continue');
  assert.match(view.message, /لا تعيد الدفع/);
});

test('a payment taken but not activated says so and does not ask for a second payment', () => {
  const view = arabicCheckoutError('activation_failed');
  assert.match(view.message, /لا تعيد الدفع/);
  assert.equal(view.action, 'contact');
});

test('the trial guards keep their existing wording', () => {
  assert.ok(arabicCheckoutError('card_trial_used').message.startsWith(CARD_TRIAL_USED_MESSAGE));
  assert.ok(arabicCheckoutError('ads_account_trial_used').message.startsWith(ADS_ACCOUNT_TRIAL_USED_MESSAGE));
});

test('no message uses a long dash, a Latin comma, or a banned phrase', () => {
  const codes = [
    'insufficient_funds', 'expired_card', 'incorrect_cvc', 'incomplete_number', 'network_error', 'rate_limit',
    'already_subscribed', 'card_trial_used', 'terms_changed', 'promo_invalid', 'promo_expired', 'setup_not_completed',
    'payment_processing', 'subscription_conflict', 'checkout_failed', 'activation_failed', 'invalid_origin',
    'google_ads_account_required', 'account_suspended', 'internal_access', 'trial_check_failed',
  ];
  for (const code of codes) {
    const { message } = arabicCheckoutError(code);
    assert.doesNotMatch(message, /[—–]/, code);
    assert.doesNotMatch(message, /,/, code);
    assert.doesNotMatch(message, /باختصار|في النهاية|لا تفوت|علاوة على ذلك/, code);
  }
});
