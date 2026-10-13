import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enforceTrialStartAccountLock,
} from '../lib/billing/trial-start-account-lock';
import type { TrialCardStripe, TrialCardSubscription } from '../lib/billing/trial-card-guard';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const THIRD = '33333333-3333-3333-3333-333333333333';
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const FUTURE = Math.floor(NOW / 1000) + 14 * 24 * 3600;
const PAST = Math.floor(NOW / 1000) - 3600;

type Account = {
  id: string;
  business_id: string;
  customer_id: string;
  status: string;
  is_manager?: boolean | null;
  linked_at: string | null;
};
type Business = { id: string; user_id: string; selected_google_ads_customer_id?: string | null };
type World = {
  businesses: Business[];
  accounts: Account[];
  /** customer_id -> first_user_id */
  ledger?: Record<string, string>;
  failTable?: Partial<Record<'businesses' | 'google_ads_accounts' | 'trial_customer_ledger:read' | 'trial_customer_ledger:write' | 'google_ads_accounts:update', { code?: string; message: string }>>;
};

/** A stateful PostgREST-shaped fake of the four tables the start lock touches. */
function fakeAdmin(world: World) {
  const ledger = new Map(Object.entries(world.ledger ?? {}));
  const ledgerWrites: Array<Record<string, unknown>[]> = [];
  const patches: Array<{ ids: string[]; patch: Record<string, unknown> }> = [];
  return {
    ledger,
    ledgerWrites,
    patches,
    accounts: world.accounts,
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      let upsertRows: Array<Record<string, any>> | null = null;
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => (filters.push([column, [value]]), chain),
        in: (column: string, values: unknown[]) => (filters.push([column, values]), chain),
        not: () => chain,
        limit: () => chain,
        update: (value: Record<string, unknown>) => ((patch = value), chain),
        upsert: (rows: Array<Record<string, any>>, options: any) => {
          assert.deepEqual(options, { onConflict: 'customer_id', ignoreDuplicates: true });
          upsertRows = rows;
          return chain;
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const matches = (row: Record<string, any>) =>
            filters.every(([column, values]) => (values as unknown[]).includes(row[column]));
          let result: { data: unknown; error: unknown };
          if (table === 'businesses') {
            result = world.failTable?.businesses
              ? { data: null, error: world.failTable.businesses }
              : { data: world.businesses.filter(matches), error: null };
          } else if (table === 'google_ads_accounts' && patch) {
            if (world.failTable?.['google_ads_accounts:update']) {
              result = { data: null, error: world.failTable['google_ads_accounts:update'] };
            } else {
              const ids = (filters.find(([column]) => column === 'id')?.[1] as string[]) ?? [];
              for (const account of world.accounts) if (ids.includes(account.id)) Object.assign(account, patch);
              patches.push({ ids, patch });
              result = { data: null, error: null };
            }
          } else if (table === 'google_ads_accounts') {
            result = world.failTable?.google_ads_accounts
              ? { data: null, error: world.failTable.google_ads_accounts }
              : { data: world.accounts.filter(matches).filter((row) => row.is_manager !== true), error: null };
          } else if (table === 'trial_customer_ledger' && upsertRows) {
            if (world.failTable?.['trial_customer_ledger:write']) {
              result = { data: null, error: world.failTable['trial_customer_ledger:write'] };
            } else {
              ledgerWrites.push(upsertRows);
              for (const row of upsertRows) if (!ledger.has(row.customer_id)) ledger.set(row.customer_id, row.first_user_id);
              result = { data: null, error: null };
            }
          } else if (table === 'trial_customer_ledger') {
            if (world.failTable?.['trial_customer_ledger:read']) {
              result = { data: null, error: world.failTable['trial_customer_ledger:read'] };
            } else {
              const ids = (filters.find(([column]) => column === 'customer_id')?.[1] as string[]) ?? [];
              result = {
                data: ids.filter((id) => ledger.has(id)).map((customer_id) => ({ customer_id, first_user_id: ledger.get(customer_id) })),
                error: null,
              };
            }
          } else {
            result = { data: [], error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

function fakeStripe(options: { cancelFails?: boolean; liveStatusAfterFailure?: string } = {}) {
  const cancelled: string[] = [];
  const stripe: TrialCardStripe = {
    async retrievePaymentMethod() {
      return null;
    },
    async retrieveCustomer() {
      return null;
    },
    async retrieveSubscription() {
      return { status: options.liveStatusAfterFailure ?? 'trialing' };
    },
    async cancelSubscription(id) {
      if (options.cancelFails) throw new Error('stripe down');
      cancelled.push(id);
      return { id, status: 'canceled' };
    },
  };
  return { stripe, cancelled };
}

const trialing = (overrides: Partial<TrialCardSubscription> = {}): TrialCardSubscription => ({
  id: 'sub_1',
  status: 'trialing',
  trial_end: FUTURE,
  customer: 'cus_1',
  ...overrides,
});

const account = (id: string, customerId: string, extra: Partial<Account> = {}): Account => ({
  id,
  business_id: 'b-user',
  customer_id: customerId,
  status: 'active',
  is_manager: false,
  linked_at: '2026-10-01T00:00:00.000Z',
  ...extra,
});

async function quietly<T>(run: () => Promise<T>) {
  const originalError = console.error;
  const originalWarn = console.warn;
  const logs = { error: [] as unknown[][], warn: [] as unknown[][] };
  console.error = (...args: unknown[]) => void logs.error.push(args);
  console.warn = (...args: unknown[]) => void logs.warn.push(args);
  try {
    return { value: await run(), logs };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

const run = (admin: ReturnType<typeof fakeAdmin>, stripe: TrialCardStripe, subscription = trialing(), userId = USER) =>
  quietly(() => enforceTrialStartAccountLock({ stripe, admin, userId, subscription, now: NOW }));

const oneBusiness = (selected: string | null = null): Business[] => [
  { id: 'b-user', user_id: USER, selected_google_ads_customer_id: selected },
];

// ---------------------------------------------------------------------------
// The reviewed bypass
// ---------------------------------------------------------------------------

test('open Checkout with a throwaway account, link a burned one before paying: the burned one is parked, the throwaway is claimed', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [
      account('throwaway', '1111111111', { linked_at: '2026-10-13T08:00:00.000Z' }),
      account('burned', '9999999999', { linked_at: '2026-10-13T09:00:00.000Z' }),
    ],
    ledger: { '9999999999': OTHER },
  });
  const { stripe, cancelled } = fakeStripe();
  const { value } = await run(admin, stripe);

  assert.equal(value.blocked, false);
  assert.equal(value.outcome, 'paused_others');
  assert.deepEqual(value.pausedAccountIds, ['burned']);
  assert.equal(value.claimedCustomerId, '1111111111');
  assert.equal(admin.accounts.find((a) => a.id === 'burned')!.status, 'paused');
  assert.equal(admin.accounts.find((a) => a.id === 'throwaway')!.status, 'active');
  assert.equal(admin.ledger.get('1111111111'), USER, 'the trial is recorded against the account it runs on');
  assert.equal(admin.ledger.get('9999999999'), OTHER, 'the other user keeps the burned account');
  assert.deepEqual(cancelled, []);
});

test('only a burned account is left: the subscription is cancelled immediately and the account parked', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('burned', '9999999999')],
    ledger: { '9999999999': OTHER },
  });
  const { stripe, cancelled } = fakeStripe();
  const { value, logs } = await run(admin, stripe);

  assert.equal(value.blocked, true);
  assert.equal(value.outcome, 'blocked');
  assert.deepEqual(cancelled, ['sub_1']);
  assert.deepEqual(value.pausedAccountIds, ['burned']);
  assert.equal(admin.accounts[0].status, 'paused');
  assert.equal(admin.ledger.size, 1, 'nothing is claimed for a trial that did not start');
  assert.ok(logs.warn.length >= 1);
});

test('every account burned by different users is also a cancel', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('a', '1000000001'), account('b', '1000000002')],
    ledger: { '1000000001': OTHER, '1000000002': THIRD },
  });
  const { stripe, cancelled } = fakeStripe();
  const { value } = await run(admin, stripe);
  assert.equal(value.blocked, true);
  assert.deepEqual(cancelled, ['sub_1']);
  assert.deepEqual(admin.patches[0].ids.sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// What gets claimed
// ---------------------------------------------------------------------------

test('the selected account is the one claimed, even when it was linked last', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness('2000000003'),
    accounts: [
      account('old', '2000000001', { linked_at: '2026-01-01T00:00:00.000Z' }),
      account('mid', '2000000002', { linked_at: '2026-02-01T00:00:00.000Z' }),
      account('picked', '2000000003', { linked_at: '2026-03-01T00:00:00.000Z' }),
    ],
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.outcome, 'claimed');
  assert.equal(value.claimedCustomerId, '2000000003');
  assert.deepEqual([...admin.ledger.keys()], ['2000000003'], 'only the used account, not all three');
  assert.deepEqual(admin.ledger.get('2000000003'), USER);
  assert.deepEqual(admin.ledgerWrites[0], [{ customer_id: '2000000003', first_user_id: USER, source: 'trial_start' }]);
});

test('a selected id stored with dashes still matches', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness('200-000-0002'),
    accounts: [account('a', '2000000001'), account('b', '2000000002')],
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.claimedCustomerId, '2000000002');
});

test('with no selected account the oldest link is claimed, then the id breaks ties', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(null),
    accounts: [
      account('z', '3000000003', { linked_at: '2026-03-01T00:00:00.000Z' }),
      account('m', '3000000002', { linked_at: '2026-01-01T00:00:00.000Z' }),
      account('c', '3000000001', { linked_at: '2026-01-01T00:00:00.000Z' }),
    ],
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.claimedCustomerId, '3000000001');
  assert.deepEqual([...admin.ledger.keys()], ['3000000001']);
});

test('a selected account owned by another user is parked and the next account is claimed instead', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness('4000000001'),
    accounts: [
      account('burned', '4000000001', { linked_at: '2026-05-01T00:00:00.000Z' }),
      account('fresh', '4000000002', { linked_at: '2026-06-01T00:00:00.000Z' }),
    ],
    ledger: { '4000000001': OTHER },
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.blocked, false);
  assert.equal(value.claimedCustomerId, '4000000002');
  assert.deepEqual(value.pausedAccountIds, ['burned']);
});

test('manager accounts, revoked links and invitations are never candidates', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [
      account('mcc', '5000000001', { is_manager: true }),
      account('revoked', '5000000002', { status: 'revoked' }),
      account('invite', '5000000003', { status: 'invitation_pending' }),
      account('real', '5000000004'),
    ],
    ledger: { '5000000001': OTHER, '5000000002': OTHER, '5000000003': OTHER },
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.blocked, false);
  assert.equal(value.claimedCustomerId, '5000000004');
  assert.deepEqual(value.pausedAccountIds, []);
});

test('the same customer id linked in two businesses is claimed once', async () => {
  const admin = fakeAdmin({
    businesses: [
      { id: 'b-user', user_id: USER },
      { id: 'b-second', user_id: USER },
    ],
    accounts: [account('one', '6000000001'), account('two', '6000000001', { business_id: 'b-second' })],
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.claimedCustomerId, '6000000001');
  assert.equal(admin.ledgerWrites.length, 1);
});

// ---------------------------------------------------------------------------
// Idempotence and the race
// ---------------------------------------------------------------------------

test('replaying the same event changes nothing after a successful claim', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('throwaway', '1111111111'), account('burned', '9999999999')],
    ledger: { '9999999999': OTHER },
  });
  const { stripe, cancelled } = fakeStripe();
  const first = (await run(admin, stripe)).value;
  const second = (await run(admin, stripe)).value;
  assert.equal(first.blocked, false);
  assert.equal(second.blocked, false);
  assert.equal(second.claimedCustomerId, '1111111111');
  assert.deepEqual(second.pausedAccountIds, [], 'already parked, nothing new to park');
  assert.equal(admin.ledger.size, 2);
  assert.deepEqual(cancelled, []);
});

test('replaying a blocked event cancels again without error and keeps the account parked', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('burned', '9999999999')],
    ledger: { '9999999999': OTHER },
  });
  const { stripe, cancelled } = fakeStripe();
  const first = (await run(admin, stripe)).value;
  assert.equal(first.blocked, true);
  // The account is paused now, but still belongs to the other user's trial.
  const replay = (await run(admin, stripe)).value;
  assert.equal(replay.blocked, true, 'a replay reaches the same decision');
  assert.deepEqual(cancelled, ['sub_1', 'sub_1']);
  assert.equal(admin.accounts[0].status, 'paused');
});

test('a cancel that fails because the subscription is already cancelled still counts as blocked', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('burned', '9999999999')],
    ledger: { '9999999999': OTHER },
  });
  const { stripe } = fakeStripe({ cancelFails: true, liveStatusAfterFailure: 'canceled' });
  const { value } = await run(admin, stripe);
  assert.equal(value.blocked, true);
});

test('a cancel that fails while the subscription is still live is thrown so the webhook retries', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('burned', '9999999999')],
    ledger: { '9999999999': OTHER },
  });
  const { stripe } = fakeStripe({ cancelFails: true });
  await assert.rejects(run(admin, stripe), /stripe down/);
});

test('two users racing on one fresh account: exactly one keeps it and the other is blocked', async () => {
  const ledger: Record<string, string> = {};
  const businesses: Business[] = [
    { id: 'b-a', user_id: USER },
    { id: 'b-b', user_id: OTHER },
  ];
  const accounts = [
    account('a-acc', '7000000001', { business_id: 'b-a' }),
    account('b-acc', '7000000001', { business_id: 'b-b' }),
  ];
  const shared = fakeAdmin({ businesses, accounts, ledger });
  const [first, second] = await Promise.all([
    run(shared, fakeStripe().stripe, trialing({ id: 'sub_a' }), USER),
    run(shared, fakeStripe().stripe, trialing({ id: 'sub_b' }), OTHER),
  ]);
  const blocked = [first.value.blocked, second.value.blocked].sort();
  assert.deepEqual(blocked, [false, true]);
  const winner = shared.ledger.get('7000000001');
  const loser = winner === USER ? OTHER : USER;
  const loserAccount = loser === USER ? 'a-acc' : 'b-acc';
  assert.equal(shared.accounts.find((a) => a.id === loserAccount)!.status, 'paused');
});

test('the loser of a claim race moves on to the next account and is not blocked', async () => {
  // The pre-read sees both accounts free; the other user's claim lands between
  // the pre-read and ours, so the first insert loses and the second wins.
  const admin = fakeAdmin({
    businesses: oneBusiness('8000000001'),
    accounts: [
      account('contested', '8000000001'),
      account('spare', '8000000002', { linked_at: '2026-10-02T00:00:00.000Z' }),
    ],
  });
  const realFrom = admin.from.bind(admin);
  let reads = 0;
  admin.from = (table: string) => {
    const chain = realFrom(table);
    if (table === 'trial_customer_ledger') {
      const realThen = chain.then;
      chain.then = (resolve: any, reject: any) => {
        reads += 1;
        // After the first read (the pre-read), the other user claims the contested id.
        if (reads === 2) admin.ledger.set('8000000001', OTHER);
        return realThen(resolve, reject);
      };
    }
    return chain;
  };
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.blocked, false);
  assert.equal(value.claimedCustomerId, '8000000002');
  assert.deepEqual(value.pausedAccountIds, ['contested']);
});

// ---------------------------------------------------------------------------
// Not a live trial, nothing to look at
// ---------------------------------------------------------------------------

test('only a live trial is checked: an active, canceled or expired-trial subscription is left alone', async () => {
  for (const subscription of [
    trialing({ status: 'active' }),
    trialing({ status: 'canceled' }),
    trialing({ trial_end: PAST }),
    trialing({ trial_end: null }),
  ]) {
    const admin = fakeAdmin({
      businesses: oneBusiness(),
      accounts: [account('burned', '9999999999')],
      ledger: { '9999999999': OTHER },
    });
    const { stripe, cancelled } = fakeStripe();
    const { value } = await run(admin, stripe, subscription);
    assert.equal(value.outcome, 'not_trialing');
    assert.equal(value.blocked, false);
    assert.deepEqual(cancelled, []);
    assert.equal(admin.accounts[0].status, 'active');
    assert.equal(admin.ledger.size, 1);
  }
});

test('a user with no accounts at all is not an abuse signal: nothing is cancelled or claimed', async () => {
  for (const world of [
    { businesses: [], accounts: [] },
    { businesses: oneBusiness(), accounts: [] },
    { businesses: oneBusiness(), accounts: [account('closed', '1212121212', { status: 'paused' })] },
  ]) {
    const admin = fakeAdmin(world);
    const { stripe, cancelled } = fakeStripe();
    const { value } = await run(admin, stripe);
    assert.equal(value.blocked, false);
    assert.equal(value.outcome, 'no_accounts');
    assert.deepEqual(cancelled, []);
    assert.equal(admin.ledger.size, 0);
  }
});

test('a user whose own earlier trial owns the account is not blocked by it', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('mine', '1313131313')],
    ledger: { '1313131313': USER },
  });
  const { value } = await run(admin, fakeStripe().stripe);
  assert.equal(value.blocked, false);
  assert.equal(value.claimedCustomerId, '1313131313');
});

// ---------------------------------------------------------------------------
// Failure semantics
// ---------------------------------------------------------------------------

test('a lookup failure allows the trial (fail open) and logs', async () => {
  for (const failTable of [
    { businesses: { message: 'db down' } },
    { google_ads_accounts: { message: 'db down' } },
    { 'trial_customer_ledger:read': { message: 'db down' } },
    { 'trial_customer_ledger:write': { message: 'db down' } },
  ] as World['failTable'][]) {
    const admin = fakeAdmin({
      businesses: oneBusiness(),
      accounts: [account('burned', '9999999999'), account('fresh', '1010101010')],
      ledger: { '9999999999': OTHER },
      failTable,
    });
    const { stripe, cancelled } = fakeStripe();
    const { value, logs } = await run(admin, stripe);
    assert.equal(value.blocked, false, JSON.stringify(failTable));
    assert.equal(value.outcome, 'lookup_failed');
    assert.deepEqual(cancelled, []);
    assert.equal(logs.error.length, 1);
  }
});

test('a missing trial_customer_ledger table (code deployed before the migration) allows the trial and says so loudly', async () => {
  for (const error of [
    { code: '42P01', message: 'relation "public.trial_customer_ledger" does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.trial_customer_ledger' in the schema cache" },
  ]) {
    const admin = fakeAdmin({
      businesses: oneBusiness(),
      accounts: [account('a', '9999999999')],
      failTable: { 'trial_customer_ledger:read': error },
    });
    const { stripe, cancelled } = fakeStripe();
    const { value, logs } = await run(admin, stripe);
    assert.equal(value.blocked, false);
    assert.equal(value.outcome, 'table_missing');
    assert.deepEqual(cancelled, []);
    assert.match(String(logs.error[0][0]), /DEPLOY ORDER/);
  }
});

test('a failed pause write never stops the cancel', async () => {
  const admin = fakeAdmin({
    businesses: oneBusiness(),
    accounts: [account('burned', '9999999999')],
    ledger: { '9999999999': OTHER },
    failTable: { 'google_ads_accounts:update': { message: 'update failed' } },
  });
  const { stripe, cancelled } = fakeStripe();
  const { value, logs } = await run(admin, stripe);
  assert.equal(value.blocked, true);
  assert.deepEqual(cancelled, ['sub_1']);
  assert.deepEqual(value.pausedAccountIds, [], 'not reported as parked when the write failed');
  assert.ok(logs.error.length >= 1);
});
