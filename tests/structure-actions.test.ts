import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTENDED_OPERATIONS, isExtendedOperation, CAMPAIGN_TARGETING_FAMILY } from '../lib/ai/extended-actions/types';
import { validateExtendedPayload } from '../lib/ai/extended-actions/validate';
import { prepareExtendedAction, ExtendedPreflightError } from '../lib/ai/extended-actions/preflight';
import { buildMutateOperations, buildRollbackOperations, finalizeExtendedRollback, isExtendedRollback } from '../lib/ai/extended-actions/execute';
import { extendedPreviewRows } from '../lib/ai/extended-actions/preview';
import { readbackExtendedAction } from '../lib/ai/extended-actions/readback';
import { checkExtendedGuardrails } from '../lib/ai/extended-actions/guardrails';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { OPERATION_LABELS_AR } from '../lib/ai/operation-labels';
import { STRUCTURE_OPERATIONS } from '../lib/structure/types';
import { checkCapacityStep } from '../lib/structure/preflight';
import { listingCase } from '../lib/structure/plan';
import { cleanPlacement, normalizePlacementHost, cleanSubdivision } from '../lib/structure/validate';
import type { OptimizerAction } from '../lib/ai/optimizer-agent';

const mut = (a: OptimizerAction, c: unknown): any[] => buildMutateOperations(a, c);
const rbo = (p: unknown): any[] => buildRollbackOperations(p as any);

const CID = '1234567890';
const C1 = `customers/${CID}/campaigns/11`;
const C2 = `customers/${CID}/campaigns/22`;
const B1 = `customers/${CID}/campaignBudgets/101`;
const B2 = `customers/${CID}/campaignBudgets/102`;
const BS = `customers/${CID}/campaignBudgets/900`;
const STRAT = `customers/${CID}/biddingStrategies/700`;
const AG = `customers/${CID}/adGroups/31`;
const ASSET_GROUP = `customers/${CID}/assetGroups/41`;

const deps = {
  filterNegativeKeywordBatch: async () => ({ keep: [], dropped: [] }),
  readSevenDayMetrics: async () => ({ cost: 10, clicks: 5, conversions: 1, conversion_value: 100 }),
  normalizeKeywordText: (v: string) => v,
};

type CampaignRow = Partial<{
  channel: string; bidding: string; portfolio: string; budget: string; amount: string; shared: boolean; ai: boolean;
  mc: any; tc: any; status: string;
}>;

function campaignRow(resource: string, r: CampaignRow = {}) {
  return {
    campaign: {
      resourceName: resource,
      name: `camp ${resource.split('/').pop()}`,
      status: r.status ?? 'ENABLED',
      advertisingChannelType: r.channel ?? 'SEARCH',
      biddingStrategyType: r.bidding ?? 'MAXIMIZE_CONVERSIONS',
      biddingStrategy: r.portfolio ?? '',
      campaignBudget: r.budget ?? B1,
      aiMaxSetting: { enableAiMax: r.ai === true },
      maximizeConversions: r.mc ?? {},
      targetCpa: r.tc,
    },
    campaignBudget: { amountMicros: r.amount ?? '50000000', explicitlyShared: r.shared === true },
  };
}

function fakeCustomer(opts: {
  campaigns?: Record<string, CampaignRow>;
  conv?: number;
  cost?: number;
  value?: number;
  extra?: (gaql: string) => any[] | undefined;
}) {
  return {
    credentials: { customer_id: CID },
    async query(gaql: string): Promise<any[]> {
      const special = opts.extra?.(gaql);
      if (special) return special;
      if (/SELECT campaign.resource_name, metrics.cost_micros/.test(gaql)) {
        return Object.keys(opts.campaigns ?? {}).map((resource) => ({
          campaign: { resourceName: resource },
          metrics: { costMicros: String(opts.cost ?? 1_000_000_000), conversions: opts.conv ?? 40, conversionsValue: opts.value ?? 4000 },
        }));
      }
      if (/FROM campaign\s/.test(gaql) && /campaign.ai_max_setting/.test(gaql)) {
        return Object.entries(opts.campaigns ?? {})
          .filter(([resource]) => gaql.includes(`'${resource}'`))
          .map(([resource, row]) => campaignRow(resource, row));
      }
      return [];
    },
  };
}

function action(type: string, params: Record<string, unknown>, target: string): OptimizerAction {
  return { type, target_id: target, params } as unknown as OptimizerAction;
}

function ok(operation: any, target: string, params: Record<string, unknown>) {
  const v = validateExtendedPayload(operation, target, params, CID);
  assert.equal(v.ok, true, JSON.stringify(v));
  return (v as any).params as Record<string, unknown>;
}

async function prepare(type: string, params: Record<string, unknown>, customer: any, target = C1) {
  const clean = ok(type, target, params);
  return prepareExtendedAction(action(type, clean, target), customer, deps);
}

async function refused(type: string, params: Record<string, unknown>, customer: any, code: string, target = C1) {
  const clean = ok(type, target, params);
  await assert.rejects(
    () => prepareExtendedAction(action(type, clean, target), customer, deps),
    (e: any) => e instanceof ExtendedPreflightError || e?.name === 'StructurePreflightError' ? e.code === code : false
  );
}

// ---------------------------------------------------------------------------

test('structure operations are extended operations with labels', () => {
  for (const op of STRUCTURE_OPERATIONS) {
    assert.equal(isExtendedOperation(op), true);
    assert.ok(EXTENDED_OPERATIONS.includes(op as any));
    assert.ok(OPERATION_LABELS_AR[op], `label for ${op}`);
    assert.doesNotMatch(OPERATION_LABELS_AR[op], /[–—]/);
  }
  assert.equal(CAMPAIGN_TARGETING_FAMILY.set_ai_max, 'ai_max');
});

test('validators: AI Max, shared budget, portfolio', () => {
  assert.equal(validateExtendedPayload('set_ai_max', C1, { campaign_resource: C1, enabled: 'yes' }, CID).ok, false);
  assert.equal(validateExtendedPayload('set_ai_max', C1, { campaign_resource: `customers/999/campaigns/1`, enabled: true }, CID).ok, false);
  assert.equal(validateExtendedPayload('create_shared_budget', C1, { name: 'x', amount_micros: 1000000, campaign_resources: [C1, C2] }, CID).ok, false);
  assert.equal(validateExtendedPayload('create_shared_budget', C1, { name: 'ميزانية', amount_micros: 100_000_000, campaign_resources: [C1] }, CID).ok, false);
  assert.equal(validateExtendedPayload('create_shared_budget', C1, { name: 'ميزانية', amount_micros: 100_000_005, campaign_resources: [C1, C2] }, CID).ok, false);
  assert.equal(validateExtendedPayload('create_shared_budget', C1, { name: 'ميزانية – مشتركة', amount_micros: 100_000_000, campaign_resources: [C1, C2] }, CID).ok, false);
  const good = ok('create_shared_budget', C1, { name: 'ميزانية', amount_micros: 100_000_000, campaign_resources: [C1, C2, C1], resolved: { evil: 1 } });
  assert.deepEqual(good.campaign_resources, [C1, C2]);
  assert.equal('resolved' in good, false);
  assert.equal(validateExtendedPayload('create_portfolio_strategy', C1, { name: 'a b', strategy_type: 'TARGET_CPA', campaign_resources: [C1, C2] }, CID).ok, false);
  assert.equal(validateExtendedPayload('create_portfolio_strategy', C1, { name: 'a b', strategy_type: 'MAXIMIZE_CONVERSIONS', target_roas: 3, campaign_resources: [C1, C2] }, CID).ok, false);
  assert.equal(validateExtendedPayload('detach_portfolio_strategy', C1, { campaign_resource: C1, to: 'MANUAL_CPC' }, CID).ok, false);
});

test('validators: placements and subdivisions', () => {
  assert.equal(normalizePlacementHost('https://www.Example.com/path?x=1'), 'example.com');
  assert.equal(normalizePlacementHost('not a host'), null);
  assert.deepEqual(cleanPlacement({ kind: 'content_label', value: 'juvenile' }), { kind: 'content_label', value: 'JUVENILE' });
  assert.equal(cleanPlacement({ kind: 'content_label', value: 'NOPE' }), null);
  assert.equal(cleanPlacement({ kind: 'youtube_channel', value: 'abc' }), null);
  assert.equal(cleanPlacement({ kind: 'mobile_app', value: '1-com.game.fun' })?.value, '1-com.game.fun');
  assert.equal(validateExtendedPayload('add_placement_exclusions', 'x', { level: 'campaign', placements: [{ kind: 'website', value: 'a.com' }] }, CID).ok, false);
  const acct = validateExtendedPayload('add_placement_exclusions', 'x', { level: 'account', placements: [{ kind: 'website', value: 'A.com' }, { kind: 'website', value: 'a.com' }] }, CID) as any;
  assert.equal(acct.ok, true);
  assert.equal(acct.params.placements.length, 1);
  assert.equal(acct.target_id, `customers/${CID}`);
  assert.equal(cleanSubdivision({ dimension: 'category', values: ['abc'] }), null);
  assert.equal(cleanSubdivision({ dimension: 'custom_label', values: ['a'] }), null);
  assert.equal(cleanSubdivision({ dimension: 'custom_label', values: ['a'], custom_label_index: 2 })?.custom_label_index, 2);
  assert.equal(cleanSubdivision({ dimension: 'brand', values: [] }), null);
  assert.equal(cleanSubdivision({ dimension: 'brand', values: Array.from({ length: 21 }, (_, i) => `b${i}`) }), null);
  assert.equal(validateExtendedPayload('subdivide_pmax_listing_group', ASSET_GROUP, { asset_group_resource: ASSET_GROUP, dimension: 'brand', values: ['X'], others: 'exclude' }, CID).ok, true);
});

test('capacity step: neutral passes, 5 to 20 percent passes, outside fails', () => {
  const M = 1_000_000;
  assert.deepEqual(checkCapacityStep(100 * M, 100.5 * M), { ok: true });
  assert.deepEqual(checkCapacityStep(100 * M, 110 * M), { ok: true });
  assert.deepEqual(checkCapacityStep(100 * M, 80 * M), { ok: true });
  assert.equal(checkCapacityStep(100 * M, 130 * M).ok, false);
  assert.equal(checkCapacityStep(100 * M, 102 * M).ok, false);
  assert.equal(checkCapacityStep(0, 10 * M).ok, false);
});

test('AI Max: gates, operation, rollback restores the previous value', async () => {
  const customer = fakeCustomer({ campaigns: { [C1]: { channel: 'SEARCH', bidding: 'MAXIMIZE_CONVERSIONS' } }, conv: 40 });
  const prepared = await prepare('set_ai_max', { campaign_resource: C1, enabled: true }, customer);
  const ops = mut(prepared.action, customer);
  assert.deepEqual(ops, [
    { campaign_operation: { update: { resource_name: C1, ai_max_setting: { enable_ai_max: true } }, update_mask: 'aiMaxSetting.enableAiMax' } },
  ]);
  const rb = rbo(prepared.rollbackPayload as any);
  assert.deepEqual(rb[0].campaign_operation.update, { resource_name: C1, ai_max_setting: { enable_ai_max: false } });
  assert.equal(isExtendedRollback(prepared.rollbackPayload as any), true);
  assert.equal(rollbackResourcesScoped(prepared.rollbackPayload as any, CID), true);
  assert.equal(rollbackResourcesScoped(prepared.rollbackPayload as any, '999'), false);

  await refused('set_ai_max', { campaign_resource: C1, enabled: true }, fakeCustomer({ campaigns: { [C1]: { channel: 'PERFORMANCE_MAX' } } }), 'ai_max_search_only');
  await refused('set_ai_max', { campaign_resource: C1, enabled: true }, fakeCustomer({ campaigns: { [C1]: { bidding: 'MANUAL_CPC' } } }), 'ai_max_needs_smart_bidding');
  await refused('set_ai_max', { campaign_resource: C1, enabled: true }, fakeCustomer({ campaigns: { [C1]: {} }, conv: 5 }), 'ai_max_needs_conversions');
  await refused('set_ai_max', { campaign_resource: C1, enabled: true }, fakeCustomer({ campaigns: { [C1]: { ai: true } } }), 'no_change');
  // Turning it off has no conversion gate.
  const off = await prepare('set_ai_max', { campaign_resource: C1, enabled: false }, fakeCustomer({ campaigns: { [C1]: { ai: true, bidding: 'MANUAL_CPC' } }, conv: 0 }));
  assert.equal(mut(off.action, null)[0].campaign_operation.update.ai_max_setting.enable_ai_max, false);
});

test('placement exclusions: account level builds customer negatives, dedupes, rolls back by result index', async () => {
  const customer = fakeCustomer({
    extra: (gaql) =>
      /FROM customer_negative_criterion/.test(gaql)
        ? [{ customerNegativeCriterion: { placement: { url: 'old.com' } } }]
        : undefined,
  });
  const prepared = await prepare(
    'add_placement_exclusions',
    { level: 'account', placements: [{ kind: 'website', value: 'old.com' }, { kind: 'website', value: 'new.com' }, { kind: 'content_label', value: 'JUVENILE' }, { kind: 'youtube_channel', value: 'UC' + 'a'.repeat(22) }] },
    customer,
    `customers/${CID}`
  );
  const ops = mut(prepared.action, customer);
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0], { customer_negative_criterion_operation: { create: { placement: { url: 'new.com' } } } });
  assert.deepEqual(ops[1], { customer_negative_criterion_operation: { create: { content_label: { type: 'JUVENILE' } } } });
  assert.deepEqual(ops[2].customer_negative_criterion_operation.create, { youtube_channel: { channel_id: 'UC' + 'a'.repeat(22) } });

  const finalized = finalizeExtendedRollback(prepared.rollbackPayload as any, {
    results: [1, 2, 3].map((n) => ({ resourceName: `customers/${CID}/customerNegativeCriteria/${n}` })),
  }) as any;
  assert.equal(finalized.reversible, true);
  const rb = rbo(finalized);
  assert.deepEqual(rb, [1, 2, 3].map((n) => ({ customer_negative_criterion_operation: { remove: `customers/${CID}/customerNegativeCriteria/${n}` } })));
  assert.equal(rollbackResourcesScoped(finalized, CID), true);

  // A result list that is too short makes the rollback unavailable instead of guessing.
  const short = finalizeExtendedRollback(prepared.rollbackPayload as any, { results: [{ resourceName: `customers/${CID}/customerNegativeCriteria/1` }] }) as any;
  assert.equal(short.reversible, false);

  const all = fakeCustomer({ extra: () => [{ customerNegativeCriterion: { placement: { url: 'a.com' } } }] });
  await refused('add_placement_exclusions', { level: 'account', placements: [{ kind: 'website', value: 'a.com' }] }, all, 'nothing_to_add', `customers/${CID}`);
});

test('placement exclusions: campaign level only for Display, Video and Demand Gen', async () => {
  await refused(
    'add_placement_exclusions',
    { level: 'campaign', campaign_resource: C1, placements: [{ kind: 'website', value: 'a.com' }] },
    fakeCustomer({ campaigns: { [C1]: { channel: 'PERFORMANCE_MAX' } } }),
    'campaign_level_not_supported',
    C1
  );
  const customer = fakeCustomer({ campaigns: { [C1]: { channel: 'DISPLAY' } } });
  const prepared = await prepare('add_placement_exclusions', { level: 'campaign', campaign_resource: C1, placements: [{ kind: 'mobile_app', value: '1-com.x.y' }] }, customer, C1);
  assert.deepEqual(mut(prepared.action, customer), [
    { campaign_criterion_operation: { create: { campaign: C1, negative: true, mobile_application: { app_id: '1-com.x.y' } } } },
  ]);
});

test('shared budget: create applies the budget step, uses a temp id, one atomic batch, rollback restores budgets', async () => {
  const campaigns = { [C1]: { bidding: 'TARGET_SPEND', budget: B1, amount: '50000000' }, [C2]: { bidding: 'TARGET_SPEND', budget: B2, amount: '50000000' } };
  const customer = fakeCustomer({ campaigns });
  const prepared = await prepare('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 110_000_000, campaign_resources: [C1, C2] }, customer);
  const ops = mut(prepared.action, customer);
  const temp = `customers/${CID}/campaignBudgets/-1`;
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0].campaign_budget_operation.create, {
    resource_name: temp, name: 'ميزانية المتجر', amount_micros: 110_000_000, delivery_method: 'STANDARD', explicitly_shared: true,
  });
  assert.equal(ops[1].campaign_operation.update.campaign_budget, temp);
  assert.equal(ops[2].campaign_operation.update_mask, 'campaignBudget');

  const finalized = finalizeExtendedRollback(prepared.rollbackPayload as any, {
    results: [{ resourceName: BS }, { resourceName: C1 }, { resourceName: C2 }],
  }) as any;
  const rb = rbo(finalized);
  assert.equal(rb.length, 3);
  assert.deepEqual(rb[0].campaign_operation.update, { resource_name: C1, campaign_budget: B1 });
  assert.deepEqual(rb[1].campaign_operation.update, { resource_name: C2, campaign_budget: B2 });
  assert.deepEqual(rb[2], { campaign_budget_operation: { remove: BS } });
  assert.equal(rollbackResourcesScoped(finalized, CID), true);

  // 100M current total: 150M is +50%, outside the 5 to 20 percent step.
  await refused('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 150_000_000, campaign_resources: [C1, C2] }, customer, 'budget_step_too_large');
  // A change of 2 percent is neither neutral nor a real step.
  await refused('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 102_000_000, campaign_resources: [C1, C2] }, customer, 'budget_step_too_small');
  // Neutral restructure passes.
  await prepare('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 100_000_000, campaign_resources: [C1, C2] }, customer);
  // Taken name.
  const taken = fakeCustomer({ campaigns, extra: (g) => (/campaign_budget.name =/.test(g) ? [{ campaignBudget: { resourceName: BS } }] : undefined) });
  await refused('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 100_000_000, campaign_resources: [C1, C2] }, taken, 'name_taken');
  // Already on a shared budget, unsupported channel, same budget twice.
  await refused('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 100_000_000, campaign_resources: [C1, C2] },
    fakeCustomer({ campaigns: { [C1]: { shared: true }, [C2]: { bidding: 'TARGET_SPEND', budget: B2 } } }), 'already_shared_budget');
  await refused('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 100_000_000, campaign_resources: [C1, C2] },
    fakeCustomer({ campaigns: { [C1]: { bidding: 'TARGET_SPEND' }, [C2]: { bidding: 'TARGET_SPEND', budget: B2, channel: 'PERFORMANCE_MAX' } } }), 'channel_not_supported');
  await refused('create_shared_budget', { name: 'ميزانية المتجر', amount_micros: 100_000_000, campaign_resources: [C1, C2] },
    fakeCustomer({ campaigns: { [C1]: { bidding: 'TARGET_SPEND', budget: B1 }, [C2]: { bidding: 'TARGET_SPEND', budget: B1 } } }), 'budget_not_exclusive');
});

test('shared budget: attach and detach', async () => {
  const sharedRow = (gaql: string) =>
    /FROM campaign_budget WHERE campaign_budget.resource_name/.test(gaql)
      ? [{ campaignBudget: { resourceName: BS, amountMicros: '100000000', explicitlyShared: true } }]
      : undefined;
  const customer = fakeCustomer({ campaigns: { [C1]: { budget: B1, amount: '8000000', bidding: 'TARGET_SPEND' } }, extra: sharedRow });
  const prepared = await prepare('attach_shared_budget', { budget_resource: BS, campaign_resources: [C1] }, customer, BS);
  const ops = mut(prepared.action, customer);
  assert.deepEqual(ops, [{ campaign_operation: { update: { resource_name: C1, campaign_budget: BS }, update_mask: 'campaignBudget' } }]);
  const rb = rbo(prepared.rollbackPayload as any);
  assert.deepEqual(rb[0].campaign_operation.update, { resource_name: C1, campaign_budget: B1 });

  // Joining with a campaign that has a much larger own budget cuts capacity too far.
  const big = fakeCustomer({ campaigns: { [C1]: { budget: B1, amount: '90000000', bidding: 'TARGET_SPEND' } }, extra: sharedRow });
  await refused('attach_shared_budget', { budget_resource: BS, campaign_resources: [C1] }, big, 'budget_step_too_large', BS);

  const detachCustomer = fakeCustomer({ campaigns: { [C1]: { budget: BS, amount: '100000000', shared: true } } });
  const detach = await prepare('detach_shared_budget', { campaign_resource: C1, amount_micros: 10_000_000 }, detachCustomer);
  const dops = mut(detach.action, detachCustomer);
  assert.equal(dops[0].campaign_budget_operation.create.explicitly_shared, false);
  assert.equal(dops[0].campaign_budget_operation.create.amount_micros, 10_000_000);
  assert.equal(dops[1].campaign_operation.update.campaign_budget, `customers/${CID}/campaignBudgets/-1`);
  const fin = finalizeExtendedRollback(detach.rollbackPayload as any, { results: [{ resourceName: B2 }, { resourceName: C1 }] }) as any;
  const drb = rbo(fin);
  assert.deepEqual(drb[0].campaign_operation.update, { resource_name: C1, campaign_budget: BS });
  assert.deepEqual(drb[1], { campaign_budget_operation: { remove: B2 } });
  await refused('detach_shared_budget', { campaign_resource: C1, amount_micros: 60_000_000 }, detachCustomer, 'budget_step_too_large');
  await refused('detach_shared_budget', { campaign_resource: C1, amount_micros: 10_000_000 }, fakeCustomer({ campaigns: { [C1]: { budget: B1 } } }), 'budget_not_shared');
});

test('portfolio strategy: create gates, builds, rolls back to the previous standalone strategy', async () => {
  // 2 campaigns, 40 conversions each row (80 pooled), cost 1000 each, value 4000 each.
  const campaigns = {
    [C1]: { bidding: 'TARGET_CPA', tc: { targetCpaMicros: '30000000' } },
    [C2]: { bidding: 'MAXIMIZE_CONVERSIONS', budget: B2, mc: { targetCpaMicros: '25000000' } },
  };
  const customer = fakeCustomer({ campaigns, conv: 40, cost: 1_000_000_000 }); // pooled CPA = 2,000,000,000 / 80 / 1e6 -> 25,000,000 micros
  const prepared = await prepare('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'TARGET_CPA', target_cpa_micros: 26_000_000, campaign_resources: [C1, C2] }, customer);
  const ops = mut(prepared.action, customer);
  const temp = `customers/${CID}/biddingStrategies/-1`;
  assert.deepEqual(ops[0], { bidding_strategy_operation: { create: { resource_name: temp, name: 'استراتيجية المتجر', target_cpa: { target_cpa_micros: 26_000_000 } } } });
  assert.deepEqual(ops[1].campaign_operation.update, { resource_name: C1, bidding_strategy: temp });
  const fin = finalizeExtendedRollback(prepared.rollbackPayload as any, { results: [{ resourceName: STRAT }, { resourceName: C1 }, { resourceName: C2 }] }) as any;
  const rb = rbo(fin);
  assert.deepEqual(rb[0].campaign_operation.update, { resource_name: C1, target_cpa: { target_cpa_micros: 30_000_000 } });
  assert.equal(rb[0].campaign_operation.update_mask, 'targetCpa');
  assert.deepEqual(rb[1].campaign_operation.update, { resource_name: C2, maximize_conversions: { target_cpa_micros: 25_000_000 } });
  assert.deepEqual(rb[2], { bidding_strategy_operation: { remove: STRAT } });
  assert.equal(rollbackResourcesScoped(fin, CID), true);

  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'TARGET_CPA', target_cpa_micros: 40_000_000, campaign_resources: [C1, C2] }, customer, 'target_far_from_actual');
  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'MAXIMIZE_CONVERSIONS', campaign_resources: [C1, C2] }, fakeCustomer({ campaigns, conv: 5 }), 'portfolio_needs_conversions');
  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'MAXIMIZE_CONVERSIONS', campaign_resources: [C1, C2] },
    fakeCustomer({ campaigns: { [C1]: { portfolio: STRAT }, [C2]: {} } }), 'already_portfolio');
  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'MAXIMIZE_CONVERSIONS', campaign_resources: [C1, C2] },
    fakeCustomer({ campaigns: { [C1]: { bidding: 'MANUAL_CPC' }, [C2]: {} } }), 'bidding_not_restorable');
  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'MAXIMIZE_CONVERSIONS', campaign_resources: [C1, C2] },
    fakeCustomer({ campaigns: { [C1]: { channel: 'PERFORMANCE_MAX' }, [C2]: {} } }), 'channel_not_supported');
});

test('portfolio strategy: target ROAS band uses pooled value over cost', async () => {
  const campaigns = { [C1]: { bidding: 'TARGET_ROAS' }, [C2]: { bidding: 'MAXIMIZE_CONVERSION_VALUE', budget: B2 } };
  // TARGET_ROAS rows have no readable target here, so previous_bidding is null: rollback impossible, refused.
  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'MAXIMIZE_CONVERSION_VALUE', campaign_resources: [C1, C2] }, fakeCustomer({ campaigns }), 'bidding_not_restorable');
  const ok2 = {
    [C1]: { bidding: 'MAXIMIZE_CONVERSION_VALUE' },
    [C2]: { bidding: 'MAXIMIZE_CONVERSION_VALUE', budget: B2 },
  };
  // value 4000 per row over cost 1000 per row gives ROAS 4.
  const customer = fakeCustomer({ campaigns: ok2, conv: 40, cost: 1_000_000_000, value: 4000 });
  await prepare('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'TARGET_ROAS', target_roas: 4.2, campaign_resources: [C1, C2] }, customer);
  await refused('create_portfolio_strategy', { name: 'استراتيجية المتجر', strategy_type: 'TARGET_ROAS', target_roas: 6, campaign_resources: [C1, C2] }, customer, 'target_far_from_actual');
});

test('portfolio strategy: detach moves to a standalone Smart Bidding strategy and rolls back by re-attaching', async () => {
  const customer = fakeCustomer({ campaigns: { [C1]: { portfolio: STRAT, bidding: 'TARGET_CPA' } } });
  const prepared = await prepare('detach_portfolio_strategy', { campaign_resource: C1, to: 'MAXIMIZE_CONVERSIONS' }, customer);
  assert.deepEqual(mut(prepared.action, customer), [
    { campaign_operation: { update: { resource_name: C1, maximize_conversions: {} }, update_mask: 'maximizeConversions' } },
  ]);
  const rb = rbo(prepared.rollbackPayload as any);
  assert.deepEqual(rb[0].campaign_operation.update, { resource_name: C1, bidding_strategy: STRAT });
  await refused('detach_portfolio_strategy', { campaign_resource: C1, to: 'MAXIMIZE_CONVERSIONS' }, fakeCustomer({ campaigns: { [C1]: {} } }), 'not_in_portfolio');
});

test('portfolio strategy: attach reads the strategy and checks the target against pooled results', async () => {
  const strategyRow = (gaql: string) =>
    /FROM bidding_strategy WHERE bidding_strategy.resource_name/.test(gaql)
      ? [{ biddingStrategy: { resourceName: STRAT, type: 'MAXIMIZE_CONVERSIONS' } }]
      : undefined;
  const customer = fakeCustomer({ campaigns: { [C1]: {} }, conv: 40, extra: strategyRow });
  const prepared = await prepare('attach_portfolio_strategy', { strategy_resource: STRAT, campaign_resources: [C1] }, customer, STRAT);
  assert.deepEqual(mut(prepared.action, customer), [
    { campaign_operation: { update: { resource_name: C1, bidding_strategy: STRAT }, update_mask: 'biddingStrategy' } },
  ]);
  await refused('attach_portfolio_strategy', { strategy_resource: STRAT, campaign_resources: [C1] }, fakeCustomer({ campaigns: { [C1]: {} }, extra: () => [] }), 'strategy_not_found', STRAT);
});

test('listing groups: case values per dimension', () => {
  assert.deepEqual(listingCase('brand', 'Nike', 1, null), { product_brand: { value: 'Nike' } });
  assert.deepEqual(listingCase('brand', null, 1, null), { product_brand: {} });
  assert.deepEqual(listingCase('category', '166', 2, null), { product_category: { level: 'LEVEL2', category_id: 166 } });
  assert.deepEqual(listingCase('category', null, 2, null), { product_category: { level: 'LEVEL2' } });
  assert.deepEqual(listingCase('product_type', 'Shoes', 1, null), { product_type: { level: 'LEVEL1', value: 'Shoes' } });
  assert.deepEqual(listingCase('custom_label', 'sale', 1, 3), { product_custom_attribute: { index: 'INDEX3', value: 'sale' } });
  assert.deepEqual(listingCase('item_id', 'sku-1', 1, null), { product_item_id: { value: 'sku-1' } });
});

test('Standard Shopping tree: remove the single root, rebuild as subdivision with temp ids, rollback restores the unit', async () => {
  const ROOT = `customers/${CID}/adGroupCriteria/31~900`;
  const rows = (gaql: string) =>
    /FROM ad_group_criterion/.test(gaql) && /cpc_bid_micros/.test(gaql)
      ? [{ adGroupCriterion: { resourceName: ROOT, cpcBidMicros: '700000', listingGroup: { type: 'UNIT' } } }]
      : undefined;
  const customer = fakeCustomer({ extra: rows });
  const prepared = await prepare('subdivide_shopping_listing_group', { ad_group_resource: AG, dimension: 'brand', values: ['Nike', 'Adidas'] }, customer, AG);
  const ops = mut(prepared.action, customer);
  const t = (n: number) => `customers/${CID}/adGroupCriteria/31~-${n}`;
  assert.equal(ops.length, 5);
  assert.deepEqual(ops[0], { ad_group_criterion_operation: { remove: ROOT } });
  assert.deepEqual(ops[1].ad_group_criterion_operation.create, { resource_name: t(1), ad_group: AG, status: 'ENABLED', listing_group: { type: 'SUBDIVISION' } });
  assert.deepEqual(ops[2].ad_group_criterion_operation.create, {
    resource_name: t(2), ad_group: AG, status: 'ENABLED', cpc_bid_micros: 700000,
    listing_group: { type: 'UNIT', parent_ad_group_criterion: t(1), case_value: { product_brand: { value: 'Nike' } } },
  });
  assert.deepEqual(ops[4].ad_group_criterion_operation.create.listing_group.case_value, { product_brand: {} });

  const NEWROOT = `customers/${CID}/adGroupCriteria/31~1000`;
  const fin = finalizeExtendedRollback(prepared.rollbackPayload as any, {
    results: [{ resourceName: ROOT }, { resourceName: NEWROOT }, {}, {}, {}].map((r) => r),
  }) as any;
  const rb = rbo(fin);
  assert.deepEqual(rb[0], { ad_group_criterion_operation: { remove: NEWROOT } });
  assert.deepEqual(rb[1].ad_group_criterion_operation.create, { ad_group: AG, status: 'ENABLED', cpc_bid_micros: 700000, listing_group: { type: 'UNIT' } });
  assert.equal(rollbackResourcesScoped(fin, CID), true);

  // A tree that is already subdivided is left alone.
  await refused('subdivide_shopping_listing_group', { ad_group_resource: AG, dimension: 'brand', values: ['Nike'] },
    fakeCustomer({ extra: (g) => (/FROM ad_group_criterion/.test(g) ? [{ adGroupCriterion: { resourceName: ROOT, listingGroup: { type: 'SUBDIVISION' } } }, { adGroupCriterion: { resourceName: ROOT + '1', listingGroup: { type: 'UNIT' } } }] : undefined) }),
    'tree_not_simple', AG);
});

test('PMax tree: filters with temp ids, others included by default or excluded on request', async () => {
  const ROOT = `customers/${CID}/assetGroupListingGroupFilters/41~900`;
  const rows = (gaql: string) =>
    /FROM asset_group_listing_group_filter/.test(gaql) && /parent_listing_group_filter/.test(gaql)
      ? [{ assetGroupListingGroupFilter: { resourceName: ROOT, type: 'UNIT_INCLUDED' } }]
      : undefined;
  const customer = fakeCustomer({ extra: rows });
  const prepared = await prepare('subdivide_pmax_listing_group', { asset_group_resource: ASSET_GROUP, dimension: 'brand', values: ['Nike'], others: 'exclude' }, customer, ASSET_GROUP);
  const ops = mut(prepared.action, customer);
  const t = (n: number) => `customers/${CID}/assetGroupListingGroupFilters/41~-${n}`;
  assert.equal(ops.length, 4);
  assert.deepEqual(ops[0], { asset_group_listing_group_filter_operation: { remove: ROOT } });
  assert.deepEqual(ops[1].asset_group_listing_group_filter_operation.create, { resource_name: t(1), asset_group: ASSET_GROUP, type: 'SUBDIVISION', listing_source: 'SHOPPING' });
  assert.equal(ops[2].asset_group_listing_group_filter_operation.create.type, 'UNIT_INCLUDED');
  assert.equal(ops[3].asset_group_listing_group_filter_operation.create.type, 'UNIT_EXCLUDED');
  assert.deepEqual(ops[3].asset_group_listing_group_filter_operation.create.case_value, { product_brand: {} });

  const plain = await prepare('subdivide_pmax_listing_group', { asset_group_resource: ASSET_GROUP, dimension: 'brand', values: ['Nike'] }, customer, ASSET_GROUP);
  assert.equal(mut(plain.action, customer)[3].asset_group_listing_group_filter_operation.create.type, 'UNIT_INCLUDED');

  const NEWROOT = `customers/${CID}/assetGroupListingGroupFilters/41~1000`;
  const fin = finalizeExtendedRollback(prepared.rollbackPayload as any, { results: [{ resourceName: ROOT }, { resourceName: NEWROOT }, {}, {}] }) as any;
  const rb = rbo(fin);
  assert.deepEqual(rb[0], { asset_group_listing_group_filter_operation: { remove: NEWROOT } });
  assert.deepEqual(rb[1].asset_group_listing_group_filter_operation.create, { asset_group: ASSET_GROUP, type: 'UNIT_INCLUDED', listing_source: 'SHOPPING' });
});

test('rollback refuses a resource that was not part of the change', () => {
  const payload = {
    reversible: true,
    action_type: 'ext_struct_rollback',
    touched_resources: [C1],
    steps: [{ op: 'remove', kind: 'campaign_budget', name: B2 }],
  };
  assert.throws(() => buildRollbackOperations(payload as any), /not part of the original change/);
  assert.throws(() => buildRollbackOperations({ ...payload, steps: [] } as any), /supported rollback/);
});

test('unprepared structure action cannot be built', () => {
  assert.throws(() => buildMutateOperations(action('set_ai_max', { campaign_resource: C1, enabled: true }, C1), null), /not prepared/);
});

test('preview rows are Arabic and carry no dashes', () => {
  const samples: Array<[string, Record<string, unknown>]> = [
    ['set_ai_max', { campaign_resource: C1, enabled: true }],
    ['add_placement_exclusions', { level: 'account', placements: [{ kind: 'content_label', value: 'JUVENILE' }, { kind: 'website', value: 'a.com' }] }],
    ['create_shared_budget', { name: 'x y', amount_micros: 100_000_000, campaign_resources: [C1, C2] }],
    ['attach_shared_budget', { budget_resource: BS, campaign_resources: [C1] }],
    ['detach_shared_budget', { campaign_resource: C1, amount_micros: 10_000_000 }],
    ['create_portfolio_strategy', { name: 'x y', strategy_type: 'TARGET_CPA', target_cpa_micros: 25_000_000, campaign_resources: [C1, C2] }],
    ['attach_portfolio_strategy', { strategy_resource: STRAT, campaign_resources: [C1] }],
    ['detach_portfolio_strategy', { campaign_resource: C1, to: 'MAXIMIZE_CONVERSIONS' }],
    ['subdivide_shopping_listing_group', { ad_group_resource: AG, dimension: 'brand', values: ['Nike'] }],
    ['subdivide_pmax_listing_group', { asset_group_resource: ASSET_GROUP, dimension: 'category', values: ['166'], others: 'exclude' }],
  ];
  for (const [op, params] of samples) {
    const rows = extendedPreviewRows(op, params);
    assert.ok(rows.length > 0, op);
    for (const row of rows) {
      assert.doesNotMatch(row.label + row.value, /[–—]/);
      assert.doesNotMatch(row.label, /,/);
    }
  }
});

test('readback: AI Max and shared budget', async () => {
  const on = fakeCustomer({ campaigns: { [C1]: { ai: true } } });
  const a = action('set_ai_max', { campaign_resource: C1, enabled: true, resolved: {} }, C1);
  assert.equal((await readbackExtendedAction(a, on)).status, 'verified');
  const off = fakeCustomer({ campaigns: { [C1]: { ai: false } } });
  assert.equal((await readbackExtendedAction(a, off)).status, 'mismatch');
  const shared = fakeCustomer({ campaigns: { [C1]: { budget: BS, shared: true, amount: '100000000' }, [C2]: { budget: BS, shared: true, amount: '100000000' } } });
  const b = action('create_shared_budget', { name: 'x y', amount_micros: 100_000_000, campaign_resources: [C1, C2], resolved: {} }, C1);
  assert.equal((await readbackExtendedAction(b, shared)).status, 'verified');
  const split = fakeCustomer({ campaigns: { [C1]: { budget: B1 }, [C2]: { budget: B2 } } });
  assert.equal((await readbackExtendedAction(b, split)).status, 'mismatch');
  const broken = { query: async () => { throw new Error('boom'); } };
  assert.equal((await readbackExtendedAction(a, broken)).status, 'unavailable');
});

test('guardrails: budget and bidding structure actions lock per campaign', async () => {
  const history = (rows: any[]) => ({
    from(table: string) {
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain,
        gte: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: { customer_id: CID }, error: null }),
      };
      return chain;
    },
  });
  const budget = action('create_shared_budget', ok('create_shared_budget', C1, { name: 'x y', amount_micros: 100_000_000, campaign_resources: [C1, C2] }), C1);
  const recent = [{ action_type: 'attach_shared_budget', created_at: new Date().toISOString(), payload: { action: { params: { campaign_resources: [C2] } } } }];
  const locked = await checkExtendedGuardrails(budget, 'acc', history(recent), { applyLocks: true });
  assert.deepEqual(locked, { ok: false, code: 'budget_locked_recent_change' });
  const free = await checkExtendedGuardrails(budget, 'acc', history([]), { applyLocks: true });
  assert.deepEqual(free, { ok: true });
  const noLocks = await checkExtendedGuardrails(budget, 'acc', history(recent), { applyLocks: false });
  assert.deepEqual(noLocks, { ok: true });
  const bid = action('detach_portfolio_strategy', ok('detach_portfolio_strategy', C1, { campaign_resource: C1, to: 'MAXIMIZE_CONVERSIONS' }), C1);
  const bidRows = [{ action_type: 'create_portfolio_strategy', created_at: new Date().toISOString(), payload: { action: { params: { campaign_resources: [C1, C2] } } } }];
  assert.deepEqual(await checkExtendedGuardrails(bid, 'acc', history(bidRows), { applyLocks: true }), { ok: false, code: 'bidding_locked_recent_change' });
});
