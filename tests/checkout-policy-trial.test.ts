import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkoutTrialDecision,
  findTrialCustomerIdsOwnedByOthers,
  isMissingRelationError,
  getBillingCheckoutContext,
  loadActiveClientCustomerIds,
  recordTrialGrant,
} from '../lib/billing/checkout-policy';
import { legacyTrialEmailKey, normalizedTrialEmailKey } from '../lib/billing/trial-identity';

type Filter = [op: string, column: string, value: unknown];
type Query = {
  table: string;
  op: 'select' | 'upsert';
  filters: Filter[];
  rows?: unknown;
  options?: unknown;
  single: boolean;
};
type Result = { data: unknown; error: unknown };

/**
 * A chainable stand-in for the Supabase query builder. `respond` decides what each
 * query returns; every executed query is kept in `calls` for assertions.
 */
function fakeClient(respond: (query: Query) => Result) {
  const calls: Query[] = [];
  return {
    calls,
    from(table: string) {
      const query: Query = { table, op: 'select', filters: [], single: false };
      const builder: any = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters.push(['eq', column, value]);
          return builder;
        },
        in(column: string, value: unknown) {
          query.filters.push(['in', column, value]);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          query.filters.push(['not', column, `${operator}:${String(value)}`]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          query.single = true;
          calls.push(query);
          return Promise.resolve(respond(query));
        },
        upsert(rows: unknown, options: unknown) {
          query.op = 'upsert';
          query.rows = rows;
          query.options = options;
          calls.push(query);
          return Promise.resolve(respond(query));
        },
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          calls.push(query);
          return Promise.resolve(respond(query)).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const NO_ERROR = null;
const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

type World = {
  grant?: boolean;
  priorTrial?: boolean;
  /** email_hash values already in billing_trial_ledger */
  emailLedger?: string[];
  emailLedgerError?: boolean | { code?: string; message: string };
  businesses?: string[];
  accounts?: Array<{ customer_id: string; status?: string; is_manager?: boolean | null }>;
  accountsError?: boolean | { code?: string; message: string };
  /** customer_id -> first_user_id in trial_customer_ledger */
  customerLedger?: Record<string, string>;
  customerLedgerError?: boolean | { code?: string; message: string };
  /** An error to return for the businesses read instead of rows. */
  businessesError?: { code?: string; message: string };
};

/** `true` is a plain failure; an object is returned as the PostgREST error. */
const errorFor = (flag: boolean | { code?: string; message: string } | undefined, fallback: string) =>
  typeof flag === 'object' ? flag : { message: fallback };

/** The user-scoped client: subscriptions, grants, businesses and accounts. */
function userClient(world: World) {
  return fakeClient((query) => {
    switch (query.table) {
      case 'subscriptions': {
        const wantsPriorTrial = query.filters.some(([, column]) => column === 'trial_ends_at');
        return { data: wantsPriorTrial && world.priorTrial ? { id: 's1' } : null, error: NO_ERROR };
      }
      case 'billing_trial_grants':
        return { data: world.grant ? { user_id: USER } : null, error: NO_ERROR };
      case 'businesses':
        if (world.businessesError) return { data: null, error: world.businessesError };
        return {
          data: (world.businesses ?? ['b1']).map((id) => ({ id })),
          error: NO_ERROR,
        };
      case 'google_ads_accounts':
        if (world.accountsError) return { data: null, error: errorFor(world.accountsError, 'boom') };
        return {
          data: (world.accounts ?? []).map((account) => ({
            status: 'active',
            is_manager: null,
            ...account,
          })),
          error: NO_ERROR,
        };
      default:
        throw new Error(`unexpected user-client table ${query.table}`);
    }
  });
}

/** The service-role client: the three durable ledgers. */
function adminClient(world: World) {
  return fakeClient((query) => {
    if (query.table === 'billing_trial_ledger') {
      if (query.op === 'upsert') return { data: null, error: NO_ERROR };
      if (world.emailLedgerError) return { data: null, error: errorFor(world.emailLedgerError, 'ledger down') };
      const keys = query.filters.find(([op, column]) => op === 'in' && column === 'email_hash')?.[2] as string[];
      return {
        data: (world.emailLedger ?? []).filter((hash) => keys.includes(hash)).map((email_hash) => ({ email_hash })),
        error: NO_ERROR,
      };
    }
    if (query.table === 'trial_customer_ledger') {
      if (query.op === 'upsert') {
        return world.customerLedgerError
          ? { data: null, error: { message: 'insert failed' } }
          : { data: null, error: NO_ERROR };
      }
      if (world.customerLedgerError) return { data: null, error: errorFor(world.customerLedgerError, 'ledger down') };
      const ids = query.filters.find(([op, column]) => op === 'in' && column === 'customer_id')?.[2] as string[];
      return {
        data: Object.entries(world.customerLedger ?? {})
          .filter(([customerId]) => ids.includes(customerId))
          .map(([customer_id, first_user_id]) => ({ customer_id, first_user_id })),
        error: NO_ERROR,
      };
    }
    throw new Error(`unexpected admin table ${query.table}`);
  });
}

async function context(world: World, email: string | null = 'owner@example.com') {
  const supabase = userClient(world);
  const admin = adminClient(world);
  const result = await getBillingCheckoutContext(supabase, USER, email, { admin });
  return { result, supabase, admin };
}

async function quietly<T>(run: () => Promise<T>) {
  const original = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args);
  };
  try {
    return { value: await run(), messages };
  } finally {
    console.error = original;
  }
}

test('a fresh user on a fresh account is offered the trial', async () => {
  const { result } = await context({ accounts: [{ customer_id: '1234567890' }] });
  assert.equal(result.trialEligible, true);
  assert.equal(result.trialIneligibleReason, null);
});

test('trialEligible is exactly "no ineligible reason"', async () => {
  for (const world of [
    {},
    { grant: true },
    { accounts: [{ customer_id: '1234567890' }], customerLedger: { '1234567890': OTHER } },
  ] as World[]) {
    const { result } = await context(world);
    assert.equal(result.trialEligible, result.trialIneligibleReason === null);
  }
});

test('the user own grant or an earlier trial subscription means already_used', async () => {
  const grant = await context({ grant: true });
  assert.equal(grant.result.trialEligible, false);
  assert.equal(grant.result.trialIneligibleReason, 'already_used');
  // The user's own rows settle it, so neither durable ledger is queried.
  assert.equal(grant.admin.calls.length, 0);

  const prior = await context({ priorTrial: true });
  assert.equal(prior.result.trialIneligibleReason, 'already_used');
});

test('the email ledger is checked under the legacy AND the normalised key', async () => {
  const { admin } = await context({}, 'John.Doe+Promo@Gmail.com');
  const lookup = admin.calls.find((call) => call.table === 'billing_trial_ledger');
  const keys = lookup?.filters.find(([op, column]) => op === 'in' && column === 'email_hash')?.[2];
  assert.deepEqual(keys, [
    legacyTrialEmailKey('John.Doe+Promo@Gmail.com'),
    normalizedTrialEmailKey('John.Doe+Promo@Gmail.com'),
  ]);
});

test('a +tag or dotted Gmail variant of a used inbox is already_used', async () => {
  // The ledger holds the normalised key written when johndoe@gmail.com took its trial.
  const emailLedger = [normalizedTrialEmailKey('johndoe@gmail.com')];
  for (const email of ['john.doe@gmail.com', 'johndoe+again@gmail.com', 'J.O.H.N.D.O.E+x@googlemail.com']) {
    const { result } = await context({ emailLedger }, email);
    assert.equal(result.trialIneligibleReason, 'already_used', email);
  }
  const unrelated = await context({ emailLedger }, 'someoneelse@gmail.com');
  assert.equal(unrelated.result.trialIneligibleReason, null);
});

test('a ledger row written under the legacy exact-address key still blocks', async () => {
  const emailLedger = [legacyTrialEmailKey('owner@example.com')];
  const { result } = await context({ emailLedger }, '  Owner@Example.com ');
  assert.equal(result.trialIneligibleReason, 'already_used');
});

test('an email ledger error fails closed as check_failed, not as a used trial', async () => {
  const { value } = await quietly(() => context({ emailLedgerError: true }));
  assert.equal(value.result.trialEligible, false);
  assert.equal(value.result.trialIneligibleReason, 'check_failed');
});

test('a linked account that already had a trial under another user is ads_account_used', async () => {
  const { result, admin } = await context({
    accounts: [{ customer_id: '1112223334' }, { customer_id: '5556667778' }],
    customerLedger: { '5556667778': OTHER },
  });
  assert.equal(result.trialEligible, false);
  assert.equal(result.trialIneligibleReason, 'ads_account_used');
  const lookup = admin.calls.find((call) => call.table === 'trial_customer_ledger');
  assert.deepEqual(lookup?.filters.find(([op]) => op === 'in')?.[2], ['1112223334', '5556667778']);
});

test('the ledger row of the SAME user never locks that user out', async () => {
  const { result } = await context({
    accounts: [{ customer_id: '1112223334' }],
    customerLedger: { '1112223334': USER },
  });
  assert.equal(result.trialIneligibleReason, null);
});

test('only active, non-manager accounts of the user businesses are looked up', async () => {
  const { supabase } = await context({
    businesses: ['b1', 'b2'],
    accounts: [
      { customer_id: '1112223334' },
      { customer_id: '9990001112', is_manager: true },
    ],
  });
  const accountQuery = supabase.calls.find((call) => call.table === 'google_ads_accounts');
  assert.deepEqual(accountQuery?.filters, [
    ['in', 'business_id', ['b1', 'b2']],
    ['eq', 'status', 'active'],
    ['not', 'is_manager', 'is:true'],
  ]);
  const businessQuery = supabase.calls.find((call) => call.table === 'businesses');
  assert.deepEqual(businessQuery?.filters, [['eq', 'user_id', USER]]);
});

test('a manager row that slips past the query filter is still not looked up', async () => {
  const ids = await loadActiveClientCustomerIds(
    userClient({
      accounts: [
        { customer_id: '1112223334' },
        { customer_id: '9990001112', is_manager: true },
        { customer_id: '123-456-7890' },
        { customer_id: '12' },
      ],
    }),
    USER
  );
  // Digits only, valid length only, no manager, no duplicates.
  assert.deepEqual(ids, ['1112223334', '1234567890']);
});

test('no linked account means no ads lookup and no lock', async () => {
  const { result, admin } = await context({ accounts: [] });
  assert.equal(result.trialIneligibleReason, null);
  assert.equal(admin.calls.filter((call) => call.table === 'trial_customer_ledger').length, 0);
});

test('a customer ledger error fails closed as check_failed', async () => {
  const { value } = await quietly(() =>
    context({ accounts: [{ customer_id: '1112223334' }], customerLedgerError: true })
  );
  assert.equal(value.result.trialEligible, false);
  assert.equal(value.result.trialIneligibleReason, 'check_failed');
});

test('an accounts read error fails closed as check_failed', async () => {
  const { value } = await quietly(() => context({ accountsError: true }));
  assert.equal(value.result.trialEligible, false);
  assert.equal(value.result.trialIneligibleReason, 'check_failed');
});

test('a disposable inbox is not offered the trial', async () => {
  const { result } = await context({ accounts: [{ customer_id: '1112223334' }] }, 'x@Mailinator.com');
  assert.equal(result.trialEligible, false);
  assert.equal(result.trialIneligibleReason, 'disposable_email');
});

test('reasons are ranked already_used, then ads_account_used, then disposable_email', async () => {
  const world: World = {
    accounts: [{ customer_id: '1112223334' }],
    customerLedger: { '1112223334': OTHER },
    emailLedger: [legacyTrialEmailKey('x@mailinator.com')],
  };
  assert.equal((await context(world, 'x@mailinator.com')).result.trialIneligibleReason, 'already_used');
  assert.equal(
    (await context({ ...world, emailLedger: [] }, 'x@mailinator.com')).result.trialIneligibleReason,
    'ads_account_used'
  );
});

test('a missing email never trips the email checks', async () => {
  const { result, admin } = await context({}, null);
  assert.equal(result.trialIneligibleReason, null);
  assert.equal(admin.calls.filter((call) => call.table === 'billing_trial_ledger').length, 0);
});

test('large account lists are looked up in chunks', async () => {
  const accounts = Array.from({ length: 250 }, (_, index) => ({
    customer_id: String(1000000000 + index),
  }));
  const { admin, result } = await context({ accounts, customerLedger: { '1000000249': OTHER } });
  const lookups = admin.calls.filter((call) => call.table === 'trial_customer_ledger');
  assert.equal(lookups.length, 3);
  assert.equal(result.trialIneligibleReason, 'ads_account_used');
});

test('findTrialCustomerIdsOwnedByOthers returns only other users rows', async () => {
  const admin = adminClient({ customerLedger: { '1112223334': USER, '5556667778': OTHER } });
  assert.deepEqual(
    await findTrialCustomerIdsOwnedByOthers(admin, USER, ['1112223334', '5556667778', '7770001112']),
    ['5556667778']
  );
  assert.deepEqual(await findTrialCustomerIdsOwnedByOthers(admin, USER, []), []);
});

// ---------------------------------------------------------------------------
// recordTrialGrant
// ---------------------------------------------------------------------------

test('recordTrialGrant writes the legacy and the normalised email key', async () => {
  const world: World = { accounts: [] };
  const supabase = userClient(world);
  const writes: Array<{ table: string; rows: unknown }> = [];
  const original = supabase.from.bind(supabase);
  supabase.from = (table: string) => {
    const builder = original(table);
    const upsert = builder.upsert.bind(builder);
    builder.upsert = (rows: unknown, options: unknown) => {
      writes.push({ table, rows });
      return upsert(rows, options);
    };
    return builder;
  };
  const admin = adminClient(world);

  await recordTrialGrant({
    supabase,
    admin,
    userId: USER,
    email: 'John.Doe+x@gmail.com',
    stripeSubscriptionId: 'sub_1',
    source: 'checkout_complete',
  });

  assert.equal(writes[0]?.table, 'billing_trial_grants');
  const ledgerWrite = admin.calls.find((call) => call.table === 'billing_trial_ledger' && call.op === 'upsert');
  assert.deepEqual(ledgerWrite?.rows, [
    { email_hash: legacyTrialEmailKey('John.Doe+x@gmail.com'), source: 'checkout_complete' },
    { email_hash: normalizedTrialEmailKey('John.Doe+x@gmail.com'), source: 'checkout_complete' },
  ]);
  assert.deepEqual(ledgerWrite?.options, { onConflict: 'email_hash', ignoreDuplicates: true });
});

test('recordTrialGrant writes one row when the legacy and normalised keys are the same', async () => {
  const world: World = {};
  const admin = adminClient(world);
  await recordTrialGrant({
    supabase: userClient(world),
    admin,
    userId: USER,
    email: 'owner@example.com',
    source: 'stripe_webhook',
  });
  const ledgerWrite = admin.calls.find((call) => call.table === 'billing_trial_ledger' && call.op === 'upsert');
  assert.equal((ledgerWrite?.rows as unknown[]).length, 1);
});

test('recordTrialGrant records the active non-manager customer ids, first writer wins', async () => {
  const world: World = {
    accounts: [{ customer_id: '1112223334' }, { customer_id: '5556667778' }],
  };
  const admin = adminClient(world);
  await recordTrialGrant({
    supabase: userClient(world),
    admin,
    userId: USER,
    email: 'owner@example.com',
    source: 'checkout_complete',
  });
  const write = admin.calls.find((call) => call.table === 'trial_customer_ledger' && call.op === 'upsert');
  assert.deepEqual(write?.rows, [
    { customer_id: '1112223334', first_user_id: USER, source: 'checkout_complete' },
    { customer_id: '5556667778', first_user_id: USER, source: 'checkout_complete' },
  ]);
  assert.deepEqual(write?.options, { onConflict: 'customer_id', ignoreDuplicates: true });
});

test('recordTrialGrant skips the customer ledger when no account is linked', async () => {
  const world: World = { accounts: [] };
  const admin = adminClient(world);
  await recordTrialGrant({
    supabase: userClient(world),
    admin,
    userId: USER,
    email: 'owner@example.com',
    source: 'checkout_complete',
  });
  assert.equal(admin.calls.filter((call) => call.table === 'trial_customer_ledger').length, 0);
});

test('a customer ledger write failure is logged and does not throw', async () => {
  const world: World = { accounts: [{ customer_id: '1112223334' }], customerLedgerError: true };
  const admin = adminClient(world);
  const { messages } = await quietly(() =>
    recordTrialGrant({
      supabase: userClient(world),
      admin,
      userId: USER,
      email: 'owner@example.com',
      source: 'checkout_complete',
    })
  );
  assert.equal(messages.length, 1);
  assert.match(String(messages[0][0]), /trial customer-id ledger/);
});

test('an accounts read failure while recording is logged and does not throw', async () => {
  const world: World = { accountsError: true };
  const { messages } = await quietly(() =>
    recordTrialGrant({
      supabase: userClient(world),
      admin: adminClient(world),
      userId: USER,
      email: 'owner@example.com',
      source: 'checkout_complete',
    })
  );
  assert.equal(messages.length, 1);
});

// ---------------------------------------------------------------------------
// Deploy order: this code can reach production before the migration has run.
// Only the NEW table's absence is tolerated; everything else keeps failing closed.
// ---------------------------------------------------------------------------

const MISSING_TABLE_ERRORS: Array<[string, { code?: string; message: string }]> = [
  ['Postgres 42P01', { code: '42P01', message: 'relation "public.trial_customer_ledger" does not exist' }],
  [
    'PostgREST PGRST205',
    { code: 'PGRST205', message: "Could not find the table 'public.trial_customer_ledger' in the schema cache" },
  ],
  [
    'the PostgREST text without a code',
    { message: "Could not find the table 'public.trial_customer_ledger' in the schema cache" },
  ],
];

for (const [label, error] of MISSING_TABLE_ERRORS) {
  test(`trial_customer_ledger missing (${label}): the trial stays available and the log is loud`, async () => {
    const { value, messages } = await quietly(() =>
      context({ accounts: [{ customer_id: '1112223334' }], customerLedgerError: error })
    );
    assert.equal(value.result.trialEligible, true);
    assert.equal(value.result.trialIneligibleReason, null);
    assert.equal(messages.length, 1, 'exactly one loud log');
    const text = String(messages[0][0]);
    assert.match(text, /DEPLOY ORDER/);
    assert.match(text, /trial_customer_ledger/);
    assert.match(text, /20261013_trial_abuse_guards\.sql/);
    assert.equal(messages[0][1], error, 'the original error is logged too');
  });
}

test('the tolerance does not hide the other reasons', async () => {
  const missing = MISSING_TABLE_ERRORS[0][1];
  const disposable = await quietly(() =>
    context({ accounts: [{ customer_id: '1112223334' }], customerLedgerError: missing }, 'x@mailinator.com')
  );
  assert.equal(disposable.value.result.trialIneligibleReason, 'disposable_email');

  const usedBefore = await quietly(() =>
    context({ grant: true, accounts: [{ customer_id: '1112223334' }], customerLedgerError: missing })
  );
  assert.equal(usedBefore.value.result.trialIneligibleReason, 'already_used');

  const emailUsed = await context(
    { emailLedger: [legacyTrialEmailKey('owner@example.com')], accounts: [] },
    'owner@example.com'
  );
  assert.equal(emailUsed.result.trialIneligibleReason, 'already_used');
});

test('every other customer ledger error still fails closed', async () => {
  const others: Array<{ code?: string; message: string }> = [
    { message: 'ledger down' },
    { code: '42501', message: 'permission denied for table trial_customer_ledger' },
    { code: '42703', message: 'column "first_user_id" does not exist' },
    { code: 'PGRST202', message: 'Could not find the function public.something in the schema cache' },
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: 'PGRST301', message: 'JWT expired' },
  ];
  for (const error of others) {
    const { value, messages } = await quietly(() =>
      context({ accounts: [{ customer_id: '1112223334' }], customerLedgerError: error })
    );
    assert.equal(value.result.trialEligible, false, error.message);
    assert.equal(value.result.trialIneligibleReason, 'check_failed', error.message);
    assert.ok(!messages.some((m) => /DEPLOY ORDER/.test(String(m[0]))), error.message);
  }
});

test('a missing table in any OTHER read still fails closed', async () => {
  const missing = { code: '42P01', message: 'relation "public.something" does not exist' };
  const businesses = await quietly(() => context({ businessesError: missing }));
  assert.equal(businesses.value.result.trialIneligibleReason, 'check_failed');

  const accounts = await quietly(() => context({ accountsError: missing }));
  assert.equal(accounts.value.result.trialIneligibleReason, 'check_failed');

  // The email ledger is billing_trial_ledger, a table that already exists in
  // production: it is not a deploy-order case, so a missing table there is a
  // real outage and stays closed.
  const email = await quietly(() => context({ emailLedgerError: { ...missing, message: 'relation "public.billing_trial_ledger" does not exist' } }));
  assert.equal(email.value.result.trialEligible, false);
  assert.equal(email.value.result.trialIneligibleReason, 'check_failed');
});

test('the email ledger lookup still reads billing_trial_ledger, not the new tables', async () => {
  const { admin } = await context({ accounts: [] });
  const tables = new Set(admin.calls.map((call) => call.table));
  assert.deepEqual(Array.from(tables), ['billing_trial_ledger']);
});

test('findTrialCustomerIdsOwnedByOthers itself still throws on a missing table (callers decide)', async () => {
  const admin = adminClient({ customerLedgerError: MISSING_TABLE_ERRORS[1][1] });
  await assert.rejects(() => findTrialCustomerIdsOwnedByOthers(admin, USER, ['1112223334']));
});

test('isMissingRelationError recognises table errors only', () => {
  assert.equal(isMissingRelationError({ code: '42P01' }), true);
  assert.equal(isMissingRelationError({ code: 'PGRST205' }), true);
  assert.equal(isMissingRelationError({ message: 'relation "public.x" does not exist' }), true);
  assert.equal(isMissingRelationError({ message: "Could not find the table 'public.x' in the schema cache" }), true);
  assert.equal(isMissingRelationError({ code: '42703', message: 'column "x" does not exist' }), false);
  assert.equal(isMissingRelationError({ code: '42883', message: 'function x() does not exist' }), false);
  assert.equal(isMissingRelationError({ code: 'PGRST202' }), false);
  assert.equal(isMissingRelationError(new Error('boom')), false);
  assert.equal(isMissingRelationError(null), false);
  assert.equal(isMissingRelationError('42P01'), false);
});

// ---------------------------------------------------------------------------
// check_failed: a lookup that could not run is not "you already had a trial"
// ---------------------------------------------------------------------------

test('a definite reason beats a failed lookup, and a failed lookup beats a trial', async () => {
  // email lookup fails, but the ads account is known to be used
  const adsUsed = await quietly(() =>
    context({ emailLedgerError: true, accounts: [{ customer_id: '1112223334' }], customerLedger: { '1112223334': OTHER } })
  );
  assert.equal(adsUsed.value.result.trialIneligibleReason, 'ads_account_used');

  // ads lookup fails, but the email ledger says used
  const emailUsed = await quietly(() =>
    context({
      emailLedger: [legacyTrialEmailKey('owner@example.com')],
      accounts: [{ customer_id: '1112223334' }],
      customerLedgerError: true,
    })
  );
  assert.equal(emailUsed.value.result.trialIneligibleReason, 'already_used');

  // a disposable inbox is refused for a known reason even if a lookup failed
  const disposable = await quietly(() => context({ emailLedgerError: true }, 'x@mailinator.com'));
  assert.equal(disposable.value.result.trialIneligibleReason, 'disposable_email');

  // the user own rows settle it without any ledger read at all
  const own = await quietly(() => context({ grant: true, emailLedgerError: true, customerLedgerError: true }));
  assert.equal(own.value.result.trialIneligibleReason, 'already_used');
  assert.equal(own.messages.length, 0);

  // both lookups fine: eligible
  assert.equal((await context({})).result.trialEligible, true);
});

test('check_failed never offers a trial (fail closed)', async () => {
  const { value } = await quietly(() => context({ emailLedgerError: true }));
  assert.equal(value.result.trialEligible, false);
  assert.equal(value.result.trialIneligibleReason, 'check_failed');
});

test('a failed lookup is logged once per lookup and names check_failed', async () => {
  const { messages } = await quietly(() => context({ emailLedgerError: true }));
  assert.equal(messages.length, 1);
  assert.match(String(messages[0][0]), /check_failed/);
});

test('checkoutTrialDecision: only an eligible user gets trial days, check_failed blocks, the rest pay', () => {
  assert.deepEqual(checkoutTrialDecision({ trialEligible: true, trialIneligibleReason: null }), {
    action: 'proceed',
    trialDays: 14,
  });
  for (const reason of ['already_used', 'ads_account_used', 'disposable_email'] as const) {
    assert.deepEqual(checkoutTrialDecision({ trialEligible: false, trialIneligibleReason: reason }), {
      action: 'proceed',
      trialDays: 0,
    });
  }
  assert.deepEqual(checkoutTrialDecision({ trialEligible: false, trialIneligibleReason: 'check_failed' }), {
    action: 'blocked',
    error: 'trial_check_failed',
  });
});
