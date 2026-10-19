import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedCheckoutSubmitMessage } from '../lib/billing/stripe';

test('trial message names the trial length and says nothing is charged before it ends', () => {
  const text = hostedCheckoutSubmitMessage(14);
  assert.match(text, /14 يوم/);
  assert.match(text, /ما ينخصم منك شي قبل نهايتها/);
});

test('no-trial message says the amount is charged straight away', () => {
  const text = hostedCheckoutSubmitMessage(0);
  assert.match(text, /ينخصم المبلغ مباشرة/);
  assert.doesNotMatch(text, /تجربتك المجانية/);
  assert.equal(hostedCheckoutSubmitMessage(undefined), text);
});

test('messages stay under Stripe\'s 1200 character limit and use no dashes', () => {
  for (const text of [hostedCheckoutSubmitMessage(14), hostedCheckoutSubmitMessage()]) {
    assert.ok(text.length < 1200);
    assert.doesNotMatch(text, /[—–]/);
  }
});
