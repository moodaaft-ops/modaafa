import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { formatCurrency } from '@/lib/utils';

/**
 * Shape of a completed audit.
 *
 * This type used to live in `lib/ai/audit-agent.ts` alongside an LLM-driven
 * `runAudit()` that asked the model to grade a full account snapshot. Nothing
 * ever called it: the shipping audit is `runRuleBasedAudit` below, which
 * derives every score and finding from cached metrics with no model in the
 * loop. Keeping the unused path around meant a 12-query gRPC snapshot
 * gatherer and an 8k-token model call sat one import away from production
 * while being covered by no test and no guardrail, so both were removed and
 * the type — the only part with a live consumer — moved here.
 */
export interface AuditResult {
  health_score: number;
  category_scores: Record<string, number>;
  estimated_monthly_waste_sar: number;
  summary_ar: string;
  summary_en: string;
  findings: Array<{
    category: string;
    severity: 'critical' | 'medium' | 'growth';
    title_ar: string;
    title_en: string;
    description_ar: string;
    description_en: string;
    expected_impact: {
      metric: string;
      delta_pct: number;
      delta_sar_per_month: number;
    };
    action_payload: {
      operation: string;
      details: Record<string, unknown>;
    };
  }>;
}

type CachedCampaign = {
  id: string;
  google_campaign_id: number;
  name: string | null;
  type: string | null;
  status: string | null;
  daily_budget: number | null;
  metrics_30d: any;
  metrics_7d: any;
  metrics_today: any;
};

type AccountContext = {
  customer_id: string;
  customer_name: string | null;
  currency_code?: string | null;
};

export function runRuleBasedAudit({
  account,
  campaigns,
  conversionTracking = null,
  benchmark = null,
}: {
  account: AccountContext;
  campaigns: CachedCampaign[];
  /**
   * Live check from the Google Ads API: how many ENABLED conversion actions
   * the account has. `null` means the check could not run (offline audit) —
   * treated as unknown, never as healthy.
   */
  conversionTracking?: { enabled_actions: number } | null;
  /**
   * Anonymous sector medians (>= 3 businesses) in the account's currency.
   * `null` when the platform does not yet have enough peers in this sector.
   */
  benchmark?: {
    businesses_count: number;
    median_cpa: number | null;
    median_ctr: number | null;
    median_roas: number | null;
  } | null;
}): AuditResult {
  const active = campaigns.filter((campaign) => campaign.status === 'ENABLED');
  const m30 = campaigns.map((campaign) => ({
    campaign,
    metrics: normalizeMetrics(campaign.metrics_30d),
  }));
  const activeM30 = m30.filter(({ campaign }) => campaign.status === 'ENABLED');

  const currencyCode = account.currency_code ?? 'SAR';
  const spend30 = sum(m30, ({ metrics }) => metrics.cost);
  const spend7 = sum(campaigns, (campaign) => normalizeMetrics(campaign.metrics_7d).cost);
  const conversions30 = sum(m30, ({ metrics }) => metrics.conversions);
  const clicks30 = sum(m30, ({ metrics }) => metrics.clicks);
  const impressions30 = sum(m30, ({ metrics }) => metrics.impressions);
  const ctr30 = impressions30 > 0 ? clicks30 / impressions30 : 0;
  const avgCpa = conversions30 > 0 ? spend30 / conversions30 : spend30;

  const findings: AuditResult['findings'] = [];
  const spendNoConversions = activeM30
    .filter(({ metrics }) => metrics.cost > 0 && metrics.conversions === 0)
    .sort((a, b) => b.metrics.cost - a.metrics.cost);
  const lowCtrCampaigns = activeM30
    .filter(({ metrics }) => metrics.impressions >= 500 && metrics.ctr > 0 && metrics.ctr < 0.035)
    .sort((a, b) => a.metrics.ctr - b.metrics.ctr);
  const expensiveCampaigns = activeM30
    .filter(({ metrics }) => metrics.conversions > 0 && metrics.cpa > Math.max(60, avgCpa * 1.35))
    .sort((a, b) => b.metrics.cpa - a.metrics.cpa);
  const zeroSpendActive = activeM30.filter(({ metrics }) => metrics.cost === 0);

  if (campaigns.length === 0) {
    findings.push({
      category: 'structure',
      severity: 'critical',
      title_ar: 'لا توجد حملات محفوظة بعد',
      title_en: 'No cached campaigns yet',
      description_ar: 'الحساب مربوط، لكن المنصة لم تسحب الحملات بعد. شغّل المزامنة أو أعد ربط الحساب إذا استمرت المشكلة.',
      description_en: 'The account is connected but no campaigns are cached yet.',
      expected_impact: { metric: 'cost', delta_pct: 0, delta_sar_per_month: 0 },
      action_payload: { operation: 'sync_campaigns', details: { customer_id: account.customer_id } },
    });
  }

  if (active.length === 0 && campaigns.length > 0) {
    findings.push({
      category: 'structure',
      severity: 'critical',
      title_ar: 'لا توجد حملات مفعلة',
      title_en: 'No enabled campaigns',
      description_ar: 'كل الحملات الموجودة موقوفة، لذلك لا يمكن للمنصة تحسين الأداء قبل تحديد الحملات التي يجب تشغيلها.',
      description_en: 'All campaigns are paused, so optimization cannot improve delivery yet.',
      expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
      action_payload: { operation: 'review_paused_campaigns', details: { paused_count: campaigns.length } },
    });
  }

  for (const item of spendNoConversions.slice(0, 3)) {
    const monthlyWaste = item.metrics.cost;
    findings.push({
      category: 'budget',
      severity: monthlyWaste >= 500 ? 'critical' : 'medium',
      title_ar: `صرف بدون تحويلات: ${item.campaign.name ?? item.campaign.google_campaign_id}`,
      title_en: 'Spend without conversions',
      description_ar: `هذه الحملة صرفت ${formatCurrency(monthlyWaste, currencyCode)} خلال آخر 30 يوم بدون تحويلات. راجع الكلمات والبحث الفعلي قبل زيادة الميزانية.`,
      description_en: 'Campaign spent budget in the last 30 days without recorded conversions.',
      expected_impact: {
        metric: 'cost',
        delta_pct: 15,
        delta_sar_per_month: round(monthlyWaste * 0.4),
      },
      action_payload: {
        operation: 'review_or_reduce_campaign_budget',
        details: {
          campaign_id: item.campaign.google_campaign_id,
          campaign_name: item.campaign.name,
          cost_30d: item.metrics.cost,
          currency_code: currencyCode,
        },
      },
    });
  }

  for (const item of expensiveCampaigns.slice(0, 3)) {
    findings.push({
      category: 'bidding',
      severity: 'medium',
      title_ar: `تكلفة تحويل مرتفعة: ${item.campaign.name ?? item.campaign.google_campaign_id}`,
      title_en: 'High conversion cost',
      description_ar: `متوسط تكلفة التحويل ${formatCurrency(item.metrics.cpa, currencyCode)} أعلى من متوسط الحساب. خفف الميزانية أو راجع استراتيجية المزايدة.`,
      description_en: 'The campaign CPA is materially above the account average.',
      expected_impact: {
        metric: 'cpa',
        delta_pct: 12,
        delta_sar_per_month: round(item.metrics.cost * 0.15),
      },
      action_payload: {
        operation: 'adjust_bidding_or_budget',
        details: {
          campaign_id: item.campaign.google_campaign_id,
          campaign_name: item.campaign.name,
          cpa: item.metrics.cpa,
          currency_code: currencyCode,
        },
      },
    });
  }

  for (const item of lowCtrCampaigns.slice(0, 3)) {
    findings.push({
      category: 'ads',
      severity: 'growth',
      title_ar: `نسبة نقر منخفضة: ${item.campaign.name ?? item.campaign.google_campaign_id}`,
      title_en: 'Low click-through rate',
      description_ar: `نسبة النقر ${formatPercent(item.metrics.ctr)} منخفضة مقارنة بحجم الظهور. جرّب عناوين أو إضافات إعلان أقوى.`,
      description_en: 'CTR is low relative to impression volume.',
      expected_impact: {
        metric: 'ctr',
        delta_pct: 10,
        delta_sar_per_month: round(item.metrics.cost * 0.08),
      },
      action_payload: {
        operation: 'improve_ad_copy_and_assets',
        details: {
          campaign_id: item.campaign.google_campaign_id,
          campaign_name: item.campaign.name,
          ctr: item.metrics.ctr,
        },
      },
    });
  }

  // Sector comparison — the number no generic blog post can give: how this
  // account performs against REAL peers in the same sector and currency.
  const benchmarkCpa = benchmark?.median_cpa ?? null;
  if (
    benchmarkCpa !== null &&
    benchmarkCpa > 0 &&
    conversions30 > 0 &&
    avgCpa > benchmarkCpa * 1.5
  ) {
    const multiplier = round(avgCpa / benchmarkCpa, 1);
    findings.push({
      category: 'bidding',
      severity: multiplier >= 2 ? 'critical' : 'medium',
      title_ar: `تكلفة تحويلك أعلى من متوسط قطاعك بـ ${multiplier}×`,
      title_en: 'CPA is above the sector median',
      description_ar: `متوسط تكلفة التحويل في حسابك ${formatCurrency(avgCpa, currencyCode)} بينما متوسط قطاعك على المنصة ${formatCurrency(benchmarkCpa, currencyCode)} (مبني على ${benchmark!.businesses_count} أنشطة مشابهة). هذا الفارق عادةً يعني هدراً في الكلمات أو مزايدة أعلى من اللازم — راجع توصيات الكلمات والمزايدة أولاً.`,
      description_en: `Account CPA is ${multiplier}x the sector median across ${benchmark!.businesses_count} peer businesses.`,
      expected_impact: {
        metric: 'cpa',
        delta_pct: Math.min(35, Math.round((1 - benchmarkCpa / avgCpa) * 100)),
        delta_sar_per_month: round(spend30 * Math.min(0.3, 1 - benchmarkCpa / avgCpa)),
      },
      action_payload: {
        operation: 'review_vs_sector_benchmark',
        details: {
          account_cpa: round(avgCpa),
          sector_median_cpa: benchmarkCpa,
          businesses_count: benchmark!.businesses_count,
          currency_code: currencyCode,
        },
      },
    });
  }

  if (zeroSpendActive.length > 0) {
    findings.push({
      category: 'structure',
      severity: 'medium',
      title_ar: 'حملات مفعلة بلا صرف',
      title_en: 'Enabled campaigns with no spend',
      description_ar: `يوجد ${zeroSpendActive.length} حملة مفعلة لكنها لم تصرف خلال آخر 30 يوم. افحص القيود، الكلمات، الميزانية، أو حالة الموافقات.`,
      description_en: 'Some enabled campaigns have no spend in the last 30 days.',
      expected_impact: { metric: 'conversions', delta_pct: 8, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'diagnose_zero_spend_campaigns',
        details: { campaign_ids: zeroSpendActive.map(({ campaign }) => campaign.google_campaign_id) },
      },
    });
  }

  // Conversion tracking health — checked BEFORE interpreting any conversion
  // number, because with broken tracking every downstream metric lies.
  const trackingMissing = conversionTracking !== null && conversionTracking.enabled_actions === 0;
  const trackingSuspect =
    !trackingMissing && spend30 > 0 && clicks30 >= 100 && conversions30 === 0;

  if (trackingMissing) {
    findings.push({
      category: 'targeting',
      severity: 'critical',
      title_ar: 'تتبع التحويلات غير مفعّل',
      title_en: 'Conversion tracking is not set up',
      description_ar:
        'لا يوجد أي إجراء تحويل مفعّل في هذا الحساب، يعني Google لا تعرف متى يشتري العميل أو يتواصل معك. هذه أهم خطوة قبل أي تحسين: بدون تتبع، كل قرارات الميزانية والمزايدة تصير تخميناً. فعّل تتبع التحويلات أولاً.',
      description_en: 'No enabled conversion actions exist. Every optimization decision is blind until tracking is set up.',
      expected_impact: { metric: 'conversions', delta_pct: 30, delta_sar_per_month: round(spend30 * 0.3) },
      action_payload: { operation: 'setup_conversion_tracking', details: { customer_id: account.customer_id } },
    });
  } else if (trackingSuspect) {
    findings.push({
      category: 'targeting',
      severity: 'critical',
      title_ar: 'يبدو أن تتبع التحويلات معطل',
      title_en: 'Conversion tracking looks broken',
      description_ar: `الحساب استقبل ${clicks30} نقرة خلال 30 يوماً بدون أي تحويل مسجل${conversionTracking ? '، رغم وجود إجراءات تحويل مفعلة' : ''}. إما أن كود التتبع لا يعمل على الموقع، أو أن الاستهداف بعيد تماماً عن جمهورك. تحقق من التتبع أولاً قبل أي قرار تحسين.`,
      description_en: 'Real click volume with zero recorded conversions — verify the tracking tag before optimizing.',
      expected_impact: { metric: 'conversions', delta_pct: 20, delta_sar_per_month: round(spend30 * 0.25) },
      action_payload: { operation: 'audit_conversion_tracking', details: { customer_id: account.customer_id } },
    });
  } else if (spend30 > 0 && conversions30 === 0) {
    findings.push({
      category: 'targeting',
      severity: 'critical',
      title_ar: 'لا توجد تحويلات مسجلة',
      title_en: 'No conversions recorded',
      description_ar: 'الحساب يصرف لكن لا تظهر تحويلات. قد تكون المشكلة في تتبع التحويلات أو جودة الاستهداف.',
      description_en: 'The account has spend but no recorded conversions.',
      expected_impact: { metric: 'conversions', delta_pct: 20, delta_sar_per_month: round(spend30 * 0.25) },
      action_payload: { operation: 'audit_conversion_tracking', details: { customer_id: account.customer_id } },
    });
  }

  const estimatedWaste = Math.min(
    spend30,
    sum(spendNoConversions, ({ metrics }) => metrics.cost * 0.5) +
      sum(expensiveCampaigns, ({ metrics }) => metrics.cost * 0.12)
  );
  const score = clamp(
    88 -
      (active.length === 0 ? 30 : 0) -
      // Broken tracking undermines every other number, so it drags the
      // headline score harder than any single wasteful campaign.
      (trackingMissing ? 18 : trackingSuspect ? 12 : 0) -
      Math.min(22, (estimatedWaste / Math.max(1, spend30)) * 35) -
      (ctr30 > 0 && ctr30 < 0.04 ? 8 : 0) -
      (zeroSpendActive.length > 0 ? 5 : 0),
    35,
    94
  );

  const categoryScores = {
    structure: clamp(active.length > 0 ? 78 - zeroSpendActive.length * 4 : 45, 35, 92),
    ad_quality: clamp(ctr30 >= 0.06 ? 85 : ctr30 >= 0.035 ? 72 : 58, 40, 90),
    keywords: clamp(spendNoConversions.length > 0 ? 62 : 78, 45, 90),
    negative_keywords: clamp(spendNoConversions.length > 0 ? 55 : 75, 40, 88),
    bidding: clamp(expensiveCampaigns.length > 0 ? 61 : 78, 45, 90),
    budget: clamp(estimatedWaste > spend30 * 0.2 ? 58 : 80, 40, 92),
    targeting: clamp(
      trackingMissing ? 40 : trackingSuspect ? 45 : conversions30 > 0 ? 76 : spend30 > 0 ? 52 : 68,
      40,
      88
    ),
  };

  const sortedFindings = findings
    .sort((a, b) => b.expected_impact.delta_sar_per_month - a.expected_impact.delta_sar_per_month)
    .slice(0, 12);

  return {
    health_score: Math.round(score),
    category_scores: categoryScores,
    estimated_monthly_waste_sar: round(estimatedWaste),
    summary_ar: buildSummary(account, {
      activeCount: active.length,
      campaignCount: campaigns.length,
      spend7,
      spend30,
      conversions30,
      estimatedWaste,
      currencyCode,
    }),
    summary_en: `Account ${googleAdsAccountDisplayName(account)} has ${active.length} enabled campaigns out of ${campaigns.length}. Estimated monthly waste is ${round(estimatedWaste)} ${currencyCode}.`,
    findings: sortedFindings,
  };
}

function buildSummary(
  account: AccountContext,
  metrics: {
    activeCount: number;
    campaignCount: number;
    spend7: number;
    spend30: number;
    conversions30: number;
    estimatedWaste: number;
    currencyCode: string;
  }
) {
  if (metrics.campaignCount === 0) {
    return `حساب ${googleAdsAccountDisplayName(account)} مربوط، لكن لا توجد حملات محفوظة بعد. شغّل المزامنة أولاً حتى يبدأ الفحص.`;
  }

  return `حساب ${googleAdsAccountDisplayName(account)} لديه ${metrics.activeCount} حملة مفعلة من أصل ${metrics.campaignCount}. صرف آخر 7 أيام ${formatCurrency(metrics.spend7, metrics.currencyCode)}، وآخر 30 يوم ${formatCurrency(metrics.spend30, metrics.currencyCode)} مع ${round(metrics.conversions30, 2)} تحويل، والتسريب المتوقع ${formatCurrency(metrics.estimatedWaste, metrics.currencyCode)} شهرياً.`;
}

function normalizeMetrics(value: any) {
  return {
    cost: moneyMetric(value, 'cost'),
    clicks: Number(value?.clicks ?? 0),
    impressions: Number(value?.impressions ?? 0),
    conversions: Number(value?.conversions ?? 0),
    conversion_value: moneyMetric(value, 'conversion_value'),
    ctr: Number(value?.ctr ?? 0),
    cpc: moneyMetric(value, 'cpc'),
    cpa: moneyMetric(value, 'cpa'),
    roas: Number(value?.roas ?? 0),
  };
}

function sum<T>(items: T[], getter: (item: T) => number) {
  return items.reduce((total, item) => total + getter(item), 0);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function formatPercent(value: number) {
  // Latin digits: this string is embedded in findings that are also read
  // by the model and shown next to other Latin-numeral metrics.
  return `${round(value * 100, 1)}%`;
}
