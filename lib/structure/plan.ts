import { toFieldMask } from '../google-ads/client';
import type { SubdivisionDimension } from './validate';

/**
 * Pure planning for the account-structure actions: the googleAds:mutate
 * operations (snake_case, the REST wrapper camelizes) and the declarative
 * rollback steps, both from the validated params plus the `resolved` block
 * that preflight read from the account. validateOnly, the live call and the
 * rollback record all come from this one function, so they cannot drift.
 *
 * Rollback steps are data, not code:
 *   { op: 'remove', kind, name | result_index }
 *   { op: 'update', kind: 'campaign', name, fields, paths }
 *   { op: 'create', kind, spec }
 * `result_index` is the position of the created resource in the mutate
 * results; finalizeStructureRollback turns it into the resource name.
 */

export type MutateOp = Record<string, Record<string, unknown>>;

export type RollbackKind =
  | 'campaign'
  | 'campaign_criterion'
  | 'customer_negative_criterion'
  | 'campaign_budget'
  | 'bidding_strategy'
  | 'ad_group_criterion'
  | 'asset_group_listing_group_filter';

export type RollbackStep =
  | { op: 'remove'; kind: RollbackKind; name?: string; result_index?: number }
  | { op: 'update'; kind: 'campaign'; name: string; fields: Record<string, unknown>; paths: string[] }
  | { op: 'create'; kind: RollbackKind; spec: Record<string, unknown> };

export type Planned = { operations: MutateOp[]; steps: RollbackStep[]; touched: string[] };

export const OPERATION_KEY: Record<RollbackKind, string> = {
  campaign: 'campaign_operation',
  campaign_criterion: 'campaign_criterion_operation',
  customer_negative_criterion: 'customer_negative_criterion_operation',
  campaign_budget: 'campaign_budget_operation',
  bidding_strategy: 'bidding_strategy_operation',
  ad_group_criterion: 'ad_group_criterion_operation',
  asset_group_listing_group_filter: 'asset_group_listing_group_filter_operation',
};

export type BiddingState =
  | { type: 'MAXIMIZE_CONVERSIONS'; target_cpa_micros: number | null }
  | { type: 'MAXIMIZE_CONVERSION_VALUE'; target_roas: number | null }
  | { type: 'TARGET_CPA'; target_cpa_micros: number }
  | { type: 'TARGET_ROAS'; target_roas: number };

/** The standalone bidding fields that put a campaign back on `state`. */
export function biddingFields(state: BiddingState): { fields: Record<string, unknown>; paths: string[] } {
  switch (state.type) {
    case 'MAXIMIZE_CONVERSIONS':
      return {
        fields: { maximize_conversions: state.target_cpa_micros ? { target_cpa_micros: state.target_cpa_micros } : {} },
        paths: ['maximize_conversions'],
      };
    case 'MAXIMIZE_CONVERSION_VALUE':
      return {
        fields: { maximize_conversion_value: state.target_roas ? { target_roas: state.target_roas } : {} },
        paths: ['maximize_conversion_value'],
      };
    case 'TARGET_CPA':
      return { fields: { target_cpa: { target_cpa_micros: state.target_cpa_micros } }, paths: ['target_cpa'] };
    case 'TARGET_ROAS':
      return { fields: { target_roas: { target_roas: state.target_roas } }, paths: ['target_roas'] };
  }
}

export function cidOf(resource: string): string {
  const m = /^customers\/(\d+)\//.exec(resource);
  if (!m) throw new Error('resource_invalid');
  return m[1];
}

const campaignUpdate = (name: string, fields: Record<string, unknown>, paths: string[]): MutateOp => ({
  campaign_operation: { update: { resource_name: name, ...fields }, update_mask: toFieldMask(paths) },
});

function prune<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

// ---------------------------------------------------------------------------
// Listing group cases
// ---------------------------------------------------------------------------

export function listingCase(
  dimension: SubdivisionDimension,
  value: string | null,
  level: number,
  index: number | null
): Record<string, unknown> {
  const lvl = `LEVEL${level}`;
  switch (dimension) {
    case 'brand':
      return { product_brand: value === null ? {} : { value } };
    case 'item_id':
      return { product_item_id: value === null ? {} : { value } };
    case 'product_type':
      return { product_type: value === null ? { level: lvl } : { level: lvl, value } };
    case 'category':
      return { product_category: value === null ? { level: lvl } : { level: lvl, category_id: Number(value) } };
    case 'custom_label':
      return { product_custom_attribute: value === null ? { index: `INDEX${index}` } : { index: `INDEX${index}`, value } };
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type Params = Record<string, any>;
type Resolved = Record<string, any>;

export function planStructure(type: string, params: Params, resolved: Resolved): Planned {
  switch (type) {
    case 'set_ai_max': {
      const campaign = params.campaign_resource as string;
      const previous = resolved.previous === true;
      return {
        operations: [campaignUpdate(campaign, { ai_max_setting: { enable_ai_max: params.enabled } }, ['ai_max_setting.enable_ai_max'])],
        steps: [{ op: 'update', kind: 'campaign', name: campaign, fields: { ai_max_setting: { enable_ai_max: previous } }, paths: ['ai_max_setting.enable_ai_max'] }],
        touched: [campaign],
      };
    }

    case 'add_placement_exclusions': {
      const placements = resolved.to_create as Array<{ kind: string; value: string }>;
      const account = params.level === 'account';
      const ops: MutateOp[] = [];
      for (const p of placements) {
        const info: Record<string, unknown> =
          p.kind === 'website' ? { placement: { url: p.value } }
          : p.kind === 'youtube_channel' ? { youtube_channel: { channel_id: p.value } }
          : p.kind === 'youtube_video' ? { youtube_video: { video_id: p.value } }
          : p.kind === 'mobile_app' ? { mobile_application: { app_id: p.value } }
          : { content_label: { type: p.value } };
        ops.push(
          account
            ? { customer_negative_criterion_operation: { create: info } }
            : { campaign_criterion_operation: { create: { campaign: params.campaign_resource, negative: true, ...info } } }
        );
      }
      const kind: RollbackKind = account ? 'customer_negative_criterion' : 'campaign_criterion';
      return {
        operations: ops,
        steps: placements.map((_, i) => ({ op: 'remove' as const, kind, result_index: i })),
        touched: account ? [] : [params.campaign_resource],
      };
    }

    case 'create_shared_budget': {
      const cid = resolved.customer_id as string;
      const temp = `customers/${cid}/campaignBudgets/-1`;
      const campaigns = resolved.campaigns as Array<{ resource: string; budget: string }>;
      const ops: MutateOp[] = [
        {
          campaign_budget_operation: {
            create: { resource_name: temp, name: params.name, amount_micros: params.amount_micros, delivery_method: 'STANDARD', explicitly_shared: true },
          },
        },
        ...campaigns.map((c) => campaignUpdate(c.resource, { campaign_budget: temp }, ['campaign_budget'])),
      ];
      const steps: RollbackStep[] = [
        ...campaigns.map((c): RollbackStep => ({ op: 'update', kind: 'campaign', name: c.resource, fields: { campaign_budget: c.budget }, paths: ['campaign_budget'] })),
        { op: 'remove', kind: 'campaign_budget', result_index: 0 },
      ];
      return { operations: ops, steps, touched: [...campaigns.map((c) => c.resource), ...campaigns.map((c) => c.budget)] };
    }

    case 'attach_shared_budget': {
      const campaigns = resolved.campaigns as Array<{ resource: string; budget: string }>;
      return {
        operations: campaigns.map((c) => campaignUpdate(c.resource, { campaign_budget: params.budget_resource }, ['campaign_budget'])),
        steps: campaigns.map((c): RollbackStep => ({ op: 'update', kind: 'campaign', name: c.resource, fields: { campaign_budget: c.budget }, paths: ['campaign_budget'] })),
        touched: [params.budget_resource, ...campaigns.map((c) => c.resource), ...campaigns.map((c) => c.budget)],
      };
    }

    case 'detach_shared_budget': {
      const cid = resolved.customer_id as string;
      const temp = `customers/${cid}/campaignBudgets/-1`;
      const campaign = params.campaign_resource as string;
      const shared = resolved.shared_budget as string;
      return {
        operations: [
          {
            campaign_budget_operation: {
              create: { resource_name: temp, name: resolved.budget_name, amount_micros: params.amount_micros, delivery_method: 'STANDARD', explicitly_shared: false },
            },
          },
          campaignUpdate(campaign, { campaign_budget: temp }, ['campaign_budget']),
        ],
        steps: [
          { op: 'update', kind: 'campaign', name: campaign, fields: { campaign_budget: shared }, paths: ['campaign_budget'] },
          { op: 'remove', kind: 'campaign_budget', result_index: 0 },
        ],
        touched: [campaign, shared],
      };
    }

    case 'create_portfolio_strategy': {
      const cid = resolved.customer_id as string;
      const temp = `customers/${cid}/biddingStrategies/-1`;
      const campaigns = resolved.campaigns as Array<{ resource: string; previous: BiddingState }>;
      const spec: Record<string, unknown> = { resource_name: temp, name: params.name };
      switch (params.strategy_type) {
        case 'MAXIMIZE_CONVERSIONS': spec.maximize_conversions = {}; break;
        case 'MAXIMIZE_CONVERSION_VALUE': spec.maximize_conversion_value = {}; break;
        case 'TARGET_CPA': spec.target_cpa = { target_cpa_micros: params.target_cpa_micros }; break;
        case 'TARGET_ROAS': spec.target_roas = { target_roas: params.target_roas }; break;
      }
      const ops: MutateOp[] = [
        { bidding_strategy_operation: { create: spec } },
        ...campaigns.map((c) => campaignUpdate(c.resource, { bidding_strategy: temp }, ['bidding_strategy'])),
      ];
      const steps: RollbackStep[] = [
        ...campaigns.map((c): RollbackStep => {
          const { fields, paths } = biddingFields(c.previous);
          return { op: 'update', kind: 'campaign', name: c.resource, fields, paths };
        }),
        { op: 'remove', kind: 'bidding_strategy', result_index: 0 },
      ];
      return { operations: ops, steps, touched: campaigns.map((c) => c.resource) };
    }

    case 'attach_portfolio_strategy': {
      const campaigns = resolved.campaigns as Array<{ resource: string; previous: BiddingState }>;
      return {
        operations: campaigns.map((c) => campaignUpdate(c.resource, { bidding_strategy: params.strategy_resource }, ['bidding_strategy'])),
        steps: campaigns.map((c): RollbackStep => {
          const { fields, paths } = biddingFields(c.previous);
          return { op: 'update', kind: 'campaign', name: c.resource, fields, paths };
        }),
        touched: [params.strategy_resource, ...campaigns.map((c) => c.resource)],
      };
    }

    case 'detach_portfolio_strategy': {
      const campaign = params.campaign_resource as string;
      const strategy = resolved.strategy_resource as string;
      const to: BiddingState =
        params.to === 'MAXIMIZE_CONVERSION_VALUE'
          ? { type: 'MAXIMIZE_CONVERSION_VALUE', target_roas: null }
          : { type: 'MAXIMIZE_CONVERSIONS', target_cpa_micros: null };
      const { fields, paths } = biddingFields(to);
      return {
        operations: [campaignUpdate(campaign, fields, paths)],
        steps: [{ op: 'update', kind: 'campaign', name: campaign, fields: { bidding_strategy: strategy }, paths: ['bidding_strategy'] }],
        touched: [campaign, strategy],
      };
    }

    case 'subdivide_shopping_listing_group': {
      const cid = resolved.customer_id as string;
      const adGroupId = resolved.ad_group_id as string;
      const bid = resolved.root.cpc_bid_micros as number | null;
      const temp = (n: number) => `customers/${cid}/adGroupCriteria/${adGroupId}~-${n}`;
      const adGroup = params.ad_group_resource as string;
      const unit = (n: number, value: string | null): MutateOp => ({
        ad_group_criterion_operation: {
          create: {
            resource_name: temp(n),
            ad_group: adGroup,
            status: 'ENABLED',
            ...prune({ cpc_bid_micros: bid }),
            listing_group: {
              type: 'UNIT',
              parent_ad_group_criterion: temp(1),
              case_value: listingCase(params.dimension, value, params.level, params.custom_label_index),
            },
          },
        },
      });
      const values = params.values as string[];
      const ops: MutateOp[] = [
        { ad_group_criterion_operation: { remove: resolved.root.resource_name } },
        {
          ad_group_criterion_operation: {
            create: { resource_name: temp(1), ad_group: adGroup, status: 'ENABLED', listing_group: { type: 'SUBDIVISION' } },
          },
        },
        ...values.map((v, i) => unit(i + 2, v)),
        unit(values.length + 2, null),
      ];
      return {
        operations: ops,
        steps: [
          { op: 'remove', kind: 'ad_group_criterion', result_index: 1 },
          {
            op: 'create',
            kind: 'ad_group_criterion',
            spec: { ad_group: adGroup, status: 'ENABLED', ...prune({ cpc_bid_micros: bid }), listing_group: { type: 'UNIT' } },
          },
        ],
        touched: [adGroup, resolved.root.resource_name],
      };
    }

    case 'subdivide_pmax_listing_group': {
      const cid = resolved.customer_id as string;
      const groupId = resolved.asset_group_id as string;
      const group = params.asset_group_resource as string;
      const temp = (n: number) => `customers/${cid}/assetGroupListingGroupFilters/${groupId}~-${n}`;
      const unit = (n: number, value: string | null, type: string): MutateOp => ({
        asset_group_listing_group_filter_operation: {
          create: {
            resource_name: temp(n),
            asset_group: group,
            type,
            listing_source: 'SHOPPING',
            parent_listing_group_filter: temp(1),
            case_value: listingCase(params.dimension, value, params.level, params.custom_label_index),
          },
        },
      });
      const values = params.values as string[];
      const ops: MutateOp[] = [
        { asset_group_listing_group_filter_operation: { remove: resolved.root.resource_name } },
        {
          asset_group_listing_group_filter_operation: {
            create: { resource_name: temp(1), asset_group: group, type: 'SUBDIVISION', listing_source: 'SHOPPING' },
          },
        },
        ...values.map((v, i) => unit(i + 2, v, 'UNIT_INCLUDED')),
        unit(values.length + 2, null, params.others === 'exclude' ? 'UNIT_EXCLUDED' : 'UNIT_INCLUDED'),
      ];
      return {
        operations: ops,
        steps: [
          { op: 'remove', kind: 'asset_group_listing_group_filter', result_index: 1 },
          {
            op: 'create',
            kind: 'asset_group_listing_group_filter',
            spec: { asset_group: group, type: 'UNIT_INCLUDED', listing_source: 'SHOPPING' },
          },
        ],
        touched: [group, resolved.root.resource_name],
      };
    }
  }
  throw new Error(`No plan for ${type}`);
}

// ---------------------------------------------------------------------------
// Rollback: finalize (result indexes to names) and build operations
// ---------------------------------------------------------------------------

export const STRUCTURE_ROLLBACK_TYPE = 'ext_struct_rollback';

export function structureRollbackPayload(steps: RollbackStep[], touched: string[]): Record<string, unknown> {
  return { reversible: true, action_type: STRUCTURE_ROLLBACK_TYPE, steps, touched_resources: [...new Set(touched.filter(Boolean))], struct_names: stepNames(steps) };
}

function specNames(spec: Record<string, unknown>): string[] {
  return ['ad_group', 'asset_group', 'campaign'].map((k) => spec[k]).filter((v): v is string => typeof v === 'string');
}

export function stepNames(steps: RollbackStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.op === 'remove' && step.name) out.push(step.name);
    if (step.op === 'update') {
      out.push(step.name);
      for (const v of Object.values(step.fields)) if (typeof v === 'string') out.push(v);
    }
    if (step.op === 'create') out.push(...specNames(step.spec));
  }
  return out;
}

function resultNames(result: any): string[] {
  const results: any[] = Array.isArray(result?.results) ? result.results : [];
  return results.map((r) => r?.resourceName ?? r?.resource_name).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export function finalizeStructureRollback(payload: Record<string, any>, result: unknown): Record<string, unknown> {
  const names = resultNames(result);
  const steps: RollbackStep[] = Array.isArray(payload.steps) ? payload.steps : [];
  const touched: string[] = Array.isArray(payload.touched_resources) ? [...payload.touched_resources] : [];
  const out: RollbackStep[] = [];
  for (const step of steps) {
    if (step.op === 'remove' && typeof step.result_index === 'number') {
      const name = names[step.result_index];
      if (!name) return { ...payload, reversible: false, note: 'created_resources_unavailable' };
      out.push({ op: 'remove', kind: step.kind, name });
      touched.push(name);
    } else {
      out.push(step);
    }
  }
  return { ...payload, steps: out, touched_resources: [...new Set(touched)], struct_names: stepNames(out) };
}

export function buildStructureRollbackOperations(rollback: Record<string, any>): MutateOp[] {
  const touched = new Set<string>(Array.isArray(rollback.touched_resources) ? rollback.touched_resources : []);
  const guard = (name: unknown): string => {
    if (typeof name !== 'string' || !name || !touched.has(name)) {
      throw new Error('Rollback names a resource that is not part of the original change');
    }
    return name;
  };
  const steps: RollbackStep[] = Array.isArray(rollback.steps) ? rollback.steps : [];
  if (steps.length === 0) throw new Error('This action does not have a supported rollback operation');
  const ops: MutateOp[] = [];
  for (const step of steps) {
    if (step.op === 'remove') {
      if (step.name === undefined) throw new Error('Rollback step has no resource name');
      ops.push({ [OPERATION_KEY[step.kind]]: { remove: guard(step.name) } });
    } else if (step.op === 'update') {
      guard(step.name);
      for (const v of Object.values(step.fields)) if (typeof v === 'string') guard(v);
      ops.push(campaignUpdate(step.name, step.fields, step.paths));
    } else if (step.op === 'create') {
      for (const n of specNames(step.spec)) guard(n);
      ops.push({ [OPERATION_KEY[step.kind]]: { create: step.spec } });
    } else {
      throw new Error('Rollback step is not recognised');
    }
  }
  return ops;
}
