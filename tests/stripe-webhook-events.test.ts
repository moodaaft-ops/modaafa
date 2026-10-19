import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RECOMMENDED_WEBHOOK_EVENTS,
  REQUIRED_WEBHOOK_EVENTS,
  missingWebhookEvents,
} from '../lib/billing/stripe';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the dispute event is recommended, never required (it must not flip launch_ready)', () => {
  assert.ok(!(REQUIRED_WEBHOOK_EVENTS as readonly string[]).includes('charge.dispute.created'));
  assert.deepEqual([...RECOMMENDED_WEBHOOK_EVENTS], ['charge.dispute.created', 'charge.refunded']);
});

test('the required list is the pre-dispute list, unchanged', () => {
  assert.deepEqual(
    [...REQUIRED_WEBHOOK_EVENTS],
    [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_succeeded',
      'invoice.payment_failed',
      'customer.subscription.trial_will_end',
    ]
  );
});

test('an endpoint that sends every required event but not disputes or refunds is webhook ok', () => {
  const enabled = [...REQUIRED_WEBHOOK_EVENTS];
  assert.deepEqual(missingWebhookEvents(REQUIRED_WEBHOOK_EVENTS, enabled), []);
  assert.deepEqual(missingWebhookEvents(RECOMMENDED_WEBHOOK_EVENTS, enabled), ['charge.dispute.created', 'charge.refunded']);
});

test('a wildcard endpoint misses nothing, and a bare endpoint misses everything', () => {
  assert.deepEqual(missingWebhookEvents(REQUIRED_WEBHOOK_EVENTS, ['*']), []);
  assert.deepEqual(missingWebhookEvents(RECOMMENDED_WEBHOOK_EVENTS, ['*']), []);
  assert.deepEqual(missingWebhookEvents(REQUIRED_WEBHOOK_EVENTS, []), [...REQUIRED_WEBHOOK_EVENTS]);
});

test('readiness: only the required events decide webhookOk, the recommended ones are reported', () => {
  const src = read('lib/billing/stripe.ts');
  assert.match(src, /const webhookOk = Boolean\(endpoint\) && missingEvents\.length === 0;/);
  assert.match(src, /missing_recommended_events: missingRecommendedEvents/);
  const okBlock = src.match(/ok:\s*account\.charges_enabled[\s\S]*?modeOk,/)?.[0] ?? '';
  assert.ok(okBlock.includes('webhookOk'));
  assert.ok(!okBlock.includes('missingRecommendedEvents'));
  assert.match(src, /const missingEvents = missingWebhookEvents\(REQUIRED_WEBHOOK_EVENTS, enabledEvents\)/);
});

test('the handler still handles the dispute event', () => {
  assert.match(read('lib/billing/stripe-webhook-handler.ts'), /case 'charge\.dispute\.created':/);
});

test('the handler handles refunds, and refunds are recommended, never required', () => {
  assert.match(read('lib/billing/stripe-webhook-handler.ts'), /case 'charge\.refunded':/);
  assert.ok(!(REQUIRED_WEBHOOK_EVENTS as readonly string[]).includes('charge.refunded'));
});
