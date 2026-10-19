import type { OptimizerAction } from './optimizer-agent';
import { isExtendedActionsEnabled } from './extended-actions/flag';
import { isExtendedOperation } from './extended-actions/types';
import { validateExtendedPayload } from './extended-actions/validate';
import { BUDGET_STEP_MAX_PCT, BUDGET_STEP_MIN_PCT } from './optimizer-gates';

/**
 * Translate a stored recommendation payload into an executable OptimizerAction.
 *
 * Extracted from app/api/recommendations/action/route.ts so the acceptance
 * rules — the exact boundary between "executes" and "manual review required" —
 * are unit-testable. Route files cannot export helpers.
 *
 * Returns null when the payload cannot be executed safely; the route then
 * records `manual_review_required` instead of attempting anything.
 */
export function buildExecutableAction(
  payload: any,
  recommendation: any,
  accountCustomerId?: string | null
): OptimizerAction | null {
  const operation = String(payload?.operation ?? '');

  // Extended operations: flag off means the same null as any unknown operation.
  if (isExtendedOperation(operation)) {
    if (!isExtendedActionsEnabled()) return null;
    const checked = validateExtendedPayload(
      operation,
      String(payload?.target_id ?? ''),
      payload?.params ?? {},
      accountCustomerId
    );
    if (!checked.ok) return null;
    return {
      type: operation,
      target_id: checked.target_id,
      params: checked.params,
      reason_ar: recommendation.description ?? recommendation.title,
      reason_en: recommendation.title,
      expected_impact: {
        metric: String(recommendation.expected_impact?.metric ?? 'performance'),
        delta_pct: Number(recommendation.expected_impact?.delta_pct ?? 0),
        delta_sar_per_month: Number(recommendation.expected_impact?.delta_sar_per_month ?? 0),
      },
    };
  }

  const allowed = [
    'pause_keyword',
    'add_negative_keyword',
    'add_keyword',
    'adjust_budget',
    'adjust_bid',
    'pause_ad',
    // Human/assistant-only operations: the nightly optimizer never proposes
    // these (see ALLOWED_ACTION_TYPES in optimizer-agent.ts) and autopilot
    // never executes them (AUTOPILOT_SAFE_ACTIONS). They reach this boundary
    // only through an approved row in the recommendations table.
    'pause_campaign',
    'enable_campaign',
    'add_negative_keywords_batch',
  ];
  if (!allowed.includes(operation)) return null;

  const params = payload?.params ?? {};
  const targetId = String(payload?.target_id ?? '');
  const base = {
    type: operation as OptimizerAction['type'],
    target_id: targetId,
    params,
    reason_ar: recommendation.description ?? recommendation.title,
    reason_en: recommendation.title,
    expected_impact: {
      metric: String(recommendation.expected_impact?.metric ?? 'performance'),
      delta_pct: Number(recommendation.expected_impact?.delta_pct ?? 0),
      delta_sar_per_month: Number(recommendation.expected_impact?.delta_sar_per_month ?? 0),
    },
  } satisfies OptimizerAction;

  if (operation === 'pause_keyword' || operation === 'pause_ad') {
    const resourceType = operation === 'pause_keyword' ? 'adGroupCriteria' : 'adGroupAds';
    return validGoogleAdsResource(targetId, resourceType, accountCustomerId) ? base : null;
  }

  if (operation === 'add_negative_keyword') {
    const campaignResource = String(params.campaign_resource ?? '');
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    if (
      !validGoogleAdsResource(campaignResource, 'campaigns', accountCustomerId) ||
      !keywordText ||
      !['EXACT', 'PHRASE', 'BROAD'].includes(matchType)
    ) {
      return null;
    }
    return base;
  }

  if (operation === 'add_keyword') {
    const adGroupResource = String(params.ad_group_resource ?? '');
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    if (
      !validGoogleAdsResource(adGroupResource, 'adGroups', accountCustomerId) ||
      !keywordText ||
      keywordText.length > 80 ||
      // Positive keyword promotion is deliberately narrower than negatives:
      // EXACT/PHRASE only, so a promoted term can never widen delivery.
      !['EXACT', 'PHRASE'].includes(matchType)
    ) {
      return null;
    }
    return base;
  }

  if (operation === 'adjust_budget') {
    const budgetResource = String(params.budget_resource ?? '');
    if (!validGoogleAdsResource(budgetResource, 'campaignBudgets', accountCustomerId)) return null;

    const newAmountMicros = Number(params.new_amount_micros ?? 0);
    const deltaPct = Number(params.delta_pct ?? NaN);
    const hasAbsolute = Number.isFinite(newAmountMicros) && newAmountMicros > 0;
    // Delta-only payloads are executable too. The optimizer prompt historically
    // instructed the model to emit `delta_pct` alone, so every cron-queued
    // budget recommendation — the platform's headline optimization — hit the
    // absolute-amount requirement here and dead-ended in
    // `manual_review_required` on every تنفيذ click. The pre-execution
    // preflight reads the LIVE budget and converts the delta to an absolute
    // amount; bounds mirror the prompt and the queue-time guardrail
    // (evaluateBudgetBounds in optimizer-gates.ts): a step of 5 to 20% either way.
    const hasBoundedDelta =
      Number.isFinite(deltaPct) &&
      Math.abs(deltaPct) >= BUDGET_STEP_MIN_PCT &&
      Math.abs(deltaPct) <= BUDGET_STEP_MAX_PCT;
    if (!hasAbsolute && !hasBoundedDelta) return null;
    return base;
  }

  if (operation === 'adjust_bid') {
    const adGroupResource = String(params.ad_group_resource ?? '');
    const hasBidTarget = params.target_cpa_micros !== undefined || params.target_roas !== undefined;
    if (!validGoogleAdsResource(adGroupResource, 'adGroups', accountCustomerId) || !hasBidTarget) return null;
    return base;
  }

  if (operation === 'pause_campaign' || operation === 'enable_campaign') {
    return validGoogleAdsResource(targetId, 'campaigns', accountCustomerId) ? base : null;
  }

  if (operation === 'add_negative_keywords_batch') {
    const campaignResource = String(params.campaign_resource ?? '');
    const matchType = String(params.match_type ?? '').trim();
    const keywords = cleanNegativeKeywordBatch(params.keywords);
    if (
      !validGoogleAdsResource(campaignResource, 'campaigns', accountCustomerId) ||
      // Same narrowing as positive promotion: a BROAD negative can block far
      // more traffic than the words suggest, so batches are EXACT/PHRASE only.
      !NEGATIVE_BATCH_MATCH_TYPES.includes(matchType) ||
      !keywords
    ) {
      return null;
    }
    return {
      ...base,
      // The batch is addressed by its campaign; a free-form target_id from the
      // payload is never used for execution.
      target_id: campaignResource,
      params: { ...params, campaign_resource: campaignResource, match_type: matchType, keywords },
    };
  }

  return null;
}

export const MAX_NEGATIVE_KEYWORD_BATCH = 10;
export const NEGATIVE_BATCH_MATCH_TYPES = ['EXACT', 'PHRASE'];
const MAX_KEYWORD_CHARS = 80;
const MAX_KEYWORD_WORDS = 10;

/**
 * Validate and canonicalise a negative-keyword batch: 1 to 10 strings, each
 * trimmed (inner whitespace collapsed, invisible direction/zero-width marks
 * removed), non-empty, at most 80 characters and 10 words, de-duplicated
 * case-insensitively. Returns null when ANY entry is invalid; a malformed
 * batch is rejected whole rather than silently shortened.
 */
export function cleanNegativeKeywordBatch(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NEGATIVE_KEYWORD_BATCH) {
    return null;
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const text = raw
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text.length > MAX_KEYWORD_CHARS || text.split(' ').length > MAX_KEYWORD_WORDS) {
      return null;
    }
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(text);
  }
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Resource names must belong to the SELECTED account, not just any account.
 * The customer id was previously left as a wildcard, so an action payload
 * could name a resource under a different `customers/<id>/…`; only Google's
 * own scoping stopped the write.
 */
export function validGoogleAdsResource(
  value: string,
  resourceType: string,
  accountCustomerId?: string | null
) {
  const customerPattern = accountCustomerId ? accountCustomerId.replace(/\D/g, '') : '\\d+';
  if (accountCustomerId && !customerPattern) return false;
  return new RegExp(`^customers/${customerPattern}/${resourceType}/[^/]+$`).test(value);
}
