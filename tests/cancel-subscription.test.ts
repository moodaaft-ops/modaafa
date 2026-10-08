import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';

import {
  createCancelSubscriptionHandler,
  parseCancelAction,
  type CancelHandlerDependencies,
} from '../lib/billing/cancel-handler';

function request(action?: string) {
  const body = new URLSearchParams(action ? { action } : {});
  return new NextRequest('https://ai.modaafa.com/api/billing/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

function build(overrides: Partial<CancelHandlerDependencies> = {}) {
  const calls: Array<{ id: string; cancel: boolean }> = [];
  const lookedUp: string[] = [];
  const deps: CancelHandlerDependencies = {
    isSameOriginRequest: () => true,
    getUserId: async () => 'user_1',
    checkRateLimit: async () => true,
    getActiveSubscriptionId: async (userId) => {
      lookedUp.push(userId);
      return 'sub_live';
    },
    setCancelAtPeriodEnd: async (id, cancel) => {
      calls.push({ id, cancel });
    },
    ...overrides,
  };
  return { handler: createCancelSubscriptionHandler(deps), calls, lookedUp };
}

function locationOf(response: Response) {
  return new URL(response.headers.get('location') ?? '', 'https://ai.modaafa.com');
}

test('anything but an explicit resume is treated as a cancel request', () => {
  assert.equal(parseCancelAction('resume'), 'resume');
  assert.equal(parseCancelAction('cancel'), 'cancel');
  assert.equal(parseCancelAction(null), 'cancel');
  assert.equal(parseCancelAction('something-else'), 'cancel');
});

test('a signed-in customer with a live subscription schedules the cancel at period end', async () => {
  const { handler, calls, lookedUp } = build();

  const response = await handler(request('cancel'));

  assert.equal(response.status, 303);
  assert.deepEqual(calls, [{ id: 'sub_live', cancel: true }]);
  assert.deepEqual(lookedUp, ['user_1']);
  const target = locationOf(response);
  assert.equal(target.pathname, '/billing');
  assert.equal(target.searchParams.get('cancel'), 'scheduled');
  assert.equal(target.hash, '#cancel');
});

test('resume undoes the scheduled cancel', async () => {
  const { handler, calls } = build();

  const response = await handler(request('resume'));

  assert.deepEqual(calls, [{ id: 'sub_live', cancel: false }]);
  assert.equal(locationOf(response).searchParams.get('cancel'), 'resumed');
});

test('the subscription id comes from our table for the signed-in user, never from the request', async () => {
  const body = new URLSearchParams({ action: 'cancel', subscription: 'sub_someone_else' });
  const { handler, calls } = build();

  await handler(
    new NextRequest('https://ai.modaafa.com/api/billing/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );

  assert.deepEqual(calls, [{ id: 'sub_live', cancel: true }]);
});

test('a cross-site request is rejected before anything is read or changed', async () => {
  const { handler, calls, lookedUp } = build({ isSameOriginRequest: () => false });

  const response = await handler(request('cancel'));

  assert.equal(locationOf(response).searchParams.get('error'), 'invalid_origin');
  assert.deepEqual(calls, []);
  assert.deepEqual(lookedUp, []);
});

test('a signed-out visitor is sent to login and nothing changes', async () => {
  const { handler, calls } = build({ getUserId: async () => null });

  const response = await handler(request('cancel'));

  assert.equal(locationOf(response).pathname, '/login');
  assert.deepEqual(calls, []);
});

test('rate limiting and a broken rate-limit service both stop the change', async () => {
  const limited = build({ checkRateLimit: async () => false });
  const limitedResponse = await limited.handler(request('cancel'));
  assert.equal(locationOf(limitedResponse).searchParams.get('error'), 'too_many_requests');
  assert.deepEqual(limited.calls, []);

  const broken = build({
    checkRateLimit: async () => {
      throw new Error('rate limit store down');
    },
  });
  const brokenResponse = await broken.handler(request('cancel'));
  assert.equal(locationOf(brokenResponse).searchParams.get('error'), 'security_service_unavailable');
  assert.deepEqual(broken.calls, []);
});

test('no live subscription means a clear message and no Stripe call', async () => {
  const { handler, calls } = build({ getActiveSubscriptionId: async () => null });

  const response = await handler(request('cancel'));

  assert.equal(locationOf(response).searchParams.get('error'), 'no_live_subscription');
  assert.deepEqual(calls, []);
});

test('a Stripe failure reports cancel_failed instead of pretending it worked', async () => {
  const { handler } = build({
    setCancelAtPeriodEnd: async () => {
      throw new Error('stripe unavailable');
    },
  });

  const response = await handler(request('cancel'));

  assert.equal(locationOf(response).searchParams.get('error'), 'cancel_failed');
  assert.equal(locationOf(response).searchParams.get('cancel'), null);
});
