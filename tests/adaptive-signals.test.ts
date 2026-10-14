import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { MODAAFA_MCC_ID, SIGNALS_TIMEOUT_MS, SIGNAL_GAQL, conversionGroupOf, ownManagerIdsFrom, readAccountSignals } from '../lib/setup/adaptive/signals';
import type { ReadSignalsContext } from '../lib/setup/adaptive/signals';
import {
  SIGNALS_RETRY_AFTER_MINUTES,
  SIGNALS_TTL_HOURS,
  SIGNAL_KEYS,
  canReuseStoredSignals,
  countOkSignals,
  loadStoredSignals,
  saveSignals,
  signalsJobName,
} from '../lib/setup/adaptive/signals-store';
import { readAndStoreSignals } from '../lib/setup/adaptive/signals-run';
import type { AccountSignals } from '../lib/setup/adaptive/types';
import { SIGNAL_LABELS, describeScenario, describeSignal } from '../app/(dashboard)/operations/onboarding-signals/describe';

// ---------------------------------------------------------------------------
// Harness: a fake GAQL customer that answers by the resource a query reads
// FROM. All data below is synthetic.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-14T10:00:00Z');

type Answer = any[] | Error | ((gaql: string) => any[] | Promise<any[]>) | 'hang';

function queryKey(gaql: string): string {
  const from = /FROM\s+([a-z_]+)/i.exec(gaql)?.[1] ?? '';
  if (from === 'campaign') {
    if (gaql.includes('segments.hour')) return gaql.includes('phone_calls') ? 'hours' : 'hours_no_calls';
    if (gaql.includes('shopping_setting')) return 'merchant';
    return gaql.includes('metrics.cost_micros') ? 'campaign_metrics' : 'campaign_list';
  }
  if (from === 'customer') return gaql.includes('conversion_action_category') ? 'conv_groups' : 'customer';
  return from;
}

function fakeCustomer(answers: Record<string, Answer> = {}, delayMs = 0) {
  const queries: Array<{ key: string; gaql: string }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    queries,
    get maxInFlight() {
      return maxInFlight;
    },
    keys: () => queries.map((entry) => entry.key),
    async query(gaql: string) {
      const key = queryKey(gaql);
      queries.push({ key, gaql });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
        const answer = answers[key] ?? [];
        if (answer === 'hang') return await new Promise<any[]>(() => undefined);
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? await answer(gaql) : answer;
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function ctx(overrides: Partial<ReadSignalsContext> = {}): ReadSignalsContext {
  return {
    customerId: '1234567890',
    currency: 'SAR',
    connectedEmail: 'Owner@Example.com',
    ownManagerIds: [MODAAFA_MCC_ID],
    now: NOW,
    ...overrides,
  };
}

/** Rows that look like Google's REST answer (camelCase, int64 as strings). */
const campaignRow = (id: number, name: string, status: string, channel: string, metrics?: Record<string, string | number>) => ({
  campaign: { id: String(id), name, status, advertisingChannelType: channel },
  ...(metrics ? { metrics } : {}),
});

function healthy(): Record<string, Answer> {
  return {
    campaign_list: [campaignRow(1, 'بحث أسنان جدة', 'ENABLED', 'SEARCH')],
    campaign_metrics: [
      campaignRow(1, 'بحث أسنان جدة', 'ENABLED', 'SEARCH', {
        costMicros: '1500000000',
        impressions: '9000',
        clicks: '400',
        conversions: 20,
        conversionsValue: 0,
      }),
    ],
    conversion_action: [{ conversionAction: { resourceName: 'customers/1/conversionActions/1', status: 'ENABLED' } }],
    conv_groups: [{ segments: { conversionActionCategory: 'PHONE_CALL_LEAD' }, metrics: { conversions: 20 } }],
    customer: [{ customer: { id: '1234567890', manager: false, autoTaggingEnabled: true } }],
    ad_group_ad: [{ adGroupAd: { ad: { finalUrls: ['https://www.clinic.example.com/dental'] } } }],
    asset_group: [],
    merchant: [{ campaign: { id: '1' } }],
    customer_asset: [{ customerAsset: { fieldType: 'CALL' } }],
    campaign_asset: [],
    customer_asset_set: [],
    campaign_asset_set: [],
    campaign_criterion: [{ campaignCriterion: { location: { geoTargetConstant: 'geoTargetConstants/1000072' } } }],
    geo_target_constant: [{ geoTargetConstant: { resourceName: 'geoTargetConstants/1000072', name: 'Jeddah' } }],
    customer_manager_link: [],
    change_event: [],
    hours: [{ segments: { hour: 10 }, metrics: { costMicros: '60000000', clicks: '20', conversions: 1, phoneCalls: '2' } }],
    shopping_performance_view: [],
  };
}

async function read(answers: Record<string, Answer> = healthy(), overrides: Partial<ReadSignalsContext> = {}) {
  const customer = fakeCustomer(answers);
  const signals = await readAccountSignals(customer, ctx(overrides));
  return { signals, customer };
}

function valueOf<T>(readResult: { ok: boolean; value?: T; error?: string }): T {
  assert.equal(readResult.ok, true, JSON.stringify(readResult));
  return (readResult as { value: T }).value;
}

function silenceWarnings() {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(String).join(' '));
  };
  return {
    calls,
    restore() {
      console.warn = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('a healthy account fills all twelve signals and stamps the read', async () => {
  const { signals } = await read();
  assert.equal(signals.version, 1);
  assert.equal(signals.readAt, NOW.toISOString());
  assert.equal(signals.customerId, '1234567890');
  assert.equal(signals.currency, 'SAR');
  assert.equal(countOkSignals(signals), 12);
  assert.deepEqual([...SIGNAL_KEYS].sort(), Object.keys(signals).filter((key) => !['version', 'readAt', 'customerId', 'currency'].includes(key)).sort());
});

test('customer id and currency are normalised', async () => {
  const { signals } = await read(healthy(), { customerId: '123-456-7890', currency: 'usd' });
  assert.equal(signals.customerId, '1234567890');
  assert.equal(signals.currency, 'USD');
  const bad = await read(healthy(), { currency: 'not a code' });
  assert.equal(bad.signals.currency, 'SAR');
});

test('every query runs in parallel', async () => {
  const customer = fakeCustomer(healthy(), 20);
  const started = Date.now();
  await readAccountSignals(customer, ctx());
  assert.ok(customer.maxInFlight >= 8, `only ${customer.maxInFlight} queries ran at once`);
  // 17 queries of 20 ms each, plus the geo name step; serial would be 340 ms and more.
  assert.ok(Date.now() - started < 300, 'queries did not overlap');
});

test('GAQL constants carry the pieces the contract names', () => {
  assert.match(SIGNAL_GAQL.campaignMetrics, /segments\.date DURING LAST_30_DAYS/);
  assert.match(SIGNAL_GAQL.campaignMetrics, /campaign\.status != 'REMOVED'/);
  assert.doesNotMatch(SIGNAL_GAQL.campaignList, /metrics\./);
  assert.match(SIGNAL_GAQL.enabledConversionActions, /conversion_action\.status = 'ENABLED'/);
  assert.match(SIGNAL_GAQL.products, /FROM shopping_performance_view/);
  assert.match(SIGNAL_GAQL.products, /ORDER BY metrics\.cost_micros DESC\s+LIMIT 50/);
  assert.match(SIGNAL_GAQL.adFinalUrls, /LIMIT 200/);
  assert.match(SIGNAL_GAQL.assetGroupFinalUrls, /LIMIT 50/);
  assert.match(SIGNAL_GAQL.targetedLocations, /campaign_criterion\.negative = FALSE/);
  const change = SIGNAL_GAQL.changeEvents(NOW);
  assert.match(change, /LIMIT 1000/);
  assert.match(change, /change_date_time >= '2026-09-30'/);
  assert.match(change, /change_date_time <= '2026-10-15'/);
});

// ---------------------------------------------------------------------------
// campaigns
// ---------------------------------------------------------------------------

test('campaigns: metrics are merged onto the metrics-free list, so a campaign with no activity still appears', async () => {
  const answers = healthy();
  answers.campaign_list = [
    campaignRow(1, 'بحث', 'ENABLED', 'SEARCH'),
    campaignRow(2, 'PMax', 'PAUSED', 'PERFORMANCE_MAX'),
    campaignRow(3, 'App', 'ENABLED', 'MULTI_CHANNEL'),
    campaignRow(4, 'Smart', 'ENABLED', 'SMART'),
    campaignRow(5, 'Gone', 'REMOVED', 'SEARCH'),
    campaignRow(6, 'Shop', 'ENABLED', 'SHOPPING'),
    campaignRow(7, 'Gen', 'ENABLED', 'DEMAND_GEN'),
    campaignRow(8, 'Odd status', 'SUSPENDED', 'DISPLAY'),
  ];
  answers.campaign_metrics = [
    campaignRow(1, 'بحث', 'ENABLED', 'SEARCH', { costMicros: '1234560000', impressions: '1000', clicks: '50', conversions: 3.5, conversionsValue: 777.777 }),
    // snake_case rows come back from the older path
    { campaign: { id: 2, name: 'PMax', status: 'PAUSED', advertising_channel_type: 'PERFORMANCE_MAX' }, metrics: { cost_micros: '2500000', impressions: 10, clicks: 2, conversions: 0, conversions_value: 0 } },
    campaignRow(5, 'Gone', 'REMOVED', 'SEARCH', { costMicros: '9000000' }),
  ];
  const { signals } = await read(answers);
  const campaigns = valueOf(signals.campaigns);
  assert.deepEqual(
    campaigns.map((c) => c.id),
    ['1', '2', '3', '4', '6', '7', '8'],
    'sorted by cost then id, REMOVED left out'
  );
  const byId = Object.fromEntries(campaigns.map((c) => [c.id, c]));
  assert.deepEqual(byId['1'], {
    id: '1',
    name: 'بحث',
    kind: 'SEARCH',
    status: 'ENABLED',
    cost30: 1234.56,
    impressions30: 1000,
    clicks30: 50,
    conversions30: 3.5,
    value30: 777.78,
  });
  assert.equal(byId['2'].kind, 'PMAX');
  assert.equal(byId['2'].status, 'PAUSED');
  assert.equal(byId['2'].cost30, 2.5);
  assert.equal(byId['3'].kind, 'APP');
  assert.equal(byId['4'].kind, 'OTHER');
  assert.equal(byId['6'].kind, 'SHOPPING');
  assert.equal(byId['7'].kind, 'DEMAND_GEN');
  assert.equal(byId['8'].status, 'OTHER');
  for (const id of ['3', '4', '6', '7', '8']) {
    assert.equal(byId[id].cost30, 0);
    assert.equal(byId[id].impressions30, 0);
  }
});

test('campaigns: an account with no campaigns is ok with an empty list', async () => {
  const answers = healthy();
  answers.campaign_list = [];
  answers.campaign_metrics = [];
  const { signals } = await read(answers);
  assert.deepEqual(valueOf(signals.campaigns), []);
});

test('campaigns: if the metrics query fails the signal fails, it never reads as zero spend', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.campaign_metrics = new Error('boom');
    const { signals } = await read(answers);
    assert.deepEqual(signals.campaigns, { ok: false, error: 'query_failed' });
    assert.equal(signals.enabledConversionActions.ok, true);
  } finally {
    warnings.restore();
  }
});

test('campaigns: if the list query fails the signal fails too', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.campaign_list = new Error('boom');
    const { signals } = await read(answers);
    assert.equal(signals.campaigns.ok, false);
  } finally {
    warnings.restore();
  }
});

// ---------------------------------------------------------------------------
// enabled actions, conversions by group, tagging
// ---------------------------------------------------------------------------

test('enabledConversionActions counts the rows of the enabled-actions query', async () => {
  const answers = healthy();
  answers.conversion_action = [{}, {}, {}];
  assert.equal(valueOf((await read(answers)).signals.enabledConversionActions), 3);
  answers.conversion_action = [];
  assert.equal(valueOf((await read(answers)).signals.enabledConversionActions), 0);
});

test('conversionsByGroup folds Google categories into the tree groups, largest first', async () => {
  const rows = (pairs: Array<[string, number]>) => pairs.map(([category, conversions]) => ({ segments: { conversionActionCategory: category }, metrics: { conversions } }));
  const answers = healthy();
  answers.conv_groups = rows([
    ['PURCHASE', 2],
    ['ADD_TO_CART', 1.5],
    ['BEGIN_CHECKOUT', 0.25],
    ['STORE_SALE', 1],
    ['PHONE_CALL_LEAD', 7],
    ['SUBMIT_LEAD_FORM', 1],
    ['QUALIFIED_LEAD', 2],
    ['CONVERTED_LEAD', 0.5],
    ['IMPORTED_LEAD', 0.5],
    ['BOOK_APPOINTMENT', 1],
    ['REQUEST_QUOTE', 1],
    ['GET_DIRECTIONS', 1],
    ['STORE_VISIT', 1],
    ['CONTACT', 1],
    ['SIGNUP', 1],
    ['SUBSCRIBE_PAID', 1],
    ['PAGE_VIEW', 1],
    ['ENGAGEMENT', 1],
    ['DEFAULT', 5],
    ['DOWNLOAD', 1],
    ['OUTBOUND_CLICK', 0],
  ]);
  const groups = valueOf((await read(answers)).signals.conversionsByGroup);
  assert.deepEqual(groups, [
    { group: 'call', conversions: 7 },
    { group: 'other', conversions: 6 },
    { group: 'purchase', conversions: 4.75 },
    { group: 'lead_form', conversions: 4 },
    { group: 'booking', conversions: 2 },
    { group: 'page_view', conversions: 2 },
    { group: 'signup', conversions: 2 },
    { group: 'contact', conversions: 1 },
    { group: 'directions', conversions: 1 },
    { group: 'store_visit', conversions: 1 },
  ]);
  assert.equal(conversionGroupOf('SOMETHING_NEW'), 'other');
});

test('conversionsByGroup with nothing converting is ok and empty', async () => {
  const answers = healthy();
  answers.conv_groups = [{ segments: { conversionActionCategory: 'PURCHASE' }, metrics: { conversions: 0 } }];
  assert.deepEqual(valueOf((await read(answers)).signals.conversionsByGroup), []);
});

test('autoTagging reads the customer flag and fails when it is missing', async () => {
  const answers = healthy();
  answers.customer = [{ customer: { id: '1', manager: false, autoTaggingEnabled: false } }];
  assert.equal(valueOf((await read(answers)).signals.autoTagging), false);
  // snake_case path
  answers.customer = [{ customer: { id: '1', manager: false, auto_tagging_enabled: true } }];
  assert.equal(valueOf((await read(answers)).signals.autoTagging), true);

  const warnings = silenceWarnings();
  try {
    answers.customer = [];
    assert.deepEqual((await read(answers)).signals.autoTagging, { ok: false, error: 'no_row' });
    answers.customer = [{ customer: { id: '1', manager: false } }];
    assert.deepEqual((await read(answers)).signals.autoTagging, { ok: false, error: 'no_value' });
  } finally {
    warnings.restore();
  }
});

test('a manager account drops every signal, so «no campaigns» never reads as a new account', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.customer = [{ customer: { id: '1', manager: true, autoTaggingEnabled: false } }];
    answers.campaign_list = [];
    answers.campaign_metrics = [];
    const { signals } = await read(answers);
    for (const key of SIGNAL_KEYS) assert.deepEqual(signals[key], { ok: false, error: 'manager_account' }, key);
    assert.equal(countOkSignals(signals), 0);
  } finally {
    warnings.restore();
  }
});

// ---------------------------------------------------------------------------
// landing hosts, merchant center, assets
// ---------------------------------------------------------------------------

test('landingHosts: hostnames lowercased without www, counted, most used first', async () => {
  const answers = healthy();
  answers.ad_group_ad = [
    { adGroupAd: { ad: { finalUrls: ['https://WWW.MyStore.salla.sa/p/1?x=1', 'https://mystore.salla.sa/p/2'] } } },
    { ad_group_ad: { ad: { final_urls: ['https://shop.example.com/'] } } },
  ];
  answers.asset_group = [{ assetGroup: { finalUrls: ['example.org/page', 'not a url {lpurl}', '', 5, 'https://mystore.salla.sa'] } }];
  assert.deepEqual(valueOf((await read(answers)).signals.landingHosts), ['mystore.salla.sa', 'example.org', 'shop.example.com']);
});

test('landingHosts: at most ten hosts', async () => {
  const answers = healthy();
  answers.ad_group_ad = Array.from({ length: 12 }, (_, i) => ({ adGroupAd: { ad: { finalUrls: [`https://site${String(i).padStart(2, '0')}.example.com`] } } }));
  const hosts = valueOf((await read(answers)).signals.landingHosts);
  assert.equal(hosts.length, 10);
  assert.equal(hosts[0], 'site00.example.com');
});

test('landingHosts: one query alone is enough when it found a host, an empty answer next to a failure is not', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.ad_group_ad = new Error('boom');
    answers.asset_group = [{ assetGroup: { finalUrls: ['https://store.example.com'] } }];
    assert.deepEqual(valueOf((await read(answers)).signals.landingHosts), ['store.example.com']);

    answers.ad_group_ad = [{ adGroupAd: { ad: { finalUrls: ['https://clinic.example.com'] } } }];
    answers.asset_group = new Error('boom');
    assert.deepEqual(valueOf((await read(answers)).signals.landingHosts), ['clinic.example.com']);

    answers.ad_group_ad = [];
    answers.asset_group = new Error('boom');
    assert.deepEqual((await read(answers)).signals.landingHosts, { ok: false, error: 'query_failed' });

    answers.ad_group_ad = [];
    answers.asset_group = [];
    assert.deepEqual(valueOf((await read(answers)).signals.landingHosts), []);

    answers.ad_group_ad = new Error('a');
    answers.asset_group = new Error('b');
    assert.equal((await read(answers)).signals.landingHosts.ok, false);
  } finally {
    warnings.restore();
  }
});

test('merchantCenterLinked is true when any campaign has a non-zero merchant id', async () => {
  const answers = healthy();
  answers.merchant = [{ campaign: { id: '1', shoppingSetting: { merchantId: '123456789' } } }];
  assert.equal(valueOf((await read(answers)).signals.merchantCenterLinked), true);
  answers.merchant = [{ campaign: { id: '1', shopping_setting: { merchant_id: 42 } } }];
  assert.equal(valueOf((await read(answers)).signals.merchantCenterLinked), true);
  answers.merchant = [{ campaign: { id: '1', shoppingSetting: { merchantId: '0' } } }, { campaign: { id: '2' } }];
  assert.equal(valueOf((await read(answers)).signals.merchantCenterLinked), false);
  answers.merchant = [];
  assert.equal(valueOf((await read(answers)).signals.merchantCenterLinked), false);
});

test('assets: call from account or campaign level, locations only from linked and enabled LOCATION_SYNC sets', async () => {
  const answers = healthy();
  const set = (id: string, type = 'LOCATION_SYNC') => ({ assetSet: { id, type } });
  answers.customer_asset = [{ customerAsset: { fieldType: 'SITELINK' } }];
  answers.campaign_asset = [{ campaignAsset: { fieldType: 'CALL' } }];
  // One set linked at account level and the same one again on a campaign, plus a second set: two locations, not three.
  answers.customer_asset_set = [set('1')];
  answers.campaign_asset_set = [set('1'), set('2')];
  assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: true, locations: 2 });

  answers.customer_asset = [{ customerAsset: { fieldType: 'CALL' } }];
  answers.campaign_asset = [];
  answers.customer_asset_set = [];
  answers.campaign_asset_set = [];
  assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: true, locations: 0 });

  answers.customer_asset = [{ customerAsset: { fieldType: 'CALLOUT' } }];
  assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: false, locations: 0 });
});

test('assets: an asset field named LOCATION counts for nothing (Google has no such field type), and only LOCATION_SYNC sets count', async () => {
  const answers = healthy();
  answers.customer_asset = [{ customerAsset: { fieldType: 'LOCATION' } }];
  answers.campaign_asset = [{ campaignAsset: { fieldType: 'LOCATION' } }, { campaignAsset: { fieldType: 'LOCATION' } }];
  assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: false, locations: 0 }, 'dead branches are gone');

  // A set of another type that came back anyway is ignored, and a set with no id is not a location.
  answers.customer_asset_set = [
    { assetSet: { id: '7', type: 'BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP' } },
    { assetSet: { id: '8', type: 'PAGE_FEED' } },
    { assetSet: { type: 'LOCATION_SYNC' } },
  ];
  answers.campaign_asset_set = [{ assetSet: { id: '9', type: 'LOCATION_SYNC' } }];
  assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: false, locations: 1 });
});

test('assets: the location queries ask for LINKED, enabled LOCATION_SYNC sets, never for unlinked asset sets', async () => {
  const { customer } = await read(healthy());
  const sets = customer.queries.filter((entry) => entry.key === 'customer_asset_set' || entry.key === 'campaign_asset_set');
  assert.deepEqual(sets.map((entry) => entry.key).sort(), ['campaign_asset_set', 'customer_asset_set']);
  for (const { gaql } of sets) {
    assert.match(gaql, /asset_set\.type = 'LOCATION_SYNC'/);
    assert.match(gaql, /_asset_set\.status = 'ENABLED'/);
    assert.match(gaql, /asset_set\.status = 'ENABLED'/);
  }
  assert.match(SIGNAL_GAQL.campaignLocationSets, /campaign\.status = 'ENABLED'/);
  assert.ok(!customer.keys().includes('asset_set'), 'the bare asset_set query (which lists sets nobody linked) is gone');
});

test('assets: a failed location-set query only costs the sets, a failed asset query fails the signal', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.customer_asset_set = new Error('boom');
    answers.campaign_asset_set = [{ assetSet: { id: '2', type: 'LOCATION_SYNC' } }];
    assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: true, locations: 1 }, 'the other link table still counts');
    answers.campaign_asset_set = new Error('boom');
    assert.deepEqual(valueOf((await read(answers)).signals.assets), { call: true, locations: 0 });
    answers.customer_asset = new Error('boom');
    assert.equal((await read(answers)).signals.assets.ok, false);
    answers.customer_asset = [];
    answers.campaign_asset = new Error('boom');
    assert.equal((await read(answers)).signals.assets.ok, false);
  } finally {
    warnings.restore();
  }
});

// ---------------------------------------------------------------------------
// targeted places
// ---------------------------------------------------------------------------

test('targetedPlaces: names for the places enabled campaigns target, most used first', async () => {
  const answers = healthy();
  const criterion = (resource: string) => ({ campaignCriterion: { location: { geoTargetConstant: resource } } });
  answers.campaign_criterion = [
    criterion('geoTargetConstants/1000073'),
    criterion('geoTargetConstants/1000072'),
    criterion('geoTargetConstants/1000072'),
    criterion("geoTargetConstants/1'; DROP"),
    criterion(''),
  ];
  const names: Answer = (gaql) => {
    assert.match(gaql, /IN \('geoTargetConstants\/1000072', 'geoTargetConstants\/1000073'\)/);
    assert.doesNotMatch(gaql, /DROP/);
    return [
      { geoTargetConstant: { resourceName: 'geoTargetConstants/1000072', name: 'Jeddah' } },
      { geo_target_constant: { resource_name: 'geoTargetConstants/1000073', name: '  Riyadh ' } },
    ];
  };
  answers.geo_target_constant = names;
  assert.deepEqual(valueOf((await read(answers)).signals.targetedPlaces), ['Jeddah', 'Riyadh']);
});

test('targetedPlaces: at most twelve names, and none means no second query', async () => {
  const answers = healthy();
  answers.campaign_criterion = Array.from({ length: 20 }, (_, i) => ({ campaignCriterion: { location: { geoTargetConstant: `geoTargetConstants/${2000 + i}` } } }));
  let inList = 0;
  answers.geo_target_constant = (gaql) => {
    inList = (gaql.match(/geoTargetConstants\/\d+/g) ?? []).length;
    return [];
  };
  assert.deepEqual(valueOf((await read(answers)).signals.targetedPlaces), []);
  assert.equal(inList, 12);

  answers.campaign_criterion = [];
  const { signals, customer } = await read(answers);
  assert.deepEqual(valueOf(signals.targetedPlaces), []);
  assert.equal(customer.keys().filter((key) => key === 'geo_target_constant').length, 0);
});

test('targetedPlaces: if the names cannot be read the signal fails', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.geo_target_constant = new Error('boom');
    assert.equal((await read(answers)).signals.targetedPlaces.ok, false);
  } finally {
    warnings.restore();
  }
});

// ---------------------------------------------------------------------------
// outside manager and other editors
// ---------------------------------------------------------------------------

test('externalManager: an active link to a manager that is not ours', async () => {
  const link = (manager: string, status: string) => ({ customerManagerLink: { managerCustomer: `customers/${manager}`, status } });
  const answers = healthy();
  answers.customer_manager_link = [link('7561141000', 'ACTIVE'), link('5550001111', 'ACTIVE'), link('5550002222', 'INACTIVE'), link('5550003333', 'PENDING')];
  assert.deepEqual(valueOf((await read(answers)).signals.externalManager), { linked: true, managerIds: ['5550001111'] });

  // ours are matched on digits, so a dashed configured id still counts as ours
  answers.customer_manager_link = [link('7561141000', 'ACTIVE'), link('9998887777', 'ACTIVE')];
  const own = await read(answers, { ownManagerIds: ownManagerIdsFrom(['999-888-7777']) });
  assert.deepEqual(valueOf(own.signals.externalManager), { linked: false, managerIds: [] });

  answers.customer_manager_link = [];
  assert.deepEqual(valueOf((await read(answers)).signals.externalManager), { linked: false, managerIds: [] });
});

test('otherEditors14d: distinct people other than the owner, Google automation and API tools', async () => {
  const change = (email: string, clientType: string) => ({ changeEvent: { userEmail: email, clientType } });
  const answers = healthy();
  answers.change_event = [
    change('agency@example.com', 'GOOGLE_ADS_WEB_CLIENT'),
    change('Agency@Example.com', 'GOOGLE_ADS_WEB_CLIENT'),
    change('owner@example.com', 'GOOGLE_ADS_WEB_CLIENT'),
    change('bot@google.com', 'GOOGLE_ADS_RECOMMENDATIONS'),
    change('rule@google.com', 'GOOGLE_ADS_AUTOMATED_RULE'),
    change('tool@example.com', 'GOOGLE_ADS_API'),
    change('', 'GOOGLE_ADS_WEB_CLIENT'),
    change('second@example.com', 'GOOGLE_ADS_EDITOR'),
  ];
  assert.equal(valueOf((await read(answers)).signals.otherEditors14d), 2);

  answers.change_event = [];
  assert.equal(valueOf((await read(answers)).signals.otherEditors14d), 0);

  // without a connected email nobody is the owner
  answers.change_event = [change('owner@example.com', 'GOOGLE_ADS_WEB_CLIENT')];
  assert.equal(valueOf((await read(answers, { connectedEmail: null })).signals.otherEditors14d), 1);
});

test('otherEditors14d asks for the last 14 days with an explicit window and a limit', async () => {
  const { customer } = await read();
  const gaql = customer.queries.find((entry) => entry.key === 'change_event')?.gaql ?? '';
  assert.match(gaql, /change_date_time >= '2026-09-30'/);
  assert.match(gaql, /change_date_time <= '2026-10-15'/);
  assert.match(gaql, /LIMIT 1000/);
});

// ---------------------------------------------------------------------------
// hours and products
// ---------------------------------------------------------------------------

test('hours: always 24 rows, summed per hour across campaigns, bad hours ignored', async () => {
  const answers = healthy();
  answers.hours = [
    { segments: { hour: 9 }, metrics: { costMicros: '10500000', clicks: '5', conversions: 1, phoneCalls: '1' } },
    { segments: { hour: '9' }, metrics: { costMicros: '4500000', clicks: '3', conversions: 0.5, phoneCalls: '2' } },
    { segments: { hour: 23 }, metrics: { costMicros: '1000000', clicks: '1', conversions: 0 } },
    { segments: { hour: 24 }, metrics: { costMicros: '999000000', clicks: '99' } },
    { segments: { hour: -1 }, metrics: { costMicros: '999000000', clicks: '99' } },
    { segments: {}, metrics: { costMicros: '999000000', clicks: '99' } },
  ];
  const hours = valueOf((await read(answers)).signals.hours);
  assert.equal(hours.length, 24);
  assert.deepEqual(hours.map((h) => h.hour), Array.from({ length: 24 }, (_, i) => i));
  assert.deepEqual(hours[9], { hour: 9, cost: 15, clicks: 8, conversions: 1.5, phoneCalls: 3 });
  assert.deepEqual(hours[23], { hour: 23, cost: 1, clicks: 1, conversions: 0, phoneCalls: 0 });
  assert.deepEqual(hours[0], { hour: 0, cost: 0, clicks: 0, conversions: 0, phoneCalls: 0 });
});

test('hours: when Google refuses call metrics by hour, the read falls back without them', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.hours = Object.assign(new Error('PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE'), { codes: ['PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE'] });
    answers.hours_no_calls = [{ segments: { hour: 12 }, metrics: { costMicros: '20000000', clicks: '4', conversions: 1, phoneCalls: '9' } }];
    const { signals, customer } = await read(answers);
    const hours = valueOf(signals.hours);
    assert.deepEqual(hours[12], { hour: 12, cost: 20, clicks: 4, conversions: 1, phoneCalls: 0 });
    assert.deepEqual(customer.keys().filter((key) => key.startsWith('hours')), ['hours', 'hours_no_calls']);

    // both fail: the signal fails, with the code of the second
    answers.hours_no_calls = new Error('boom');
    assert.equal((await read(answers)).signals.hours.ok, false);
  } finally {
    warnings.restore();
  }
});

test('products: merged by item id, highest cost first, titles cleaned, at most fifty', async () => {
  const row = (id: string, title: string, cost: number, conversions: number, value: number) => ({
    segments: { productItemId: id, productTitle: title },
    metrics: { costMicros: String(cost * 1_000_000), conversions, conversionsValue: value },
  });
  const answers = healthy();
  answers.shopping_performance_view = [
    row('a1', 'قميص\u0000   أبيض', 40, 0, 0),
    row('a1', 'قميص أبيض', 10.126, 1, 120.456),
    row('b2', 'حذاء', 70, 2, 400),
    row('', 'no id', 500, 1, 1),
    row('c3', '', 5, 0, 0),
  ];
  const products = valueOf((await read(answers)).signals.products);
  assert.deepEqual(products, [
    { id: 'b2', title: 'حذاء', cost30: 70, conversions30: 2, value30: 400 },
    { id: 'a1', title: 'قميص أبيض', cost30: 50.13, conversions30: 1, value30: 120.46 },
    { id: 'c3', title: 'c3', cost30: 5, conversions30: 0, value30: 0 },
  ]);

  answers.shopping_performance_view = Array.from({ length: 60 }, (_, i) => row(`p${i}`, `منتج ${i}`, 100 - i, 0, 0));
  const many = valueOf((await read(answers)).signals.products);
  assert.equal(many.length, 50);
  assert.equal(many[0].id, 'p0');
});

// ---------------------------------------------------------------------------
// failures, deadline, logging
// ---------------------------------------------------------------------------

test('one failing query leaves the other signals ok, with a short code', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.conversion_action = new Error('boom');
    const { signals } = await read(answers);
    assert.deepEqual(signals.enabledConversionActions, { ok: false, error: 'query_failed' });
    assert.equal(countOkSignals(signals), 11);
    for (const key of SIGNAL_KEYS) if (key !== 'enabledConversionActions') assert.equal(signals[key].ok, true, key);
  } finally {
    warnings.restore();
  }
});

test("a failure keeps Google's own error word and the HTTP status, nothing else", async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.conversion_action = Object.assign(new Error('Customer 1234567890 owner@example.com'), { codes: ['UNRECOGNIZED_FIELD', 'x'], status: 400 });
    answers.merchant = Object.assign(new Error('rate'), { status: 429 });
    answers.customer_asset = Object.assign(new Error('weird'), { codes: ['not a code'], status: 'x' });
    const { signals } = await read(answers);
    assert.deepEqual(signals.enabledConversionActions, { ok: false, error: 'query_failed:UNRECOGNIZED_FIELD' });
    assert.deepEqual(signals.merchantCenterLinked, { ok: false, error: 'query_failed:http_429' });
    assert.deepEqual(signals.assets, { ok: false, error: 'query_failed' });
  } finally {
    warnings.restore();
  }
});

test('logs carry the signal key and the code only, never account data', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.conversion_action = new Error('Customer 1234567890 owner@example.com clinic.example.com');
    answers.campaign_list = new Error('حملة سرية');
    answers.hours = new Error('boom');
    answers.hours_no_calls = new Error('boom2');
    const { signals } = await read(answers);
    assert.ok(warnings.calls.length >= 3);
    for (const line of warnings.calls) {
      assert.match(line, /^\[onboarding-signals\] [A-Za-z0-9 ,:_-]+$/, line);
      assert.doesNotMatch(line, /1234567890|owner@|clinic\.example|حملة/);
    }
    assert.doesNotMatch(JSON.stringify(signals), /1234567890 owner|clinic\.example\.com.*boom|حملة سرية/);
  } finally {
    warnings.restore();
  }
});

test('the deadline turns a hanging query into a timeout and the rest still answer', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.conversion_action = 'hang';
    answers.shopping_performance_view = 'hang';
    const customer = fakeCustomer(answers);
    const started = Date.now();
    const signals = await readAccountSignals(customer, ctx({ timeoutMs: 60 }));
    const took = Date.now() - started;
    assert.ok(took < 1000, `took ${took} ms`);
    assert.deepEqual(signals.enabledConversionActions, { ok: false, error: 'timeout' });
    assert.deepEqual(signals.products, { ok: false, error: 'timeout' });
    assert.equal(countOkSignals(signals), 10);
  } finally {
    warnings.restore();
  }
});

test('a signal that already has an answer survives a later timeout of its sibling query', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.ad_group_ad = 'hang';
    answers.asset_group = [{ assetGroup: { finalUrls: ['https://store.example.com'] } }];
    const signals = await readAccountSignals(fakeCustomer(answers), ctx({ timeoutMs: 60 }));
    assert.deepEqual(valueOf(signals.landingHosts), ['store.example.com']);
  } finally {
    warnings.restore();
  }
});

test('a first step that outlives the deadline times out and the second step is never asked', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.campaign_criterion = async () => {
      await new Promise((done) => setTimeout(done, 80));
      return [{ campaignCriterion: { location: { geoTargetConstant: 'geoTargetConstants/1000072' } } }];
    };
    const customer = fakeCustomer(answers);
    const signals = await readAccountSignals(customer, ctx({ timeoutMs: 40 }));
    assert.deepEqual(signals.targetedPlaces, { ok: false, error: 'timeout' });
    await new Promise((done) => setTimeout(done, 120));
    assert.equal(customer.keys().includes('geo_target_constant'), false);
  } finally {
    warnings.restore();
  }
});

test('the default deadline is the documented one', () => {
  assert.equal(SIGNALS_TIMEOUT_MS, 6000);
});

test('readAccountSignals never throws, whatever the client does', async () => {
  const warnings = silenceWarnings();
  try {
    const throwsSync = { query: () => { throw new Error('sync boom'); } } as any;
    const a = await readAccountSignals(throwsSync, ctx());
    assert.equal(countOkSignals(a), 0);
    for (const key of SIGNAL_KEYS) assert.deepEqual(a[key], { ok: false, error: 'query_failed' }, key);

    const notAClient = await readAccountSignals({} as any, ctx());
    assert.equal(countOkSignals(notAClient), 0);

    const wrongShape = await readAccountSignals({ query: async () => 'not rows' } as any, ctx());
    assert.equal(wrongShape.version, 1);

    const bad = await readAccountSignals(fakeCustomer(healthy()), ctx({ ownManagerIds: undefined as any, customerId: undefined as any, currency: undefined as any }));
    assert.equal(bad.version, 1);
  } finally {
    warnings.restore();
  }
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function fakeAdmin(options: { failInsert?: boolean; throwOn?: 'from' } = {}) {
  const rows: Row[] = [];
  let seq = 0;
  return {
    rows,
    from(table: string) {
      assert.equal(table, 'job_runs');
      if (options.throwOn === 'from') throw new Error('admin down');
      return {
        async insert(row: Row) {
          if (options.failInsert) return { error: { message: 'nope' } };
          seq += 1;
          rows.push({ id: seq, started_at: new Date(1_000_000 + seq * 1000).toISOString(), ...row });
          return { error: null };
        },
        select() {
          const filters: Array<(row: Row) => boolean> = [];
          const query: any = {
            eq(column: string, value: unknown) {
              filters.push((row) => row[column] === value);
              return query;
            },
            in(column: string, values: unknown[]) {
              filters.push((row) => values.includes(row[column]));
              return query;
            },
            order() {
              return query;
            },
            limit() {
              return query;
            },
            async maybeSingle() {
              const matches = rows.filter((row) => filters.every((test) => test(row)));
              const newest = matches.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
              return { data: newest ? { details: newest.details } : null, error: null };
            },
          };
          return query;
        },
      };
    },
  };
}

async function readNow(overrides: Partial<ReadSignalsContext> = {}, answers: Record<string, Answer> = healthy()) {
  return readAccountSignals(fakeCustomer(answers), ctx(overrides));
}

test('store: a clean read is saved as success and loads back identical', async () => {
  const admin = fakeAdmin();
  const signals = await readNow();
  assert.equal(await saveSignals(admin, 'acc-1', signals), true);
  assert.equal(admin.rows.length, 1);
  const row = admin.rows[0];
  assert.equal(row.job_name, 'onboarding_signals:acc-1');
  assert.equal(row.job_name, signalsJobName('acc-1'));
  assert.equal(row.status, 'success');
  assert.equal(row.processed, 12);
  assert.equal(row.error_count, 0);
  assert.equal(row.error_message, null);
  assert.ok(Number.isFinite(Date.parse(row.finished_at)));
  assert.deepEqual(Object.keys(row.details), ['signals']);

  assert.deepEqual(await loadStoredSignals(admin, 'acc-1', NOW), signals);
});

test('store: a read with a failed signal is saved as partial with the counts', async () => {
  const warnings = silenceWarnings();
  try {
    const admin = fakeAdmin();
    const answers = healthy();
    answers.shopping_performance_view = new Error('boom');
    answers.merchant = Object.assign(new Error('x'), { codes: ['UNRECOGNIZED_FIELD'] });
    const signals = await readNow({}, answers);
    assert.equal(await saveSignals(admin, 'acc-1', signals), true);
    const row = admin.rows[0];
    assert.equal(row.status, 'partial');
    assert.equal(row.processed, 10);
    assert.equal(row.error_count, 2);
    assert.match(row.error_message, /merchantCenterLinked:query_failed:UNRECOGNIZED_FIELD/);
    assert.match(row.error_message, /products:query_failed/);
    // a partial read is still loaded
    assert.deepEqual(await loadStoredSignals(admin, 'acc-1', NOW), signals);
  } finally {
    warnings.restore();
  }
});

test('store: the newest read wins and other accounts never leak in', async () => {
  const admin = fakeAdmin();
  const older = await readNow({ now: new Date('2026-10-14T08:00:00Z') });
  const newer = await readNow({ now: new Date('2026-10-14T09:00:00Z') });
  const other = await readNow({ now: new Date('2026-10-14T09:30:00Z') });
  await saveSignals(admin, 'acc-1', older);
  await saveSignals(admin, 'acc-1', newer);
  await saveSignals(admin, 'acc-2', other);
  assert.equal((await loadStoredSignals(admin, 'acc-1', NOW))?.readAt, newer.readAt);
  assert.equal((await loadStoredSignals(admin, 'acc-2', NOW))?.readAt, other.readAt);
  assert.equal(await loadStoredSignals(admin, 'acc-3', NOW), null);
});

test('store: a read is used for 24 hours and not after', async () => {
  assert.equal(SIGNALS_TTL_HOURS, 24);
  const admin = fakeAdmin();
  const signals = await readNow({ now: new Date('2026-10-14T00:00:00Z') });
  await saveSignals(admin, 'acc-1', signals);
  assert.ok(await loadStoredSignals(admin, 'acc-1', new Date('2026-10-14T23:59:00Z')));
  assert.equal(await loadStoredSignals(admin, 'acc-1', new Date('2026-10-15T00:01:00Z')), null);
});

test('store: only version 1 with every signal in place is accepted', async () => {
  const warnings = silenceWarnings();
  try {
    const good = await readNow();
    const variants: Array<[string, (value: any) => any]> = [
      ['version 2', (value) => ({ ...value, version: 2 })],
      ['no version', (value) => ({ ...value, version: undefined })],
      ['bad time', (value) => ({ ...value, readAt: 'yesterday' })],
      ['no time', (value) => ({ ...value, readAt: undefined })],
      ['missing signal', (value) => ({ ...value, hours: undefined })],
      ['signal without ok', (value) => ({ ...value, hours: { value: [] } })],
      ['not an object', () => 'text'],
    ];
    for (const [label, change] of variants) {
      const admin = fakeAdmin();
      admin.rows.push({ id: 1, job_name: signalsJobName('acc-1'), status: 'success', started_at: '2026-10-14T09:00:00Z', details: { signals: change(good) } });
      assert.equal(await loadStoredSignals(admin, 'acc-1', NOW), null, label);
    }
    const noDetails = fakeAdmin();
    noDetails.rows.push({ id: 1, job_name: signalsJobName('acc-1'), status: 'success', started_at: '2026-10-14T09:00:00Z', details: {} });
    assert.equal(await loadStoredSignals(noDetails, 'acc-1', NOW), null);
  } finally {
    warnings.restore();
  }
});

test('store: failed or running rows are ignored', async () => {
  const good = await readNow();
  const admin = fakeAdmin();
  admin.rows.push({ id: 1, job_name: signalsJobName('acc-1'), status: 'failed', started_at: '2026-10-14T09:00:00Z', details: { signals: good } });
  admin.rows.push({ id: 2, job_name: signalsJobName('acc-1'), status: 'running', started_at: '2026-10-14T09:10:00Z', details: { signals: good } });
  assert.equal(await loadStoredSignals(admin, 'acc-1', NOW), null);
});

test('store: never throws when the database is down', async () => {
  const warnings = silenceWarnings();
  try {
    const signals = await readNow();
    const down = fakeAdmin({ throwOn: 'from' });
    assert.equal(await loadStoredSignals(down, 'acc-1', NOW), null);
    assert.equal(await saveSignals(down, 'acc-1', signals), false);
    assert.equal(await saveSignals(fakeAdmin({ failInsert: true }), 'acc-1', signals), false);
    assert.equal(await loadStoredSignals(null, 'acc-1', NOW), null);
    assert.equal(await saveSignals(null, 'acc-1', signals), false);
    assert.equal(await saveSignals(fakeAdmin(), 'acc-1', {} as any), false);
  } finally {
    warnings.restore();
  }
});

test('canReuseStoredSignals trusts a clean read for a day and a partial one for half an hour', async () => {
  const warnings = silenceWarnings();
  try {
    assert.equal(SIGNALS_RETRY_AFTER_MINUTES, 30);
    assert.equal(canReuseStoredSignals(null, NOW), false);
    const clean = await readNow({ now: new Date('2026-10-14T00:00:00Z') });
    assert.equal(canReuseStoredSignals(clean, new Date('2026-10-14T23:00:00Z')), true);
    assert.equal(canReuseStoredSignals(clean, new Date('2026-10-15T01:00:00Z')), false);

    const answers = healthy();
    answers.conversion_action = new Error('boom');
    const partial = await readNow({ now: new Date('2026-10-14T09:00:00Z') }, answers);
    assert.equal(canReuseStoredSignals(partial, new Date('2026-10-14T09:20:00Z')), true);
    assert.equal(canReuseStoredSignals(partial, new Date('2026-10-14T09:40:00Z')), false);
    // a clock that runs behind never makes a read look stale
    assert.equal(canReuseStoredSignals(partial, new Date('2026-10-14T08:00:00Z')), true);
  } finally {
    warnings.restore();
  }
});

// ---------------------------------------------------------------------------
// Running and storing in one step
// ---------------------------------------------------------------------------

const account = { id: 'acc-1', customer_id: '123-456-7890', manager_id: '7561141000', currency_code: 'SAR', refresh_token_encrypted: 'enc' };

test('readAndStoreSignals builds the client like Jarvis does, reads and stores', async () => {
  const admin = fakeAdmin();
  const customer = fakeCustomer(healthy());
  const calls: unknown[][] = [];
  const result = await readAndStoreSignals(
    { admin, account, connectedEmail: 'owner@example.com', now: NOW },
    {
      decrypt: (payload) => `plain:${payload}`,
      getCustomer: (...args) => {
        calls.push(args);
        return customer;
      },
      managerIds: () => ['999-888-7777'],
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['123-456-7890', 'plain:enc', '7561141000']]);
  if (!result.ok) return;
  assert.equal(result.saved, true);
  assert.equal(result.signals.customerId, '1234567890');
  assert.equal(admin.rows.length, 1);
});

test('readAndStoreSignals: our manager ids are not an outside agency', async () => {
  const link = (manager: string) => ({ customerManagerLink: { managerCustomer: `customers/${manager}`, status: 'ACTIVE' } });
  const answers = healthy();
  answers.customer_manager_link = [link('7561141000'), link('9998887777'), link('5550001111')];
  const result = await readAndStoreSignals(
    { admin: fakeAdmin(), account, connectedEmail: null },
    { decrypt: () => 't', getCustomer: () => fakeCustomer(answers), managerIds: () => ['999-888-7777'] }
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(valueOf(result.signals.externalManager), { linked: true, managerIds: ['5550001111'] });
});

test('readAndStoreSignals: the manager the account was connected through is not an outside agency', async () => {
  const link = (manager: string) => ({ customerManagerLink: { managerCustomer: `customers/${manager}`, status: 'ACTIVE' } });
  const answers = healthy();
  answers.customer_manager_link = [link('1140035066')];
  const through = await readAndStoreSignals(
    { admin: fakeAdmin(), account: { ...account, manager_id: '114-003-5066' }, connectedEmail: null },
    { decrypt: () => 't', getCustomer: () => fakeCustomer(answers), managerIds: () => [] }
  );
  assert.equal(through.ok, true);
  if (through.ok) assert.deepEqual(valueOf(through.signals.externalManager), { linked: false, managerIds: [] });
  // Connected directly: the same link is somebody else's manager.
  const direct = await readAndStoreSignals(
    { admin: fakeAdmin(), account: { ...account, manager_id: null }, connectedEmail: null },
    { decrypt: () => 't', getCustomer: () => fakeCustomer(answers), managerIds: () => [] }
  );
  if (direct.ok) assert.deepEqual(valueOf(direct.signals.externalManager), { linked: true, managerIds: ['1140035066'] });
});

test('GAQL: a WHERE filter on another resource\'s field is also selected (EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE)', () => {
  const texts = Object.entries(SIGNAL_GAQL).map(([key, query]) => {
    if (key === 'geoNames') return SIGNAL_GAQL.geoNames(['geoTargetConstants/1']);
    if (key === 'changeEvents') return SIGNAL_GAQL.changeEvents(new Date('2026-10-14T00:00:00Z'));
    return query as string;
  });
  const dateSegments = new Set(['segments.date', 'segments.week', 'segments.month', 'segments.quarter', 'segments.year']);
  for (const text of texts) {
    const flat = text.replace(/\s+/g, ' ');
    const select = flat.match(/SELECT (.*?) FROM /i)?.[1] ?? '';
    const from = flat.match(/ FROM (\w+)/i)?.[1] ?? '';
    const where = flat.match(/ WHERE (.*?)( ORDER BY | LIMIT |$)/i)?.[1] ?? '';
    const selected = new Set(select.split(',').map((field) => field.trim()));
    for (const field of where.match(/\b[a-z_]+\.[a-z_.]+/g) ?? []) {
      if (field.startsWith(`${from}.`) || dateSegments.has(field)) continue;
      assert.ok(selected.has(field), `${from}: ${field} is filtered but not selected`);
    }
  }
});

test('readAndStoreSignals: no token or a token that cannot be opened is client_unavailable, not a throw', async () => {
  const warnings = silenceWarnings();
  try {
    const deps = { decrypt: () => { throw new Error('bad key'); }, getCustomer: () => fakeCustomer(), managerIds: () => [] };
    assert.deepEqual(await readAndStoreSignals({ admin: fakeAdmin(), account, connectedEmail: null }, deps), { ok: false, error: 'client_unavailable' });
    assert.deepEqual(
      await readAndStoreSignals({ admin: fakeAdmin(), account: { ...account, refresh_token_encrypted: null }, connectedEmail: null }, { ...deps, decrypt: () => 't' }),
      { ok: false, error: 'client_unavailable' }
    );
  } finally {
    warnings.restore();
  }
});

test('readAndStoreSignals reports a save that did not happen', async () => {
  const result = await readAndStoreSignals(
    { admin: fakeAdmin({ failInsert: true }), account, connectedEmail: null },
    { decrypt: () => 't', getCustomer: () => fakeCustomer(healthy()), managerIds: () => [] }
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.saved, false);
});

test('ownManagerIdsFrom starts with our MCC, keeps digits only and drops repeats', () => {
  assert.deepEqual(ownManagerIdsFrom(), [MODAAFA_MCC_ID]);
  assert.deepEqual(ownManagerIdsFrom(['756-114-1000', '999-888-7777', '', null, undefined, 'x']), ['7561141000', '9998887777']);
});

// ---------------------------------------------------------------------------
// The two routes and the operator page: guard rails read from source
// ---------------------------------------------------------------------------

const read_ = (path: string) => readFileSync(resolve(path), 'utf8');
const setupRoute = read_('app/api/setup/signals/route.ts');
const operatorRoute = read_('app/api/operations/onboarding-signals/route.ts');
const page = read_('app/(dashboard)/operations/onboarding-signals/page.tsx');
const panel = read_('app/(dashboard)/operations/onboarding-signals/signals-panel.tsx');

const signalsRequestSource = read_('lib/setup/adaptive/signals-request.ts');

test('POST /api/setup/signals: same origin, signed in, flag, rate limit, then the request module (own account, admin save)', () => {
  // The decisions after the guards are behavioral tests in tests/adaptive-answers-flow.test.ts (runSignalsRequest).
  const order = ['isSameOriginRequest(req)', 'auth.getUser()', 'isAdaptiveOnboarding(process.env, user.email)', "scope: 'setup_signals'", 'getAccountWorkspace(user.id)', 'runSignalsRequest({'];
  let at = -1;
  for (const needle of order) {
    const next = setupRoute.indexOf(needle);
    assert.ok(next > at, `${needle} is missing or out of order`);
    at = next;
  }
  assert.match(setupRoute, /limit: 10, windowSeconds: 600, identifier: user\.id/);
  assert.match(setupRoute, /status: 404/);
  assert.doesNotMatch(setupRoute, /hasProductAccess|getSubscriptionAccess/);
  assert.doesNotMatch(signalsRequestSource, /hasProductAccess|getSubscriptionAccess/);
});

test('POST /api/operations/onboarding-signals: operator only, own business only, fresh read', () => {
  assert.match(operatorRoute, /isOperatorUser\(/);
  assert.match(operatorRoute, /isSameOriginRequest\(req\)/);
  assert.match(operatorRoute, /scope: 'operator_onboarding_signals'/);
  assert.match(operatorRoute, /\.eq\('business_id', business\.id\)/);
  assert.match(operatorRoute, /\.eq\('id', accountId\)\s+\.eq\('business_id', business\.id\)/);
  assert.match(operatorRoute, /classifyScenario\(/);
  assert.doesNotMatch(operatorRoute, /loadStoredSignals/, 'the operator read ignores the stored one');
});

test('the operator page is operator-only and linked from the operations tabs', () => {
  assert.match(page, /requireOperatorPage\('\/operations\/onboarding-signals'\)/);
  assert.match(page, /<OpsTabs active="signals"/);
  const tabs = read_('app/(dashboard)/operations/ops-ui.tsx');
  assert.match(tabs, /href: '\/operations\/onboarding-signals'/);
  assert.match(panel, /اقرأ الحساب/);
  assert.match(panel, /\/api\/operations\/onboarding-signals/);
});

// ---------------------------------------------------------------------------
// Operator page copy
// ---------------------------------------------------------------------------

const DASHES = /[—–]/;
const LATIN_COMMA_IN_ARABIC = /[؀-ۿ][^\n]*,\s|,\s[^\n]*[؀-ۿ]/;

async function sampleSignals() {
  const answers = healthy();
  answers.campaign_list = [campaignRow(1, 'بحث أسنان جدة', 'ENABLED', 'SEARCH'), campaignRow(2, 'متجر', 'PAUSED', 'PERFORMANCE_MAX'), campaignRow(3, 'نايمة', 'ENABLED', 'SEARCH')];
  answers.campaign_metrics = [
    campaignRow(1, 'بحث أسنان جدة', 'ENABLED', 'SEARCH', { costMicros: '1500000000', impressions: '9000', clicks: '400', conversions: 20, conversionsValue: 0 }),
  ];
  answers.conv_groups = [
    { segments: { conversionActionCategory: 'PHONE_CALL_LEAD' }, metrics: { conversions: 20 } },
    { segments: { conversionActionCategory: 'PURCHASE' }, metrics: { conversions: 3 } },
  ];
  answers.customer_manager_link = [{ customerManagerLink: { managerCustomer: 'customers/5550001111', status: 'ACTIVE' } }];
  answers.change_event = [{ changeEvent: { userEmail: 'x@example.com', clientType: 'GOOGLE_ADS_WEB_CLIENT' } }];
  answers.shopping_performance_view = [{ segments: { productItemId: 'a', productTitle: 'منتج' }, metrics: { costMicros: '80000000', conversions: 1, conversionsValue: 200 } }];
  answers.ad_group_ad = [{ adGroupAd: { ad: { finalUrls: ['https://clinic.example.com'] } } }];
  return readNow({}, answers);
}

test('operator page text: a line for every signal, Arabic, no long dashes, no Latin comma in prose', async () => {
  const signals = await sampleSignals();
  for (const key of SIGNAL_KEYS) {
    const label = SIGNAL_LABELS[key];
    assert.ok(label.length > 0, key);
    assert.doesNotMatch(label, DASHES);
    const text = describeSignal(key, signals);
    assert.ok(text.length > 0, `${key} has no text`);
    assert.doesNotMatch(text, DASHES, key);
    assert.doesNotMatch(text, LATIN_COMMA_IN_ARABIC, text);
  }
  assert.match(describeSignal('campaigns', signals), /3 حملات/);
  assert.match(describeSignal('campaigns', signals), /1,500/);
  assert.match(describeSignal('conversionsByGroup', signals), /اتصالات 20/);
  assert.match(describeSignal('autoTagging', signals), /شغّال/);
  assert.match(describeSignal('landingHosts', signals), /clinic\.example\.com/);
  assert.match(describeSignal('externalManager', signals), /5550001111/);
  assert.match(describeSignal('otherEditors14d', signals), /معدّل واحد/);
  assert.match(describeSignal('hours', signals), /الصرف 60 ريال/);
});

test('operator page text: a failed signal has no value text (the page shows the code instead)', async () => {
  const warnings = silenceWarnings();
  try {
    const answers = healthy();
    answers.campaign_list = new Error('boom');
    const signals = await readNow({}, answers);
    assert.equal(describeSignal('campaigns', signals), '');
    assert.notEqual(describeSignal('autoTagging', signals), '');
  } finally {
    warnings.restore();
  }
});

test('operator page text: the scenario in plain Arabic', () => {
  const rows = describeScenario({
    state: 'no_tracking',
    managed: 'suspected',
    kind: 'clinic',
    kindConfidence: 'confident',
    kindRanking: ['clinic', 'services', 'general'],
    platform: null,
    specialty: 'dental',
    outcome: 'calls',
    evidence: ['words:clinic', 'conv:call'],
  });
  const text = rows.map((row) => `${row.label} ${row.value}`).join('\n');
  assert.match(text, /يصرف وبدون تتبع/);
  assert.match(text, /عيادة \(واثق\)/);
  assert.match(text, /اتصالات/);
  assert.match(text, /مشكوك فيه/);
  assert.match(text, /words:clinic conv:call/);
  assert.doesNotMatch(text, DASHES);
  assert.doesNotMatch(text, /undefined/);
});

test('copy rules: no long or medium dash in anything Part A writes', () => {
  for (const [name, source] of Object.entries({ setupRoute, operatorRoute, page, panel, describe: read_('app/(dashboard)/operations/onboarding-signals/describe.ts') })) {
    assert.doesNotMatch(source, DASHES, name);
  }
});
