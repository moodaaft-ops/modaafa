import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkSetupAnswer,
  isFallbackBusinessName,
  recordSetupAnswer,
  resolveAnswerTarget,
} from '../lib/setup/answer-flow';
import { runSignalsRequest } from '../lib/setup/adaptive/signals-request';
import { countOkSignals } from '../lib/setup/adaptive/signals-store';
import { ADAPTIVE_KEYS } from '../lib/setup/adaptive/types';
import type { AccountSignals } from '../lib/setup/adaptive/types';
import { eqValue, fakeDb, type FakeQuery } from './fixtures/fake-db';
import { clinicAccount, readAgo, sallaAccount, signalsRow } from './fixtures/adaptive-accounts';

const USER = { id: 'u1', email: 'Owner@Example.com', user_metadata: { full_name: 'سلطان', name: 'Sultan' } };
const ACCOUNT = { id: 'acc-1', customer_name: 'Smile Clinic' };

// ---------------------------------------------------------------------------
// What the browser may send (replaces the regexes over the route source)
// ---------------------------------------------------------------------------

test('checkSetupAnswer: an adaptive key from someone without the tree is a 404 before anything is parsed', () => {
  for (const key of ADAPTIVE_KEYS) {
    // Even a body that would not parse is a 404, not a 400: the key does not exist for them.
    assert.deepEqual(checkSetupAnswer({ key, answer: { choice: 'nonsense' } }, false), { ok: false, status: 404, error: 'not_found' }, key);
    assert.deepEqual(checkSetupAnswer({ key }, false), { ok: false, status: 404, error: 'not_found' }, key);
  }
  // With the tree on the same bad body is the 400 it always was.
  assert.deepEqual(checkSetupAnswer({ key: 'confirm', answer: { choice: 'nonsense' } }, true), { ok: false, status: 400, error: 'invalid_choice' });
  const ok = checkSetupAnswer({ key: 'confirm', answer: { choice: 'yes', kind: 'clinic', outcome: 'calls' } }, true);
  assert.deepEqual(ok, { ok: true, answer: { key: 'confirm', choice: 'yes', kind: 'clinic', outcome: 'calls' } });
  // The ten fixed questions answer for everybody.
  assert.equal(checkSetupAnswer({ key: 'pain', answer: { choice: 'few_leads' } }, false).ok, true);
  assert.deepEqual(checkSetupAnswer({ key: 'nope', answer: {} }, false), { ok: false, status: 400, error: 'invalid_key' });
  assert.deepEqual(checkSetupAnswer(null, true), { ok: false, status: 400, error: 'invalid_key' });
});

test('nit a: without the tree the per-kind goal and pain ids are refused, the legacy lists are not', () => {
  for (const [key, choice] of [
    ['goal', 'clinic_calls'],
    ['goal', 'shop_orders'],
    ['pain', 'shop_few_orders'],
    ['pain', 'clinic_few_calls'],
  ] as const) {
    assert.deepEqual(checkSetupAnswer({ key, answer: { choice } }, false), { ok: false, status: 400, error: 'invalid_choice' }, `${key}:${choice}`);
    assert.equal(checkSetupAnswer({ key, answer: { choice } }, true).ok, true, `${key}:${choice} with the tree on`);
  }
  for (const [key, choice] of [
    ['goal', 'online_sales'],
    ['goal', 'awareness'],
    ['pain', 'few_leads'],
    ['pain', 'unsure'],
  ] as const) {
    assert.equal(checkSetupAnswer({ key, answer: { choice } }, false).ok, true, `${key}:${choice}`);
    assert.equal(checkSetupAnswer({ key, answer: { choice } }, true).ok, true, `${key}:${choice} with the tree on`);
  }
  assert.deepEqual(checkSetupAnswer({ key: 'goal', answer: { choice: 'whatever' } }, false), { ok: false, status: 400, error: 'invalid_choice' });
});

test('S4 route: the browser cannot send the average order; only the server fills it', () => {
  const checked = checkSetupAnswer({ key: 'aov_check', answer: { choice: 'same', amount: 99999, currency: 'USD' } }, true);
  assert.ok(checked.ok);
  assert.deepEqual(checked.ok && checked.answer, { key: 'aov_check', choice: 'same' });
});

// ---------------------------------------------------------------------------
// resolveAnswerTarget
// ---------------------------------------------------------------------------

const WORKSPACE_BUSINESS = { id: 'biz-1', name: 'سلطان' };

test('the workspace is made only for «has_account», only with the tree on, and only when none exists', async () => {
  const made: string[] = [];
  const ensureBusiness = async () => {
    made.push('made');
    return { id: 'biz-new', selected_google_ads_customer_id: null };
  };
  const none = async () => ({ business: null, selectedAccount: null });
  const supabase = fakeDb({ businesses: [] }).client;
  const hasAccount = checkSetupAnswer({ key: 'has_account', answer: { choice: 'none' } }, true);
  const goal = checkSetupAnswer({ key: 'goal', answer: { choice: 'calls' } }, true);
  assert.ok(hasAccount.ok && goal.ok);

  const first = await resolveAnswerTarget({ supabase, user: USER, adaptiveOn: true, answer: hasAccount.ok ? hasAccount.answer : (null as never), deps: { workspace: none, ensureBusiness } });
  assert.equal(first.business?.id, 'biz-new');
  assert.equal(made.length, 1);

  // Every other answer without a business stays a «no_business» (the route's 409).
  const other = await resolveAnswerTarget({ supabase, user: USER, adaptiveOn: true, answer: goal.ok ? goal.answer : (null as never), deps: { workspace: none, ensureBusiness } });
  assert.equal(other.business, null);
  assert.equal(made.length, 1);

  // An existing workspace is never created again.
  const existing = await resolveAnswerTarget({
    supabase,
    user: USER,
    adaptiveOn: true,
    answer: hasAccount.ok ? hasAccount.answer : (null as never),
    deps: { workspace: async () => ({ business: WORKSPACE_BUSINESS, selectedAccount: ACCOUNT }), ensureBusiness },
  });
  assert.equal(existing.business?.id, 'biz-1');
  assert.equal(made.length, 1);
});

test('S6 answer: with the tree on the account is the one the setup screen reads, not the persisted one', async () => {
  const supabase = fakeDb({ businesses: [{ id: 'biz-1', selected_google_ads_customer_id: '1111111111' }] }).client;
  const answer = checkSetupAnswer({ key: 'goal', answer: { choice: 'calls' } }, true);
  assert.ok(answer.ok);
  const target = await resolveAnswerTarget({
    supabase,
    user: USER,
    adaptiveOn: true,
    answer: answer.ok ? answer.answer : (null as never),
    deps: { workspace: async () => ({ business: WORKSPACE_BUSINESS, selectedAccount: { id: 'acc-cookie', customer_name: 'Chosen' } }) },
  });
  assert.equal(target.account?.id, 'acc-cookie');
});

test('flag off: the route resolves the business and account exactly as it always did, and never makes a workspace', async () => {
  let workspaceCalls = 0;
  let made = 0;
  const db = fakeDb({
    businesses: [{ id: 'biz-9', selected_google_ads_customer_id: null }],
    google_ads_accounts: [{ id: 'acc-9', customer_id: '9998887776' }],
  });
  const answer = checkSetupAnswer({ key: 'pain', answer: { choice: 'few_leads' } }, false);
  assert.ok(answer.ok);
  const target = await resolveAnswerTarget({
    supabase: db.client,
    user: USER,
    adaptiveOn: false,
    answer: answer.ok ? answer.answer : (null as never),
    deps: {
      workspace: async () => {
        workspaceCalls += 1;
        return null;
      },
      ensureBusiness: async () => {
        made += 1;
        return null;
      },
    },
  });
  assert.equal(target.business?.id, 'biz-9');
  assert.equal(target.account?.id, 'acc-9');
  assert.equal(workspaceCalls, 0);
  assert.equal(made, 0);

  const empty = await resolveAnswerTarget({ supabase: fakeDb({ businesses: [] }).client, user: USER, adaptiveOn: false, answer: answer.ok ? answer.answer : (null as never) });
  assert.equal(empty.business, null);
});

// ---------------------------------------------------------------------------
// recordSetupAnswer: what an answer writes beyond its own fact
// ---------------------------------------------------------------------------

const memoryInsert = (admin: ReturnType<typeof fakeDb>) => admin.queries.find((query) => query.table === 'business_memory' && query.op === 'insert');
const fact = (admin: ReturnType<typeof fakeDb>) => memoryInsert(admin)?.payload as { fact_ar: string; data: Record<string, unknown> } | undefined;

function answerOf(key: string, answer: Record<string, unknown>, adaptiveOn = true) {
  const checked = checkSetupAnswer({ key, answer }, adaptiveOn);
  assert.ok(checked.ok, JSON.stringify(checked));
  return checked.ok ? checked.answer : (null as never);
}

/** A stored read that is fresh whenever the test runs. */
const freshStore = (signals: AccountSignals) => ({ job_runs: [signalsRow(readAgo(signals, new Date(), 0.1))] });

async function record(args: { key: string; answer: Record<string, unknown>; admin?: ReturnType<typeof fakeDb>; adaptiveOn?: boolean; account?: typeof ACCOUNT | null; business?: { id: string; name: string | null } }) {
  const adaptiveOn = args.adaptiveOn ?? true;
  const supabase = fakeDb({});
  const admin = args.admin ?? fakeDb({});
  const outcome = await recordSetupAnswer({
    supabase: supabase.client,
    admin: admin.client,
    user: USER,
    adaptiveOn,
    business: args.business ?? { id: 'biz-1', name: 'سلطان' },
    account: args.account === undefined ? ACCOUNT : args.account,
    answer: answerOf(args.key, args.answer, adaptiveOn),
  });
  return { outcome, supabase, admin };
}

test('S4: the average order the account reported is written into the fact, in the customer\'s direction', async () => {
  const cases: Array<[string, string]> = [
    ['same', 'متوسط طلبه من قوقل قرابة 186 ريال، وقال إنه قريب من الصح'],
    ['less', 'متوسط طلبه من قوقل قرابة 186 ريال، وقال إن الفعلي أقل'],
    ['more', 'متوسط طلبه من قوقل قرابة 186 ريال، وقال إن الفعلي أكثر'],
  ];
  for (const [choice, text] of cases) {
    const { outcome, admin } = await record({ key: 'aov_check', answer: { choice }, admin: fakeDb(freshStore(sallaAccount())) });
    assert.ok(outcome.ok);
    assert.equal(fact(admin)?.fact_ar, text, choice);
    assert.equal(fact(admin)?.data.aov, 186, choice);
    assert.equal(fact(admin)?.data.currency, 'SAR', choice);
    assert.equal(fact(admin)?.data.choice, choice);
  }
});

test('S4: with no stored read, or an old one, the fact keeps its old words and no number', async () => {
  const none = await record({ key: 'aov_check', answer: { choice: 'less' }, admin: fakeDb({ job_runs: [] }) });
  assert.equal(fact(none.admin)?.fact_ar, 'متوسط طلبه الفعلي أقل من اللي قراه حسابه');
  assert.equal('aov' in (fact(none.admin)?.data ?? {}), false);

  const old = await record({ key: 'aov_check', answer: { choice: 'same' }, admin: fakeDb({ job_runs: [signalsRow(readAgo(sallaAccount(), new Date(), 72))] }) });
  assert.equal(fact(old.admin)?.fact_ar, 'متوسط الطلب اللي قراه حسابه قريب من الصح');
  assert.equal('aov' in (fact(old.admin)?.data ?? {}), false);

  // An account that reports no average order has nothing to say.
  const clinic = await record({ key: 'aov_check', answer: { choice: 'same' }, admin: fakeDb(freshStore(clinicAccount())) });
  assert.equal('aov' in (fact(clinic.admin)?.data ?? {}), false);
});

test('the picked products are named from the stored read, and a flag-off answer reads nothing', async () => {
  const on = await record({ key: 'push_products', answer: { choices: ['p_0'] }, admin: fakeDb(freshStore(sallaAccount())) });
  assert.equal(fact(on.admin)?.fact_ar, 'منتجات يبي تبيع أكثر: عطر العود الملكي');

  // The same key cannot reach this code with the tree off; a legacy key reads no signals at all.
  const off = await record({ key: 'pain', answer: { choice: 'few_leads' }, adaptiveOn: false, admin: fakeDb(freshStore(sallaAccount())) });
  assert.equal(off.admin.reads().some((query) => query.table === 'job_runs'), false);
  assert.equal(off.admin.reads().some((query) => query.table === 'business_memory'), false);
});

test('the reaction to a margin answer uses the stored average order, only for the tree', async () => {
  // The average order counts only when the customer agreed with it.
  const agreed = { business_memory: [{ data: { setup_key: 'aov_check', choice: 'same' }, created_at: '2026-10-14T09:00:00.000Z' }] };
  const on = await record({ key: 'margin', answer: { choice: 'lt20' }, admin: fakeDb({ ...freshStore(sallaAccount()), ...agreed }) });
  assert.ok(on.outcome.ok);
  assert.match((on.outcome.ok && on.outcome.reaction) || '', /37/, '20% of 186');
  const without = await record({ key: 'margin', answer: { choice: 'lt20' }, admin: fakeDb({ job_runs: [] }) });
  assert.equal(without.outcome.ok && without.outcome.reaction, 'تمام، الربح ضيق، فبحسب كل ريال إعلان بدقة.');
});

// --- S5: the business takes the account's name -------------------------------

const renames = (supabase: ReturnType<typeof fakeDb>) =>
  supabase.queries.filter((query) => query.table === 'businesses' && query.op === 'update' && (query.payload as { name?: string }).name !== undefined);

const YES = { choice: 'yes', kind: 'clinic', outcome: 'calls' };

test('S5: after «إي صح» a workspace still named after the login takes the account\'s name', async () => {
  const { outcome, supabase } = await record({ key: 'confirm', answer: YES });
  assert.ok(outcome.ok);
  const [rename] = renames(supabase);
  assert.equal((rename.payload as { name: string }).name, 'Smile Clinic');
  assert.equal(eqValue(rename, 'id'), 'biz-1');
  assert.equal(eqValue(rename, 'user_id'), 'u1', 'scoped to the caller\'s own row');
  // The answer itself still wrote the sector.
  assert.ok(supabase.queries.some((query) => query.table === 'businesses' && query.op === 'update' && 'sector' in (query.payload as object)));
});

test('S5: every name the workspace is created with counts as a fallback, however it is cased', async () => {
  for (const name of ['سلطان', 'Sultan', 'owner', 'OWNER', '  Owner  ', 'نشاطي', '']) {
    const { supabase } = await record({ key: 'confirm', answer: YES, business: { id: 'biz-1', name } });
    assert.equal(renames(supabase).length, 1, JSON.stringify(name));
  }
  const nameless = await record({ key: 'confirm', answer: YES, business: { id: 'biz-1', name: null } });
  assert.equal(renames(nameless.supabase).length, 1);
});

test('S5: a name the customer typed is never replaced', async () => {
  for (const name of ['عيادة الابتسامة', 'Smile Dental Center', 'ownership group']) {
    const { supabase } = await record({ key: 'confirm', answer: YES, business: { id: 'biz-1', name } });
    assert.equal(renames(supabase).length, 0, name);
  }
});

test('S5: nothing is renamed on a «no», without a real account name, without an account, with the tree off, or when the answer failed', async () => {
  const no = await record({ key: 'confirm', answer: { choice: 'no' } });
  assert.equal(renames(no.supabase).length, 0);

  for (const customer_name of ['Google Ads 123-456-7890', 'حساب بدون اسم', '', null]) {
    const { supabase } = await record({ key: 'confirm', answer: YES, account: { id: 'acc-1', customer_name } as never });
    assert.equal(renames(supabase).length, 0, String(customer_name));
  }

  const noAccount = await record({ key: 'confirm', answer: YES, account: null });
  assert.equal(renames(noAccount.supabase).length, 0);

  const off = await recordSetupAnswer({
    supabase: fakeDb({}).client,
    admin: fakeDb({}).client,
    user: USER,
    adaptiveOn: false,
    business: { id: 'biz-1', name: 'سلطان' },
    account: ACCOUNT,
    answer: { key: 'confirm', choice: 'yes', kind: 'clinic' },
  });
  assert.ok(off.ok);

  const failing = fakeDb({}, { failWrite: (query) => query.table === 'businesses' });
  const failedOutcome = await recordSetupAnswer({
    supabase: failing.client,
    admin: fakeDb({}).client,
    user: USER,
    adaptiveOn: true,
    business: { id: 'biz-1', name: 'سلطان' },
    account: ACCOUNT,
    answer: answerOf('confirm', YES),
  });
  assert.deepEqual(failedOutcome, { ok: false, error: 'save_failed' });
  assert.equal(renames(failing).length, 0, 'a failed answer renames nothing');
});

test('S5: a rename that fails does not fail the answer', async () => {
  const supabase = fakeDb({}, { failWrite: (query) => (query.payload as { name?: string } | undefined)?.name !== undefined });
  const outcome = await recordSetupAnswer({
    supabase: supabase.client,
    admin: fakeDb({}).client,
    user: USER,
    adaptiveOn: true,
    business: { id: 'biz-1', name: 'سلطان' },
    account: ACCOUNT,
    answer: answerOf('confirm', YES),
  });
  assert.ok(outcome.ok);
});

// ---------------------------------------------------------------------------
// S1: a «no» after a «yes» takes back what the «yes» wrote on the business
// ---------------------------------------------------------------------------

/** Ledger rows, newest first (what `readLedgerEntries` asks the database for). */
const ledgerRows = (...facts: Array<Record<string, unknown>>) => ({
  business_memory: facts.map((data, index) => ({ data, created_at: `2026-10-14T10:0${index}:00Z` })),
});

const YES_FACT = { setup_key: 'confirm', choice: 'yes', kind: 'clinic', outcome: 'calls' };

const clears = (supabase: ReturnType<typeof fakeDb>, column: 'sector' | 'primary_goal') =>
  supabase.queries.filter(
    (query) => query.table === 'businesses' && query.op === 'update' && column in (query.payload as object) && (query.payload as Record<string, unknown>)[column] === null
  );

test('S1: «لا» after «إي صح» clears the sector the yes wrote, only while it still holds exactly that', async () => {
  const { outcome, supabase } = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(ledgerRows(YES_FACT)) });
  assert.ok(outcome.ok);
  const [sector] = clears(supabase, 'sector');
  assert.ok(sector, 'the sector is cleared');
  assert.equal(eqValue(sector, 'id'), 'biz-1');
  assert.equal(eqValue(sector, 'user_id'), 'u1', 'scoped to the caller\'s own row');
  assert.equal(eqValue(sector, 'sector'), 'عيادة أو مركز طبي', 'a sector the customer changed since is left alone');
  // The goal the yes wrote (calls -> leads) goes the same way.
  const [goal] = clears(supabase, 'primary_goal');
  assert.equal(eqValue(goal, 'primary_goal'), 'leads');
});

test('S1: the «no» itself is saved first, and nothing is cleared when there was no «yes» to take back', async () => {
  const afterYes = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(ledgerRows(YES_FACT)) });
  assert.equal(fact(afterYes.admin)?.data.choice, 'no');

  for (const rows of [ledgerRows(), ledgerRows({ setup_key: 'confirm', choice: 'no' }), ledgerRows({ setup_key: 'focus_service', choice: 'all' })]) {
    const { outcome, supabase } = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(rows) });
    assert.ok(outcome.ok);
    assert.equal(clears(supabase, 'sector').length, 0);
    assert.equal(clears(supabase, 'primary_goal').length, 0);
  }
});

test('S1: a type or a goal the customer answered themselves is never wiped by a «no»', async () => {
  const typed = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(ledgerRows(YES_FACT, { setup_key: 'type', choice: 'clinic' })) });
  assert.equal(clears(typed.supabase, 'sector').length, 0, 'the sector is also their stated type');
  assert.equal(clears(typed.supabase, 'primary_goal').length, 1);

  const goaled = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(ledgerRows(YES_FACT, { setup_key: 'goal', choice: 'clinic_calls' })) });
  assert.equal(clears(goaled.supabase, 'primary_goal').length, 0);
  assert.equal(clears(goaled.supabase, 'sector').length, 1);
});

test('S1: a «yes» that confirmed a kind with no sector, or no outcome, clears only what it wrote', async () => {
  const general = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(ledgerRows({ setup_key: 'confirm', choice: 'yes', kind: 'general', outcome: 'purchases' })) });
  assert.equal(clears(general.supabase, 'sector').length, 0, '«general» writes no sector');
  assert.equal(eqValue(clears(general.supabase, 'primary_goal')[0], 'primary_goal'), 'conversions');

  const noOutcome = await record({ key: 'confirm', answer: { choice: 'no' }, admin: fakeDb(ledgerRows({ setup_key: 'confirm', choice: 'yes', kind: 'local' })) });
  assert.equal(eqValue(clears(noOutcome.supabase, 'sector')[0], 'sector'), 'محل أو فرع');
  assert.equal(clears(noOutcome.supabase, 'primary_goal').length, 0);
});

test('S1: other answers, the tree off, a failed answer and a failed clear leave the business alone or the answer intact', async () => {
  const other = await record({ key: 'focus_service', answer: { choice: 'all' }, admin: fakeDb(ledgerRows(YES_FACT)) });
  assert.equal(clears(other.supabase, 'sector').length, 0);

  const yesAgain = await record({ key: 'confirm', answer: YES, admin: fakeDb(ledgerRows(YES_FACT)) });
  assert.equal(clears(yesAgain.supabase, 'sector').length, 0, 'a yes after a yes takes nothing back');

  const off = fakeDb({});
  const offOutcome = await recordSetupAnswer({
    supabase: off.client,
    admin: fakeDb(ledgerRows(YES_FACT)).client,
    user: USER,
    adaptiveOn: false,
    business: { id: 'biz-1', name: 'سلطان' },
    account: ACCOUNT,
    answer: { key: 'confirm', choice: 'no' },
  });
  assert.ok(offOutcome.ok);
  assert.equal(clears(off, 'sector').length, 0);

  const failing = fakeDb({}, { failWrite: (query) => query.table === 'businesses' });
  const failed = await recordSetupAnswer({
    supabase: failing.client,
    admin: fakeDb(ledgerRows(YES_FACT)).client,
    user: USER,
    adaptiveOn: true,
    business: { id: 'biz-1', name: 'سلطان' },
    account: ACCOUNT,
    answer: answerOf('confirm', { choice: 'no' }),
  });
  assert.ok(failed.ok, 'the no writes no business column itself, so a business that cannot be written does not fail it');
});

test('S5: isFallbackBusinessName', () => {
  assert.equal(isFallbackBusinessName('سلطان', USER), true);
  assert.equal(isFallbackBusinessName('owner', USER), true);
  assert.equal(isFallbackBusinessName('نشاطي', USER), true);
  assert.equal(isFallbackBusinessName('   ', USER), true);
  assert.equal(isFallbackBusinessName('Smile Clinic', USER), false);
  assert.equal(isFallbackBusinessName('owner', { id: 'u2' }), false, 'no email, no local part to match');
});

// ---------------------------------------------------------------------------
// S6: the signals route reads the account the screen shows
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-14T10:00:00.000Z');

function signalsRequest(overrides: Partial<Parameters<typeof runSignalsRequest>[0]> = {}, accountRows?: (query: FakeQuery) => unknown[]) {
  const rls = fakeDb({
    google_ads_accounts:
      accountRows ??
      ((query: FakeQuery) =>
        eqValue(query, 'id') === 'acc-cookie'
          ? [{ id: 'acc-cookie', customer_id: '2222222222', currency_code: 'SAR', manager_id: null, refresh_token_encrypted: 'enc' }]
          : []),
  });
  const admin = fakeDb({ job_runs: [] });
  const reads: Array<{ id: string }> = [];
  const emails: Array<string | null> = [];
  const read = (async (args: { account: { id: string }; connectedEmail: string | null }) => {
    reads.push(args.account);
    emails.push(args.connectedEmail);
    return { ok: true as const, signals: clinicAccount({ readAt: NOW.toISOString() }), saved: true };
  }) as never;
  return {
    rls,
    admin,
    reads,
    emails,
    run: () =>
      runSignalsRequest({
        supabase: rls.client,
        admin: admin.client,
        user: { id: 'u1', email: 'owner@example.com' },
        workspace: { business: { id: 'biz-1' }, selectedAccount: { id: 'acc-cookie' } },
        now: NOW,
        read,
        ...overrides,
      }),
  };
}

test('S6: the account read and stored is the one the workspace selected, found by its own id and the caller\'s business', async () => {
  const request = signalsRequest();
  const result = await request.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.fresh, true);
  assert.equal(result.body.okSignals, countOkSignals(clinicAccount()), 'how many of the twelve signals read fine');
  assert.deepEqual(request.emails, ['owner@example.com'], 'the editors are compared with the signed-in email');
  assert.deepEqual(request.reads, [{ id: 'acc-cookie', customer_id: '2222222222', currency_code: 'SAR', manager_id: null, refresh_token_encrypted: 'enc' }]);
  const lookup = request.rls.reads().find((query) => query.table === 'google_ads_accounts')!;
  assert.equal(eqValue(lookup, 'id'), 'acc-cookie');
  assert.equal(eqValue(lookup, 'business_id'), 'biz-1');
  assert.equal(eqValue(lookup, 'status'), 'active');
  const stored = request.admin.reads().find((query) => query.table === 'job_runs')!;
  assert.equal(eqValue(stored, 'job_name'), 'onboarding_signals:acc-cookie');
});

test('S6: a fresh stored read of that account answers without reading Google again', async () => {
  const request = signalsRequest({ admin: fakeDb({ job_runs: [signalsRow(clinicAccount({ readAt: NOW.toISOString() }))] }).client });
  const result = await request.run();
  assert.deepEqual(result, { status: 200, body: { ok: true, fresh: false } });
  assert.equal(request.reads.length, 0);
});

test('S6: no business, no selected account, an account that is not the caller\'s, no service client and failed reads each answer as before', async () => {
  const request = signalsRequest();
  assert.deepEqual(await signalsRequest({ workspace: { business: null, selectedAccount: null } }).run(), { status: 409, body: { error: 'no_business' } });
  assert.deepEqual(await signalsRequest({ workspace: { business: { id: 'biz-1' }, selectedAccount: null } }).run(), { status: 409, body: { error: 'no_account' } });
  assert.deepEqual(
    await signalsRequest({ workspace: { business: { id: 'biz-1' }, selectedAccount: { id: 'acc-other' } } }).run(),
    { status: 409, body: { error: 'no_account' } },
    'the lookup found nothing for this id under this business'
  );
  assert.deepEqual(await signalsRequest({ admin: null }).run(), { status: 503, body: { error: 'service_unavailable' } });
  assert.deepEqual(
    await signalsRequest({ read: (async () => ({ ok: false as const, error: 'client_unavailable' })) as never }).run(),
    { status: 503, body: { error: 'client_unavailable' } }
  );
  assert.deepEqual(
    await signalsRequest({ read: (async () => ({ ok: true as const, signals: clinicAccount(), saved: false })) as never }).run(),
    { status: 500, body: { error: 'save_failed' } }
  );
  assert.equal(request.reads.length, 0);
});
