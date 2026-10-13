import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OPTIMIZER_ACCOUNTS_PER_PLAN,
  OPTIMIZER_DETAIL_BATCH_SIZE,
  chunkIds,
  getBillableBusinessIds,
  getOptimizerAllowedAccountIds,
  pickOptimizerBatch,
  selectOptimizerAccountIds,
  trialClaimsForBatch,
  type OptimizerAllowedAccount,
  type OptimizerCapAccount,
  type OptimizerCapBusiness,
} from '../lib/platform/jobs';
import { optimizerAccountsLine, type OptimizerPlan } from '../lib/billing/optimizer-caps';

const plans = (entries: Record<string, OptimizerPlan>) => new Map(Object.entries(entries));

function accountsFor(businessId: string, count: number, prefix = 'a') {
  return Array.from({ length: count }, (_, index): OptimizerCapAccount => ({
    id: `${prefix}${String(index + 1).padStart(2, '0')}`,
    business_id: businessId,
    customer_id: String(1000000001 + index),
    linked_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
}

test('the per-plan caps are trial 1, starter 3, growth 10 and pro 50 accounts', () => {
  assert.deepEqual(OPTIMIZER_ACCOUNTS_PER_PLAN, { trial: 1, starter: 3, growth: 10, pro: 50 });
});

test('a trial user keeps one account: the selected one, whichever it is', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '1000000003' },
  ];
  const accounts = accountsFor('b1', 3);
  const result = selectOptimizerAccountIds({ planByUser: plans({ u1: 'trial' }), businesses, accounts });
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
  const starter = selectOptimizerAccountIds({ planByUser: plans({ u1: 'starter' }), businesses, accounts });
  // Jan 1 twice (c before m by id), then March; the unlinked-date row is last.
  assert.deepEqual(starter.allowedAccountIds, ['c', 'm', 'z']);
  assert.equal(starter.skippedOverPlanCap, 1);
});

test('the selected account comes first even when it was linked last, then the oldest fill the rest', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '1000000005' },
  ];
  const accounts = accountsFor('b1', 5);
  const result = selectOptimizerAccountIds({ planByUser: plans({ u1: 'starter' }), businesses, accounts });
  assert.deepEqual(result.allowedAccountIds, ['a05', 'a01', 'a02']);
});

test('a selected customer id stored with dashes still matches', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'u1', selected_google_ads_customer_id: '100-000-0002' },
  ];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'trial' }),
    businesses,
    accounts: accountsFor('b1', 3),
  });
  assert.deepEqual(result.allowedAccountIds, ['a02']);
});

test('a pro user keeps 50 of 60 and the rest are counted as skipped', () => {
  const businesses: OptimizerCapBusiness[] = [{ id: 'b1', user_id: 'u1' }];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'pro' }),
    businesses,
    accounts: accountsFor('b1', 60),
  });
  assert.equal(result.allowedAccountIds.length, 50);
  assert.equal(result.skippedOverPlanCap, 10);
  assert.ok(!result.allowedAccountIds.includes('a60'));
});

test('a growth user keeps 10 of 12 and a starter user 3 of 12', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 'g' },
    { id: 'b2', user_id: 's' },
  ];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ g: 'growth', s: 'starter' }),
    businesses,
    accounts: [...accountsFor('b1', 12, 'g'), ...accountsFor('b2', 12, 's')],
  });
  assert.equal(result.allowedAccountIds.filter((id) => id.startsWith('g')).length, 10);
  assert.equal(result.allowedAccountIds.filter((id) => id.startsWith('s')).length, 3);
  assert.equal(result.skippedOverPlanCap, 2 + 9);
});

test('a trial is a level of its own: a paid Starter keeps 3 where a trial keeps 1', () => {
  const businesses: OptimizerCapBusiness[] = [
    { id: 'b1', user_id: 't' },
    { id: 'b2', user_id: 's' },
  ];
  const result = selectOptimizerAccountIds({
    planByUser: plans({ t: 'trial', s: 'starter' }),
    businesses,
    accounts: [...accountsFor('b1', 4, 't'), ...accountsFor('b2', 4, 's')],
  });
  assert.equal(result.allowedAccountIds.filter((id) => id.startsWith('t')).length, 1);
  assert.equal(result.allowedAccountIds.filter((id) => id.startsWith('s')).length, 3);
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
    planByUser: plans({ u1: 'trial', u2: 'trial' }),
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
  const forward = selectOptimizerAccountIds({ planByUser: plans({ u1: 'starter' }), businesses, accounts });
  const backward = selectOptimizerAccountIds({
    planByUser: plans({ u1: 'starter' }),
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

test('a trial gets 1 whatever its plan, a paid Starter 3, Growth 10 and Pro all of up to 50', async () => {
  const database = world({
    subscriptions: [
      subscriptionRow('trial-pro', { status: 'trialing', trial_ends_at: iso(10 * DAY) }),
      subscriptionRow('trial-starter', { plan: 'starter', status: 'trialing', trial_ends_at: iso(10 * DAY) }),
      subscriptionRow('paid-pro'),
      subscriptionRow('paid-growth', { plan: 'growth' }),
      subscriptionRow('paid-starter', { plan: 'starter' }),
    ],
    accountsPerUser: 12,
  });
  const result = await getOptimizerAllowedAccountIds(database);
  const countFor = (userId: string) => result.allowedAccountIds.filter((id) => id.startsWith(`${userId}-`)).length;
  assert.equal(countFor('trial-pro'), 1);
  assert.equal(countFor('trial-starter'), 1);
  assert.equal(countFor('paid-pro'), 12);
  assert.equal(countFor('paid-growth'), 10);
  assert.equal(countFor('paid-starter'), 3);
  // trial-pro 11 + trial-starter 11 + paid-growth 2 + paid-starter 9
  assert.equal(result.skippedOverPlanCap, 33);
});

test('the helper hands the cron the round-robin cursor of every allowed account', async () => {
  const database = fakeDatabase({
    subscriptions: [subscriptionRow('u1')],
    account_access_overrides: [],
    businesses: [{ id: 'b1', user_id: 'u1', selected_google_ads_customer_id: null }],
    google_ads_accounts: [
      { id: 'fresh', business_id: 'b1', customer_id: '3000000001', status: 'active', is_manager: false, linked_at: '2026-01-01T00:00:00.000Z', last_optimized_at: '2026-10-13T01:00:00.000Z' },
      { id: 'never', business_id: 'b1', customer_id: '3000000002', status: 'active', is_manager: false, linked_at: '2026-01-02T00:00:00.000Z', last_optimized_at: null },
    ],
  });
  const result = await getOptimizerAllowedAccountIds(database);
  assert.deepEqual(
    [...result.allowedAccounts].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'fresh', last_optimized_at: '2026-10-13T01:00:00.000Z', trial_user_id: null },
      { id: 'never', last_optimized_at: null, trial_user_id: null },
    ]
  );
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
    accountsPerUser: 12,
  });
  const result = await getOptimizerAllowedAccountIds(database);
  const countFor = (userId: string) => result.allowedAccountIds.filter((id) => id.startsWith(`${userId}-`)).length;
  assert.equal(countFor('trial-starter'), 12);
  assert.equal(countFor('grant-only'), 10);
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


// ---------------------------------------------------------------------------
// In-memory cooldown / ordering / limit, and batched detail fetch
// ---------------------------------------------------------------------------

const HOUR = 3600 * 1000;
const NOW_MS = Date.parse('2026-10-13T12:00:00.000Z');
const cutoff = new Date(NOW_MS - 12 * HOUR).toISOString();
const at = (hoursAgo: number): string => new Date(NOW_MS - hoursAgo * HOUR).toISOString();

test('pickOptimizerBatch leaves cooled-down accounts out and counts them', () => {
  const accounts: OptimizerAllowedAccount[] = [
    { id: 'recent', last_optimized_at: at(1) },
    { id: 'old', last_optimized_at: at(30) },
    { id: 'never', last_optimized_at: null },
    { id: 'edge', last_optimized_at: cutoff },
  ];
  const result = pickOptimizerBatch({ accounts, cooldownCutoffIso: cutoff, limit: 60 });
  // Exactly at the cutoff is still cooled down (the old filter was strictly "lt").
  assert.deepEqual(result.batchIds, ['never', 'old']);
  assert.equal(result.cooledDownAccounts, 2);
});

test('pickOptimizerBatch with no cutoff (force run) keeps everything and counts no cooldown', () => {
  const accounts: OptimizerAllowedAccount[] = [
    { id: 'recent', last_optimized_at: at(1) },
    { id: 'old', last_optimized_at: at(30) },
  ];
  const result = pickOptimizerBatch({ accounts, cooldownCutoffIso: null, limit: 60 });
  assert.deepEqual(result.batchIds, ['old', 'recent']);
  assert.equal(result.cooledDownAccounts, 0);
});

test('pickOptimizerBatch orders oldest first with never-optimized first and a stable id tie-break', () => {
  const accounts: OptimizerAllowedAccount[] = [
    { id: 'c', last_optimized_at: at(20) },
    { id: 'b', last_optimized_at: at(40) },
    { id: 'z-never', last_optimized_at: null },
    { id: 'a-never', last_optimized_at: null },
    { id: 'a', last_optimized_at: at(20) },
  ];
  const result = pickOptimizerBatch({ accounts, cooldownCutoffIso: cutoff, limit: 60 });
  assert.deepEqual(result.batchIds, ['a-never', 'z-never', 'b', 'a', 'c']);
});

test('pickOptimizerBatch applies the limit after the cooldown, and the cooled-down count ignores the limit', () => {
  const accounts: OptimizerAllowedAccount[] = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `cool${index}`, last_optimized_at: at(2) })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `due${index}`, last_optimized_at: at(24 + index) })),
  ];
  const result = pickOptimizerBatch({ accounts, cooldownCutoffIso: cutoff, limit: 3 });
  // Oldest cursor first: due4 (28h), due3, due2.
  assert.deepEqual(result.batchIds, ['due4', 'due3', 'due2']);
  assert.equal(result.cooledDownAccounts, 5);
});

test('pickOptimizerBatch treats an unreadable cursor as never optimized and a bad cutoff as no cooldown', () => {
  const accounts: OptimizerAllowedAccount[] = [
    { id: 'junk', last_optimized_at: 'not-a-date' },
    { id: 'ok', last_optimized_at: at(1) },
  ];
  assert.deepEqual(pickOptimizerBatch({ accounts, cooldownCutoffIso: cutoff, limit: 10 }).batchIds, ['junk']);
  assert.deepEqual(pickOptimizerBatch({ accounts, cooldownCutoffIso: 'nope', limit: 10 }).batchIds, ['junk', 'ok']);
  assert.deepEqual(pickOptimizerBatch({ accounts: [], cooldownCutoffIso: cutoff, limit: 10 }), {
    batchIds: [],
    cooledDownAccounts: 0,
  });
  assert.deepEqual(pickOptimizerBatch({ accounts, cooldownCutoffIso: null, limit: 0 }).batchIds, []);
});

test('chunkIds never builds a request with more than 60 ids and loses none', () => {
  assert.ok(OPTIMIZER_DETAIL_BATCH_SIZE <= 60);
  const ids = Array.from({ length: 125 }, (_, index) => `id-${index}`);
  const chunks = chunkIds(ids);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [60, 60, 5]);
  assert.deepEqual(chunks.flat(), ids);
  assert.deepEqual(chunkIds([]), []);
  assert.deepEqual(chunkIds(['a']), [['a']]);
});

test('at the Pro cap of 50 per user and many users, the allowed list is big but no request carries it', async () => {
  const users = Array.from({ length: 6 }, (_, index) => `pro-${index}`);
  const database = world({ subscriptions: users.map((userId) => subscriptionRow(userId)), accountsPerUser: 50 });
  const result = await getOptimizerAllowedAccountIds(database);
  assert.equal(result.allowedAccounts.length, 300);
  // The cron's batch is bounded by the limit, and its requests by the batch size.
  const batch = pickOptimizerBatch({ accounts: result.allowedAccounts, cooldownCutoffIso: cutoff, limit: 100 });
  assert.equal(batch.batchIds.length, 100);
  assert.ok(chunkIds(batch.batchIds).every((chunk) => chunk.length <= 60));
});

test('the optimize cron no longer sends the allowed list in one .in(id) and fetches details in batches', () => {
  const source = readFileSync(new URL('../app/api/cron/optimize/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.in\('id', allowedAccountIds\)/);
  assert.doesNotMatch(source, /allowedAccountIds/);
  assert.match(source, /pickOptimizerBatch\(/);
  assert.match(source, /chunkIds\(batchIds, OPTIMIZER_DETAIL_BATCH_SIZE\)/);
  assert.match(source, /\.in\('id', idBatch\)/);
  // The Supabase side no longer filters on the cursor: it is decided in memory.
  assert.doesNotMatch(source, /last_optimized_at\.is\.null/);
  assert.doesNotMatch(source, /\.gte\('last_optimized_at'/);
});

// ---------------------------------------------------------------------------
// The billing page line
// ---------------------------------------------------------------------------

test('the plan card line has the right Arabic number agreement and no dash', () => {
  assert.equal(optimizerAccountsLine(1), 'الخطة اليومية التلقائية لحساب واحد');
  assert.equal(optimizerAccountsLine(3), 'الخطة اليومية التلقائية لحد 3 حسابات');
  assert.equal(optimizerAccountsLine(10), 'الخطة اليومية التلقائية لحد 10 حسابات');
  assert.equal(optimizerAccountsLine(50), 'الخطة اليومية التلقائية لحد 50 حساب');
  for (const count of [1, 2, 3, 10, 11, 50]) assert.doesNotMatch(optimizerAccountsLine(count), /[\u2013\u2014]/);
});

test('every plan card on the billing page carries its optimizer line, and the home page does not', () => {
  const billing = readFileSync(new URL('../app/(dashboard)/billing/page.tsx', import.meta.url), 'utf8');
  for (const plan of ['starter', 'growth', 'pro'] as const) {
    assert.ok(
      billing.includes(`optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.${plan})`),
      `${plan} card shows its optimizer line`
    );
  }
  const home = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(home, /الخطة اليومية التلقائية|optimizerAccountsLine/);
  // The numbers shown are the numbers enforced.
  assert.equal(optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.starter), 'الخطة اليومية التلقائية لحد 3 حسابات');
  assert.equal(optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.growth), 'الخطة اليومية التلقائية لحد 10 حسابات');
  assert.equal(optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.pro), 'الخطة اليومية التلقائية لحد 50 حساب');
});

test('only the accounts of users on a Stripe trial carry a trial owner, so only they are claimed', async () => {
  const database = world({
    subscriptions: [
      subscriptionRow('trial-user', { status: 'trialing', trial_ends_at: iso(10 * DAY) }),
      subscriptionRow('paid-user'),
      subscriptionRow('granted-trial', { status: 'trialing', trial_ends_at: iso(10 * DAY) }),
    ],
    overrides: [
      // An operator grant on top of a trial is "comp", not a trial.
      { user_id: 'granted-trial', kind: 'plan_grant', plan: 'pro', expires_at: null, created_at: iso(-DAY), revoked_at: null },
    ],
    accountsPerUser: 3,
  });
  const result = await getOptimizerAllowedAccountIds(database);
  const ownerOf = (id: string) => result.allowedAccounts.find((account) => account.id === id)?.trial_user_id;
  assert.equal(result.allowedAccounts.filter((a) => a.trial_user_id === 'trial-user').length, 1, 'the trial cap of 1 applies');
  assert.equal(ownerOf('trial-user-acc1'), 'trial-user');
  assert.equal(ownerOf('paid-user-acc1'), null);
  assert.equal(ownerOf('paid-user-acc3'), null);
  assert.equal(ownerOf('granted-trial-acc1'), null);
});

test('trialClaimsForBatch claims only trial users\' accounts, with the customer id as digits', () => {
  const allowed: OptimizerAllowedAccount[] = [
    { id: 'a1', last_optimized_at: null, trial_user_id: 'trial-user' },
    { id: 'a2', last_optimized_at: null, trial_user_id: null },
    { id: 'a3', last_optimized_at: null },
    { id: 'a4', last_optimized_at: null, trial_user_id: 'trial-user' },
  ];
  const claims = trialClaimsForBatch(allowed, [
    { id: 'a1', customer_id: '123-456-7890' },
    { id: 'a2', customer_id: '2222222222' },
    { id: 'a3', customer_id: '3333333333' },
    { id: 'a4', customer_id: null },
    { id: 'unknown', customer_id: '5555555555' },
  ]);
  assert.deepEqual(claims, [{ userId: 'trial-user', customerId: '1234567890' }]);
  assert.deepEqual(trialClaimsForBatch([], [{ id: 'a1', customer_id: '1111111111' }]), []);
});
