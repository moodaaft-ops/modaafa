import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { adaptiveReaction } from '../lib/setup/adaptive/answers';
import { ensureSetupBusiness } from '../lib/setup/adaptive/ensure-business';
import {
  ANSWER_KEYS_NEEDING_LEDGER,
  ANSWER_KEYS_NEEDING_SIGNALS,
  adaptiveAnswered,
  buildAdaptiveView,
  endingFor,
  reactionContextFor,
  type AdaptiveViewInput,
} from '../lib/setup/adaptive/view';
import { SIGNAL_KEYS } from '../lib/setup/adaptive/signals-store';
import type {
  AccountSignals,
  AdaptiveAnswer,
  CampaignSignal,
  ConversionGroup,
  HourSignal,
  ProductSignal,
} from '../lib/setup/adaptive/types';
import { LEDGER_LABEL_MAX, readLedger, readLedgerEntries } from '../lib/setup/load';
import { buildPlan, stripPlanCategories, withScenarioLead, type Plan } from '../lib/plan/plan';
import { toPlanRecommendations } from '../lib/plan/load';
import { SUPPORT_WHATSAPP_NUMBER, whatsappHelpUrl } from '../lib/support/contact';
import { parseAnswer } from '../lib/setup/questions';
import { saveSetupAnswer } from '../lib/setup/save';

// ---------------------------------------------------------------------------
// Fixtures (shapes copied from tests/adaptive-engine.test.ts; all synthetic)
// ---------------------------------------------------------------------------

const READ_AT = '2026-10-14T08:00:00.000Z';
const FIVE_MIN_LATER = new Date('2026-10-14T08:05:00.000Z');
const TWO_HOURS_LATER = new Date('2026-10-14T10:00:00.000Z');

const failed = { ok: false as const, error: 'not_read' };

function account(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return {
    version: 1,
    readAt: READ_AT,
    customerId: '1234567890',
    currency: 'SAR',
    campaigns: failed,
    enabledConversionActions: failed,
    conversionsByGroup: failed,
    autoTagging: failed,
    landingHosts: failed,
    merchantCenterLinked: failed,
    assets: failed,
    targetedPlaces: failed,
    externalManager: failed,
    otherEditors14d: failed,
    hours: failed,
    products: failed,
    ...overrides,
  };
}

function campaign(overrides: Partial<CampaignSignal> & { id: string; name: string }): CampaignSignal {
  return {
    kind: 'SEARCH',
    status: 'ENABLED',
    cost30: 0,
    impressions30: 0,
    clicks30: 0,
    conversions30: 0,
    value30: 0,
    ...overrides,
  };
}

function groups(...rows: Array<[ConversionGroup, number]>) {
  return { ok: true as const, value: rows.map(([group, conversions]) => ({ group, conversions })) };
}

function clinicHours(outside: { cost: number; callsBefore9: number }): HourSignal[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const open = (hour >= 9 && hour < 13) || (hour >= 16 && hour < 22);
    return {
      hour,
      cost: open ? 120 : outside.cost,
      clicks: 10,
      conversions: 1,
      phoneCalls: open ? 5 : hour < 9 ? outside.callsBefore9 : 0,
    };
  });
}

function clinicAccount(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'بحث - زراعة الأسنان', cost30: 1100, impressions30: 30000, clicks30: 900, conversions30: 40 }),
        campaign({ id: '2', name: 'بحث - تقويم الأسنان', cost30: 900, impressions30: 20000, clicks30: 600, conversions30: 33 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 3 },
    conversionsByGroup: groups(['call', 64], ['lead_form', 9]),
    autoTagging: { ok: true, value: true },
    landingHosts: { ok: true, value: ['smile-clinic.example.sa'] },
    merchantCenterLinked: { ok: true, value: false },
    assets: { ok: true, value: { call: true, locations: 0 } },
    targetedPlaces: { ok: true, value: ['Jeddah'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
    hours: { ok: true, value: clinicHours({ cost: 30, callsBefore9: 1 }) },
    ...overrides,
  });
}

const PRODUCTS: ProductSignal[] = [
  { id: 'a', title: 'عطر العود الملكي', cost30: 520, conversions30: 9, value30: 2000 },
  { id: 'b', title: 'عطر الورد', cost30: 410, conversions30: 7, value30: 1500 },
  { id: 'c', title: 'بخور فاخر', cost30: 90, conversions30: 0, value30: 0 },
  { id: 'd', title: 'مجموعة هدايا', cost30: 80, conversions30: 0, value30: 0 },
  { id: 'e', title: 'عطر صيفي', cost30: 70, conversions30: 0, value30: 0 },
  { id: 'f', title: 'دهن عود', cost30: 60, conversions30: 0, value30: 0 },
  { id: 'g', title: 'منتج جديد', cost30: 20, conversions30: 0, value30: 0 },
];

function sallaAccount(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 2000, impressions30: 50000, clicks30: 1500, conversions30: 30, value30: 5580 }),
        campaign({ id: '2', name: 'بحث - عطور', cost30: 1200, impressions30: 12000, clicks30: 700, conversions30: 11, value30: 2046 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['purchase', 41]),
    autoTagging: { ok: true, value: true },
    landingHosts: { ok: true, value: ['myperfume.salla.sa'] },
    merchantCenterLinked: { ok: true, value: true },
    assets: { ok: true, value: { call: false, locations: 0 } },
    targetedPlaces: { ok: true, value: ['Saudi Arabia'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
    products: { ok: true, value: PRODUCTS },
    ...overrides,
  });
}

/** Every one of the twelve signals read fine, so the read is reusable for the whole TTL. */
function fullyRead(signals: AccountSignals): AccountSignals {
  const filled = { ...signals } as Record<string, unknown>;
  const defaults: Record<string, unknown> = {
    campaigns: { ok: true, value: [] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: { ok: true, value: [] },
    autoTagging: { ok: true, value: true },
    landingHosts: { ok: true, value: [] },
    merchantCenterLinked: { ok: true, value: false },
    assets: { ok: true, value: { call: false, locations: 0 } },
    targetedPlaces: { ok: true, value: [] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
    hours: { ok: true, value: [] },
    products: { ok: true, value: [] },
  };
  for (const key of SIGNAL_KEYS) {
    const read = filled[key] as { ok: boolean } | undefined;
    if (!read || read.ok !== true) filled[key] = defaults[key];
  }
  return filled as unknown as AccountSignals;
}

/** A store account that spends, has tracking, and brought nothing from 120 clicks. */
function suspectAccount() {
  return clinicAccount({
    campaigns: {
      ok: true,
      value: [campaign({ id: '1', name: 'بحث - تقويم الأسنان', cost30: 900, impressions30: 20000, clicks30: 600, conversions30: 0 })],
    },
    conversionsByGroup: groups(),
  });
}

/** Spends, and no enabled conversion action at all. */
function untrackedAccount() {
  return clinicAccount({
    enabledConversionActions: { ok: true, value: 0 },
    conversionsByGroup: groups(),
    campaigns: {
      ok: true,
      value: [campaign({ id: '1', name: 'بحث - تقويم الأسنان', cost30: 900, impressions30: 20000, clicks30: 600, conversions30: 0 })],
    },
  });
}

function newAccount() {
  return account({ campaigns: { ok: true, value: [] }, enabledConversionActions: { ok: true, value: 0 } });
}

function dormantAccount() {
  return account({
    campaigns: { ok: true, value: [campaign({ id: '9', name: 'بحث قديم', status: 'PAUSED' })] },
    enabledConversionActions: { ok: true, value: 0 },
  });
}

const BUSINESS = { name: 'عيادة', monthlyBudget: null, targetRegions: [] as string[], website: null };

function input(overrides: Partial<AdaptiveViewInput> = {}): AdaptiveViewInput {
  return {
    signals: clinicAccount(),
    linkedAccounts: 1,
    accountChosen: true,
    needsChoice: false,
    connectRunning: false,
    connectError: null,
    answered: {},
    labels: {},
    business: BUSINESS,
    consentAnswered: false,
    edit: false,
    firstName: 'سلطان',
    auditExists: false,
    subscriptionActive: false,
    plan: null,
    currency: 'SAR',
    now: FIVE_MIN_LATER,
    ...overrides,
  };
}

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `قرار ${id}`,
  description: `سبب ${id}`,
  severity: 'medium',
  status: 'pending',
  created_at: '2026-10-13T08:00:00.000Z',
  expected_impact: null,
  executable: true,
  category: 'keywords',
  ...extra,
});

const AUDIT = { health_score: 58, estimated_monthly_waste: 1840, ran_at: '2026-10-13T07:00:00.000Z' };

/** The plan as load.ts hands it over: with each decision's category. */
function auditPlan(rows = [rec('a', { severity: 'critical', expected_impact: { metric: 'cost', delta_sar_per_month: 412 }, category: 'keywords' }), rec('b', { category: 'bidding' }), rec('c', { category: 'ads' })]): Plan {
  return buildPlan({ audit: AUDIT, recommendations: rows, currency: 'SAR', includeCategory: true });
}

/** Everything the free-new-account tree asks, answered. */
const FRESH_ANSWERED = { type: 'services', focus_service: 'other', regions: 'saudi', goal: 'leads', budget: null, website: 'none' };

// ---------------------------------------------------------------------------
// Stage overrides
// ---------------------------------------------------------------------------

test('stage: no linked account and no «كمّل بدون حساب» stays on connect, with nothing pending', () => {
  const result = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false }));
  assert.equal(result.stage, 'connect');
  assert.deepEqual(result.pending, []);
  assert.equal(result.view.needsRead, false);
});

test('stage: no account and has_account «none» asks the fresh questions, then finishes (never done)', () => {
  const asking = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, answered: { has_account: 'none' } }));
  assert.equal(asking.stage, 'questions');
  assert.equal(asking.view.scenario.state, 'no_account');
  assert.deepEqual(asking.pending, ['type', 'focus_service', 'regions', 'goal', 'budget', 'website']);
  assert.equal(asking.pending.includes('consent'), false, 'no account, no consent question');

  const answered = { has_account: 'none', ...FRESH_ANSWERED };
  const finished = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, answered }));
  assert.deepEqual(finished.pending, []);
  assert.equal(finished.stage, 'finishing');
  // A subscription changes nothing here: there is no home without an account.
  const paid = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, answered, subscriptionActive: true }));
  assert.equal(paid.stage, 'finishing');
  assert.equal(finished.view.ending, 'first_campaign');
  assert.equal(finished.view.firstCampaign?.next, 'open_account');
  assert.equal(finished.view.auditAllowed, false);
});

test('stage: the connect job ending with no accounts is the no_account state, but questions wait for the customer to go on', () => {
  for (const connectError of ['no_accounts', 'no_client_accounts']) {
    const result = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, connectError }));
    assert.equal(result.view.scenario.state, 'no_account');
    assert.equal(result.stage, 'connect');
    assert.deepEqual(result.pending, []);
  }
  const other = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, connectError: 'connect_failed' }));
  assert.notEqual(other.view.scenario.state, 'no_account');
});

test('stage: a running connect job wins over everything, the no-account flow included', () => {
  const noAccount = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, answered: { has_account: 'none' }, connectRunning: true }));
  assert.equal(noAccount.stage, 'connecting');
  const finishedFresh = buildAdaptiveView(
    input({ signals: newAccount(), answered: FRESH_ANSWERED, connectRunning: true })
  );
  assert.equal(finishedFresh.stage, 'connecting');
  const clinic = buildAdaptiveView(input({ connectRunning: true }));
  assert.equal(clinic.stage, 'connecting');
});

test('stage: editing with no account is plain setup (the page reloads it without edit)', () => {
  const result = buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false, answered: { has_account: 'none' }, edit: true }));
  assert.equal(result.stage, 'connect');
  assert.deepEqual(result.pending, []);
});

test('stage: several accounts and none picked is choose, with nothing pending and nothing read', () => {
  const result = buildAdaptiveView(input({ signals: clinicAccount(), linkedAccounts: 3, accountChosen: false, needsChoice: true }));
  assert.equal(result.stage, 'choose');
  assert.deepEqual(result.pending, []);
  assert.equal(result.view.needsRead, false);
  assert.equal(result.view.opener, null);
});

test('stage: a new account with nothing pending finishes, or is done with a subscription', () => {
  const asking = buildAdaptiveView(input({ signals: newAccount() }));
  assert.equal(asking.view.scenario.state, 'new');
  assert.equal(asking.stage, 'questions');
  assert.deepEqual(asking.pending, ['type', 'focus_service', 'regions', 'goal', 'budget', 'website']);

  const done = input({ signals: newAccount(), answered: FRESH_ANSWERED });
  assert.equal(buildAdaptiveView(done).stage, 'finishing');
  assert.equal(buildAdaptiveView({ ...done, subscriptionActive: true }).stage, 'done');
  // An old audit on record does not skip the first-campaign plan.
  assert.equal(buildAdaptiveView({ ...done, auditExists: true }).stage, 'finishing');
});

test('stage: a dormant account behaves like a new one', () => {
  const done = input({ signals: dormantAccount(), answered: FRESH_ANSWERED });
  const result = buildAdaptiveView(done);
  assert.equal(result.view.scenario.state, 'dormant');
  assert.equal(result.stage, 'finishing');
  assert.equal(buildAdaptiveView({ ...done, subscriptionActive: true }).stage, 'done');
  assert.equal(result.view.ending, 'first_campaign');
});

test('stage: an account that runs ads keeps today\'s rule (finishing until the audit lands, then done)', () => {
  const answered = {
    confirm: 'yes',
    focus_service: 'dental_braces',
    value: '100_500',
    pain: 'clinic_few_calls',
    call_hours: 'always',
    whatsapp_booking: 'yes',
    budget: null,
  };
  const noAudit = buildAdaptiveView(input({ answered, consentAnswered: true }));
  assert.deepEqual(noAudit.pending, []);
  assert.equal(noAudit.stage, 'finishing');
  const audited = buildAdaptiveView(input({ answered, consentAnswered: true, auditExists: true }));
  assert.equal(audited.stage, 'done');
  const asking = buildAdaptiveView(input());
  assert.equal(asking.stage, 'questions');
  assert.equal(asking.pending[0], 'confirm');
});

test('stage: editing a new account is not finished by the new-account rule', () => {
  const result = buildAdaptiveView(input({ signals: newAccount(), answered: FRESH_ANSWERED, edit: true }));
  assert.ok(result.pending.length > 0, 'edit asks every question again');
  assert.equal(result.stage, 'questions');
});

// ---------------------------------------------------------------------------
// needsRead
// ---------------------------------------------------------------------------

test('needsRead: true with no stored read, false with a reusable one', () => {
  assert.equal(buildAdaptiveView(input({ signals: null })).view.needsRead, true);
  // A partial read is trusted only for a short while (the retry window).
  assert.equal(buildAdaptiveView(input({ signals: clinicAccount(), now: FIVE_MIN_LATER })).view.needsRead, false);
  assert.equal(buildAdaptiveView(input({ signals: clinicAccount(), now: TWO_HOURS_LATER })).view.needsRead, true);
  // A clean read is trusted for the whole day.
  assert.equal(buildAdaptiveView(input({ signals: fullyRead(clinicAccount()), now: TWO_HOURS_LATER })).view.needsRead, false);
  assert.equal(buildAdaptiveView(input({ signals: fullyRead(clinicAccount()), now: new Date('2026-10-15T09:00:00.000Z') })).view.needsRead, true);
});

test('needsRead: never in edit mode, and never without a chosen account', () => {
  assert.equal(buildAdaptiveView(input({ signals: null, edit: true })).view.needsRead, false);
  assert.equal(buildAdaptiveView(input({ signals: null, linkedAccounts: 0, accountChosen: false })).view.needsRead, false);
  assert.equal(buildAdaptiveView(input({ signals: null, linkedAccounts: 2, accountChosen: false, needsChoice: true })).view.needsRead, false);
});

test('without a read the tree asks everything and states nothing it did not read', () => {
  const result = buildAdaptiveView(input({ signals: null }));
  assert.equal(result.view.scenario.state, 'active');
  assert.equal(result.view.scenario.kindConfidence, 'none');
  assert.equal(result.view.opener, null);
  assert.ok(result.pending.includes('type'));
  assert.equal(result.pending.includes('confirm'), false);
});

// ---------------------------------------------------------------------------
// Opener, questions, understood
// ---------------------------------------------------------------------------

test('opener: only while confirm is pending, and only outside edit mode', () => {
  const first = buildAdaptiveView(input());
  assert.ok(first.pending.includes('confirm'));
  assert.ok(first.view.opener);
  assert.match(first.view.opener.greeting, /^هلا سلطان/);
  assert.ok(first.view.opener.seen.length >= 2 && first.view.opener.seen.length <= 4);
  assert.match(first.view.opener.headline, /عيادة أسنان في جدة/);
  assert.deepEqual(first.view.opener.proposal, { kind: 'clinic', outcome: 'calls' });

  const answered = buildAdaptiveView(input({ answered: { confirm: 'yes' } }));
  assert.equal(answered.view.opener, null);

  const editing = buildAdaptiveView(input({ answered: { confirm: 'yes' }, edit: true }));
  assert.equal(editing.view.opener, null);
  assert.equal(editing.pending.includes('confirm'), false);

  const fresh = buildAdaptiveView(input({ signals: newAccount() }));
  assert.equal(fresh.view.opener, null);
});

test('questions: every pending key with adaptive copy has it, the rest keep the legacy dock', () => {
  const result = buildAdaptiveView(input());
  for (const key of Object.keys(result.view.questions)) assert.ok(result.pending.includes(key as any), `${key} is pending`);
  assert.ok(result.view.questions.confirm);
  assert.equal(result.view.questions.confirm?.options[0].id, 'yes');
  assert.ok(result.view.questions.call_hours);
  assert.equal(result.view.questions.budget, undefined, 'budget keeps the legacy copy and dock');
  assert.equal(result.view.questions.consent, undefined);
});

test('questions: edit mode marks the answer on record as current', () => {
  const result = buildAdaptiveView(input({ edit: true, answered: { confirm: 'yes', call_hours: 'day_8_23' } }));
  assert.equal(result.view.questions.call_hours?.current, 'day_8_23');
});

test('understood: only when nothing is pending and not in edit mode', () => {
  const answered = { confirm: 'yes', focus_service: 'dental_braces', value: '100_500', pain: 'clinic_few_calls', call_hours: 'always', whatsapp_booking: 'yes', budget: null };
  const asking = buildAdaptiveView(input({ answered: { confirm: 'yes' } }));
  assert.deepEqual(asking.view.understood, []);

  const done = buildAdaptiveView(input({ answered, consentAnswered: true, business: { ...BUSINESS, monthlyBudget: 4000 } }));
  assert.deepEqual(done.pending, []);
  const rows = done.view.understood;
  assert.ok(rows.length >= 4);
  const activity = rows.find((row) => row.label === 'النشاط');
  assert.ok(activity);
  assert.match(activity.value, /عيادة أسنان في جدة/);
  assert.equal(activity.source, 'confirmed');
  assert.ok(rows.find((row) => row.label === 'الميزانية' && row.source === 'you'));

  const editing = buildAdaptiveView(input({ answered, consentAnswered: true, edit: true }));
  assert.deepEqual(editing.view.understood, []);
});

test('understood: the labels read from the ledger feed the rows (picked products by title)', () => {
  const answered = {
    confirm: 'yes',
    aov_check: 'same',
    margin: '20_40',
    push_products: 'p_0',
    exclude_products: 'none',
    pain: 'shop_few_orders',
    budget: null,
  };
  const labels = { push_products: 'عطر العود الملكي، عطر الورد' };
  const result = buildAdaptiveView(input({ signals: sallaAccount(), answered, labels, consentAnswered: true }));
  assert.deepEqual(result.pending, []);
  const row = result.view.understood.find((entry) => entry.label === 'منتجات تبيها تبيع أكثر');
  assert.ok(row, 'the picked products have a row');
  assert.equal(row.value, 'عطر العود الملكي، عطر الورد');
  assert.equal(row.source, 'you');
  // Without the label the chips\' ids say nothing, so the row is left out rather than showing «p_0».
  const bare = buildAdaptiveView(input({ signals: sallaAccount(), answered, consentAnswered: true }));
  assert.equal(bare.view.understood.some((entry) => entry.value.includes('p_0')), false);
  assert.equal(bare.view.understood.some((entry) => entry.label === 'منتجات تبيها تبيع أكثر'), false);
});

test('answered: a «yes» on the opener does not turn the sector it wrote into a stated type or goal', () => {
  // businesses.sector was written by the confirm, so the old-form rule marked type, name and goal as answered.
  const profileAnswered = { type: 'clinic', name: null, goal: null, budget: null, confirm: 'yes' };
  const ledger = new Map<string, string | null>([['confirm', 'yes']]);
  const fixed = adaptiveAnswered({ answered: profileAnswered, ledger });
  assert.equal('type' in fixed, false);
  assert.equal('goal' in fixed, false);
  assert.equal('name' in fixed, false);
  assert.equal('budget' in fixed, true, 'what the old form really answered stays');

  // A real answer in the ledger stays.
  const kept = adaptiveAnswered({ answered: { ...profileAnswered, goal: 'clinic_calls' }, ledger: new Map([...ledger, ['goal', 'clinic_calls']]) });
  assert.equal(kept.goal, 'clinic_calls');
  // Without a yes nothing is touched.
  const untouched = adaptiveAnswered({ answered: { type: 'clinic', goal: null }, ledger: new Map([['confirm', 'no']]) });
  assert.deepEqual(untouched, { type: 'clinic', goal: null });

  // And the difference shows: the activity row is «أكدته», not «قلته».
  const answers = { confirm: 'yes', focus_service: 'dental_braces', value: '100_500', pain: 'clinic_few_calls', call_hours: 'always', whatsapp_booking: 'yes', budget: null };
  const asProfile = buildAdaptiveView(input({ answered: { ...answers, type: 'clinic', name: null, goal: null }, consentAnswered: true }));
  assert.equal(asProfile.view.scenario.kindConfidence, 'stated');
  const asFixed = buildAdaptiveView(input({ answered: adaptiveAnswered({ answered: { ...answers, type: 'clinic', name: null, goal: null }, ledger }), consentAnswered: true }));
  assert.equal(asFixed.view.scenario.kindConfidence, 'confident');
  assert.equal(asFixed.view.understood.find((row) => row.label === 'النشاط')?.source, 'confirmed');
});

// ---------------------------------------------------------------------------
// Ending, auditAllowed, scenario
// ---------------------------------------------------------------------------

test('ending: first_campaign for new, dormant and no_account; agency when confirmed; tracking for the two tracking states; else plan', () => {
  const endingOf = (overrides: Partial<AdaptiveViewInput>) => buildAdaptiveView(input(overrides)).view.ending;
  assert.equal(endingOf({}), 'plan');
  assert.equal(endingOf({ signals: sallaAccount() }), 'plan');
  assert.equal(endingOf({ signals: newAccount() }), 'first_campaign');
  assert.equal(endingOf({ signals: dormantAccount() }), 'first_campaign');
  assert.equal(endingOf({ signals: null, linkedAccounts: 0, accountChosen: false, answered: { has_account: 'none' } }), 'first_campaign');
  assert.equal(endingOf({ signals: untrackedAccount() }), 'tracking');
  assert.equal(endingOf({ signals: suspectAccount() }), 'tracking');
  // A confirmed manager wins over tracking and plan, but not over the first-campaign states.
  assert.equal(endingOf({ answered: { manager: 'agency' } }), 'agency');
  assert.equal(endingOf({ answered: { manager: 'employee' } }), 'agency');
  assert.equal(endingOf({ answered: { manager: 'self' } }), 'plan');
  assert.equal(endingOf({ signals: untrackedAccount(), answered: { manager: 'agency' } }), 'agency');
  assert.equal(endingOf({ signals: newAccount(), answered: { manager: 'agency' } }), 'first_campaign');
  assert.equal(endingFor({ state: 'active', managed: 'suspected' }), 'plan');
});

test('auditAllowed: active and the two tracking states only', () => {
  const allowed = (overrides: Partial<AdaptiveViewInput>) => buildAdaptiveView(input(overrides)).view.auditAllowed;
  assert.equal(allowed({}), true);
  assert.equal(allowed({ signals: untrackedAccount() }), true);
  assert.equal(allowed({ signals: suspectAccount() }), true);
  assert.equal(allowed({ signals: newAccount() }), false);
  assert.equal(allowed({ signals: dormantAccount() }), false);
  assert.equal(allowed({ signals: null, linkedAccounts: 0, accountChosen: false, answered: { has_account: 'none' } }), false);
});

test('scenario: only the small public fields go to the browser (no evidence, no ranking, no raw signals)', () => {
  const { view } = buildAdaptiveView(input());
  assert.deepEqual(Object.keys(view.scenario).sort(), ['kind', 'kindConfidence', 'managed', 'outcome', 'platform', 'specialty', 'state']);
  const wire = JSON.stringify(view);
  for (const secret of ['smile-clinic.example.sa', 'customerId', '1234567890', 'managerIds', 'evidence', 'kindRanking']) {
    assert.equal(wire.includes(secret), false, secret);
  }
});

// ---------------------------------------------------------------------------
// The plan: lead, waste, categories
// ---------------------------------------------------------------------------

test('withScenarioLead: the audit\'s first decision moves to the locked list as id, title and severity only', () => {
  const plan = auditPlan();
  assert.equal(plan.first?.id, 'a');
  const led = withScenarioLead(plan);
  assert.equal(led.first, null);
  assert.equal(led.decisionsCount, plan.decisionsCount);
  assert.deepEqual(led.locked.map((row) => row.id), ['a', ...plan.locked.map((row) => row.id)], 'the old first is on top, the others keep their order');
  assert.deepEqual(Object.keys(led.locked[0]).sort(), ['id', 'severity', 'title']);
  const wire = JSON.stringify(led);
  assert.equal(wire.includes('سبب a'), false, 'the reason is gone');
  assert.equal(wire.includes('412'), false, 'the amount is gone');
  // The other fields of the plan are untouched.
  assert.equal(led.waste, plan.waste);
  assert.equal(led.healthScore, plan.healthScore);
  assert.equal(led.kind, plan.kind);
});

test('withScenarioLead: a plan without a first decision comes back as it is', () => {
  const empty = buildPlan({ audit: AUDIT, recommendations: [] });
  assert.equal(withScenarioLead(empty), empty);
  const none = buildPlan({ audit: null, recommendations: [] });
  assert.equal(withScenarioLead(none), none);
});

test('categories ride on the plan only when asked for, and stripPlanCategories removes them', () => {
  const plain = buildPlan({ audit: AUDIT, recommendations: toPlanRecommendations([{ id: 'x', title: 'قرار', severity: 'critical', category: 'bidding', action_payload: null }, { id: 'y', title: 'قرار ثاني', severity: 'medium', category: 'ads', action_payload: null }]) });
  assert.equal('category' in (plain.first ?? {}), false);
  assert.deepEqual(plain.locked.map((row) => Object.keys(row).sort()), [['id', 'severity', 'title']], 'the locked row keeps its three keys');
  const withCategory = auditPlan();
  assert.equal(withCategory.first?.category, 'keywords');
  assert.equal(withCategory.locked[0].category, 'bidding');
  const stripped = stripPlanCategories(withCategory);
  assert.equal('category' in (stripped.first ?? {}), false);
  assert.deepEqual(stripped.locked.map((row) => Object.keys(row).sort()), stripped.locked.map(() => ['id', 'severity', 'title']));
  assert.equal(stripped.first?.reason, withCategory.first?.reason, 'the rest of the first decision is untouched');
});

test('plan: a rules decision takes the open slot and the browser never sees the audit category', () => {
  const answered = { confirm: 'yes', focus_service: 'dental_braces', value: '100_500', pain: 'clinic_few_calls', call_hours: 'split_9_13_16_22', whatsapp_booking: 'yes', budget: null };
  const result = buildAdaptiveView(input({ answered, consentAnswered: true, auditExists: true, plan: auditPlan() }));
  const { view, plan } = result;
  assert.ok(view.decision, 'ad spend while nobody answers the phone is a rules decision');
  assert.equal(view.decision?.id, 'call_hours');
  assert.equal(view.firstWhy, null, 'a rules decision carries its own «ليش أول شي»');
  assert.ok(plan);
  assert.equal(plan.first, null);
  assert.equal(plan.locked[0].id, 'a');
  assert.equal(plan.decisionsCount, 3);
  const wire = JSON.stringify({ view, plan });
  for (const hidden of ['سبب a', '412', 'keywords', 'bidding', '"category"']) assert.equal(wire.includes(hidden), false, hidden);
});

test('plan: with no rules decision the audit\'s first decision stays open, categories stripped', () => {
  const result = buildAdaptiveView(input({ answered: { confirm: 'yes' }, plan: auditPlan() }));
  assert.equal(result.view.decision, null);
  assert.equal(result.plan?.first?.id, 'a');
  assert.equal(result.plan?.first?.reason, 'سبب a');
  assert.equal('category' in (result.plan?.first ?? {}), false);
  assert.equal(result.plan?.locked.some((row) => 'category' in row), false);
});

test('plan: a store with idle products leads with them (rules decision for ecommerce)', () => {
  const result = buildAdaptiveView(input({ signals: sallaAccount(), answered: { confirm: 'yes', margin: '20_40' }, plan: auditPlan() }));
  assert.equal(result.view.decision?.id, 'idle_products');
  assert.equal(result.plan?.first, null);
});

test('plan: no waste number for no_tracking and tracking_suspect, kept for an account that tracks', () => {
  for (const signals of [untrackedAccount(), suspectAccount()]) {
    const result = buildAdaptiveView(input({ signals, plan: auditPlan() }));
    assert.equal(result.plan?.waste, null);
    assert.equal(JSON.stringify(result.plan).includes('1840'), false);
    assert.equal(result.view.decision?.id, 'tracking_setup', 'tracking comes first');
    assert.equal(result.plan?.first, null);
  }
  const tracked = buildAdaptiveView(input({ plan: auditPlan() }));
  assert.equal(tracked.plan?.waste, 1840);
});

test('plan: null stays null, and nothing breaks when the plan is not loaded', () => {
  const result = buildAdaptiveView(input({ plan: null, signals: untrackedAccount() }));
  assert.equal(result.plan, null);
  assert.equal(result.view.decision?.id, 'tracking_setup');
});

test('firstWhy: tied to what the customer said when the decision\'s category touches it, else null', () => {
  const plan = auditPlan();
  const said = buildAdaptiveView(input({ answered: { confirm: 'yes', pain: 'clinic_few_calls' }, plan }));
  assert.equal(said.view.decision, null);
  assert.equal(said.view.firstWhy, 'لأنك قلت «الاتصالات قليلة»، وهالقرار يمس الكلمات اللي تطلع فيها إعلاناتك.');

  // The first decision's category is not one the answer touches.
  const untouched = buildAdaptiveView(input({ answered: { confirm: 'yes', pain: 'clinic_few_calls' }, plan: auditPlan([rec('a', { severity: 'critical', category: 'extensions' }), rec('b')]) }));
  assert.equal(untouched.view.firstWhy, null);

  // Nothing said, no plan, or a rules decision: no line.
  assert.equal(buildAdaptiveView(input({ answered: { confirm: 'yes' }, plan })).view.firstWhy, null);
  assert.equal(buildAdaptiveView(input({ answered: { confirm: 'yes', pain: 'clinic_few_calls' }, plan: null })).view.firstWhy, null);
  const lead = buildAdaptiveView(input({ answered: { confirm: 'yes', pain: 'clinic_few_calls', call_hours: 'split_9_13_16_22' }, plan }));
  assert.ok(lead.view.decision);
  assert.equal(lead.view.firstWhy, null);
});

test('agency: the questions, the full-management card and no execute wording only for the agency ending', () => {
  const plan = auditPlan([rec('a', { severity: 'critical', category: 'bidding' }), rec('b', { category: 'keywords' }), rec('c', { category: 'keywords' }), rec('d', { category: 'unknown_category' })]);
  const agency = buildAdaptiveView(input({ answered: { confirm: 'yes', manager: 'agency' }, plan }));
  assert.equal(agency.view.ending, 'agency');
  assert.equal(agency.view.agencyQuestions.length, 2, 'one per category present, repeats and unknown categories dropped');
  assert.match(agency.view.agencyQuestions[0], /المزايدة/);
  assert.match(agency.view.agencyQuestions[1], /الكلمات/);
  assert.equal(agency.view.fullManagementCard, true);

  const self = buildAdaptiveView(input({ answered: { confirm: 'yes', manager: 'self' }, plan }));
  assert.deepEqual(self.view.agencyQuestions, []);
  assert.equal(self.view.fullManagementCard, false);

  const noPlan = buildAdaptiveView(input({ answered: { manager: 'agency' }, plan: null }));
  assert.deepEqual(noPlan.view.agencyQuestions, []);
  assert.equal(noPlan.view.fullManagementCard, true);
});

test('agency: at most five questions, whatever the audit found', () => {
  const rows = ['bidding', 'keywords', 'ads', 'structure', 'budget', 'targeting', 'extensions'].map((category, index) => rec(`r${index}`, { category }));
  const result = buildAdaptiveView(input({ answered: { manager: 'agency' }, plan: auditPlan(rows) }));
  assert.equal(result.view.agencyQuestions.length, 5);
});

test('firstCampaign: filled for the three first-campaign states from the answers and the business, null otherwise', () => {
  const fresh = buildAdaptiveView(
    input({
      signals: newAccount(),
      answered: { ...FRESH_ANSWERED, type: 'clinic', focus_service: 'dental_braces' },
      labels: {},
      business: { name: 'عيادة', monthlyBudget: 3000, targetRegions: ['جدة'], website: null },
    })
  );
  assert.ok(fresh.view.firstCampaign);
  assert.equal(fresh.view.firstCampaign.next, 'trial');
  assert.match(fresh.view.firstCampaign.campaign, /جدة/);
  assert.match(fresh.view.firstCampaign.budgetLine, /3,000/);
  assert.equal(buildAdaptiveView(input()).view.firstCampaign, null);
});

// ---------------------------------------------------------------------------
// Reaction context, the answer route's rules
// ---------------------------------------------------------------------------

function answerOf(key: string, raw: unknown): AdaptiveAnswer {
  const parsed = parseAnswer(key, raw);
  assert.equal(parsed.ok, true, `${key} ${JSON.stringify(raw)}`);
  return (parsed as { ok: true; answer: AdaptiveAnswer }).answer;
}

test('reaction context: the account\'s average order counts only when the customer agreed with it', () => {
  const signals = sallaAccount();
  const margin = answerOf('margin', { choice: 'lt20' });
  const same = reactionContextFor({ answer: margin, ledger: new Map([['aov_check', 'same']]), signals });
  assert.equal(same.aov, 186);
  assert.equal(same.currency, 'SAR');
  assert.equal(reactionContextFor({ answer: margin, ledger: new Map([['aov_check', 'less']]), signals }).aov, null);
  assert.equal(reactionContextFor({ answer: margin, ledger: new Map(), signals }).aov, null);
  // The answer itself is aov_check: same.
  assert.equal(reactionContextFor({ answer: answerOf('aov_check', { choice: 'same' }), ledger: new Map(), signals }).aov, 186);
  assert.equal(reactionContextFor({ answer: answerOf('aov_check', { choice: 'less' }), ledger: new Map([['aov_check', 'same']]), signals }).aov, null);
  // No read: no number, no currency.
  assert.deepEqual(reactionContextFor({ answer: margin, ledger: new Map([['aov_check', 'same']]), signals: null }), { aov: null, currency: null, dealValue: null });
});

test('reaction context: the deal value comes from the ledger and the currency from the stored read', () => {
  const close = answerOf('close_rate', { choice: '2_3' });
  const context = reactionContextFor({ answer: close, ledger: new Map([['deal_value', 'lt2k']]), signals: clinicAccount() });
  assert.equal(context.dealValue, 'lt2k');
  assert.equal(context.currency, 'SAR');
  assert.deepEqual([...ANSWER_KEYS_NEEDING_LEDGER].sort(), ['close_rate', 'margin']);
  for (const key of ANSWER_KEYS_NEEDING_LEDGER) assert.ok(ANSWER_KEYS_NEEDING_SIGNALS.includes(key));
  assert.ok(ANSWER_KEYS_NEEDING_SIGNALS.includes('push_products'));
});

test('saveSetupAnswer passes the reaction context to the reply (margin with the agreed average order)', async () => {
  const stub = {
    from() {
      const chain: any = {
        update: () => chain,
        eq: () => chain,
        insert: () => Promise.resolve({ error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    },
  };
  const answer = answerOf('margin', { choice: 'lt20' });
  const context = { aov: 186, currency: 'SAR', dealValue: null };
  const withContext = await saveSetupAnswer({ supabase: stub, admin: stub, userId: 'u', businessId: 'b', accountId: null, answer, reactionContext: context });
  const without = await saveSetupAnswer({ supabase: stub, admin: stub, userId: 'u', businessId: 'b', accountId: null, answer });
  assert.equal(withContext.ok && withContext.reaction, adaptiveReaction(answer, context));
  assert.match((withContext.ok && withContext.reaction) || '', /37/, '20% of 186, said as a number');
  assert.equal(without.ok && without.reaction, 'تمام، الربح ضيق، فبحسب كل ريال إعلان بدقة.');
});

const ROUTE = readFileSync(resolve(__dirname, '../app/api/setup/answer/route.ts'), 'utf8');

test('answer route: an adaptive key from a user without the flag is a 404 before anything is parsed or written', () => {
  const gate = ROUTE.indexOf("isAdaptiveKey(body?.key) && !adaptiveOn");
  assert.ok(gate > 0, 'the gate exists');
  assert.match(ROUTE.slice(gate, gate + 160), /status: 404/);
  assert.ok(gate < ROUTE.indexOf('parseAnswer(body?.key'), 'the gate comes before parsing');
  assert.ok(gate < ROUTE.indexOf('saveSetupAnswer({'), 'and before the write');
  assert.match(ROUTE, /const adaptiveOn = isAdaptiveOnboarding\(process\.env, user\.email\)/);
});

test('answer route: the workspace is created only for «has_account», only with the flag on, and only when none exists', () => {
  assert.match(ROUTE, /if \(!business && adaptiveOn && parsed\.answer\.key === 'has_account'\) \{\s*business = await ensureSetupBusiness\(supabase, user\);/);
  // Every other answer without a business is still the old 409.
  assert.match(ROUTE, /if \(!business\) return NextResponse\.json\(\{ error: 'no_business' \}, \{ status: 409 \}\)/);
});

test('answer route: product titles and the reaction context are read only for adaptive answers with the flag on', () => {
  assert.match(ROUTE, /if \(adaptiveOn && admin && isAdaptiveAnswer\(answer\) && ANSWER_KEYS_NEEDING_SIGNALS\.includes\(answer\.key\)\)/);
  assert.match(ROUTE, /if \(answer\.key === 'push_products'\) answer = withProductTitles\(answer, signals\)/);
});

test('load.ts: with the flag off nothing adaptive is read and adaptive is null', () => {
  const load = readFileSync(resolve(__dirname, '../lib/setup/load.ts'), 'utf8');
  assert.match(load, /const adaptiveOn = isAdaptiveOnboarding\(process\.env, user\.email\)/);
  assert.match(load, /adaptiveOn && admin \? loadStoredSignals\(admin, selectedAccount\.id\) : Promise\.resolve\(null\)/);
  assert.match(load, /let adaptive: AdaptiveView \| null = null;\s*if \(adaptiveOn\) \{/);
  // pending, stage and plan are overwritten only inside that block.
  const block = load.slice(load.indexOf('if (adaptiveOn) {\n    const built'), load.indexOf('const accountName ='));
  for (const assignment of ['pending = built.pending', 'stage = built.stage', 'plan = built.plan', 'adaptive = built.view']) {
    assert.ok(block.includes(assignment), assignment);
  }
  assert.equal(load.slice(0, load.indexOf('if (adaptiveOn) {\n    const built')).includes('built.'), false);
});

// ---------------------------------------------------------------------------
// ensureSetupBusiness
// ---------------------------------------------------------------------------

type Call = { table: string; op: string; payload?: any; options?: any; filters: Array<[string, unknown]> };

function fakeDb(opts: { existing?: any; created?: any; createError?: boolean; reread?: any; lookupError?: boolean } = {}) {
  const calls: Call[] = [];
  let upserts = 0;
  const client = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      calls.push(call);
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        upsert: (payload: any, options: any) => {
          call.op = 'upsert';
          call.payload = payload;
          call.options = options;
          upserts += 1;
          return chain;
        },
        maybeSingle: () => {
          if (call.op === 'upsert') {
            return Promise.resolve(opts.createError ? { data: null, error: { message: 'x' } } : { data: opts.created ?? null, error: null });
          }
          const selects = calls.filter((c) => c.table === 'businesses' && c.op === 'select').length;
          if (opts.lookupError) return Promise.resolve({ data: null, error: { message: 'x' } });
          return Promise.resolve({ data: selects === 1 ? opts.existing ?? null : opts.reread ?? null, error: null });
        },
        then: (resolve: (value: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    },
  };
  return { client, calls, upserts: () => upserts };
}

const SETUP_USER = { id: 'u1', email: 'sultan@example.com', user_metadata: { full_name: 'سلطان الحربي', picture: 'https://example.com/a.png' } };

test('ensureSetupBusiness: an existing workspace is returned as it is, nothing is written', async () => {
  const db = fakeDb({ existing: { id: 'b1', selected_google_ads_customer_id: null } });
  const admin = fakeDb();
  const business = await ensureSetupBusiness(db.client, SETUP_USER, { admin: admin.client });
  assert.deepEqual(business, { id: 'b1', selected_google_ads_customer_id: null });
  assert.equal(db.upserts(), 0);
  assert.equal(admin.calls.length, 0);
});

test('ensureSetupBusiness: no workspace makes the profile row first, then upserts the business on the unique user_id', async () => {
  const db = fakeDb({ created: { id: 'b2', selected_google_ads_customer_id: null } });
  const admin = fakeDb();
  const business = await ensureSetupBusiness(db.client, SETUP_USER, { admin: admin.client });
  assert.deepEqual(business, { id: 'b2', selected_google_ads_customer_id: null });

  const profile = admin.calls.find((call) => call.table === 'users');
  assert.ok(profile, 'the profile row is ensured');
  assert.equal(profile.op, 'upsert');
  assert.equal(profile.payload.id, 'u1');
  assert.equal(profile.payload.email, 'sultan@example.com');
  assert.deepEqual(profile.options, { onConflict: 'id', ignoreDuplicates: true }, 'an existing profile is never overwritten');

  const insert = db.calls.find((call) => call.table === 'businesses' && call.op === 'upsert');
  assert.ok(insert);
  assert.deepEqual(insert.options, { onConflict: 'user_id', ignoreDuplicates: true });
  assert.equal(insert.payload.user_id, 'u1');
  assert.equal(insert.payload.name, 'سلطان الحربي');
  assert.deepEqual(insert.payload.target_regions, []);
  assert.equal(insert.payload.sector, undefined, 'no sector: the customer has not said what the business is');
});

test('ensureSetupBusiness: a racing request that created it first is read back', async () => {
  const db = fakeDb({ created: null, reread: { id: 'b3', selected_google_ads_customer_id: null } });
  const business = await ensureSetupBusiness(db.client, SETUP_USER, { admin: fakeDb().client });
  assert.equal(business?.id, 'b3');
});

test('ensureSetupBusiness: failures return null and never throw; a missing admin client skips only the profile', async () => {
  assert.equal(await ensureSetupBusiness(fakeDb({ createError: true }).client, SETUP_USER, { admin: fakeDb().client }), null);
  assert.equal(await ensureSetupBusiness(fakeDb({ lookupError: true }).client, SETUP_USER, { admin: fakeDb().client }), null);
  const brokenAdmin = { from: () => { throw new Error('no service key'); } };
  const still = await ensureSetupBusiness(fakeDb({ created: { id: 'b4', selected_google_ads_customer_id: null } }).client, SETUP_USER, { admin: brokenAdmin });
  assert.equal(still?.id, 'b4');
  const noAdmin = await ensureSetupBusiness(fakeDb({ created: { id: 'b5', selected_google_ads_customer_id: null } }).client, SETUP_USER, { admin: null });
  assert.equal(noAdmin?.id, 'b5');
  // A name with no metadata falls back to the email's local part, then to «نشاطي».
  const named = fakeDb({ created: { id: 'b6', selected_google_ads_customer_id: null } });
  await ensureSetupBusiness(named.client, { id: 'u2', email: 'ali@example.com' }, { admin: null });
  assert.equal(named.calls.find((call) => call.op === 'upsert')?.payload.name, 'ali');
  const unnamed = fakeDb({ created: { id: 'b7', selected_google_ads_customer_id: null } });
  await ensureSetupBusiness(unnamed.client, { id: 'u3' }, { admin: null });
  assert.equal(unnamed.calls.find((call) => call.op === 'upsert')?.payload.name, 'نشاطي');
});

// ---------------------------------------------------------------------------
// readLedgerEntries
// ---------------------------------------------------------------------------

function ledgerAdmin(rows: unknown, error: unknown = null) {
  const chain: any = {};
  for (const name of ['select', 'eq', 'order', 'limit']) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error });
  return { from: () => chain };
}

test('readLedgerEntries: the newest fact per key wins, with its label capped at the limit', async () => {
  const long = 'م'.repeat(300);
  const admin = ledgerAdmin([
    { data: { setup_key: 'push_products', choice: 'p_1', label: 'عطر الورد' } },
    { data: { setup_key: 'push_products', choice: 'p_0', label: 'قديم' } },
    { data: { setup_key: 'focus_service', choice: 'other', label: long } },
    { data: { setup_key: 'budget', choice: undefined } },
    { data: { setup_key: 'not_a_key', choice: 'x', label: 'x' } },
    { data: { setup_key: 'pain', choice: 'clinic_few_calls', label: 42 } },
  ]);
  const entries = await readLedgerEntries(admin, 'b1');
  assert.equal(entries.choices.get('push_products'), 'p_1');
  assert.equal(entries.labels.push_products, 'عطر الورد');
  assert.equal(entries.labels.focus_service?.length, LEDGER_LABEL_MAX);
  assert.equal(entries.choices.get('budget'), null);
  assert.equal(entries.choices.has('not_a_key' as any), false);
  assert.equal(entries.labels.pain, undefined, 'a label that is not text is ignored');
  assert.equal(entries.labels.budget, undefined);
});

test('readLedgerEntries and readLedger: any failure reads as nothing on record; readLedger keeps returning the choices Map', async () => {
  for (const admin of [null, ledgerAdmin(null, { message: 'x' }), ledgerAdmin('nope'), { from: () => { throw new Error('x'); } }]) {
    const entries = await readLedgerEntries(admin, 'b1');
    assert.equal(entries.choices.size, 0);
    assert.deepEqual(entries.labels, {});
    assert.equal((await readLedger(admin, 'b1')).size, 0);
  }
  const rows = [{ data: { setup_key: 'type', choice: 'clinic' } }];
  const map = await readLedger(ledgerAdmin(rows), 'b1');
  assert.ok(map instanceof Map);
  assert.equal(map.get('type'), 'clinic');
});

// ---------------------------------------------------------------------------
// Support link
// ---------------------------------------------------------------------------

test('whatsapp help: the full-management opener', () => {
  const url = whatsappHelpUrl('full_management', 'sultan@example.com');
  assert.ok(url.startsWith(`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=`));
  const text = decodeURIComponent(url.split('?text=')[1]);
  assert.equal(text, 'السلام عليكم\nسجلت في مضاعف وابي فريق مضاعفة يدير حساب اعلاناتي\nايميلي في المنصة: sultan@example.com');
  // The three existing reasons are unchanged.
  assert.match(decodeURIComponent(whatsappHelpUrl('no_ads_account').split('?text=')[1]), /ما عندي حساب اعلانات قوقل، ابي مساعدة افتحه/);
});

// ---------------------------------------------------------------------------
// Copy rules for everything view.ts returns for the snapshot accounts
// ---------------------------------------------------------------------------

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

test('copy: nothing the view returns has a long dash, a Latin comma in Arabic prose or a banned phrase', () => {
  const banned = ['ليس مجرد', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'حلول متكاملة', 'رحلتك', 'باختصار', 'زياد'];
  const cases = [
    input(),
    input({ signals: sallaAccount(), plan: auditPlan() }),
    input({ signals: untrackedAccount(), plan: auditPlan() }),
    input({ signals: newAccount(), answered: FRESH_ANSWERED }),
    input({ answered: { manager: 'agency' }, plan: auditPlan() }),
    input({ signals: null, linkedAccounts: 0, accountChosen: false, answered: { has_account: 'none', ...FRESH_ANSWERED } }),
  ];
  for (const one of cases) {
    const { view, plan } = buildAdaptiveView(one);
    for (const text of allStrings({ view, plan })) {
      assert.equal(/[—–]/.test(text), false, `long dash in ${text}`);
      assert.equal(/[؀-ۿ]\s*,\s*[؀-ۿ]/.test(text), false, `Latin comma in ${text}`);
      for (const phrase of banned) assert.equal(text.includes(phrase), false, `${phrase} in ${text}`);
    }
  }
});
