import { allowableCpaCut, allowableCpaScale, type BreakEven } from '../economics/break-even';
import {
  conversionVerdict,
  type ConversionActionInfo,
  type DailyConversionPoint,
} from '../jarvis/tools/get-conversion-health';
import type { OptimizerSnapshot, SnapshotEconomics } from './optimizer-agent';
import { numOrNull, type Campaign30d, type CampaignDiag } from './optimizer-gates';

/**
 * Pure assembly of the parts of the optimizer snapshot that carry judgment:
 * the tracking verdict, the client's economics next to the account's history,
 * and the per-campaign diagnostics. The cron runs the queries; everything it
 * does with the answers lives here so it can be tested without Google.
 *
 * Rows come from the Google Ads client and may use snake_case or camelCase
 * keys, so every read goes through `pick`.
 */

function camel(segment: string) {
  return segment.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase());
}

function pick(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    const object = current as Record<string, unknown>;
    const c = camel(segment);
    current = object[c] !== undefined ? object[c] : object[segment];
  }
  return current;
}

function text(row: unknown, path: string): string {
  const raw = pick(row, path);
  return raw === undefined || raw === null ? '' : String(raw);
}

function flag(row: unknown, path: string): boolean | null {
  const raw = pick(row, path);
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Google writes "--" for a share it cannot compute; that is null, never zero. */
function share(row: unknown, path: string): number | null {
  const value = numOrNull(pick(row, path));
  return value === null ? null : round(value, 4);
}

const ENUM_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function enumName(row: unknown, path: string): string | null {
  const raw = pick(row, path);
  return typeof raw === 'string' && ENUM_NAME.test(raw) ? raw : null;
}

function enumList(row: unknown, path: string): string[] {
  const raw = pick(row, path);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && ENUM_NAME.test(item)).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Conversion tracking
// ---------------------------------------------------------------------------

type TrackingBlock = NonNullable<OptimizerSnapshot['conversion_tracking']>;

/**
 * The tracking verdict from the real health check. `actionRows` is the list of
 * enabled conversion actions, `dailyRows` the all_conversions per action per
 * day for 30 days. Either one failing to read is "unknown", never "healthy":
 * the verdict gates every money decision, so a blind spot must close the gate.
 */
export function buildConversionTracking(input: {
  actionRows: any[] | null;
  dailyRows: any[] | null;
  /**
   * The daily rows hit the query limit, so older days may be missing. The history
   * is then not trusted at all: a cut-short history can look like an action that
   * "went silent" (lib/ai/optimizer-queries.ts orders newest first, but a count
   * of days is still wrong). Without the history no `broken_recently` verdict is
   * possible and a healthy-looking account reads as `unknown`.
   */
  dailyTruncated?: boolean;
  clicks7d: number;
  conversions7d: number;
  today: string;
}): TrackingBlock {
  if (!input.actionRows) {
    return { status: 'unknown', enabled_actions: 0, note: 'Conversion actions could not be read.' };
  }

  const actions: ConversionActionInfo[] = input.actionRows.map((row) => ({
    name: text(row, 'conversion_action.name'),
    status: text(row, 'conversion_action.status') || 'ENABLED',
    category: text(row, 'conversion_action.category') || 'UNKNOWN',
    primaryForGoal: flag(row, 'conversion_action.primary_for_goal'),
    includeInConversionsMetric: flag(row, 'conversion_action.include_in_conversions_metric'),
  }));
  const daily: DailyConversionPoint[] | null = input.dailyRows && !input.dailyTruncated
    ? input.dailyRows.map((row) => ({
        date: text(row, 'segments.date'),
        action: text(row, 'segments.conversion_action_name'),
        conversions: numOrNull(pick(row, 'metrics.all_conversions')) ?? 0,
      }))
    : null;

  const result = conversionVerdict({
    actions,
    clicks7d: input.clicks7d,
    conversions7d: input.conversions7d,
    daily,
    autoTaggingEnabled: null,
    today: input.today,
  });
  const enabledActions = actions.filter((action) => action.status === 'ENABLED').length;
  const issues = result.issues
    .filter((issue) => issue.code !== 'auto_tagging_off')
    .map((issue) => ({
      code: issue.code,
      reason_ar: issue.reason_ar,
      ...(issue.actions ? { actions: issue.actions } : {}),
    }));

  if (result.verdict === 'healthy' && !daily) {
    // The "went silent" check could not run, so "healthy" would be a guess.
    return {
      status: 'unknown',
      enabled_actions: enabledActions,
      note: input.dailyTruncated
        ? 'The daily conversion history was cut short by the query limit, so a silent conversion action cannot be ruled out.'
        : 'The daily conversion history could not be read, so a silent conversion action cannot be ruled out.',
    };
  }
  return {
    status: result.verdict,
    enabled_actions: enabledActions,
    ...(issues.length > 0 ? { issues } : {}),
  };
}

// ---------------------------------------------------------------------------
// Campaign rows: diagnostics and 30-day totals
// ---------------------------------------------------------------------------

const CAMPAIGN_FIELDS_MOVED_TO_DIAG = [
  'advertising_channel_type',
  'bidding_strategy_type',
  'primary_status',
  'primary_status_reasons',
];
const METRIC_FIELDS_MOVED_TO_DIAG = [
  'impressions',
  'search_impression_share',
  'search_budget_lost_impression_share',
  'search_rank_lost_impression_share',
];

function withoutKeys<T extends Record<string, any>>(object: T | undefined, snakeKeys: string[]): Record<string, any> | undefined {
  if (!object || typeof object !== 'object') return object;
  const copy: Record<string, any> = { ...object };
  for (const key of snakeKeys) {
    delete copy[key];
    delete copy[camel(key)];
  }
  return copy;
}

export function campaignDiag(row: unknown): CampaignDiag {
  const impressions = numOrNull(pick(row, 'metrics.impressions'));
  return {
    type: enumName(row, 'campaign.advertising_channel_type'),
    bidding: enumName(row, 'campaign.bidding_strategy_type'),
    primary_status: enumName(row, 'campaign.primary_status'),
    status_reasons: enumList(row, 'campaign.primary_status_reasons'),
    impressions_7d: impressions === null ? null : Math.round(impressions),
    search_is: share(row, 'metrics.search_impression_share'),
    lost_budget_is: share(row, 'metrics.search_budget_lost_impression_share'),
    lost_rank_is: share(row, 'metrics.search_rank_lost_impression_share'),
  };
}

function campaign30d(row: unknown): Campaign30d {
  return {
    cost_micros: Math.round(numOrNull(pick(row, 'metrics.cost_micros')) ?? 0),
    conversions: round(numOrNull(pick(row, 'metrics.conversions')) ?? 0, 2),
    conversions_value: round(numOrNull(pick(row, 'metrics.conversions_value')) ?? 0, 2),
  };
}

/**
 * The 7-day campaign rows the model reads, with the new fields folded into a
 * compact `diag` object (and removed from where Google put them, so nothing is
 * said twice) and the 30-day totals attached as `last_30d`. When the 30-day
 * query failed (`rows30d` null) `last_30d` is absent and every gate that needs
 * it fails closed.
 */
export function enrichCampaignRows(rows: any[], rows30d: any[] | null): any[] {
  const byCampaign = new Map<string, Campaign30d>();
  for (const row of rows30d ?? []) {
    const resource = text(row, 'campaign.resource_name');
    if (!resource) continue;
    const prior = byCampaign.get(resource);
    const next = campaign30d(row);
    byCampaign.set(
      resource,
      prior
        ? {
            cost_micros: prior.cost_micros + next.cost_micros,
            conversions: round(prior.conversions + next.conversions, 2),
            conversions_value: round(prior.conversions_value + next.conversions_value, 2),
          }
        : next
    );
  }

  return rows.map((row) => {
    const resource = text(row, 'campaign.resource_name');
    const copy: Record<string, any> = { ...row };
    if (row?.campaign) copy.campaign = withoutKeys(row.campaign, CAMPAIGN_FIELDS_MOVED_TO_DIAG);
    if (row?.metrics) copy.metrics = withoutKeys(row.metrics, METRIC_FIELDS_MOVED_TO_DIAG);
    copy.diag = campaignDiag(row);
    const last30 = rows30d ? byCampaign.get(resource) : undefined;
    // A campaign with spend in the 7-day window but no 30-day row cannot happen
    // in a healthy read; treat it as an unread total rather than as zero.
    if (last30) copy.last_30d = last30;
    return copy;
  });
}

// ---------------------------------------------------------------------------
// History and economics
// ---------------------------------------------------------------------------

type Totals = { cost: number; conversions: number; value: number };

function totalsOf(rows: any[]): Totals {
  return rows.reduce(
    (acc: Totals, row: any) => {
      acc.cost += (numOrNull(pick(row, 'metrics.cost_micros')) ?? 0) / 1_000_000;
      acc.conversions += numOrNull(pick(row, 'metrics.conversions')) ?? 0;
      acc.value += numOrNull(pick(row, 'metrics.conversions_value')) ?? 0;
      return acc;
    },
    { cost: 0, conversions: 0, value: 0 }
  );
}

const roasOf = (t: Totals) => (t.cost > 0 ? round(t.value / t.cost, 2) : null);
const cpaOf = (t: Totals) => (t.conversions > 0 ? round(t.cost / t.conversions, 2) : null);

/** What the account actually did. Labeled history; nothing downstream may call it a target. */
export function buildAccountHistory(rows7d: any[], rows30d: any[] | null): NonNullable<OptimizerSnapshot['account_history']> {
  const seven = totalsOf(rows7d);
  const thirty = rows30d ? totalsOf(rows30d) : null;
  return {
    roas_7d: roasOf(seven),
    cpa_7d: cpaOf(seven),
    roas_30d: thirty ? roasOf(thirty) : null,
    cpa_30d: thirty ? cpaOf(thirty) : null,
  };
}

/**
 * The economics the model reads. Both thresholds of the client's range travel
 * with their names: break_even_roas / break_even_cpa are the SCALE ones (the
 * pessimistic end), break_even_roas_cut / break_even_cpa_cut the CUT ones (the
 * optimistic end), allowable_cpa_cut is the waste limit (with the account's
 * own 30-day CPA as a labeled fallback) and allowable_cpa_scale the promotion
 * limit (no fallback).
 */
export function buildSnapshotEconomics(economics: BreakEven, accountCpa30d: number | null): SnapshotEconomics {
  return {
    ...economics,
    allowable_cpa_cut: allowableCpaCut(economics, accountCpa30d),
    allowable_cpa_scale: allowableCpaScale(economics),
  };
}

/**
 * Everything in the snapshot that distinguishes the client's targets from the
 * account's history. `target_roas` and `target_cpa` are the client's
 * break-even (null when unknown), no longer the account's own average.
 */
export function composeEconomicsFields(input: {
  economics: BreakEven;
  campaignRows: any[];
  rows30d: any[] | null;
}): Pick<OptimizerSnapshot, 'campaigns' | 'account_history' | 'economics' | 'target_roas' | 'target_cpa'> {
  const history = buildAccountHistory(input.campaignRows, input.rows30d);
  return {
    campaigns: enrichCampaignRows(input.campaignRows, input.rows30d),
    account_history: history,
    economics: buildSnapshotEconomics(input.economics, history.cpa_30d),
    target_roas: input.economics.break_even_roas,
    target_cpa: input.economics.break_even_cpa,
  };
}

// ---------------------------------------------------------------------------
// Poor ads: what the pause rule needs about the ad's own ad group
// ---------------------------------------------------------------------------

/**
 * Adds the ad group's CTR, CPA and number of enabled ads to each ad row, so the
 * model can compare an ad with its siblings instead of with a quality label.
 * `adGroupRows` are 30-day ad_group rows, `enabledAdRows` one row per enabled
 * ad. A source that failed to read leaves the fields null, and the prompt
 * says null means "do not pause".
 */
export function enrichPoorAds(rows: any[], adGroupRows: any[] | null, enabledAdRows: any[] | null): any[] {
  const groups = new Map<string, { ctr: number | null; cpa: number | null }>();
  for (const row of adGroupRows ?? []) {
    const resource = text(row, 'ad_group.resource_name');
    if (!resource) continue;
    const impressions = numOrNull(pick(row, 'metrics.impressions')) ?? 0;
    const clicks = numOrNull(pick(row, 'metrics.clicks')) ?? 0;
    const cost = (numOrNull(pick(row, 'metrics.cost_micros')) ?? 0) / 1_000_000;
    const conversions = numOrNull(pick(row, 'metrics.conversions')) ?? 0;
    groups.set(resource, {
      ctr: impressions > 0 ? round(clicks / impressions, 4) : null,
      cpa: conversions > 0 ? round(cost / conversions, 2) : null,
    });
  }
  const adCounts = new Map<string, number>();
  for (const row of enabledAdRows ?? []) {
    const resource = text(row, 'ad_group.resource_name');
    if (resource) adCounts.set(resource, (adCounts.get(resource) ?? 0) + 1);
  }

  return rows.map((row) => {
    const resource = text(row, 'ad_group.resource_name');
    const group = adGroupRows ? groups.get(resource) : undefined;
    const copy: Record<string, any> = { ...row };
    delete copy.adGroup;
    delete copy.ad_group;
    // The group's resource name is already inside the ad's own resource name
    // (customers/X/adGroupAds/<group>~<ad>), so it is not repeated here.
    copy.ad_group = {
      ctr_30d: group?.ctr ?? null,
      cpa_30d: group?.cpa ?? null,
      enabled_ads: enabledAdRows && resource ? adCounts.get(resource) ?? 0 : null,
    };
    return copy;
  });
}
