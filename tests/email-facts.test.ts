import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { loadEmailFacts } from '../lib/lifecycle/facts';
import { cleanHighlightLine, firstNameOf, highlightsFrom, toLatinDigits } from '../lib/lifecycle/facts/text';
import { EMPTY_FACTS, type FactNeed } from '../lib/lifecycle/types';
import { signalsJobName } from '../lib/setup/adaptive/signals-store';
import { createFakeAdmin } from './support/fake-admin';
import { signalsRow, untrackedAccount } from './fixtures/adaptive-accounts';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const USER = { id: 'u1', name: 'أيمن أمين' };
const NO_ADAPTIVE = { CHAT_FIRST_ENTRY: 'true' };

type Rows = Record<string, Record<string, unknown>[]>;

/** One clinic with one active account, three open decisions and a 58-point audit. */
function baseTables(): Rows {
  return {
    users: [{ id: 'u1', email: 'owner@example.test', name: 'أيمن أمين' }],
    businesses: [
      {
        id: 'b1',
        user_id: 'u1',
        name: 'عيادة الابتسامة',
        sector: 'clinic',
        selected_google_ads_customer_id: '1111111111',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    google_ads_accounts: [
      { id: 'acc1', business_id: 'b1', customer_id: '1111111111', customer_name: 'حساب العيادة', status: 'active', is_manager: false, currency_code: 'SAR', linked_at: '2026-09-02T00:00:00Z' },
      { id: 'acc2', business_id: 'b1', customer_id: '2222222222', customer_name: 'حساب قديم', status: 'revoked', is_manager: false, currency_code: 'USD', linked_at: '2026-09-03T00:00:00Z' },
      { id: 'accM', business_id: 'b1', customer_id: '3333333333', customer_name: 'حساب المدير', status: 'active', is_manager: true, currency_code: 'SAR', linked_at: '2026-09-04T00:00:00Z' },
    ],
    audits: [
      { account_id: 'acc1', health_score: 58, estimated_monthly_waste: 1840, ran_at: '2026-10-13T07:00:00Z' },
      { account_id: 'acc1', health_score: 40, estimated_monthly_waste: 999, ran_at: '2026-10-01T07:00:00Z' },
    ],
    recommendations: [
      { id: 'r1', account_id: 'acc1', status: 'pending', severity: 'critical', title: 'أوقف الكلمات الخاسرة', category: 'keywords', created_at: '2026-10-13T08:00:00Z' },
      { id: 'r2', account_id: 'acc1', status: 'pending', severity: 'medium', title: 'ارفع ميزانية حملة البحث', category: 'budget', created_at: '2026-10-12T08:00:00Z' },
      { id: 'r3', account_id: 'acc1', status: 'pending', severity: 'growth', title: 'أضف كلمات سلبية', category: 'keywords', created_at: '2026-10-11T08:00:00Z' },
      { id: 'r4', account_id: 'acc1', status: 'dismissed', severity: 'critical', title: 'قرار قديم', category: 'ads', created_at: '2026-10-10T08:00:00Z' },
      { id: 'r9', account_id: 'acc9', status: 'pending', severity: 'critical', title: 'حساب ثاني', category: 'ads', created_at: '2026-10-13T09:00:00Z' },
    ],
    subscriptions: [],
    ai_actions: [],
    reports: [],
  };
}

function admin(tables: Rows = baseTables()) {
  return createFakeAdmin(tables);
}

/** Wraps an admin so tests can count queries per table and make chosen tables fail. */
function watched(base: ReturnType<typeof createFakeAdmin>, failing: Record<string, 'error' | 'throw'> = {}) {
  const queried: string[] = [];
  const failingQuery = (): any => {
    const chain: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement' } }).then(resolve);
          }
          return () => chain;
        },
      }
    );
    return chain;
  };
  const client = {
    ...base,
    from(table: string) {
      queried.push(table);
      if (failing[table] === 'throw') throw new Error('connection reset');
      if (failing[table] === 'error') return failingQuery();
      return base.from(table);
    },
  };
  return { client, queried };
}

function quietly<T>(run: (errors: unknown[][]) => Promise<T>): Promise<T> {
  const errors: unknown[][] = [];
  const spy = mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  return run(errors).finally(() => spy.mock.restore());
}

const load = (client: unknown, needs: FactNeed[], extra: { env?: Record<string, string | undefined> } = {}) =>
  loadEmailFacts(client, USER, needs, { now: NOW, env: NO_ADAPTIVE, ...extra });

// ---------------------------------------------------------------------------
// firstName
// ---------------------------------------------------------------------------

test('firstName: the first word of the name, trimmed', () => {
  assert.equal(firstNameOf('أيمن أمين'), 'أيمن');
  assert.equal(firstNameOf('  Sara   Ahmed '), 'Sara');
  assert.equal(firstNameOf('Noura'), 'Noura');
  assert.equal(firstNameOf('عبد الله'), 'عبد', 'the first word, as the contract says');
  assert.equal(firstNameOf('‏محمد‏ العتيبي'), 'محمد', 'bidi marks do not become part of the name');
});

test('firstName: nothing usable gives null, never a guess', () => {
  assert.equal(firstNameOf(null), null);
  assert.equal(firstNameOf(undefined), null);
  assert.equal(firstNameOf(''), null);
  assert.equal(firstNameOf('   \n\t '), null);
  assert.equal(firstNameOf('12345'), null, 'no letter in it');
  assert.equal(firstNameOf('ن'), null, 'one character is an initial, not a name');
  assert.equal(firstNameOf('john@example.com'), null, 'an email pasted as a name');
  assert.equal(firstNameOf('<b>Ali</b>'), null, 'markup');
  assert.equal(firstNameOf('🔥🔥🔥'), null);
});

test('firstName: edge punctuation is trimmed and the length limit is 40 characters', () => {
  assert.equal(firstNameOf('"Ali"'), 'Ali');
  assert.equal(firstNameOf('🔥Ali'), 'Ali');
  assert.equal(firstNameOf('Ali,'), 'Ali');
  assert.equal(firstNameOf('ab'), 'ab');
  assert.equal(firstNameOf('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(firstNameOf('a'.repeat(41)), null);
  assert.equal(firstNameOf(`${'ع'.repeat(41)} الغامدي`), null, 'a long first word is not shortened, it is dropped');
});

// ---------------------------------------------------------------------------
// highlights
// ---------------------------------------------------------------------------

test('highlights: markdown, bullets, dashes and Arabic digits are cleaned; at most three lines', () => {
  const lines = highlightsFrom({
    highlights: [
      '**ارتفع** إنفاق «حملة البحث» ٣٠٠ ر.س — وزادت التحويلات',
      '- زادت التحويلات إلى ٤١ تحويل',
      '1. قلّ الهدر في [الكلمات الواسعة](https://example.test/x).',
      'سطر رابع ما ينعرض',
    ],
  });
  assert.deepEqual(lines, [
    'ارتفع إنفاق «حملة البحث» 300 ر.س، وزادت التحويلات',
    'زادت التحويلات إلى 41 تحويل',
    'قلّ الهدر في الكلمات الواسعة.',
  ]);
});

test('highlights: empty, repeated and non-text entries are skipped', () => {
  assert.deepEqual(highlightsFrom({ highlights: ['', '   ', 42, null, 'نفس السطر', 'نفس السطر', '## عنوان'] }), ['نفس السطر', 'عنوان']);
  assert.deepEqual(highlightsFrom({}), []);
  assert.deepEqual(highlightsFrom({ highlights: 'not a list' }), []);
});

test('highlights: a line of 140 characters or more becomes its first sentence, or is dropped, never cut', () => {
  const long = `${'كلمة '.repeat(10).trim()}. ${'كلمة '.repeat(40).trim()}.`;
  assert.ok(long.length >= 140);
  assert.deepEqual(highlightsFrom({ highlights: [long] }), [`${'كلمة '.repeat(10).trim()}.`]);

  const noSentence = 'كلمة '.repeat(40).trim();
  assert.ok(noSentence.length >= 140);
  assert.deepEqual(highlightsFrom({ highlights: [noSentence] }), []);

  const justUnder = 'ا'.repeat(139);
  assert.deepEqual(highlightsFrom({ highlights: [justUnder] }), [justUnder]);
  assert.equal(cleanHighlightLine('ا'.repeat(140)), null);
});

test('highlights: without a bullet list the summary is split into sentences without breaking «ر.س» or 1.5', () => {
  const lines = highlightsFrom({
    highlights: [],
    summary: 'ارتفع الإنفاق إلى 3,200 ر.س هذا الأسبوع. التحويلات 41 بتكلفة 1.5 أقل من قبل! هل نكمل؟ نعم',
  });
  assert.deepEqual(lines, [
    'ارتفع الإنفاق إلى 3,200 ر.س هذا الأسبوع.',
    'التحويلات 41 بتكلفة 1.5 أقل من قبل!',
    'هل نكمل؟',
  ]);
});

test('highlights: a list whose every line is unusable falls back to the summary', () => {
  const tooLong = 'كلمة '.repeat(40).trim();
  assert.deepEqual(highlightsFrom({ highlights: [tooLong], summary: 'الأسبوع هادي. ما تغير شي.' }), ['الأسبوع هادي.', 'ما تغير شي.']);
});

test('toLatinDigits turns Arabic-Indic and Persian digits into Latin ones', () => {
  assert.equal(toLatinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ 5'), '0123456789 0123456789 5');
});

// ---------------------------------------------------------------------------
// what is read
// ---------------------------------------------------------------------------

test('with no needs only the business is read, and the onboarding name is the business name', async () => {
  const { client, queried } = watched(admin());
  const facts = await load(client, []);
  assert.deepEqual(queried, ['businesses']);
  assert.deepEqual(facts, { ...EMPTY_FACTS, firstName: 'أيمن', businessName: 'عيادة الابتسامة' });
});

test('each need reads only its own tables', async () => {
  const cases: Array<[FactNeed[], string[]]> = [
    [['billing'], ['businesses', 'subscriptions']],
    [['plan'], ['businesses', 'google_ads_accounts', 'audits', 'recommendations']],
    [['weekly'], ['businesses', 'google_ads_accounts', 'reports', 'recommendations']],
    [['trial'], ['businesses', 'subscriptions']],
  ];
  for (const [needs, expected] of cases) {
    const { client, queried } = watched(admin());
    await load(client, needs);
    assert.deepEqual([...new Set(queried)].sort(), [...expected].sort(), `needs ${needs.join(',')}`);
  }
});

test('trial reads approvals and open decisions only when a trial subscription exists', async () => {
  const tables = baseTables();
  tables.subscriptions = [{ user_id: 'u1', plan: 'starter', status: 'trialing', created_at: '2026-10-10T08:00:00Z', trial_ends_at: '2026-10-24T08:00:00Z' }];
  const { client, queried } = watched(admin(tables));
  await load(client, ['trial']);
  assert.deepEqual([...new Set(queried)].sort(), ['ai_actions', 'businesses', 'google_ads_accounts', 'recommendations', 'subscriptions']);
});

test('the open-decisions count is read once when trial and weekly both need it', async () => {
  const tables = baseTables();
  tables.subscriptions = [{ user_id: 'u1', plan: 'starter', status: 'trialing', created_at: '2026-10-10T08:00:00Z', trial_ends_at: '2026-10-24T08:00:00Z' }];
  const { client, queried } = watched(admin(tables));
  await load(client, ['trial', 'weekly']);
  assert.equal(queried.filter((table) => table === 'recommendations').length, 1);
});

// ---------------------------------------------------------------------------
// businessName
// ---------------------------------------------------------------------------

test('businessName: a business with no onboarding answers falls back to the selected account name', async () => {
  const tables = baseTables();
  (tables.businesses[0] as any).sector = null;
  (tables.businesses[0] as any).name = 'اسم تلقائي من الدخول';
  const facts = await load(admin(tables), []);
  assert.equal(facts.businessName, 'حساب العيادة', 'the login name placeholder is never used as a business name');
});

test('businessName: a generated account name, no account or no business gives null', async () => {
  const generated = baseTables();
  (generated.businesses[0] as any).sector = null;
  (generated.google_ads_accounts[0] as any).customer_name = 'Google Ads 111-111-1111';
  assert.equal((await load(admin(generated), [])).businessName, null);

  const noAccount = baseTables();
  (noAccount.businesses[0] as any).sector = null;
  noAccount.google_ads_accounts = [];
  assert.equal((await load(admin(noAccount), [])).businessName, null);

  const noBusiness = baseTables();
  noBusiness.businesses = [];
  const facts = await load(admin(noBusiness), ['plan', 'trial', 'weekly', 'billing']);
  assert.deepEqual(facts, { ...EMPTY_FACTS, firstName: 'أيمن' });
});

test('businessName: the selected account is the persisted one, else the newest active client account, never a manager', async () => {
  const tables = baseTables();
  (tables.businesses[0] as any).sector = null;
  (tables.businesses[0] as any).selected_google_ads_customer_id = null;
  tables.google_ads_accounts.push({ id: 'acc3', business_id: 'b1', customer_id: '4444444444', customer_name: 'الأحدث ربطاً', status: 'active', is_manager: false, currency_code: 'SAR', linked_at: '2026-10-01T00:00:00Z' });
  assert.equal((await load(admin(tables), [])).businessName, 'الأحدث ربطاً');

  (tables.businesses[0] as any).selected_google_ads_customer_id = '1111111111';
  assert.equal((await load(admin(tables), [])).businessName, 'حساب العيادة');
});

test('businessName: a business read that fails gives null and does not throw', async () => {
  await quietly(async (errors) => {
    const { client } = watched(admin(), { businesses: 'error' });
    const facts = await load(client, ['plan']);
    assert.deepEqual(facts, { ...EMPTY_FACTS, firstName: 'أيمن' });
    assert.equal(errors.length, 1);
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

test('plan: counts, first title, waste and currency are what the plan screen computes', async () => {
  const facts = await load(admin(), ['plan']);
  assert.deepEqual(facts.plan, {
    decisionsTotal: 3,
    lockedCount: 2,
    firstDecisionTitle: 'أوقف الكلمات الخاسرة',
    wasteEstimate: 1840,
    currency: 'SAR',
  });
  assert.equal(facts.trial, null);
  assert.equal(facts.weekly, null);
  assert.equal(facts.billing, null);
});

test('plan: the account currency is used as is', async () => {
  const tables = baseTables();
  (tables.google_ads_accounts[0] as any).currency_code = 'usd';
  assert.equal((await load(admin(tables), ['plan'])).plan?.currency, 'USD');
});

test('plan: a missing or zero waste estimate is null, never a made-up number', async () => {
  const noWaste = baseTables();
  (noWaste.audits[0] as any).estimated_monthly_waste = null;
  assert.equal((await load(admin(noWaste), ['plan'])).plan?.wasteEstimate, null);

  const zero = baseTables();
  (zero.audits[0] as any).estimated_monthly_waste = 0;
  assert.equal((await load(admin(zero), ['plan'])).plan?.wasteEstimate, null, 'the screen never shows «0»');

  const text = baseTables();
  (text.audits[0] as any).estimated_monthly_waste = '412.5';
  assert.equal((await load(admin(text), ['plan'])).plan?.wasteEstimate, 412.5);
});

test('plan: an audit with nothing to decide is a plan with zero decisions; no audit at all is no plan', async () => {
  const none = baseTables();
  none.recommendations = [];
  assert.deepEqual((await load(admin(none), ['plan'])).plan, {
    decisionsTotal: 0,
    lockedCount: 0,
    firstDecisionTitle: null,
    wasteEstimate: 1840,
    currency: 'SAR',
  });

  const noAudit = baseTables();
  noAudit.audits = [];
  noAudit.recommendations = [];
  assert.equal((await load(admin(noAudit), ['plan'])).plan, null, 'the screen says «ما جهزت خطتك للحين»: nothing to talk about');

  const decisionsOnly = baseTables();
  decisionsOnly.audits = [];
  const partial = (await load(admin(decisionsOnly), ['plan'])).plan;
  assert.equal(partial?.decisionsTotal, 3, 'decisions without an audit row still make the screen show a plan');
  assert.equal(partial?.wasteEstimate, null, 'and there is no waste number without an audit');

  const noAccount = baseTables();
  noAccount.google_ads_accounts = [];
  assert.equal((await load(admin(noAccount), ['plan'])).plan, null);
});

test('plan: only pending and approved decisions of the selected account count', async () => {
  const tables = baseTables();
  tables.recommendations.push({ id: 'r6', account_id: 'acc1', status: 'applied', severity: 'critical', title: 'تم تنفيذه', created_at: '2026-10-13T10:00:00Z' });
  tables.recommendations.push({ id: 'r7', account_id: 'acc1', status: 'pending', severity: 'critical', title: '   ', created_at: '2026-10-13T11:00:00Z' });
  const facts = await load(admin(tables), ['plan']);
  assert.equal(facts.plan?.decisionsTotal, 3, 'applied, dismissed, other accounts and blank titles are not in the plan');
});

test('plan: any failed read makes the plan null and is logged once', async () => {
  for (const table of ['audits', 'recommendations', 'google_ads_accounts'] as const) {
    await quietly(async (errors) => {
      const { client } = watched(admin(), { [table]: 'error' });
      const facts = await load(client, ['plan']);
      assert.equal(facts.plan, null, `${table} failing`);
      assert.equal(errors.length, 1, `${table} logged once`);
    });
  }
  await quietly(async () => {
    const { client } = watched(admin(), { audits: 'throw' });
    assert.equal((await load(client, ['plan'])).plan, null, 'a thrown read is a failed read');
  });
});

test('plan: with the adaptive onboarding on, the plan is the one the lock shows (rules decision first, no waste without tracking)', async () => {
  const tables = baseTables();
  tables.job_runs = [
    {
      job_name: signalsJobName('acc1'),
      status: 'success',
      started_at: '2026-10-14T09:00:00Z',
      details: signalsRow(untrackedAccount({ readAt: NOW.toISOString() })).details,
    },
  ];
  const adaptiveEnv = { CHAT_FIRST_ENTRY: 'true', ADAPTIVE_ONBOARDING: 'true' };

  const on = await load(admin(tables), ['plan'], { env: adaptiveEnv });
  assert.deepEqual(on.plan, {
    decisionsTotal: 3,
    lockedCount: 3,
    firstDecisionTitle: 'ركّب تتبع النتائج قبل أي تعديل',
    wasteEstimate: null,
    currency: 'SAR',
  });

  const off = await load(admin(tables), ['plan'], { env: NO_ADAPTIVE });
  assert.deepEqual(off.plan, {
    decisionsTotal: 3,
    lockedCount: 2,
    firstDecisionTitle: 'أوقف الكلمات الخاسرة',
    wasteEstimate: 1840,
    currency: 'SAR',
  });
});

test('plan: adaptive on but the user email cannot be read gives null instead of a guess', async () => {
  await quietly(async () => {
    const { client } = watched(admin(), { users: 'error' });
    const facts = await load(client, ['plan'], { env: { CHAT_FIRST_ENTRY: 'true', ADAPTIVE_ONBOARDING: 'true' } });
    assert.equal(facts.plan, null);
  });
});

// ---------------------------------------------------------------------------
// trial
// ---------------------------------------------------------------------------

function trialTables(): Rows {
  const tables = baseTables();
  tables.subscriptions = [
    { user_id: 'u1', plan: 'starter', status: 'trialing', created_at: '2026-10-10T08:00:00Z', trial_ends_at: '2026-10-24T08:00:00Z' },
    { user_id: 'u1', plan: 'growth', status: 'canceled', created_at: '2026-06-01T08:00:00Z', trial_ends_at: null },
    { user_id: 'u2', plan: 'pro', status: 'trialing', created_at: '2026-10-12T08:00:00Z', trial_ends_at: '2026-10-26T08:00:00Z' },
  ];
  tables.ai_actions = [
    { id: 'aa1', account_id: 'acc1', action_type: 'approval_queued', recommendation_id: 'r1', created_at: '2026-10-11T09:00:00Z' },
    { id: 'aa2', account_id: 'acc1', action_type: 'approval_queued', recommendation_id: 'r2', created_at: '2026-10-12T09:00:00Z' },
    { id: 'aa3', account_id: 'acc1', action_type: 'approval_queued', recommendation_id: 'r1', created_at: '2026-10-13T09:00:00Z' },
    { id: 'aa4', account_id: 'acc1', action_type: 'approval_queued', recommendation_id: 'r3', created_at: '2026-10-09T09:00:00Z' },
    { id: 'aa5', account_id: 'acc9', action_type: 'approval_queued', recommendation_id: 'rZ', created_at: '2026-10-12T09:00:00Z' },
    { id: 'aa6', account_id: 'acc1', action_type: 'add_negative_keyword', recommendation_id: 'r3', created_at: '2026-10-12T09:00:00Z' },
  ];
  return tables;
}

test('trial: dates, whole days left, approvals since the trial started and decisions waiting now', async () => {
  const facts = await load(admin(trialTables()), ['trial']);
  // Hand count: ends 24 Oct 08:00 UTC, now 14 Oct 10:00 UTC: 9 days 22 hours left -> 10 (rounded up, the last partial day counts).
  // Approved since 10 Oct 08:00: r1 (11 Oct, again on 13 Oct, one recommendation) and r2 = 2.
  //   Not counted: r3 approved on 9 Oct (before the trial), another account, another action type.
  // Waiting now on acc1: r1, r2, r3 pending = 3 (dismissed r4 and the other account's r9 are not).
  assert.deepEqual(facts.trial, {
    startedAt: '2026-10-10T08:00:00Z',
    endsAt: '2026-10-24T08:00:00Z',
    daysLeft: 10,
    approvedCount: 2,
    pendingCount: 3,
  });
});

test('trial: the trial of another user and the plan fact are not mixed in', async () => {
  const facts = await load(admin(trialTables()), ['trial']);
  assert.equal(facts.plan, null);
  assert.equal(facts.billing, null);
  assert.equal(facts.trial?.startedAt, '2026-10-10T08:00:00Z');
});

test('trial: daysLeft is whole days remaining rounded up, never negative, and null without an end date', async () => {
  const daysLeft = async (endsAt: string | null) => {
    const tables = trialTables();
    (tables.subscriptions[0] as any).trial_ends_at = endsAt;
    return (await load(admin(tables), ['trial'])).trial;
  };
  assert.equal((await daysLeft('2026-10-15T09:59:59Z'))?.daysLeft, 1, '23h59m left is 1 day, not "0 days left"');
  assert.equal((await daysLeft('2026-10-15T10:00:00Z'))?.daysLeft, 1, 'exactly 24h left');
  assert.equal((await daysLeft('2026-10-15T10:00:01Z'))?.daysLeft, 2, 'a second over one day');
  assert.equal((await daysLeft('2026-10-14T10:30:00Z'))?.daysLeft, 1, '30 minutes left still shows the last day');
  assert.equal((await daysLeft('2026-10-14T10:00:00Z'))?.daysLeft, 0, 'ends right now');
  assert.equal((await daysLeft('2026-10-13T10:00:00Z'))?.daysLeft, 0, 'already over, never negative');
  const open = await daysLeft(null);
  assert.equal(open?.daysLeft, null);
  assert.equal(open?.endsAt, null);
});

test('trial: decisions waiting now include approved ones that are not executed yet, as /home lists them', async () => {
  const tables = trialTables();
  tables.recommendations.push(
    { id: 'r5', account_id: 'acc1', status: 'approved', severity: 'medium', title: 'وافقت عليه', category: 'ads', created_at: '2026-10-13T12:00:00Z' },
    { id: 'r6', account_id: 'acc1', status: 'applied', severity: 'medium', title: 'نُفّذ', category: 'ads', created_at: '2026-10-13T12:00:00Z' },
    { id: 'r7', account_id: 'acc1', status: 'executing', severity: 'medium', title: 'يُنفّذ', category: 'ads', created_at: '2026-10-13T12:00:00Z' },
    { id: 'r8', account_id: 'acc9', status: 'approved', severity: 'medium', title: 'حساب ثاني', category: 'ads', created_at: '2026-10-13T12:00:00Z' }
  );
  const facts = await load(admin(tables), ['trial']);
  // r1, r2, r3 pending + r5 approved. Applied, executing and another account's rows are not waiting for the user.
  assert.equal(facts.trial?.pendingCount, 4);
});

test('trial: no trialing subscription is null (a canceled or active one is not a trial)', async () => {
  const none = baseTables();
  assert.equal((await load(admin(none), ['trial'])).trial, null);

  const tables = baseTables();
  tables.subscriptions = [
    { user_id: 'u1', plan: 'growth', status: 'active', created_at: '2026-09-01T08:00:00Z', trial_ends_at: null },
    { user_id: 'u1', plan: 'starter', status: 'canceled', created_at: '2026-08-01T08:00:00Z', trial_ends_at: '2026-08-15T08:00:00Z' },
  ];
  assert.equal((await load(admin(tables), ['trial'])).trial, null);
});

test('trial: the latest trialing subscription wins', async () => {
  const tables = trialTables();
  tables.subscriptions.push({ user_id: 'u1', plan: 'starter', status: 'trialing', created_at: '2026-10-13T08:00:00Z', trial_ends_at: '2026-10-27T08:00:00Z' });
  const facts = await load(admin(tables), ['trial']);
  assert.equal(facts.trial?.startedAt, '2026-10-13T08:00:00Z');
  assert.equal(facts.trial?.approvedCount, 1, 'only the 13 Oct approval is after this trial start');
});

test('trial: a trialing user with no linked account has nothing to approve, which is a true 0, not a missing value', async () => {
  const tables = trialTables();
  tables.google_ads_accounts = [];
  const facts = await load(admin(tables), ['trial']);
  assert.equal(facts.trial?.approvedCount, 0);
  assert.equal(facts.trial?.pendingCount, 0);
  assert.equal(facts.trial?.daysLeft, 10);
});

test('trial: any failed read makes the trial null and is logged once', async () => {
  for (const table of ['subscriptions', 'ai_actions', 'recommendations', 'google_ads_accounts', 'businesses'] as const) {
    await quietly(async (errors) => {
      const { client } = watched(admin(trialTables()), { [table]: 'error' });
      const facts = await load(client, ['trial']);
      assert.equal(facts.trial, null, `${table} failing`);
      assert.equal(errors.length, 1, `${table} logged once`);
    });
  }
});

// ---------------------------------------------------------------------------
// weekly
// ---------------------------------------------------------------------------

const weeklyMetrics = () => ({
  kind: 'weekly_performance',
  currency_code: 'SAR',
  totals: {
    this_week: { cost: 3200.5, clicks: 900, conversions: 41, conversion_value: 9000 },
    prior_week: { cost: 2900, clicks: 800, conversions: 33, conversion_value: 7000 },
    delta: { cost: 300.5, clicks: 100, conversions: 8, conversion_value: 2000, cpa_this: 78.06, cpa_prior: 87.88 },
  },
  highlights_ar: [
    '**ارتفع** إنفاق «حملة البحث» ٣٠٠ ر.س — وزادت التحويلات',
    '- زادت التحويلات إلى ٤١ تحويل',
    '1. قلّ الهدر في الكلمات الواسعة.',
    'سطر رابع ما ينعرض',
  ],
});

function weeklyTables(): Rows {
  const tables = baseTables();
  tables.reports = [
    { id: 'w1', account_id: 'acc1', period_type: 'weekly', period_start: '2026-10-07', period_end: '2026-10-14', generated_at: '2026-10-14T03:00:00Z', summary_ar: 'ارتفع الإنفاق. النتائج أفضل.', metrics: weeklyMetrics() },
    { id: 'w0', account_id: 'acc1', period_type: 'weekly', period_start: '2026-09-28', period_end: '2026-10-05', generated_at: '2026-10-05T03:00:00Z', summary_ar: 'أسبوع قديم', metrics: { ...weeklyMetrics(), totals: { this_week: { cost: 1, conversions: 1 }, prior_week: { cost: 1, conversions: 1 } } } },
    { id: 'wa', account_id: 'acc1', period_type: 'custom', period_start: '2026-10-14', period_end: '2026-10-14', generated_at: '2026-10-14T05:00:00Z', summary_ar: 'ملخص فحص', metrics: { kind: 'audit_summary' } },
    { id: 'wk', account_id: 'acc1', period_type: 'weekly', period_start: '2026-10-07', period_end: '2026-10-14', generated_at: '2026-10-14T06:00:00Z', summary_ar: 'نوع ثاني', metrics: { kind: 'something_else', totals: { this_week: { cost: 5, conversions: 5 } } } },
    { id: 'wo', account_id: 'acc9', period_type: 'weekly', period_start: '2026-10-07', period_end: '2026-10-14', generated_at: '2026-10-14T07:00:00Z', summary_ar: 'حساب ثاني', metrics: { ...weeklyMetrics(), totals: { this_week: { cost: 7, conversions: 7 }, prior_week: { cost: 7, conversions: 7 } } } },
  ];
  return tables;
}

test('weekly: the latest weekly_performance report of the selected account, its numbers, three clean highlights and the waiting decisions', async () => {
  const facts = await load(admin(weeklyTables()), ['weekly']);
  assert.deepEqual(facts.weekly, {
    // Generated 14 Oct 03:00 UTC = 06:00 Riyadh: the data is the 7 days that ended on 13 Oct, whatever period_end says.
    periodStart: '2026-10-07',
    periodEnd: '2026-10-13',
    currency: 'SAR',
    spend: 3200.5,
    conversions: 41,
    costPerConversion: 78.06,
    prevSpend: 2900,
    prevConversions: 33,
    highlights: [
      'ارتفع إنفاق «حملة البحث» 300 ر.س، وزادت التحويلات',
      'زادت التحويلات إلى 41 تحويل',
      'قلّ الهدر في الكلمات الواسعة.',
    ],
    pendingCount: 3,
  });
});

test('weekly: another kind, another account or no account is not this week\'s report', async () => {
  const tables = weeklyTables();
  tables.reports = tables.reports.filter((row) => row.id !== 'w1');
  assert.equal((await load(admin(tables), ['weekly'])).weekly, null);

  const none = baseTables();
  assert.equal((await load(admin(none), ['weekly'])).weekly, null);

  const noAccount = weeklyTables();
  noAccount.google_ads_accounts = [];
  assert.equal((await load(admin(noAccount), ['weekly'])).weekly, null);
});

test('weekly: only a report generated in the current Saudi week counts, not last week\'s even when it is under 8 days old', async () => {
  // NOW is Wednesday 14 Oct 10:00 UTC; the Saudi week began on Saturday 10 Oct 00:00 UTC.
  const only = (generatedAt: string, summary = 'تقرير') => {
    const tables = weeklyTables();
    tables.reports = [
      { id: 'x', account_id: 'acc1', period_type: 'weekly', period_start: '2026-10-03', period_end: '2026-10-10', generated_at: generatedAt, summary_ar: summary, metrics: weeklyMetrics() },
    ];
    return load(admin(tables), ['weekly']);
  };
  assert.equal((await only('2026-10-09T23:59:59Z')).weekly, null, 'Friday night: last week\'s report, 4 days old');
  assert.equal((await only('2026-10-06T03:00:00Z')).weekly, null, '8 days old and previous week');
  assert.ok((await only('2026-10-10T00:00:00Z')).weekly, 'Saturday 00:00 UTC is the first instant of this week');
  assert.ok((await only('2026-10-10T03:47:00Z')).weekly, 'the normal case: written Saturday morning, mailed Sunday 09:00 Riyadh');

  // A fresh and a stale report side by side: the fresh one is used.
  const both = weeklyTables();
  both.reports = [
    { id: 'old', account_id: 'acc1', period_type: 'weekly', period_start: '2026-10-03', period_end: '2026-10-10', generated_at: '2026-10-09T20:00:00Z', summary_ar: 'قديم', metrics: { ...weeklyMetrics(), totals: { this_week: { cost: 1, conversions: 1 }, prior_week: { cost: 1, conversions: 1 } } } },
    { id: 'new', account_id: 'acc1', period_type: 'weekly', period_start: '2026-10-07', period_end: '2026-10-14', generated_at: '2026-10-11T03:00:00Z', summary_ar: 'جديد', metrics: weeklyMetrics() },
  ];
  assert.equal((await load(admin(both), ['weekly'])).weekly?.spend, 3200.5);
});

test('weekly: on the Sunday slot the report written the day before is this week\'s, last week\'s is not', async () => {
  const sunday = new Date('2026-10-18T06:00:00Z'); // Sunday 09:00 Riyadh
  const run = (generatedAt: string) => {
    const tables = weeklyTables();
    tables.reports = [{ id: 'x', account_id: 'acc1', period_type: 'weekly', generated_at: generatedAt, summary_ar: 'تقرير', metrics: weeklyMetrics() }];
    return loadEmailFacts(admin(tables), USER, ['weekly'], { now: sunday, env: NO_ADAPTIVE });
  };
  assert.ok((await run('2026-10-17T00:47:00Z')).weekly, 'Saturday 00:47 UTC');
  assert.equal((await run('2026-10-16T23:59:00Z')).weekly, null, 'Friday 23:59 UTC is the previous week');
});

test('weekly: a number the stored report does not have is null, and the cost per conversion is computed only from real figures', async () => {
  const noTotals = weeklyTables();
  (noTotals.reports[0] as any).metrics = { kind: 'weekly_performance', highlights_ar: ['سطر واحد'] };
  const bare = (await load(admin(noTotals), ['weekly'])).weekly;
  assert.equal(bare?.spend, null);
  assert.equal(bare?.conversions, null);
  assert.equal(bare?.costPerConversion, null);
  assert.equal(bare?.prevSpend, null);
  assert.equal(bare?.prevConversions, null);
  assert.deepEqual(bare?.highlights, ['سطر واحد']);
  assert.equal(bare?.currency, 'SAR', 'falls back to the account currency');

  const derived = weeklyTables();
  delete (derived.reports[0] as any).metrics.totals.delta;
  // 3200.5 / 41 = 78.0609... -> 78.06
  assert.equal((await load(admin(derived), ['weekly'])).weekly?.costPerConversion, 78.06);

  const noConversions = weeklyTables();
  (noConversions.reports[0] as any).metrics = {
    kind: 'weekly_performance',
    totals: { this_week: { cost: 500, conversions: 0 }, prior_week: { cost: 400, conversions: 2 }, delta: { cpa_this: null } },
  };
  const zero = (await load(admin(noConversions), ['weekly'])).weekly;
  assert.equal(zero?.spend, 500);
  assert.equal(zero?.conversions, 0, 'zero conversions is a real figure');
  assert.equal(zero?.costPerConversion, null, 'no division by zero');
});

test('weekly: highlights fall back to the summary sentences when the narrative has no bullet list', async () => {
  const tables = weeklyTables();
  (tables.reports[0] as any).metrics = { ...weeklyMetrics(), highlights_ar: [] };
  (tables.reports[0] as any).summary_ar = 'ارتفع الإنفاق إلى 3,200 ر.س. التحويلات 41.';
  const weekly = (await load(admin(tables), ['weekly'])).weekly;
  assert.deepEqual(weekly?.highlights, ['ارتفع الإنفاق إلى 3,200 ر.س.', 'التحويلات 41.']);
});

test('weekly: the period is the 7 days the data covers: ending the day before generation, on the Riyadh calendar', async () => {
  const periodOf = async (generatedAt: string, stored: { period_start?: string | null; period_end?: string | null } = {}) => {
    const tables = weeklyTables();
    tables.reports = [{ id: 'x', account_id: 'acc1', period_type: 'weekly', generated_at: generatedAt, summary_ar: 'تقرير', metrics: weeklyMetrics(), ...stored }];
    const weekly = (await load(admin(tables), ['weekly'])).weekly;
    return weekly && { start: weekly.periodStart, end: weekly.periodEnd };
  };
  // Saturday 10 Oct 03:47 UTC (06:47 Riyadh): LAST_7_DAYS is 3..9 Oct.
  assert.deepEqual(await periodOf('2026-10-10T03:47:00Z'), { start: '2026-10-03', end: '2026-10-09' });
  // The stored columns say period_end = the generation day (the cron's labelling); they are not what the data covers.
  assert.deepEqual(
    await periodOf('2026-10-10T03:47:00Z', { period_start: '2026-10-03', period_end: '2026-10-10' }),
    { start: '2026-10-03', end: '2026-10-09' }
  );
  // 13 Oct 21:30 UTC is already 14 Oct 00:30 in Riyadh: the day before is 13 Oct, not 12 Oct.
  assert.deepEqual(await periodOf('2026-10-13T21:30:00Z'), { start: '2026-10-07', end: '2026-10-13' });
});

test('weekly: the period crosses a month and a year boundary correctly', async () => {
  const periodOf = async (generatedAt: string, now: string) => {
    const tables = weeklyTables();
    tables.reports = [{ id: 'x', account_id: 'acc1', period_type: 'weekly', generated_at: generatedAt, summary_ar: 'تقرير', metrics: weeklyMetrics() }];
    const weekly = (await loadEmailFacts(admin(tables), USER, ['weekly'], { now: new Date(now), env: NO_ADAPTIVE })).weekly;
    return weekly && { start: weekly.periodStart, end: weekly.periodEnd };
  };
  // Saturday 2 Jan 2027 03:47 UTC -> covers 26 Dec .. 1 Jan.
  assert.deepEqual(await periodOf('2027-01-02T03:47:00Z', '2027-01-03T06:00:00Z'), { start: '2026-12-26', end: '2027-01-01' });
  // Saturday 3 Oct 2026 -> 26 Sep .. 2 Oct.
  assert.deepEqual(await periodOf('2026-10-03T03:47:00Z', '2026-10-04T06:00:00Z'), { start: '2026-09-26', end: '2026-10-02' });
});

test('weekly: the currency comes from the report, falling back to the account', async () => {
  const tables = weeklyTables();
  (tables.reports[0] as any).metrics = { ...weeklyMetrics(), currency_code: 'usd' };
  assert.equal((await load(admin(tables), ['weekly'])).weekly?.currency, 'USD');
});

test('weekly: decisions waiting include approved ones that are not executed yet, same as /home', async () => {
  const tables = weeklyTables();
  tables.recommendations.push(
    { id: 'r5', account_id: 'acc1', status: 'approved', severity: 'medium', title: 'وافقت عليه', category: 'ads', created_at: '2026-10-13T12:00:00Z' },
    { id: 'r6', account_id: 'acc1', status: 'applied', severity: 'medium', title: 'نُفّذ', category: 'ads', created_at: '2026-10-13T12:00:00Z' },
    { id: 'r8', account_id: 'acc9', status: 'approved', severity: 'medium', title: 'حساب ثاني', category: 'ads', created_at: '2026-10-13T12:00:00Z' }
  );
  assert.equal((await load(admin(tables), ['weekly'])).weekly?.pendingCount, 4, 'r1, r2, r3 pending + r5 approved');

  const onlyApproved = weeklyTables();
  onlyApproved.recommendations = [{ id: 'r5', account_id: 'acc1', status: 'approved', severity: 'medium', title: 'وافقت عليه', category: 'ads', created_at: '2026-10-13T12:00:00Z' }];
  assert.equal((await load(admin(onlyApproved), ['weekly'])).weekly?.pendingCount, 1, 'an approved-only list is not "nothing waiting"');
});

test('weekly: a failed reports or decisions read makes weekly null and is logged once', async () => {
  for (const table of ['reports', 'recommendations'] as const) {
    await quietly(async (errors) => {
      const { client } = watched(admin(weeklyTables()), { [table]: 'error' });
      assert.equal((await load(client, ['weekly'])).weekly, null, `${table} failing`);
      assert.equal(errors.length, 1, `${table} logged once`);
    });
  }
});

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------

test('billing: plan name and trial end of the latest subscription', async () => {
  const facts = await load(admin(trialTables()), ['billing']);
  assert.deepEqual(facts.billing, { planName: 'البداية', trialEndsAt: '2026-10-24T08:00:00Z' });
  assert.equal(facts.trial, null);
});

test('billing: a paid plan has no trial end; no subscription or an unknown plan name is null, not invented', async () => {
  const paid = baseTables();
  paid.subscriptions = [{ user_id: 'u1', plan: 'growth', status: 'active', created_at: '2026-09-01T08:00:00Z', trial_ends_at: null }];
  assert.deepEqual((await load(admin(paid), ['billing'])).billing, { planName: 'النمو', trialEndsAt: null });

  assert.equal((await load(admin(baseTables()), ['billing'])).billing, null);

  const odd = baseTables();
  odd.subscriptions = [{ user_id: 'u1', plan: 'enterprise', status: 'active', created_at: '2026-09-01T08:00:00Z', trial_ends_at: null }];
  assert.deepEqual((await load(admin(odd), ['billing'])).billing, { planName: null, trialEndsAt: null });
});

test('billing: a failed subscriptions read gives null for billing and trial together, logged once', async () => {
  await quietly(async (errors) => {
    const { client } = watched(admin(trialTables()), { subscriptions: 'error' });
    const facts = await load(client, ['billing', 'trial']);
    assert.equal(facts.billing, null);
    assert.equal(facts.trial, null);
    assert.equal(errors.length, 1);
  });
});

// ---------------------------------------------------------------------------
// resilience
// ---------------------------------------------------------------------------

test('it never throws: a client that throws on every call still gives the first name', async () => {
  await quietly(async () => {
    const broken = {
      from() {
        throw new Error('no database');
      },
    };
    const facts = await load(broken, ['plan', 'trial', 'weekly', 'billing']);
    assert.deepEqual(facts, { ...EMPTY_FACTS, firstName: 'أيمن' });

    assert.deepEqual(await load(null, ['plan']), { ...EMPTY_FACTS, firstName: 'أيمن' });
    assert.deepEqual(await load(undefined, []), { ...EMPTY_FACTS, firstName: 'أيمن' });
  });
});

test('every fact together: all four present for a trialing customer', async () => {
  const tables = trialTables();
  tables.reports = weeklyTables().reports;
  const facts = await load(admin(tables), ['plan', 'trial', 'weekly', 'billing']);
  assert.equal(facts.firstName, 'أيمن');
  assert.equal(facts.businessName, 'عيادة الابتسامة');
  assert.equal(facts.plan?.decisionsTotal, 3);
  assert.equal(facts.trial?.approvedCount, 2);
  assert.equal(facts.weekly?.spend, 3200.5);
  assert.equal(facts.billing?.planName, 'البداية');
});

test('the log line for a failed read never carries the name, the email or a number from the data', async () => {
  await quietly(async (errors) => {
    const { client } = watched(admin(), { audits: 'error' });
    await load(client, ['plan']);
    const logged = JSON.stringify(errors);
    assert.ok(!logged.includes('أيمن'));
    assert.ok(!logged.includes('owner@example.test'));
    assert.ok(logged.includes('audits'));
  });
});
