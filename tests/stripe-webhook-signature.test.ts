import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';

import { constructWebhookEvent } from '../lib/billing/stripe';
import { createStripeWebhookHandler } from '../lib/billing/stripe-webhook-handler';

test('the Stripe webhook route accepts a valid signature and rejects tampering', async () => {
  const previousSecretKey = process.env.STRIPE_SECRET_KEY;
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const webhookSecret = 'whsec_modaafa_test_only';
  const payload = JSON.stringify({
    id: 'evt_signature_test',
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'sub_test' } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: 'customer.subscription.updated',
  });

  process.env.STRIPE_SECRET_KEY = 'sk_test_modaafa_signature_verification_only';
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-02-24.acacia',
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    assert.equal(constructWebhookEvent(payload, signature).id, 'evt_signature_test');
    assert.throws(
      () => constructWebhookEvent(`${payload} `, signature),
      /No signatures found matching the expected signature for payload/,
    );

    const handler = createStripeWebhookHandler({
      createAdminClient: () => ({}) as any,
      claimStripeWebhookEvent: async () => 'already_completed',
    });
    const accepted = await handler(webhookRequest(payload, signature));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { received: true, duplicate: true });

    const rejected = await handler(webhookRequest(`${payload} `, signature));
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'invalid_signature' });
  } finally {
    restoreEnv('STRIPE_SECRET_KEY', previousSecretKey);
    restoreEnv('STRIPE_WEBHOOK_SECRET', previousWebhookSecret);
  }
});

function webhookRequest(payload: string, signature: string) {
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: payload,
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
