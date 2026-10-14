import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { computeBreakEven } from '../lib/economics/break-even';
import { buildSnapshotEconomics } from '../lib/ai/optimizer-snapshot';
import { emptyEconomicsTally, tallyEconomics } from '../lib/ai/optimizer-audit-trail';
import { economicsKindFromLedger, emptyLedger } from '../lib/setup/ledger';
import { missingCoreKeys, missingEconomicsKeys, type SetupKey } from '../lib/setup/questions';

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
  assert.match(page, /missingCoreKeys\(answered, adaptiveOn \? economicsKindFromLedger\(ledgerEntries, business\) : null\)/);
});

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
