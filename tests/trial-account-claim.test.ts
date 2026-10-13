import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  claimTrialAccountIfTrialing,
  claimTrialAccountsInUse,
  claimTrialCustomerIds,
} from '../lib/billing/trial-account-claim';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const DAY = 24 * 3600 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

type Row = Record<string, any>;

function fakeAdmin(world: {
  ledger?: Record<string, string>;
  subscriptions?: Row[];
  overrides?: Row[];
  failWrite?: { code?: string; message: string };
}) {
  const ledger = new Map(Object.entries(world.ledger ?? {}));
  const writes: Array<{ rows: Row[]; options: unknown }> = [];
  return {
    ledger,
    writes,
    from(table: string) {
      let ids: string[] = [];
      let upserted: { rows: Row[]; options: unknown } | null = null;
      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        in: (_column: string, values: string[]) => ((ids = values), chain),
        upsert: (rows: Row[], options: unknown) => ((upserted = { rows, options }), chain),
        then: (resolve: any, reject: any) => {
          let result: { data: unknown; error: unknown };
          if (table === 'trial_customer_ledger' && upserted) {
            if (world.failWrite) result = { data: null, error: world.failWrite };
            else {
              writes.push(upserted);
              for (const row of upserted.rows) if (!ledger.has(row.customer_id)) ledger.set(row.customer_id, row.first_user_id);
              result = { data: null, error: null };
            }
          } else if (table === 'trial_customer_ledger') {
            result = {
              data: ids.filter((id) => ledger.has(id)).map((customer_id) => ({ customer_id, first_user_id: ledger.get(customer_id) })),
              error: null,
            };
          } else if (table === 'subscriptions') {
            result = { data: world.subscriptions ?? [], error: null };
          } else if (table === 'account_access_overrides') {
            result = { data: world.overrides ?? [], error: null };
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

const trialingSub = (extra: Row = {}) => ({
  user_id: USER,
  plan: 'growth',
  status: 'trialing',
  trial_ends_at: iso(10 * DAY),
  current_period_start: iso(-4 * DAY),
  current_period_end: iso(10 * DAY),
  ...extra,
});
const payingSub = () => ({
  user_id: USER,
  plan: 'growth',
  status: 'active',
  trial_ends_at: iso(-20 * DAY),
  current_period_start: iso(-5 * DAY),
  current_period_end: iso(25 * DAY),
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

// ---------------------------------------------------------------------------
// claimTrialCustomerIds
// ---------------------------------------------------------------------------

test('claim inserts with on-conflict-do-nothing and reports who else owns what', async () => {
  const admin = fakeAdmin({ ledger: { '2222222222': OTHER } });
  const result = await claimTrialCustomerIds({
    admin,
    userId: USER,
    customerIds: ['111-111-1111', '2222222222', '1111111111', 'junk', '12'],
    source: 'audit_during_trial',
  });
  assert.deepEqual(result.ownedByOthers, ['2222222222']);
  assert.deepEqual(admin.writes[0].options, { onConflict: 'customer_id', ignoreDuplicates: true });
  assert.deepEqual(
    admin.writes[0].rows.map((row) => row.customer_id),
    ['1111111111', '2222222222'],
    'normalised, de-duplicated, junk and too-short ids dropped'
  );
  assert.equal(admin.ledger.get('1111111111'), USER);
  assert.equal(admin.ledger.get('2222222222'), OTHER, 'the first owner keeps it');
});

test('claim with nothing valid writes nothing', async () => {
  const admin = fakeAdmin({});
  assert.deepEqual(await claimTrialCustomerIds({ admin, userId: USER, customerIds: [], source: 'x' }), { ownedByOthers: [] });
  assert.deepEqual(await claimTrialCustomerIds({ admin, userId: USER, customerIds: ['abc'], source: 'x' }), { ownedByOthers: [] });
  assert.equal(admin.writes.length, 0);
});

// ---------------------------------------------------------------------------
// claimTrialAccountsInUse (optimizer)
// ---------------------------------------------------------------------------

test('use-time claims are grouped per user and report accounts another user owns', async () => {
  const admin = fakeAdmin({ ledger: { '3333333333': OTHER } });
  const { value } = await quietly(() =>
    claimTrialAccountsInUse({
      admin,
      claims: [
        { userId: USER, customerId: '1111111111' },
        { userId: USER, customerId: '3333333333' },
        { userId: OTHER, customerId: '4444444444' },
      ],
      source: 'optimizer_during_trial',
    })
  );
  assert.deepEqual(value.ownedByOthers, [{ userId: USER, customerId: '3333333333' }]);
  assert.equal(admin.ledger.get('1111111111'), USER);
  assert.equal(admin.ledger.get('4444444444'), OTHER);
  assert.equal(admin.writes.length, 2, 'one write per user');
});

test('use-time claims never throw: a ledger error is logged, a missing table is logged as a deploy-order problem', async () => {
  for (const [failWrite, expected] of [
    [{ message: 'db down' }, /Failed to record/],
    [{ code: '42P01', message: 'relation "public.trial_customer_ledger" does not exist' }, /DEPLOY ORDER/],
    [{ code: 'PGRST205', message: "Could not find the table 'public.trial_customer_ledger' in the schema cache" }, /DEPLOY ORDER/],
  ] as const) {
    const admin = fakeAdmin({ failWrite });
    const { value, logs } = await quietly(() =>
      claimTrialAccountsInUse({ admin, claims: [{ userId: USER, customerId: '1111111111' }], source: 's' })
    );
    assert.deepEqual(value.ownedByOthers, []);
    assert.equal(logs.error.length, 1);
    assert.match(String(logs.error[0][0]), expected);
  }
});

// ---------------------------------------------------------------------------
// claimTrialAccountIfTrialing (audit)
// ---------------------------------------------------------------------------

test('an audit by a trialing user claims the audited account', async () => {
  const admin = fakeAdmin({ subscriptions: [trialingSub()] });
  const { value } = await quietly(() =>
    claimTrialAccountIfTrialing({ admin, userId: USER, customerId: '1111111111', source: 'audit_during_trial' })
  );
  assert.equal(value.claimed, true);
  assert.equal(admin.ledger.get('1111111111'), USER);
  assert.equal(admin.writes[0].rows[0].source, 'audit_during_trial');
});

test('an audit by a paying user, a user with no subscription or an expired trial claims nothing', async () => {
  for (const subscriptions of [[payingSub()], [], [trialingSub({ trial_ends_at: iso(-DAY) })]]) {
    const admin = fakeAdmin({ subscriptions });
    const { value } = await quietly(() =>
      claimTrialAccountIfTrialing({ admin, userId: USER, customerId: '1111111111', source: 's' })
    );
    assert.equal(value.claimed, false);
    assert.equal(admin.ledger.size, 0);
  }
});

test('an operator free-plan grant means the user is not on a trial: nothing is claimed', async () => {
  const admin = fakeAdmin({
    subscriptions: [trialingSub()],
    overrides: [{ kind: 'plan_grant', plan: 'pro', expires_at: null, created_at: iso(-DAY), revoked_at: null }],
  });
  const { value } = await quietly(() =>
    claimTrialAccountIfTrialing({ admin, userId: USER, customerId: '1111111111', source: 's' })
  );
  assert.equal(value.claimed, false);
  assert.equal(admin.ledger.size, 0);
});

test('a failed claim never breaks the audit', async () => {
  const admin = fakeAdmin({ subscriptions: [trialingSub()], failWrite: { message: 'db down' } });
  const { value } = await quietly(() =>
    claimTrialAccountIfTrialing({ admin, userId: USER, customerId: '1111111111', source: 's' })
  );
  assert.equal(value.claimed, true, 'the attempt was made; the failure was logged and swallowed');
});


// ---------------------------------------------------------------------------
// Where the claims are wired
// ---------------------------------------------------------------------------

test('the optimizer and the audit route claim through the one shared helper, after their own gates', () => {
  const cron = read('app/api/cron/optimize/route.ts');
  assert.match(cron, /claimTrialAccountsInUse\(\{ admin: supabase, claims: trialClaims, source: 'optimizer_during_trial' \}\)/);
  assert.match(cron, /trialClaimsForBatch\(allowedAccounts, accounts\)/);

  const audit = read('app/api/audit/run/route.ts');
  assert.match(audit, /claimTrialAccountIfTrialing\(\{/);
  assert.match(audit, /source: 'audit_during_trial'/);
  // Only after access was granted: a refused audit is not the trial using the account.
  assert.ok(audit.indexOf('if (!usage.ok)') < audit.indexOf('claimTrialAccountIfTrialing({'));
});

test('recordTrialGrant and the link lock no longer touch the customer ledger', () => {
  const policy = read('lib/billing/checkout-policy.ts');
  assert.doesNotMatch(policy, /recordTrialCustomerIds/);
  const lock = read('lib/billing/trial-account-lock.ts');
  assert.doesNotMatch(lock, /\.upsert\(/);
  assert.doesNotMatch(lock, /connect_during_trial/);
});
