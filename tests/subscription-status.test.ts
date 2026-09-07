import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSubscriptionStatus } from '../lib/billing/subscription-status';
import { getSubscriptionAccess, isSubscriptionEntitled } from '../lib/billing/entitlements';

const now = Date.parse('2026-09-07T00:00:00Z');
const future = '2026-10-07T00:00:00Z';

for (const status of ['incomplete', 'unpaid', 'incomplete_expired', 'paused', 'unknown', undefined]) {
  test(`Stripe ${status} cannot grant access even with a future period end`, () => {
    assert.equal(isSubscriptionEntitled({
      status: normalizeSubscriptionStatus(status), current_period_end: future,
    }, now), false);
  });
}

test('a real past_due subscription preserves the existing grace policy', () => {
  assert.equal(isSubscriptionEntitled({
    status: normalizeSubscriptionStatus('past_due'), current_period_end: future,
  }, now), true);
});

test('expired initial checkout is terminal so it cannot block a new subscription', () => {
  assert.equal(normalizeSubscriptionStatus('incomplete_expired'), 'canceled');
});

test('invalid or epoch subscription dates do not grant indefinite access', () => {
  for (const date of ['not-a-date', '1970-01-01T00:00:00Z']) {
    assert.equal(isSubscriptionEntitled({ status: 'active', current_period_end: date }, now), false);
    assert.equal(isSubscriptionEntitled({ status: 'trialing', trial_ends_at: date }, now), false);
  }
});

test('subscription storage failure is not misrepresented as an unsubscribed customer', async () => {
  const query = {
    select() { return this; }, order() { return this; }, limit() { return this; },
    async eq() { return { data: null, error: { message: 'unavailable' } }; },
  };
  await assert.rejects(getSubscriptionAccess({ from: () => query }, 'user-test'), /could not be verified/);
});
