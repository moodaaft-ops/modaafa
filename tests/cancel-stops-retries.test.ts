import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';

import {
  applyCustomerCancellation,
  endUnpaidScheduledCancellation,
  type CancelStripeOps,
} from '../lib/billing/stripe';
import { createCancelSubscriptionHandler } from '../lib/billing/cancel-handler';

function fakeOps(status: string, openInvoices: string[] = ['in_1']) {
  const log: string[] = [];
  const ops: CancelStripeOps = {
    retrieveSubscription: async (id) => ({ id, status }),
    scheduleCancel: async (id, cancel) => { log.push(`schedule:${id}:${cancel}`); },
    cancelNow: async (id) => { log.push(`cancelNow:${id}`); },
    listOpenInvoiceIds: async () => openInvoices,
    voidInvoice: async (id) => { log.push(`void:${id}`); },
  };
  return { ops, log };
}

test('past_due subscription is cancelled now and its open invoice voided, so retries stop', async () => {
  const { ops, log } = fakeOps('past_due', ['in_1', 'in_2']);
  assert.equal(await applyCustomerCancellation(ops, 'sub_1', true), 'ended');
  assert.deepEqual(log, ['cancelNow:sub_1', 'void:in_1', 'void:in_2']);
});

test('unpaid and incomplete are treated like past_due', async () => {
  for (const status of ['unpaid', 'incomplete']) {
    const { ops, log } = fakeOps(status);
    assert.equal(await applyCustomerCancellation(ops, 'sub_1', true), 'ended');
    assert.ok(log.includes('cancelNow:sub_1'));
  }
});

test('healthy trial or active period is still scheduled for period end', async () => {
  for (const status of ['trialing', 'active']) {
    const { ops, log } = fakeOps(status);
    assert.equal(await applyCustomerCancellation(ops, 'sub_1', true), 'scheduled');
    assert.deepEqual(log, ['schedule:sub_1:true']);
  }
});

test('resume only undoes a schedule and never reads or cancels', async () => {
  const { ops, log } = fakeOps('past_due');
  assert.equal(await applyCustomerCancellation(ops, 'sub_1', false), 'scheduled');
  assert.deepEqual(log, ['schedule:sub_1:false']);
});

test('a failing void does not undo or fail the cancellation', async () => {
  const { ops, log } = fakeOps('past_due', ['in_bad', 'in_ok']);
  ops.voidInvoice = async (id) => {
    if (id === 'in_bad') throw new Error('boom');
    log.push(`void:${id}`);
  };
  assert.equal(await applyCustomerCancellation(ops, 'sub_1', true), 'ended');
  assert.deepEqual(log, ['cancelNow:sub_1', 'void:in_ok']);
});

test('webhook safety net acts only on unpaid subscriptions scheduled to cancel', async () => {
  const { ops, log } = fakeOps('past_due');
  assert.equal(await endUnpaidScheduledCancellation({ id: 's', status: 'past_due', cancel_at_period_end: true }, ops), true);
  assert.equal(await endUnpaidScheduledCancellation({ id: 's', status: 'past_due', cancel_at_period_end: false }, ops), false);
  assert.equal(await endUnpaidScheduledCancellation({ id: 's', status: 'active', cancel_at_period_end: true }, ops), false);
  assert.equal(await endUnpaidScheduledCancellation({ id: 's', status: 'unpaid', cancel_at: 1 }, ops), true);
  assert.deepEqual(log, ['cancelNow:s', 'void:in_1', 'cancelNow:s', 'void:in_1']);
});

test('cancel route tells the customer it ended now', async () => {
  const handler = createCancelSubscriptionHandler({
    isSameOriginRequest: () => true,
    getUserId: async () => 'u',
    checkRateLimit: async () => true,
    getActiveSubscriptionId: async () => 'sub_1',
    setCancelAtPeriodEnd: async () => 'ended',
  });
  const res = await handler(
    new NextRequest('https://ai.modaafa.com/api/billing/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'cancel' }),
    })
  );
  assert.equal(new URL(res.headers.get('location')!).searchParams.get('cancel'), 'ended');
});
