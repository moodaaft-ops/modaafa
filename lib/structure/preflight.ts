import type { OptimizerAction } from '../ai/optimizer-agent';
import type { MeasurementDescriptor } from '../ai/execution-preflight';
import { evaluateBudgetBounds } from '../ai/optimizer-gates';
import { esc } from '../ads/rows';
import {
  AI_MAX_BIDDING,
  AI_MAX_MIN_CONVERSIONS_30D,
  CAMPAIGN_PLACEMENT_CHANNELS,
  NEUTRAL_BUDGET_DELTA_PCT,
  PORTFOLIO_CHANNELS,
  PORTFOLIO_STRATEGIES,
  PORTFOLIO_TARGET_BAND,
  PORTFOLIO_TARGET_MIN_CONVERSIONS_30D,
  SHARED_BUDGET_CHANNELS,
  type StructureOperation,
} from './types';
import { cidOf, planStructure, structureRollbackPayload, type BiddingState } from './plan';

/**
 * Pre-execution reads for the account-structure actions. Everything the live
 * mutate needs is read from the account HERE and stored in `params.resolved`;
 * the executor sends exactly that. A stored payload never carries `resolved`.
 */

export class StructurePreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StructurePreflightError';
  }
}

const refuse = (code: string, message: string): never => {
  throw new StructurePreflightError(code, message);
};

export type StructurePrepared = {
  action: OptimizerAction;
  rollbackPayload: Record<string, unknown>;
  measurement: MeasurementDescriptor | null;
};

export type StructurePreflightDeps = {
  readSevenDayMetrics(
    customer: any,
    fromClause: string,
    whereField: string,
    resourceName: string
  ): Promise<{ cost: number; clicks: number; conversions: number; conversion_value: number } | null>;
};

type GaqlCustomer = { query(gaql: string): Promise<any[]> };

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? 0 : n;
};
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const pick = (o: any, camel: string, snake: string) => (o && typeof o === 'object' ? (o[camel] !== undefined ? o[camel] : o[snake]) : undefined);

// ---------------------------------------------------------------------------
// Campaign reads
// ---------------------------------------------------------------------------

export type CampaignFacts = {
  resource: string;
  name: string;
  status: string;
  channel: string;
  bidding_type: string;
  portfolio: string | null;
  budget: string;
  budget_amount_micros: number;
  budget_shared: boolean;
  ai_max: boolean;
  previous_bidding: BiddingState | null;
  cost_30d: number;
  conversions_30d: number;
  value_30d: number;
};

function previousBidding(campaign: any, type: string): BiddingState | null {
  const mc = pick(campaign, 'maximizeConversions', 'maximize_conversions');
  const mv = pick(campaign, 'maximizeConversionValue', 'maximize_conversion_value');
  const tc = pick(campaign, 'targetCpa', 'target_cpa');
  const tr = pick(campaign, 'targetRoas', 'target_roas');
  if (type === 'MAXIMIZE_CONVERSIONS') {
    const t = num(pick(mc, 'targetCpaMicros', 'target_cpa_micros'));
    return { type, target_cpa_micros: t > 0 ? t : null };
  }
  if (type === 'MAXIMIZE_CONVERSION_VALUE') {
    const t = num(pick(mv, 'targetRoas', 'target_roas'));
    return { type, target_roas: t > 0 ? t : null };
  }
  if (type === 'TARGET_CPA') {
    const t = num(pick(tc, 'targetCpaMicros', 'target_cpa_micros'));
    return t > 0 ? { type, target_cpa_micros: t } : null;
  }
  if (type === 'TARGET_ROAS') {
    const t = num(pick(tr, 'targetRoas', 'target_roas'));
    return t > 0 ? { type, target_roas: t } : null;
  }
  return null;
}

export async function readCampaignFacts(customer: GaqlCustomer, resources: string[]): Promise<CampaignFacts[]> {
  const inList = resources.map((r) => `'${esc(r)}'`).join(', ');
  const rows = await customer.query(`
    SELECT campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type,
      campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.campaign_budget,
      campaign.ai_max_setting.enable_ai_max,
      campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
      campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
      campaign_budget.amount_micros, campaign_budget.explicitly_shared
    FROM campaign
    WHERE campaign.resource_name IN (${inList})
  `);
  const metricRows = await customer.query(`
    SELECT campaign.resource_name, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE campaign.resource_name IN (${inList}) AND segments.date DURING LAST_30_DAYS
  `);
  const metrics = new Map<string, { cost: number; conv: number; value: number }>();
  for (const row of metricRows ?? []) {
    const name = str(pick(row?.campaign, 'resourceName', 'resource_name'));
    const m = row?.metrics ?? {};
    const prev = metrics.get(name) ?? { cost: 0, conv: 0, value: 0 };
    metrics.set(name, {
      cost: prev.cost + num(pick(m, 'costMicros', 'cost_micros')),
      conv: prev.conv + num(m.conversions),
      value: prev.value + num(pick(m, 'conversionsValue', 'conversions_value')),
    });
  }
  const out: CampaignFacts[] = [];
  for (const row of rows ?? []) {
    const c = row?.campaign ?? {};
    const b = pick(row, 'campaignBudget', 'campaign_budget') ?? {};
    const resource = str(pick(c, 'resourceName', 'resource_name'));
    const type = str(pick(c, 'biddingStrategyType', 'bidding_strategy_type'));
    const portfolio = str(pick(c, 'biddingStrategy', 'bidding_strategy'));
    const m = metrics.get(resource) ?? { cost: 0, conv: 0, value: 0 };
    out.push({
      resource,
      name: str(c.name),
      status: str(c.status),
      channel: str(pick(c, 'advertisingChannelType', 'advertising_channel_type')),
      bidding_type: type,
      portfolio: portfolio || null,
      budget: str(pick(c, 'campaignBudget', 'campaign_budget')),
      budget_amount_micros: num(pick(b, 'amountMicros', 'amount_micros')),
      budget_shared: (pick(b, 'explicitlyShared', 'explicitly_shared') as unknown) === true,
      ai_max: pick(pick(c, 'aiMaxSetting', 'ai_max_setting'), 'enableAiMax', 'enable_ai_max') === true,
      previous_bidding: portfolio ? null : previousBidding(c, type),
      cost_30d: m.cost,
      conversions_30d: m.conv,
      value_30d: m.value,
    });
  }
  return out;
}

async function facts(customer: GaqlCustomer, resources: string[]): Promise<CampaignFacts[]> {
  const found = await readCampaignFacts(customer, resources);
  for (const resource of resources) {
    const hit = found.find((c) => c.resource === resource);
    if (!hit) refuse('campaign_not_found', 'A campaign could not be read before execution');
    if (hit!.status === 'REMOVED') refuse('campaign_removed', 'A campaign is removed');
  }
  return resources.map((r) => found.find((c) => c.resource === r)!);
}

/** Step check for a change of the combined daily capacity. Spend-neutral restructures pass. */
export function checkCapacityStep(beforeMicros: number, afterMicros: number): { ok: true } | { ok: false; code: string } {
  if (!(beforeMicros > 0) || !(afterMicros > 0)) return { ok: false, code: 'budget_unreadable' };
  const pct = Math.abs(((afterMicros - beforeMicros) / beforeMicros) * 100);
  if (pct < NEUTRAL_BUDGET_DELTA_PCT) return { ok: true };
  const verdict = evaluateBudgetBounds({
    current_amount_micros: beforeMicros,
    new_amount_micros: afterMicros,
    delta_pct: ((afterMicros - beforeMicros) / beforeMicros) * 100,
  });
  return verdict.ok ? { ok: true } : { ok: false, code: (verdict as any).code ?? 'budget_step_invalid' };
}

async function metricsMeasurement(
  deps: StructurePreflightDeps,
  customer: any,
  campaign: string | null,
  capturedAt: string
): Promise<MeasurementDescriptor | null> {
  if (!campaign) return null;
  const before = await deps.readSevenDayMetrics(customer, 'campaign', 'campaign.resource_name', campaign);
  return { level: 'campaign', resource: campaign, window_days: 7, before, captured_at: capturedAt };
}

function withResolved(action: OptimizerAction, resolved: Record<string, unknown>): OptimizerAction {
  return { ...action, params: { ...action.params, resolved } };
}

function finish(action: OptimizerAction, resolved: Record<string, unknown>, measurement: MeasurementDescriptor | null): StructurePrepared {
  const prepared = withResolved(action, resolved);
  const plan = planStructure(action.type, prepared.params as Record<string, any>, resolved);
  return { action: prepared, rollbackPayload: structureRollbackPayload(plan.steps, plan.touched), measurement };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function prepareStructureAction(
  action: OptimizerAction,
  customer: any,
  deps: StructurePreflightDeps
): Promise<StructurePrepared> {
  const capturedAt = new Date().toISOString();
  const params = action.params as Record<string, any>;
  const operation = action.type as StructureOperation;

  switch (operation) {
    case 'set_ai_max': {
      const [campaign] = await facts(customer, [params.campaign_resource]);
      if (campaign.channel !== 'SEARCH') refuse('ai_max_search_only', 'AI Max works on Search campaigns only');
      if (campaign.ai_max === params.enabled) refuse('no_change', 'AI Max already has this setting');
      if (params.enabled) {
        if (!AI_MAX_BIDDING.has(campaign.bidding_type)) {
          refuse('ai_max_needs_smart_bidding', `${campaign.bidding_type || 'This strategy'} is not Smart Bidding on conversions`);
        }
        if (campaign.conversions_30d < AI_MAX_MIN_CONVERSIONS_30D) {
          refuse('ai_max_needs_conversions', `AI Max needs ${AI_MAX_MIN_CONVERSIONS_30D} conversions in 30 days`);
        }
      }
      return finish(action, { previous: campaign.ai_max }, await metricsMeasurement(deps, customer, campaign.resource, capturedAt));
    }

    case 'add_placement_exclusions': {
      const account = params.level === 'account';
      let campaignFact: CampaignFacts | null = null;
      if (!account) {
        [campaignFact] = await facts(customer, [params.campaign_resource]);
        if (!CAMPAIGN_PLACEMENT_CHANNELS.has(campaignFact.channel)) {
          refuse('campaign_level_not_supported', `${campaignFact.channel} takes placement exclusions at account level`);
        }
      }
      const existing = new Set<string>();
      const rows = account
        ? await customer.query(`
            SELECT customer_negative_criterion.placement.url, customer_negative_criterion.youtube_channel.channel_id,
              customer_negative_criterion.youtube_video.video_id, customer_negative_criterion.mobile_application.app_id,
              customer_negative_criterion.content_label.type
            FROM customer_negative_criterion
            WHERE customer_negative_criterion.type IN ('PLACEMENT', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'MOBILE_APPLICATION', 'CONTENT_LABEL')
          `)
        : await customer.query(`
            SELECT campaign_criterion.placement.url, campaign_criterion.youtube_channel.channel_id,
              campaign_criterion.youtube_video.video_id, campaign_criterion.mobile_application.app_id,
              campaign_criterion.content_label.type
            FROM campaign_criterion
            WHERE campaign_criterion.campaign = '${esc(params.campaign_resource)}'
              AND campaign_criterion.negative = TRUE
              AND campaign_criterion.type IN ('PLACEMENT', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'MOBILE_APPLICATION', 'CONTENT_LABEL')
          `);
      for (const row of rows ?? []) {
        const c = account ? pick(row, 'customerNegativeCriterion', 'customer_negative_criterion') : pick(row, 'campaignCriterion', 'campaign_criterion');
        if (!c) continue;
        const url = str(c.placement?.url);
        const channel = str(pick(c.youtubeChannel ?? c.youtube_channel, 'channelId', 'channel_id'));
        const video = str(pick(c.youtubeVideo ?? c.youtube_video, 'videoId', 'video_id'));
        const app = str(pick(c.mobileApplication ?? c.mobile_application, 'appId', 'app_id'));
        const label = str((c.contentLabel ?? c.content_label)?.type);
        if (url) existing.add(`website:${url.toLowerCase().replace(/^www\./, '')}`);
        if (channel) existing.add(`youtube_channel:${channel}`);
        if (video) existing.add(`youtube_video:${video}`);
        if (app) existing.add(`mobile_app:${app}`);
        if (label) existing.add(`content_label:${label}`);
      }
      const toCreate = (params.placements as Array<{ kind: string; value: string }>).filter((p) => !existing.has(`${p.kind}:${p.value}`));
      if (toCreate.length === 0) refuse('nothing_to_add', 'Every placement is already excluded');
      const customerId = account ? (/^customers\/(\d+)/.exec(String(action.target_id))?.[1] ?? '') : cidOf(params.campaign_resource);
      if (!customerId) refuse('customer_unknown', 'The account id is unavailable');
      return finish(
        action,
        { customer_id: customerId, to_create: toCreate, skipped: params.placements.length - toCreate.length },
        campaignFact ? await metricsMeasurement(deps, customer, campaignFact.resource, capturedAt) : null
      );
    }

    case 'create_shared_budget': {
      const campaigns = await facts(customer, params.campaign_resources);
      for (const c of campaigns) {
        if (!SHARED_BUDGET_CHANNELS.has(c.channel)) refuse('channel_not_supported', `${c.channel} cannot use a shared budget`);
        if (c.budget_shared) refuse('already_shared_budget', 'A campaign already spends from a shared budget; attach to it instead');
      }
      const distinct = new Set(campaigns.map((c) => c.budget));
      if (distinct.size !== campaigns.length) refuse('budget_not_exclusive', 'Two campaigns already share one budget');
      const before = campaigns.reduce((sum, c) => sum + c.budget_amount_micros, 0);
      const step = checkCapacityStep(before, params.amount_micros);
      if (!step.ok) refuse(step.code, 'The shared budget changes the total daily budget by more than the allowed step');
      const taken = await customer.query(
        `SELECT campaign_budget.resource_name FROM campaign_budget WHERE campaign_budget.name = '${esc(params.name)}' AND campaign_budget.status != 'REMOVED' LIMIT 1`
      );
      if ((taken ?? []).length > 0) refuse('name_taken', 'A budget with this name already exists');
      return finish(
        action,
        {
          customer_id: cidOf(params.campaign_resources[0]),
          before_total_micros: before,
          campaigns: campaigns.map((c) => ({ resource: c.resource, budget: c.budget, amount_micros: c.budget_amount_micros })),
        },
        await metricsMeasurement(deps, customer, campaigns[0].resource, capturedAt)
      );
    }

    case 'attach_shared_budget': {
      const budgetRows = await customer.query(`
        SELECT campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.status
        FROM campaign_budget WHERE campaign_budget.resource_name = '${esc(params.budget_resource)}' LIMIT 1
      `);
      const budget = budgetRows?.[0]?.campaignBudget ?? budgetRows?.[0]?.campaign_budget;
      if (!budget) refuse('budget_not_found', 'The shared budget could not be read');
      if (pick(budget, 'explicitlyShared', 'explicitly_shared') !== true) refuse('budget_not_shared', 'This budget is not a shared budget');
      const shared = num(pick(budget, 'amountMicros', 'amount_micros'));
      const campaigns = await facts(customer, params.campaign_resources);
      for (const c of campaigns) {
        if (!SHARED_BUDGET_CHANNELS.has(c.channel)) refuse('channel_not_supported', `${c.channel} cannot use a shared budget`);
        if (c.budget === params.budget_resource) refuse('already_attached', 'A campaign already uses this budget');
        if (c.budget_shared) refuse('already_shared_budget', 'A campaign already spends from another shared budget');
      }
      // The campaigns drop their own budgets and spend from one amount: capacity before is the sum.
      const before = shared + campaigns.reduce((sum, c) => sum + c.budget_amount_micros, 0);
      const step = checkCapacityStep(before, shared);
      if (!step.ok) refuse(step.code, 'Joining the shared budget cuts the total daily budget by more than the allowed step');
      return finish(
        action,
        { before_total_micros: before, shared_amount_micros: shared, campaigns: campaigns.map((c) => ({ resource: c.resource, budget: c.budget })) },
        await metricsMeasurement(deps, customer, campaigns[0].resource, capturedAt)
      );
    }

    case 'detach_shared_budget': {
      const [campaign] = await facts(customer, [params.campaign_resource]);
      if (!campaign.budget_shared) refuse('budget_not_shared', 'The campaign does not spend from a shared budget');
      if (campaign.budget_amount_micros <= 0) refuse('budget_unreadable', 'The shared budget amount could not be read');
      // The shared budget stays as it is for the others; the detached campaign gets its own on top.
      const step = checkCapacityStep(campaign.budget_amount_micros, campaign.budget_amount_micros + params.amount_micros);
      if (!step.ok) refuse(step.code, 'The new own budget adds more than the allowed step to the total daily budget');
      return finish(
        action,
        {
          customer_id: cidOf(campaign.resource),
          shared_budget: campaign.budget,
          budget_name: `${campaign.name} ${Date.now().toString(36)}`.slice(0, 80),
          before_total_micros: campaign.budget_amount_micros,
        },
        await metricsMeasurement(deps, customer, campaign.resource, capturedAt)
      );
    }

    case 'create_portfolio_strategy':
    case 'attach_portfolio_strategy': {
      let strategyType = String(params.strategy_type ?? '');
      let targetCpa = params.target_cpa_micros as number | undefined;
      let targetRoas = params.target_roas as number | undefined;
      if (operation === 'attach_portfolio_strategy') {
        const rows = await customer.query(`
          SELECT bidding_strategy.resource_name, bidding_strategy.type, bidding_strategy.status,
            bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.target_roas.target_roas
          FROM bidding_strategy WHERE bidding_strategy.resource_name = '${esc(params.strategy_resource)}' LIMIT 1
        `);
        const strategy = rows?.[0]?.biddingStrategy ?? rows?.[0]?.bidding_strategy;
        if (!strategy) refuse('strategy_not_found', 'The bidding strategy could not be read');
        strategyType = str(strategy.type);
        if (!(PORTFOLIO_STRATEGIES as readonly string[]).includes(strategyType)) refuse('strategy_type_unsupported', `${strategyType} is not supported`);
        targetCpa = num(pick(pick(strategy, 'targetCpa', 'target_cpa'), 'targetCpaMicros', 'target_cpa_micros')) || undefined;
        targetRoas = num(pick(pick(strategy, 'targetRoas', 'target_roas'), 'targetRoas', 'target_roas')) || undefined;
      }
      const campaigns = await facts(customer, params.campaign_resources);
      for (const c of campaigns) {
        if (!PORTFOLIO_CHANNELS.has(c.channel)) refuse('channel_not_supported', `${c.channel} cannot join a portfolio strategy here`);
        if (c.portfolio) refuse('already_portfolio', 'A campaign already uses a portfolio strategy');
        if (!c.previous_bidding) refuse('bidding_not_restorable', `${c.bidding_type || 'This strategy'} cannot be restored by rollback`);
      }
      const conversions = campaigns.reduce((s, c) => s + c.conversions_30d, 0);
      if (conversions < PORTFOLIO_TARGET_MIN_CONVERSIONS_30D) {
        refuse('portfolio_needs_conversions', `The campaigns together need ${PORTFOLIO_TARGET_MIN_CONVERSIONS_30D} conversions in 30 days`);
      }
      const cost = campaigns.reduce((s, c) => s + c.cost_30d, 0);
      const value = campaigns.reduce((s, c) => s + c.value_30d, 0);
      // A numeric target must sit near what the campaigns actually deliver together (never invented).
      if (strategyType === 'TARGET_CPA') {
        if (!targetCpa) refuse('target_invalid', 'Target CPA is missing');
        const actual = cost / conversions;
        if (targetCpa! < actual * (1 - PORTFOLIO_TARGET_BAND) || targetCpa! > actual * (1 + PORTFOLIO_TARGET_BAND)) {
          refuse('target_far_from_actual', 'Target CPA is more than 20% away from the real pooled CPA');
        }
      }
      if (strategyType === 'TARGET_ROAS') {
        if (!targetRoas) refuse('target_invalid', 'Target ROAS is missing');
        if (!(cost > 0) || !(value > 0)) refuse('roas_unreadable', 'Pooled conversion value is unreadable');
        const actual = value / (cost / 1_000_000);
        if (targetRoas! < actual * (1 - PORTFOLIO_TARGET_BAND) || targetRoas! > actual * (1 + PORTFOLIO_TARGET_BAND)) {
          refuse('target_far_from_actual', 'Target ROAS is more than 20% away from the real pooled ROAS');
        }
      }
      if (operation === 'create_portfolio_strategy') {
        const taken = await customer.query(
          `SELECT bidding_strategy.resource_name FROM bidding_strategy WHERE bidding_strategy.name = '${esc(params.name)}' AND bidding_strategy.status != 'REMOVED' LIMIT 1`
        );
        if ((taken ?? []).length > 0) refuse('name_taken', 'A bidding strategy with this name already exists');
      }
      return finish(
        action,
        {
          customer_id: cidOf(params.campaign_resources[0]),
          pooled_conversions_30d: Math.round(conversions * 100) / 100,
          campaigns: campaigns.map((c) => ({ resource: c.resource, previous: c.previous_bidding })),
        },
        await metricsMeasurement(deps, customer, campaigns[0].resource, capturedAt)
      );
    }

    case 'detach_portfolio_strategy': {
      const [campaign] = await facts(customer, [params.campaign_resource]);
      if (!campaign.portfolio) refuse('not_in_portfolio', 'The campaign does not use a portfolio strategy');
      return finish(action, { strategy_resource: campaign.portfolio }, await metricsMeasurement(deps, customer, campaign.resource, capturedAt));
    }

    case 'subdivide_shopping_listing_group': {
      const adGroupId = /\/adGroups\/(\d+)$/.exec(params.ad_group_resource)?.[1] ?? '';
      const rows = await customer.query(`
        SELECT ad_group_criterion.resource_name, ad_group_criterion.cpc_bid_micros, ad_group_criterion.status,
          ad_group_criterion.listing_group.type, ad_group_criterion.listing_group.parent_ad_group_criterion
        FROM ad_group_criterion
        WHERE ad_group_criterion.ad_group = '${esc(params.ad_group_resource)}'
          AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED'
      `);
      const nodes = list(rows).map((r: any) => r?.adGroupCriterion ?? r?.ad_group_criterion).filter(Boolean);
      if (nodes.length !== 1) refuse('tree_not_simple', 'Only an ad group whose tree is a single "all products" node can be subdivided');
      const root = nodes[0];
      const listing = root.listingGroup ?? root.listing_group ?? {};
      if (str(listing.type) !== 'UNIT') refuse('tree_not_simple', 'The tree root is not a single node');
      const bid = num(pick(root, 'cpcBidMicros', 'cpc_bid_micros'));
      return finish(
        action,
        {
          customer_id: cidOf(params.ad_group_resource),
          ad_group_id: adGroupId,
          root: { resource_name: str(pick(root, 'resourceName', 'resource_name')), cpc_bid_micros: bid > 0 ? bid : null },
        },
        null
      );
    }

    case 'subdivide_pmax_listing_group': {
      const groupId = /\/assetGroups\/(\d+)$/.exec(params.asset_group_resource)?.[1] ?? '';
      const rows = await customer.query(`
        SELECT asset_group_listing_group_filter.resource_name, asset_group_listing_group_filter.type,
          asset_group_listing_group_filter.parent_listing_group_filter
        FROM asset_group_listing_group_filter
        WHERE asset_group_listing_group_filter.asset_group = '${esc(params.asset_group_resource)}'
      `);
      const nodes = list(rows)
        .map((r: any) => r?.assetGroupListingGroupFilter ?? r?.asset_group_listing_group_filter)
        .filter(Boolean);
      if (nodes.length !== 1) refuse('tree_not_simple', 'Only an asset group whose tree is a single "all products" node can be subdivided');
      const root = nodes[0];
      if (str(root.type) !== 'UNIT_INCLUDED') refuse('tree_not_simple', 'The tree root is not an included single node');
      return finish(
        action,
        { customer_id: cidOf(params.asset_group_resource), asset_group_id: groupId, root: { resource_name: str(pick(root, 'resourceName', 'resource_name')) } },
        null
      );
    }
  }
  return refuse('unknown_operation', `No preflight for ${String(operation)}`);
}
