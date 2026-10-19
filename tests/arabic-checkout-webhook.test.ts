import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';

import {
  createStripeWebhookHandler,
  type StripeWebhookDependencies,
} from '../lib/billing/stripe-webhook-handler';

const CREATED_AT = Math.floor(new Date('2026-10-20T09:00:00.000Z').getTime() / 1000);

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_arabic',
    object: 'subscription',
    status: 'trialing',
    customer: 'cus_test',
    metadata: { userId: 'user-1', plan: 'growth', period: 'monthly', source: 'arabic_checkout' },
    items: { data: [] },
    trial_end: CREATED_AT + 14 * 86400,
    current_period_start: CREATED_AT,
    current_period_end: CREATED_AT + 14 * 86400,
    canceled_at: null,
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function event(type: string, object: object, id: string, previous?: object): Stripe.Event {
  return {
    id,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: CREATED_AT,
    data: { object, ...(previous ? { previous_attributes: previous } : {}) },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as unknown as Stripe.Event;
}

function usersDatabase() {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === 'users' ? { email: 'customer@example.com', name: 'عميل' } : { id: 'row-1', user_id: 'user-1' },
          error: null,
        }),
      };
      return chain;
    },
  };
}

function harness(stripeEvent: Stripe.Event, live: Stripe.Subscription, overrides: Partial<StripeWebhookDependencies> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const mails: Array<Record<string, unknown>> = [];
  const invoices: string[] = [];
  const handler = createStripeWebhookHandler({
    constructWebhookEvent: () => stripeEvent,
    createAdminClient: () => usersDatabase() as any,
    claimStripeWebhookEvent: async () => 'claimed',
    retrieveStripeSubscription: async () => live as any,
    planFromSubscription: () => ({ plan: 'growth', period: 'monthly', source: 'price' }) as any,
    applySubscriptionEvent: async (_db: any, row: any) => {
      writes.push(row);
      return 'updated';
    },
    subscriptionEventWasApplied: () => true,
    recordTrialGrant: async () => undefined,
    recordPaidInvoice: async (_db: any, input: any) => {
      invoices.push(input.invoice.id);
      return { recorded: true, duplicate: false } as any;
    },
    recordUserEvent: async () => undefined,
    enforceTrialCardUniqueness: async () => ({ blocked: false, outcome: 'first_use' as const }),
    enforceTrialStartAccountLock: async () => ({
      blocked: false,
      outcome: 'claimed' as const,
      pausedAccountIds: [],
      claimedCustomerId: null,
    }),
    sendEmail: (async (message: Record<string, unknown>) => {
      mails.push(message);
      return { sent: true, id: 'mail' };
    }) as any,
    completeStripeWebhookEvent: async () => undefined,
    failStripeWebhookEvent: async () => undefined,
    sendOpsAlert: async () => ({ sent: true, id: 'ops' }),
    ...overrides,
  } as Partial<StripeWebhookDependencies>);
  const send = () =>
    handler(
      new NextRequest('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'stubbed' },
        body: '{}',
      }),
    );
  return { send, writes, mails, invoices };
}

test('an Arabic-checkout subscription still waiting on its first payment is not written to our table', async () => {
  for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
    for (const status of ['incomplete', 'incomplete_expired']) {
      const live = subscription({ status });
      const { send, writes, mails } = harness(event(type, { id: 'sub_arabic' }, `evt_${type}_${status}`), live);
      const response = await send();
      assert.equal(response.status, 200, `${type} ${status}`);
      assert.equal(writes.length, 0, `${type} ${status} must not be written (incomplete would become past_due)`);
      assert.equal(mails.length, 0);
    }
  }
});

test('the first invoice of a pay-now subscription failing sends no payment-failed mail and writes no row', async () => {
  const live = subscription({ status: 'incomplete', trial_end: null });
  const { send, writes, mails } = harness(
    event('invoice.payment_failed', { id: 'in_1', subscription: 'sub_arabic' }, 'evt_inv_failed'),
    live,
  );
  assert.equal((await send()).status, 200);
  assert.equal(writes.length, 0);
  assert.equal(mails.length, 0);
});

test('an unactivated subscription records no invoice either', async () => {
  const live = subscription({ status: 'incomplete', trial_end: null });
  const { send, writes, invoices } = harness(
    event('invoice.payment_succeeded', { id: 'in_2', subscription: 'sub_arabic', amount_paid: 0 }, 'evt_inv_paid'),
    live,
  );
  await send();
  assert.equal(writes.length, 0);
  assert.deepEqual(invoices, []);
});

test('a paid invoice on a not-yet-active subscription is retried, not dropped', async () => {
  const live = subscription({ status: 'incomplete', trial_end: null });
  const { send, writes, invoices } = harness(
    event('invoice.payment_succeeded', { id: 'in_2', subscription: 'sub_arabic', status: 'paid', amount_paid: 50000 }, 'evt_inv_paid_early'),
    live,
  );
  const response = await send();
  assert.ok((response as Response).status >= 500, 'a failure status makes Stripe deliver the event again');
  assert.equal(writes.length, 0);
  assert.deepEqual(invoices, []);
});

test('a failed renewal after the trial is a normal past_due and still reaches the customer', async () => {
  const live = subscription({ status: 'past_due', trial_end: CREATED_AT - 86400 });
  const { send, writes, mails } = harness(
    event('invoice.payment_failed', { id: 'in_3', subscription: 'sub_arabic' }, 'evt_renewal_failed'),
    live,
  );
  await send();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'past_due');
  assert.equal(mails.length, 1, 'the payment-failed mail still goes out');
});

test('the welcome mail is sent once from the created event, with a key that stops a second one', async () => {
  const { send, writes, mails } = harness(
    event('customer.subscription.created', { id: 'sub_arabic' }, 'evt_created'),
    subscription(),
  );
  await send();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'trialing');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'customer@example.com');
  assert.equal(mails[0].idempotencyKey, 'modaafa-arabic-welcome:sub_arabic');
});

test('a pay-now subscription is welcomed when it moves from incomplete to active', async () => {
  const live = subscription({ status: 'active', trial_end: null });
  const { send, writes, mails } = harness(
    event('customer.subscription.updated', { id: 'sub_arabic' }, 'evt_activated', { status: 'incomplete' }),
    live,
  );
  await send();
  assert.equal(writes[0].status, 'active');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].idempotencyKey, 'modaafa-arabic-welcome:sub_arabic');
});

test('an ordinary update, a stale write, or a blocked trial sends no welcome', async () => {
  const update = harness(event('customer.subscription.updated', { id: 'sub_arabic' }, 'evt_plain'), subscription());
  await update.send();
  assert.equal(update.mails.length, 0);

  const stale = harness(event('customer.subscription.created', { id: 'sub_arabic' }, 'evt_stale'), subscription(), {
    subscriptionEventWasApplied: (() => false) as any,
  });
  await stale.send();
  assert.equal(stale.mails.length, 0, 'the activation floor lost the race on purpose; the other writer sends it');

  const blocked = harness(event('customer.subscription.created', { id: 'sub_arabic' }, 'evt_blocked'), subscription(), {
    enforceTrialCardUniqueness: async () => ({ blocked: true, outcome: 'blocked' as const }) as any,
  });
  await blocked.send();
  assert.equal(blocked.writes[0].status, 'canceled');
  assert.equal(blocked.mails.length, 0);
});

test('a hosted-checkout subscription is handled exactly as before and never gets the Arabic welcome', async () => {
  const hosted = subscription({ metadata: { userId: 'user-1', plan: 'growth', period: 'monthly' } });
  const { send, writes, mails } = harness(event('customer.subscription.created', { id: 'sub_arabic' }, 'evt_hosted'), hosted);
  await send();
  assert.equal(writes.length, 1);
  assert.equal(mails.length, 0, 'the hosted path welcomes from checkout.session.completed');
});
