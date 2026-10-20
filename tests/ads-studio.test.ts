import assert from 'node:assert/strict';
import test from 'node:test';

import { isAdsStudioActive, isAdsStudioEnabled } from '../lib/ads/flag';
import {
  assetVerdict,
  buildAdAssetsSnapshot,
  computeCoverage,
  normalizeRsaRows,
  normalizeViewRows,
  mergeViewIntoRsas,
  readRsaAssets,
} from '../lib/ads/assets-reader';
import { writeRsaReplacements, writeCallouts } from '../lib/ads/writer';
import { validateAdsStudioPayload } from '../lib/ads/studio/validate';
import { prepareAdsStudioAction, AdsStudioPreflightError } from '../lib/ads/studio/preflight';
import {
  buildAdsStudioOperations,
  buildAdsStudioRollbackOperations,
  finalizeAdsStudioRollback,
} from '../lib/ads/studio/execute';
import { evaluateAdTest, buildAdTests } from '../lib/ads/ad-test';
import { buildAssetProposals, cardToRow, replaceFingerprint } from '../lib/ads/proposals';
import { hasBlockingCard } from '../lib/ads/cron';
import { buildExecutableAction } from '../lib/ai/executable-action';
import { validateExtendedPayload } from '../lib/ai/extended-actions/validate';
import { executeExtendedAction } from '../lib/ai/extended-actions/execute';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { EXTENDED_OPERATION_LABELS_AR } from '../lib/ai/operation-labels';
import { AUTOPILOT_SAFE_ACTIONS } from '../lib/autopilot/types';
import { readFileSync } from 'node:fs';

const CID = '1234567890';
const AD = `customers/${CID}/adGroupAds/11~22`;
const NEW_AD = `customers/${CID}/adGroupAds/11~33`;
const GROUP = `customers/${CID}/adGroups/11`;
const CAMPAIGN = `customers/${CID}/campaigns/555`;

function withFlags<T>(studio: string | undefined, extended: string | undefined, fn: () => T): T {
  const old = [process.env.ADS_STUDIO_ENABLED, process.env.EXTENDED_ACTIONS_ENABLED];
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set('ADS_STUDIO_ENABLED', studio);
  set('EXTENDED_ACTIONS_ENABLED', extended);
  try {
    return fn();
  } finally {
    set('ADS_STUDIO_ENABLED', old[0]);
    set('EXTENDED_ACTIONS_ENABLED', old[1]);
  }
}
async function withFlagsAsync<T>(studio: string | undefined, extended: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = [process.env.ADS_STUDIO_ENABLED, process.env.EXTENDED_ACTIONS_ENABLED];
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set('ADS_STUDIO_ENABLED', studio);
  set('EXTENDED_ACTIONS_ENABLED', extended);
  try {
    return await fn();
  } finally {
    set('ADS_STUDIO_ENABLED', old[0]);
    set('EXTENDED_ACTIONS_ENABLED', old[1]);
  }
}

const H = (text: string, label: string, extra: Record<string, unknown> = {}) => ({ text, asset_performance_label: label, ...extra });

function rsaRow(over: Record<string, unknown> = {}, impressions = 5000, status = 'ENABLED') {
  return {
    campaign: { resource_name: CAMPAIGN, name: 'بحث الصالون' },
    ad_group: { resource_name: GROUP, name: 'قص وتصفيف' },
    ad_group_ad: {
      resource_name: AD,
      status,
      ad_strength: 'AVERAGE',
      ad: {
        id: '22',
        final_urls: ['https://rose.sa/'],
        responsive_search_ad: {
          headlines: [
            H('صالون الورد الرياض', 'BEST'),
            H('احجزي موعدك اليوم', 'GOOD'),
            H('قص وتصفيف الشعر', 'GOOD'),
            H('خدمات تجميل نسائية', 'LOW'),
            H('عناية كاملة بالبشرة', 'LOW'),
          ],
          descriptions: [
            H('صالون نسائي في الرياض نقدم قص وصبغة وعناية بالبشرة', 'BEST'),
            H('احجزي موعدك بسهولة عبر الموقع', 'GOOD'),
            H('نخدمك في حي الورود بأجواء هادئة', 'LOW'),
          ],
        },
      },
    },
    metrics: { impressions, clicks: 100, conversions: 5, cost_micros: 200_000_000 },
    ...over,
  };
}

test('reader: labels come from the rows, verdict replaces only LOW texts with enough data', () => {
  const [rsa] = normalizeRsaRows([rsaRow()]);
  const v = assetVerdict(rsa);
  assert.equal(v.skip_reason, null);
  assert.deepEqual(v.replace.map((r) => r.text).sort(), ['خدمات تجميل نسائية', 'عناية كاملة بالبشرة', 'نخدمك في حي الورود بأجواء هادئة'].sort());
  assert.equal(v.counts.LOW, 3);

  const [few] = normalizeRsaRows([rsaRow({}, 300)]);
  assert.deepEqual([assetVerdict(few).replace.length, assetVerdict(few).skip_reason], [0, 'not_enough_data']);

  const [paused] = normalizeRsaRows([rsaRow({}, 5000, 'PAUSED')]);
  assert.equal(assetVerdict(paused).skip_reason, 'ad_not_enabled');
});

test('reader: a pinned LOW text is never replaced and the ad keeps its minimum', () => {
  const row = rsaRow();
  (row.ad_group_ad.ad.responsive_search_ad.headlines[3] as any).pinned_field = 'HEADLINE_1';
  const [rsa] = normalizeRsaRows([row]);
  const texts = assetVerdict(rsa).replace.map((r) => r.text);
  assert.ok(!texts.includes('خدمات تجميل نسائية'));

  const small = rsaRow();
  small.ad_group_ad.ad.responsive_search_ad.headlines = [
    H('أ أ أ', 'LOW'),
    H('ب ب ب', 'LOW'),
    H('ج ج ج', 'GOOD'),
  ];
  const [tiny] = normalizeRsaRows([small]);
  assert.equal(assetVerdict(tiny).skip_reason, 'would_empty_the_ad');
});

test('reader: the per-asset view wins over inline labels, and a failed view falls back', async () => {
  const [rsa] = normalizeRsaRows([rsaRow()]);
  const view = normalizeViewRows([
    {
      ad_group_ad_asset_view: { ad_group_ad: AD, field_type: 'HEADLINE', performance_label: 'LOW', enabled: true },
      asset: { text_asset: { text: 'صالون الورد الرياض' } },
    },
  ]);
  const merged = mergeViewIntoRsas([rsa], view)[0];
  assert.equal(merged.headlines[0].label, 'LOW');

  const calls: string[] = [];
  const report = await readRsaAssets({
    query: async (gaql: string) => {
      calls.push(gaql);
      if (gaql.includes('ad_group_ad_asset_view')) throw new Error('boom');
      return [rsaRow()];
    },
  });
  assert.equal(report.readable, true);
  assert.equal(report.rsas[0].headlines[0].label, 'BEST');
  const dead = await readRsaAssets({ query: async () => { throw new Error('down'); } });
  assert.equal(dead.readable, false);
});

test('reader: whole policy summary preserves per-text approval without rejected subfields', async () => {
  const report = await readRsaAssets({ query: async (gaql) => {
    if (!gaql.includes('FROM ad_group_ad_asset_view')) return [rsaRow()];
    if (/ad_group_ad_asset_view\.policy_summary\./.test(gaql)) throw new Error('UNRECOGNIZED_FIELD');
    return [{ ad_group_ad_asset_view: { ad_group_ad: AD, field_type: 'HEADLINE', performance_label: 'LOW',
      enabled: true, policy_summary: { approval_status: 'DISAPPROVED', review_status: 'REVIEWED' } },
    asset: { text_asset: { text: 'صالون الورد الرياض' } } }];
  } });
  assert.equal(report.readable, true);
  assert.equal(report.rsas[0].labels_from_view, true);
  assert.equal(report.rsas[0].headlines[0].label, 'LOW');
  assert.equal(report.rsas[0].headlines[0].approval, 'DISAPPROVED');
  assert.equal(report.rsas[0].headlines[0].review, 'REVIEWED');
});

test('snapshot block has counts only, no ad text, and coverage lists missing extensions', () => {
  const [rsa] = normalizeRsaRows([rsaRow()]);
  const coverage = computeCoverage(
    [{ resource: CAMPAIGN, name: 'بحث الصالون' }],
    [{ campaign: { resource_name: CAMPAIGN }, campaign_asset: { field_type: 'CALLOUT' } }],
    []
  );
  assert.ok(coverage[0].missing.includes('SITELINK'));
  const block = buildAdAssetsSnapshot({ rsas: [rsa], readable: true }, coverage);
  const json = JSON.stringify(block);
  assert.ok(!json.includes('صالون الورد'));
  assert.ok(json.includes('"low":3'));
});

test('writer: invalid model text never ships, a retry fills the gap', async () => {
  const replies = [
    JSON.stringify({ headlines: ['أفضل صالون في الرياض', 'عناية بالبشرة والشعر', 'خصم 50 بالمية'], descriptions: ['اتصلي 0555123456 الحين', 'احجزي موعدك في حي الورود بكل سهولة'] }),
    JSON.stringify({ headlines: ['تسريحات للمناسبات'], descriptions: ['نستقبلك في صالون الورد بالرياض بأجواء مريحة'] }),
  ];
  let calls = 0;
  const result = await writeRsaReplacements(
    {
      language: 'ar',
      business: { name: 'صالون الورد', sector: 'تجميل', city: 'الرياض', facts: ['صالون نسائي في الرياض', 'حي الورود'] },
      topTerms: [{ term: 'صالون نسائي', conversions: 4 }],
      replace: [{ field: 'HEADLINE' }, { field: 'HEADLINE' }, { field: 'DESCRIPTION' }],
      keep: [{ text: 'صالون الورد الرياض', field: 'HEADLINE' }],
    },
    { complete: async () => replies[calls++] }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const shipped = [...result.headlines, ...result.descriptions].join(' ');
  assert.ok(!/أفضل|خصم|0555/.test(shipped));
  assert.equal(result.headlines.length, 2);
  assert.equal(calls, 2);
});

test('writer: nothing passes means no result, and a model failure is reported', async () => {
  const bad = await writeCallouts(
    { language: 'ar', business: { name: 'صالون الورد' } },
    { complete: async () => JSON.stringify({ callouts: ['أفضل سعر!', 'مجاني 100%'] }) },
    3
  );
  assert.equal(bad.ok, false);
  const down = await writeCallouts({ language: 'ar', business: {} }, { complete: async () => { throw new Error('x'); } }, 3);
  assert.equal(down.ok, false);
});

const replaceParams = (over: Record<string, unknown> = {}) => ({
  ad_group_ad_resource: AD,
  mode: 'swap',
  language: 'ar',
  grounding_terms: ['صالون نسائي', 'الرياض'],
  replacements: [
    { field: 'HEADLINE', old_text: 'خدمات تجميل نسائية', new_text: 'تسريحات للمناسبات' },
    { field: 'DESCRIPTION', old_text: 'نخدمك في حي الورود بأجواء هادئة', new_text: 'نستقبلك في صالون الورد بأجواء مريحة وهادئة' },
  ],
  ...over,
});

test('payload validators: whitelist, texts, resources and urls', () => {
  assert.equal(validateAdsStudioPayload('replace_rsa_assets', AD, replaceParams(), CID).ok, true);
  assert.equal(validateAdsStudioPayload('replace_rsa_assets', AD, replaceParams(), '9999999999').ok, false);
  const dash = replaceParams({ replacements: [{ field: 'HEADLINE', old_text: 'أ', new_text: 'صالون — الرياض' }] });
  assert.equal(validateAdsStudioPayload('replace_rsa_assets', AD, dash, CID).ok, false);
  const numbers = replaceParams({ replacements: [{ field: 'HEADLINE', old_text: 'أ', new_text: 'خصم 70 بالمية' }] });
  assert.equal(validateAdsStudioPayload('replace_rsa_assets', AD, numbers, CID).ok, false);

  const co = validateAdsStudioPayload('add_callouts', CAMPAIGN, { campaign_resource: CAMPAIGN, callouts: ['حجز سهل', 'فريق نسائي'], language: 'ar' }, CID);
  assert.equal(co.ok, true);
  assert.equal(validateAdsStudioPayload('add_callouts', CAMPAIGN, { campaign_resource: CAMPAIGN, callouts: ['حجز سهل'] }, CID).ok, false);
  assert.equal(
    validateAdsStudioPayload('add_structured_snippet', CAMPAIGN, { campaign_resource: CAMPAIGN, header: 'Nonsense', values: ['قص', 'صبغة', 'عناية'] }, CID).ok,
    false
  );
  assert.equal(validateAdsStudioPayload('add_call_asset', CAMPAIGN, { campaign_resource: CAMPAIGN, phone_number: '0555123456' }, CID).ok, true);
  assert.equal(validateAdsStudioPayload('add_call_asset', CAMPAIGN, { campaign_resource: CAMPAIGN, phone_number: '123' }, CID).ok, false);
  const sl = validateAdsStudioPayload(
    'add_sitelinks',
    CAMPAIGN,
    {
      campaign_resource: CAMPAIGN,
      sitelinks: [
        { final_url: 'http://rose.sa/a', link_text: 'خدماتنا', description1: 'قص وتصفيف', description2: 'صبغة وعناية' },
        { final_url: 'https://rose.sa/b', link_text: 'احجزي', description1: 'موعد سهل', description2: 'بدون انتظار' },
      ],
    },
    CID
  );
  assert.equal(sl.ok, false, 'a non-https url is refused');
});

// ---- preflight with a mocked account -------------------------------------

function mockCustomer(opts: { rows?: any[]; enabledAds?: number; campaignChannel?: string; existing?: Record<string, any[]>; hosts?: string[] } = {}) {
  const log: string[] = [];
  return {
    log,
    async query(gaql: string) {
      log.push(gaql);
      if (gaql.includes('FROM ad_group_ad_asset_view')) return [];
      if (gaql.includes('responsive_search_ad.headlines')) return opts.rows ?? [rsaRow()];
      if (gaql.includes("ad_group_ad.status = 'ENABLED'") && gaql.includes('RESPONSIVE_SEARCH_AD')) {
        return Array.from({ length: opts.enabledAds ?? 1 }, () => ({ ad_group_ad: { resource_name: AD } }));
      }
      if (gaql.includes('FROM campaign_asset')) {
        const kind = /field_type = '(\w+)'/.exec(gaql)?.[1] ?? '';
        return opts.existing?.[kind] ?? [];
      }
      if (gaql.includes('ad_group_ad.ad.final_urls') && gaql.includes('campaign.resource_name')) {
        return (opts.hosts ?? ['https://rose.sa/']).map((u) => ({ ad_group_ad: { ad: { final_urls: [u] } } }));
      }
      if (gaql.includes('FROM campaign')) {
        return [{ campaign: { resource_name: CAMPAIGN, status: 'ENABLED', advertising_channel_type: opts.campaignChannel ?? 'SEARCH' } }];
      }
      return [];
    },
  };
}
const deps = { readSevenDayMetrics: async () => ({ cost: 10, clicks: 5, conversions: 1, conversion_value: 100 }) };
const act = (type: string, params: Record<string, unknown>, target = AD) => ({ type, target_id: target, params, reason_ar: '', reason_en: '', expected_impact: { metric: 'm', delta_pct: 0, delta_sar_per_month: 0 } }) as any;

test('preflight swap: builds a new ad from live data and keeps the old one paused for rollback', async () => {
  const validated: any = validateAdsStudioPayload('replace_rsa_assets', AD, replaceParams(), CID);
  const prepared = await prepareAdsStudioAction(act('replace_rsa_assets', validated.params), mockCustomer(), deps);
  const resolved = (prepared.action.params as any).resolved;
  assert.equal(resolved.pause_old, true);
  assert.equal(resolved.new_ad.headlines.length, 5);
  assert.ok(resolved.new_ad.headlines.some((h: any) => h.text === 'تسريحات للمناسبات'));
  assert.ok(!resolved.new_ad.headlines.some((h: any) => h.text === 'خدمات تجميل نسائية'));
  assert.equal((prepared.rollbackPayload as any).action_type, 'ext_ads_replace_rsa');
  assert.deepEqual((prepared.rollbackPayload as any).reenable_ads, [AD]);

  const ops = buildAdsStudioOperations(prepared.action);
  assert.equal(ops.length, 2);
  assert.deepEqual(Object.keys(ops[0]), ['ad_group_ad_operation']);
  assert.equal((ops[0] as any).ad_group_ad_operation.update.status, 'PAUSED');
  assert.equal((ops[1] as any).ad_group_ad_operation.create.status, 'ENABLED');
  assert.ok(!JSON.stringify(ops).includes('"remove"'));
});

test('preflight: refuses a changed ad, a pinned text, a full ad group and a disabled ad', async () => {
  const validated: any = validateAdsStudioPayload('replace_rsa_assets', AD, replaceParams(), CID);
  const changed = rsaRow();
  changed.ad_group_ad.ad.responsive_search_ad.headlines[3] = H('نص ثاني', 'LOW');
  await assert.rejects(prepareAdsStudioAction(act('replace_rsa_assets', validated.params), mockCustomer({ rows: [changed] }), deps), (e: any) => e instanceof AdsStudioPreflightError && e.code === 'ad_changed');

  const pinned = rsaRow();
  (pinned.ad_group_ad.ad.responsive_search_ad.headlines[3] as any).pinned_field = 'HEADLINE_2';
  await assert.rejects(prepareAdsStudioAction(act('replace_rsa_assets', validated.params), mockCustomer({ rows: [pinned] }), deps), (e: any) => e.code === 'pinned_asset');

  const variant: any = validateAdsStudioPayload('replace_rsa_assets', AD, replaceParams({ mode: 'test_variant' }), CID);
  await assert.rejects(prepareAdsStudioAction(act('replace_rsa_assets', variant.params), mockCustomer({ enabledAds: 2 }), deps), (e: any) => e.code === 'too_many_ads_for_test');

  await assert.rejects(prepareAdsStudioAction(act('replace_rsa_assets', validated.params), mockCustomer({ rows: [rsaRow({}, 5000, 'PAUSED')] }), deps), (e: any) => e.code === 'ad_not_enabled');
});

test('preflight test_variant: the old ad stays enabled and only the new one is created', async () => {
  const variant: any = validateAdsStudioPayload('replace_rsa_assets', AD, replaceParams({ mode: 'test_variant' }), CID);
  const prepared = await prepareAdsStudioAction(act('replace_rsa_assets', variant.params), mockCustomer({ enabledAds: 1 }), deps);
  const ops = buildAdsStudioOperations(prepared.action);
  assert.equal(ops.length, 1);
  assert.deepEqual((prepared.rollbackPayload as any).reenable_ads, []);
});

test('campaign assets: temp resource names, link after asset, search campaigns only, duplicates refused', async () => {
  const p: any = validateAdsStudioPayload('add_callouts', CAMPAIGN, { campaign_resource: CAMPAIGN, callouts: ['حجز سهل', 'فريق نسائي'], language: 'ar' }, CID);
  const prepared = await prepareAdsStudioAction(act('add_callouts', p.params, CAMPAIGN), mockCustomer(), deps);
  const ops = buildAdsStudioOperations(prepared.action);
  assert.equal(ops.length, 4);
  assert.ok((ops[0] as any).asset_operation.create.resource_name.endsWith('/assets/-1'));
  assert.equal((ops[1] as any).campaign_asset_operation.create.asset, (ops[0] as any).asset_operation.create.resource_name);
  assert.equal((ops[1] as any).campaign_asset_operation.create.field_type, 'CALLOUT');
  assert.deepEqual((prepared.rollbackPayload as any).created_link_indexes, [1, 3]);

  await assert.rejects(prepareAdsStudioAction(act('add_callouts', p.params, CAMPAIGN), mockCustomer({ campaignChannel: 'PERFORMANCE_MAX' }), deps), (e: any) => e.code === 'not_search_campaign');
  const existing = { CALLOUT: [{ asset: { callout_asset: { callout_text: 'حجز سهل' }, resource_name: `customers/${CID}/assets/9` }, campaign_asset: { resource_name: `customers/${CID}/campaignAssets/1~9~CALLOUT` } }] };
  await assert.rejects(prepareAdsStudioAction(act('add_callouts', p.params, CAMPAIGN), mockCustomer({ existing }), deps), (e: any) => e.code === 'callout_exists');

  const sl: any = validateAdsStudioPayload(
    'add_sitelinks',
    CAMPAIGN,
    {
      campaign_resource: CAMPAIGN,
      sitelinks: [
        { final_url: 'https://other.com/a', link_text: 'خدماتنا', description1: 'قص وتصفيف', description2: 'صبغة وعناية' },
        { final_url: 'https://other.com/b', link_text: 'احجزي', description1: 'موعد سهل', description2: 'بدون انتظار' },
      ],
    },
    CID
  );
  assert.equal(sl.ok, true);
  await assert.rejects(prepareAdsStudioAction(act('add_sitelinks', sl.params, CAMPAIGN), mockCustomer(), deps), (e: any) => e.code === 'sitelink_host_mismatch');
});

test('rollback: finalize maps results, rollback never removes an ad and stays inside the touched resources', () => {
  const payload = { action_type: 'ext_ads_replace_rsa', reenable_ads: [AD], pause_ads: [], created_ad_indexes: [1], touched_resources: [GROUP, AD] };
  const finalized: any = finalizeAdsStudioRollback(payload, { results: [{ resourceName: AD }, { resourceName: NEW_AD }] });
  assert.deepEqual(finalized.pause_ads, [NEW_AD]);
  const ops = buildAdsStudioRollbackOperations(finalized);
  assert.equal(ops.length, 2);
  assert.ok(!JSON.stringify(ops).includes('"remove"'));
  assert.equal(rollbackResourcesScoped(finalized, CID), true);
  assert.equal(rollbackResourcesScoped(finalized, '9999999999'), false);
  assert.throws(() => buildAdsStudioRollbackOperations({ ...finalized, pause_ads: [`customers/${CID}/adGroupAds/99~99`] }));

  const missing: any = finalizeAdsStudioRollback(payload, { results: [{ resourceName: AD }] });
  assert.equal(missing.reversible, false);

  const assets: any = finalizeAdsStudioRollback(
    { action_type: 'ext_ads_remove_campaign_assets', created_link_indexes: [1], touched_resources: [CAMPAIGN] },
    { results: [{ resourceName: `customers/${CID}/assets/1` }, { resourceName: `customers/${CID}/campaignAssets/555~1~CALLOUT` }] }
  );
  const rb = buildAdsStudioRollbackOperations(assets);
  assert.deepEqual(rb, [{ campaign_asset_operation: { remove: `customers/${CID}/campaignAssets/555~1~CALLOUT` } }]);
});

test('flags: off means refused, the tool is absent and labels exist', async () => {
  withFlags(undefined, 'true', () => {
    assert.equal(isAdsStudioEnabled(), false);
    assert.equal(isAdsStudioActive(), false);
    assert.deepEqual(validateExtendedPayload('add_callouts' as any, CAMPAIGN, {}, CID), { ok: false, code: 'ads_studio_disabled' });
    assert.equal(buildExecutableAction({ operation: 'add_callouts', target_id: CAMPAIGN, params: { campaign_resource: CAMPAIGN, callouts: ['حجز سهل', 'فريق نسائي'] } }, { id: 'r1' }, CID), null);
  });
  withFlags('true', undefined, () => {
    assert.equal(isAdsStudioEnabled(), true);
    assert.equal(isAdsStudioActive(), false, 'the studio flag alone does not unlock writes');
  });
  withFlags('true', 'true', () => assert.equal(isAdsStudioActive(), true));
  withFlags('TRUE', 'true', () => assert.equal(isAdsStudioEnabled(), false));
  await withFlagsAsync(undefined, 'true', async () => {
    await assert.rejects(executeExtendedAction(act('add_callouts', {}, CAMPAIGN), {} as any), /disabled/);
  });
  for (const op of ['replace_rsa_assets', 'add_sitelinks', 'add_callouts', 'add_structured_snippet', 'add_call_asset']) {
    assert.ok((EXTENDED_OPERATION_LABELS_AR as any)[op], op);
    assert.ok(!/[—–]/.test((EXTENDED_OPERATION_LABELS_AR as any)[op]));
  }
});

test('ad test: collecting, winner, no clear difference, and the CPA block', () => {
  const v = (id: string, impressions: number, conversions: number, cost = 100) => ({ ad_group_ad: id, impressions, clicks: 0, conversions, cost });
  assert.equal(evaluateAdTest(v('a', 300, 2), v('b', 300, 5), 28).status, 'collecting');
  assert.equal(evaluateAdTest(v('a', 5000, 20), v('b', 5000, 55), 28).status, 'winner');
  assert.equal(evaluateAdTest(v('a', 5000, 30), v('b', 5000, 32), 28).status, 'no_clear_difference');
  assert.equal(evaluateAdTest(v('a', 5000, 20, 2000), v('b', 5000, 55, 5500), 28, { allowableCpa: 50 }).status, 'cpa_blocks_winner');
  const note = evaluateAdTest(v('a', 5000, 20), v('b', 5000, 55), 28).note_ar;
  assert.ok(note.length > 0 && !/[—–]/.test(note));
  assert.ok(Array.isArray(buildAdTests([])));
});

// ---- optimizer proposals --------------------------------------------------

test('proposals: a LOW-assets card is built, validated, queued for approval and never autopilot', async () => {
  const rsas = normalizeRsaRows([rsaRow()]);
  const replies = [JSON.stringify({ headlines: ['تسريحات للمناسبات', 'عناية بالشعر والبشرة', 'صبغة وقص'], descriptions: ['نستقبلك في صالون الورد بأجواء مريحة وهادئة', 'احجزي موعدك وتعالي لصالون الورد'] })];
  const report = await buildAssetProposals(
    {
      accountId: 'acc1',
      customerId: CID,
      report: { rsas, readable: true },
      coverage: [],
      reader: mockCustomer(),
      business: { name: 'صالون الورد', facts: ['صالون نسائي في الرياض'] },
      topTerms: [{ term: 'صالون نسائي', conversions: 4 }],
    },
    { writer: { complete: async () => replies[0] }, hasBlocking: async () => false }
  );
  assert.equal(report.cards.length, 1);
  const card = report.cards[0];
  assert.equal(card.action.type, 'replace_rsa_assets');
  assert.equal(validateAdsStudioPayload('replace_rsa_assets', AD, card.action.params, CID).ok, true);
  const row: any = cardToRow(card);
  assert.equal(row.action_payload.operation, 'replace_rsa_assets');
  assert.equal(row.action_payload.source, 'optimizer_cron');
  assert.notEqual(row.action_payload.autopilot.outcome, 'execute');
  assert.ok(!/[—–,]/.test(row.title + row.description));
  assert.ok(!(AUTOPILOT_SAFE_ACTIONS as readonly string[]).some((a) => a.startsWith('replace_rsa') || a.startsWith('add_call') || a.startsWith('add_sitelink')));
  const agentSource = readFileSync('lib/ai/optimizer-agent.ts', 'utf8');
  assert.ok(!/replace_rsa_assets|add_sitelinks|add_callouts|add_structured_snippet|add_call_asset/.test(agentSource.slice(agentSource.indexOf('const ALLOWED_ACTION_TYPES'), agentSource.indexOf('const ALLOWED_ACTION_TYPES') + 900)));
  assert.equal(card.fingerprint, replaceFingerprint('acc1', AD, assetVerdict(rsas[0]).replace));
});

test('proposals: an existing card or an unusable model reply gives no card and no write', async () => {
  const rsas = normalizeRsaRows([rsaRow()]);
  let modelCalls = 0;
  const base = {
    accountId: 'acc1',
    customerId: CID,
    report: { rsas, readable: true },
    coverage: [],
    reader: mockCustomer(),
    business: { name: 'صالون الورد' },
    topTerms: [],
  };
  const blocked = await buildAssetProposals(base, { writer: { complete: async () => { modelCalls++; return '{}'; } }, hasBlocking: async () => true });
  assert.equal(blocked.cards.length, 0);
  assert.equal(modelCalls, 0, 'a pending card costs no model call');
  const junk = await buildAssetProposals(base, { writer: { complete: async () => 'not json' }, hasBlocking: async () => false });
  assert.equal(junk.cards.length, 0);
  const lowData = await buildAssetProposals({ ...base, report: { rsas: normalizeRsaRows([rsaRow({}, 200)]), readable: true } }, { writer: { complete: async () => { modelCalls++; return '{}'; } }, hasBlocking: async () => false });
  assert.equal(lowData.cards.length, 0);
  assert.equal(modelCalls, 0);
});

test('proposals: missing callouts become an add card; sitelinks and call assets are never invented', async () => {
  const rsas = normalizeRsaRows([rsaRow()]);
  const coverage = computeCoverage([{ resource: CAMPAIGN, name: 'بحث الصالون' }], [], []);
  const report = await buildAssetProposals(
    {
      accountId: 'acc1',
      customerId: CID,
      report: { rsas: normalizeRsaRows([rsaRow({}, 500)]), readable: true },
      coverage,
      reader: mockCustomer(),
      business: { name: 'صالون الورد', facts: ['صالون نسائي في الرياض'] },
      topTerms: [],
    },
    { writer: { complete: async () => JSON.stringify({ callouts: ['حجز سهل', 'فريق نسائي', 'قص وتصفيف', 'عناية بالبشرة'] }) }, hasBlocking: async () => false }
  );
  assert.equal(report.cards.length, 1);
  assert.equal(report.cards[0].action.type, 'add_callouts');
  assert.ok(report.skipped.some((s) => s.what === 'add_sitelinks' && s.why === 'no_site_urls') || report.cards[0].kind === 'add_missing');
  assert.equal(rsas.length, 1);
});

test('cooldown: a pending card or a recent one blocks, an old finished one does not', async () => {
  const mk = (rows: any[]) => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: rows }) }) }) }) }) });
  const now = Date.now();
  assert.equal(await hasBlockingCard(mk([{ status: 'pending', created_at: new Date(now - 40 * 86400000).toISOString() }]), 'a', 'f', now), true);
  assert.equal(await hasBlockingCard(mk([{ status: 'dismissed', created_at: new Date(now - 3 * 86400000).toISOString() }]), 'a', 'f', now), true);
  assert.equal(await hasBlockingCard(mk([{ status: 'dismissed', created_at: new Date(now - 30 * 86400000).toISOString() }]), 'a', 'f', now), false);
  assert.equal(await hasBlockingCard(mk([]), 'a', 'f', now), false);
});
