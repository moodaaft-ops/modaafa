import assert from 'node:assert/strict';
import test from 'node:test';

import { enforceTrialAccountLock } from '../lib/billing/trial-account-lock';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const DAY = 24 * 3600 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Row = Record<string, any>;

/** Tables the lock reads and writes, behind a PostgREST-shaped fake. */
function fakeAdmin(world: {
  subscriptions?: Row[];
  overrides?: Row[];
  ledger?: Record<string, string>;
  failLedgerRead?: boolean | { code?: string; message: string };
  failPause?: boolean;
}) {
  const ledger = new Map(Object.entries(world.ledger ?? {}));
  const accountPatches: Array<{ ids: string[]; patch: Row }> = [];
  const ledgerWrites: Row[][] = [];
  const admin = {
    ledger,
    accountPatches,
    ledgerWrites,
    from(table: string) {
      let filterIds: string[] | null = null;
      let patch: Row | null = null;
      const rowsFor = () => {
        if (table === 'subscriptions') return world.subscriptions ?? [];
        if (table === 'account_access_overrides') return world.overrides ?? [];
        return [];
      };
      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        in: (_column: string, values: string[]) => {
          filterIds = values;
          return chain;
        },
        update: (value: Row) => {
          patch = value;
          return chain;
        },
        upsert: (rows: Row[]) => {
          ledgerWrites.push(rows);
          for (const row of rows) if (!ledger.has(row.customer_id)) ledger.set(row.customer_id, row.first_user_id);
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          let result: { data: unknown; error: unknown };
          if (table === 'google_ads_accounts' && patch) {
            if (world.failPause) result = { data: null, error: { message: 'update failed' } };
            else {
              accountPatches.push({ ids: filterIds ?? [], patch });
              result = { data: null, error: null };
            }
          } else if (table === 'trial_customer_ledger') {
            if (world.failLedgerRead) {
              result = {
                data: null,
                error: typeof world.failLedgerRead === 'object' ? world.failLedgerRead : { message: 'ledger down' },
              };
            }
            else {
              result = {
                data: (filterIds ?? [])
                  .filter((id) => ledger.has(id))
                  .map((customer_id) => ({ customer_id, first_user_id: ledger.get(customer_id) })),
                error: null,
              };
            }
          } else {
            result = { data: rowsFor(), error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return admin;
}

const trialing = (overrides: Row = {}) => ({
  plan: 'pro',
  status: 'trialing',
  trial_ends_at: iso(10 * DAY),
  current_period_start: iso(-4 * DAY),
  current_period_end: iso(10 * DAY),
  created_at: iso(-4 * DAY),
  ...overrides,
});

const paying = () => trialing({ status: 'active', trial_ends_at: null, current_period_end: iso(25 * DAY) });

const linked = [
  { id: 'acc-1', customer_id: '1111111111' },
  { id: 'acc-2', customer_id: '222-222-2222' },
];

async function quietly<T>(run: () => Promise<T>) {
  const originalError = console.error;
  const originalWarn = console.warn;
  const logs: { error: unknown[][]; warn: unknown[][] } = { error: [], warn: [] };
  console.error = (...args: unknown[]) => void logs.error.push(args);
  console.warn = (...args: unknown[]) => void logs.warn.push(args);
  try {
    return { value: await run(), logs };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

test("a trialing user's newly linked account owned by another user's trial is paused and logged", async () => {
  const admin = fakeAdmin({ subscriptions: [trialing()], ledger: { '2222222222': OTHER } });
  const { value, logs } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
  assert.deepEqual(value.pausedAccountIds, ['acc-2']);
  assert.deepEqual(admin.accountPatches, [{ ids: ['acc-2'], patch: { status: 'paused' } }]);
  assert.equal(logs.warn.length, 1);
  assert.deepEqual((logs.warn[0][1] as any).customerIds, ['2222222222']);
});

test('accounts nobody has trialed on are left active and recorded for this user', async () => {
  const admin = fakeAdmin({ subscriptions: [trialing()], ledger: { '2222222222': OTHER } });
  await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
  assert.equal(admin.ledger.get('1111111111'), USER);
  assert.equal(admin.ledger.get('2222222222'), OTHER, 'the other user keeps their account');
  assert.deepEqual(admin.ledgerWrites[0], [
    { customer_id: '1111111111', first_user_id: USER, source: 'connect_during_trial' },
  ]);
});

test("the user's own earlier trial account is not paused", async () => {
  const admin = fakeAdmin({ subscriptions: [trialing()], ledger: { '1111111111': USER, '2222222222': USER } });
  const { value } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
  assert.deepEqual(value.pausedAccountIds, []);
  assert.deepEqual(admin.accountPatches, []);
});

test('a paying user, a user with no subscription and an expired trial are not touched', async () => {
  for (const subscriptions of [[paying()], [], [trialing({ trial_ends_at: iso(-DAY) })]]) {
    const admin = fakeAdmin({ subscriptions, ledger: { '2222222222': OTHER } });
    const { value } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
    assert.deepEqual(value.pausedAccountIds, []);
    assert.deepEqual(admin.accountPatches, []);
    assert.deepEqual(admin.ledgerWrites, []);
  }
});

test('an operator free-plan grant exempts the trial from the lock', async () => {
  const admin = fakeAdmin({
    subscriptions: [trialing()],
    overrides: [{ kind: 'plan_grant', plan: 'pro', expires_at: null, created_at: iso(-DAY), revoked_at: null }],
    ledger: { '2222222222': OTHER },
  });
  const { value } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
  assert.deepEqual(value.pausedAccountIds, []);
  assert.deepEqual(admin.accountPatches, []);
});

test('a ledger read failure leaves the accounts linked and logs', async () => {
  const admin = fakeAdmin({ subscriptions: [trialing()], ledger: { '2222222222': OTHER }, failLedgerRead: true });
  const { value, logs } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
  assert.deepEqual(value.pausedAccountIds, []);
  assert.equal(logs.error.length, 1);
});

test('a failed pause write is not reported as paused', async () => {
  const admin = fakeAdmin({ subscriptions: [trialing()], ledger: { '2222222222': OTHER }, failPause: true });
  const { value, logs } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
  assert.deepEqual(value.pausedAccountIds, []);
  assert.equal(logs.error.length, 1);
});

test('nothing linked means nothing to check', async () => {
  const admin = fakeAdmin({ subscriptions: [trialing()] });
  const { value } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked: [] }));
  assert.deepEqual(value.pausedAccountIds, []);
});

// Deploy order: a missing trial_customer_ledger (code shipped before the migration) must
// leave the connect flow untouched, exactly like any other ledger failure.
test('a missing trial_customer_ledger table leaves the accounts linked and logs', async () => {
  for (const failLedgerRead of [
    { code: '42P01', message: 'relation "public.trial_customer_ledger" does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.trial_customer_ledger' in the schema cache" },
  ]) {
    const admin = fakeAdmin({ subscriptions: [trialing()], failLedgerRead });
    const { value, logs } = await quietly(() => enforceTrialAccountLock({ admin, userId: USER, linked }));
    assert.deepEqual(value.pausedAccountIds, []);
    assert.equal(admin.accountPatches.length, 0);
    assert.equal(logs.error.length, 1);
  }
});
