import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { computeBreakEven } from '../lib/economics/break-even';
import { buildSnapshotEconomics } from '../lib/ai/optimizer-snapshot';
import { emptyEconomicsTally, tallyEconomics } from '../lib/ai/optimizer-audit-trail';
import { economicsKindFromLedger, emptyLedger } from '../lib/setup/ledger';
import { missingCoreKeys, missingEconomicsKeys, type SetupKey } from '../lib/setup/questions';
import { askableEconomicsKeys, homeMissingKeys, loadEconomicsNudgeInput } from '../lib/setup/adaptive/economics-nudge';
import { signalsJobName } from '../lib/setup/adaptive/signals-store';
import type { AccountSignals, CampaignSignal } from '../lib/setup/adaptive/types';

const CORE: SetupKey[] = ['type', 'goal', 'value', 'budget'];

// ---------------------------------------------------------------------------
// MAJOR 5: the «كمّل تعريفي» card asks for the economics the optimizer needs
// ---------------------------------------------------------------------------

test('a store without a margin is asked for it; a clinic, services or local business for profit and close rate', () => {
  assert.deepEqual(missingEconomicsKeys([], 'ecommerce'), ['margin']);
  for (const kind of ['clinic', 'services', 'local'] as const) {
    assert.deepEqual(missingEconomicsKeys([], kind), ['profit_per_deal', 'close_rate'], kind);
  }
  // No kind, or a kind the break-even has no question for, asks nothing new.
  assert.deepEqual(missingEconomicsKeys([], null), []);
  assert.deepEqual(missingEconomicsKeys([], undefined), []);
  assert.deepEqual(missingEconomicsKeys([], 'general'), []);
});

test('those who answered are not asked again, and «ما أدري» counts as an answer', () => {
  assert.deepEqual(missingEconomicsKeys(['margin'], 'ecommerce'), []);
  assert.deepEqual(missingEconomicsKeys(['profit_per_deal'], 'clinic'), ['close_rate']);
  assert.deepEqual(missingEconomicsKeys(['close_rate'], 'clinic'), ['profit_per_deal']);
  assert.deepEqual(missingEconomicsKeys(['profit_per_deal', 'close_rate'], 'clinic'), []);
  // The older pair (deal value x margin) already gives a profit per deal; only the close rate is still missing.
  assert.deepEqual(missingEconomicsKeys(['deal_value', 'margin'], 'services'), ['close_rate']);
  assert.deepEqual(missingEconomicsKeys(['deal_value'], 'services'), ['profit_per_deal', 'close_rate']);
  // The ledger keeps a key whose choice is null («ما أدري»): the key is what is checked.
  const ledger = emptyLedger();
  ledger.choices.set('margin', null);
  assert.deepEqual(missingEconomicsKeys(ledger.choices.keys(), 'ecommerce'), []);
});

test('missingCoreKeys appends the economics keys by kind and is unchanged without a kind', () => {
  const answeredCore = new Set<SetupKey>(CORE);
  assert.deepEqual(missingCoreKeys(answeredCore), []);
  assert.deepEqual(missingCoreKeys(answeredCore, null), []);
  assert.deepEqual(missingCoreKeys(answeredCore, 'ecommerce'), ['margin']);
  assert.deepEqual(missingCoreKeys(answeredCore, 'clinic'), ['profit_per_deal', 'close_rate']);
  // Core gaps come first.
  assert.deepEqual(missingCoreKeys(['type', 'goal'], 'ecommerce'), ['value', 'budget', 'margin']);
  assert.deepEqual(missingCoreKeys([...CORE, 'margin'], 'ecommerce'), []);
  assert.deepEqual(missingCoreKeys([...CORE, 'profit_per_deal', 'close_rate'], 'services'), []);
});

test('the kind comes from the ledger the same way the optimizer derives it', () => {
  const entries = () => emptyLedger();

  const store = entries();
  store.choices.set('type', 'ecommerce');
  assert.equal(economicsKindFromLedger(store, null), 'ecommerce');

  const clinic = entries();
  clinic.choices.set('type', 'clinic');
  assert.equal(economicsKindFromLedger(clinic, null), 'clinic');

  // The kind the customer confirmed on the opener wins.
  const confirmed = entries();
  confirmed.choices.set('type', 'ecommerce');
  confirmed.confirmed = { kind: 'clinic', outcome: null };
  assert.equal(economicsKindFromLedger(confirmed, null), 'clinic');

  // With no type on record, the business sector label decides, then the goal.
  assert.equal(economicsKindFromLedger(entries(), { sector: 'متجر إلكتروني' }), 'ecommerce');
  assert.equal(economicsKindFromLedger(entries(), { sector: null, primary_goal: 'leads' }), 'services');
  assert.equal(economicsKindFromLedger(entries(), null), 'general');

  // A store's ledger produces exactly the margin nudge, and answering it ends the nudge.
  assert.deepEqual(missingCoreKeys(new Set<SetupKey>(CORE), economicsKindFromLedger(store, null)), ['margin']);
  store.choices.set('margin', '20_40');
  assert.deepEqual(missingCoreKeys(new Set<SetupKey>([...CORE, ...store.choices.keys()]), economicsKindFromLedger(store, null)), []);
});

test('the home screen asks for economics only where the adaptive onboarding can collect them', () => {
  const page = readFileSync(new URL('../app/(dashboard)/home/page.tsx', import.meta.url), 'utf8');
  // Adaptive on: the economics keys the edit questionnaire would ask this account's scenario, nothing else.
  assert.match(page, /adaptiveOn\s*\?\s*homeMissingKeys\(\{/);
  assert.match(page, /kind: economicsKindFromLedger\(ledgerEntries, business\)/);
  assert.match(page, /await loadEconomicsNudgeInput\(\{ admin, supabase, account: selectedAccount, weekSpend: week\.spend \}\)/);
  // Adaptive off: the ten fixed questions never ask a margin, so no economics key at all.
  assert.match(page, /: missingCoreKeys\(answered\)/);
});

test('the chip says how long the questions take honestly: edit mode replays the whole questionnaire', () => {
  const page = readFileSync(new URL('../app/(dashboard)/home/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes("'كمّل تعريف نشاطك، كم دقيقة'"));
  assert.ok(!page.includes("'كمّل تعريف نشاطك، دقيقة'"));
});

// ---------------------------------------------------------------------------
// The chip counts only what the questionnaire asks this account (so it can clear)
// ---------------------------------------------------------------------------

const failedRead = { ok: false as const, error: 'not_read' };
const READ_AT = '2026-10-14T08:00:00.000Z';
const NOW = new Date('2026-10-14T09:00:00.000Z');

function account(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return {
    version: 1,
    readAt: READ_AT,
    customerId: '1234567890',
    currency: 'SAR',
    campaigns: failedRead,
    enabledConversionActions: failedRead,
    conversionsByGroup: failedRead,
    autoTagging: failedRead,
    landingHosts: failedRead,
    merchantCenterLinked: failedRead,
    assets: failedRead,
    targetedPlaces: failedRead,
    externalManager: failedRead,
    otherEditors14d: failedRead,
    hours: failedRead,
    products: failedRead,
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

const clinicRead = () =>
  account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'بحث - زراعة الأسنان', cost30: 1100, impressions30: 30000, clicks30: 900, conversions30: 40 }),
        campaign({ id: '2', name: 'بحث - تقويم الأسنان', cost30: 900, impressions30: 20000, clicks30: 600, conversions30: 33 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 3 },
    conversionsByGroup: { ok: true, value: [{ group: 'call', conversions: 64 }] },
    landingHosts: { ok: true, value: ['smile-clinic.example.sa'] },
    targetedPlaces: { ok: true, value: ['Jeddah'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
  });

const storeRead = () =>
  account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 2000, impressions30: 50000, clicks30: 1500, conversions30: 30, value30: 5580 }),
        campaign({ id: '2', name: 'بحث - عطور', cost30: 1200, impressions30: 12000, clicks30: 700, conversions30: 11, value30: 2046 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: { ok: true, value: [{ group: 'purchase', conversions: 41 }] },
    landingHosts: { ok: true, value: ['myperfume.salla.sa'] },
    merchantCenterLinked: { ok: true, value: true },
    targetedPlaces: { ok: true, value: ['Saudi Arabia'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
  });

const newRead = () => account({ campaigns: { ok: true, value: [] }, enabledConversionActions: { ok: true, value: 0 } });
const dormantRead = () =>
  account({
    campaigns: { ok: true, value: [campaign({ id: '9', name: 'بحث قديم', status: 'PAUSED' })] },
    enabledConversionActions: { ok: true, value: 0 },
  });

/** The answers on record as the setup screen reads them: the four core ones, plus whatever else the test adds. */
const recorded = (extra: Record<string, string | null> = {}) => ({ type: null, goal: null, value: null, budget: null, ...extra });
const keysOf = (answered: Record<string, string | null>) => Object.keys(answered) as SetupKey[];

test('an active clinic is asked the profit and the close rate, and answering them clears the chip', () => {
  const base = { signals: clinicRead(), linkedAccounts: 1, kind: 'clinic' as const };
  const open = recorded();
  assert.deepEqual(homeMissingKeys({ ...base, answeredKeys: keysOf(open), answered: open }), ['profit_per_deal', 'close_rate']);

  const half = recorded({ profit_per_deal: '50_200' });
  assert.deepEqual(homeMissingKeys({ ...base, answeredKeys: keysOf(half), answered: half }), ['close_rate']);

  const done = recorded({ profit_per_deal: '50_200', close_rate: '2_3' });
  assert.deepEqual(homeMissingKeys({ ...base, answeredKeys: keysOf(done), answered: done }), []);
});

test('an active store is asked the margin, and answering it clears the chip', () => {
  const base = { signals: storeRead(), linkedAccounts: 1, kind: 'ecommerce' as const };
  const open = recorded();
  assert.deepEqual(homeMissingKeys({ ...base, answeredKeys: keysOf(open), answered: open }), ['margin']);
  const done = recorded({ margin: '20_40' });
  assert.deepEqual(homeMissingKeys({ ...base, answeredKeys: keysOf(done), answered: done }), []);
});

test('a new or dormant account is never asked for economics, even when the optimizer would call it a store', () => {
  for (const signals of [newRead(), dormantRead()]) {
    for (const kind of ['ecommerce', 'clinic', 'services', 'local'] as const) {
      const open = recorded();
      assert.deepEqual(homeMissingKeys({ signals, linkedAccounts: 1, kind, answeredKeys: keysOf(open), answered: open }), [], kind);
    }
  }
});

test('no read at all: a stated type still gets its economics, the unplaced account and an empty one do not', () => {
  // The customer said «clinic» themselves: the tree asks the clinic questions without any read.
  const stated = recorded({ type: 'clinic' });
  assert.deepEqual(
    homeMissingKeys({ signals: null, linkedAccounts: 1, kind: 'clinic', answeredKeys: keysOf(stated), answered: stated }),
    ['profit_per_deal', 'close_rate']
  );

  // Nothing read and no word from the customer: the tree guesses no kind, so it asks no margin.
  const open = recorded();
  assert.deepEqual(homeMissingKeys({ signals: null, linkedAccounts: 1, kind: 'ecommerce', answeredKeys: keysOf(open), answered: open }), []);
  // The platform says the account runs nothing: a new account, again no economics.
  assert.deepEqual(
    homeMissingKeys({ signals: null, activityHint: 'empty', linkedAccounts: 1, kind: 'ecommerce', answeredKeys: keysOf(open), answered: open }),
    []
  );
});

test('a business the optimizer calls a clinic but the tree could not place is not nagged for what it will not ask', () => {
  // The read found an account with spend but nothing that says what it sells: kind general, no economics keys.
  const unplaced = account({
    campaigns: { ok: true, value: [campaign({ id: '1', name: 'Campaign 1', cost30: 500, impressions30: 9000, clicks30: 300, conversions30: 12 })] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: { ok: true, value: [] },
  });
  const open = recorded();
  assert.deepEqual(askableEconomicsKeys({ missing: ['profit_per_deal', 'close_rate'], signals: unplaced, linkedAccounts: 1, answered: open }), []);
  assert.deepEqual(homeMissingKeys({ signals: unplaced, linkedAccounts: 1, kind: 'clinic', answeredKeys: keysOf(open), answered: open }), []);
});

test('the core keys are always counted, scenario or not', () => {
  const none = {};
  assert.deepEqual(homeMissingKeys({ signals: newRead(), linkedAccounts: 1, kind: 'ecommerce', answeredKeys: [], answered: none }), ['type', 'goal', 'value', 'budget']);
});

function storedAdmin(signals: AccountSignals | null) {
  const asked: string[] = [];
  const chain: any = {
    select: () => chain,
    eq: (_column: string, value: string) => {
      asked.push(value);
      return chain;
    },
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: signals ? { details: { signals } } : null, error: null }),
  };
  return { admin: { from: () => chain }, asked };
}

const ACCOUNT = { id: 'acc-1', last_synced_at: null };

test('the loader takes the stored read only inside the 24-hour onboarding window, as the edit screen does', async () => {
  const fresh = storedAdmin(fullRead(clinicRead(), READ_AT));
  const got = await loadEconomicsNudgeInput({ admin: fresh.admin, supabase: null, account: ACCOUNT, weekSpend: 0, now: NOW });
  assert.ok(got.signals);
  assert.equal(got.activityHint, null);
  assert.deepEqual(fresh.asked, [signalsJobName('acc-1')]);

  // Two days old: still a valid read for the plan lock (30 days), but the edit screen would not stand on it.
  const old = storedAdmin(fullRead(clinicRead(), '2026-10-12T08:00:00.000Z'));
  const stale = await loadEconomicsNudgeInput({ admin: old.admin, supabase: null, account: ACCOUNT, weekSpend: 0, now: NOW });
  assert.equal(stale.signals, null);
});

test('without a usable read the loader falls back to the week spend, then to the platform hint, and never throws', async () => {
  const none = storedAdmin(null);
  assert.deepEqual(await loadEconomicsNudgeInput({ admin: none.admin, supabase: null, account: ACCOUNT, weekSpend: 120, now: NOW }), {
    signals: null,
    activityHint: 'spends',
  });
  // No spend this week and the account was never synced: unknown, which changes nothing.
  assert.deepEqual(await loadEconomicsNudgeInput({ admin: none.admin, supabase: null, account: ACCOUNT, weekSpend: 0, now: NOW }), {
    signals: null,
    activityHint: null,
  });
  // A synced account with an empty campaign cache says «nothing runs».
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) };
  const synced = { id: 'acc-1', last_synced_at: '2026-10-13T08:00:00.000Z' };
  assert.deepEqual(await loadEconomicsNudgeInput({ admin: none.admin, supabase, account: synced, weekSpend: 0, now: NOW }), {
    signals: null,
    activityHint: 'empty',
  });
  // No service client and a throwing one are both just «no read».
  const throwing = { from: () => { throw new Error('boom'); } };
  assert.deepEqual(await loadEconomicsNudgeInput({ admin: null, supabase: null, account: ACCOUNT, weekSpend: 0, now: NOW }), { signals: null, activityHint: null });
  assert.deepEqual(await loadEconomicsNudgeInput({ admin: throwing, supabase: null, account: ACCOUNT, weekSpend: 0, now: NOW }), { signals: null, activityHint: null });
});

/** A stored read has every signal as an object with `ok`; the fixtures above leave some failed, which is valid. */
function fullRead(signals: AccountSignals, readAt: string): AccountSignals {
  return { ...signals, readAt };
}

// ---------------------------------------------------------------------------
// MAJOR 5: the optimize job run counts the accounts with unknown economics
// ---------------------------------------------------------------------------

test('the tally counts accounts, the unknown ones, and which answer each lacks', () => {
  const tally = emptyEconomicsTally();
  assert.deepEqual(tally, { accounts: 0, unknown: 0, missing_keys: {} });

  const known = buildSnapshotEconomics(
    computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 } } }),
    null
  );
  const storeNoMargin = computeBreakEven({ facts: { type: { choice: 'ecommerce' } } });
  const clinicNothing = computeBreakEven({ facts: { type: { choice: 'clinic' } } });
  const clinicNoClose = computeBreakEven({
    facts: { type: { choice: 'clinic' }, profit_per_deal: { choice: '50_200', min_sar: 50, max_sar: 200 } },
  });

  tallyEconomics(tally, known);
  tallyEconomics(tally, storeNoMargin);
  tallyEconomics(tally, clinicNothing);
  tallyEconomics(tally, clinicNoClose);

  assert.equal(tally.accounts, 4);
  assert.equal(tally.unknown, 3);
  assert.deepEqual(tally.missing_keys, { margin: 1, profit_per_deal: 1, close_rate: 2 });
});

test('economics that could not be read count as unknown with an «unreadable» key', () => {
  const tally = emptyEconomicsTally();
  tallyEconomics(tally, null);
  tallyEconomics(tally, undefined);
  tallyEconomics(tally, { break_even_roas: null, break_even_cpa: null, missing: [] });
  assert.deepEqual(tally, { accounts: 3, unknown: 3, missing_keys: { unreadable: 3 } });
});

test('a known ROAS or a known CPA is enough to be known', () => {
  const tally = emptyEconomicsTally();
  tallyEconomics(tally, { break_even_roas: 4, break_even_cpa: null, missing: ['close_rate'] });
  tallyEconomics(tally, { break_even_roas: null, break_even_cpa: 120, missing: [] });
  assert.deepEqual(tally, { accounts: 2, unknown: 0, missing_keys: {} });
});

test('the tally holds counts and short codes only, never an account or a number the owner gave', () => {
  const tally = emptyEconomicsTally();
  tallyEconomics(tally, { break_even_roas: null, break_even_cpa: null, missing: ['x'.repeat(200)] });
  assert.deepEqual(Object.keys(tally).sort(), ['accounts', 'missing_keys', 'unknown']);
  assert.ok(Object.keys(tally.missing_keys).every((key) => key.length <= 64));
});

test('the optimize cron tallies the economics of every account and keeps the tally in the job run details', () => {
  const route = readFileSync(new URL('../app/api/cron/optimize/route.ts', import.meta.url), 'utf8');
  assert.match(route, /economics: emptyEconomicsTally\(\)|results\.economics = emptyEconomicsTally\(\)/);
  assert.match(route, /tallyEconomics\(results\.economics, economics\)/);
  assert.match(route, /economics: results\.economics/);
});
