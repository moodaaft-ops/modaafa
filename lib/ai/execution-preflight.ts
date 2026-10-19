import type { OptimizerAction } from './optimizer-agent';
import { cleanNegativeKeywordBatch, NEGATIVE_BATCH_MATCH_TYPES } from './executable-action';

/** Where and how the nightly measurement pass evaluates an applied action. */
export type MeasurementDescriptor = {
  level: 'budget_campaigns' | 'ad_group' | 'criterion' | 'ad' | 'created_criterion' | 'campaign';
  resource: string | null;
  window_days: number;
  before: { cost: number; clicks: number; conversions: number; conversion_value: number } | null;
  captured_at: string;
};

const AMBIGUOUS_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * A transport error raised after a live mutation was dispatched cannot prove
 * whether Google committed it. Keep the recommendation locked instead of
 * making a non-idempotent create action executable again.
 */
export function isAmbiguousGoogleAdsMutationError(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    const name = String(candidate.name ?? '');
    const code = String(candidate.code ?? '').toUpperCase();
    if (
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      name === 'FetchError' ||
      name === 'APIConnectionError' ||
      AMBIGUOUS_NETWORK_CODES.has(code)
    ) {
      return true;
    }

    const message = String(candidate.message ?? '').toLowerCase();
    if (
      message.includes('fetch failed') ||
      message.includes('socket hang up') ||
      message.includes('network connection was lost')
    ) {
      return true;
    }
  }
  return false;
}

function* errorChain(error: unknown) {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) return;
    seen.add(current);
    yield current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    current = (current as { cause?: unknown }).cause;
  }
}

export async function prepareActionForExecution(action: OptimizerAction, customer: any) {
  const params = { ...action.params };
  let rollbackPayload: Record<string, unknown> = { reversible: true };
  const capturedAt = new Date().toISOString();
  let measurement: MeasurementDescriptor | null = null;

  if (action.type === 'adjust_budget') {
    const resourceName = String(params.budget_resource);
    const rows = await customer.query(`
      SELECT campaign_budget.resource_name, campaign_budget.amount_micros
      FROM campaign_budget
      WHERE campaign_budget.resource_name = '${escapeGaql(resourceName)}'
      LIMIT 1
    `);
    const budget = rows[0]?.campaignBudget ?? rows[0]?.campaign_budget;
    const currentAmountMicros = Number(budget?.amountMicros ?? budget?.amount_micros ?? 0);
    if (!currentAmountMicros) throw new Error('Unable to read current campaign budget before execution');

    if (!(Number(params.new_amount_micros) > 0)) {
      const deltaPct = Number(params.delta_pct);
      if (!Number.isFinite(deltaPct) || deltaPct === 0) {
        throw new Error('Budget action carries neither an absolute amount nor a delta');
      }
      params.new_amount_micros = Math.round(currentAmountMicros * (1 + deltaPct / 100));
    }
    params.current_amount_micros = currentAmountMicros;
    params.delta_pct =
      ((Number(params.new_amount_micros) - currentAmountMicros) / currentAmountMicros) * 100;
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_budget',
      budget_resource: resourceName,
      amount_micros: currentAmountMicros,
    };
    measurement = {
      level: 'budget_campaigns',
      resource: resourceName,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'campaign', 'campaign.campaign_budget', resourceName),
      captured_at: capturedAt,
    };
  } else if (action.type === 'pause_keyword') {
    const rows = await customer.query(`
      SELECT ad_group_criterion.resource_name, ad_group_criterion.status
      FROM keyword_view
      WHERE ad_group_criterion.resource_name = '${escapeGaql(action.target_id)}'
      LIMIT 1
    `);
    const criterion = rows[0]?.adGroupCriterion ?? rows[0]?.ad_group_criterion;
    const previousStatus = criterion?.status;
    if (!previousStatus) throw new Error('Unable to read keyword status before execution');
    rollbackPayload = {
      reversible: true,
      action_type: 'pause_keyword',
      resource_name: action.target_id,
      status: previousStatus,
    };
    measurement = {
      level: 'criterion',
      resource: action.target_id,
      window_days: 7,
      before: await readSevenDayMetrics(
        customer,
        'keyword_view',
        'ad_group_criterion.resource_name',
        action.target_id
      ),
      captured_at: capturedAt,
    };
  } else if (action.type === 'pause_ad') {
    const rows = await customer.query(`
      SELECT ad_group_ad.resource_name, ad_group_ad.status
      FROM ad_group_ad
      WHERE ad_group_ad.resource_name = '${escapeGaql(action.target_id)}'
      LIMIT 1
    `);
    const ad = rows[0]?.adGroupAd ?? rows[0]?.ad_group_ad;
    const previousStatus = ad?.status;
    if (!previousStatus) throw new Error('Unable to read ad status before execution');
    rollbackPayload = {
      reversible: true,
      action_type: 'pause_ad',
      resource_name: action.target_id,
      status: previousStatus,
    };
    measurement = {
      level: 'ad',
      resource: action.target_id,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'ad_group_ad', 'ad_group_ad.resource_name', action.target_id),
      captured_at: capturedAt,
    };
  } else if (action.type === 'adjust_bid') {
    const resourceName = String(params.ad_group_resource);
    const rows = await customer.query(`
      SELECT ad_group.resource_name, ad_group.target_cpa_micros, ad_group.target_roas
      FROM ad_group
      WHERE ad_group.resource_name = '${escapeGaql(resourceName)}'
      LIMIT 1
    `);
    const adGroup = rows[0]?.adGroup ?? rows[0]?.ad_group;
    if (!adGroup) throw new Error('Unable to read ad group bid targets before execution');
    const currentTargetCpa = adGroup.targetCpaMicros ?? adGroup.target_cpa_micros ?? null;
    const currentTargetRoas = adGroup.targetRoas ?? adGroup.target_roas ?? null;
    if (currentTargetCpa !== null) params.current_target_cpa_micros = Number(currentTargetCpa);
    if (currentTargetRoas !== null) params.current_target_roas = Number(currentTargetRoas);
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_bid',
      ad_group_resource: resourceName,
      target_cpa_micros: currentTargetCpa,
      target_roas: currentTargetRoas,
    };
    measurement = {
      level: 'ad_group',
      resource: resourceName,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'ad_group', 'ad_group.resource_name', resourceName),
      captured_at: capturedAt,
    };
  } else if (action.type === 'add_negative_keyword') {
    // The single negative gets the same collision check as a batch: not already
    // a negative, not blocking a term that converted in the last 30 days, and
    // not blocking an enabled keyword of the campaign. A negative that matches
    // a keyword the account is paying to show on would switch that keyword off
    // (titan 7.1). Any read failure propagates: a negative is never sent unchecked.
    const campaignResource = String(params.campaign_resource ?? '');
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    if (!campaignResource || !keywordText || !['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) {
      throw new Error('Negative keyword is malformed');
    }
    const { keep, dropped } = await filterNegativeKeywordBatch(customer, campaignResource, matchType, [keywordText]);
    if (keep.length === 0) {
      throw new Error(
        `Negative keyword was dropped (${dropped.map((d) => `${d.text}: ${d.reason}`).join('; ')}); nothing to add.`
      );
    }
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_negative_keyword',
      resource_name_from_result: true,
    };
  } else if (action.type === 'launch_campaign') {
    // The created resources only exist after the mutate; the rollback is filled from its result.
    rollbackPayload = { reversible: true, action_type: 'remove_launched_campaign', launch_result_rollback: true };
  } else if (action.type === 'pause_campaign' || action.type === 'enable_campaign') {
    const campaignResource = action.target_id;
    const rows = await customer.query(`
      SELECT campaign.resource_name, campaign.status, campaign_budget.amount_micros
      FROM campaign
      WHERE campaign.resource_name = '${escapeGaql(campaignResource)}'
      LIMIT 1
    `);
    const campaign = rows[0]?.campaign;
    const previousStatus = normalizeCampaignStatus(campaign?.status);
    if (!campaign || !previousStatus) throw new Error('Unable to read campaign status before execution');

    if (action.type === 'pause_campaign') {
      if (previousStatus !== 'ENABLED') {
        throw new Error(`Campaign is ${previousStatus}, not ENABLED; nothing to pause.`);
      }
    } else {
      if (previousStatus !== 'PAUSED') {
        throw new Error(`Campaign is ${previousStatus}, not PAUSED; only a paused campaign can be enabled.`);
      }
      const budget = rows[0]?.campaignBudget ?? rows[0]?.campaign_budget;
      const budgetMicros = Number(budget?.amountMicros ?? budget?.amount_micros ?? 0);
      if (!(Number.isFinite(budgetMicros) && budgetMicros > 0)) {
        throw new Error('Campaign has no positive daily budget; refusing to enable it.');
      }
      params.budget_amount_micros = budgetMicros;
    }
    params.previous_status = previousStatus;
    rollbackPayload = {
      reversible: true,
      action_type: 'restore_campaign_status',
      campaign_resource: campaignResource,
      status: previousStatus,
    };
    measurement = {
      level: 'campaign',
      resource: campaignResource,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'campaign', 'campaign.resource_name', campaignResource),
      captured_at: capturedAt,
    };
  } else if (action.type === 'add_negative_keywords_batch') {
    const campaignResource = String(params.campaign_resource ?? '');
    const matchType = String(params.match_type ?? '').trim();
    const candidates = cleanNegativeKeywordBatch(params.keywords);
    if (!campaignResource || !NEGATIVE_BATCH_MATCH_TYPES.includes(matchType) || !candidates) {
      throw new Error('Negative keyword batch is malformed');
    }
    const { keep, dropped } = await filterNegativeKeywordBatch(customer, campaignResource, matchType, candidates);
    params.keywords = keep;
    params.dropped = dropped;
    if (keep.length === 0) {
      throw new Error(
        `Every keyword in the batch was dropped (${dropped.map((d) => `${d.text}: ${d.reason}`).join('; ')}); nothing to add.`
      );
    }
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_negative_keywords',
      resource_names_from_result: true,
    };
    measurement = {
      level: 'campaign',
      resource: campaignResource,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'campaign', 'campaign.resource_name', campaignResource),
      captured_at: capturedAt,
    };
  } else if (action.type === 'add_keyword') {
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    const existing = await customer.query(`
      SELECT ad_group_criterion.resource_name
      FROM keyword_view
      WHERE ad_group_criterion.keyword.text = '${escapeGaql(keywordText)}'
        AND ad_group_criterion.keyword.match_type = '${escapeGaql(matchType)}'
        AND ad_group_criterion.status != 'REMOVED'
      LIMIT 1
    `);
    if (existing.length > 0) {
      throw new Error('Keyword already exists in this account; promotion skipped to avoid duplicate serving.');
    }
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_keyword',
      resource_name_from_result: true,
    };
    measurement = {
      level: 'created_criterion',
      resource: null,
      window_days: 7,
      before: { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 },
      captured_at: capturedAt,
    };
  }

  return { action: { ...action, params }, rollbackPayload, measurement };
}

export type DroppedNegativeKeyword = {
  text: string;
  reason: 'already_negative' | 'blocks_converting_search_term' | 'blocks_enabled_keyword';
};

/**
 * Drop batch candidates that are redundant or that would block traffic the
 * campaign is already winning:
 *  - already a campaign negative with the same match type;
 *  - would block a search term that converted in the last 30 days;
 *  - would block one of the campaign's enabled positive keywords.
 * Any read failure propagates: a batch is never sent unchecked.
 */
export async function filterNegativeKeywordBatch(
  customer: any,
  campaignResource: string,
  matchType: string,
  candidates: string[]
): Promise<{ keep: string[]; dropped: DroppedNegativeKeyword[] }> {
  const campaign = escapeGaql(campaignResource);
  const existingRows = await customer.query(`
    SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
    FROM campaign_criterion
    WHERE campaign_criterion.campaign = '${campaign}'
      AND campaign_criterion.negative = TRUE
      AND campaign_criterion.type = 'KEYWORD'
      AND campaign_criterion.status != 'REMOVED'
  `);
  const convertingRows = await customer.query(`
    SELECT search_term_view.search_term, metrics.conversions
    FROM search_term_view
    WHERE campaign.resource_name = '${campaign}'
      AND segments.date DURING LAST_30_DAYS
      AND metrics.conversions > 0
  `);
  const keywordRows = await customer.query(`
    SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
    FROM keyword_view
    WHERE campaign.resource_name = '${campaign}'
      AND ad_group_criterion.status = 'ENABLED'
      AND ad_group_criterion.negative = FALSE
  `);

  const existing = new Set<string>();
  for (const row of existingRows ?? []) {
    const criterion = row?.campaignCriterion ?? row?.campaign_criterion;
    const keyword = criterion?.keyword;
    const text = typeof keyword?.text === 'string' ? keyword.text : '';
    const rowMatch = String(keyword?.matchType ?? keyword?.match_type ?? '');
    if (text && rowMatch === matchType) existing.add(normalizeKeywordText(text));
  }
  const convertingTerms = (convertingRows ?? [])
    .map((row: any) => row?.searchTermView?.searchTerm ?? row?.search_term_view?.search_term)
    .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeKeywordText);
  const enabledKeywords = (keywordRows ?? [])
    .map((row: any) => (row?.adGroupCriterion ?? row?.ad_group_criterion)?.keyword?.text)
    .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeKeywordText);

  const keep: string[] = [];
  const dropped: DroppedNegativeKeyword[] = [];
  for (const text of candidates) {
    const normalized = normalizeKeywordText(text);
    if (existing.has(normalized)) {
      dropped.push({ text, reason: 'already_negative' });
    } else if (convertingTerms.some((term: string) => negativeWouldBlock(normalized, matchType, term))) {
      dropped.push({ text, reason: 'blocks_converting_search_term' });
    } else if (enabledKeywords.some((keyword: string) => negativeWouldBlock(normalized, matchType, keyword))) {
      dropped.push({ text, reason: 'blocks_enabled_keyword' });
    } else {
      keep.push(text);
    }
  }
  return { keep, dropped };
}

/**
 * Comparison form for conflict checks only (never sent to Google): trimmed,
 * single-spaced, lower-cased, Arabic alef variants folded to ا, ta marbuta to
 * ه, alef maqsura to ي, and diacritics/tatweel removed. Folding makes the
 * check MORE conservative: a candidate that differs from a converting term
 * only by spelling variant is treated as a conflict and dropped.
 */
export function normalizeKeywordText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Would a negative of this match type block `target` (a normalized search
 * term or keyword)? EXACT blocks only an identical query. PHRASE blocks a
 * query containing the phrase words in the same order; Google requires them
 * to be adjacent, but this check accepts gaps too, which can only drop more
 * candidates, never fewer.
 */
export function negativeWouldBlock(normalizedNegative: string, matchType: string, normalizedTarget: string) {
  if (!normalizedNegative || !normalizedTarget) return false;
  if (matchType === 'EXACT') return normalizedNegative === normalizedTarget;
  const needle = normalizedNegative.split(' ');
  const haystack = normalizedTarget.split(' ');
  let index = 0;
  for (const word of haystack) {
    if (word === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

const CAMPAIGN_STATUS_BY_NUMBER: Record<number, string> = { 2: 'ENABLED', 3: 'PAUSED', 4: 'REMOVED' };

function normalizeCampaignStatus(value: unknown): string | null {
  if (typeof value === 'number') return CAMPAIGN_STATUS_BY_NUMBER[value] ?? null;
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toUpperCase();
}

async function readSevenDayMetrics(
  customer: any,
  fromClause: string,
  whereField: string,
  resourceName: string
) {
  try {
    const rows = await customer.query(`
      SELECT metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM ${fromClause}
      WHERE ${whereField} = '${escapeGaql(resourceName)}'
        AND segments.date DURING LAST_7_DAYS
    `);
    return sumMetricRows(rows);
  } catch {
    return null;
  }
}

function sumMetricRows(rows: any[]) {
  const totals = { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  for (const row of rows ?? []) {
    const metrics = row?.metrics ?? {};
    totals.cost += Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000;
    totals.clicks += Number(metrics.clicks ?? 0);
    totals.conversions += Number(metrics.conversions ?? 0);
    totals.conversion_value += Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0);
  }
  totals.cost = Number(totals.cost.toFixed(2));
  totals.conversions = Number(totals.conversions.toFixed(3));
  totals.conversion_value = Number(totals.conversion_value.toFixed(2));
  return totals;
}

function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export type WriteAccess = 'full' | 'read_only' | 'unknown';

const WRITE_DENIED_CODES = new Set(['USER_PERMISSION_DENIED', 'ACTION_NOT_PERMITTED']);

/**
 * Can Modaafa write to this account at all (spec 83, 5.5)? Re-submits the
 * first enabled campaign's budget at its CURRENT amount with validateOnly
 * hard-coded to true, so Google checks permissions and nothing is applied.
 * A permission error means the linked login is read-only (typical for an
 * agency-managed account). Anything else that fails is "unknown", never a
 * guess.
 */
export async function probeWriteAccess(customer: any): Promise<WriteAccess> {
  let rows: any[];
  try {
    rows = await customer.query(`
      SELECT campaign_budget.resource_name, campaign_budget.amount_micros
      FROM campaign
      WHERE campaign.status = 'ENABLED'
      LIMIT 1
    `);
  } catch {
    return 'unknown';
  }
  const budget = rows?.[0]?.campaignBudget ?? rows?.[0]?.campaign_budget;
  const resourceName = String(budget?.resourceName ?? budget?.resource_name ?? '');
  const amount = Number(budget?.amountMicros ?? budget?.amount_micros ?? 0);
  if (!/^customers\/\d+\/campaignBudgets\/\d+$/.test(resourceName) || !(amount > 0)) return 'unknown';

  try {
    await customer.campaignBudgets.update([{ resource_name: resourceName, amount_micros: amount }], {
      validateOnly: true,
    });
    return 'full';
  } catch (error) {
    for (const candidate of errorChain(error)) {
      const codes = Array.isArray((candidate as any).codes) ? ((candidate as any).codes as string[]) : [];
      if (codes.some((code) => WRITE_DENIED_CODES.has(code))) return 'read_only';
      const message = String(candidate.message ?? '');
      if ([...WRITE_DENIED_CODES].some((code) => message.includes(code))) return 'read_only';
    }
    return 'unknown';
  }
}
