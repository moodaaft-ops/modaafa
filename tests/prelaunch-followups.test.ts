import assert from 'node:assert/strict';
import test from 'node:test';

import { invoiceSubscriptionId } from '../lib/billing/stripe-webhook-handler';
import { isOAuthClientLevelError, shouldTreatAsPlatformAuthOutage } from '../lib/google-ads/client';
import { buildOperatorUserRows, sanitizeOperatorSearch } from '../lib/platform/operator-users';

test('invoice subscription id is read from both Stripe API shapes', () => {
  assert.equal(invoiceSubscriptionId({ subscription: 'sub_old' }), 'sub_old');
  assert.equal(invoiceSubscriptionId({ subscription: { id: 'sub_obj' } }), 'sub_obj');
  assert.equal(
    invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_new' } } }),
    'sub_new'
  );
  assert.equal(invoiceSubscriptionId({}), null);
});

test('client-level OAuth failures across a whole run are a platform outage, not revocations', () => {
  assert.equal(isOAuthClientLevelError({ response: { data: { error: 'invalid_client' } } }), true);
  assert.equal(isOAuthClientLevelError({ response: { data: { error: 'invalid_grant' } } }), false);
  assert.equal(shouldTreatAsPlatformAuthOutage(5, 0), true);
  assert.equal(shouldTreatAsPlatformAuthOutage(1, 0), false);
  assert.equal(shouldTreatAsPlatformAuthOutage(5, 3), false);
});

test('operator user rows join plan, live subscription, accounts and usage per user', () => {
  const rows = buildOperatorUserRows({
    users: [
      { id: 'u1', email: 'a@x.com', name: 'A', created_at: '2026-09-01' },
      { id: 'u2', email: 'b@x.com', name: null, created_at: '2026-09-02' },
    ],
    subscriptions: [
      { user_id: 'u1', plan: 'starter', status: 'canceled', created_at: '2026-09-02' },
      { user_id: 'u1', plan: 'growth', status: 'trialing', created_at: '2026-09-01', trial_ends_at: '2026-09-15' },
    ],
    businesses: [{ id: 'b1', user_id: 'u1', name: 'Shop' }],
    accounts: [
      { business_id: 'b1', status: 'active', is_manager: false },
      { business_id: 'b1', status: 'active', is_manager: true },
      { business_id: 'b1', status: 'revoked', is_manager: false },
    ],
    usage: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }],
  });
  assert.equal(rows[0].plan, 'growth');
  assert.equal(rows[0].subscriptionStatus, 'trialing');
  assert.equal(rows[0].businessName, 'Shop');
  assert.equal(rows[0].activeAdAccounts, 1);
  assert.equal(rows[0].usageLast7Days, 2);
  assert.equal(rows[1].plan, null);
  assert.equal(rows[1].usageLast7Days, 1);
});

test('operator search cannot inject PostgREST filter syntax', () => {
  assert.equal(sanitizeOperatorSearch('ali@x.com'), 'ali@x.com');
  assert.equal(sanitizeOperatorSearch('a%,email.eq.x)'), 'aemail.eq.x');
  assert.equal(sanitizeOperatorSearch(42), '');
});
