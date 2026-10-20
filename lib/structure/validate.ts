import {
  CONTENT_LABELS,
  DETACH_TARGETS,
  LISTING_DIMENSIONS,
  MAX_PLACEMENTS_PER_ACTION,
  MAX_SHARED_NAME,
  MAX_STRUCTURE_CAMPAIGNS,
  MAX_SUBDIVISION_VALUES,
  MIN_PORTFOLIO_CAMPAIGNS,
  MIN_SHARED_BUDGET_CAMPAIGNS,
  PLACEMENT_KINDS,
  PORTFOLIO_STRATEGIES,
  type PlacementKind,
  type StructureOperation,
} from './types';

/**
 * Pure payload validators for the account-structure actions. Same contract as
 * lib/ai/extended-actions/validate.ts: the canonical target_id and params to
 * store and execute (built from a whitelist, so a stored payload can never
 * carry `resolved`), or a short refusal code. Nothing here talks to Google.
 */

export type StructureValidation =
  | { ok: true; target_id: string; params: Record<string, unknown> }
  | { ok: false; code: string };

const bad = (code: string): StructureValidation => ({ ok: false, code });

export function resourceIn(value: unknown, type: string, customerId?: string | null): value is string {
  if (typeof value !== 'string') return false;
  const cid = customerId ? customerId.replace(/\D/g, '') : '\\d+';
  if (customerId && !cid) return false;
  return new RegExp(`^customers/${cid}/${type}/\\d+$`).test(value);
}

const DASHES = /[\u2013\u2014]/;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > MAX_SHARED_NAME) return null;
  if (INVISIBLE.test(name) || DASHES.test(name) || /[<>"'\\]/.test(name)) return null;
  return name;
}

function campaignList(value: unknown, min: number, customerId?: string | null): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_STRUCTURE_CAMPAIGNS) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!resourceIn(item, 'campaigns', customerId)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out.length >= min ? out : null;
}

function positiveInt(value: unknown, max: number): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n > max) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

const YT_CHANNEL = /^UC[\w-]{22}$/;
const YT_VIDEO = /^[\w-]{11}$/;
const MOBILE_APP = /^[12]-[\w.]{2,150}$/;
const HOST = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** A website placement is a host (the API takes a domain or a URL): lowercase, no scheme, no www, no path. */
export function normalizePlacementHost(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw || /\s/.test(raw)) return null;
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').replace(/:\d+$/, '');
  return HOST.test(host) ? host : null;
}

export function cleanPlacement(item: unknown): { kind: PlacementKind; value: string } | null {
  if (!item || typeof item !== 'object') return null;
  const kind = (item as any).kind;
  const raw = (item as any).value;
  if (!(PLACEMENT_KINDS as readonly string[]).includes(kind) || typeof raw !== 'string') return null;
  const value = raw.trim();
  switch (kind as PlacementKind) {
    case 'website': {
      const host = normalizePlacementHost(value);
      return host ? { kind, value: host } : null;
    }
    case 'youtube_channel':
      return YT_CHANNEL.test(value) ? { kind, value } : null;
    case 'youtube_video':
      return YT_VIDEO.test(value) ? { kind, value } : null;
    case 'mobile_app':
      return MOBILE_APP.test(value) ? { kind, value } : null;
    case 'content_label': {
      const label = value.toUpperCase();
      return (CONTENT_LABELS as readonly string[]).includes(label) ? { kind, value: label } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Listing groups
// ---------------------------------------------------------------------------

export type SubdivisionDimension = 'brand' | 'product_type' | 'category' | 'custom_label' | 'item_id';

export function cleanSubdivision(params: Record<string, unknown>): {
  dimension: SubdivisionDimension;
  values: string[];
  level: number;
  custom_label_index: number | null;
} | null {
  const dimension = params.dimension;
  if (!(LISTING_DIMENSIONS as readonly string[]).includes(dimension as string)) return null;
  if (!Array.isArray(params.values) || params.values.length < 1 || params.values.length > MAX_SUBDIVISION_VALUES) return null;
  const values: string[] = [];
  for (const raw of params.values) {
    if (typeof raw !== 'string') return null;
    const value = raw.replace(/\s+/g, ' ').trim();
    if (!value || value.length > 120 || INVISIBLE.test(value)) return null;
    if (dimension === 'category' && !/^\d{1,12}$/.test(value)) return null;
    if (dimension === 'item_id' && value.length > 50) return null;
    if (!values.some((v) => v.toLowerCase() === value.toLowerCase())) values.push(value);
  }
  let level = 1;
  if (dimension === 'product_type' || dimension === 'category') {
    const given = params.level === undefined ? 1 : positiveInt(params.level, 5);
    if (!given) return null;
    level = given;
  }
  let index: number | null = null;
  if (dimension === 'custom_label') {
    const n = typeof params.custom_label_index === 'number' ? params.custom_label_index : Number.NaN;
    if (!Number.isInteger(n) || n < 0 || n > 4) return null;
    index = n;
  }
  return { dimension: dimension as SubdivisionDimension, values, level, custom_label_index: index };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateStructurePayload(
  operation: StructureOperation,
  targetId: string,
  paramsInput: unknown,
  customerId?: string | null
): StructureValidation {
  const params = paramsInput && typeof paramsInput === 'object' ? (paramsInput as Record<string, unknown>) : {};

  switch (operation) {
    case 'set_ai_max': {
      const campaign = String(params.campaign_resource ?? '');
      if (!resourceIn(campaign, 'campaigns', customerId)) return bad('campaign_invalid');
      if (typeof params.enabled !== 'boolean') return bad('enabled_invalid');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, enabled: params.enabled } };
    }

    case 'add_placement_exclusions': {
      const level = params.level;
      if (level !== 'account' && level !== 'campaign') return bad('level_invalid');
      let campaign = '';
      if (level === 'campaign') {
        campaign = String(params.campaign_resource ?? '');
        if (!resourceIn(campaign, 'campaigns', customerId)) return bad('campaign_invalid');
      }
      if (!Array.isArray(params.placements) || params.placements.length < 1 || params.placements.length > MAX_PLACEMENTS_PER_ACTION) {
        return bad('placements_invalid');
      }
      const placements: Array<{ kind: PlacementKind; value: string }> = [];
      for (const item of params.placements) {
        const clean = cleanPlacement(item);
        if (!clean) return bad('placement_invalid');
        if (!placements.some((p) => p.kind === clean.kind && p.value === clean.value)) placements.push(clean);
      }
      const out: Record<string, unknown> = { level, placements };
      if (level === 'campaign') out.campaign_resource = campaign;
      const targetKey = level === 'campaign' ? campaign : `customers/${customerId ?? ''}`;
      return { ok: true, target_id: targetKey, params: out };
    }

    case 'create_shared_budget': {
      const name = cleanName(params.name);
      if (!name) return bad('name_invalid');
      const amount = positiveInt(params.amount_micros, 1e13);
      if (!amount || amount % 10_000 !== 0) return bad('amount_invalid');
      const campaigns = campaignList(params.campaign_resources, MIN_SHARED_BUDGET_CAMPAIGNS, customerId);
      if (!campaigns) return bad('campaigns_invalid');
      return { ok: true, target_id: campaigns[0], params: { name, amount_micros: amount, campaign_resources: campaigns } };
    }

    case 'attach_shared_budget': {
      const budget = String(params.budget_resource ?? '');
      if (!resourceIn(budget, 'campaignBudgets', customerId)) return bad('budget_invalid');
      const campaigns = campaignList(params.campaign_resources, 1, customerId);
      if (!campaigns) return bad('campaigns_invalid');
      return { ok: true, target_id: budget, params: { budget_resource: budget, campaign_resources: campaigns } };
    }

    case 'detach_shared_budget': {
      const campaign = String(params.campaign_resource ?? '');
      if (!resourceIn(campaign, 'campaigns', customerId)) return bad('campaign_invalid');
      const amount = positiveInt(params.amount_micros, 1e13);
      if (!amount || amount % 10_000 !== 0) return bad('amount_invalid');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, amount_micros: amount } };
    }

    case 'create_portfolio_strategy': {
      const name = cleanName(params.name);
      if (!name) return bad('name_invalid');
      const strategy = params.strategy_type;
      if (!(PORTFOLIO_STRATEGIES as readonly string[]).includes(strategy as string)) return bad('strategy_invalid');
      const campaigns = campaignList(params.campaign_resources, MIN_PORTFOLIO_CAMPAIGNS, customerId);
      if (!campaigns) return bad('campaigns_invalid');
      const out: Record<string, unknown> = { name, strategy_type: strategy, campaign_resources: campaigns };
      if (strategy === 'TARGET_CPA') {
        const cpa = positiveInt(params.target_cpa_micros, 1e12);
        if (!cpa || cpa % 10_000 !== 0) return bad('target_invalid');
        out.target_cpa_micros = cpa;
      } else if (strategy === 'TARGET_ROAS') {
        const roas = params.target_roas;
        if (typeof roas !== 'number' || !Number.isFinite(roas) || roas < 0.01 || roas > 1000) return bad('target_invalid');
        out.target_roas = Math.round(roas * 100) / 100;
      } else if (params.target_cpa_micros !== undefined || params.target_roas !== undefined) {
        return bad('target_not_allowed');
      }
      return { ok: true, target_id: campaigns[0], params: out };
    }

    case 'attach_portfolio_strategy': {
      const strategy = String(params.strategy_resource ?? '');
      if (!resourceIn(strategy, 'biddingStrategies', customerId)) return bad('strategy_invalid');
      const campaigns = campaignList(params.campaign_resources, 1, customerId);
      if (!campaigns) return bad('campaigns_invalid');
      return { ok: true, target_id: strategy, params: { strategy_resource: strategy, campaign_resources: campaigns } };
    }

    case 'detach_portfolio_strategy': {
      const campaign = String(params.campaign_resource ?? '');
      if (!resourceIn(campaign, 'campaigns', customerId)) return bad('campaign_invalid');
      if (!(DETACH_TARGETS as readonly string[]).includes(params.to as string)) return bad('target_invalid');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, to: params.to } };
    }

    case 'subdivide_shopping_listing_group': {
      const adGroup = String(params.ad_group_resource ?? '');
      if (!resourceIn(adGroup, 'adGroups', customerId)) return bad('ad_group_invalid');
      const clean = cleanSubdivision(params);
      if (!clean) return bad('subdivision_invalid');
      return {
        ok: true,
        target_id: adGroup,
        params: {
          ad_group_resource: adGroup,
          dimension: clean.dimension,
          values: clean.values,
          level: clean.level,
          custom_label_index: clean.custom_label_index,
        },
      };
    }

    case 'subdivide_pmax_listing_group': {
      const group = String(params.asset_group_resource ?? '');
      if (!resourceIn(group, 'assetGroups', customerId)) return bad('asset_group_invalid');
      const clean = cleanSubdivision(params);
      if (!clean) return bad('subdivision_invalid');
      const others = params.others === 'exclude' ? 'exclude' : 'include';
      return {
        ok: true,
        target_id: group,
        params: {
          asset_group_resource: group,
          dimension: clean.dimension,
          values: clean.values,
          level: clean.level,
          custom_label_index: clean.custom_label_index,
          others,
        },
      };
    }
  }
  return bad('unknown_operation');
}
