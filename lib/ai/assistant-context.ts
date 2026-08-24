import type { BusinessSummary } from '@/lib/accounts/selection';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { sanitizePromptText } from '@/lib/ai/optimizer-agent';

export type AssistantMetricInput = Record<string, unknown> | null;

export type AssistantCampaignInput = {
  id: string;
  name: string | null;
  status: string | null;
  type: string | null;
  daily_budget: number | null;
  bidding_strategy?: string | null;
  metrics_7d: AssistantMetricInput;
  metrics_30d: AssistantMetricInput;
  metrics_today: AssistantMetricInput;
  last_synced_at?: string | null;
};

export type AssistantAuditInput = {
  health_score?: number | null;
  category_scores?: unknown;
  findings?: unknown;
  metrics_snapshot?: unknown;
  estimated_monthly_waste?: number | null;
  ran_at?: string | null;
} | null;

export type AssistantAuditRecordInput = Exclude<AssistantAuditInput, null>;

export type AssistantRecommendationInput = {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  severity?: string | null;
  expected_impact?: unknown;
  action_payload?: unknown;
  status?: string | null;
  created_at?: string | null;
};

export type AssistantActionInput = {
  id?: string | null;
  action_type?: string | null;
  description_ar?: string | null;
  reason?: string | null;
  expected_impact?: unknown;
  observed_impact?: unknown;
  result?: unknown;
  created_at?: string | null;
  reverted_at?: string | null;
};

type MetricTotals = {
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversion_value: number;
};

type DerivedMetrics = MetricTotals & {
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
};

export type AssistantCampaignInsight = {
  id: string;
  name: string;
  status: string | null;
  type: string | null;
  bidding_strategy: string | null;
  daily_budget: number;
  metrics_7d: DerivedMetrics;
  metrics_30d: DerivedMetrics;
  prior_23d: DerivedMetrics;
  recent_daily_cost_delta_pct: number | null;
  recent_daily_conversion_delta_pct: number | null;
};

export type AssistantAnalysis = {
  business: {
    name: string | null;
    sector: string | null;
    website: string | null;
    monthly_budget_sar: number | null;
    primary_goal: string | null;
    target_regions: string[];
  };
  account: {
    customer_id: string;
    customer_name: string;
    currency_code: string;
    total_campaigns: number;
    active_campaigns: number;
  };
  performance: {
    recent_7d: DerivedMetrics;
    total_30d: DerivedMetrics;
    prior_23d: DerivedMetrics;
    today: DerivedMetrics;
    comparison: {
      basis: 'recent_7d_daily_average_vs_prior_23d_daily_average';
      spend_delta_pct: number | null;
      clicks_delta_pct: number | null;
      impressions_delta_pct: number | null;
      conversions_delta_pct: number | null;
      conversion_value_delta_pct: number | null;
      cpa_delta_pct: number | null;
      ctr_delta_pct: number | null;
      roas_delta_pct: number | null;
    };
  };
  diagnostics: {
    highest_spend: AssistantCampaignInsight[];
    spend_without_conversions: AssistantCampaignInsight[];
    efficient: AssistantCampaignInsight[];
    improving: AssistantCampaignInsight[];
    declining: AssistantCampaignInsight[];
  };
  audit: {
    health_score: number | null;
    estimated_monthly_waste: number | null;
    category_scores: unknown;
    findings: unknown[];
    sector_benchmark: unknown;
    live_coverage: unknown;
    ai_narrative: unknown;
    ran_at: string | null;
  };
  data_quality: {
    confidence: 'high' | 'medium' | 'limited';
    confidence_ar: string;
    sync_state: 'fresh' | 'aging' | 'stale' | 'unknown';
    sync_age_hours: number | null;
    audit_age_hours: number | null;
    last_synced_at: string | null;
    gaps_ar: string[];
    sources_ar: string[];
  };
  campaigns: AssistantCampaignInsight[];
  open_recommendations: unknown[];
  decision_history: {
    recent_actions: unknown[];
    audit_history: Array<{
      health_score: number | null;
      estimated_monthly_waste: number | null;
      ran_at: string | null;
    }>;
    audit_trend: {
      direction: 'improving' | 'declining' | 'stable' | 'unknown';
      health_score_delta: number | null;
      estimated_monthly_waste_delta: number | null;
      from: string | null;
      to: string | null;
    } | null;
  };
};

export function buildAssistantAnalysis({
  business,
  account,
  campaigns,
  audit,
  auditHistory = [],
  recommendations,
  actions = [],
  now = new Date(),
}: {
  business: BusinessSummary | null;
  account: {
    customer_id: string;
    customer_name?: string | null;
    currency_code?: string | null;
    last_synced_at?: string | null;
  };
  campaigns: AssistantCampaignInput[];
  audit: AssistantAuditInput;
  auditHistory?: AssistantAuditRecordInput[];
  recommendations: AssistantRecommendationInput[];
  actions?: AssistantActionInput[];
  now?: Date;
}): AssistantAnalysis {
  const recent7 = sumCampaignMetrics(campaigns, 'metrics_7d');
  const total30 = sumCampaignMetrics(campaigns, 'metrics_30d');
  const today = sumCampaignMetrics(campaigns, 'metrics_today');
  const prior23 = subtractTotals(total30, recent7);
  const recent7Derived = deriveMetrics(recent7);
  const total30Derived = deriveMetrics(total30);
  const prior23Derived = deriveMetrics(prior23);
  const todayDerived = deriveMetrics(today);

  const campaignInsights = campaigns.map(buildCampaignInsight);
  const meaningfulSpend = Math.max(25, recent7.cost * 0.015);
  const syncTimestamp = latestTimestamp([
    account.last_synced_at,
    ...campaigns.map((campaign) => campaign.last_synced_at),
  ]);
  const syncAgeHours = ageHours(syncTimestamp, now);
  const auditAgeHours = ageHours(audit?.ran_at ?? null, now);
  const snapshot = objectValue(audit?.metrics_snapshot);
  const liveCoverage = snapshot?.live_coverage ?? null;
  const coveragePct = finiteNumber(objectValue(liveCoverage)?.coverage_pct);
  const gaps: string[] = [];

  if (campaigns.length === 0) gaps.push('لا توجد بيانات حملات متزامنة بعد.');
  if (syncAgeHours === null) gaps.push('وقت آخر مزامنة غير معروف.');
  else if (syncAgeHours > 72) gaps.push('بيانات الحملات أقدم من 72 ساعة؛ يلزم تحديث الحساب.');
  if (!audit) gaps.push('لا يوجد فحص حساب محفوظ؛ بعض الأحكام الاستراتيجية محدودة.');
  else if (auditAgeHours !== null && auditAgeHours > 168) gaps.push('آخر فحص أقدم من 7 أيام.');
  if (recent7.conversions > 0 && recent7.conversion_value <= 0) {
    gaps.push('قيم التحويل غير متوفرة؛ يمكن تقييم CPA لكن لا يمكن الحكم على ROAS بدقة.');
  }
  if (!business?.primary_goal) gaps.push('الهدف التجاري الأساسي غير محفوظ في ملف النشاط.');
  if (!business?.monthly_budget) gaps.push('الميزانية الشهرية المستهدفة غير محفوظة.');
  if (coveragePct !== null && coveragePct < 84) {
    gaps.push(`تغطية الفحص الحي ${round(coveragePct, 0)}% فقط؛ بعض التشخيصات غير مكتملة.`);
  }

  const syncState =
    syncAgeHours === null ? 'unknown' : syncAgeHours <= 24 ? 'fresh' : syncAgeHours <= 72 ? 'aging' : 'stale';
  const confidence = confidenceLevel({ campaigns: campaigns.length, syncState, audit, auditAgeHours, coveragePct });
  const findings = Array.isArray(audit?.findings) ? audit.findings.slice(0, 12).map(compactPromptValue) : [];
  const normalizedAuditHistory = normalizeAuditHistory(audit, auditHistory);

  return {
    business: {
      name: cleanText(business?.name),
      sector: cleanText(business?.sector),
      website: cleanText(business?.website),
      monthly_budget_sar: positiveOrNull(business?.monthly_budget),
      primary_goal: cleanText(business?.primary_goal),
      target_regions: (business?.target_regions ?? []).slice(0, 20).map((region) => cleanText(region) ?? '').filter(Boolean),
    },
    account: {
      customer_id: account.customer_id,
      customer_name: cleanText(account.customer_name) ?? account.customer_id,
      currency_code: normalizedCurrency(account.currency_code),
      total_campaigns: campaigns.length,
      active_campaigns: campaigns.filter((campaign) => campaign.status === 'ENABLED').length,
    },
    performance: {
      recent_7d: recent7Derived,
      total_30d: total30Derived,
      prior_23d: prior23Derived,
      today: todayDerived,
      comparison: {
        basis: 'recent_7d_daily_average_vs_prior_23d_daily_average',
        spend_delta_pct: percentDelta(recent7.cost / 7, prior23.cost / 23),
        clicks_delta_pct: percentDelta(recent7.clicks / 7, prior23.clicks / 23),
        impressions_delta_pct: percentDelta(recent7.impressions / 7, prior23.impressions / 23),
        conversions_delta_pct: percentDelta(recent7.conversions / 7, prior23.conversions / 23),
        conversion_value_delta_pct: percentDelta(recent7.conversion_value / 7, prior23.conversion_value / 23),
        cpa_delta_pct: percentDelta(recent7Derived.cpa, prior23Derived.cpa),
        ctr_delta_pct: percentDelta(recent7Derived.ctr, prior23Derived.ctr),
        roas_delta_pct: percentDelta(recent7Derived.roas, prior23Derived.roas),
      },
    },
    diagnostics: {
      highest_spend: [...campaignInsights].sort((a, b) => b.metrics_7d.cost - a.metrics_7d.cost).slice(0, 8),
      spend_without_conversions: campaignInsights
        .filter((campaign) => campaign.metrics_7d.cost >= meaningfulSpend && campaign.metrics_7d.conversions <= 0)
        .sort((a, b) => b.metrics_7d.cost - a.metrics_7d.cost)
        .slice(0, 8),
      efficient: campaignInsights
        .filter((campaign) => campaign.metrics_7d.conversions > 0)
        .sort((a, b) => efficiencyScore(b) - efficiencyScore(a))
        .slice(0, 8),
      improving: campaignInsights
        .filter((campaign) =>
          campaign.metrics_7d.conversions >= 1 &&
          (campaign.recent_daily_conversion_delta_pct ?? 0) >= 25
        )
        .sort((a, b) => (b.recent_daily_conversion_delta_pct ?? 0) - (a.recent_daily_conversion_delta_pct ?? 0))
        .slice(0, 8),
      declining: campaignInsights
        .filter((campaign) =>
          campaign.prior_23d.conversions > 0 &&
          (campaign.recent_daily_conversion_delta_pct ?? 0) <= -25
        )
        .sort((a, b) => (a.recent_daily_conversion_delta_pct ?? 0) - (b.recent_daily_conversion_delta_pct ?? 0))
        .slice(0, 8),
    },
    audit: {
      health_score: finiteNumber(audit?.health_score),
      estimated_monthly_waste: finiteNumber(audit?.estimated_monthly_waste),
      category_scores: compactPromptValue(audit?.category_scores ?? null),
      findings,
      sector_benchmark: compactPromptValue(snapshot?.sector_benchmark ?? null),
      live_coverage: compactPromptValue(liveCoverage),
      ai_narrative: compactPromptValue(snapshot?.ai_narrative ?? null),
      ran_at: audit?.ran_at ?? null,
    },
    data_quality: {
      confidence,
      confidence_ar: confidence === 'high' ? 'عالية' : confidence === 'medium' ? 'متوسطة' : 'محدودة',
      sync_state: syncState,
      sync_age_hours: syncAgeHours,
      audit_age_hours: auditAgeHours,
      last_synced_at: syncTimestamp,
      gaps_ar: gaps,
      sources_ar: [
        campaigns.length > 0 ? 'بيانات حملات Google Ads المتزامنة' : null,
        audit ? 'آخر فحص محفوظ وأدلته' : null,
        business ? 'ملف النشاط التجاري' : null,
        snapshot?.sector_benchmark ? 'معيار قطاع مجهول الهوية' : null,
      ].filter((source): source is string => Boolean(source)),
    },
    campaigns: campaignInsights,
    open_recommendations: recommendations.slice(0, 12).map((recommendation) =>
      compactPromptValue({
        id: recommendation.id,
        title: recommendation.title,
        description: recommendation.description,
        severity: recommendation.severity,
        expected_impact: recommendation.expected_impact,
        action_payload: recommendation.action_payload,
        status: recommendation.status,
        created_at: recommendation.created_at,
      })
    ),
    decision_history: {
      recent_actions: actions.slice(0, 12).map((action) =>
        compactPromptValue({
          id: action.id,
          action_type: action.action_type,
          description_ar: action.description_ar,
          reason: action.reason,
          expected_impact: action.expected_impact,
          observed_impact: action.observed_impact,
          result: action.result,
          created_at: action.created_at,
          reverted_at: action.reverted_at,
          state: action.reverted_at ? 'reverted' : hasMeaningfulValue(action.observed_impact) ? 'measured' : 'awaiting_measurement',
        })
      ),
      audit_history: normalizedAuditHistory.map((item) => ({
        health_score: finiteNumber(item.health_score),
        estimated_monthly_waste: finiteNumber(item.estimated_monthly_waste),
        ran_at: item.ran_at ?? null,
      })),
      audit_trend: buildAuditTrend(normalizedAuditHistory),
    },
  };
}

export function assistantPromptContext(analysis: AssistantAnalysis, message: string) {
  const selectedCampaigns = selectRelevantCampaigns(analysis.campaigns, message, 40);
  return compactPromptValue({
    business: analysis.business,
    account: analysis.account,
    performance: analysis.performance,
    diagnostics: analysis.diagnostics,
    audit: analysis.audit,
    data_quality: analysis.data_quality,
    campaigns: selectedCampaigns,
    open_recommendations: analysis.open_recommendations,
    decision_history: analysis.decision_history,
  });
}

function normalizeAuditHistory(audit: AssistantAuditInput, history: AssistantAuditRecordInput[]) {
  const candidates = [...history];
  if (audit && !candidates.some((item) => item.ran_at && item.ran_at === audit.ran_at)) candidates.push(audit);
  return candidates
    .filter((item) => Boolean(item))
    .sort((left, right) => timestamp(right.ran_at) - timestamp(left.ran_at))
    .slice(0, 4);
}

function buildAuditTrend(history: AssistantAuditRecordInput[]): AssistantAnalysis['decision_history']['audit_trend'] {
  const current = history[0];
  const previous = history[1];
  if (!current || !previous) return null;
  const healthScoreDelta = numericDelta(current.health_score, previous.health_score);
  const wasteDelta = numericDelta(current.estimated_monthly_waste, previous.estimated_monthly_waste);
  const direction =
    healthScoreDelta === null && wasteDelta === null
      ? 'unknown'
      : (healthScoreDelta ?? 0) >= 2 || (wasteDelta ?? 0) <= -1
        ? 'improving'
        : (healthScoreDelta ?? 0) <= -2 || (wasteDelta ?? 0) >= 1
          ? 'declining'
          : 'stable';
  return {
    direction,
    health_score_delta: healthScoreDelta,
    estimated_monthly_waste_delta: wasteDelta,
    from: previous.ran_at ?? null,
    to: current.ran_at ?? null,
  };
}

function numericDelta(current: unknown, previous: unknown) {
  const currentNumber = finiteNumber(current);
  const previousNumber = finiteNumber(previous);
  return currentNumber === null || previousNumber === null ? null : round(currentNumber - previousNumber);
}

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasMeaningfulValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0);
}

function buildCampaignInsight(campaign: AssistantCampaignInput): AssistantCampaignInsight {
  const recent7 = metricTotals(campaign.metrics_7d);
  const total30 = metricTotals(campaign.metrics_30d);
  const prior23 = subtractTotals(total30, recent7);
  return {
    id: campaign.id,
    name: cleanText(campaign.name) ?? 'حملة بدون اسم',
    status: campaign.status,
    type: campaign.type,
    bidding_strategy: campaign.bidding_strategy ?? null,
    daily_budget: nonNegative(campaign.daily_budget),
    metrics_7d: deriveMetrics(recent7),
    metrics_30d: deriveMetrics(total30),
    prior_23d: deriveMetrics(prior23),
    recent_daily_cost_delta_pct: percentDelta(recent7.cost / 7, prior23.cost / 23),
    recent_daily_conversion_delta_pct: percentDelta(recent7.conversions / 7, prior23.conversions / 23),
  };
}

function sumCampaignMetrics(campaigns: AssistantCampaignInput[], key: 'metrics_7d' | 'metrics_30d' | 'metrics_today') {
  return campaigns.reduce<MetricTotals>((total, campaign) => addTotals(total, metricTotals(campaign[key])), emptyTotals());
}

function metricTotals(metrics: AssistantMetricInput): MetricTotals {
  return {
    cost: nonNegative(moneyMetric(metrics, 'cost')),
    clicks: nonNegative(metrics?.clicks),
    impressions: nonNegative(metrics?.impressions),
    conversions: nonNegative(metrics?.conversions),
    conversion_value: nonNegative(moneyMetric(metrics, 'conversion_value')),
  };
}

function emptyTotals(): MetricTotals {
  return { cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 };
}

function addTotals(left: MetricTotals, right: MetricTotals): MetricTotals {
  return {
    cost: left.cost + right.cost,
    clicks: left.clicks + right.clicks,
    impressions: left.impressions + right.impressions,
    conversions: left.conversions + right.conversions,
    conversion_value: left.conversion_value + right.conversion_value,
  };
}

function subtractTotals(total: MetricTotals, recent: MetricTotals): MetricTotals {
  return {
    cost: Math.max(0, total.cost - recent.cost),
    clicks: Math.max(0, total.clicks - recent.clicks),
    impressions: Math.max(0, total.impressions - recent.impressions),
    conversions: Math.max(0, total.conversions - recent.conversions),
    conversion_value: Math.max(0, total.conversion_value - recent.conversion_value),
  };
}

function deriveMetrics(totals: MetricTotals): DerivedMetrics {
  return {
    ...mapTotals(totals),
    ctr: totals.impressions > 0 ? round((totals.clicks / totals.impressions) * 100) : null,
    cpc: totals.clicks > 0 ? round(totals.cost / totals.clicks) : null,
    cpa: totals.conversions > 0 ? round(totals.cost / totals.conversions) : null,
    roas: totals.cost > 0 && totals.conversion_value > 0 ? round(totals.conversion_value / totals.cost) : null,
  };
}

function mapTotals(totals: MetricTotals): MetricTotals {
  return {
    cost: round(totals.cost),
    clicks: round(totals.clicks),
    impressions: round(totals.impressions),
    conversions: round(totals.conversions),
    conversion_value: round(totals.conversion_value),
  };
}

function percentDelta(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous <= 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function selectRelevantCampaigns(campaigns: AssistantCampaignInsight[], message: string, limit: number) {
  const tokens = sanitizePromptText(message)
    .toLocaleLowerCase('ar')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3)
    .slice(0, 12);
  const ranked = campaigns.map((campaign) => ({
    campaign,
    match: tokens.reduce((score, token) => score + (campaign.name.toLocaleLowerCase('ar').includes(token) ? 1 : 0), 0),
  }));
  return ranked
    .sort((left, right) => right.match - left.match || right.campaign.metrics_30d.cost - left.campaign.metrics_30d.cost)
    .slice(0, limit)
    .map(({ campaign }) => campaign);
}

function confidenceLevel({
  campaigns,
  syncState,
  audit,
  auditAgeHours,
  coveragePct,
}: {
  campaigns: number;
  syncState: AssistantAnalysis['data_quality']['sync_state'];
  audit: AssistantAuditInput;
  auditAgeHours: number | null;
  coveragePct: number | null;
}): AssistantAnalysis['data_quality']['confidence'] {
  if (campaigns === 0 || syncState === 'stale' || syncState === 'unknown') return 'limited';
  if (syncState === 'fresh' && audit && (auditAgeHours ?? Infinity) <= 168 && (coveragePct === null || coveragePct >= 84)) {
    return 'high';
  }
  return 'medium';
}

function efficiencyScore(campaign: AssistantCampaignInsight) {
  const conversions = campaign.metrics_7d.conversions;
  const roas = campaign.metrics_7d.roas ?? 0;
  const cpa = campaign.metrics_7d.cpa ?? campaign.metrics_7d.cost;
  return conversions * 100 + roas * 20 - cpa;
}

function ageHours(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return round(Math.max(0, now.getTime() - timestamp) / 3_600_000, 1);
}

function latestTimestamp(values: Array<string | null | undefined>) {
  const timestamps = values
    .map((value) => ({ value, timestamp: value ? Date.parse(value) : Number.NaN }))
    .filter((entry): entry is { value: string; timestamp: number } => Boolean(entry.value) && Number.isFinite(entry.timestamp));
  return timestamps.sort((left, right) => right.timestamp - left.timestamp)[0]?.value ?? null;
}

function compactPromptValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return sanitizePromptText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? round(value) : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => compactPromptValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, item]) => [sanitizePromptText(key), compactPromptValue(item, depth + 1)])
    );
  }
  return null;
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function cleanText(value: unknown) {
  const text = typeof value === 'string' ? sanitizePromptText(value).trim() : '';
  return text || null;
}

function normalizedCurrency(value: unknown) {
  const currency = String(value ?? 'SAR').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'SAR';
}

function positiveOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? round(number) : null;
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? round(number) : null;
}

function nonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
