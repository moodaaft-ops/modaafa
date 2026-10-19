import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDemandGenPlan, evaluateDemandGenReadiness, parseYoutubeId, DEMAND_GEN_MIN_DAILY_SAR } from '../lib/demand-gen/plan';
import { buildDemandGenOperations } from '../lib/demand-gen/operations';
import { validateStoredDemandGenPlan } from '../lib/demand-gen/validate';
import { executeDemandGen, validateDemandGenOnly, DemandGenBlockedError, DEMAND_GEN_ROLLBACK_ACTION } from '../lib/demand-gen/execute';
import { executeGrowthRollback } from '../lib/growth/action';
import { readReadiness } from '../lib/growth/readiness';
import { CID, P, healthyHandlers, makeCustomer } from './growth-fixtures';

const site = 'https://shop.example.com';
const input = (over: Record<string, unknown> = {}) => ({
  name: 'ديماند جن تجريبي',
  daily_budget_sar: 100,
  bidding_strategy: 'MAXIMIZE_CLICKS',
  landing_page: `${site}/offer`,
  business_name: 'متجر المثال',
  headlines: ['اكتشف المجموعة الجديدة', 'توصيل سريع لكل المدن', 'جودة تستاهل'],
  long_headlines: ['تسوق الآن واستلم طلبك خلال يومين لين باب بيتك'],
  descriptions: ['منتجات أصلية بضمان واسترجاع خلال 14 يوم', 'اطلب اليوم وادفع عند الاستلام'],
  marketing_images: [`${P}/assets/1`],
  square_images: [`${P}/assets/2`],
  logo_images: [`${P}/assets/3`],
  ...over,
});
const ctx = { website: site, businessName: 'متجر المثال' };
const plan = (over: Record<string, unknown> = {}) => buildDemandGenPlan(input(over) as any, ctx);
const nonce = () => 'abcd1234';

function handlers(extra: any[] = []) {
  return [
    ...extra,
    {
      match: /FROM asset WHERE asset\.resource_name IN/,
      rows: [
        { asset: { resourceName: `${P}/assets/1`, type: 'IMAGE', imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 628 } } } },
        { asset: { resourceName: `${P}/assets/2`, type: 'IMAGE', imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 1200 } } } },
        { asset: { resourceName: `${P}/assets/3`, type: 'IMAGE', imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 1200 } } } },
      ],
    },
    { match: /SELECT campaign\.name FROM campaign/, rows: [] },
    {
      match: /campaign\.advertising_channel_type, campaign_budget\.amount_micros FROM campaign/,
      rows: [{ campaign: { resourceName: `${P}/campaigns/501`, status: 'PAUSED', advertisingChannelType: 'DEMAND_GEN' }, campaignBudget: { amountMicros: 100_000_000 } }],
    },
    { match: /FROM ad_group WHERE campaign/, rows: [{ adGroup: { resourceName: `${P}/adGroups/1` } }] },
    { match: /FROM ad_group_ad WHERE/, rows: [{ adGroupAd: { resourceName: `${P}/adGroupAds/1~2` } }] },
    { match: /ad_group_criterion\.type = 'LOCATION'/, rows: [{ x: 1 }] },
    { match: /ad_group_criterion\.type = 'LANGUAGE'/, rows: [{ x: 1 }] },
    ...healthyHandlers(),
  ];
}

const names = (ops: any[]) =>
  ops.map((op) => {
    const key = Object.keys(op)[0];
    if (key === 'campaign_budget_operation') return `${P}/campaignBudgets/900`;
    if (key === 'campaign_operation') return `${P}/campaigns/501`;
    return `${P}/${key}/${Math.floor(Math.random() * 1e6)}`;
  });

// ---- plan ---------------------------------------------------------------------

test('a complete input builds an executable PAUSED-only plan with Display closed', () => {
  const p = plan();
  assert.equal(p.executable, true, JSON.stringify(p.blockers));
  assert.equal(p.channels.display, false);
  assert.equal(p.blockers.length, 0);
});

test('the landing page must be on the merchant own site', () => {
  const p = plan({ landing_page: 'https://other-site.example.org/x' });
  assert.equal(p.executable, false);
  assert.ok(p.blockers.length > 0);
});

test('a budget under the product floor is a blocker', () => {
  const p = plan({ daily_budget_sar: DEMAND_GEN_MIN_DAILY_SAR - 1 });
  assert.equal(p.executable, false);
});

test('copy over the limits or with phone numbers is refused, not trimmed', () => {
  const p = plan({ headlines: ['ا'.repeat(60), 'اتصل 0501234567', 'عنوان ثالث', 'اكتشف المجموعة الجديدة'] });
  assert.ok(!p.copy.headlines.some((h) => h.length > 30 || /0501234567/.test(h)));
  assert.ok(p.removed_ar.length >= 2);
  assert.equal(plan({ headlines: ['ا'.repeat(60), 'اتصل 0501234567'] }).executable, false, 'too few valid headlines left');
});

test('a logo is required and the image lists need the right resource scope', () => {
  assert.equal(plan({ logo_images: [] }).executable, false);
  assert.equal(plan({ marketing_images: ['customers/999/assets/1'] }).executable, true, 'scope is checked at validation with the account id');
});

test('YouTube ids are parsed from watch, short and youtu.be links and refused otherwise', () => {
  assert.equal(parseYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYoutubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYoutubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYoutubeId('https://evil.example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYoutubeId('not a video'), null);
});

test('guardrails: unhealthy tracking, non-SAR, and missing history for the strategy all block', () => {
  const p = plan({ bidding_strategy: 'TARGET_CPA', target_cpa_sar: 30 });
  const codes = (r: any) => evaluateDemandGenReadiness(p, r).map((b) => b.code);
  assert.ok(codes({ verdict: 'broken_recently', issues_ar: ['x'], conversions30d: 200, currency: 'SAR' }).includes('tracking_not_healthy'));
  assert.ok(codes({ verdict: null, issues_ar: [], conversions30d: 200, currency: 'SAR' }).includes('tracking_not_healthy'));
  assert.ok(codes({ verdict: 'healthy', issues_ar: [], conversions30d: 200, currency: 'USD' }).includes('not_sar'));
  assert.ok(codes({ verdict: 'healthy', issues_ar: [], conversions30d: 12, currency: 'SAR' }).includes('strategy_history_missing'));
  assert.deepEqual(codes({ verdict: 'healthy', issues_ar: [], conversions30d: 80, currency: 'SAR' }), []);
});

test('readiness: an unreadable conversion action list is unknown, never healthy', async () => {
  const stub = makeCustomer([{ match: /FROM conversion_action/, rows: () => { throw new Error('boom'); } }, ...healthyHandlers().slice(1)]);
  const r = await readReadiness(stub);
  assert.equal(r.verdict, null);
});

// ---- operations -----------------------------------------------------------------

test('operations: budget, then campaign PAUSED DEMAND_GEN, ad group, targeting, then the ad', () => {
  const built = buildDemandGenOperations(plan(), { customerId: CID, campaignName: 'ديماند جن تجريبي', budgetName: 'b', audienceName: 'a' });
  assert.deepEqual(built.roles.slice(0, 3), ['budget', 'campaign', 'ad_group']);
  assert.equal(built.roles[built.roles.length - 1], 'ad');
  const campaign = (built.operations[1] as any).campaign_operation.create;
  assert.equal(campaign.status, 'PAUSED');
  assert.equal(campaign.advertising_channel_type, 'DEMAND_GEN');
  assert.notEqual(campaign.status, 'ENABLED');
  assert.ok(!JSON.stringify(built.operations[0]).includes('ENABLED'));
});

test('operations: a YouTube video id builds the video asset and a video responsive ad', () => {
  const p = plan({ youtube_video: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(p.executable, true, JSON.stringify(p.blockers));
  const built = buildDemandGenOperations(p, { customerId: CID, campaignName: 'x', budgetName: 'b', audienceName: 'a' });
  assert.ok(built.roles.includes('asset'));
  assert.ok(JSON.stringify(built.operations).includes('demand_gen_video_responsive_ad'));
});

test('operations: an existing YouTube asset is linked, not created again', () => {
  const p = plan({ youtube_video: 'dQw4w9WgXcQ' });
  const built = buildDemandGenOperations(p, { customerId: CID, campaignName: 'x', budgetName: 'b', audienceName: 'a', existingVideoAsset: `${P}/assets/55` });
  assert.ok(!built.roles.includes('asset'));
  assert.ok(JSON.stringify(built.operations).includes(`${P}/assets/55`));
});

test('operations: a user list builds an audience and attaches it to the ad group', () => {
  const p = plan({ user_lists: [`${P}/userLists/9`] });
  const built = buildDemandGenOperations(p, { customerId: CID, campaignName: 'x', budgetName: 'b', audienceName: 'a' });
  assert.ok(built.roles.includes('audience'));
  assert.ok(built.roles.includes('audience_criterion'));
});

test('a plan with blockers cannot be built', () => {
  assert.throws(() => buildDemandGenOperations(plan({ daily_budget_sar: 1 }), { customerId: CID, campaignName: 'x', budgetName: 'b', audienceName: 'a' }));
});

// ---- stored plan ----------------------------------------------------------------

test('stored plan: round-trips, and tampering is rejected', () => {
  const p = plan();
  assert.equal(validateStoredDemandGenPlan(JSON.parse(JSON.stringify(p)), CID).ok, true);
  const bad = (mut: (x: any) => void) => {
    const x = JSON.parse(JSON.stringify(p));
    mut(x);
    return validateStoredDemandGenPlan(x, CID).ok;
  };
  assert.equal(bad((x) => { x.channels.display = true; }), false);
  assert.equal(bad((x) => { x.images.marketing = ['customers/999/assets/1']; }), false);
  assert.equal(bad((x) => { x.budget.daily_sar = 999999; }), false);
  assert.equal(bad((x) => { x.audience.user_lists = ['customers/999/userLists/1']; }), false);
  assert.equal(bad((x) => { x.executable = true; x.blockers = [{ code: 'x', message_ar: 'x' }]; }), false);
  assert.equal(validateStoredDemandGenPlan(null).ok, false);
});

// ---- execution ------------------------------------------------------------------

test('execute: validateOnly first, then the live mutate, readback ok, rollback descriptor scoped', async () => {
  const stub = makeCustomer(handlers(), { mutateNames: names });
  const result = await executeDemandGen(plan(), stub, CID, { nonce, isAmbiguous: () => false });
  assert.equal(stub.mutates.length, 2);
  assert.equal(stub.mutates[0].validateOnly, true);
  assert.equal(stub.mutates[1].validateOnly, false);
  assert.equal(result.readback.ok, true, JSON.stringify(result.readback));
  assert.equal(result.rollback_payload.action_type, DEMAND_GEN_ROLLBACK_ACTION);
  assert.ok(result.rollback_payload.resource_names.every((n) => n.startsWith(`${P}/`)));
});

test('execute: validateOnly failure stops before any live write', async () => {
  const stub = makeCustomer(handlers());
  const original = stub.mutateOperations.bind(stub);
  stub.mutateOperations = async (ops: any[], o?: any) => {
    if (o?.validateOnly) throw new Error('INVALID_ARGUMENT');
    return original(ops, o);
  };
  await assert.rejects(() => executeDemandGen(plan(), stub, CID, { nonce, isAmbiguous: () => false }), /INVALID_ARGUMENT/);
  assert.equal(stub.mutates.filter((m: any) => !m.validateOnly).length, 0);
});

test('execute: unhealthy tracking refuses the build with blockers', async () => {
  const stub = makeCustomer(handlers().filter((h: any) => !String(h.match).includes('conversion_action')).concat([{ match: /FROM conversion_action/, rows: [] }]));
  await assert.rejects(() => executeDemandGen(plan(), stub, CID, { nonce, isAmbiguous: () => false }), DemandGenBlockedError);
  assert.equal(stub.mutates.length, 0);
});

test('execute: a campaign that comes back ENABLED is paused again', async () => {
  const hs = handlers().map((h: any) =>
    String(h.match).includes('campaign_budget')
      ? { ...h, rows: [{ campaign: { resourceName: `${P}/campaigns/501`, status: 'ENABLED', advertisingChannelType: 'DEMAND_GEN' }, campaignBudget: { amountMicros: 100_000_000 } }] }
      : h
  );
  const stub = makeCustomer(hs, { mutateNames: names });
  const result = await executeDemandGen(plan(), stub, CID, { nonce, isAmbiguous: () => false });
  const last = stub.mutates[stub.mutates.length - 1];
  assert.equal(last.validateOnly, false);
  assert.equal(last.ops[0].campaign_operation.update.status, 'PAUSED');
  assert.equal(result.readback.ok, false);
});

test('execute: an ambiguous timeout is reconciled by campaign name', async () => {
  const hs = [
    { match: /SELECT campaign\.resource_name, campaign\.campaign_budget FROM campaign WHERE campaign\.name/, rows: [{ campaign: { resourceName: `${P}/campaigns/501`, campaignBudget: `${P}/campaignBudgets/900` } }] },
    ...handlers(),
  ];
  const stub = makeCustomer(hs, { failLive: () => new Error('ETIMEDOUT') });
  const result = await executeDemandGen(plan(), stub, CID, { nonce, isAmbiguous: () => true });
  assert.equal(result.reconciled, true);
  assert.equal(result.campaign_resource, `${P}/campaigns/501`);
});

test('validateDemandGenOnly never makes a live call', async () => {
  const stub = makeCustomer(handlers());
  await validateDemandGenOnly(plan(), stub, CID, { nonce });
  assert.ok(stub.mutates.length >= 1);
  assert.ok(stub.mutates.every((m: any) => m.validateOnly));
});

test('rollback: removes the campaign and budget through the launcher undo, and refuses while enabled', async () => {
  const payload = { action_type: DEMAND_GEN_ROLLBACK_ACTION, campaign_resource: `${P}/campaigns/501`, budget_resource: `${P}/campaignBudgets/900`, campaign_shared_set_resource: null, shared_set_resource: null };
  const paused = makeCustomer([{ match: /SELECT campaign\.status/, rows: [{ campaign: { status: 'PAUSED' } }] }]);
  await executeGrowthRollback(payload, paused);
  assert.equal(paused.mutates.length, 1);
  assert.equal(paused.mutates[0].ops[0].campaign_operation.remove, payload.campaign_resource);
  const enabled = makeCustomer([{ match: /SELECT campaign\.status/, rows: [{ campaign: { status: 'ENABLED' } }] }]);
  await assert.rejects(() => executeGrowthRollback(payload, enabled), /enabled/i);
});
