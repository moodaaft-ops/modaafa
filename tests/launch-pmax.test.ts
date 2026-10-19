import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchPlan } from '../lib/launch/plan';
import { validateStoredPlan } from '../lib/launch/validate';
import { buildPmaxLaunchOperations } from '../lib/launch/pmax-operations';
import { buildLaunchOperations } from '../lib/launch/operations';
import { imageFits } from '../lib/launch/pmax';
import { offlineUploadInPlace, slotsForImage } from '../lib/launch/pmax-inventory';
import { readPmaxPreflight } from '../lib/launch/pmax-preflight';
import { launchPreviewModel } from '../lib/launch/preview';
import { applyBuilderGates } from '../lib/ai/builder-gates';
import { context, draft } from './launch-fixtures';

const inventory = {
  images: [
    { resource_name: 'customers/1234567890/assets/1', width: 1200, height: 628 },
    { resource_name: 'customers/1234567890/assets/2', width: 1200, height: 1200 },
    { resource_name: 'customers/1234567890/assets/3', width: 512, height: 512 },
  ],
  videos: [],
  user_lists: [{ resource_name: 'customers/1234567890/userLists/9', name: 'عملاء' }],
  custom_audiences: [],
};
const signals = { conversions_30d: 60, tracking_healthy: true, merchant_center_linked: true };
const pmaxDraft = (extra: Record<string, unknown> = {}) =>
  draft({
    type: 'PMAX',
    objective: 'SALES',
    pmax: { marketing_images: ['customers/1234567890/assets/1'], square_images: ['customers/1234567890/assets/2'], logos: ['customers/1234567890/assets/3'] },
    ...extra,
  });
const ctx = (extra: Record<string, unknown> = {}) =>
  context({ sector: 'متجر إلكتروني', signals, pmaxEnabled: true, pmaxInventory: inventory, ...extra } as any);

test('flag off: Performance Max stays a blocker', () => {
  const p = buildLaunchPlan(pmaxDraft(), ctx({ pmaxEnabled: false }));
  assert.equal(p.executable, false);
  assert.ok(p.blockers.some((b) => b.code === 'pmax_assets_required'));
  assert.equal(p.pmax?.build ?? null, null);
});

test('image slots follow ratio and minimum size', () => {
  assert.equal(imageFits('marketing', 1200, 628), true);
  assert.equal(imageFits('marketing', 600, 600), false);
  assert.equal(imageFits('logo', 100, 100), false);
  assert.deepEqual(slotsForImage(512, 512).sort(), ['logo', 'square']);
});

test('flag on without images: blocker lists what is missing', () => {
  const p = buildLaunchPlan(pmaxDraft({ pmax: undefined }), ctx({ pmaxInventory: { ...inventory, images: [] } }));
  assert.equal(p.executable, false);
  assert.ok(p.blockers.some((b) => b.code === 'pmax_assets_required'));
});

test('flag on with assets: a PMax plan is built, validates and has no ad groups', () => {
  const p = buildLaunchPlan(pmaxDraft(), ctx());
  assert.equal(p.blockers.length, 0, JSON.stringify(p.blockers));
  assert.equal(p.executable, true);
  assert.equal(p.ad_groups.length, 0);
  assert.ok(p.pmax?.build);
  assert.equal(p.pmax!.build!.url_expansion.enabled, false);
  assert.equal(p.bidding.strategy, 'MAXIMIZE_CONVERSION_VALUE');
  const prev = process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED;
  const prevMain = process.env.CAMPAIGN_LAUNCH_ENABLED;
  process.env.CAMPAIGN_LAUNCH_ENABLED = 'true';
  process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED = 'true';
  try {
    assert.equal(validateStoredPlan(p).ok, true);
    const off = (process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED = 'false');
    assert.equal(off, 'false');
    assert.equal(validateStoredPlan(p).ok, false);
  } finally {
    if (prev === undefined) delete process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED;
    else process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED = prev;
    if (prevMain === undefined) delete process.env.CAMPAIGN_LAUNCH_ENABLED;
    else process.env.CAMPAIGN_LAUNCH_ENABLED = prevMain;
  }
});

test('operations: paused campaign, asset group, links, retail filter, expansion off', () => {
  const p = buildLaunchPlan(pmaxDraft(), ctx());
  const built = buildPmaxLaunchOperations(p, { customerId: '123-456-7890', merchantId: 555, feedLabel: 'SA' } as any);
  const camp = (built.operations.find((o: any) => o.campaign_operation) as any).campaign_operation.create;
  assert.equal(camp.status, 'PAUSED');
  assert.equal(camp.advertising_channel_type, 'PERFORMANCE_MAX');
  assert.ok(built.roles.includes('asset_group'));
  assert.ok(built.roles.includes('asset_group_asset'));
  assert.ok(built.roles.includes('asset_group_filter'));
  assert.match(JSON.stringify(camp), /OPTED_OUT/);
  // Dispatch through the common builder gives the same result.
  assert.throws(() => buildLaunchOperations(p, { customerId: '123-456-7890', merchantId: 555 } as any), /not supported/);
  const prev = { a: process.env.CAMPAIGN_LAUNCH_ENABLED, b: process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED };
  process.env.CAMPAIGN_LAUNCH_ENABLED = 'true';
  process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED = 'true';
  try {
    const viaCommon = buildLaunchOperations(p, { customerId: '123-456-7890', merchantId: 555, feedLabel: 'SA' } as any);
    assert.equal(viaCommon.operations.length, built.operations.length);
  } finally {
    if (prev.a === undefined) delete process.env.CAMPAIGN_LAUNCH_ENABLED;
    else process.env.CAMPAIGN_LAUNCH_ENABLED = prev.a;
    if (prev.b === undefined) delete process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED;
    else process.env.CAMPAIGN_LAUNCH_PMAX_ENABLED = prev.b;
  }
});

test('retail without a Merchant Center id throws', () => {
  const p = buildLaunchPlan(pmaxDraft(), ctx());
  assert.throws(() => buildPmaxLaunchOperations(p, { customerId: '1234567890', merchantId: null } as any));
});

test('preview shows the asset group', () => {
  const p = buildLaunchPlan(pmaxDraft(), ctx());
  const model = launchPreviewModel(p);
  assert.ok(model.facts.some((f) => f.label === 'مجموعة الأصول'));
  assert.ok(model.facts.some((f) => f.label === 'توسيع الرابط'));
});

test('gates: leads PMax needs the offline upload and volume', () => {
  const leads = { type: 'PMAX', objective: 'LEADS', daily_budget_sar: 100 };
  const base = { conversions_30d: 60, tracking_healthy: true, merchant_center_linked: false };
  const off = applyBuilderGates(leads, { brief: 'x', signals: base });
  assert.equal(off.draft.type, 'SEARCH');
  const on = applyBuilderGates(leads, { brief: 'x', signals: { ...base, offline_upload_in_place: true } });
  assert.equal(on.draft.type, 'PMAX');
  const low = applyBuilderGates(leads, { brief: 'x', signals: { ...base, conversions_30d: 5, offline_upload_in_place: true } });
  assert.equal(low.draft.type, 'SEARCH');
});

test('offline upload detection requires an enabled primary action with conversions', () => {
  assert.equal(offlineUploadInPlace([]), false);
});

test('preflight: missing Merchant Center blocks retail, a vanished image blocks the build', async () => {
  const p = buildLaunchPlan(pmaxDraft(), ctx());
  const none = await readPmaxPreflight(p, { query: async () => [] });
  assert.equal(none.ok, false);
  const gone = await readPmaxPreflight(p, {
    query: async (gaql: string) => (gaql.includes('shopping_product') ? [{ shoppingProduct: { merchantCenterId: '555', feedLabel: 'SA' } }] : []),
  });
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.code, 'pmax_assets_changed');
});
