import { createHash } from 'node:crypto';

/**
 * Shared identity of a proposed Google Ads change. Moved out of the optimizer
 * cron route (route files cannot export helpers) so the chat brain dedupes
 * against the SAME fingerprint the nightly optimizer and autopilot use: a
 * negative proposed in chat and the same negative proposed overnight are one
 * recommendation, not two.
 */
export function actionFingerprint(accountId: string, action: any) {
  // Fingerprint the STABLE identity of the change only. Hashing the whole
  // action folded in `reason_ar`/`reason_en`/`expected_impact`, which the model
  // regenerates with different wording and rounding every night, so the hash
  // changed each run, the dedupe select missed, and the user accumulated one
  // near-identical pending recommendation per night per finding.
  const identity = {
    type: action?.type ?? null,
    target_id: action?.target_id ?? null,
    params: action?.params ?? {},
  };
  return createHash('sha256')
    .update(`${accountId}:${stableStringify(identity)}`)
    .digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function categoryForAction(type: string) {
  const map: Record<string, string> = {
    pause_keyword: 'keywords',
    add_negative_keyword: 'keywords',
    add_negative_keywords_batch: 'keywords',
    add_keyword: 'keywords',
    adjust_budget: 'budget',
    adjust_bid: 'bidding',
    pause_ad: 'ads',
    set_ad_schedule: 'targeting',
    set_device_bid_modifier: 'targeting',
    exclude_location: 'targeting',
    set_location_bid_modifier: 'targeting',
    set_geo_target_type: 'targeting',
    set_network_settings: 'targeting',
    create_shared_negative_list: 'keywords',
    add_shared_negative_keywords: 'keywords',
    attach_shared_negative_list: 'keywords',
    replace_rsa_assets: 'ads',
    add_sitelinks: 'ads',
    add_callouts: 'ads',
    add_structured_snippet: 'ads',
    add_call_asset: 'ads',
    set_ai_max: 'targeting',
    add_placement_exclusions: 'targeting',
    create_shared_budget: 'budget',
    attach_shared_budget: 'budget',
    detach_shared_budget: 'budget',
    create_portfolio_strategy: 'bidding',
    attach_portfolio_strategy: 'bidding',
    detach_portfolio_strategy: 'bidding',
  };
  return map[type] ?? 'structure';
}

export function severityForAction(action: { expected_impact?: { delta_sar_per_month?: number } }) {
  const impact = Number(action.expected_impact?.delta_sar_per_month ?? 0);
  if (impact >= 1000) return 'critical';
  if (impact >= 250) return 'medium';
  return 'growth';
}
