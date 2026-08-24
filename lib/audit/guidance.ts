export type GuidanceRecommendation = {
  status?: string | null;
  severity?: string | null;
  expected_impact?: {
    delta_sar_per_month?: number | null;
  } | null;
  created_at?: string | null;
};

const STATUS_ORDER: Record<string, number> = {
  pending: 0,
  failed: 1,
  approved: 2,
  executing: 3,
  applied: 4,
  dismissed: 5,
};

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  medium: 1,
  growth: 2,
};

export function isRecommendationActionable(recommendation: GuidanceRecommendation) {
  return ['pending', 'failed'].includes(String(recommendation.status ?? ''));
}

export function orderRecommendationsForGuidance<T extends GuidanceRecommendation>(recommendations: T[]) {
  return [...recommendations].sort((left, right) => {
    const statusDifference = statusRank(left.status) - statusRank(right.status);
    if (statusDifference !== 0) return statusDifference;

    const severityDifference = severityRank(left.severity) - severityRank(right.severity);
    if (severityDifference !== 0) return severityDifference;

    const impactDifference = impactValue(right) - impactValue(left);
    if (impactDifference !== 0) return impactDifference;

    return createdAtValue(right.created_at) - createdAtValue(left.created_at);
  });
}

function statusRank(status?: string | null) {
  return STATUS_ORDER[String(status ?? '')] ?? 6;
}

function severityRank(severity?: string | null) {
  return SEVERITY_ORDER[String(severity ?? '')] ?? 4;
}

function impactValue(recommendation: GuidanceRecommendation) {
  const value = Number(recommendation.expected_impact?.delta_sar_per_month ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function createdAtValue(createdAt?: string | null) {
  const value = createdAt ? Date.parse(createdAt) : 0;
  return Number.isFinite(value) ? value : 0;
}
