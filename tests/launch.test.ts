import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignLaunchEnabled, LAUNCH_OPERATION } from '../lib/launch/flag';
import { buildLaunchPlan } from '../lib/launch/plan';
import { expandArabicVariants, expandAndDedupeKeywords } from '../lib/launch/arabic';
import { buildRsa, containsPhoneNumber, copyIssues, hasExcessCaps, hasExcessPunctuation } from '../lib/launch/copy';
import { buildNegativePlan, negativeBlocksKeyword } from '../lib/launch/negatives';
import { buildLaunchOperations } from '../lib/launch/operations';
import { executeLaunch, executeLaunchRollback, type LaunchCustomer } from '../lib/launch/execute';
import { validateStoredPlan } from '../lib/launch/validate';
import { buildExecutableAction } from '../lib/ai/executable-action';
import { finalizeRollbackPayload } from '../lib/ai/execution-result';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { launchPreviewModel } from '../lib/launch/preview';
import { createEnableCard, buildCardRow, enableCardRow } from '../lib/launch/recommendation';
import { runLaunchAction } from '../lib/launch/action';
import { pickGeoTargetConstants } from '../lib/launch/geo';
import { context, draft, descriptions, headlines } from './launch-fixtures';

const CID = '1234567890';

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.CAMPAIGN_LAUNCH_ENABLED;
  if (value === undefined) delete process.env.CAMPAIGN_LAUNCH_ENABLED;
  else process.env.CAMPAIGN_LAUNCH_ENABLED = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CAMPAIGN_LAUNCH_ENABLED;
    else process.env.CAMPAIGN_LAUNCH_ENABLED = previous;
  }
}

const rec = { title: 'ابنِ الحملة موقوفة', description: 'وصف' };
const plan = () => buildLaunchPlan(draft(), context());

// ---- flag ----------------------------------------------------------------------

test('the launch flag is off unless exactly "true"', () => {
  assert.equal(campaignLaunchEnabled({}), false);
  assert.equal(campaignLaunchEnabled({ CAMPAIGN_LAUNCH_ENABLED: 'false' }), false);
  assert.equal(campaignLaunchEnabled({ CAMPAIGN_LAUNCH_ENABLED: '1' }), false);
  assert.equal(campaignLaunchEnabled({ CAMPAIGN_LAUNCH_ENABLED: 'true' }), true);
});

test('flag off: an approved launch card is never executable and the old operations are unchanged', () => {
  const p = plan();
  withFlag(undefined, () => {
    assert.equal(buildExecutableAction({ operation: LAUNCH_OPERATION, params: { plan: p } }, rec), null);
    const pause = buildExecutableAction(
      { operation: 'pause_campaign', target_id: 'customers/123/campaigns/9', params: {} },
      rec
    );
    assert.equal(pause?.type, 'pause_campaign');
  });
});

test('flag off: the executor entry refuses to run', async () => {
  await withFlag(undefined, async () => {
    await assert.rejects(runLaunchAction({ plan: plan(), customer_id: CID }, {}), /disabled/);
  });
});

test('flag on: a valid stored plan becomes a launch action scoped to the account', () => {
  withFlag('true', () => {
    const action = buildExecutableAction({ operation: LAUNCH_OPERATION, params: { plan: plan() } }, rec, CID);
    assert.equal(action?.type, 'launch_campaign');
    assert.equal(action?.params.customer_id, CID);
    // The first pass has no account yet and still validates.
    assert.equal(buildExecutableAction({ operation: LAUNCH_OPERATION, params: { plan: plan() } }, rec)?.type, 'launch_campaign');
  });
});

test('flag on: a tampered plan is refused (not paused, networks open, blocked, missing)', () => {
  withFlag('true', () => {
    const tamper = (mutate: (p: any) => void) => {
      const p: any = JSON.parse(JSON.stringify(plan()));
      mutate(p);
      return buildExecutableAction({ operation: LAUNCH_OPERATION, params: { plan: p } }, rec);
    };
    assert.equal(tamper((p) => (p.settings.status = 'ENABLED')), null);
    assert.equal(tamper((p) => (p.settings.display_network = true)), null);
    assert.equal(tamper((p) => (p.settings.search_partners = true)), null);
    assert.equal(tamper((p) => (p.executable = false)), null);
    assert.equal(tamper((p) => p.blockers.push({ code: 'x', message_ar: 'x' })), null);
    assert.equal(tamper((p) => (p.budget.daily_micros = 6_000_000_000)), null);
    assert.equal(tamper((p) => (p.bidding.cpc_ceiling_micros = null)), null);
    assert.equal(tamper((p) => (p.ad_groups[0].rsa.headlines[0] = '0551234567 اتصل')), null);
    assert.equal(tamper((p) => (p.ad_groups[0].final_url = 'http://insecure.example')), null);
    assert.equal(tamper((p) => (p.geo.country_constant = 'geoTargetConstants/2840')), null);
    assert.equal(tamper((p) => (p.version = 99)), null);
    assert.equal(tamper(() => undefined)?.type, 'launch_campaign');
    assert.equal(buildExecutableAction({ operation: LAUNCH_OPERATION, params: {} }, rec), null);
  });
});

// ---- plan per business type ------------------------------------------------------

test('a clinic plan is a Search plan with Max Clicks capped at a tenth of the budget, PAUSED, networks off', () => {
  const p = plan();
  assert.equal(p.executable, true);
  assert.equal(p.type, 'SEARCH');
  assert.equal(p.business_kind, 'clinic');
  assert.equal(p.settings.status, 'PAUSED');
  assert.equal(p.settings.search_partners, false);
  assert.equal(p.settings.display_network, false);
  assert.equal(p.settings.positive_geo_target_type, 'PRESENCE');
  assert.equal(p.bidding.strategy, 'MAXIMIZE_CLICKS');
  assert.ok((p.bidding.cpc_ceiling_micros ?? 0) <= p.budget.daily_micros / 10);
  assert.equal(p.budget.daily_micros, 100_000_000);
  assert.equal(p.geo.regions[0].geo_target_constant, 'geoTargetConstants/1012045');
  assert.equal(p.assets.call_phone, '+966551234567');
  assert.ok(p.shared_negative_list.keywords.length > 0);
  assert.ok(p.ad_groups[0].rsa && p.ad_groups[0].rsa.headlines.length >= 3);
});

test('a services business gets a services kind and its own plan', () => {
  const p = buildLaunchPlan(
    draft({ name: 'سباك الرياض', objective: 'LEADS' }),
    context({ sector: 'خدمات صيانة', businessName: 'سباك الرياض' })
  );
  assert.equal(p.executable, true);
  assert.notEqual(p.business_kind, 'ecommerce');
  assert.equal(p.type, 'SEARCH');
});

test('a local business keeps PRESENCE geo and a location asset request', () => {
  const p = buildLaunchPlan(draft(), context({ sector: 'مطعم', businessName: 'مطعم الديرة' }));
  assert.equal(p.business_kind, 'local');
  assert.equal(p.settings.positive_geo_target_type, 'PRESENCE');
  assert.equal(p.assets.use_location_sync, true);
});

test('a store without Merchant Center starts as Search', () => {
  const p = buildLaunchPlan(
    draft({ objective: 'SALES' }),
    context({ sector: 'متجر إلكتروني', businessName: 'متجر الورد', signals: { conversions_30d: 3, tracking_healthy: true, merchant_center_linked: false } })
  );
  assert.equal(p.type, 'SEARCH');
});

test('a store with Merchant Center and under 30 conversions starts as Standard Shopping, never Max Conversions', () => {
  const p = buildLaunchPlan(
    draft({ objective: 'SALES', bidding_strategy: 'MAXIMIZE_CONVERSIONS' }),
    context({ sector: 'متجر إلكتروني', businessName: 'متجر الورد', signals: { conversions_30d: 4, tracking_healthy: true, merchant_center_linked: true } })
  );
  assert.equal(p.type, 'SHOPPING');
  assert.notEqual(p.bidding.strategy, 'MAXIMIZE_CONVERSIONS');
  assert.deepEqual(p.shopping, { campaign_priority: 0 });
  assert.equal(p.assets.sitelinks.length, 0);
  assert.equal(p.executable, true);
  const check = withFlag('true', () => validateStoredPlan(p));
  assert.equal(check.ok, true);
});

test('Performance Max is a blocker, not a build', () => {
  const p = buildLaunchPlan(
    draft({ type: 'PMAX', objective: 'SALES' }),
    context({ sector: 'متجر إلكتروني', signals: { conversions_30d: 60, tracking_healthy: true, merchant_center_linked: true } })
  );
  if (p.type === 'PMAX') {
    assert.equal(p.executable, false);
    assert.ok(p.blockers.some((b) => b.code === 'pmax_assets_required'));
  }
});

test('blockers: non-SAR account, missing budget, unresolved region, no landing page', () => {
  assert.ok(buildLaunchPlan(draft(), context({ currency: 'USD' })).blockers.some((b) => b.code === 'not_sar'));
  assert.ok(buildLaunchPlan(draft({ daily_budget_sar: 0 }), context()).blockers.some((b) => b.code === 'budget_missing'));
  const unresolved = buildLaunchPlan(draft(), context({ resolvedRegions: {} }));
  assert.ok(unresolved.blockers.some((b) => b.code === 'regions_unresolved'));
  assert.equal(unresolved.executable, false);
  const noSite = buildLaunchPlan(draft({ landing_page: undefined, ad_groups: draft().ad_groups.map((g) => ({ ...g, final_url: undefined })) }), context({ website: null }));
  assert.ok(noSite.blockers.some((b) => b.code === 'no_landing_page'));
});

test('a budget far above the monthly budget is a blocker', () => {
  const p = buildLaunchPlan(draft({ daily_budget_sar: 900 }), context({ monthlyBudgetSar: 3000 }));
  assert.ok(p.blockers.some((b) => b.code === 'budget_unreasonable'));
});

test('BROAD match is never planned', () => {
  const d = draft();
  d.ad_groups[0].keywords.push({ text: 'علاج اسنان', match_type: 'BROAD' } as any);
  const p = buildLaunchPlan(d, context());
  for (const group of p.ad_groups) for (const k of group.keywords) assert.ok(['EXACT', 'PHRASE'].includes(k.match_type));
});

// ---- Arabic variants ----------------------------------------------------------------

test('spelling variants cover ة/ه, أ/ا/إ and with/without ال', () => {
  const variants = expandArabicVariants('عيادة أسنان');
  assert.ok(variants.includes('عيادة أسنان'));
  assert.ok(variants.includes('عياده أسنان'));
  assert.ok(variants.includes('عيادة اسنان'));
  assert.ok(variants.includes('عيادة الأسنان'));
});

test('ى/ي variants are produced', () => {
  const variants = expandArabicVariants('مستشفى الاطفال');
  assert.ok(variants.some((v) => v.includes('مستشفي')));
});

test('variants are deduped across keywords and the original comes first', () => {
  const out = expandAndDedupeKeywords([
    { text: 'عيادة أسنان', match_type: 'PHRASE' },
    { text: 'عياده اسنان', match_type: 'PHRASE' },
  ]);
  const texts = out.keywords.map((k) => k.text);
  assert.equal(texts[0], 'عيادة أسنان');
  assert.equal(new Set(texts.map((t) => t.normalize('NFC'))).size, texts.length);
  assert.ok(out.dropped_duplicates >= 1);
});

test('the keyword cap is respected', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ text: `خدمة أسنان ${i}`, match_type: 'PHRASE' as const }));
  const out = expandAndDedupeKeywords(many, { maxTotal: 10 });
  assert.equal(out.keywords.length, 10);
  assert.ok(out.truncated > 0);
});

// ---- RSA and copy validators ----------------------------------------------------------

test('RSA keeps 15 headlines and 4 descriptions at most, within 30 and 90', () => {
  const longList = Array.from({ length: 20 }, (_, i) => `عنوان رقم ${i + 1} للإعلان`);
  const check = buildRsa({ headlines: longList, descriptions: descriptions.concat(descriptions), path1: null, path2: null, brand: null, allowGuarantee: false, language: 'ar' });
  assert.ok(check.rsa);
  assert.ok(check.rsa!.headlines.length <= 15);
  assert.ok(check.rsa!.descriptions.length <= 4);
  for (const h of check.rsa!.headlines) assert.ok(h.length <= 30);
  for (const d of check.rsa!.descriptions) assert.ok(d.length <= 90);
});

test('over-long, shouting, punctuation-heavy and phone-number lines are dropped', () => {
  const check = buildRsa({
    headlines: [
      ...headlines,
      'هذا عنوان أطول بكثير من ثلاثين حرفاً بالتأكيد',
      'BEST CLINIC IN TOWN NOW',
      'احجز الآن!!!',
      'اتصل 0551234567',
    ],
    descriptions,
    path1: null,
    path2: null,
    brand: null,
    allowGuarantee: false,
    language: 'ar',
  });
  assert.ok(check.rsa);
  const kept = check.rsa!.headlines.join('|');
  assert.ok(!kept.includes('0551234567'));
  assert.ok(!kept.includes('BEST CLINIC'));
  assert.ok(!kept.includes('!!!'));
  assert.ok(check.dropped.length >= 4);
});

test('phone number detection ignores prices and ranges', () => {
  assert.equal(containsPhoneNumber('اتصل 0551234567'), true);
  assert.equal(containsPhoneNumber('055 123 4567'), true);
  assert.equal(containsPhoneNumber('٠٥٥١٢٣٤٥٦٧'), true);
  assert.equal(containsPhoneNumber('من 1500 - 2500 ريال'), false);
  assert.equal(containsPhoneNumber('خصم 20%'), false);
  assert.equal(hasExcessCaps('GREATEST DEAL TODAY'), true);
  assert.equal(hasExcessCaps('خصم على iPhone'), false);
  assert.equal(hasExcessPunctuation('خصم!!'), true);
  assert.equal(hasExcessPunctuation('خصم كبير'), false);
});

test('copy limits per kind', () => {
  assert.deepEqual(copyIssues('احجز موعدك', { kind: 'headline' }), []);
  assert.ok(copyIssues('أ'.repeat(31), { kind: 'headline' }).length > 0);
  assert.ok(copyIssues('أ'.repeat(91), { kind: 'description' }).length > 0);
  assert.ok(copyIssues('أ'.repeat(26), { kind: 'callout' }).length > 0);
});

// ---- negatives -------------------------------------------------------------------------

test('a starter negative that would block a keyword is removed, never the keyword', () => {
  const out = buildNegativePlan({ campaignNegatives: [{ text: 'مجانا', match_type: 'PHRASE' }], positiveKeywords: ['فحص مجانا'] });
  assert.ok(!out.campaign_negatives.some((n) => n.text === 'مجانا'));
  assert.equal(negativeBlocksKeyword({ text: 'مجانا', match_type: 'PHRASE' }, 'فحص مجانا'), true);
  assert.equal(negativeBlocksKeyword({ text: 'وظائف', match_type: 'PHRASE' }, 'عيادة أسنان'), false);
});

test('the starter list has jobs and free style words in Arabic', () => {
  const out = buildNegativePlan({ campaignNegatives: [], positiveKeywords: ['عيادة أسنان'] });
  const texts = out.shared_list.keywords.map((n) => n.text).join(' ');
  assert.ok(/وظائف|توظيف/.test(texts));
  assert.ok(/مجان/.test(texts));
});

// ---- operations --------------------------------------------------------------------------

const opCtx = {
  customerId: CID,
  campaignName: 'عيادات النخبة | بحث',
  budgetName: 'عيادات النخبة | بحث | ميزانية abcd1234',
  merchantId: null,
};

function flatten(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flatten(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => flatten(v, out));
  return out;
}

test('the batch creates the campaign PAUSED with temporary negative ids and networks closed', () => {
  const built = buildLaunchOperations(plan(), opCtx);
  const campaignOp = built.operations.find((op: any) => op.campaign_operation) as any;
  const campaign = campaignOp.campaign_operation.create;
  assert.equal(campaign.status, 'PAUSED');
  assert.match(campaign.resource_name, /^customers\/1234567890\/campaigns\/-\d+$/);
  assert.match(campaign.campaign_budget, /^customers\/1234567890\/campaignBudgets\/-\d+$/);
  assert.equal(campaign.network_settings.target_google_search, true);
  assert.equal(campaign.network_settings.target_search_network, false);
  assert.equal(campaign.network_settings.target_content_network, false);
  assert.equal(campaign.geo_target_type_setting.positive_geo_target_type, 'PRESENCE');
  assert.ok('contains_eu_political_advertising' in campaign);
  assert.ok(campaign.maximize_clicks || campaign.target_spend || campaign.manual_cpc);
  assert.equal(built.operations.length, built.roles.length);
  for (const [i, role] of built.roles.entries()) {
    const body: any = Object.values(built.operations[i])[0];
    if (body.create?.resource_name) assert.match(body.create.resource_name, /-\d+$/, `${role} uses a temp id`);
  }
});

test('nothing in the batch enables anything or removes anything', () => {
  const built = buildLaunchOperations(plan(), opCtx);
  const campaigns = built.operations.filter((op: any) => op.campaign_operation) as any[];
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].campaign_operation.create.status, 'PAUSED');
  for (const op of built.operations) {
    const body: any = Object.values(op)[0];
    assert.equal(body.remove, undefined);
  }
  const statuses = flatten(built.operations).filter((s) => s === 'REMOVED');
  assert.equal(statuses.length, 0);
});

test('every temp id is unique and every reference points at a created resource', () => {
  const built = buildLaunchOperations(plan(), opCtx);
  const created = new Set<string>();
  for (const op of built.operations) {
    const body: any = Object.values(op)[0];
    const name = body.create?.resource_name;
    if (typeof name === 'string') {
      assert.ok(!created.has(name), `duplicate ${name}`);
      created.add(name);
    }
  }
  const refs = flatten(built.operations).filter((s) => /^customers\/\d+\/[A-Za-z]+\/-\d+$/.test(s));
  for (const ref of refs) assert.ok(created.has(ref), `dangling temp reference ${ref}`);
});

test('the shopping batch carries the merchant id and campaign priority and a product ad', () => {
  const shop = buildLaunchPlan(
    draft({ objective: 'SALES' }),
    context({ sector: 'متجر إلكتروني', businessName: 'متجر الورد', signals: { conversions_30d: 1, tracking_healthy: true, merchant_center_linked: true } })
  );
  const built = buildLaunchOperations(shop, { ...opCtx, merchantId: 555 });
  const campaign = (built.operations.find((op: any) => op.campaign_operation) as any).campaign_operation.create;
  assert.equal(campaign.advertising_channel_type, 'SHOPPING');
  assert.equal(campaign.shopping_setting.merchant_id, 555);
  assert.equal(campaign.status, 'PAUSED');
  assert.ok(flatten(built.operations).includes('SHOPPING_PRODUCT_ADS'));
});

// ---- executor ------------------------------------------------------------------------------

type Call = { kind: 'query' | 'mutate'; gaql?: string; validateOnly?: boolean; count?: number };

function stubCustomer(options: { timeoutOnLive?: boolean; campaignStatus?: string; failReadback?: boolean; keywordRows?: number } = {}) {
  const calls: Call[] = [];
  const state = { created: false };
  const customer: LaunchCustomer = {
    async query(gaql: string) {
      calls.push({ kind: 'query', gaql });
      if (/SELECT campaign\.name FROM campaign/.test(gaql)) return [{ campaign: { name: 'قديمة' } }];
      if (/campaign\.name = /.test(gaql)) {
        return state.created
          ? [{ campaign: { resourceName: `customers/${CID}/campaigns/777`, campaignBudget: `customers/${CID}/campaignBudgets/888` } }]
          : [];
      }
      if (/campaign_shared_set/.test(gaql) && /WHERE campaign\.resource_name/.test(gaql)) return [];
      const rows = (n: number) => Array.from({ length: n }, () => ({}));
      if (/FROM ad_group WHERE/.test(gaql)) return rows(1);
      if (/FROM ad_group_ad WHERE/.test(gaql)) return rows(1);
      if (/FROM ad_group_criterion WHERE/.test(gaql)) return rows(options.keywordRows ?? 8);
      if (/campaign_criterion\.type = 'KEYWORD'/.test(gaql)) return rows(1);
      if (/campaign_criterion\.type = 'LOCATION'/.test(gaql)) return rows(1);
      if (/FROM campaign WHERE campaign\.resource_name/.test(gaql)) {
        if (options.failReadback) throw new Error('boom');
        return [
          {
            campaign: { status: options.campaignStatus ?? 'PAUSED', networkSettings: { targetSearchNetwork: false, targetContentNetwork: false } },
            campaignBudget: { amountMicros: '100000000' },
          },
        ];
      }
      return [];
    },
    async mutateOperations(operations: unknown[], opts?: { validateOnly?: boolean }) {
      calls.push({ kind: 'mutate', validateOnly: Boolean(opts?.validateOnly), count: operations.length });
      if (opts?.validateOnly) return {};
      state.created = true;
      if (options.timeoutOnLive) {
        const error: any = new Error('timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      const responses = operations.map((op: any, i) => {
        const key = Object.keys(op)[0].replace('_operation', '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        const body: any = Object.values(op)[0];
        const temp = String(body.create?.resource_name ?? '');
        const real = temp.replace(/-\d+$/, String(1000 + i)).replace(/\/-?\d+$/, `/${1000 + i}`);
        return { [`${key}Result`]: { resourceName: real || `customers/${CID}/assets/${i}` } };
      });
      return { mutateOperationResponses: responses };
    },
  };
  return { customer, calls };
}

const deps = (ambiguous = false) => ({ nonce: () => 'abcd1234', isAmbiguous: () => ambiguous });

test('the executor validates first, then runs the live batch, then reads back, and returns a rollback descriptor', async () => {
  const { customer, calls } = stubCustomer();
  const result = await executeLaunch(plan(), customer, CID, deps());
  const mutates = calls.filter((c) => c.kind === 'mutate');
  assert.equal(mutates.length, 2);
  assert.equal(mutates[0].validateOnly, true);
  assert.equal(mutates[1].validateOnly, false);
  assert.equal(mutates[0].count, mutates[1].count);
  assert.ok(calls.findIndex((c) => c === mutates[1]) < calls.length - 1, 'readback queries come after the live mutate');
  assert.equal(result.validate_only, 'passed');
  assert.deepEqual(result.readback.mismatches, [], JSON.stringify(result.readback));
  assert.equal(result.campaign_name, 'عيادات النخبة | بحث');
  const rb = result.rollback_payload;
  assert.equal(rb.reversible, true);
  assert.equal(rb.action_type, 'remove_launched_campaign');
  assert.match(rb.campaign_resource, new RegExp(`^customers/${CID}/campaigns/`));
  assert.ok(rb.resource_names.length >= 2);
  assert.equal(rollbackResourcesScoped(rb as any, CID), true);
  assert.equal(rollbackResourcesScoped(rb as any, '999'), false);
});

test('a name already used in the account is suffixed, never reused', async () => {
  const { customer } = stubCustomer();
  const taken = buildLaunchPlan(draft({ name: 'قديمة' }), context());
  const result = await executeLaunch(taken, customer, CID, deps());
  assert.equal(result.campaign_name, 'قديمة (2)');
});

test('a failed validateOnly stops before any live write', async () => {
  const { customer, calls } = stubCustomer();
  const original = customer.mutateOperations.bind(customer);
  customer.mutateOperations = async (ops, opts) => {
    if (opts?.validateOnly) throw new Error('INVALID_ARGUMENT');
    return original(ops, opts);
  };
  await assert.rejects(executeLaunch(plan(), customer, CID, deps()), /INVALID_ARGUMENT/);
  assert.equal(calls.filter((c) => c.kind === 'mutate' && c.validateOnly === false).length, 0);
});

test('an ambiguous timeout is reconciled by name and still yields a rollback descriptor', async () => {
  const { customer } = stubCustomer({ timeoutOnLive: true });
  const result = await executeLaunch(plan(), customer, CID, deps(true));
  assert.equal(result.reconciled, true);
  assert.equal(result.rollback_payload.campaign_resource, `customers/${CID}/campaigns/777`);
});

test('a non-ambiguous live error is rethrown', async () => {
  const { customer } = stubCustomer({ timeoutOnLive: true });
  await assert.rejects(executeLaunch(plan(), customer, CID, deps(false)), /timeout/);
});

test('a readback that cannot be read never fails a launch that already happened', async () => {
  const { customer } = stubCustomer({ failReadback: true });
  const result = await executeLaunch(plan(), customer, CID, deps());
  assert.equal(result.readback.ok, false);
  assert.ok(result.rollback_payload.campaign_resource);
});

test('a campaign that comes back not PAUSED is forced to PAUSED', async () => {
  const { customer, calls } = stubCustomer({ campaignStatus: 'ENABLED' });
  const result = await executeLaunch(plan(), customer, CID, deps());
  assert.ok(result.readback.mismatches.includes('campaign_status_ENABLED'));
  const last = calls.filter((c) => c.kind === 'mutate').pop();
  assert.equal(last?.count, 1);
});

// ---- rollback ---------------------------------------------------------------------------------

test('the stored rollback is what the generic finalizer persists', async () => {
  const { customer } = stubCustomer();
  const result = await executeLaunch(plan(), customer, CID, deps());
  const stored = finalizeRollbackPayload({ reversible: true, action_type: 'remove_launched_campaign' }, result) as any;
  assert.equal(stored.campaign_resource, result.campaign_resource);
  assert.deepEqual(finalizeRollbackPayload({ reversible: true, action_type: 'remove_launched_campaign' }, {}), {
    reversible: false,
    resource_names: [],
    note: 'created_resources_unavailable',
  });
});

test('rollback removes campaign, link and budget in one atomic batch, and validates first', async () => {
  const batches: Array<{ ops: any[]; validateOnly: boolean }> = [];
  const customer: LaunchCustomer = {
    async query() {
      return [{ campaign: { status: 'PAUSED' } }];
    },
    async mutateOperations(ops, opts) {
      batches.push({ ops: ops as any[], validateOnly: Boolean(opts?.validateOnly) });
      return {};
    },
  };
  const payload = {
    campaign_resource: `customers/${CID}/campaigns/777`,
    budget_resource: `customers/${CID}/campaignBudgets/888`,
    campaign_shared_set_resource: `customers/${CID}/campaignSharedSets/777~55`,
    shared_set_resource: null,
  };
  await executeLaunchRollback(payload, customer, { validateOnly: true });
  await executeLaunchRollback(payload, customer);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].validateOnly, true);
  assert.equal(batches[1].validateOnly, false);
  const removed = batches[1].ops.map((op) => Object.values(op)[0] as any).map((b) => b.remove);
  assert.deepEqual(removed, [payload.campaign_shared_set_resource, payload.campaign_resource, payload.budget_resource]);
});

test('rollback refuses an ENABLED campaign and a malformed or cross-account descriptor', async () => {
  const live: LaunchCustomer = {
    async query() {
      return [{ campaign: { status: 'ENABLED' } }];
    },
    async mutateOperations() {
      throw new Error('must not mutate');
    },
  };
  const good = {
    campaign_resource: `customers/${CID}/campaigns/777`,
    budget_resource: `customers/${CID}/campaignBudgets/888`,
  };
  await assert.rejects(executeLaunchRollback(good, live), /enabled/i);
  await assert.rejects(executeLaunchRollback({ ...good, budget_resource: 'customers/999/campaignBudgets/1' }, live), /more than one account/);
  await assert.rejects(executeLaunchRollback({ ...good, campaign_resource: 'customers/1/adGroups/1' }, live), /malformed/);
});

// ---- follow-up card and preview ------------------------------------------------------------------

test('the build card and the enable card are separate, and the enable card reuses enable_campaign', () => {
  const build = buildCardRow('acc-1', plan());
  assert.equal(build.title, 'ابنِ الحملة موقوفة');
  assert.equal(build.action_payload.operation, 'launch_campaign');
  assert.equal(build.status, 'pending');
  const enable = enableCardRow('acc-1', { campaign_resource: `customers/${CID}/campaigns/777`, campaign_name: 'عيادات' });
  assert.equal(enable.title, 'شغّلها');
  assert.equal(enable.action_payload.operation, 'enable_campaign');
  assert.equal(enable.action_payload.target_id, `customers/${CID}/campaigns/777`);
  assert.notEqual(build.fingerprint, enable.fingerprint);
  const action = withFlag(undefined, () =>
    buildExecutableAction(enable.action_payload, { title: enable.title, description: enable.description }, CID)
  );
  assert.equal(action?.type, 'enable_campaign');
});

function fakeAdmin(existing: any[] = []) {
  const inserted: any[] = [];
  const admin = {
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: async () => ({ data: existing }),
        insert: async (row: any) => {
          inserted.push(row);
          return { error: null };
        },
      };
      return chain;
    },
  };
  return { admin, inserted };
}

test('the enable card is created after a clean build, once, and never after a dirty readback', async () => {
  const good = { campaign_resource: `customers/${CID}/campaigns/777`, campaign_name: 'عيادات', readback: { ok: true } };
  const first = fakeAdmin();
  assert.equal(await createEnableCard(first.admin, { account_id: 'acc-1', action_payload: { params: { plan: plan() } } }, good), true);
  assert.equal(first.inserted.length, 1);
  assert.equal(first.inserted[0].title, 'شغّلها');
  const again = fakeAdmin([{ id: 'x' }]);
  assert.equal(await createEnableCard(again.admin, { account_id: 'acc-1' }, good), true);
  assert.equal(again.inserted.length, 0);
  const dirty = fakeAdmin();
  assert.equal(await createEnableCard(dirty.admin, { account_id: 'acc-1' }, { ...good, readback: { ok: false } }), false);
  assert.equal(dirty.inserted.length, 0);
  assert.equal(await createEnableCard(dirty.admin, { account_id: 'acc-1' }, { campaign_resource: 'nope' }), false);
});

test('the preview model is compact Arabic and states what is off', () => {
  const model = launchPreviewModel(plan());
  assert.equal(model.groups.length, 1);
  assert.ok(model.facts.some((f) => f.label === 'الميزانية اليومية'));
  assert.ok(model.off.some((line) => line.includes('موقوفة')));
  assert.ok(model.off.some((line) => line.includes('شركاء البحث')));
  assert.ok(model.off.some((line) => line.includes('شبكة العرض')));
  assert.ok(model.groups[0].headlines.length <= 3);
});

test('Arabic launch copy has no em or en dashes and no Latin commas', () => {
  const p = plan();
  const strings = [
    ...flatten(launchPreviewModel(p)),
    ...p.warnings_ar,
    ...p.removed_ar,
    p.bidding.note_ar,
    buildCardRow('a', p).description,
    buildCardRow('a', p).title,
    enableCardRow('a', { campaign_resource: `customers/${CID}/campaigns/1`, campaign_name: 'حملة' }).description,
  ];
  for (const text of strings) {
    if (!/[؀-ۿ]/.test(text)) continue;
    assert.ok(!/[–—]/.test(text), `dash in: ${text}`);
    assert.ok(!/[؀-ۿ][^\S\n]*,|,[^\S\n]*[؀-ۿ]/.test(text), `latin comma in: ${text}`);
  }
});

test('region names resolve only to Saudi, enabled, matching suggestions', () => {
  const response = {
    geoTargetConstantSuggestions: [
      { searchTerm: 'الرياض', geoTargetConstant: { resourceName: 'geoTargetConstants/1012045', countryCode: 'SA', status: 'ENABLED', targetType: 'City' } },
      { searchTerm: 'جدة', geoTargetConstant: { resourceName: 'geoTargetConstants/9', countryCode: 'EG', status: 'ENABLED', targetType: 'City' } },
    ],
  };
  assert.deepEqual(pickGeoTargetConstants(['الرياض', 'جدة'], response), { الرياض: 'geoTargetConstants/1012045' });
});
