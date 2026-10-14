import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ADAPTIVE_CATALOG,
  adaptiveEffects,
  adaptiveLabel,
  adaptiveReaction,
  breakEvenLine,
  contactValueLine,
  parseAdaptiveAnswer,
} from '../lib/setup/adaptive/answers';
import { adaptivePending, adaptiveQuestion, pushProductChoices, withProductTitles } from '../lib/setup/adaptive/bank';
import { AGENCY_FULL_MANAGEMENT_CARD, agencyQuestions, firstCampaignPlan } from '../lib/setup/adaptive/endings';
import { scenarioDecision, planReason, largestClosedStretch } from '../lib/setup/adaptive/decisions';
import { ALL_FOCUS_ENTRIES } from '../lib/setup/adaptive/focus';
import { buildOpener } from '../lib/setup/adaptive/opener';
import { classifyScenario } from '../lib/setup/adaptive/scenario';
import { money } from '../lib/setup/adaptive/shared';
import { understandingRows } from '../lib/setup/adaptive/understanding';
import {
  ADAPTIVE_KEYS,
  type AccountSignals,
  type AdaptiveAnswer,
  type AdaptiveKey,
  type CampaignSignal,
  type ConversionGroup,
  type HourSignal,
  type ProductSignal,
  type Scenario,
} from '../lib/setup/adaptive/types';
import {
  GOAL_OPTIONS,
  KIND_GOAL_OPTIONS,
  KIND_PAIN_OPTIONS,
  PAIN_OPTIONS,
  TYPE_OPTIONS,
  answerEffects,
  answerLabel,
  formatAmount,
  parseAnswer,
  reactionTo,
  type SetupKey,
} from '../lib/setup/questions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const failed = { ok: false as const, error: 'not_read' };

/** Every signal failed unless the test says otherwise. */
function account(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return {
    version: 1,
    readAt: '2026-10-14T08:00:00.000Z',
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

/** The ad hours: expensive while the phone is answered (9 to 13 and 16 to 22), cheap otherwise. */
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

/** A dental clinic in Jeddah: two search campaigns, calls first, forms second, tracked. */
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

/** A perfume store on Salla: 3,200 spent, 41 orders worth 7,626, so an average order of 186. */
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

function classify(signals: AccountSignals | null, answered: Partial<Record<string, string | null>> = {}, extra: { linked?: number; noAccount?: boolean } = {}): Scenario {
  return classifyScenario({ signals, linkedAccounts: extra.linked ?? 1, connectNoAccount: extra.noAccount ?? false, answered });
}

function pending(scenario: Scenario, answered: Partial<Record<string, string | null>> = {}, extra: { consent?: boolean; edit?: boolean; hasAccount?: boolean } = {}): SetupKey[] {
  return adaptivePending({
    scenario,
    answered,
    consentAnswered: extra.consent ?? false,
    edit: extra.edit ?? false,
    hasAccount: extra.hasAccount ?? true,
  });
}

function parsed(key: AdaptiveKey, raw: unknown): AdaptiveAnswer {
  const result = parseAdaptiveAnswer(key, raw);
  assert.equal(result.ok, true, `expected ${key} ${JSON.stringify(raw)} to parse: ${JSON.stringify(result)}`);
  return (result as { ok: true; answer: AdaptiveAnswer }).answer;
}

// ---------------------------------------------------------------------------
// Copy rules
// ---------------------------------------------------------------------------

const BANNED_PHRASES = ['ليس مجرد', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'حلول متكاملة', 'رحلتك', 'باختصار', 'زياد'];

/** Every string anywhere inside a value. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

function assertCopyRules(value: unknown, where: string) {
  for (const text of allStrings(value)) {
    assert.doesNotMatch(text, /[–—]/, `${where}: long dash in «${text}»`);
    assert.doesNotMatch(text, /[؀-ۿ]\s*,|,\s*[؀-ۿ]/, `${where}: Latin comma in Arabic prose «${text}»`);
    for (const phrase of BANNED_PHRASES) assert.equal(text.includes(phrase), false, `${where}: banned «${phrase}» in «${text}»`);
  }
}

// ---------------------------------------------------------------------------
// classifyScenario: state
// ---------------------------------------------------------------------------

test('state: no_account needs no linked account and a say-so, either from the connect job or the answer', () => {
  assert.equal(classify(null, {}, { linked: 0, noAccount: true }).state, 'no_account');
  assert.equal(classify(null, { has_account: 'none' }, { linked: 0 }).state, 'no_account');
  // A linked account wins over a stale «none».
  assert.notEqual(classify(clinicAccount(), { has_account: 'none' }, { linked: 1 }).state, 'no_account');
  // No account linked and nothing said: we simply have not read anything.
  assert.equal(classify(null, {}, { linked: 0 }).state, 'active');
});

test('state: new, dormant, no_tracking, tracking_suspect and active, in that order', () => {
  const empty = account({ campaigns: { ok: true, value: [] } });
  assert.equal(classify(empty).state, 'new');
  const zero = account({ campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث' })] } });
  assert.equal(classify(zero).state, 'new');
  const paused = account({ campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث', status: 'PAUSED' })] } });
  assert.equal(classify(paused).state, 'dormant');

  const spending = (conversions: number, clicks: number, actions: number | null) =>
    account({
      campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث', cost30: 500, impressions30: 5000, clicks30: clicks, conversions30: conversions })] },
      enabledConversionActions: actions === null ? failed : { ok: true, value: actions },
    });
  assert.equal(classify(spending(0, 300, 0)).state, 'no_tracking');
  assert.equal(classify(spending(0, 300, 2)).state, 'tracking_suspect');
  assert.equal(classify(spending(0, 100, 2)).state, 'tracking_suspect', 'exactly the click threshold counts');
  assert.equal(classify(spending(0, 99, 2)).state, 'active', 'too few clicks to doubt the tracking');
  assert.equal(classify(spending(5, 300, 2)).state, 'active');
});

test('state: a signal that failed never drives a branch, the tree falls back to asking', () => {
  assert.equal(classify(null).state, 'active');
  assert.equal(classify(null).kindConfidence, 'none');
  const unread = classify(account());
  assert.equal(unread.state, 'active');
  assert.equal(unread.kind, 'general');
  assert.equal(unread.kindConfidence, 'none');
  assert.ok(unread.evidence.includes('no_read'));
  // Spending, but the count of conversion actions could not be read: not no_tracking, not tracking_suspect.
  const unknownActions = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث', cost30: 500, impressions30: 5000, clicks30: 900 })] },
    enabledConversionActions: failed,
  });
  assert.equal(classify(unknownActions).state, 'active');
});

// ---------------------------------------------------------------------------
// classifyScenario: kind, confidence, platform, specialty, outcome, managed
// ---------------------------------------------------------------------------

test('kind: the snapshot accounts are read as confident clinic and ecommerce', () => {
  const clinic = classify(clinicAccount());
  assert.equal(clinic.kind, 'clinic');
  assert.equal(clinic.kindConfidence, 'confident');
  assert.equal(clinic.specialty, 'dental');
  assert.equal(clinic.outcome, 'calls');
  assert.equal(clinic.platform, null);
  for (const code of ['words:clinic', 'conv:call', 'places', 'hosts', 'mgr_read', 'hours']) assert.ok(clinic.evidence.includes(code), code);

  const store = classify(sallaAccount());
  assert.equal(store.kind, 'ecommerce');
  assert.equal(store.kindConfidence, 'confident');
  assert.equal(store.platform, 'salla');
  assert.equal(store.outcome, 'purchases');
  for (const code of ['host:salla', 'mc', 'pmax_purchase', 'value', 'aov', 'products']) assert.ok(store.evidence.includes(code), code);
});

test('kind: store platforms come from the landing hosts', () => {
  const withHost = (host: string) => classify(sallaAccount({ landingHosts: { ok: true, value: [host] }, merchantCenterLinked: failed }));
  assert.equal(withHost('shop.salla.sa').platform, 'salla');
  assert.equal(withHost('shop.salla.store').platform, 'salla');
  assert.equal(withHost('shop.zid.store').platform, 'zid');
  assert.equal(withHost('shop.myshopify.com').platform, 'shopify');
  assert.equal(withHost('www.example.com').platform, null);
});

test('kind: confident needs a score of 3 and a lead of 2, otherwise it is a guess, and a lone call conversion is only a guess', () => {
  // Calls alone: clinic and services both get 1, the tie goes to the order clinic, services.
  const callsOnly = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'حملة 1', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 20 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['call', 20]),
  });
  const guess = classify(callsOnly);
  assert.equal(guess.kindConfidence, 'guess');
  assert.equal(guess.kind, 'clinic');
  assert.equal(guess.kindRanking[0], 'clinic');

  // Clinic words (3) plus calls (1) against services (1): lead 3, confident.
  assert.equal(classify(clinicAccount()).kindConfidence, 'confident');

  // Two kinds at 4 (clinic words plus a booking, services words plus the same booking): the lead is not there.
  const tied = account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'عيادة أسنان', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 5 }),
        campaign({ id: '2', name: 'شركة تنظيف', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 5 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['booking', 10]),
  });
  const close = classify(tied);
  assert.equal(close.kindConfidence, 'guess');
  assert.equal(close.kind, 'clinic');
});

test('kind: services words, local campaigns and directions', () => {
  const services = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'شركة تنظيف مجالس', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 10 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['lead_form', 10]),
  });
  const s = classify(services);
  assert.equal(s.kind, 'services');
  assert.equal(s.kindConfidence, 'confident');
  assert.equal(s.outcome, 'forms');

  const local = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'مطعم الحي', kind: 'LOCAL', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 10 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['directions', 10]),
    assets: { ok: true, value: { call: false, locations: 3 } },
  });
  const l = classify(local);
  assert.equal(l.kind, 'local');
  assert.equal(l.kindConfidence, 'confident');
  assert.equal(l.outcome, 'visits');
});

test('kind: a stated type overrides the guess, a «no» on the opener drops the confidence', () => {
  const stated = classify(sallaAccount(), { type: 'clinic' });
  assert.equal(stated.kind, 'clinic');
  assert.equal(stated.kindConfidence, 'stated');
  assert.equal(stated.kindRanking[0], 'clinic');
  assert.equal(stated.platform, null, 'a store platform means nothing for a clinic');
  assert.ok(stated.evidence.includes('stated:type'));

  assert.equal(classify(null, { type: 'real_estate' }).kind, 'services');
  assert.equal(classify(null, { type: 'restaurant' }).kind, 'local');
  assert.equal(classify(null, { type: 'local_store' }).kind, 'local');
  assert.equal(classify(null, { type: 'education' }).kind, 'general');
  assert.equal(classify(null, { type: 'other' }).kind, 'general');
  assert.equal(classify(null, { type: 'other' }).kindConfidence, 'stated');

  const denied = classify(sallaAccount(), { confirm: 'no' });
  assert.equal(denied.kindConfidence, 'none');
  assert.ok(denied.evidence.includes('confirm:no'));
  assert.equal(denied.kind, 'ecommerce', 'the guess is kept for ordering the type question');
  // A «no» does not cancel a type the customer stated.
  assert.equal(classify(sallaAccount(), { confirm: 'no', type: 'ecommerce' }).kindConfidence, 'stated');
});

test('specialty: dental, derma, or general; hair transplants are not dental', () => {
  const named = (name: string) =>
    classify(account({ campaigns: { ok: true, value: [campaign({ id: '1', name, cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 10 })] } }), { type: 'clinic' }).specialty;
  assert.equal(named('تقويم الأسنان'), 'dental');
  assert.equal(named('عيادة جلدية ليزر'), 'derma');
  assert.equal(named('زراعة الشعر'), 'general');
  assert.equal(named('عيادة'), 'general');
  assert.equal(classify(null, { type: 'ecommerce' }).specialty, null);
});

test('managed: an agency answer confirms, an outside manager or other editors only suspect', () => {
  assert.equal(classify(clinicAccount()).managed, 'none');
  assert.equal(classify(clinicAccount(), { manager: 'agency' }).managed, 'confirmed');
  assert.equal(classify(clinicAccount(), { manager: 'employee' }).managed, 'confirmed');
  assert.equal(classify(clinicAccount(), { manager: 'self' }).managed, 'none');
  const linked = clinicAccount({ externalManager: { ok: true, value: { linked: true, managerIds: ['7770001112'] } } });
  assert.equal(classify(linked).managed, 'suspected');
  assert.ok(classify(linked).evidence.includes('mgr:link'));
  const editors = clinicAccount({ otherEditors14d: { ok: true, value: 2 } });
  assert.equal(classify(editors).managed, 'suspected');
  assert.ok(classify(editors).evidence.includes('mgr:editors'));
  // A failed read says nothing, and does not claim the account was read for managers.
  const unread = clinicAccount({ externalManager: failed, otherEditors14d: failed });
  assert.equal(classify(unread).managed, 'none');
  assert.equal(classify(unread).evidence.includes('mgr_read'), false);
});

// ---------------------------------------------------------------------------
// adaptivePending
// ---------------------------------------------------------------------------

test('pending: the dental clinic is asked eight things', () => {
  assert.deepEqual(pending(classify(clinicAccount())), [
    'confirm',
    'focus_service',
    'value',
    'pain',
    'call_hours',
    'whatsapp_booking',
    'budget',
    'consent',
  ]);
});

test('pending: the Salla store is asked eight things', () => {
  assert.deepEqual(pending(classify(sallaAccount())), [
    'confirm',
    'aov_check',
    'margin',
    'push_products',
    'exclude_products',
    'pain',
    'budget',
    'consent',
  ]);
});

test('pending: a store without a computable average order is asked the plain value question', () => {
  const noValue = sallaAccount({
    campaigns: {
      ok: true,
      value: [campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 3200, impressions30: 60000, clicks30: 2000, conversions30: 41 })],
    },
  });
  const list = pending(classify(noValue));
  assert.ok(list.includes('value'));
  assert.equal(list.includes('aov_check'), false);
  assert.equal(adaptiveQuestion('aov_check', { scenario: classify(noValue), signals: noValue, answered: {}, edit: false }), null);
});

test('pending: answered keys are never asked again, and consent follows its own flag', () => {
  const scenario = classify(clinicAccount());
  assert.deepEqual(pending(scenario, { confirm: 'yes', focus_service: 'dental_braces', pain: 'clinic_few_calls' }), [
    'value',
    'call_hours',
    'whatsapp_booking',
    'budget',
    'consent',
  ]);
  assert.equal(pending(scenario, {}, { consent: true }).includes('consent'), false);
  // An answer stored without a choice id (budget set on the business) still counts as answered.
  assert.equal(pending(scenario, { budget: null }).includes('budget'), false);
  // The plain value question and the average-order check replace each other.
  const store = classify(sallaAccount());
  assert.equal(pending(store, { value: '100_500' }).includes('aov_check'), false);
  assert.equal(pending(store, { aov_check: 'same' }).includes('value'), false);
});

test('pending: a «no» on the opener asks the type and the goal back', () => {
  const scenario = classify(clinicAccount(), { confirm: 'no' });
  const list = pending(scenario, { confirm: 'no' });
  assert.ok(list.includes('type'));
  assert.ok(list.includes('goal'));
  assert.equal(list.includes('confirm'), false);
  assert.equal(list.includes('focus_service'), false, 'general wording: no kind to build the questions on');
  // The type question lists the rejected guess last (before «غير كذا»).
  const question = adaptiveQuestion('type', { scenario, signals: clinicAccount(), answered: { confirm: 'no' }, edit: false });
  assert.ok(question);
  const ids = question.options.map((option) => option.id);
  assert.equal(ids[ids.length - 1], 'other');
  assert.equal(ids[ids.length - 2], 'clinic');
});

test('pending: a confirmed agency drops consent, a suspected one is asked first after the opener', () => {
  const confirmed = classify(clinicAccount(), { manager: 'agency' });
  assert.equal(pending(confirmed, { manager: 'agency' }).includes('consent'), false);
  const suspected = classify(clinicAccount({ otherEditors14d: { ok: true, value: 1 } }));
  assert.deepEqual(pending(suspected).slice(0, 2), ['confirm', 'manager']);
});

test('pending: when the read has no manager answer the question stays', () => {
  const unread = clinicAccount({ externalManager: failed, otherEditors14d: failed });
  const list = pending(classify(unread));
  assert.ok(list.includes('manager'));
  assert.ok(list.indexOf('manager') < list.indexOf('budget'));
});

test('pending: what the account answers itself is not asked (regions, website), and is asked when the read failed', () => {
  const read = pending(classify(clinicAccount()));
  assert.equal(read.includes('regions'), false);
  assert.equal(read.includes('website'), false);
  const blind = clinicAccount({ targetedPlaces: failed, landingHosts: failed });
  const list = pending(classify(blind));
  assert.ok(list.includes('regions'));
  assert.ok(list.includes('website'));
});

test('pending: services and local have their own lists', () => {
  const services = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'شركة تنظيف مجالس', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 10 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['lead_form', 10]),
    targetedPlaces: { ok: true, value: ['Riyadh'] },
    landingHosts: { ok: true, value: ['clean.example.sa'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
  });
  assert.deepEqual(pending(classify(services)), [
    'confirm',
    'focus_service',
    'deal_value',
    'close_rate',
    'pain',
    'budget',
    'consent',
  ]);

  const local = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'مطعم الحي', kind: 'LOCAL', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 10 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['directions', 10]),
    assets: { ok: true, value: { call: false, locations: 3 } },
    targetedPlaces: { ok: true, value: ['Riyadh'] },
    landingHosts: { ok: true, value: ['food.example.sa'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
  });
  assert.deepEqual(pending(classify(local)), ['confirm', 'goal', 'peak_hours', 'value', 'delivery_apps', 'budget', 'consent']);
});

test('pending: no tracking adds tracking_now before the budget', () => {
  const noTracking = sallaAccount({
    enabledConversionActions: { ok: true, value: 0 },
    conversionsByGroup: groups(),
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 3200, impressions30: 60000, clicks30: 2000 })] },
  });
  const scenario = classify(noTracking);
  assert.equal(scenario.state, 'no_tracking');
  const list = pending(scenario);
  assert.ok(list.indexOf('tracking_now') > list.indexOf('pain'));
  assert.equal(list[list.indexOf('tracking_now') + 1], 'budget');
  assert.ok(list.includes('goal'), 'no conversions means the opener cannot write the goal');
});

test('pending: new, dormant and no_account ask what they sell, where, the goal and the budget, never the pain', () => {
  const fresh = ['type', 'focus_service', 'regions', 'goal', 'budget', 'website'];
  assert.deepEqual(pending(classify(account({ campaigns: { ok: true, value: [] } }))), fresh);
  assert.deepEqual(pending(classify(account({ campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث', status: 'PAUSED' })] } }))), fresh);
  assert.deepEqual(pending(classify(null, {}, { linked: 0, noAccount: true }), {}, { hasAccount: false }), fresh);
  const list = pending(classify(account({ campaigns: { ok: true, value: [] } })));
  assert.equal(list.includes('pain'), false);
  assert.equal(list.includes('consent'), false);
});

test('pending: general (nothing read) is the old ten questions', () => {
  assert.deepEqual(pending(classify(null)), ['type', 'name', 'goal', 'value', 'budget', 'regions', 'manager', 'pain', 'website', 'consent']);
});

test('pending: edit mode asks every key of the scenario again, except confirm and has_account', () => {
  const scenario = classify(clinicAccount());
  const answered = { confirm: 'yes', focus_service: 'dental_braces', value: '100_500', pain: 'clinic_few_calls', call_hours: 'always' };
  assert.deepEqual(pending(scenario, answered, { edit: true }), [
    // The type and the goal can be changed while editing, for every kind (the clinic's own list skips them).
    'type',
    'goal',
    'focus_service',
    'value',
    'pain',
    'call_hours',
    'whatsapp_booking',
    'budget',
    'consent',
  ]);
  // The current choice is marked on the question.
  const question = adaptiveQuestion('call_hours', { scenario, signals: clinicAccount(), answered, edit: true });
  assert.equal(question?.current, 'always');
  assert.equal(adaptiveQuestion('call_hours', { scenario, signals: clinicAccount(), answered, edit: false })?.current, null);
  // Someone who said who manages the account may change it.
  assert.ok(pending(scenario, { manager: 'self' }, { edit: true }).includes('manager'));
  // Consent still follows its own flag.
  assert.equal(pending(scenario, answered, { edit: true, consent: true }).includes('consent'), false);
});

// ---------------------------------------------------------------------------
// adaptiveQuestion
// ---------------------------------------------------------------------------

test('questions: the clinic is asked in the clinic words', () => {
  const signals = clinicAccount();
  const scenario = classify(signals);
  const ask = (key: SetupKey) => adaptiveQuestion(key, { scenario, signals, answered: {}, edit: false });

  const focus = ask('focus_service');
  assert.equal(focus?.text, 'وش الخدمة اللي تبي تكثر حجوزاتها؟');
  assert.equal(focus?.why, 'أوجّه أغلب الميزانية لها.');
  // The services the campaigns already talk about come first, and say so.
  assert.deepEqual(focus?.options.slice(0, 2).map((option) => option.id), ['dental_implants', 'dental_braces']);
  assert.equal(focus?.options[0].hint, 'من حملاتك');
  assert.equal(focus?.options.some((option) => option.id === 'all'), true);
  assert.ok(focus?.freeText);

  assert.equal(ask('value')?.text, 'كم يدفع المريض تقريباً في أول زيارة؟');
  assert.deepEqual(ask('pain')?.options.map((option) => option.id), ['clinic_few_calls', 'clinic_price_shoppers', 'clinic_costly_booking', 'unsure']);
  assert.equal(ask('call_hours')?.text, 'متى أحد يرد على اتصالات العيادة؟');
  assert.equal(ask('call_hours')?.why, 'الاتصال اللي ما ينرد عليه حجز ضايع.');
  assert.deepEqual(ask('call_hours')?.options.map((option) => option.id), ['split_9_13_16_22', 'day_8_23', 'evening_16_24', 'always']);
  assert.equal(ask('call_hours')?.options[0].label, 'فترتين: 9 الصبح لين 1، و4 العصر لين 10 الليل');
  assert.equal(ask('whatsapp_booking')?.text, 'فيه واتساب للحجز؟');
  assert.deepEqual(ask('whatsapp_booking')?.options.map((option) => option.id), ['yes', 'no', 'link']);
  assert.equal(ask('confirm')?.text, 'صح كذا؟');
});

test('questions: the store is asked in the store words, with the average order the account reports', () => {
  const signals = sallaAccount();
  const scenario = classify(signals);
  const ask = (key: SetupKey) => adaptiveQuestion(key, { scenario, signals, answered: {}, edit: false });

  assert.equal(ask('aov_check')?.text, 'متوسط طلبك من قوقل طلع قرابة 186 ريال. قريب من الصح؟');
  assert.deepEqual(ask('aov_check')?.options.map((option) => option.label), ['إي قريب', 'لا، أقل', 'لا، أكثر']);
  assert.equal(ask('margin')?.text, 'من كل 100 ريال تبيعها، كم يتبقى لك بعد تكلفة المنتج والشحن؟');
  assert.deepEqual(ask('margin')?.options.map((option) => option.label), ['أقل من 20 ريال', 'من 20 إلى 40 ريال', 'أكثر من 40 ريال', 'ما أدري']);
  assert.deepEqual(ask('pain')?.options.map((option) => option.label), [
    'الطلبات قليلة',
    'فيه طلبات بس الإعلان ياكل الربح',
    'السلة تنترك كثير',
    'ما أدري، شوف أنت',
  ]);
  assert.equal(ask('confirm')?.text, 'صح إن اللي يهمك الطلبات من المتجر؟');
  assert.equal(ask('exclude_products')?.options.some((option) => option.id === 'text'), false, 'typing goes through the free text box');
});

test('questions: push_products offers the six costliest products as p_<index>, or only free text when none were read', () => {
  const signals = sallaAccount();
  const question = adaptiveQuestion('push_products', { scenario: classify(signals), signals, answered: {}, edit: false });
  assert.equal(question?.layout, 'chips');
  assert.deepEqual(question?.options.map((option) => option.id), ['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'none']);
  assert.equal(question?.options[0].label, 'عطر العود الملكي');
  assert.equal(question?.options[5].label, 'دهن عود');
  assert.deepEqual(pushProductChoices(signals).map((choice) => choice.title), PRODUCTS.slice(0, 6).map((product) => product.title));

  const blind = sallaAccount({ products: failed });
  const typed = adaptiveQuestion('push_products', { scenario: classify(blind), signals: blind, answered: {}, edit: false });
  assert.deepEqual(typed?.options.map((option) => option.id), ['none']);
  assert.ok(typed?.freeText);
  assert.deepEqual(pushProductChoices(null), []);
});

test('questions: titles from the account are cleaned', () => {
  const signals = sallaAccount({ products: { ok: true, value: [{ id: 'x', title: '  <b>عطر</b>   {خاص}  ', cost30: 90, conversions30: 1, value30: 100 }] } });
  assert.deepEqual(pushProductChoices(signals).map((choice) => choice.title), ['bعطر/b خاص']);
});

test('questions: legacy keys with nothing to say differently return null so the old dock is used', () => {
  const clinicCtx = { scenario: classify(clinicAccount()), signals: clinicAccount(), answered: {}, edit: false };
  for (const key of ['budget', 'consent', 'regions', 'website', 'name'] as const) assert.equal(adaptiveQuestion(key, clinicCtx), null, key);
  const general = { scenario: classify(null), signals: null, answered: {}, edit: false };
  for (const key of ['goal', 'value', 'pain', 'budget', 'name', 'consent'] as const) assert.equal(adaptiveQuestion(key, general), null, key);
});

test('questions: services and local ask their own goal, deal and rhythm questions', () => {
  const services = classify(null, { type: 'services' });
  const ctx = (scenario: Scenario) => ({ scenario, signals: null, answered: {}, edit: false });
  assert.equal(adaptiveQuestion('deal_value', ctx(services))?.text, 'كم تسوى لك الصفقة الواحدة تقريباً؟');
  assert.equal(adaptiveQuestion('close_rate', ctx(services))?.text, 'من كل 10 يتواصلون معك، كم يصيرون عملاء؟');
  assert.deepEqual(adaptiveQuestion('pain', ctx(services))?.options.map((option) => option.id), ['svc_wrong_calls', 'svc_price_ghosts', 'svc_few_calls', 'unsure']);
  const local = classify(null, { type: 'restaurant' });
  assert.deepEqual(adaptiveQuestion('goal', ctx(local))?.options.map((option) => option.id), ['local_visits', 'local_delivery', 'local_bookings', 'local_calls']);
  assert.equal(adaptiveQuestion('peak_hours', ctx(local))?.layout, 'chips');
  assert.equal(adaptiveQuestion('pain', ctx(local)), null, 'local never asks the pain question');
  assert.equal(adaptiveQuestion('value', ctx(local))?.text, 'كم متوسط الفاتورة؟');
});

test('questions: no tracking asks how the customer knows a customer came', () => {
  const noTracking = sallaAccount({ enabledConversionActions: { ok: true, value: 0 }, conversionsByGroup: groups() });
  const scenario = classify(noTracking);
  const question = adaptiveQuestion('tracking_now', { scenario, signals: noTracking, answered: {}, edit: false });
  assert.equal(question?.text, 'كيف تعرف الحين إن الإعلان جاب لك عميل؟');
  assert.deepEqual(question?.options.map((option) => option.id), ['tells_me', 'check_records', 'dont_know']);
  assert.equal(question?.options[1].label, 'أشوف الطلبات في المتجر');
});

// ---------------------------------------------------------------------------
// answers
// ---------------------------------------------------------------------------

test('answers: every key has a catalog and accepts exactly its ids', () => {
  for (const key of ADAPTIVE_KEYS) {
    const options = ADAPTIVE_CATALOG[key];
    assert.ok(Array.isArray(options), key);
    const ids = options.map((option) => option.id);
    assert.equal(new Set(ids).size, ids.length, `${key}: ids are unique`);
    for (const id of ids) assert.match(id, /^[a-z0-9_]+$/, `${key}.${id}: lowercase ascii`);
  }
  assert.deepEqual(parseAdaptiveAnswer('margin', { choice: 'lt20' }), { ok: true, answer: { key: 'margin', choice: 'lt20' } });
  assert.deepEqual(parseAdaptiveAnswer('margin', { choice: 'huge' }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('margin', {}), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('margin', null), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('salary' as AdaptiveKey, { choice: 'x' }), { ok: false, error: 'invalid_key' });
  // The shared entry point routes the new keys here.
  assert.deepEqual(parseAnswer('call_hours', { choice: 'day_8_23' }), { ok: true, answer: { key: 'call_hours', choice: 'day_8_23' } });
  assert.deepEqual(parseAnswer('call_hours', { choice: 'whenever' }), { ok: false, error: 'invalid_choice' });
});

test('answers: confirm carries the proposal on yes and nothing on no', () => {
  assert.deepEqual(parsed('confirm', { choice: 'yes', kind: 'clinic', outcome: 'calls' }), { key: 'confirm', choice: 'yes', kind: 'clinic', outcome: 'calls' });
  assert.deepEqual(parsed('confirm', { choice: 'yes' }), { key: 'confirm', choice: 'yes' });
  assert.deepEqual(parsed('confirm', { choice: 'no', kind: 'clinic' }), { key: 'confirm', choice: 'no' });
  assert.deepEqual(parseAdaptiveAnswer('confirm', { choice: 'maybe' }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('confirm', { choice: 'yes', kind: 'bank' }), { ok: false, error: 'invalid_kind' });
  assert.deepEqual(parseAdaptiveAnswer('confirm', { choice: 'yes', outcome: 'riches' }), { ok: false, error: 'invalid_outcome' });
});

test('answers: focus_service takes a catalog id, or «other» with 2 to 40 characters of text', () => {
  assert.deepEqual(parsed('focus_service', { choice: 'dental_braces' }), { key: 'focus_service', choice: 'dental_braces' });
  assert.deepEqual(parsed('focus_service', { choice: 'all' }), { key: 'focus_service', choice: 'all' });
  assert.deepEqual(parsed('focus_service', { choice: 'other', text: '  تقويم   شفاف ' }), { key: 'focus_service', choice: 'other', text: 'تقويم شفاف' });
  assert.deepEqual(parseAdaptiveAnswer('focus_service', { choice: 'other', text: 'ت' }), { ok: false, error: 'text_required' });
  assert.deepEqual(parseAdaptiveAnswer('focus_service', { choice: 'other' }), { ok: false, error: 'text_required' });
  assert.deepEqual(parseAdaptiveAnswer('focus_service', { choice: 'nonsense' }), { ok: false, error: 'invalid_choice' });
  const long = parsed('focus_service', { choice: 'other', text: 'ا'.repeat(80) });
  assert.equal(long.text?.length, 40);
  // Every id the screen can offer is accepted, whatever the kind.
  for (const entry of ALL_FOCUS_ENTRIES) assert.equal(parseAdaptiveAnswer('focus_service', { choice: entry.id }).ok, true, entry.id);
  // Text is cleaned like every other free text.
  assert.equal(parsed('focus_service', { choice: 'other', text: '<b>مظلات</b>{x}' }).text, 'bمظلات/bx');
});

test('answers: push_products takes p_0 to p_9, «none», or typed text, and rejects mixing none with others', () => {
  assert.deepEqual(parsed('push_products', { choices: ['p_0', 'p_3'] }), { key: 'push_products', choice: 'p_0', choices: ['p_0', 'p_3'] });
  assert.deepEqual(parsed('push_products', { choices: ['p_1'], text: 'عطر الورد الأحمر' }), { key: 'push_products', choice: 'p_1', choices: ['p_1'], text: 'عطر الورد الأحمر' });
  assert.deepEqual(parsed('push_products', { choice: 'none' }), { key: 'push_products', choice: 'none', choices: ['none'] });
  assert.deepEqual(parsed('push_products', { choice: 'text', text: 'دهن عود كمبودي' }), { key: 'push_products', choice: 'text', text: 'دهن عود كمبودي' });
  assert.deepEqual(parsed('push_products', { text: 'دهن عود كمبودي' }), { key: 'push_products', choice: 'text', text: 'دهن عود كمبودي' });
  assert.deepEqual(parseAdaptiveAnswer('push_products', { choices: ['none', 'p_0'] }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('push_products', { choices: ['none'], text: 'عطر' }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('push_products', { choices: ['p_10'] }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('push_products', { choices: ['p_x'] }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('push_products', {}), { ok: false, error: 'text_required' });
  assert.deepEqual(parseAdaptiveAnswer('push_products', { choice: 'text', text: 'ع' }), { ok: false, error: 'text_required' });
  assert.equal(parsed('push_products', { choice: 'text', text: 'ع'.repeat(300) }).text?.length, 120);
  // Repeats collapse.
  assert.deepEqual(parsed('push_products', { choices: ['p_2', 'p_2'] }).choices, ['p_2']);
});

test('answers: exclude_products and peak_hours', () => {
  assert.deepEqual(parsed('exclude_products', { choice: 'out_of_stock' }), { key: 'exclude_products', choice: 'out_of_stock' });
  assert.deepEqual(parsed('exclude_products', { choice: 'text', text: 'عطر الصيف' }), { key: 'exclude_products', choice: 'text', text: 'عطر الصيف' });
  assert.deepEqual(parseAdaptiveAnswer('exclude_products', { choice: 'text' }), { ok: false, error: 'text_required' });
  assert.deepEqual(parseAdaptiveAnswer('exclude_products', { choice: 'all' }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parsed('peak_hours', { choices: ['lunch', 'dinner'] }), { key: 'peak_hours', choice: 'lunch', choices: ['lunch', 'dinner'] });
  assert.deepEqual(parsed('peak_hours', { choice: 'late' }), { key: 'peak_hours', choice: 'late', choices: ['late'] });
  assert.deepEqual(parseAdaptiveAnswer('peak_hours', { choices: ['lunch', 'brunch'] }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAdaptiveAnswer('peak_hours', { choices: [] }), { ok: false, error: 'invalid_choice' });
});

test('answers: the per-kind goal and pain ids are accepted by the shared parser, and the legacy lists did not move', () => {
  assert.deepEqual(GOAL_OPTIONS.map((option) => option.id), ['online_sales', 'calls', 'store_visits', 'site_visits', 'awareness']);
  assert.deepEqual(PAIN_OPTIONS.map((option) => option.id), ['few_leads', 'expensive', 'confusing', 'grow', 'unsure']);
  for (const [kind, options] of Object.entries(KIND_GOAL_OPTIONS)) {
    for (const option of options) {
      const parsedGoal = parseAnswer('goal', { choice: option.id });
      assert.equal(parsedGoal.ok, true, `${kind}.${option.id}`);
      const effects = answerEffects((parsedGoal as { ok: true; answer: Parameters<typeof answerEffects>[0] }).answer);
      assert.ok(['conversions', 'leads', 'traffic', 'awareness'].includes(String(effects.business.primary_goal)), `${option.id} writes a known primary_goal`);
      assert.equal(effects.fact?.data.setup_key, 'goal');
      assert.equal(effects.fact?.data.choice, option.id);
      assert.equal(answerLabel({ key: 'goal', choice: option.id }), option.label);
    }
  }
  for (const [kind, options] of Object.entries(KIND_PAIN_OPTIONS)) {
    for (const option of options) {
      const parsedPain = parseAnswer('pain', { choice: option.id });
      assert.equal(parsedPain.ok, true, `${kind}.${option.id}`);
      const effects = answerEffects((parsedPain as { ok: true; answer: Parameters<typeof answerEffects>[0] }).answer);
      assert.equal(effects.fact?.data.setup_key, 'pain');
      assert.deepEqual(effects.business, {});
      assert.ok(effects.fact?.fact_ar.length);
      assert.equal(answerLabel({ key: 'pain', choice: option.id }), option.label);
    }
  }
  assert.deepEqual(parseAnswer('goal', { choice: 'world_domination' }), { ok: false, error: 'invalid_choice' });
  assert.deepEqual(parseAnswer('pain', { choice: 'tired' }), { ok: false, error: 'invalid_choice' });
  assert.equal(KIND_PAIN_OPTIONS.clinic.at(-1)?.id, 'unsure');
  assert.equal(reactionTo({ key: 'pain', choice: 'unsure' }), null);
});

test('answers: a «yes» on the opener writes sector and primary_goal, a «no» writes neither', () => {
  const clinic = adaptiveEffects(parsed('confirm', { choice: 'yes', kind: 'clinic', outcome: 'calls' }));
  assert.deepEqual(clinic.business, { sector: TYPE_OPTIONS.find((option) => option.id === 'clinic')?.label, primary_goal: 'leads' });
  assert.equal(clinic.fact?.data.setup_key, 'confirm');
  assert.equal(clinic.fact?.data.choice, 'yes');
  assert.equal(clinic.fact?.data.kind, 'clinic');

  const store = adaptiveEffects(parsed('confirm', { choice: 'yes', kind: 'ecommerce', outcome: 'purchases' }));
  assert.deepEqual(store.business, { sector: 'متجر إلكتروني', primary_goal: 'conversions' });
  assert.deepEqual(adaptiveEffects(parsed('confirm', { choice: 'yes', kind: 'services', outcome: 'forms' })).business, { sector: 'شركة خدمات', primary_goal: 'leads' });
  assert.deepEqual(adaptiveEffects(parsed('confirm', { choice: 'yes', kind: 'local', outcome: 'visits' })).business, { sector: 'محل أو فرع', primary_goal: 'leads' });
  // A kind we do not name, or no outcome, writes only what is known.
  assert.deepEqual(adaptiveEffects(parsed('confirm', { choice: 'yes', kind: 'general' })).business, {});
  assert.deepEqual(adaptiveEffects(parsed('confirm', { choice: 'yes', kind: 'clinic' })).business, { sector: 'عيادة أو مركز طبي' });

  const no = adaptiveEffects(parsed('confirm', { choice: 'no' }));
  assert.deepEqual(no.business, {});
  assert.equal(no.fact?.data.setup_key, 'confirm');
  // Through the shared entry point the answer is saved like any other.
  const shared = answerEffects(parsed('confirm', { choice: 'yes', kind: 'ecommerce', outcome: 'purchases' }));
  assert.deepEqual(shared.business, { sector: 'متجر إلكتروني', primary_goal: 'conversions' });
});

test('answers: every other key writes one fact with its setup key and choice and no business column', () => {
  const samples: AdaptiveAnswer[] = [
    { key: 'has_account', choice: 'none' },
    { key: 'focus_service', choice: 'dental_braces' },
    { key: 'focus_service', choice: 'other', text: 'تقويم شفاف' },
    { key: 'aov_check', choice: 'less' },
    { key: 'margin', choice: '20_40' },
    { key: 'push_products', choice: 'p_0', choices: ['p_0', 'p_1'] },
    { key: 'exclude_products', choice: 'low_margin' },
    { key: 'call_hours', choice: 'split_9_13_16_22' },
    { key: 'whatsapp_booking', choice: 'link' },
    { key: 'deal_value', choice: '2k_10k' },
    { key: 'close_rate', choice: '2_3' },
    { key: 'peak_hours', choice: 'lunch', choices: ['lunch', 'dinner'] },
    { key: 'delivery_apps', choice: 'yes' },
    { key: 'tracking_now', choice: 'dont_know' },
  ];
  for (const answer of samples) {
    const effects = adaptiveEffects(answer);
    assert.deepEqual(effects.business, {}, answer.key);
    assert.ok(effects.fact, answer.key);
    assert.equal(effects.fact.data.setup_key, answer.key);
    assert.equal(effects.fact.data.choice, answer.choice);
    assert.ok(effects.fact.fact_ar.length > 5, answer.key);
    assert.ok(['goal', 'margin', 'constraint', 'geo', 'agency', 'other', 'product', 'schedule', 'capacity'].includes(effects.fact.kind));
    if (answer.choices) assert.deepEqual(effects.fact.data.choices, answer.choices);
    if (answer.text) assert.equal(effects.fact.data.text, answer.text);
  }
  assert.deepEqual(adaptiveEffects({ key: 'margin', choice: '20_40' }).fact?.data, {
    setup_key: 'margin',
    choice: '20_40',
    label: 'من 20 إلى 40 ريال',
    min_per_100: 20,
    max_per_100: 40,
  });
  assert.equal(adaptiveEffects({ key: 'margin', choice: '20_40' }).fact?.fact_ar, 'يتبقى له من كل 100 ريال من 20 إلى 40 ريال بعد تكلفة المنتج والشحن');
  assert.deepEqual(adaptiveEffects({ key: 'call_hours', choice: 'day_8_23' }).fact?.data.windows, [[8, 23]]);
  assert.equal(adaptiveEffects({ key: 'deal_value', choice: 'gt50k' }).fact?.fact_ar, 'الصفقة الواحدة تسوى له تقريباً أكثر من 50,000 ريال');
});

test('answers: picked products keep their titles so a reload shows the same words', () => {
  const signals = sallaAccount();
  const chips = pushProductChoices(signals);
  assert.ok(chips.length >= 2);
  const answer = withProductTitles({ key: 'push_products', choice: 'p_0', choices: ['p_0', 'p_1'] }, signals);
  assert.deepEqual(answer.titles, [chips[0].title, chips[1].title]);
  const fact = adaptiveEffects(answer).fact;
  assert.equal(fact?.data.label, `${chips[0].title}، ${chips[1].title}`);
  assert.equal(fact?.fact_ar, `منتجات يبي تبيع أكثر: ${chips[0].title}، ${chips[1].title}`);
  // Without a read the ids stay ids and nothing is invented.
  assert.equal(withProductTitles({ key: 'push_products', choice: 'p_0', choices: ['p_0'] }, null).titles, undefined);
  assert.equal(adaptiveLabel({ key: 'push_products', choice: 'p_0', choices: ['p_0'] }), 'منتجات من القائمة');
  // Other keys pass through untouched.
  const margin: AdaptiveAnswer = { key: 'margin', choice: 'lt20' };
  assert.equal(withProductTitles(margin, signals), margin);
});

test('answers: the customer bubble says what they tapped', () => {
  assert.equal(adaptiveLabel({ key: 'margin', choice: 'lt20' }), 'أقل من 20 ريال');
  assert.equal(adaptiveLabel({ key: 'focus_service', choice: 'other', text: 'تقويم شفاف' }), 'تقويم شفاف');
  assert.equal(adaptiveLabel({ key: 'focus_service', choice: 'all' }), 'كلها بنفس القدر');
  assert.equal(adaptiveLabel({ key: 'push_products', choice: 'none', choices: ['none'] }), 'لا، كلها سوا');
  assert.equal(adaptiveLabel({ key: 'push_products', choice: 'p_0', choices: ['p_0'], text: 'عطر الورد' }), 'عطر الورد');
  assert.equal(adaptiveLabel({ key: 'peak_hours', choice: 'lunch', choices: ['lunch', 'dinner'] }), 'الغدا، العشا');
  assert.equal(adaptiveLabel({ key: 'confirm', choice: 'yes' }), 'إي صح');
  assert.equal(answerLabel({ key: 'call_hours', choice: 'always' }), 'أي وقت والجوال معي');
});

test('answers: the margin reaction does the break-even sum from the account average, and without it stays plain', () => {
  assert.equal(
    adaptiveReaction({ key: 'margin', choice: 'lt20' }, { aov: 186, currency: 'SAR' }),
    'يعني الطلب لازم يكلفك إعلان أقل من 37 ريال تقريباً عشان تطلع رابح. بحسبها كذا.'
  );
  assert.equal(breakEvenLine(186, '20_40', 'SAR'), 'يعني الطلب اللي يكلفك إعلان أقل من 37 ريال تقريباً رابح، واللي فوق 74 خسران. بحسبها كذا.');
  assert.equal(breakEvenLine(186, 'gt40', 'SAR'), 'يعني أي طلب يكلفك إعلان أقل من 74 ريال تقريباً أنت فيه رابح. بحسبها كذا.');
  assert.equal(breakEvenLine(186, 'unknown', 'SAR'), null);
  assert.equal(breakEvenLine(null, 'lt20', 'SAR'), null);
  assert.equal(breakEvenLine(0, 'lt20', 'SAR'), null);
  // No average given: a plain line, with no number in it.
  for (const choice of ['lt20', '20_40', 'gt40', 'unknown']) {
    const line = adaptiveReaction({ key: 'margin', choice });
    assert.ok(line);
    assert.doesNotMatch(line, /\d/);
  }
  // Through the shared entry point, the context travels along.
  assert.equal(
    reactionTo({ key: 'margin', choice: 'lt20' }, { aov: 186, currency: 'SAR' }),
    'يعني الطلب لازم يكلفك إعلان أقل من 37 ريال تقريباً عشان تطلع رابح. بحسبها كذا.'
  );
});

test('answers: the close-rate reaction needs the deal range, and most answers get no reaction', () => {
  assert.equal(contactValueLine('2k_10k', '2_3', 'SAR'), 'يعني الاتصال الواحد يسوى لك من 400 إلى 3,000 ريال تقريباً.');
  assert.equal(contactValueLine('2k_10k', 'le1', 'SAR'), 'يعني الاتصال الواحد يسوى لك أقل من 1,000 ريال تقريباً.');
  assert.equal(contactValueLine('2k_10k', 'ge4', 'SAR'), 'يعني الاتصال الواحد يسوى لك أكثر من 800 ريال تقريباً.');
  assert.equal(contactValueLine('gt50k', '2_3', 'SAR'), 'يعني الاتصال الواحد يسوى لك أكثر من 10,000 ريال تقريباً.');
  assert.equal(contactValueLine('unknown', '2_3', 'SAR'), null);
  assert.equal(contactValueLine(null, '2_3', 'SAR'), null);
  assert.equal(contactValueLine('2k_10k', 'unknown', 'SAR'), null);
  assert.equal(adaptiveReaction({ key: 'close_rate', choice: '2_3' }, { dealValue: '2k_10k' }), 'يعني الاتصال الواحد يسوى لك من 400 إلى 3,000 ريال تقريباً.');
  assert.equal(adaptiveReaction({ key: 'close_rate', choice: '2_3' }), null);
  assert.equal(adaptiveReaction({ key: 'whatsapp_booking', choice: 'yes' }), null);
  assert.equal(adaptiveReaction({ key: 'focus_service', choice: 'all' }), null);
  assert.equal(adaptiveReaction({ key: 'confirm', choice: 'yes' }), null);
  assert.ok(adaptiveReaction({ key: 'confirm', choice: 'no' }));
  assert.equal(adaptiveReaction({ key: 'call_hours', choice: 'always' }), null);
  assert.ok(adaptiveReaction({ key: 'call_hours', choice: 'day_8_23' }));
  assert.ok(adaptiveReaction({ key: 'tracking_now', choice: 'dont_know' }));
  assert.equal(adaptiveReaction({ key: 'aov_check', choice: 'same' }), null);
  assert.ok(adaptiveReaction({ key: 'aov_check', choice: 'less' }));
});

// ---------------------------------------------------------------------------
// opener
// ---------------------------------------------------------------------------

test('opener: the dental clinic', () => {
  const signals = clinicAccount();
  const opener = buildOpener(classify(signals), signals, { firstName: 'سلطان' });
  assert.ok(opener);
  assert.equal(opener.greeting, 'هلا سلطان، ربطت حسابك وقريته.');
  assert.equal(opener.seen[0], 'حملتين بحث شغّالة على الزراعة والتقويم، وتطلع في جدة بس');
  assert.equal(opener.seen[1], 'آخر 30 يوم: 64 اتصال من الإعلان و9 نماذج من الموقع');
  assert.ok(opener.seen.length >= 2 && opener.seen.length <= 4);
  assert.equal(opener.headline, 'يعني عيادة أسنان في جدة، وشغلك على الاتصالات.');
  assert.equal(opener.ask, 'صح كذا؟');
  assert.deepEqual(opener.proposal, { kind: 'clinic', outcome: 'calls' });
});

test('opener: the Salla store', () => {
  const signals = sallaAccount();
  const opener = buildOpener(classify(signals), signals, { firstName: null });
  assert.ok(opener);
  assert.equal(opener.greeting, 'هلا، ربطت حسابك وقريته.');
  assert.deepEqual(opener.seen, ['حملة أداء أقصى وحملة بحث شغّالة', 'المتجر على سلة، وربط Merchant Center شغّال', 'التتبع يحسب الطلبات وقيمتها']);
  assert.equal(opener.headline, 'آخر 30 يوم صرفت 3,200 ريال وجاك منها 41 طلب.');
  assert.equal(opener.ask, 'صح إن اللي يهمك الطلبات من المتجر؟');
  assert.deepEqual(opener.proposal, { kind: 'ecommerce', outcome: 'purchases' });
});

test('opener: says nothing when there is nothing read or nothing to say', () => {
  assert.equal(buildOpener(classify(null), null, { firstName: 'نورة' }), null);
  assert.equal(buildOpener(classify(account()), account(), { firstName: null }), null, 'campaigns failed to read');
  const fresh = account({ campaigns: { ok: true, value: [] } });
  assert.equal(buildOpener(classify(fresh), fresh, { firstName: null }), null, 'new account');
  const dormant = account({ campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث', status: 'PAUSED' })] } });
  assert.equal(buildOpener(classify(dormant), dormant, { firstName: null }), null, 'dormant account');
  assert.equal(buildOpener(classify(null, {}, { linked: 0, noAccount: true }), null, { firstName: null }), null, 'no account');
});

test('opener: every failed signal leaves its row out and never claims what it did not read', () => {
  const signals = clinicAccount({
    targetedPlaces: failed,
    conversionsByGroup: failed,
    assets: failed,
    landingHosts: failed,
    merchantCenterLinked: failed,
  });
  const scenario = classify(signals);
  const opener = buildOpener(scenario, signals, { firstName: null });
  assert.ok(opener);
  assert.equal(opener.seen.some((row) => row.includes('جدة')), false);
  assert.equal(opener.seen.some((row) => row.includes('اتصال من الإعلان')), false);
  assert.equal(opener.headline.includes('جدة'), false);
  assert.equal(opener.headline.includes('الاتصالات'), false, 'no conversion read, so no outcome is claimed');
  assert.ok(opener.seen.length >= 2, 'a spend row fills in so the box is never a single line');
  assert.ok(opener.seen.some((row) => row.includes('صرفت')));
});

test('opener: a guess asks for more instead of asking «صح؟», and the proposal is withheld', () => {
  const callsOnly = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'حملة 1', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 20 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['call', 20]),
  });
  const scenario = classify(callsOnly);
  assert.equal(scenario.kindConfidence, 'guess');
  const opener = buildOpener(scenario, callsOnly, { firstName: null });
  assert.ok(opener);
  assert.equal(opener.proposal, null);
  assert.notEqual(opener.ask, 'صح كذا؟');
  assert.match(opener.headline, /^آخر 30 يوم صرفت 500 ريال وجاك منها 20 نتيجة/);
});

test('opener: no tracking and a tracking that records nothing are said as they are', () => {
  const noTracking = sallaAccount({
    enabledConversionActions: { ok: true, value: 0 },
    conversionsByGroup: groups(),
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 3200, impressions30: 60000, clicks30: 2000 })] },
  });
  const a = buildOpener(classify(noTracking), noTracking, { firstName: null });
  assert.ok(a?.seen.includes('ما فيه تتبع مفعّل في الحساب'));
  const suspect = sallaAccount({
    enabledConversionActions: { ok: true, value: 2 },
    conversionsByGroup: groups(),
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 3200, impressions30: 60000, clicks30: 2000 })] },
  });
  const b = buildOpener(classify(suspect), suspect, { firstName: null });
  assert.ok(b?.seen.includes('فيه تتبع مفعّل، بس ما سجّل ولا نتيجة من 2,000 نقرة'));
});

test('opener: the first name is cleaned', () => {
  const signals = clinicAccount();
  const opener = buildOpener(classify(signals), signals, { firstName: '  <b>سلطان</b>  ' });
  assert.equal(opener?.greeting, 'هلا bسلطان/b، ربطت حسابك وقريته.');
});

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

test('decision: the clinic stops the ad outside the hours somebody answers', () => {
  const signals = clinicAccount();
  const decision = scenarioDecision({ scenario: classify(signals), signals, answered: { call_hours: 'split_9_13_16_22' }, currency: 'SAR' });
  assert.ok(decision);
  assert.equal(decision.id, 'call_hours');
  // The largest closed stretch of the answer's own windows: 10 at night to 9 in the morning.
  assert.equal(decision.title, 'وقّف الإعلان من 10 الليل لين 9 الصبح');
  assert.equal(decision.reason, 'آخر 30 يوم صرفت 420 ريال في ساعات ما أحد يرد فيها، وجاك فيها 9 اتصالات.');
  assert.equal(decision.why, 'لأنك قلت إن الرد فترتين، والاتصال اللي ما ينرد عليه حجز ضايع.');
  assert.equal(decision.amount, 420);
  assert.equal(decision.currency, 'SAR');
  assert.ok(decision.steps.length >= 3);
  assert.ok(decision.steps.some((step) => step.includes('من 9 الصبح لين 1 الظهر ومن 4 العصر لين 10 الليل')));
});

test('decision: call_hours thresholds are the larger of 100 and 10% of the 30-day cost, or 5 calls outside', () => {
  const decide = (hours: HourSignal[], choice = 'split_9_13_16_22') => {
    const signals = clinicAccount({ hours: { ok: true, value: hours } });
    return scenarioDecision({ scenario: classify(signals), signals, answered: { call_hours: choice }, currency: 'SAR' });
  };
  // Outside cost 14 * 30 = 420 of 1,620 total: over both bars.
  assert.ok(decide(clinicHours({ cost: 30, callsBefore9: 1 })));
  // 14 * 6 = 84 outside (under 100) and 9 hours with no calls: nothing to say.
  assert.equal(decide(clinicHours({ cost: 6, callsBefore9: 0 })), null);
  // Just under the 100 floor (14 * 7 = 98) with 4 calls outside (under 5).
  const justUnder = clinicHours({ cost: 7, callsBefore9: 0 });
  justUnder[0].phoneCalls = 4;
  assert.equal(decide(justUnder), null);
  // Exactly 5 calls outside carries it even when the cost is small.
  const fiveCalls = clinicHours({ cost: 1, callsBefore9: 0 });
  fiveCalls[0].phoneCalls = 3;
  fiveCalls[1].phoneCalls = 2;
  const byCalls = decide(fiveCalls);
  assert.ok(byCalls);
  assert.equal(byCalls.reason, 'آخر 30 يوم جاك 5 اتصالات في ساعات ما أحد يرد فيها.');
  // 10% of a large total beats the 100 floor: 14 * 10 = 140 outside of (1,200 + 140) is 10.4%, but of a bigger total it is not.
  const big = clinicHours({ cost: 10, callsBefore9: 0 }).map((row) => (row.cost === 120 ? { ...row, cost: 400 } : row));
  assert.equal(decide(big), null, '140 outside of 4,140 is 3%, under the floor of 414');
  const edge = clinicHours({ cost: 10, callsBefore9: 0 });
  assert.ok(decide(edge), '140 outside of 1,340 is over 134');
  // Someone who answers all day has no closed stretch.
  assert.equal(decide(clinicHours({ cost: 30, callsBefore9: 1 }), 'always'), null);
  // An answer that is not a call-hours choice carries no windows.
  assert.equal(decide(clinicHours({ cost: 30, callsBefore9: 1 }), 'whenever'), null);
});

test('decision: call_hours needs the hours read and the answer; a failed read falls back', () => {
  const answered = { call_hours: 'split_9_13_16_22' };
  const blind = clinicAccount({ hours: failed });
  assert.equal(scenarioDecision({ scenario: classify(blind), signals: blind, answered, currency: 'SAR' }), null);
  const signals = clinicAccount();
  assert.equal(scenarioDecision({ scenario: classify(signals), signals, answered: {}, currency: 'SAR' }), null);
  assert.equal(scenarioDecision({ scenario: classify(signals), signals: null, answered, currency: 'SAR' }), null);
});

test('decision: the evening-only answer closes the morning, and the stretch is found round midnight', () => {
  const signals = clinicAccount();
  const decision = scenarioDecision({ scenario: classify(signals), signals, answered: { call_hours: 'evening_16_24' }, currency: 'SAR' });
  assert.ok(decision);
  assert.equal(decision.title, 'وقّف الإعلان من 12 الليل لين 4 العصر');
  assert.equal(decision.why, 'لأنك قلت إن الرد المسا بس، والاتصال اللي ما ينرد عليه حجز ضايع.');

  const open = (from: number, to: number) => Array.from({ length: 24 }, (_, hour) => hour >= from && hour < to);
  assert.deepEqual(largestClosedStretch(open(8, 23)), { start: 23, end: 8, length: 9 });
  assert.deepEqual(largestClosedStretch(open(0, 24)), null);
  assert.deepEqual(largestClosedStretch(open(0, 0)), null);
  assert.deepEqual(largestClosedStretch(open(16, 24)), { start: 0, end: 16, length: 16 });
});

test('decision: the store stops the products that spend and do not sell', () => {
  const signals = sallaAccount();
  const decision = scenarioDecision({ scenario: classify(signals), signals, answered: { margin: 'lt20' }, currency: 'SAR' });
  assert.ok(decision);
  assert.equal(decision.id, 'idle_products');
  assert.equal(decision.title, 'أوقف 4 منتجات تصرف وما تبيع');
  assert.equal(decision.reason, '4 منتجات صرفت عليها 300 ريال آخر 30 يوم وما جابت ولا طلب. الأكثر صرفاً: بخور فاخر، مجموعة هدايا وعطر صيفي.');
  assert.match(decision.why, /^لأنك قلت إن اللي يتبقى لك من كل 100 ريال أقل من 20 ريال/);
  assert.equal(decision.amount, 300);
  assert.ok(decision.steps.length >= 3);
  assert.ok(decision.steps.some((step) => step.includes('بخور فاخر')));
});

test('decision: idle_products thresholds are 50 per product and 200 together', () => {
  const decide = (products: ProductSignal[], answered: Partial<Record<string, string | null>> = {}) => {
    const signals = sallaAccount({ products: { ok: true, value: products } });
    return scenarioDecision({ scenario: classify(signals), signals, answered, currency: 'SAR' });
  };
  const idle = (id: string, cost30: number): ProductSignal => ({ id, title: `منتج ${id}`, cost30, conversions30: 0, value30: 0 });
  // 200 exactly counts, 199 does not.
  assert.ok(decide([idle('a', 50), idle('b', 50), idle('c', 50), idle('d', 50)]));
  assert.equal(decide([idle('a', 50), idle('b', 50), idle('c', 50), idle('d', 49)]), null, 'a product under 50 is not counted, leaving 150');
  assert.equal(decide([idle('a', 60), idle('b', 60), idle('c', 60)]), null, '180 together is under 200');
  // Products that sold are never idle.
  assert.equal(decide([{ ...idle('a', 500), conversions30: 1 }, idle('b', 60)]), null);
  // Singular, dual and plural wording.
  assert.equal(decide([idle('a', 250)])?.title, 'أوقف منتج يصرف وما يبيع');
  assert.equal(decide([idle('a', 150), idle('b', 100)])?.title, 'أوقف منتجين يصرفون وما يبيعون');
  assert.match(decide([idle('a', 250)])?.reason ?? '', /^منتج واحد صرفت عليه 250 ريال/);
  assert.equal(decide(Array.from({ length: 12 }, (_, index) => idle(String(index), 60)))?.title, 'أوقف 12 منتج تصرف وما تبيع');
  // The why follows what was said, else stays honest.
  assert.match(decide([idle('a', 250)], { pain: 'shop_profit_eaten' })?.why ?? '', /الإعلان ياكل الربح/);
  assert.equal(decide([idle('a', 250)])?.why, 'لأن هذا صرف ما رجع منه طلب في آخر 30 يوم.');
  // A failed read of the products falls back.
  const blind = sallaAccount({ products: failed });
  assert.equal(scenarioDecision({ scenario: classify(blind), signals: blind, answered: {}, currency: 'SAR' }), null);
  assert.equal(scenarioDecision({ scenario: classify(sallaAccount()), signals: null, answered: {}, currency: 'SAR' }), null);
});

test('decision: no tracking and a tracking that records nothing put the tracking first, with steps by kind and platform', () => {
  const track = (overrides: Partial<AccountSignals>, answered: Partial<Record<string, string | null>> = {}) => {
    const signals = sallaAccount({
      enabledConversionActions: { ok: true, value: 0 },
      conversionsByGroup: groups(),
      campaigns: { ok: true, value: [campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 3200, impressions30: 60000, clicks30: 2000 })] },
      ...overrides,
    });
    return scenarioDecision({ scenario: classify(signals), signals, answered, currency: 'SAR' });
  };
  const store = track({}, { tracking_now: 'dont_know' });
  assert.ok(store);
  assert.equal(store.id, 'tracking_setup');
  assert.equal(store.amount, null, 'no waste number without tracking');
  assert.match(store.reason, /3,200 ريال/);
  assert.match(store.why, /ما تعرف الحين/);
  assert.ok(store.steps.some((step) => step.includes('من لوحة سلة')));
  assert.ok(store.steps.some((step) => step.includes('قيمة الطلب')));
  assert.ok(track({ landingHosts: { ok: true, value: ['shop.zid.store'] } })?.steps.some((step) => step.includes('من لوحة زد')));
  assert.ok(track({ landingHosts: { ok: true, value: ['shop.myshopify.com'] } })?.steps.some((step) => step.includes('من لوحة شوبيفاي')));
  assert.ok(track({ landingHosts: { ok: true, value: ['shop.example.com'] }, merchantCenterLinked: { ok: true, value: true } })?.steps.some((step) => step.includes('كود تتبع الشراء')));
  assert.ok(track({ autoTagging: { ok: true, value: false } })?.steps.some((step) => step.includes('Auto-tagging')));
  assert.equal(track({ autoTagging: { ok: true, value: true } })?.steps.some((step) => step.includes('Auto-tagging')), false);
  assert.equal(track({ autoTagging: failed })?.steps.some((step) => step.includes('Auto-tagging')), false, 'a failed read is not a finding');

  // Tracking that records nothing: check it first.
  const suspectSignals = clinicAccount({
    enabledConversionActions: { ok: true, value: 2 },
    conversionsByGroup: groups(),
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث - تقويم الأسنان', cost30: 800, impressions30: 9000, clicks30: 240 })] },
  });
  const suspect = scenarioDecision({ scenario: classify(suspectSignals), signals: suspectSignals, answered: {}, currency: 'SAR' });
  assert.ok(suspect);
  assert.equal(suspect.id, 'tracking_setup');
  assert.equal(suspect.title, 'راجع التتبع، ما سجّل ولا نتيجة');
  assert.match(suspect.reason, /240 نقرة/);
  assert.ok(suspect.steps.some((step) => step.includes('ضغطة زر الواتساب')));
});

test('decision: new, dormant and no_account have no decision (their ending is the first-campaign plan)', () => {
  const fresh = account({ campaigns: { ok: true, value: [] } });
  assert.equal(scenarioDecision({ scenario: classify(fresh), signals: fresh, answered: {}, currency: 'SAR' }), null);
  assert.equal(scenarioDecision({ scenario: classify(null, {}, { linked: 0, noAccount: true }), signals: null, answered: {}, currency: 'SAR' }), null);
  // A kind we do not word has no kind decision either.
  const general = classify(null);
  assert.equal(scenarioDecision({ scenario: general, signals: null, answered: {}, currency: 'SAR' }), null);
});

test('planReason: ties the audit decision to what the customer said, or says nothing', () => {
  const scenario = classify(sallaAccount());
  const reason = (category: string | null, answered: Partial<Record<string, string | null>>, labels: Partial<Record<string, string>> = {}) =>
    planReason({ scenario, answered, labels, decision: { title: 'قرار', category }, });
  assert.equal(
    reason('bidding', { pain: 'shop_profit_eaten' }),
    'لأنك قلت «الإعلان ياكل الربح»، وهالقرار يمس كم تدفع على كل نقرة.'
  );
  assert.equal(
    reason('keywords', { pain: 'clinic_price_shoppers' }),
    'لأنك قلت «يتصلون يسألون عن السعر وما يحجزون»، وهالقرار يمس الكلمات اللي تطلع فيها إعلاناتك.'
  );
  // A decision the answer has nothing to do with says nothing rather than force a link.
  assert.equal(reason('ads', { pain: 'shop_profit_eaten' }), null);
  assert.equal(reason('structure', { pain: 'shop_abandoned_carts' }), null);
  assert.equal(reason('keywords', { pain: 'unsure' }), null);
  assert.equal(reason('keywords', {}), null);
  assert.equal(reason(null, { pain: 'shop_few_orders' }), null);
  assert.equal(reason('mystery', { pain: 'shop_few_orders' }), null);
  // The service they want to grow connects to the budget, the structure and the keywords.
  assert.equal(
    reason('budget', { focus_service: 'dental_braces' }, { focus_service: 'تقويم' }),
    'لأنك تبي طلب أكثر على «تقويم»، وهالقرار يمس كم يروح من فلوسك وعلى أي حملة.'
  );
  assert.equal(reason('ads', { focus_service: 'dental_braces' }), null);
  assert.equal(reason('budget', { focus_service: 'all' }), null);
  assert.equal(reason('keywords', { focus_service: 'dental_braces' }), 'لأنك تبي طلب أكثر على «تقويم»، وهالقرار يمس الكلمات اللي تطلع فيها إعلاناتك.');
});

// ---------------------------------------------------------------------------
// understanding
// ---------------------------------------------------------------------------

test('understanding: the clinic card says each thing in the customer words, with where it came from', () => {
  const signals = clinicAccount();
  const rows = understandingRows({
    scenario: classify(signals),
    signals,
    answered: { confirm: 'yes', focus_service: 'dental_implants', value: '100_500', pain: 'clinic_price_shoppers', call_hours: 'split_9_13_16_22', whatsapp_booking: 'yes' },
    labels: {},
    business: { name: 'عيادة', monthlyBudget: 4000, targetRegions: [] },
  });
  assert.deepEqual(rows, [
    { label: 'النشاط', value: 'عيادة أسنان في جدة', source: 'confirmed' },
    { label: 'وين تعلن', value: 'جدة', source: 'account' },
    { label: 'اللي تبيه من الإعلان', value: 'اتصالات', source: 'confirmed' },
    { label: 'الخدمة اللي تبي تكثر حجوزاتها', value: 'زراعة', source: 'you' },
    { label: 'اللي يدفعه المريض في أول زيارة', value: 'من 100 إلى 500 ريال', source: 'you' },
    { label: 'ساعات الرد على الاتصالات', value: 'فترتين: 9 الصبح لين 1، و4 العصر لين 10 الليل', source: 'you' },
    { label: 'الحجز بالواتساب', value: 'موجود', source: 'you' },
    { label: 'اللي مضايقك', value: 'يتصلون يسألون عن السعر وما يحجزون', source: 'you' },
    { label: 'الميزانية', value: '4,000 ريال بالشهر', source: 'you' },
  ]);
});

test('understanding: the store card uses the confirmed average order, the margin and the products', () => {
  const signals = sallaAccount();
  const rows = understandingRows({
    scenario: classify(signals),
    signals,
    answered: { confirm: 'yes', aov_check: 'same', margin: 'lt20', push_products: 'p_0', exclude_products: 'none', pain: 'shop_profit_eaten' },
    labels: { push_products: 'عطر العود الملكي' },
    business: { name: null, monthlyBudget: 3000, targetRegions: ['السعودية'] },
  });
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.deepEqual(byLabel['النشاط'], { label: 'النشاط', value: 'متجر إلكتروني على سلة', source: 'confirmed' });
  assert.deepEqual(byLabel['متوسط الطلب'], { label: 'متوسط الطلب', value: 'قرابة 186 ريال', source: 'confirmed' });
  assert.deepEqual(byLabel['اللي يتبقى من كل 100 ريال'], { label: 'اللي يتبقى من كل 100 ريال', value: 'أقل من 20 ريال', source: 'you' });
  assert.equal(byLabel['منتجات تبيها تبيع أكثر'].value, 'عطر العود الملكي');
  assert.equal(byLabel['منتجات ما تبيها تطلع'].value, 'لا، كلها تطلع');
  assert.equal(byLabel['الميزانية'].value, '3,000 ريال بالشهر');

  // An «less» on the average order is the customer's own word.
  const less = understandingRows({ scenario: classify(signals), signals, answered: { aov_check: 'less' }, labels: {}, business: null });
  assert.deepEqual(less.find((row) => row.label === 'متوسط الطلب'), { label: 'متوسط الطلب', value: 'أقل من 186 ريال', source: 'you' });
});

test('understanding: only what is backed gets a row, and «ما أدري» is left out', () => {
  assert.deepEqual(understandingRows({ scenario: classify(null), signals: null, answered: {}, labels: {}, business: null }), []);
  const signals = sallaAccount();
  const rows = understandingRows({
    scenario: classify(signals),
    signals,
    answered: { margin: 'unknown', value: 'unknown', pain: 'unsure' },
    labels: {},
    business: { name: null, monthlyBudget: null, targetRegions: [] },
  });
  for (const label of ['اللي يتبقى من كل 100 ريال', 'متوسط الطلب', 'اللي مضايقك', 'الميزانية']) assert.equal(rows.some((row) => row.label === label), false, label);
  // A typed answer shows in the words the screen showed.
  const typed = understandingRows({
    scenario: classify(null, { type: 'clinic' }),
    signals: null,
    answered: { type: 'clinic', focus_service: 'other' },
    labels: { type: 'عيادة أو مركز طبي', focus_service: 'تقويم شفاف' },
    business: null,
  });
  assert.deepEqual(typed, [
    { label: 'النشاط', value: 'عيادة أو مركز طبي', source: 'you' },
    { label: 'الخدمة اللي تبي تكثر حجوزاتها', value: 'تقويم شفاف', source: 'you' },
  ]);
  // A guess is not shown as understood.
  const callsOnly = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'حملة 1', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 20 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['call', 20]),
  });
  assert.deepEqual(understandingRows({ scenario: classify(callsOnly), signals: callsOnly, answered: {}, labels: {}, business: null }), []);
});

test('understanding: services show the deal and the close rate', () => {
  const rows = understandingRows({
    scenario: classify(null, { type: 'services' }),
    signals: null,
    answered: { type: 'services', deal_value: '2k_10k', close_rate: '2_3' },
    labels: { type: 'شركة خدمات' },
    business: null,
  });
  assert.deepEqual(rows.map((row) => [row.label, row.value]), [
    ['النشاط', 'شركة خدمات'],
    ['الصفقة الواحدة', 'من 2,000 إلى 10,000 ريال'],
    ['من كل 10 يتواصلون معك يصيرون عملاء', 'من 2 إلى 3'],
  ]);
});

// ---------------------------------------------------------------------------
// endings
// ---------------------------------------------------------------------------

test('first campaign: a dental clinic gets a search campaign on the service it named, in its city, with its budget', () => {
  const scenario = classify(account({ campaigns: { ok: true, value: [] } }), { type: 'clinic' });
  const plan = firstCampaignPlan({
    scenario,
    answered: { type: 'clinic', focus_service: 'dental_braces' },
    labels: {},
    business: { monthlyBudget: 6000, targetRegions: ['جدة'], website: null },
    currency: 'SAR',
  });
  assert.ok(plan);
  assert.equal(plan.campaign, 'حملة بحث على التقويم في جدة');
  // 6,000 is what the «من 3,000 إلى 10,000 ريال» tile books: the customer hears the range, not a number they never gave.
  assert.equal(plan.budgetLine, 'من 3,000 إلى 10,000 ريال بالشهر');
  assert.equal(plan.next, 'trial');
  assert.ok(plan.items.length >= 3 && plan.items.length <= 5);
  const byLabel = Object.fromEntries(plan.items.map((item) => [item.label, item.detail]));
  assert.equal(byLabel['أول كلمات البحث'], 'تقويم أسنان، عيادة تقويم أسنان');
  assert.equal(byLabel['الميزانية'], 'من 3,000 إلى 10,000 ريال بالشهر، وتحدد الرقم بالضبط قبل لا تشتغل الحملة.');
  // A typed amount is the customer's own number, so the daily figure follows from it.
  const typed = firstCampaignPlan({
    scenario,
    answered: { type: 'clinic', focus_service: 'dental_braces' },
    labels: {},
    business: { monthlyBudget: 4500, targetRegions: ['جدة'], website: null },
    currency: 'SAR',
  });
  assert.equal(typed?.budgetLine, '4,500 ريال بالشهر');
  assert.equal(Object.fromEntries((typed?.items ?? []).map((item) => [item.label, item.detail]))['الميزانية'], '4,500 ريال بالشهر، قرابة 150 ريال باليوم.');
  assert.match(byLabel['التتبع'], /الاتصال/);
});

test('first campaign: a store with Merchant Center gets a product campaign, without it a search campaign', () => {
  const withFeed = account({ campaigns: { ok: true, value: [] }, merchantCenterLinked: { ok: true, value: true } });
  const scenarioFeed = classify(withFeed, { type: 'ecommerce' });
  const feed = firstCampaignPlan({
    scenario: scenarioFeed,
    answered: { type: 'ecommerce', focus_service: 'shop_perfume' },
    labels: {},
    business: { monthlyBudget: 3000, targetRegions: ['السعودية'], website: 'https://shop.example.sa' },
    currency: 'SAR',
  });
  assert.ok(feed);
  assert.equal(feed.campaign, 'حملة أداء أقصى على منتجات المتجر في السعودية');
  assert.equal(feed.items.some((item) => item.label === 'أول كلمات البحث'), false, 'a product feed runs on products, not on typed words');
  assert.match(feed.items[0].detail, /Merchant Center/);

  const noFeed = classify(null, { type: 'ecommerce', has_account: 'none' }, { linked: 0 });
  const search = firstCampaignPlan({
    scenario: noFeed,
    answered: { type: 'ecommerce', focus_service: 'shop_perfume' },
    labels: {},
    business: { monthlyBudget: null, targetRegions: [], website: null },
    currency: 'SAR',
  });
  assert.ok(search);
  assert.equal(search.campaign, 'حملة بحث على العطور');
  assert.equal(search.next, 'open_account', 'no ad account: the next step is opening one');
  assert.equal(search.budgetLine, 'تحددها قبل لا تشتغل الحملة');
  assert.equal(search.items.at(-1)?.detail, 'ما حددت ميزانية للحين، وتحددها قبل لا تشتغل الحملة.');
});

test('first campaign: services, local and general each get a search campaign shaped for them', () => {
  const plan = (type: string, answered: Partial<Record<string, string | null>>, labels: Partial<Record<string, string>> = {}) =>
    firstCampaignPlan({
      scenario: classify(account({ campaigns: { ok: true, value: [campaign({ id: '1', name: 'قديمة', status: 'PAUSED' })] } }), { type }),
      answered: { type, ...answered },
      labels,
      business: { monthlyBudget: 3000, targetRegions: ['الرياض', 'جدة'], website: null },
      currency: 'SAR',
    });
  const services = plan('services', { focus_service: 'svc_cleaning' });
  assert.equal(services?.campaign, 'حملة بحث على التنظيف في الرياض وجدة');
  assert.equal(services?.next, 'trial', 'a dormant account opens the trial');
  assert.ok(services?.items.some((item) => item.label === 'الاتصال من الإعلان'));

  const local = plan('restaurant', { focus_service: 'other' }, { focus_service: 'مندي حاشي' });
  assert.equal(local?.campaign, 'حملة بحث قريب من الفرع على مندي حاشي في الرياض وجدة');
  assert.match(local?.items[0].detail ?? '', /إضافة الموقع/);
  assert.match(local?.items.find((item) => item.label === 'التتبع')?.detail ?? '', /الاتجاهات/);

  const general = plan('other', {});
  assert.equal(general?.campaign, 'حملة بحث في الرياض وجدة');
  assert.ok(general && general.items.length >= 3);

  // «كلها بنفس القدر» starts from the first two services of the catalog, without naming one as the topic.
  const all = plan('services', { focus_service: 'all' });
  assert.equal(all?.campaign, 'حملة بحث في الرياض وجدة');
  assert.equal(all?.items.find((item) => item.label === 'أول كلمات البحث')?.detail, 'شركة مقاولات، شركة ترميم');
});

test('first campaign: an account that already runs ads has no first-campaign plan', () => {
  for (const signals of [clinicAccount(), sallaAccount()]) {
    const plan = firstCampaignPlan({
      scenario: classify(signals),
      answered: {},
      labels: {},
      business: { monthlyBudget: 3000, targetRegions: [], website: null },
      currency: 'SAR',
    });
    assert.equal(plan, null);
  }
});

test('agency: one plain question per audit category present, in the audit order, at most five', () => {
  const decisions = ['bidding', 'keywords', 'bidding', 'ads', 'structure', 'budget', 'targeting', 'extensions'].map((category, index) => ({ title: `قرار ${index}`, category }));
  const questions = agencyQuestions(decisions);
  assert.equal(questions.length, 5);
  assert.equal(new Set(questions).size, 5);
  assert.deepEqual(agencyQuestions([{ title: 'a', category: 'targeting' }, { title: 'b', category: 'Bidding' }]).length, 2);
  assert.deepEqual(agencyQuestions([]), []);
  assert.deepEqual(agencyQuestions([{ title: 'a', category: null }, { title: 'b', category: 'unknown' }]), []);
  assert.equal(agencyQuestions([{ title: 'a', category: 'extensions' }]).length, 1);
  assert.equal(AGENCY_FULL_MANAGEMENT_CARD, true);
});

// ---------------------------------------------------------------------------
// Number format and copy rules
// ---------------------------------------------------------------------------

test('the engine formats money exactly like the rest of the setup flow', () => {
  for (const amount of [0, 7, 999.6, 1000, 3200, 186, 12480, 1_250_000]) {
    assert.equal(money(amount, 'SAR'), `${formatAmount(amount)} ريال`);
  }
  assert.equal(money(3200, 'sar'), '3,200 ريال');
  assert.equal(money(3200, 'USD'), '3,200 USD');
});

test('copy: no long dash, no Latin comma in Arabic, no banned phrase, and never «زياد», in any catalog', () => {
  assertCopyRules(ADAPTIVE_CATALOG, 'ADAPTIVE_CATALOG');
  assertCopyRules(KIND_GOAL_OPTIONS, 'KIND_GOAL_OPTIONS');
  assertCopyRules(KIND_PAIN_OPTIONS, 'KIND_PAIN_OPTIONS');
  assertCopyRules(ALL_FOCUS_ENTRIES, 'focus entries');
  assertCopyRules(TYPE_OPTIONS, 'TYPE_OPTIONS');
  for (const options of Object.values(KIND_GOAL_OPTIONS)) {
    for (const option of options) {
      assertCopyRules([answerEffects({ key: 'goal', choice: option.id }), reactionTo({ key: 'goal', choice: option.id })], `goal ${option.id}`);
    }
  }
  for (const options of Object.values(KIND_PAIN_OPTIONS)) {
    for (const option of options) {
      assertCopyRules([answerEffects({ key: 'pain', choice: option.id }), reactionTo({ key: 'pain', choice: option.id })], `pain ${option.id}`);
    }
  }
});

test('copy: no long dash, no Latin comma, no banned phrase in anything the functions return for the snapshot accounts', () => {
  const noTracking = sallaAccount({
    enabledConversionActions: { ok: true, value: 0 },
    conversionsByGroup: groups(),
    autoTagging: { ok: true, value: false },
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 3200, impressions30: 60000, clicks30: 2000 })] },
  });
  const suspect = clinicAccount({
    enabledConversionActions: { ok: true, value: 2 },
    conversionsByGroup: groups(),
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'بحث - تقويم الأسنان', cost30: 800, impressions30: 9000, clicks30: 240 })] },
  });
  const fixtures: Array<{ name: string; signals: AccountSignals | null; answered: Record<string, string | null>; extra?: { linked?: number; noAccount?: boolean } }> = [
    {
      name: 'clinic',
      signals: clinicAccount(),
      answered: { confirm: 'yes', focus_service: 'dental_implants', value: '100_500', pain: 'clinic_price_shoppers', call_hours: 'split_9_13_16_22', whatsapp_booking: 'link' },
    },
    {
      name: 'store',
      signals: sallaAccount(),
      answered: { confirm: 'yes', aov_check: 'less', margin: '20_40', push_products: 'p_0', exclude_products: 'low_margin', pain: 'shop_profit_eaten' },
    },
    { name: 'no tracking', signals: noTracking, answered: { tracking_now: 'tells_me' } },
    { name: 'tracking suspect', signals: suspect, answered: { tracking_now: 'check_records' } },
    { name: 'unread', signals: null, answered: {} },
    { name: 'no account', signals: null, answered: { type: 'ecommerce', has_account: 'none' }, extra: { linked: 0, noAccount: true } },
  ];
  const callHours = ['split_9_13_16_22', 'day_8_23', 'evening_16_24'];
  const returned: unknown[] = [];

  for (const fixture of fixtures) {
    const scenario = classify(fixture.signals, fixture.answered, fixture.extra);
    const ctx = { scenario, signals: fixture.signals, answered: fixture.answered, edit: false };
    returned.push(buildOpener(scenario, fixture.signals, { firstName: 'نورة' }));
    for (const key of [...ADAPTIVE_KEYS, 'type', 'goal', 'value', 'pain', 'budget', 'regions', 'manager', 'website', 'name', 'consent'] as SetupKey[]) {
      returned.push(adaptiveQuestion(key, ctx));
    }
    returned.push(scenarioDecision({ scenario, signals: fixture.signals, answered: fixture.answered, currency: 'SAR' }));
    returned.push(
      understandingRows({ scenario, signals: fixture.signals, answered: fixture.answered, labels: {}, business: { name: 'نشاط', monthlyBudget: 4000, targetRegions: ['جدة'] } })
    );
    returned.push(firstCampaignPlan({ scenario, answered: fixture.answered, labels: {}, business: { monthlyBudget: 4000, targetRegions: ['جدة'], website: null }, currency: 'SAR' }));
    for (const category of ['bidding', 'keywords', 'ads', 'structure', 'budget', 'targeting', 'extensions']) {
      returned.push(planReason({ scenario, answered: fixture.answered, labels: {}, decision: { title: 'قرار', category } }));
    }
  }
  // Every call-hours window through the clinic decision.
  for (const choice of callHours) {
    const signals = clinicAccount();
    returned.push(scenarioDecision({ scenario: classify(signals), signals, answered: { call_hours: choice }, currency: 'SAR' }));
  }
  returned.push(agencyQuestions(['bidding', 'keywords', 'ads', 'structure', 'budget'].map((category) => ({ title: 'قرار', category }))));
  returned.push(agencyQuestions([{ title: 'قرار', category: 'targeting' }, { title: 'قرار', category: 'extensions' }]));

  // Every answer's bubble, fact and reaction.
  for (const key of ADAPTIVE_KEYS) {
    for (const option of ADAPTIVE_CATALOG[key]) {
      const answer: AdaptiveAnswer = { key, choice: option.id };
      returned.push(adaptiveLabel(answer), adaptiveEffects(answer), adaptiveReaction(answer, { aov: 186, currency: 'SAR', dealValue: '2k_10k' }));
    }
  }
  for (const choice of ['lt20', '20_40', 'gt40', 'unknown']) returned.push(breakEvenLine(186, choice, 'SAR'));
  for (const deal of ['lt2k', '2k_10k', '10k_50k', 'gt50k']) for (const close of ['le1', '2_3', 'ge4']) returned.push(contactValueLine(deal, close, 'SAR'));

  const texts = allStrings(returned);
  assert.ok(texts.length > 400, `walked ${texts.length} strings`);
  assertCopyRules(returned, 'engine output');
});

test('copy: the engine source files carry no long dash either, so a branch the tests miss cannot add one', () => {
  const files = ['scenario', 'bank', 'opener', 'understanding', 'decisions', 'endings', 'answers', 'shared', 'focus'];
  for (const file of files) {
    const source = readFileSync(resolve(`lib/setup/adaptive/${file}.ts`), 'utf8');
    assert.doesNotMatch(source, /[–—]/, `${file}.ts`);
  }
});

test('classify: pool, door and aluminium contractors read as services (trades seen on real accounts)', () => {
  for (const name of ['مسابح فايبر جلاس - الرياض', 'تركيب أبواب WPC', 'واجهات ألمنيوم']) {
    const signals = account({
      campaigns: { ok: true, value: [campaign({ id: '1', name, cost30: 900, impressions30: 4000, clicks30: 300, conversions30: 12 })] },
      enabledConversionActions: { ok: true, value: 2 },
    });
    const scenario = classify(signals);
    assert.equal(scenario.kind, 'services', name);
    assert.equal(scenario.kindConfidence, 'confident', name);
  }
});

test('classify: a linked Business Profile is not a shop (real reads of 14 Oct 2026)', () => {
  // A dental clinic with its location asset linked: was a guess because the location scored «local».
  const clinic = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'زيارة - تقويم أسنان', status: 'PAUSED', cost30: 36.94, impressions30: 900, clicks30: 24, conversions30: 11 })] },
    enabledConversionActions: { ok: true, value: 11 },
    conversionsByGroup: groups(['contact', 11]),
    assets: { ok: true, value: { call: true, locations: 1 } },
  });
  const c = classify(clinic);
  assert.equal(c.kind, 'clinic');
  assert.equal(c.kindConfidence, 'confident');
  assert.ok(!c.evidence.includes('loc'));

  // A pool contractor with a «فرع» campaign and its location linked: was read as a shop.
  const pools = account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'مسابح فايبر جلاس', cost30: 3000, impressions30: 40000, clicks30: 12000, conversions30: 2000 }),
        campaign({ id: '2', name: 'فرع الرياض - بحث', cost30: 1407, impressions30: 20000, clicks30: 4337, conversions30: 991 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 35 },
    conversionsByGroup: groups(['contact', 2599], ['directions', 391]),
    assets: { ok: true, value: { call: true, locations: 1 } },
  });
  const p = classify(pools);
  assert.equal(p.kind, 'services');
  assert.equal(p.kindConfidence, 'confident');

  // A Local campaign still counts for a shop.
  const shop = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'مطعم الحي', kind: 'LOCAL', cost30: 500, impressions30: 5000, clicks30: 80, conversions30: 10 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['directions', 10]),
    assets: { ok: true, value: { call: false, locations: 1 } },
  });
  assert.equal(classify(shop).kind, 'local');
});
