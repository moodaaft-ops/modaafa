import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';

import {
  createStripeWebhookHandler,
  type StripeWebhookDependencies,
} from '../lib/billing/stripe-webhook-handler';

const CREATED_AT = Math.floor(new Date('2026-08-03T12:00:00.000Z').getTime() / 1000);

test('an event already being processed returns 409 so Stripe retries it', async () => {
  let completed = false;
  const handler = handlerFor(
    event('customer.subscription.updated', { id: 'sub_in_flight' }, 'evt_in_flight'),
    {
      claimStripeWebhookEvent: async () => 'in_flight',
      completeStripeWebhookEvent: async () => {
        completed = true;
      },
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'event_in_flight' });
  assert.equal(completed, false);
});

test('a delayed update reads current Stripe state and cannot revive a deleted subscription', async () => {
  const applied: Array<Record<string, unknown>> = [];
  const completed: string[] = [];
  const liveSubscription = subscription({
    id: 'sub_ordering',
    status: 'canceled',
    canceled_at: CREATED_AT + 300,
  });
  const handler = handlerFor(
    event(
      'customer.subscription.updated',
      { id: 'sub_ordering', status: 'active', metadata: { userId: 'user-1' } },
      'evt_stale_update',
    ),
    {
      retrieveStripeSubscription: async () => liveSubscription as any,
      applySubscriptionEvent: async (_database, row) => {
        applied.push(row);
        return 'updated';
      },
      completeStripeWebhookEvent: async (_database, eventId) => {
        completed.push(eventId);
      },
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].status, 'canceled');
  assert.equal(applied[0].stripe_subscription_id, 'sub_ordering');
  assert.equal(applied[0].last_event_at, '2026-08-03T12:00:00.000Z');
  assert.deepEqual(completed, ['evt_stale_update']);
});

test('a successful invoice delivery records the invoice before completing the event claim', async () => {
  const order: string[] = [];
  const invoice = {
    id: 'in_paid',
    subscription: 'sub_paid',
    currency: 'sar',
    amount_paid: 50_000,
  };
  const handler = handlerFor(event('invoice.payment_succeeded', invoice, 'evt_invoice'), {
    createAdminClient: () => invoiceDatabase() as any,
    retrieveStripeSubscription: async () =>
      subscription({ id: 'sub_paid', status: 'active' }) as any,
    applySubscriptionEvent: async () => {
      order.push('subscription');
      return 'updated';
    },
    recordPaidInvoice: async (_database, input) => {
      order.push(`invoice:${input.invoice.id}`);
      return { recorded: true, duplicate: false };
    },
    completeStripeWebhookEvent: async (_database, eventId) => {
      order.push(`complete:${eventId}`);
    },
  });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(order, [
    'subscription',
    'invoice:in_paid',
    'complete:evt_invoice',
  ]);
});

test('a processing failure marks the claim failed and returns a retryable 500', async () => {
  const failures: Array<{ id: string; message: string }> = [];
  let alerted = false;
  const handler = handlerFor(
    event('customer.subscription.updated', { id: 'sub_failed' }, 'evt_failed'),
    {
      retrieveStripeSubscription: async () => subscription({ id: 'sub_failed' }) as any,
      applySubscriptionEvent: async () => {
        throw new Error('database unavailable');
      },
      failStripeWebhookEvent: async (_database, id, message) => {
        failures.push({ id, message });
      },
      sendOpsAlert: async () => {
        alerted = true;
        return { sent: true, id: 'ops-test' };
      },
    },
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handler(request());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'processing_failed' });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(failures, [{ id: 'evt_failed', message: 'database unavailable' }]);
  assert.equal(alerted, true);
});

for (const status of ['incomplete', 'unpaid']) {
  test(`subscription webhook stores ${status} without paid grace access`, async () => {
    const rows: Array<Record<string, unknown>> = [];
    const handler = handlerFor(
      event('customer.subscription.updated', { id: 'sub_unpaid' }, `evt_${status}`),
      {
        retrieveStripeSubscription: async () => subscription({ status }),
        applySubscriptionEvent: async (_database, row) => {
          rows.push(row);
          return 'updated';
        },
      },
    );
    assert.equal((await handler(request())).status, 200);
    assert.equal(rows[0].status, 'paused');
  });
}

test('retry repairs a failed durable trial grant even after its subscription snapshot was applied', async () => {
  let attempts = 0;
  let completed = 0;
  const handler = handlerFor(event('customer.subscription.updated', { id: 'sub_trial' }, 'evt_trial_retry'), {
    retrieveStripeSubscription: async () => subscription({ trial_end: CREATED_AT + 86400 }),
    applySubscriptionEvent: async () => 'stale_or_missing',
    recordTrialGrant: async () => {
      attempts++;
      if (attempts === 1) throw new Error('ledger temporarily unavailable');
    },
    completeStripeWebhookEvent: async () => { completed++; },
  });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handler(request())).status, 500);
    assert.equal(completed, 0);
    assert.equal((await handler(request())).status, 200);
    assert.equal(attempts, 2);
    assert.equal(completed, 1);
  } finally { console.error = original; }
});

function handlerFor(
  stripeEvent: Stripe.Event,
  overrides: Partial<StripeWebhookDependencies> = {},
) {
  return createStripeWebhookHandler({
    constructWebhookEvent: () => stripeEvent,
    createAdminClient: () => ({}) as any,
    claimStripeWebhookEvent: async () => 'claimed',
    retrieveStripeSubscription: async () => subscription() as any,
    planFromSubscription: () => ({
      plan: 'starter',
      period: 'monthly',
      source: 'metadata',
    }),
    subscriptionEventWasApplied: () => true,
    recordTrialGrant: async () => undefined,
    completeStripeWebhookEvent: async () => undefined,
    failStripeWebhookEvent: async () => undefined,
    sendOpsAlert: async () => ({ sent: true, id: 'ops-test' }),
    ...overrides,
  } as Partial<StripeWebhookDependencies>);
}

function request() {
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': 'stubbed-valid-signature' },
    body: '{}',
  });
}

function event(type: Stripe.Event.Type, object: object, id: string): Stripe.Event {
  return {
    id,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: CREATED_AT,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as Stripe.Event;
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_default',
    object: 'subscription',
    status: 'active',
    customer: 'cus_test',
    metadata: { userId: 'user-1', plan: 'starter', period: 'monthly' },
    items: { data: [] },
    trial_end: null,
    current_period_start: CREATED_AT - 300,
    current_period_end: CREATED_AT + 2_592_000,
    canceled_at: null,
    lastResponse: { headers: {}, requestId: 'req_test', statusCode: 200 },
    ...overrides,
  } as unknown as Stripe.Response<Stripe.Subscription>;
}

function invoiceDatabase() {
  return {
    from(table: string) {
      assert.equal(table, 'subscriptions');
      return {
        select(columns: string) {
          assert.equal(columns, 'id, user_id');
          return this;
        },
        eq(column: string, value: string) {
          assert.equal(column, 'stripe_subscription_id');
          assert.equal(value, 'sub_paid');
          return this;
        },
        async maybeSingle() {
          return {
            data: { id: 'local-subscription', user_id: 'user-1' },
            error: null,
          };
        },
      };
    },
  };
}
