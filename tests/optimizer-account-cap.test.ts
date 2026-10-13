import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPTIMIZER_ACCOUNTS_PER_PLAN,
  getBillableBusinessIds,
  getOptimizerAllowedAccountIds,
  selectOptimizerAccountIds,
  type OptimizerCapAccount,
  type OptimizerCapBusiness,
} from '../lib/platform/jobs';

const plans = (entries: Record<string, 'starter' | 'growth' | 'pro'>) => new Map(Object.entries(entries));

function accountsFor(businessId: string, count: number, prefix = 'a') {
  return Array.from({ length: count }, (_, index): OptimizerCapAccount => ({
    id: `${prefix}${String(index + 1).padStart(2, '0')}`,
    business_id: businessId,
    customer_id: String(1000000001 + index),
    linked_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
}

test('the per-plan caps are 1, 3 and 25 accounts', () => {
  assert.deepEqual(OPTIMIZER_ACCOUNTS_PER_PLAN, { starter: 1, growth: 3, pro: 25 });
});

test('a starter user keeps one account: the selected one, whichever it is', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '1000000003' },
  ];
  const accounts = accountsFor('b1', 3);
  const result = selectOptimizerAccountIds({ planByUser: plans({ u1: 'starter' }), businesses, accounts });
  assert.deepEqual(result.allowedAccountIds, ['a03']);
  assert.equal(result.skippedOverPlanCap, 2);
});

test('with no selected account the oldest link wins, then the id', () => {
  const businesses: OptimizerCapBusiness[] = [{ id: 'b1', user_id: 'u1', selected_google_ads_customer_id: null }];
  const accounts: OptimizerCapAccount[] = [
    { id: 'z', business_id: 'b1', customer_id: '1000000001', linked_at: '2026-03-01T00:00:00.000Z' },
    { id: 'm', business_id: 'b1', customer_id: '1000000002', linked_at: '2026-01-01T00:00:00.000Z' },
    { id: 'c', business_id: 'b1', customer_id: '1000000003', linked_at: '2026-01-01T00:00:00.000Z' },
    { id: 'n', business_id: 'b1', customer_id: '1000000004', linked_at: null },
  ];
  const growth = selectOptimizerAccountIds({ planByUser: plans({ u1: 'growth' }), businesses, accounts });
  // Jan 1 twice (c before m by id), then March; the unlinked-date row is last.
  assert.deepEqual(growth.allowedAccountIds, ['c', 'm', 'z']);
  assert.equal(growth.skippedOverPlanCap, 1);
});

test('the selected account comes first even when it was linked last, then the oldest fill the rest', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '1000000005' },
  ];
  const accounts = accountsFor('b1', 5);
  const result = selectOptimizerAccountIds({ planByUser: plans({ u1: 'growth' }), businesses, accounts });
  assert.deepEqual(result.allowedAccountIds, ['a05', 'a01', 'a02']);
});

test('a selected customer id stored with dashes still matches', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '100-000-0002' },
  ];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'starter' }),
    businesses,
    accounts: accountsFor('b1', 3),
  });
  assert.deepEqual(result.allowedAccountIds, ['a02']);
});

test('a pro user keeps 25 of 30 and the rest are counted as skipped', () => {
  const businesses: OptimizerCapBusiness[] = [{ id: 'b1', user_id: 'u1' }];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'pro' }),
    businesses,
    accounts: accountsFor('b1', 30),
  });
  assert.equal(result.allowedAccountIds.length, 25);
  assert.equal(result.skippedOverPlanCap, 5);
  assert.ok(!result.allowedAccountIds.includes('a30'));
});

test('a user under the cap keeps everything and skips nothing', () => {
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'pro' }),
    businesses: [{ id: 'b1', user_id: 'u1' }],
    accounts: accountsFor('b1', 2),
  });
  assert.deepEqual(result.allowedAccountIds.sort(), ['a01', 'a02']);
  assert.equal(result.skippedOverPlanCap, 0);
});

test('the cap is per USER: two businesses of one user share it, two users do not', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1' },
    { id: 'b2', user_id: 'u1' },
    { id: 'b3', user_id: 'u2' },
  ];
  const accounts = [
    ...accountsFor('b1', 2, 'x'),
    ...accountsFor('b2', 2, 'y'),
    ...accountsFor('b3', 2, 'z'),
  ];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'starter', u2: 'starter' }),
    businesses,
    accounts,
  });
  // One for u1 (x01 and y01 tie on date, id order) and one for u2.
  assert.deepEqual(result.allowedAccountIds.sort(), ['x01', 'z01']);
  assert.equal(result.skippedOverPlanCap, 4);
});

test('accounts of users who are not billable are ignored, not counted as skipped', () => {
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'starter' }),
    businesses: [
      { id: 'b1', user_id: 'u1' },
      { id: 'b2', user_id: 'lapsed' },
    ],
    accounts: [...accountsFor('b1', 1, 'x'), ...accountsFor('b2', 4, 'y'), ...accountsFor('ghost', 2, 'g')],
  });
  assert.deepEqual(result.allowedAccountIds, ['x01']);
  assert.equal(result.skippedOverPlanCap, 0);
});

test('the choice does not depend on the order the rows arrive in', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '1000000004' },
  ];
  const accounts = accountsFor('b1', 6);
  const forward = selectOptimizerAccountIds({ planByUser: plans({ u1: 'growth' }), businesses, accounts });
  const backward = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'growth' }),
    businesses,
    accounts: [...accounts].reverse(),
  });
  assert.deepEqual(forward.allowedAccountIds, backward.allowedAccountIds);
  assert.deepEqual(forward.allowedAccountIds, ['a04', 'a01', 'a02']);
});

// ---------------------------------------------------------------------------
// Reading the billable set: trial -> starter, grants, suspensions
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

/** A small PostgREST-shaped fake: select/in/eq/not/is/order/range over in-memory tables. */
function fakeDatabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let orderColumn: string | null = null;
      const chain: any = {
        select: () => chain,
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return chain;
        },
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return chain;
        },
        not: (column: string, _operator: string, value: unknown) => {
          rows = rows.filter((row) => row[column] !== value);
          return chain;
        },
        is: (column: string, value: unknown) => {
          rows = rows.filter((row) => (row[column] ?? null) === value);
          return chain;
        },
        order: (column: string) => {
          orderColumn = column;
          return chain;
        },
        range: async (from: number, to: number) => {
          if (orderColumn) {
            const column = orderColumn;
            rows.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0));
          }
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
      return chain;
    },
  };
}

const DAY = 24 * 3600 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function subscriptionRow(userId: string, overrides: Row = {}): Row {
  return {
    user_id: userId,
    plan: 'pro',
    status: 'active',
    trial_ends_at: null,
    current_period_start: iso(-5 * DAY),
    current_period_end: iso(25 * DAY),
    ...overrides,
  };
}

function world(extra: { subscriptions: Row[]; overrides?: Row[]; accountsPerUser?: number }) {
  const users = Array.from(new Set(extra.subscriptions.map((row) => row.user_id)));
  const grantUsers = (extra.overrides ?? []).map((row) => row.user_id as string);
  const everyone = Array.from(new Set([...users, ...grantUsers]));
  const businesses = everyone.map((userId) => ({
    id: `b-${userId}`,
    user_id: userId,
    selected_google_ads_customer_id: null,
  }));
  const accounts = everyone.flatMap((userId) =>
    Array.from({ length: extra.accountsPerUser ?? 4 }, (_, index) => ({
      id: `${userId}-acc${index + 1}`,
      business_id: `b-${userId}`,
      customer_id: String(2000000001 + index),
      status: 'active',
      is_manager: false,
      linked_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }))
  );
  return fakeDatabase({
    subscriptions: extra.subscriptions,
    account_access_overrides: extra.overrides ?? [],
    businesses,
    google_ads_accounts: accounts,
  });
}

test('a trialing Pro user is capped like Starter, an active Pro user like Pro', async () => {
  const database = world({
    subscriptions: [
      subscriptionRow('trial-pro', { status: 'trialing', trial_ends_at: iso(10 * DAY) }),
      subscriptionRow('paid-pro'),
      subscriptionRow('paid-growth', { plan: 'growth' }),
      subscriptionRow('paid-starter', { plan: 'starter' }),
    ],
    accountsPerUser: 5,
  });
  const result = await getOptimizerAllowedAccountIds(database);
  const countFor = (userId: string) => result.allowedAccountIds.filter((id) => id.startsWith(`${userId}-`)).length;
  assert.equal(countFor('trial-pro'), 1);
  assert.equal(countFor('paid-pro'), 5);
  assert.equal(countFor('paid-growth'), 3);
  assert.equal(countFor('paid-starter'), 1);
  // trial-pro 4 + paid-growth 2 + paid-starter 4
  assert.equal(result.skippedOverPlanCap, 10);
});

test('a free-plan grant uses the granted plan, a suspension removes the user entirely', async () => {
  const database = world({
    subscriptions: [
      subscriptionRow('trial-starter', { plan: 'starter', status: 'trialing', trial_ends_at: iso(5 * DAY) }),
      subscriptionRow('suspended-pro'),
    ],
    overrides: [
      // A pro grant on top of a Starter trial wins and is not capped to Starter.
      { user_id: 'trial-starter', kind: 'plan_grant', plan: 'pro', expires_at: null, created_at: iso(-DAY), revoked_at: null },
      // A grant with no Stripe row at all.
      { user_id: 'grant-only', kind: 'plan_grant', plan: 'growth', expires_at: null, created_at: iso(-DAY), revoked_at: null },
      { user_id: 'suspended-pro', kind: 'suspension', plan: null, expires_at: null, created_at: iso(-DAY), revoked_at: null },
    ],
    accountsPerUser: 5,
  });
  const result = await getOptimizerAllowedAccountIds(database);
  const countFor = (userId: string) => result.allowedAccountIds.filter((id) => id.startsWith(`${userId}-`)).length;
  assert.equal(countFor('trial-starter'), 5);
  assert.equal(countFor('grant-only'), 3);
  assert.equal(countFor('suspended-pro'), 0);
});

test('an expired trial or an expired subscription is not billable and gets no accounts', async () => {
  const database = world({
    subscriptions: [
      subscriptionRow('expired-trial', { status: 'trialing', trial_ends_at: iso(-DAY) }),
      subscriptionRow('lapsed', { current_period_end: iso(-DAY) }),
      subscriptionRow('ok'),
    ],
  });
  const result = await getOptimizerAllowedAccountIds(database);
  assert.deepEqual(
    Array.from(new Set(result.allowedAccountIds.map((id) => id.split('-')[0]))),
    ['ok']
  );
});

test('manager accounts and non-active links are never offered to the optimizer', async () => {
  const database = fakeDatabase({
    subscriptions: [subscriptionRow('u1')],
    account_access_overrides: [],
    businesses: [{ id: 'b1', user_id: 'u1', selected_google_ads_customer_id: null }],
    google_ads_accounts: [
      { id: 'mcc', business_id: 'b1', customer_id: '3000000001', status: 'active', is_manager: true, linked_at: '2026-01-01T00:00:00.000Z' },
      { id: 'paused', business_id: 'b1', customer_id: '3000000002', status: 'paused', is_manager: false, linked_at: '2026-01-02T00:00:00.000Z' },
      { id: 'revoked', business_id: 'b1', customer_id: '3000000003', status: 'revoked', is_manager: false, linked_at: '2026-01-03T00:00:00.000Z' },
      { id: 'real', business_id: 'b1', customer_id: '3000000004', status: 'active', is_manager: false, linked_at: '2026-01-04T00:00:00.000Z' },
    ],
  });
  const result = await getOptimizerAllowedAccountIds(database);
  assert.deepEqual(result.allowedAccountIds, ['real']);
});

test('getBillableBusinessIds still returns exactly the businesses of the billable users', async () => {
  const database = world({
    subscriptions: [
      subscriptionRow('paid-pro'),
      subscriptionRow('trial', { status: 'trialing', trial_ends_at: iso(3 * DAY) }),
      subscriptionRow('past-due-recent', { status: 'past_due', current_period_start: iso(-2 * DAY) }),
      subscriptionRow('past-due-stale', { status: 'past_due', current_period_start: iso(-20 * DAY) }),
      subscriptionRow('expired-trial', { status: 'trialing', trial_ends_at: iso(-DAY) }),
      subscriptionRow('suspended'),
    ],
    overrides: [
      { user_id: 'grant-only', kind: 'plan_grant', plan: 'starter', expires_at: null, created_at: iso(-DAY), revoked_at: null },
      { user_id: 'suspended', kind: 'suspension', plan: null, expires_at: null, created_at: iso(-DAY), revoked_at: null },
    ],
  });
  const ids = await getBillableBusinessIds(database);
  assert.deepEqual(
    ids.sort(),
    ['b-grant-only', 'b-paid-pro', 'b-past-due-recent', 'b-trial'].sort()
  );
});
