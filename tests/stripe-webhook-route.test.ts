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
    enforceTrialCardUniqueness: async () => ({ blocked: false, outcome: 'first_use' as const }),
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
    ...overrides,
  } as unknown as Stripe.Subscription;
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

function trialEndingDatabase() {
  const rows: Record<string, Record<string, unknown>> = {
    subscriptions: { user_id: 'user-1' },
    users: { email: 'customer@example.com' },
  };
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return chain;
    },
  };
}

test('the trial-ending email is skipped when the customer already cancelled', async () => {
  const sent: Array<{ to: string }> = [];
  const handler = handlerFor(
    event('customer.subscription.trial_will_end', { id: 'sub_trial', trial_end: CREATED_AT + 259_200 }, 'evt_trial_cancelled'),
    {
      createAdminClient: () => trialEndingDatabase() as any,
      retrieveStripeSubscription: async () =>
        subscription({ id: 'sub_trial', status: 'trialing', cancel_at_period_end: true }) as any,
      sendEmail: (async (message: { to: string }) => {
        sent.push(message);
        return { sent: true };
      }) as any,
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(sent, []);
});

test('the trial-ending email is still sent when the customer has not cancelled', async () => {
  const sent: Array<{ to: string }> = [];
  const handler = handlerFor(
    event('customer.subscription.trial_will_end', { id: 'sub_trial', trial_end: CREATED_AT + 259_200 }, 'evt_trial_live'),
    {
      createAdminClient: () => trialEndingDatabase() as any,
      retrieveStripeSubscription: async () =>
        subscription({ id: 'sub_trial', status: 'trialing', cancel_at_period_end: false }) as any,
      sendEmail: (async (message: { to: string }) => {
        sent.push(message);
        return { sent: true };
      }) as any,
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'customer@example.com');
});

// ---------------------------------------------------------------------------
// One free trial per card
// ---------------------------------------------------------------------------

function trialingSubscription(overrides: Record<string, unknown> = {}) {
  return subscription({
    id: 'sub_card',
    status: 'trialing',
    trial_end: CREATED_AT + 14 * 86_400,
    default_payment_method: 'pm_card',
    ...overrides,
  });
}

function checkoutCompletedEvent(id: string) {
  return event(
    'checkout.session.completed',
    { id: 'cs_card', metadata: { userId: 'user-1' }, subscription: 'sub_card', customer: 'cus_test' },
    id,
  );
}

test('checkout.session.completed passes the live trialing subscription to the card guard', async () => {
  const guardCalls: Array<{ userId: string; subscriptionId: string }> = [];
  const applied: Array<Record<string, unknown>> = [];
  const sent: Array<{ to: string }> = [];
  const grants: string[] = [];
  const handler = handlerFor(checkoutCompletedEvent('evt_card_ok'), {
    createAdminClient: () => trialEndingDatabase() as any,
    retrieveStripeSubscription: async () => trialingSubscription() as any,
    enforceTrialCardUniqueness: async ({ userId, subscription: sub }) => {
      guardCalls.push({ userId, subscriptionId: sub.id });
      return { blocked: false, outcome: 'first_use' };
    },
    applySubscriptionEvent: async (_database, row) => {
      applied.push(row);
      return 'inserted';
    },
    recordTrialGrant: async ({ userId }) => {
      grants.push(userId);
    },
    sendEmail: (async (message: { to: string }) => {
      sent.push(message);
      return { sent: true };
    }) as any,
  });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(guardCalls, [{ userId: 'user-1', subscriptionId: 'sub_card' }]);
  assert.equal(applied[0].status, 'trialing');
  assert.deepEqual(grants, ['user-1']);
  assert.equal(sent.length, 1);
});

test('a duplicate-card trial is written as canceled and gets no welcome email', async () => {
  const applied: Array<Record<string, unknown>> = [];
  const sent: Array<{ to: string }> = [];
  const grants: string[] = [];
  const handler = handlerFor(checkoutCompletedEvent('evt_card_dupe'), {
    createAdminClient: () => trialEndingDatabase() as any,
    retrieveStripeSubscription: async () => trialingSubscription() as any,
    enforceTrialCardUniqueness: async () => ({ blocked: true, outcome: 'duplicate_card' }),
    applySubscriptionEvent: async (_database, row) => {
      applied.push(row);
      return 'inserted';
    },
    recordTrialGrant: async ({ userId }) => {
      grants.push(userId);
    },
    sendEmail: (async (message: { to: string }) => {
      sent.push(message);
      return { sent: true };
    }) as any,
  });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].status, 'canceled');
  assert.equal(applied[0].canceled_at, '2026-08-03T12:00:00.000Z');
  assert.deepEqual(sent, []);
  // The trial still counts as used, so the next checkout does not offer another.
  assert.deepEqual(grants, ['user-1']);
});

test('customer.subscription.created also runs the card guard and a block writes canceled', async () => {
  const guardCalls: string[] = [];
  const applied: Array<Record<string, unknown>> = [];
  const handler = handlerFor(
    event('customer.subscription.created', { id: 'sub_card', metadata: { userId: 'user-1' } }, 'evt_created_dupe'),
    {
      retrieveStripeSubscription: async () => trialingSubscription() as any,
      enforceTrialCardUniqueness: async ({ subscription: sub }) => {
        guardCalls.push(sub.id);
        return { blocked: true, outcome: 'duplicate_card' };
      },
      applySubscriptionEvent: async (_database, row) => {
        applied.push(row);
        return 'updated';
      },
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(guardCalls, ['sub_card']);
  assert.equal(applied[0].status, 'canceled');
});

test('customer.subscription.updated and a missing user never run the card guard', async () => {
  let calls = 0;
  const guard = async () => {
    calls += 1;
    return { blocked: true, outcome: 'duplicate_card' as const };
  };
  const applied: Array<Record<string, unknown>> = [];
  const apply = async (_database: unknown, row: Record<string, unknown>) => {
    applied.push(row);
    return 'updated' as const;
  };

  await handlerFor(
    event('customer.subscription.updated', { id: 'sub_card', metadata: { userId: 'user-1' } }, 'evt_updated'),
    {
      retrieveStripeSubscription: async () => trialingSubscription() as any,
      enforceTrialCardUniqueness: guard,
      applySubscriptionEvent: apply as any,
    },
  )(request());

  await handlerFor(
    event('customer.subscription.created', { id: 'sub_card' }, 'evt_created_no_user'),
    {
      retrieveStripeSubscription: async () =>
        trialingSubscription({ metadata: {} }) as any,
      enforceTrialCardUniqueness: guard,
      applySubscriptionEvent: apply as any,
    },
  )(request());

  assert.equal(calls, 0);
  assert.deepEqual(
    applied.map((row) => row.status),
    ['trialing', 'trialing'],
  );
});

test('a card guard failure returns a retryable 500 instead of leaving a known duplicate trial', async () => {
  const failures: string[] = [];
  const handler = handlerFor(checkoutCompletedEvent('evt_card_throw'), {
    createAdminClient: () => trialEndingDatabase() as any,
    retrieveStripeSubscription: async () => trialingSubscription() as any,
    enforceTrialCardUniqueness: async () => {
      throw new Error('stripe cancel failed');
    },
    applySubscriptionEvent: async () => {
      throw new Error('must not be written before the guard settles');
    },
    failStripeWebhookEvent: async (_database, _id, message) => {
      failures.push(message);
    },
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handler(request());
    assert.equal(response.status, 500);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(failures, ['stripe cancel failed']);
});

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

type OpsAlert = { subject: string; message: string; details?: unknown };

function disputeHarness(
  disputeObject: Record<string, unknown>,
  overrides: Partial<StripeWebhookDependencies> & {
    localSubscriptions?: Array<{ stripe_customer_id: string; stripe_subscription_id: string }>;
  } = {},
) {
  const calls = {
    charges: [] as string[],
    invoices: [] as string[],
    cancelled: [] as string[],
    applied: [] as Array<Record<string, unknown>>,
    alerts: [] as OpsAlert[],
  };
  const { localSubscriptions = [], ...dependencyOverrides } = overrides;
  const database = {
    from(table: string) {
      assert.equal(table, 'subscriptions');
      let customerId: string | null = null;
      const chain: any = {
        select: () => chain,
        eq: (_column: string, value: string) => {
          customerId = value;
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data: localSubscriptions.find((row) => row.stripe_customer_id === customerId) ?? null,
          error: null,
        }),
      };
      return chain;
    },
  };
  const handler = handlerFor(event('charge.dispute.created', disputeObject, 'evt_dispute'), {
    createAdminClient: () => database as any,
    retrieveStripeCharge: (async (id: string) => {
      calls.charges.push(id);
      return { id, invoice: 'in_1', customer: 'cus_test' };
    }) as any,
    retrieveStripeInvoice: (async (id: string) => {
      calls.invoices.push(id);
      return { id, subscription: 'sub_disputed' };
    }) as any,
    retrieveStripeSubscription: async () =>
      subscription({ id: 'sub_disputed', status: 'active' }) as any,
    cancelStripeSubscriptionImmediately: (async (id: string) => {
      calls.cancelled.push(id);
      return subscription({ id, status: 'canceled', canceled_at: CREATED_AT + 5 });
    }) as any,
    applySubscriptionEvent: async (_database, row) => {
      calls.applied.push(row);
      return 'updated';
    },
    sendOpsAlert: async (alert) => {
      calls.alerts.push(alert);
      return { sent: true, id: 'ops-test' };
    },
    ...dependencyOverrides,
  });
  return { handler, calls };
}

test('a dispute cancels the subscription behind the charge immediately and alerts ops with ids only', async () => {
  const { handler, calls } = disputeHarness({ id: 'dp_1', charge: 'ch_1', reason: 'fraudulent', amount: 9900 });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.charges, ['ch_1']);
  assert.deepEqual(calls.invoices, ['in_1']);
  assert.deepEqual(calls.cancelled, ['sub_disputed']);
  assert.equal(calls.applied.length, 1);
  assert.equal(calls.applied[0].status, 'canceled');
  assert.equal(calls.applied[0].stripe_subscription_id, 'sub_disputed');
  assert.equal(calls.alerts.length, 1);
  assert.deepEqual(calls.alerts[0].details, {
    event_id: 'evt_dispute',
    dispute_id: 'dp_1',
    charge_id: 'ch_1',
    subscription_id: 'sub_disputed',
    outcome: 'cancelled',
  });
  // Ids only: nothing about the customer or the amount leaks into the alert.
  const serialized = JSON.stringify(calls.alerts[0]);
  assert.doesNotMatch(serialized, /@|9900|fraudulent/);
});

test('a dispute on a basil-shaped invoice resolves the subscription from parent.subscription_details', async () => {
  const { handler, calls } = disputeHarness(
    { id: 'dp_basil', charge: 'ch_basil' },
    {
      retrieveStripeInvoice: (async (id: string) => ({
        id,
        parent: { subscription_details: { subscription: 'sub_basil' } },
      })) as any,
      retrieveStripeSubscription: async () =>
        subscription({ id: 'sub_basil', status: 'active' }) as any,
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.cancelled, ['sub_basil']);
});

test('an expanded charge and invoice on the dispute need no extra Stripe reads', async () => {
  const { handler, calls } = disputeHarness({
    id: 'dp_expanded',
    charge: { id: 'ch_exp', invoice: { id: 'in_exp', subscription: 'sub_disputed' }, customer: 'cus_test' },
  });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.charges, []);
  assert.deepEqual(calls.invoices, []);
  assert.deepEqual(calls.cancelled, ['sub_disputed']);
});

test('a charge with no invoice falls back to the customer live subscription in our table', async () => {
  const { handler, calls } = disputeHarness(
    { id: 'dp_noinv', charge: 'ch_noinv' },
    {
      retrieveStripeCharge: (async (id: string) => ({ id, invoice: null, customer: 'cus_known' })) as any,
      localSubscriptions: [{ stripe_customer_id: 'cus_known', stripe_subscription_id: 'sub_local' }],
      retrieveStripeSubscription: async () =>
        subscription({ id: 'sub_local', status: 'trialing' }) as any,
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.invoices, []);
  assert.deepEqual(calls.cancelled, ['sub_local']);
});

test('a dispute with no resolvable subscription cancels nothing and tells ops', async () => {
  const { handler, calls } = disputeHarness(
    { id: 'dp_orphan', charge: 'ch_orphan' },
    {
      retrieveStripeCharge: (async (id: string) => ({ id, invoice: null, customer: 'cus_unknown' })) as any,
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.cancelled, []);
  assert.deepEqual(calls.applied, []);
  assert.equal(calls.alerts.length, 1);
  assert.deepEqual(calls.alerts[0].details, {
    event_id: 'evt_dispute',
    dispute_id: 'dp_orphan',
    charge_id: 'ch_orphan',
  });
});

test('a repeated dispute on an already cancelled subscription does not cancel twice', async () => {
  const { handler, calls } = disputeHarness(
    { id: 'dp_repeat', charge: 'ch_1' },
    {
      retrieveStripeSubscription: async () =>
        subscription({ id: 'sub_disputed', status: 'canceled', canceled_at: CREATED_AT - 60 }) as any,
    },
  );

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.cancelled, []);
  assert.equal(calls.applied[0].status, 'canceled');
  assert.equal((calls.alerts[0].details as any).outcome, 'already_ended');
});

test('a failed cancellation is a retryable 500, not a silent success', async () => {
  const failures: string[] = [];
  const { handler } = disputeHarness(
    { id: 'dp_fail', charge: 'ch_1' },
    {
      cancelStripeSubscriptionImmediately: (async () => {
        throw new Error('stripe unavailable');
      }) as any,
      failStripeWebhookEvent: async (_database, _id, message) => {
        failures.push(message);
      },
    },
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handler(request());
    assert.equal(response.status, 500);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(failures, ['stripe unavailable']);
});

test('a lost ops alert does not fail the dispute event after the subscription was cancelled', async () => {
  const completed: string[] = [];
  const { handler, calls } = disputeHarness(
    { id: 'dp_alert', charge: 'ch_1' },
    {
      sendOpsAlert: async () => {
        throw new Error('resend down');
      },
      completeStripeWebhookEvent: async (_database, id) => {
        completed.push(id);
      },
    },
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handler(request());
    assert.equal(response.status, 200);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(calls.cancelled, ['sub_disputed']);
  assert.deepEqual(completed, ['evt_dispute']);
});
