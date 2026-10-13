import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enforceTrialCardUniqueness,
  type TrialCardStripe,
  type TrialCardSubscription,
} from '../lib/billing/trial-card-guard';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const FUTURE = Math.floor(NOW / 1000) + 14 * 24 * 3600;
const PAST = Math.floor(NOW / 1000) - 3600;

/** An in-memory trial_card_ledger behind the slice of the query builder the guard uses. */
function fakeAdmin(options: { failInsert?: boolean; failRead?: boolean } = {}) {
  const rows = new Map<string, { first_user_id: string; stripe_subscription_id: string | null }>();
  return {
    rows,
    from(table: string) {
      assert.equal(table, 'trial_card_ledger');
      return {
        upsert(row: any, opts: any) {
          assert.deepEqual(opts, { onConflict: 'fingerprint', ignoreDuplicates: true });
          return {
            select() {
              if (options.failInsert) {
                return Promise.resolve({ data: null, error: { message: 'insert failed' } });
              }
              if (rows.has(row.fingerprint)) return Promise.resolve({ data: [], error: null });
              rows.set(row.fingerprint, {
                first_user_id: row.first_user_id,
                stripe_subscription_id: row.stripe_subscription_id,
              });
              return Promise.resolve({ data: [{ fingerprint: row.fingerprint }], error: null });
            },
          };
        },
        select() {
          return {
            eq(_column: string, fingerprint: string) {
              return {
                maybeSingle() {
                  if (options.failRead) {
                    return Promise.resolve({ data: null, error: { message: 'read failed' } });
                  }
                  return Promise.resolve({ data: rows.get(fingerprint) ?? null, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

function fakeStripe(overrides: Partial<TrialCardStripe> & { fingerprints?: Record<string, string> } = {}) {
  const calls = { retrievePaymentMethod: [] as string[], retrieveCustomer: [] as string[], cancel: [] as string[] };
  const fingerprints = overrides.fingerprints ?? { pm_a: 'fp_card_a', pm_b: 'fp_card_b' };
  const stripe: TrialCardStripe = {
    async retrievePaymentMethod(id) {
      calls.retrievePaymentMethod.push(id);
      return fingerprints[id] ? { id, card: { fingerprint: fingerprints[id] } } : { id, card: null };
    },
    async retrieveCustomer(id) {
      calls.retrieveCustomer.push(id);
      return { invoice_settings: { default_payment_method: 'pm_a' } };
    },
    async retrieveSubscription() {
      return { status: 'trialing' };
    },
    async cancelSubscription(id) {
      calls.cancel.push(id);
      return { id, status: 'canceled' };
    },
    ...overrides,
  };
  return { stripe, calls };
}

function trialing(overrides: Partial<TrialCardSubscription> = {}): TrialCardSubscription {
  return {
    id: 'sub_1',
    status: 'trialing',
    trial_end: FUTURE,
    customer: 'cus_1',
    default_payment_method: 'pm_a',
    ...overrides,
  };
}

async function quietly<T>(run: () => Promise<T>) {
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => void errors.push(args);
  console.warn = () => {};
  try {
    return { value: await run(), errors };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

test('a new card claims the ledger and is not blocked', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  const result = await enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW });
  assert.deepEqual(result, { blocked: false, outcome: 'first_use' });
  assert.deepEqual(admin.rows.get('fp_card_a'), { first_user_id: USER, stripe_subscription_id: 'sub_1' });
  assert.deepEqual(calls.cancel, []);
});

test('the same user replaying the same card is fine (idempotent)', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  await enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW });
  const again = await enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW });
  assert.deepEqual(again, { blocked: false, outcome: 'same_user' });
  assert.deepEqual(calls.cancel, []);
  // The first claim keeps its subscription id.
  assert.equal(admin.rows.get('fp_card_a')?.stripe_subscription_id, 'sub_1');
});

test("another user's card cancels the new subscription immediately and blocks", async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  await enforceTrialCardUniqueness({ stripe, admin, userId: OTHER, subscription: trialing({ id: 'sub_first' }), now: NOW });

  const { value } = await quietly(() =>
    enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing({ id: 'sub_second' }), now: NOW })
  );
  assert.deepEqual(value, { blocked: true, outcome: 'duplicate_card' });
  assert.deepEqual(calls.cancel, ['sub_second']);
  // The original owner keeps the card.
  assert.equal(admin.rows.get('fp_card_a')?.first_user_id, OTHER);
});

test('a different card for the same user is a separate claim', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  await enforceTrialCardUniqueness({ stripe, admin, userId: OTHER, subscription: trialing(), now: NOW });
  const result = await enforceTrialCardUniqueness({
    stripe,
    admin,
    userId: USER,
    subscription: trialing({ id: 'sub_2', default_payment_method: 'pm_b' }),
    now: NOW,
  });
  assert.equal(result.blocked, false);
  assert.deepEqual(calls.cancel, []);
});

test('an expanded payment method object is used without another Stripe call', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  const result = await enforceTrialCardUniqueness({
    stripe,
    admin,
    userId: USER,
    subscription: trialing({ default_payment_method: { id: 'pm_x', card: { fingerprint: 'fp_expanded' } } }),
    now: NOW,
  });
  assert.equal(result.outcome, 'first_use');
  assert.deepEqual(calls.retrievePaymentMethod, []);
  assert.ok(admin.rows.has('fp_expanded'));
});

test("falls back to the customer's default payment method", async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  const result = await enforceTrialCardUniqueness({
    stripe,
    admin,
    userId: USER,
    subscription: trialing({ default_payment_method: null }),
    now: NOW,
  });
  assert.equal(result.outcome, 'first_use');
  assert.deepEqual(calls.retrieveCustomer, ['cus_1']);
  assert.ok(admin.rows.has('fp_card_a'));
});

test('an expanded customer object on the subscription also resolves the customer id', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  await enforceTrialCardUniqueness({
    stripe,
    admin,
    userId: USER,
    subscription: trialing({ default_payment_method: null, customer: { id: 'cus_obj' } }),
    now: NOW,
  });
  assert.deepEqual(calls.retrieveCustomer, ['cus_obj']);
});

test('a Stripe lookup failure does NOT block the trial', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe({
    async retrievePaymentMethod() {
      throw new Error('stripe is down');
    },
  });
  const { value, errors } = await quietly(() =>
    enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW })
  );
  assert.deepEqual(value, { blocked: false, outcome: 'lookup_failed' });
  assert.deepEqual(calls.cancel, []);
  assert.equal(errors.length, 1);
  assert.equal(admin.rows.size, 0);
});

test('a ledger failure does NOT block the trial', async () => {
  for (const options of [{ failInsert: true }, { failRead: true }]) {
    const admin = fakeAdmin(options);
    // Make the card look already claimed so the read-back path is exercised.
    admin.rows.set('fp_card_a', { first_user_id: OTHER, stripe_subscription_id: 'sub_old' });
    const { stripe, calls } = fakeStripe();
    const { value } = await quietly(() =>
      enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW })
    );
    assert.deepEqual(value, { blocked: false, outcome: 'lookup_failed' });
    assert.deepEqual(calls.cancel, []);
  }
});

test('a card with no fingerprint (and no fallback) is not blocked', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe({
    async retrieveCustomer() {
      return { invoice_settings: { default_payment_method: null } };
    },
  });
  const { value, errors } = await quietly(() =>
    enforceTrialCardUniqueness({
      stripe,
      admin,
      userId: USER,
      subscription: trialing({ default_payment_method: 'pm_unknown' }),
      now: NOW,
    })
  );
  assert.deepEqual(value, { blocked: false, outcome: 'no_fingerprint' });
  assert.deepEqual(calls.cancel, []);
  assert.equal(errors.length, 1);
  assert.equal(admin.rows.size, 0);
});

test('a deleted customer yields no fingerprint', async () => {
  const admin = fakeAdmin();
  const { stripe } = fakeStripe({
    async retrieveCustomer() {
      return { deleted: true };
    },
  });
  const { value } = await quietly(() =>
    enforceTrialCardUniqueness({
      stripe,
      admin,
      userId: USER,
      subscription: trialing({ default_payment_method: null }),
      now: NOW,
    })
  );
  assert.equal(value.outcome, 'no_fingerprint');
});

test('only a live trial is checked', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  for (const subscription of [
    trialing({ status: 'active' }),
    trialing({ status: 'canceled' }),
    trialing({ trial_end: PAST }),
    trialing({ trial_end: null }),
  ]) {
    const result = await enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription, now: NOW });
    assert.deepEqual(result, { blocked: false, outcome: 'not_trialing' });
  }
  assert.equal(admin.rows.size, 0);
  assert.deepEqual(calls.retrievePaymentMethod, []);
  assert.deepEqual(calls.cancel, []);
});

test('two users racing on one card: exactly one is blocked', async () => {
  const admin = fakeAdmin();
  const { stripe, calls } = fakeStripe();
  const { value } = await quietly(() =>
    Promise.all([
      enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing({ id: 'sub_u' }), now: NOW }),
      enforceTrialCardUniqueness({ stripe, admin, userId: OTHER, subscription: trialing({ id: 'sub_o' }), now: NOW }),
    ])
  );
  assert.equal(value.filter((result) => result.blocked).length, 1);
  assert.equal(calls.cancel.length, 1);
});

test('a cancel that fails because the subscription is already cancelled still counts as blocked', async () => {
  const admin = fakeAdmin();
  admin.rows.set('fp_card_a', { first_user_id: OTHER, stripe_subscription_id: 'sub_old' });
  const { stripe } = fakeStripe({
    async cancelSubscription() {
      throw new Error('No such subscription');
    },
    async retrieveSubscription() {
      return { status: 'canceled' };
    },
  });
  const { value } = await quietly(() =>
    enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW })
  );
  assert.deepEqual(value, { blocked: true, outcome: 'duplicate_card' });
});

test('a cancel that fails while the subscription is still live is surfaced, not swallowed', async () => {
  const admin = fakeAdmin();
  admin.rows.set('fp_card_a', { first_user_id: OTHER, stripe_subscription_id: 'sub_old' });
  const { stripe } = fakeStripe({
    async cancelSubscription() {
      throw new Error('stripe unavailable');
    },
    async retrieveSubscription() {
      return { status: 'trialing' };
    },
  });
  const { value } = await quietly(() =>
    enforceTrialCardUniqueness({ stripe, admin, userId: USER, subscription: trialing(), now: NOW }).then(
      () => 'resolved',
      (error) => (error as Error).message
    )
  );
  assert.equal(value, 'stripe unavailable');
});
