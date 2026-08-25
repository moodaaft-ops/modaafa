type UnknownRecord = Record<string, unknown>;

export type AutopilotDecisionDisplayDetails = {
  keyword: string | null;
  campaign: string | null;
  matchType: string | null;
};

/**
 * Read the action fields exactly where the decision ledger stores them. Keep
 * this tolerant of older snapshots so historical entries remain useful after
 * payload shapes evolve.
 */
export function autopilotDecisionDisplayDetails(
  snapshot: unknown
): AutopilotDecisionDisplayDetails {
  const action = asRecord(snapshot);
  const params = asRecord(action.params);
  const campaignResource = firstText(params.campaign_resource, action.target_id);
  const campaignId = campaignResource?.split('/').filter(Boolean).at(-1) ?? null;

  return {
    keyword: firstText(action.keyword, action.keyword_text, params.keyword_text),
    campaign:
      firstText(action.campaign_name, params.campaign_name) ??
      (campaignId ? `الحملة ${campaignId}` : null),
    matchType: firstText(action.match_type, params.match_type),
  };
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return null;
}
