import assert from 'node:assert/strict';
import test from 'node:test';

import { isExtendedActionsEnabled } from '../lib/ai/extended-actions/flag';
import {
  APPLY_SUPPORTED_RECOMMENDATION_TYPES,
  CAMPAIGN_TARGETING_FAMILY,
  EXTENDED_OPERATIONS,
  isExtendedOperation,
} from '../lib/ai/extended-actions/types';
import { cleanScheduleSlots, pctToModifier, validateExtendedPayload } from '../lib/ai/extended-actions/validate';
import { planAdSchedule, scheduleCriteriaFromRows } from '../lib/ai/extended-actions/schedule';
import { prepareExtendedAction, ExtendedPreflightError } from '../lib/ai/extended-actions/preflight';
import {
  buildMutateOperations,
  buildRollbackOperations,
  executeExtendedAction,
  finalizeExtendedRollback,
} from '../lib/ai/extended-actions/execute';
import { checkExtendedGuardrails } from '../lib/ai/extended-actions/guardrails';
import { readbackExtendedAction } from '../lib/ai/extended-actions/readback';
import { extendedPreviewRows } from '../lib/ai/extended-actions/preview';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { buildExecutableAction } from '../lib/ai/executable-action';
import { finalizeRollbackPayload } from '../lib/ai/execution-result';
import { EXTENDED_OPERATION_LABELS_AR, OPERATION_LABELS_AR } from '../lib/ai/operation-labels';
import { MEASURED_ACTION_TYPES } from '../lib/ai/impact';
import { categoryForAction } from '../lib/ai/action-fingerprint';
import { prepareActionForExecution } from '../lib/ai/execution-preflight';
import { executeAction, executeRollback, type OptimizerAction } from '../lib/ai/optimizer-agent';

const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/555`;
const OTHER_CAMPAIGN = `customers/9999999999/campaigns/555`;
const SHARED = `customers/${CID}/sharedSets/77`;
const REC = `customers/${CID}/recommendations/abc`;
const SUB = `customers/${CID}/recommendationSubscriptions/SITELINK_ASSET`;
const GEO = 'geoTargetConstants/1012045';

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.EXTENDED_ACTIONS_ENABLED;
  if (value === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
  else process.env.EXTENDED_ACTIONS_ENABLED = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
    else process.env.EXTENDED_ACTIONS_ENABLED = old;
  }
}

async function withFlagAsync<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = process.env.EXTENDED_ACTIONS_ENABLED;
  if (value === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
  else process.env.EXTENDED_ACTIONS_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
    else process.env.EXTENDED_ACTIONS_ENABLED = old;
  }
}

const slot = (day: string, from: number, to: number, bid_modifier = 1) => ({
  day_of_week: day,
  start_hour: from,
  start_minute: 'ZERO',
  end_hour: to,
  end_minute: 'ZERO',
  bid_modifier,
});

const deps = {
  async filterNegativeKeywordBatch(_c: any, _campaign: string, _m: string, candidates: string[]) {
    return {
      keep: candidates.filter((c) => c !== 'blocked'),
      dropped: candidates.filter((c) => c === 'blocked').map((text) => ({ text, reason: 'blocks_converting_search_term' })),
    };
  },
  async readSevenDayMetrics() {
    return { cost: 10, clicks: 5, conversions: 1, conversion_value: 20 };
  },
  normalizeKeywordText: (v: string) => v.trim().toLowerCase(),
};

type FakeOptions = {
  bidding?: string;
  channel?: string;
  geoType?: string;
  search?: boolean;
  content?: boolean;
  schedule?: any[];
  devices?: any[];
  locations?: any[];
  lists?: any[];
  subs?: any[];
  recommendation?: any;
  attached?: string[];
};

function fakeCustomer(options: FakeOptions = {}) {
  const queries: string[] = [];
  const mutations: any[] = [];
  const customer: any = {
    queries,
    mutations,
    credentials: { customer_id: CID },
    async query(gaql: string) {
      queries.push(gaql);
      if (/FROM campaign_criterion/.test(gaql) && gaql.includes("= 'AD_SCHEDULE'")) return options.schedule ?? [];
      if (/FROM campaign_criterion/.test(gaql) && gaql.includes("= 'DEVICE'")) return options.devices ?? [];
      if (/FROM campaign_criterion/.test(gaql) && gaql.includes("= 'LOCATION'")) return options.locations ?? [];
      if (/FROM campaign\s+WHERE campaign\.resource_name/.test(gaql)) {
        return [
          {
            campaign: {
              status: 'ENABLED',
              advertisingChannelType: options.channel ?? 'SEARCH',
              biddingStrategyType: options.bidding ?? 'MANUAL_CPC',
              geoTargetTypeSetting: { positiveGeoTargetType: options.geoType ?? 'PRESENCE_OR_INTEREST' },
              networkSettings: { targetSearchNetwork: options.search ?? true, targetContentNetwork: options.content ?? true },
            },
          },
        ];
      }
      if (/FROM shared_set/.test(gaql)) return options.lists ?? [];
      if (/FROM campaign_shared_set/.test(gaql)) return (options.attached ?? []).map((c) => ({ campaignSharedSet: { campaign: c } }));
      if (/FROM recommendation_subscription/.test(gaql)) return options.subs ?? [];
      if (/FROM recommendation\b/.test(gaql)) return options.recommendation ? [{ recommendation: options.recommendation }] : [];
      return [];
    },
    async mutateOperations(ops: any[], opts?: any) {
      mutations.push({ ops, opts });
      return { results: ops.map((_, i) => ({ resourceName: `customers/${CID}/created/${i}` })) };
    },
    recommendations: {
      async apply(ops: any[]) {
        mutations.push({ apply: ops });
        return { results: [] };
      },
      async dismiss(ops: any[]) {
        mutations.push({ dismiss: ops });
        return { results: [] };
      },
    },
  };
  return customer;
}

const scheduleRow = (id: number, day: string, from: number, to: number, mod = 1) => ({
  campaignCriterion: {
    resourceName: `customers/${CID}/campaignCriteria/555~${id}`,
    bidModifier: mod,
    adSchedule: { dayOfWeek: day, startHour: from, startMinute: 'ZERO', endHour: to, endMinute: 'ZERO' },
  },
});

function act(type: string, params: Record<string, unknown>, target = CAMPAIGN): OptimizerAction {
  return { type, target_id: target, params, reason_ar: 'x', reason_en: 'x' } as OptimizerAction;
}

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

test('flag is on only for the exact string true', () => {
  assert.equal(isExtendedActionsEnabled({}), false);
  assert.equal(isExtendedActionsEnabled({ EXTENDED_ACTIONS_ENABLED: 'false' }), false);
  assert.equal(isExtendedActionsEnabled({ EXTENDED_ACTIONS_ENABLED: '1' }), false);
  assert.equal(isExtendedActionsEnabled({ EXTENDED_ACTIONS_ENABLED: 'TRUE' }), false);
  assert.equal(isExtendedActionsEnabled({ EXTENDED_ACTIONS_ENABLED: 'true' }), true);
});

test('flag off: extended operations are not executable and have no tool surface', () => {
  withFlag(undefined, () => {
    for (const op of EXTENDED_OPERATIONS) {
      assert.equal(
        buildExecutableAction({ operation: op, target_id: CAMPAIGN, params: { campaign_resource: CAMPAIGN } }, { title: 't' }, CID),
        null
      );
    }
  });
});

test('flag off: execute and prepare refuse extended types; undo of an applied change is not gated', async () => {
  await withFlagAsync(undefined, async () => {
    await assert.rejects(executeAction(act('set_network_settings', {}), fakeCustomer()), /disabled/);
    await assert.rejects(prepareActionForExecution(act('set_network_settings', {}), fakeCustomer()), /disabled/);
    // A rollback only reverses a change the merchant already approved; turning the
    // flag off must not strand it (REVIEW.md). A malformed descriptor still fails.
    await assert.rejects(
      executeRollback({ action_type: 'ext_restore_campaign_fields' }, fakeCustomer()),
      (error: Error) => !/disabled/.test(error.message)
    );
  });
});

test('every extended operation has an Arabic label without dashes or Latin commas', () => {
  for (const op of EXTENDED_OPERATIONS) {
    const label = EXTENDED_OPERATION_LABELS_AR[op];
    assert.ok(label, op);
    assert.equal(OPERATION_LABELS_AR[op], label);
    assert.doesNotMatch(label, /[–—,]/);
  }
});

test('measured and categorised', () => {
  for (const op of ['set_ad_schedule', 'set_device_bid_modifier', 'exclude_location', 'set_location_bid_modifier', 'set_geo_target_type', 'set_network_settings']) {
    assert.ok(MEASURED_ACTION_TYPES.includes(op), op);
    assert.equal(categoryForAction(op), 'targeting');
  }
  assert.equal(categoryForAction('create_shared_negative_list'), 'keywords');
  assert.equal(isExtendedOperation('pause_campaign'), false);
});

// ---------------------------------------------------------------------------
// Payload validators
// ---------------------------------------------------------------------------

test('validate: ad schedule accepts clean slots and rejects overlap, bad hours and foreign campaigns', () => {
  const ok = validateExtendedPayload('set_ad_schedule', CAMPAIGN, { campaign_resource: CAMPAIGN, slots: [slot('MONDAY', 9, 17, 1.2)] }, CID);
  assert.equal(ok.ok, true);
  const bad = (slots: unknown, campaign = CAMPAIGN) =>
    validateExtendedPayload('set_ad_schedule', campaign, { campaign_resource: campaign, slots }, CID);
  assert.equal(bad([slot('MONDAY', 9, 17), slot('MONDAY', 16, 20)]).ok, false);
  assert.equal(bad([slot('MONDAY', 17, 9)]).ok, false);
  assert.equal(bad([slot('FUNDAY', 9, 17)]).ok, false);
  assert.equal(bad([slot('MONDAY', 9, 25)]).ok, false);
  assert.equal(bad([slot('MONDAY', 9, 17, 2.5)]).ok, false);
  assert.equal(bad([]).ok, false);
  assert.equal(bad('nope').ok, false);
  assert.equal(bad([slot('MONDAY', 9, 17)], OTHER_CAMPAIGN).ok, false);
  const seven = Array.from({ length: 7 }, (_, i) => slot('MONDAY', i * 3, i * 3 + 1));
  assert.equal(cleanScheduleSlots(seven), null);
});

test('validate: payload never carries resolved or unknown keys', () => {
  const r = validateExtendedPayload(
    'set_device_bid_modifier',
    CAMPAIGN,
    { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.8, resolved: { evil: true }, extra: 1 },
    CID
  );
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(Object.keys(r.params).sort(), ['bid_modifier', 'campaign_resource', 'device']);
});

test('validate: device modifier bounds, 0 excludes, no-op rejected', () => {
  const v = (extra: Record<string, unknown>) =>
    validateExtendedPayload('set_device_bid_modifier', CAMPAIGN, { campaign_resource: CAMPAIGN, device: 'MOBILE', ...extra }, CID);
  assert.equal(v({ bid_modifier: 0 }).ok, true);
  assert.equal(v({ bid_modifier: 0.5 }).ok, true);
  assert.equal(v({ bid_modifier: 1.5 }).ok, true);
  assert.equal(v({ bid_modifier: 0.4 }).ok, false);
  assert.equal(v({ bid_modifier: 1.6 }).ok, false);
  assert.equal(v({ bid_modifier: 1 }).ok, false);
  assert.equal(v({ bid_modifier: 'x' }).ok, false);
  assert.equal(
    validateExtendedPayload('set_device_bid_modifier', CAMPAIGN, { campaign_resource: CAMPAIGN, device: 'CONNECTED_TV', bid_modifier: 0.8 }, CID).ok,
    false
  );
  assert.equal(pctToModifier(-20), 0.8);
});

test('validate: locations need a geo constant, location modifier cannot be 0', () => {
  assert.equal(validateExtendedPayload('exclude_location', CAMPAIGN, { campaign_resource: CAMPAIGN, geo_target_constant: GEO }, CID).ok, true);
  assert.equal(validateExtendedPayload('exclude_location', CAMPAIGN, { campaign_resource: CAMPAIGN, geo_target_constant: 'Riyadh' }, CID).ok, false);
  assert.equal(validateExtendedPayload('exclude_location', CAMPAIGN, { campaign_resource: CAMPAIGN, geo_target_constant: "geoTargetConstants/1'" }, CID).ok, false);
  const mod = (bid_modifier: unknown) =>
    validateExtendedPayload('set_location_bid_modifier', CAMPAIGN, { campaign_resource: CAMPAIGN, geo_target_constant: GEO, bid_modifier }, CID);
  assert.equal(mod(1.2).ok, true);
  assert.equal(mod(0).ok, false);
  assert.equal(mod(1).ok, false);
});

test('validate: geo type and networks', () => {
  const geo = (positive_geo_target_type: string) =>
    validateExtendedPayload('set_geo_target_type', CAMPAIGN, { campaign_resource: CAMPAIGN, positive_geo_target_type }, CID);
  assert.equal(geo('PRESENCE').ok, true);
  assert.equal(geo('PRESENCE_OR_INTEREST').ok, true);
  assert.equal(geo('SEARCH_INTEREST').ok, false);
  const net = (extra: Record<string, unknown>) =>
    validateExtendedPayload('set_network_settings', CAMPAIGN, { campaign_resource: CAMPAIGN, ...extra }, CID);
  assert.equal(net({ target_search_network: false, target_content_network: false }).ok, true);
  assert.equal(net({ target_search_network: true }).ok, false);
  assert.equal(net({}).ok, false);
});

test('validate: shared lists', () => {
  const create = (extra: Record<string, unknown>) =>
    validateExtendedPayload(
      'create_shared_negative_list',
      '',
      { name: 'قائمة', keywords: [{ text: 'مجاني', match_type: 'PHRASE' }], campaign_resources: [CAMPAIGN], ...extra },
      CID
    );
  assert.equal(create({}).ok, true);
  assert.equal(create({ name: '' }).ok, false);
  assert.equal(create({ keywords: [] }).ok, false);
  assert.equal(create({ keywords: [{ text: 'a', match_type: 'BROAD' }] }).ok, false);
  assert.equal(create({ campaign_resources: [OTHER_CAMPAIGN] }).ok, false);
  assert.equal(create({ keywords: Array.from({ length: 51 }, (_, i) => ({ text: `k${i}`, match_type: 'PHRASE' })) }).ok, false);
  assert.equal(
    validateExtendedPayload('add_shared_negative_keywords', SHARED, { shared_set_resource: SHARED, keywords: [{ text: 'x', match_type: 'EXACT' }] }, CID).ok,
    true
  );
  assert.equal(
    validateExtendedPayload('attach_shared_negative_list', SHARED, { shared_set_resource: `customers/9999999999/sharedSets/1`, campaign_resources: [CAMPAIGN] }, CID).ok,
    false
  );
});

test('validate: recommendations and subscriptions', () => {
  const apply = (type: string, resource = REC) =>
    validateExtendedPayload('apply_google_recommendation', resource, { recommendation_resource: resource, recommendation_type: type }, CID);
  for (const type of APPLY_SUPPORTED_RECOMMENDATION_TYPES) assert.equal(apply(type).ok, true);
  assert.equal(apply('CAMPAIGN_BUDGET').ok, false);
  assert.equal(apply('SITELINK_ASSET', `customers/9999999999/recommendations/abc`).ok, false);
  assert.equal(
    validateExtendedPayload('dismiss_google_recommendation', REC, { recommendation_resource: REC, recommendation_type: 'CAMPAIGN_BUDGET' }, CID).ok,
    true
  );
  assert.equal(validateExtendedPayload('pause_auto_apply', '', { subscription_resources: [SUB] }, CID).ok, true);
  assert.equal(validateExtendedPayload('pause_auto_apply', '', { subscription_resources: [] }, CID).ok, false);
  assert.equal(validateExtendedPayload('pause_auto_apply', '', { subscription_resources: ['customers/1/x'] }, CID).ok, false);
});

test('buildExecutableAction (flag on) returns canonical payloads and null for bad ones', () => {
  withFlag('true', () => {
    const good = buildExecutableAction(
      { operation: 'set_network_settings', target_id: CAMPAIGN, params: { campaign_resource: CAMPAIGN, target_search_network: false, junk: 1 } },
      { title: 't', description: 'd' },
      CID
    );
    assert.ok(good);
    assert.deepEqual(good!.params, { campaign_resource: CAMPAIGN, target_search_network: false });
    assert.equal(
      buildExecutableAction({ operation: 'set_network_settings', target_id: OTHER_CAMPAIGN, params: { campaign_resource: OTHER_CAMPAIGN, target_search_network: false } }, { title: 't' }, CID),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// Ad schedule planner
// ---------------------------------------------------------------------------

test('planAdSchedule keeps uncovered hours serving unless restricted', () => {
  const requested = cleanScheduleSlots([slot('MONDAY', 9, 17, 1.2)])!;
  const open = planAdSchedule([], requested, false);
  assert.ok(open.ok);
  if (open.ok) {
    // 9-17 at 1.2 plus 0-9 and 17-24 at 1, so Monday is covered end to end.
    assert.equal(open.plan.creates.filter((c) => c.day_of_week === 'MONDAY').length, 3);
    assert.ok(open.plan.coverage_minutes >= 24 * 60 * 7);
  }
  const closed = planAdSchedule([], requested, true);
  assert.ok(closed.ok);
  if (closed.ok) {
    assert.equal(closed.plan.creates.length, 1);
    assert.equal(closed.plan.coverage_minutes, 8 * 60);
  }
});

test('planAdSchedule is a no-op when nothing changes and updates modifiers in place', () => {
  const existing = scheduleCriteriaFromRows([scheduleRow(1, 'MONDAY', 9, 17, 1)])!;
  const same = planAdSchedule(existing, cleanScheduleSlots([slot('MONDAY', 9, 17, 1)])!, true);
  assert.deepEqual(same.ok ? null : same.code, 'no_change');
  const changed = planAdSchedule(existing, cleanScheduleSlots([slot('MONDAY', 9, 17, 1.3)])!, true);
  assert.ok(changed.ok);
  if (changed.ok) {
    assert.equal(changed.plan.updates.length, 1);
    assert.equal(changed.plan.updates[0].bid_modifier, 1.3);
    assert.equal(changed.plan.updates[0].previous_modifier, 1);
    assert.equal(changed.plan.creates.length, 0);
    assert.equal(changed.plan.removes.length, 0);
  }
  assert.equal(scheduleCriteriaFromRows([{ campaignCriterion: { resourceName: 'x' } }]), null);
});

// ---------------------------------------------------------------------------
// Preflight, operation builders, rollback
// ---------------------------------------------------------------------------

test('device modifier: create path builds a create op and a rollback that removes the created criterion', async () => {
  const customer = fakeCustomer({ devices: [] });
  const prepared = await prepareExtendedAction(
    act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.8 }),
    customer,
    deps
  );
  const ops = buildMutateOperations(prepared.action, customer);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    campaign_criterion_operation: { create: { campaign: CAMPAIGN, bid_modifier: 0.8, device: { type: 'MOBILE' } } },
  });
  assert.equal(prepared.measurement?.level, 'campaign');
  assert.equal(prepared.measurement?.resource, CAMPAIGN);

  const result = await executeExtendedAction(prepared.action, customer, { validateOnly: true });
  assert.equal(customer.mutations[0].opts.validateOnly, true);
  const rollback = finalizeExtendedRollback(prepared.rollbackPayload, result);
  assert.deepEqual(rollback.remove_criteria, [`customers/${CID}/created/0`]);
  assert.ok(rollbackResourcesScoped(rollback, CID));
  assert.deepEqual(buildRollbackOperations(rollback), [
    { campaign_criterion_operation: { remove: `customers/${CID}/created/0` } },
  ]);
});

test('device modifier: update path stores the old value and restores it', async () => {
  const existing = {
    campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/555~30001`, bidModifier: 1.1, device: { type: 'MOBILE' } },
  };
  const customer = fakeCustomer({ devices: [existing] });
  const prepared = await prepareExtendedAction(
    act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.7 }),
    customer,
    deps
  );
  const [op] = buildMutateOperations(prepared.action, customer) as any[];
  assert.deepEqual(op.campaign_criterion_operation.update, {
    resource_name: `customers/${CID}/campaignCriteria/555~30001`,
    bid_modifier: 0.7,
  });
  assert.equal(op.campaign_criterion_operation.update_mask, 'bidModifier');
  const rollback = prepared.rollbackPayload as any;
  assert.deepEqual(rollback.restore_modifiers, [{ resource_name: `customers/${CID}/campaignCriteria/555~30001`, bid_modifier: 1.1 }]);
  const [back] = buildRollbackOperations(rollback) as any[];
  assert.equal(back.campaign_criterion_operation.update.bid_modifier, 1.1);
  assert.ok(rollbackResourcesScoped(rollback, CID));
});

test('modifier on a Smart Bidding campaign is refused, opt-out is not', async () => {
  const smart = fakeCustomer({ bidding: 'MAXIMIZE_CONVERSIONS' });
  await assert.rejects(
    prepareExtendedAction(act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.8 }), smart, deps),
    (e: any) => e instanceof ExtendedPreflightError && e.code === 'smart_bidding_ignores_modifier'
  );
  await assert.rejects(
    prepareExtendedAction(act('set_location_bid_modifier', { campaign_resource: CAMPAIGN, geo_target_constant: GEO, bid_modifier: 1.2 }), smart, deps),
    /smart_bidding/
  );
  await assert.rejects(
    prepareExtendedAction(act('set_ad_schedule', { campaign_resource: CAMPAIGN, slots: [slot('MONDAY', 9, 17, 1.2)], restrict_to_slots: false }), smart, deps),
    /smart_bidding/
  );
  const optOut = await prepareExtendedAction(
    act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'TABLET', bid_modifier: 0 }),
    smart,
    deps
  );
  assert.ok(optOut.action);
});

test('excluding every device is refused', async () => {
  const devices = ['DESKTOP', 'TABLET'].map((d, i) => ({
    campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/555~4000${i}`, bidModifier: 0, device: { type: d } },
  }));
  await assert.rejects(
    prepareExtendedAction(act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0 }), fakeCustomer({ devices }), deps),
    /all_devices_excluded/
  );
});

test('ad schedule: operations are removes, updates, then creates; rollback restores and removes', async () => {
  const customer = fakeCustomer({
    schedule: [scheduleRow(1, 'MONDAY', 9, 17, 1), scheduleRow(2, 'TUESDAY', 8, 12, 1)],
  });
  const prepared = await prepareExtendedAction(
    act('set_ad_schedule', {
      campaign_resource: CAMPAIGN,
      slots: [slot('MONDAY', 9, 17, 1.3), slot('WEDNESDAY', 10, 14, 0.8)],
      restrict_to_slots: true,
    }),
    customer,
    deps
  );
  const ops = buildMutateOperations(prepared.action, customer) as any[];
  const kinds = ops.map((o) => Object.keys(o.campaign_criterion_operation)[0]);
  const firstCreate = kinds.indexOf('create');
  assert.ok(kinds.indexOf('remove') < kinds.indexOf('update'));
  assert.ok(kinds.indexOf('update') < firstCreate);
  assert.ok(kinds.slice(firstCreate).every((k) => k === 'create'));

  const result = await executeExtendedAction(prepared.action, customer);
  const rollback = finalizeExtendedRollback(prepared.rollbackPayload, result) as any;
  assert.equal(rollback.remove_criteria.length, kinds.filter((k) => k === 'create').length);
  assert.ok(rollbackResourcesScoped(rollback, CID));
  const back = buildRollbackOperations(rollback) as any[];
  assert.ok(back.some((o) => o.campaign_criterion_operation.create?.ad_schedule?.day_of_week === 'TUESDAY'));
  assert.ok(back.some((o) => o.campaign_criterion_operation.update?.bid_modifier === 1));
});

test('rollback refuses a resource that was not part of the change', () => {
  assert.throws(
    () =>
      buildRollbackOperations({
        action_type: 'ext_restore_campaign_criteria',
        touched_resources: [CAMPAIGN],
        remove_criteria: [`customers/${CID}/campaignCriteria/1~2`],
      }),
    /not part of the original change/
  );
});

test('location: exclude and modifier paths', async () => {
  const excluded = await prepareExtendedAction(
    act('exclude_location', { campaign_resource: CAMPAIGN, geo_target_constant: GEO }),
    fakeCustomer(),
    deps
  );
  const [op] = buildMutateOperations(excluded.action, fakeCustomer()) as any[];
  assert.deepEqual(op.campaign_criterion_operation.create, {
    campaign: CAMPAIGN,
    negative: true,
    location: { geo_target_constant: GEO },
  });

  const targeted = {
    campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/555~5`, negative: false, bidModifier: 1, location: { geoTargetConstant: GEO } },
  };
  await assert.rejects(
    prepareExtendedAction(act('exclude_location', { campaign_resource: CAMPAIGN, geo_target_constant: GEO }), fakeCustomer({ locations: [targeted] }), deps),
    /location_is_targeted/
  );
  await assert.rejects(
    prepareExtendedAction(act('set_location_bid_modifier', { campaign_resource: CAMPAIGN, geo_target_constant: GEO, bid_modifier: 1.2 }), fakeCustomer(), deps),
    /location_not_targeted/
  );
  const modified = await prepareExtendedAction(
    act('set_location_bid_modifier', { campaign_resource: CAMPAIGN, geo_target_constant: GEO, bid_modifier: 1.2 }),
    fakeCustomer({ locations: [targeted] }),
    deps
  );
  assert.deepEqual((modified.rollbackPayload as any).restore_modifiers, [
    { resource_name: `customers/${CID}/campaignCriteria/555~5`, bid_modifier: 1 },
  ]);
});

test('geo target type and network settings: field masks, old values, no-ops', async () => {
  const customer = fakeCustomer({ geoType: 'PRESENCE_OR_INTEREST' });
  const geo = await prepareExtendedAction(
    act('set_geo_target_type', { campaign_resource: CAMPAIGN, positive_geo_target_type: 'PRESENCE' }),
    customer,
    deps
  );
  const [geoOp] = buildMutateOperations(geo.action, customer) as any[];
  assert.deepEqual(geoOp.campaign_operation.update, {
    resource_name: CAMPAIGN,
    geo_target_type_setting: { positive_geo_target_type: 'PRESENCE' },
  });
  assert.equal(geoOp.campaign_operation.update_mask, 'geoTargetTypeSetting.positiveGeoTargetType');
  const [geoBack] = buildRollbackOperations(geo.rollbackPayload) as any[];
  assert.equal(geoBack.campaign_operation.update.geo_target_type_setting.positive_geo_target_type, 'PRESENCE_OR_INTEREST');
  await assert.rejects(
    prepareExtendedAction(act('set_geo_target_type', { campaign_resource: CAMPAIGN, positive_geo_target_type: 'PRESENCE' }), fakeCustomer({ geoType: 'PRESENCE' }), deps),
    /no_change/
  );

  const net = await prepareExtendedAction(
    act('set_network_settings', { campaign_resource: CAMPAIGN, target_search_network: false, target_content_network: false }),
    customer,
    deps
  );
  const [netOp] = buildMutateOperations(net.action, customer) as any[];
  assert.deepEqual(netOp.campaign_operation.update.network_settings, { target_search_network: false, target_content_network: false });
  assert.equal(netOp.campaign_operation.update_mask, 'networkSettings.targetSearchNetwork,networkSettings.targetContentNetwork');
  const [netBack] = buildRollbackOperations(net.rollbackPayload) as any[];
  assert.deepEqual(netBack.campaign_operation.update.network_settings, { target_search_network: true, target_content_network: true });
  await assert.rejects(
    prepareExtendedAction(act('set_network_settings', { campaign_resource: CAMPAIGN, target_search_network: false }), fakeCustomer({ search: false }), deps),
    /no_change/
  );
  await assert.rejects(
    prepareExtendedAction(act('set_network_settings', { campaign_resource: CAMPAIGN, target_search_network: false }), fakeCustomer({ channel: 'PERFORMANCE_MAX' }), deps),
    /network_search_only/
  );
});

test('shared list: one atomic mutate with a temporary resource name, conflicts dropped, rollback detaches then removes', async () => {
  const customer = fakeCustomer({ lists: [] });
  const prepared = await prepareExtendedAction(
    act(
      'create_shared_negative_list',
      {
        name: 'قائمة منع',
        keywords: [
          { text: 'مجاني', match_type: 'PHRASE' },
          { text: 'blocked', match_type: 'PHRASE' },
        ],
        campaign_resources: [CAMPAIGN],
      },
      ''
    ),
    customer,
    deps
  );
  const ops = buildMutateOperations(prepared.action, customer) as any[];
  const kinds = ops.map((o) => Object.keys(o)[0]);
  assert.deepEqual(kinds, ['shared_set_operation', 'shared_criterion_operation', 'campaign_shared_set_operation']);
  const temp = ops[0].shared_set_operation.create.resource_name;
  assert.match(temp, new RegExp(`^customers/${CID}/sharedSets/-\\d+$`));
  assert.equal(ops[1].shared_criterion_operation.create.shared_set, temp);
  assert.equal(ops[2].shared_criterion_operation, undefined);
  assert.equal(ops[2].campaign_shared_set_operation.create.shared_set, temp);
  assert.equal(ops[0].shared_set_operation.create.type, 'NEGATIVE_KEYWORDS');
  assert.ok(!JSON.stringify(ops).includes('blocked'));

  const result = await executeExtendedAction(prepared.action, customer);
  const rollback = finalizeExtendedRollback(prepared.rollbackPayload, result) as any;
  assert.equal(rollback.remove_shared_sets.length, 1);
  assert.equal(rollback.remove_shared_criteria.length, 1);
  assert.equal(rollback.remove_campaign_shared_sets.length, 1);
  assert.ok(rollbackResourcesScoped(rollback, CID));
  const kindsBack = (buildRollbackOperations(rollback) as any[]).map((o) => Object.keys(o)[0]);
  assert.deepEqual(kindsBack, ['campaign_shared_set_operation', 'shared_criterion_operation', 'shared_set_operation']);
});

test('shared list: duplicate name, account limit and a fully conflicting list are refused', async () => {
  const params = {
    name: 'قائمة',
    keywords: [{ text: 'مجاني', match_type: 'PHRASE' }],
    campaign_resources: [CAMPAIGN],
  };
  const list = (n: number, name = 'x') => ({ sharedSet: { resourceName: `customers/${CID}/sharedSets/${n}`, name, memberCount: 1, referenceCount: 0 } });
  await assert.rejects(prepareExtendedAction(act('create_shared_negative_list', params, ''), fakeCustomer({ lists: [list(1, 'قائمة')] }), deps), /list_name_taken/);
  await assert.rejects(
    prepareExtendedAction(act('create_shared_negative_list', params, ''), fakeCustomer({ lists: Array.from({ length: 20 }, (_, i) => list(i + 1, `n${i}`)) }), deps),
    /list_limit/
  );
  await assert.rejects(
    prepareExtendedAction(
      act('create_shared_negative_list', { ...params, keywords: [{ text: 'blocked', match_type: 'PHRASE' }] }, ''),
      fakeCustomer(),
      deps
    ),
    ExtendedPreflightError
  );
});

test('recommendations: apply builds an asset operation, dismiss is read-checked, both are not reversible', async () => {
  const recommendation = {
    resourceName: REC,
    type: 'SITELINK_ASSET',
    dismissed: false,
    campaign: CAMPAIGN,
    sitelinkAssetRecommendation: {
      recommendedCampaignSitelinkAssets: [{ sitelinkAsset: { linkText: 'تواصل' }, finalUrls: ['https://example.com/c'] }],
    },
  };
  const customer = fakeCustomer({ recommendation });
  const prepared = await prepareExtendedAction(
    act('apply_google_recommendation', { recommendation_resource: REC, recommendation_type: 'SITELINK_ASSET' }, REC),
    customer,
    deps
  );
  assert.equal((prepared.rollbackPayload as any).reversible, false);
  const validated = await executeExtendedAction(prepared.action, customer, { validateOnly: true });
  assert.equal((validated as any).validated, 'read_only_check');
  assert.equal(customer.mutations.length, 0);
  await executeExtendedAction(prepared.action, customer);
  const op = customer.mutations[0].apply[0];
  assert.equal(op.resource_name, REC);
  assert.equal(op.sitelink_asset.ad_asset_apply_parameters.scope, 'CAMPAIGN');
  assert.equal(op.sitelink_asset.ad_asset_apply_parameters.new_assets[0].sitelink_asset.link_text, 'تواصل');

  await assert.rejects(
    prepareExtendedAction(
      act('apply_google_recommendation', { recommendation_resource: REC, recommendation_type: 'SITELINK_ASSET' }, REC),
      fakeCustomer({ recommendation: { ...recommendation, dismissed: true } }),
      deps
    ),
    /recommendation_dismissed/
  );
  await assert.rejects(
    prepareExtendedAction(
      act('apply_google_recommendation', { recommendation_resource: REC, recommendation_type: 'SITELINK_ASSET' }, REC),
      fakeCustomer({ recommendation: { ...recommendation, type: 'CAMPAIGN_BUDGET' } }),
      deps
    ),
    /recommendation_changed/
  );

  const dismissCustomer = fakeCustomer({ recommendation: { resourceName: REC, type: 'CAMPAIGN_BUDGET', dismissed: false } });
  const dismissed = await prepareExtendedAction(
    act('dismiss_google_recommendation', { recommendation_resource: REC, recommendation_type: 'CAMPAIGN_BUDGET' }, REC),
    dismissCustomer,
    deps
  );
  await executeExtendedAction(dismissed.action, dismissCustomer);
  assert.deepEqual(dismissCustomer.mutations[0].dismiss, [{ resource_name: REC }]);
});

test('pause auto-apply: pauses enabled subscriptions and the rollback re-enables them', async () => {
  const subs = [
    { recommendationSubscription: { resourceName: SUB, type: 'SITELINK_ASSET', status: 'ENABLED' } },
    { recommendationSubscription: { resourceName: `customers/${CID}/recommendationSubscriptions/KEYWORD`, type: 'KEYWORD', status: 'PAUSED' } },
  ];
  const customer = fakeCustomer({ subs });
  const prepared = await prepareExtendedAction(act('pause_auto_apply', { subscription_resources: [SUB] }, ''), customer, deps);
  const [op] = buildMutateOperations(prepared.action, customer) as any[];
  assert.deepEqual(op.recommendation_subscription_operation.update, { resource_name: SUB, status: 'PAUSED' });
  const [back] = buildRollbackOperations(prepared.rollbackPayload) as any[];
  assert.equal(back.recommendation_subscription_operation.update.status, 'ENABLED');
  await assert.rejects(
    prepareExtendedAction(act('pause_auto_apply', { subscription_resources: [`customers/${CID}/recommendationSubscriptions/KEYWORD`] }, ''), customer, deps),
    /no_change/
  );
});

test('prepareActionForExecution and finalizeRollbackPayload delegate when the flag is on', async () => {
  await withFlagAsync('true', async () => {
    const customer = fakeCustomer();
    const prepared = await prepareActionForExecution(
      act('exclude_location', { campaign_resource: CAMPAIGN, geo_target_constant: GEO }),
      customer
    );
    assert.equal((prepared.rollbackPayload as any).action_type, 'ext_restore_campaign_criteria');
    const result = await executeAction(prepared.action, customer);
    const finalized = finalizeRollbackPayload(prepared.rollbackPayload, result) as any;
    assert.equal(finalized.remove_criteria.length, 1);
    const back = await executeRollback(finalized, customer);
    assert.ok(back);
  });
});

// ---------------------------------------------------------------------------
// Rollback scope
// ---------------------------------------------------------------------------

test('rollbackResourcesScoped checks every list of an extended payload and fails closed', () => {
  const base = {
    action_type: 'ext_restore_campaign_criteria',
    campaign_resource: CAMPAIGN,
    touched_resources: [CAMPAIGN],
  };
  assert.equal(rollbackResourcesScoped(base, CID), true);
  assert.equal(rollbackResourcesScoped({ ...base, touched_resources: [OTHER_CAMPAIGN] }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, touched_resources: [] }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, remove_criteria: [OTHER_CAMPAIGN] }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, remove_criteria: 'x' }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, restore_modifiers: [{ resource_name: OTHER_CAMPAIGN }] }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, recreate: [{ campaign: OTHER_CAMPAIGN }] }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, subscriptions: [{ resource_name: 'customers/1/x' }] }, CID), false);
  assert.equal(rollbackResourcesScoped({ ...base, remove_shared_sets: [SHARED], touched_resources: [CAMPAIGN, SHARED] }, CID), true);
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

function fakeDb(options: { customerId?: string | null; history?: any[]; historyError?: boolean }) {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gte: () => chain,
        maybeSingle: async () => ({ data: options.customerId ? { customer_id: options.customerId } : null, error: null }),
        then: (resolve: any) =>
          resolve(
            table === 'ai_actions'
              ? options.historyError
                ? { data: null, error: { message: 'x' } }
                : { data: options.history ?? [], error: null }
              : { data: [], error: null }
          ),
      };
      return chain;
    },
  };
}

test('guardrails: payload re-validated against the account, 7 day family lock, fail closed', async () => {
  const action = act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.8 });
  const ok = await checkExtendedGuardrails(action, 'acc', fakeDb({ customerId: CID }), { applyLocks: true });
  assert.equal(ok.ok, true);

  const foreign = await checkExtendedGuardrails(act('set_device_bid_modifier', { campaign_resource: OTHER_CAMPAIGN, device: 'MOBILE', bid_modifier: 0.8 }, OTHER_CAMPAIGN), 'acc', fakeDb({ customerId: CID }), { applyLocks: true });
  assert.equal(foreign.ok, false);

  const noAccount = await checkExtendedGuardrails(action, 'acc', fakeDb({ customerId: null }), { applyLocks: true });
  assert.equal(noAccount.ok, false);

  const history = [{ action_type: 'set_ad_schedule', payload: { action: { params: { campaign_resource: CAMPAIGN } } }, created_at: new Date().toISOString() }];
  const locked = await checkExtendedGuardrails(action, 'acc', fakeDb({ customerId: CID, history }), { applyLocks: true });
  assert.deepEqual(locked, { ok: false, code: 'targeting_locked_recent_change' });
  const unlockedAtQueueTime = await checkExtendedGuardrails(action, 'acc', fakeDb({ customerId: CID, history }), { applyLocks: false });
  assert.equal(unlockedAtQueueTime.ok, true);

  const other = [{ action_type: 'set_ad_schedule', payload: { action: { params: { campaign_resource: `customers/${CID}/campaigns/1` } } } }];
  assert.equal((await checkExtendedGuardrails(action, 'acc', fakeDb({ customerId: CID, history: other }), { applyLocks: true })).ok, true);

  const unreadable = await checkExtendedGuardrails(action, 'acc', fakeDb({ customerId: CID, historyError: true }), { applyLocks: true });
  assert.equal(unreadable.ok, false);
  assert.ok(CAMPAIGN_TARGETING_FAMILY.set_ad_schedule);
});

// ---------------------------------------------------------------------------
// Readback and preview
// ---------------------------------------------------------------------------

test('readback verifies the live state and reports mismatches without throwing', async () => {
  const device = {
    campaignCriterion: { resourceName: 'r', bidModifier: 0.8, device: { type: 'MOBILE' } },
  };
  const good = await readbackExtendedAction(
    act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.8 }),
    fakeCustomer({ devices: [device] })
  );
  assert.equal(good.status, 'verified');
  const bad = await readbackExtendedAction(
    act('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0.7 }),
    fakeCustomer({ devices: [device] })
  );
  assert.equal(bad.status, 'mismatch');
  const broken: any = { async query() { throw new Error('boom'); } };
  assert.equal((await readbackExtendedAction(act('set_network_settings', { campaign_resource: CAMPAIGN, target_search_network: false }), broken)).status, 'unavailable');
  const net = await readbackExtendedAction(
    act('set_network_settings', { campaign_resource: CAMPAIGN, target_search_network: false }),
    fakeCustomer({ search: false })
  );
  assert.equal(net.status, 'verified');
});

test('preview rows are Arabic without dashes', () => {
  const rows = extendedPreviewRows('set_ad_schedule', { campaign_resource: CAMPAIGN, slots: [slot('MONDAY', 9, 17, 1.2)], restrict_to_slots: true });
  const text = rows.map((r) => `${r.label} ${r.value}`).join(' ');
  assert.match(text, /الاثنين/);
  assert.match(text, /زيادة 20%/);
  assert.doesNotMatch(text, /[–—]/);
  assert.equal(extendedPreviewRows('set_device_bid_modifier', { campaign_resource: CAMPAIGN, device: 'MOBILE', bid_modifier: 0 }).at(-1)?.value, 'استبعاد كامل');
});
