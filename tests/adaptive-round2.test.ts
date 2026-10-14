import assert from 'node:assert/strict';
import test from 'node:test';

import { activityHintFrom, readActivityHint, CACHE_EMPTY_FRESH_HOURS, SPEND_ZERO_FRESH_HOURS } from '../lib/setup/adaptive/activity-hint';
import { adaptivePending, adaptiveQuestion } from '../lib/setup/adaptive/bank';
import { classifyScenario } from '../lib/setup/adaptive/scenario';
import { understandingRows } from '../lib/setup/adaptive/understanding';
import { adaptiveAnswered, answeredOnRecord } from '../lib/setup/adaptive/view';
import type { AccountSignals, ClassifyInput, Scenario } from '../lib/setup/adaptive/types';
import { readLedgerEntries } from '../lib/setup/ledger';
import { keysAnsweredByProfile, missingCoreKeys, TYPE_OPTIONS, type BusinessProfile, type SetupKey } from '../lib/setup/questions';
import { eqValue, fakeDb } from './fixtures/fake-db';
import { account, campaign, clinicAccount, groups, sallaAccount } from './fixtures/adaptive-accounts';

const NOW = new Date('2026-10-14T10:00:00.000Z');

function classify(overrides: Partial<ClassifyInput> = {}): Scenario {
  return classifyScenario({ signals: null, linkedAccounts: 1, connectNoAccount: false, answered: {}, ...overrides });
}

/** The campaigns signal failed, everything else read fine: the read «partly worked». */
const campaignsFailed = (): AccountSignals => ({ ...clinicAccount(), campaigns: { ok: false, error: 'deadline' } });

// ---------------------------------------------------------------------------
// B2: a failed read must not let the free audit run on an empty account
// ---------------------------------------------------------------------------

test('B2 classify: a failed read with the hint «empty» is a new account, with no kind guessed', () => {
  for (const signals of [null, campaignsFailed(), account()]) {
    const scenario = classify({ signals, activityHint: 'empty' });
    assert.equal(scenario.state, 'new');
    assert.ok(scenario.evidence.includes('hint:empty'));
    assert.equal(scenario.kind, 'general');
    assert.equal(scenario.kindConfidence, 'none');
  }
});

test('B2 classify: the hint «spends» keeps the account active and guesses no kind', () => {
  const scenario = classify({ signals: campaignsFailed(), activityHint: 'spends' });
  assert.equal(scenario.state, 'active');
  assert.equal(scenario.kindConfidence, 'none');
  assert.ok(scenario.evidence.includes('hint:spends'));
});

test('B2 classify: no hint changes nothing, whether it is absent or null', () => {
  const plain = classify({ signals: campaignsFailed() });
  assert.deepEqual(classify({ signals: campaignsFailed(), activityHint: null }), plain);
  assert.equal(plain.state, 'active');
  assert.equal(plain.evidence.some((entry) => entry.startsWith('hint:')), false);
});

test('B2 classify: the hint is for a failed read only; a good read speaks for itself', () => {
  const read = classify({ signals: clinicAccount(), activityHint: 'empty' });
  assert.equal(read.state, 'active');
  assert.equal(read.kind, 'clinic');
  assert.equal(read.evidence.some((entry) => entry.startsWith('hint:')), false);
});

test('B2 classify: no account stays no account whatever the hint says', () => {
  const scenario = classify({ linkedAccounts: 0, answered: { has_account: 'none' }, activityHint: 'empty' });
  assert.equal(scenario.state, 'no_account');
});

// --- where the hint comes from ---------------------------------------------

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

test('B2 hint: any spend the connect job read means «spends», however old the read', () => {
  assert.equal(activityHintFrom({ spend30: 120, spendReadAt: hoursAgo(24 * 20), cached: null, now: NOW }), 'spends');
});

test('B2 hint: a zero from the connect job means «empty» only while it is fresh', () => {
  assert.equal(activityHintFrom({ spend30: 0, spendReadAt: hoursAgo(SPEND_ZERO_FRESH_HOURS - 1), cached: null, now: NOW }), 'empty');
  assert.equal(activityHintFrom({ spend30: 0, spendReadAt: hoursAgo(SPEND_ZERO_FRESH_HOURS + 1), cached: null, now: NOW }), null);
  assert.equal(activityHintFrom({ spend30: null, spendReadAt: hoursAgo(1), cached: null, now: NOW }), null, 'not read is not zero');
  assert.equal(activityHintFrom({ spend30: 0, cached: null, now: NOW }), null, 'a zero with no time is not trusted');
});

test('B2 hint: the synced account\'s cached campaigns say it when the job did not', () => {
  const synced = hoursAgo(5);
  assert.equal(activityHintFrom({ spend30: null, syncedAt: synced, cached: [], now: NOW }), 'empty');
  assert.equal(
    activityHintFrom({ spend30: null, syncedAt: synced, cached: [{ metrics_30d: { cost: 0 }, metrics_7d: { cost: 0 } }], now: NOW }),
    'empty'
  );
  assert.equal(activityHintFrom({ spend30: null, syncedAt: synced, cached: [{ metrics_30d: { cost: 0 }, metrics_7d: { cost: 40 } }], now: NOW }), 'spends');
  assert.equal(activityHintFrom({ spend30: null, syncedAt: synced, cached: [{ metrics_30d: { cost_sar: 900 } }], now: NOW }), 'spends', 'the older key counts too');
});

test('B2 hint: rows with no stored metrics are an account that has not spent, and an old sync is not believed when empty', () => {
  // A campaign with no activity in the window keeps no metrics for it (lib/google-ads/sync.ts), so null is a zero.
  assert.equal(activityHintFrom({ spend30: null, syncedAt: hoursAgo(5), cached: [{ metrics_30d: null, metrics_7d: null }], now: NOW }), 'empty');
  assert.equal(activityHintFrom({ spend30: null, syncedAt: hoursAgo(CACHE_EMPTY_FRESH_HOURS + 1), cached: [{ metrics_30d: null, metrics_7d: null }], now: NOW }), null);
  assert.equal(activityHintFrom({ spend30: null, syncedAt: hoursAgo(CACHE_EMPTY_FRESH_HOURS + 1), cached: [{ metrics_30d: { cost: 5 } }], now: NOW }), 'spends', 'a cost is believed at any age');
  assert.equal(activityHintFrom({ spend30: null, syncedAt: hoursAgo(CACHE_EMPTY_FRESH_HOURS + 1), cached: [], now: NOW }), null);
  assert.equal(activityHintFrom({ spend30: null, cached: [], now: NOW }), null, 'an account the sync never ran for');
  assert.equal(activityHintFrom({ spend30: null, syncedAt: hoursAgo(5), cached: null, now: NOW }), null, 'the table could not be read');
});

test('B2 hint: readActivityHint asks the caller\'s client for this account only when the job did not settle it', async () => {
  const db = fakeDb({ campaigns_cache: [] });
  const empty = await readActivityHint(db.client, { account: { id: 'acc-1', last_synced_at: hoursAgo(5) }, spend30: null, now: NOW });
  assert.equal(empty, 'empty');
  assert.equal(eqValue(db.queries[0], 'account_id'), 'acc-1');

  const settled = fakeDb({ campaigns_cache: [] });
  assert.equal(await readActivityHint(settled.client, { account: { id: 'acc-1', last_synced_at: hoursAgo(5) }, spend30: 500, now: NOW }), 'spends');
  assert.equal(settled.queries.length, 0, 'a spend on record needs no second read');

  const never = fakeDb({ campaigns_cache: [] });
  assert.equal(await readActivityHint(never.client, { account: { id: 'acc-1', last_synced_at: null }, spend30: null, now: NOW }), null);
  assert.equal(never.queries.length, 0);

  const broken = fakeDb({ campaigns_cache: { error: 'boom' } });
  assert.equal(await readActivityHint(broken.client, { account: { id: 'acc-1', last_synced_at: hoursAgo(5) }, spend30: null, now: NOW }), null);
});

// ---------------------------------------------------------------------------
// S1: «إي صح» then «لا» then a re-read; the confirmed kind survives a lost read
// ---------------------------------------------------------------------------

test('S1 classify: the kind the customer agreed with comes back as confident when the read is gone', () => {
  const withoutIt = classify({ signals: null, answered: { confirm: 'yes' } });
  assert.equal(withoutIt.kind, 'general');
  assert.equal(withoutIt.kindConfidence, 'none');

  const scenario = classify({ signals: null, answered: { confirm: 'yes' }, confirmed: { kind: 'clinic', outcome: 'calls' } });
  assert.equal(scenario.kind, 'clinic');
  assert.equal(scenario.kindConfidence, 'confident');
  assert.equal(scenario.kindRanking[0], 'clinic');
  assert.equal(scenario.outcome, 'calls', 'the outcome too, when the read gives none');
  assert.ok(scenario.evidence.includes('confirmed:kind'));
  assert.ok(scenario.evidence.includes('confirmed:outcome'));
});

test('S1 classify: a stated type beats the confirmed kind, and the read\'s own outcome is kept', () => {
  const stated = classify({ signals: null, answered: { confirm: 'yes', type: 'ecommerce' }, confirmed: { kind: 'clinic', outcome: null } });
  assert.equal(stated.kind, 'ecommerce');
  assert.equal(stated.kindConfidence, 'stated');

  const read = classify({ signals: clinicAccount(), answered: { confirm: 'yes' }, confirmed: { kind: 'ecommerce', outcome: 'purchases' } });
  assert.equal(read.kind, 'ecommerce');
  assert.equal(read.outcome, 'calls', 'what the account converts on is not overwritten by what was proposed');
});

test('S1 classify: a «no» after a «yes» drops the confirmed kind, and «general» confirms nothing', () => {
  const no = classify({ signals: null, answered: { confirm: 'no' }, confirmed: { kind: 'clinic', outcome: 'calls' } });
  assert.equal(no.kindConfidence, 'none');
  assert.equal(no.kind, 'general');
  const general = classify({ signals: null, answered: { confirm: 'yes' }, confirmed: { kind: 'general', outcome: null } });
  assert.equal(general.kindConfidence, 'none');
  const none = classify({ linkedAccounts: 0, answered: { has_account: 'none' }, confirmed: { kind: 'clinic', outcome: null } });
  assert.equal(none.kindConfidence, 'none', 'no account, nothing to agree with');
});

test('S1 answered: a «no» on the opener stops the sector an earlier «yes» wrote from counting as the customer\'s own type', () => {
  const clinic = TYPE_OPTIONS.find((option) => option.id === 'clinic')!;
  const business = { name: 'عيادة', sector: clinic.label, monthly_budget: null, target_regions: [] as string[], website: null };
  const ledger = new Map<string, string | null>([['confirm', 'no']]);
  const onRecord = answeredOnRecord({ business, ledger: ledger as never });
  assert.equal(onRecord.type, 'clinic', 'the sector still matches a label');
  const answered = adaptiveAnswered({ answered: onRecord, ledger });
  assert.equal(answered.type, undefined);
  assert.equal(answered.name, undefined);
  assert.equal(answered.goal, undefined);
  // The classifier then guesses nothing from the sector.
  assert.notEqual(classify({ signals: sallaAccount(), answered }).kindConfidence, 'stated');
  // Without the «no», and without a type of their own, the old-form rule applies as before: nothing changes for them.
  const legacy = adaptiveAnswered({ answered: onRecord, ledger: new Map() });
  assert.equal(legacy.type, 'clinic');
});

// --- the ledger remembers what was agreed ------------------------------------

function memory(...rows: Array<Record<string, unknown>>) {
  return rows.map((data, index) => ({ data, created_at: `2026-10-14T0${9 - index}:00:00.000Z` }));
}

test('S1 ledger: the newest «yes» on the opener keeps its kind and outcome', async () => {
  const db = fakeDb({ business_memory: memory({ setup_key: 'confirm', choice: 'yes', kind: 'clinic', outcome: 'calls' }) });
  const ledger = await readLedgerEntries(db.client, 'biz-1');
  assert.deepEqual(ledger.confirmed, { kind: 'clinic', outcome: 'calls' });
  assert.equal(ledger.choices.get('confirm'), 'yes');
});

test('S1 ledger: a newer «no» wins over an older «yes»; a «yes» with no usable kind confirms nothing', async () => {
  const newer = fakeDb({
    business_memory: memory({ setup_key: 'confirm', choice: 'no' }, { setup_key: 'confirm', choice: 'yes', kind: 'clinic', outcome: 'calls' }),
  });
  assert.equal((await readLedgerEntries(newer.client, 'biz-1')).confirmed, null);

  for (const data of [
    { setup_key: 'confirm', choice: 'yes' },
    { setup_key: 'confirm', choice: 'yes', kind: 'restaurant' },
  ]) {
    const db = fakeDb({ business_memory: memory(data) });
    assert.equal((await readLedgerEntries(db.client, 'biz-1')).confirmed, null);
  }

  const odd = fakeDb({ business_memory: memory({ setup_key: 'confirm', choice: 'yes', kind: 'local', outcome: 'teleport' }) });
  assert.deepEqual((await readLedgerEntries(odd.client, 'biz-1')).confirmed, { kind: 'local', outcome: null });

  const none = fakeDb({ business_memory: memory({ setup_key: 'focus_service', choice: 'all' }) });
  assert.equal((await readLedgerEntries(none.client, 'biz-1')).confirmed, undefined, 'no confirm on record, no key');
});

// ---------------------------------------------------------------------------
// S1c: editing asks the type and the goal again, for every kind
// ---------------------------------------------------------------------------

const KINDS: Array<[string, AccountSignals]> = [
  ['clinic', clinicAccount()],
  ['ecommerce', sallaAccount()],
  [
    'services',
    account({
      campaigns: { ok: true, value: [campaign({ id: '1', name: 'صيانة تكييف الرياض', cost30: 800, clicks30: 300, impressions30: 9000, conversions30: 20 })] },
      enabledConversionActions: { ok: true, value: 2 },
      conversionsByGroup: groups(['call', 20]),
    }),
  ],
  [
    'local',
    account({
      campaigns: { ok: true, value: [campaign({ id: '1', name: 'مطعم الديرة - فرع', kind: 'LOCAL', cost30: 500, clicks30: 200, impressions30: 7000, conversions30: 15 })] },
      enabledConversionActions: { ok: true, value: 2 },
      conversionsByGroup: groups(['directions', 15]),
    }),
  ],
];

test('S1c pending: in edit mode the type and the goal come first for every kind', () => {
  for (const [kind, signals] of KINDS) {
    const scenario = classify({ signals, answered: { confirm: 'yes' } });
    assert.equal(scenario.kind, kind, kind);
    const pending = adaptivePending({ scenario, answered: { confirm: 'yes', type: kind }, consentAnswered: true, edit: true, hasAccount: true });
    assert.deepEqual(pending.slice(0, 2), ['type', 'goal'], kind);
    assert.equal(pending.filter((key) => key === 'type').length, 1, kind);
    assert.equal(pending.filter((key) => key === 'goal').length, 1, kind);
    assert.equal(pending.includes('confirm'), false, kind);
  }
});

test('S1c pending: a suspected manager is asked before the type and the goal, and a normal visit is unchanged', () => {
  const managed = clinicAccount({ otherEditors14d: { ok: true, value: 3 } });
  const scenario = classify({ signals: managed });
  assert.equal(scenario.managed, 'suspected');
  const edit = adaptivePending({ scenario, answered: { confirm: 'yes' }, consentAnswered: true, edit: true, hasAccount: true });
  assert.deepEqual(edit.slice(0, 3), ['manager', 'type', 'goal']);

  const first = classify({ signals: clinicAccount() });
  const visit = adaptivePending({ scenario: first, answered: {}, consentAnswered: true, edit: false, hasAccount: true });
  assert.equal(visit.includes('type'), false, 'the account already says what the business is');
  assert.equal(visit.includes('goal'), false);
});

// ---------------------------------------------------------------------------
// S4: «value» is covered by the adaptive tree's own value questions
// ---------------------------------------------------------------------------

test('S4 core keys: the average-order, deal-value and focus-service answers cover «value»', () => {
  const base = ['type', 'goal', 'budget'] as const;
  assert.deepEqual(missingCoreKeys([...base]), ['value'], 'nobody outside the tree is affected');
  for (const covering of ['aov_check', 'deal_value', 'focus_service'] as const) {
    assert.deepEqual(missingCoreKeys([...base, covering]), [], covering);
  }
  assert.deepEqual(missingCoreKeys(['aov_check']), ['type', 'goal', 'budget'], 'the other keys are still missing');
  assert.deepEqual(missingCoreKeys([...base, 'value']), []);
});

test('S4 /home: «كمّل تعريف نشاطك» clears after each journey of the tree (the rule /home applies to the profile and the ledger)', () => {
  // The same union /home builds: what the old form answers through the business, plus every ledger key.
  const missing = (business: BusinessProfile, ledger: string[]) =>
    missingCoreKeys(new Set<SetupKey>([...keysAnsweredByProfile(business), ...(ledger as SetupKey[])]));
  const sector = (id: string) => TYPE_OPTIONS.find((option) => option.id === id)!.label;
  const budgeted = { monthly_budget: 4000 };

  // A store: «إي صح» wrote the sector, the tree asked the average order instead of «value».
  assert.deepEqual(missing({ sector: sector('ecommerce'), ...budgeted }, ['confirm', 'aov_check', 'margin', 'push_products', 'pain']), []);
  // A services business: the deal value.
  assert.deepEqual(missing({ sector: sector('services'), ...budgeted }, ['confirm', 'deal_value', 'pain']), []);
  // New, dormant and no account: only what they want to sell.
  assert.deepEqual(missing({ sector: sector('clinic'), ...budgeted }, ['type', 'focus_service', 'regions', 'goal']), []);
  // A clinic keeps the legacy «value» question.
  assert.deepEqual(missing({ sector: sector('clinic'), ...budgeted }, ['confirm', 'focus_service', 'value', 'pain']), []);

  // Before the fix a store was left with «value» for good.
  assert.deepEqual(missing({ sector: sector('ecommerce'), ...budgeted }, ['confirm', 'margin', 'push_products', 'pain']), ['value'], 'without any of the three it is still missing');
});

// ---------------------------------------------------------------------------
// S8: the manager question says only what is true
// ---------------------------------------------------------------------------

const BANNED = ['—', '–', ',', 'ليس مجرد', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'حلول متكاملة', 'رحلتك', 'باختصار', 'زياد'];

function managerQuestion(signals: AccountSignals) {
  const scenario = classify({ signals });
  assert.equal(scenario.managed, 'suspected');
  const question = adaptiveQuestion('manager', { scenario, signals, answered: {}, edit: false });
  assert.ok(question);
  return question!;
}

test('S8 manager: someone else\'s email editing is not described as the email the account was connected with', () => {
  const editors = managerQuestion(clinicAccount({ otherEditors14d: { ok: true, value: 2 } }));
  assert.equal(editors.text, 'شفت تعديلات على حسابك آخر أسبوعين من إيميل غير إيميلك في مُضاعِف. مين يدير الحساب؟');

  const both = managerQuestion(
    clinicAccount({ otherEditors14d: { ok: true, value: 2 }, externalManager: { ok: true, value: { linked: true, managerIds: ['9990001112'] } } })
  );
  assert.equal(
    both.text,
    'شفت إن حسابك مربوط بحساب إدارة من برا، وفيه تعديلات آخر أسبوعين من إيميل غير إيميلك في مُضاعِف. مين يدير الحساب؟'
  );

  // A link to a manager account is read straight from Google, so its wording was already true.
  const link = managerQuestion(clinicAccount({ externalManager: { ok: true, value: { linked: true, managerIds: ['9990001112'] } } }));
  assert.equal(link.text, 'شفت إن حسابك مربوط بحساب إدارة من برا. مين يديره؟');
});

test('S8 manager: «أنا» stays among the options, and the copy follows the house rules', () => {
  const questions = [
    managerQuestion(clinicAccount({ otherEditors14d: { ok: true, value: 2 } })),
    managerQuestion(clinicAccount({ externalManager: { ok: true, value: { linked: true, managerIds: ['9990001112'] } } })),
    managerQuestion(
      clinicAccount({ otherEditors14d: { ok: true, value: 2 }, externalManager: { ok: true, value: { linked: true, managerIds: ['9990001112'] } } })
    ),
  ];
  for (const question of questions) {
    assert.deepEqual(question.options.map((option) => option.id), ['agency', 'employee', 'self']);
    assert.equal(question.options.find((option) => option.id === 'self')?.label, 'أنا بنفسي');
    const copy = [question.text, question.why ?? '', ...question.options.map((option) => option.label)].join(' ');
    for (const banned of BANNED) assert.equal(copy.includes(banned), false, banned);
  }
});

// ---------------------------------------------------------------------------
// Nit b: «شركة» is in a company's name, not in a service
// ---------------------------------------------------------------------------

test('nit b: a campaign named after a company does not make the account a services business', () => {
  const named = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث - شركة الأمل للتجارة', cost30: 500, clicks30: 120, impressions30: 4000, conversions30: 5 })] },
    enabledConversionActions: { ok: true, value: 1 },
  });
  const scenario = classify({ signals: named });
  assert.equal(scenario.evidence.includes('words:services'), false);
  assert.equal(scenario.kindConfidence === 'confident' && scenario.kind === 'services', false);

  const real = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث - صيانة مكيفات', cost30: 500, clicks30: 120, impressions30: 4000, conversions30: 5 })] },
    enabledConversionActions: { ok: true, value: 1 },
  });
  assert.ok(classify({ signals: real }).evidence.includes('words:services'), 'a real service word still counts');
});

// ---------------------------------------------------------------------------
// Nit c: «غير كذا» shows the sector the customer typed
// ---------------------------------------------------------------------------

test('nit c: a type answered «غير كذا» shows the business sector text in the understanding rows', () => {
  const scenario = classify({ signals: null, answered: { type: 'other' } });
  const rows = (sector: string | null) =>
    understandingRows({
      scenario,
      signals: null,
      answered: { type: 'other' },
      labels: { type: 'غير كذا' },
      business: { name: 'مشغلي', monthlyBudget: null, targetRegions: [], sector },
    });
  const activity = rows('مشغل خياطة رجالية').find((row) => row.label === 'النشاط');
  assert.deepEqual(activity, { label: 'النشاط', value: 'مشغل خياطة رجالية', source: 'you' });
  // Without the typed text there is no row at all, rather than the useless «غير كذا».
  assert.equal(rows(null).some((row) => row.label === 'النشاط'), false);
  assert.equal(rows('   ').some((row) => row.label === 'النشاط'), false);
  // The sector is cleaned and capped like every typed text.
  const long = rows('خياطة '.repeat(40)).find((row) => row.label === 'النشاط');
  assert.ok(long && long.value.length <= 40);
  // A listed type keeps saying its own label, whatever the sector holds.
  const listed = understandingRows({
    scenario: classify({ signals: null, answered: { type: 'clinic' } }),
    signals: null,
    answered: { type: 'clinic' },
    labels: { type: 'عيادة أو مركز طبي' },
    business: { name: 'x', monthlyBudget: null, targetRegions: [], sector: 'عيادة أو مركز طبي' },
  });
  assert.equal(listed.find((row) => row.label === 'النشاط')?.value, 'عيادة أو مركز طبي');
});

