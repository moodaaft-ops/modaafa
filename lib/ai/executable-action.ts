import type { OptimizerAction } from './optimizer-agent';

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
  const allowed = ['pause_keyword', 'add_negative_keyword', 'add_keyword', 'adjust_budget', 'adjust_bid', 'pause_ad'];
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
    // amount; bounds mirror the prompt and the queue-time guardrail.
    const hasBoundedDelta = Number.isFinite(deltaPct) && deltaPct !== 0 && deltaPct >= -30 && deltaPct <= 25;
    if (!hasAbsolute && !hasBoundedDelta) return null;
    return base;
  }

  if (operation === 'adjust_bid') {
    const adGroupResource = String(params.ad_group_resource ?? '');
    const hasBidTarget = params.target_cpa_micros !== undefined || params.target_roas !== undefined;
    if (!validGoogleAdsResource(adGroupResource, 'adGroups', accountCustomerId) || !hasBidTarget) return null;
    return base;
  }

  return null;
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
