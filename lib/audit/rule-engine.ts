import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { moneyMetric } from '@/lib/google-ads/metrics';
import { formatCurrency } from '@/lib/utils';
import type { AuditLiveSnapshot, AuditConfidence } from '@/lib/audit/live-snapshot';

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
      evidence_ar?: string[];
      confidence?: AuditConfidence;
      source?: 'google_ads_live' | 'campaign_cache' | 'sector_benchmark' | 'data_coverage';
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
  liveSnapshot = null,
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
  liveSnapshot?: AuditLiveSnapshot | null;
}): AuditResult {
  const active = campaigns.filter((campaign) => campaign.status === 'ENABLED');
  const m30 = campaigns.map((campaign) => ({
    campaign,
    metrics: normalizeMetrics(campaign.metrics_30d),
  }));
  const activeM30 = m30.filter(({ campaign }) => campaign.status === 'ENABLED');

  const currencyCode = account.currency_code ?? 'SAR';
  const cachedSpend30 = sum(m30, ({ metrics }) => metrics.cost);
  const liveSpend30 = sum(liveSnapshot?.campaigns ?? [], (campaign) => campaign.cost);
  const spend30 = cachedSpend30 > 0 ? cachedSpend30 : liveSpend30;
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

  const liveWastedTerms = (liveSnapshot?.search_terms ?? [])
    .filter((term) => term.conversions === 0 && (term.clicks >= 7 || term.cost >= Math.max(20, avgCpa * 0.25)))
    .sort((a, b) => b.cost - a.cost);
  const lowQualityKeywords = (liveSnapshot?.keywords ?? [])
    .filter((keyword) => keyword.quality_score !== null && keyword.quality_score <= 5 && (keyword.cost > 0 || keyword.impressions >= 100))
    .sort((a, b) => b.cost - a.cost);
  const weakOrDisapprovedAds = (liveSnapshot?.ads ?? [])
    .filter((ad) => ad.approval_status === 'DISAPPROVED' || (ad.ad_strength === 'POOR' && ad.impressions >= 100))
    .sort((a, b) => b.impressions - a.impressions);

  for (const term of liveWastedTerms.slice(0, 5)) {
    findings.push({
      category: 'keywords',
      severity: term.cost >= Math.max(100, avgCpa) ? 'critical' : 'medium',
      title_ar: `عبارة بحث تستهلك الميزانية بلا نتيجة: ${term.term}`,
      title_en: 'Search term spending without conversions',
      description_ar: `ظهرت عبارة البحث الفعلية هذه للمستخدمين وحققت ${term.clicks} نقرة بتكلفة ${formatCurrency(term.cost, currencyCode)} دون تحويل. راجع ملاءمتها قبل إضافتها ككلمة سلبية؛ لا ينفذ الفحص أي تعديل تلقائياً.`,
      description_en: 'A real search term consumed budget without a recorded conversion.',
      expected_impact: { metric: 'cost', delta_pct: 8, delta_sar_per_month: round(term.cost) },
      action_payload: {
        operation: 'review_wasted_search_term',
        details: {
          search_term: term.term,
          campaign_name: term.campaign_name,
          campaign_resource_name: term.campaign_resource_name,
          ad_group_resource_name: term.ad_group_resource_name,
          cost_30d: term.cost,
          clicks_30d: term.clicks,
          currency_code: currencyCode,
        },
        evidence_ar: [
          `${term.clicks} نقرة خلال 30 يوماً`,
          `${formatCurrency(term.cost, currencyCode)} صرف بلا تحويلات`,
          `الحملة: ${term.campaign_name || 'غير مسماة'}`,
        ],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  for (const keyword of lowQualityKeywords.slice(0, 4)) {
    findings.push({
      category: 'keywords',
      severity: keyword.quality_score !== null && keyword.quality_score <= 3 ? 'critical' : 'medium',
      title_ar: `جودة كلمة منخفضة: ${keyword.text}`,
      title_en: 'Low keyword quality score',
      description_ar: `درجة الجودة ${keyword.quality_score}/10، وهذا قد يرفع تكلفة النقرة ويضعف ترتيب الإعلان. راجع صلة الإعلان وتجربة صفحة الهبوط وتوقع النقر لهذه الكلمة.`,
      description_en: 'Keyword quality score is low and may increase CPC or weaken ad rank.',
      expected_impact: { metric: 'cpc', delta_pct: 10, delta_sar_per_month: round(keyword.cost * 0.12) },
      action_payload: {
        operation: 'review_low_quality_keyword',
        details: {
          keyword: keyword.text,
          resource_name: keyword.resource_name,
          quality_score: keyword.quality_score,
          expected_ctr: keyword.expected_ctr,
          ad_relevance: keyword.ad_relevance,
          landing_page_experience: keyword.landing_page_experience,
        },
        evidence_ar: [
          `درجة الجودة ${keyword.quality_score}/10`,
          `${keyword.impressions} ظهور و${keyword.clicks} نقرة`,
          `${formatCurrency(keyword.cost, currencyCode)} صرف خلال 30 يوماً`,
        ],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  for (const ad of weakOrDisapprovedAds.slice(0, 3)) {
    const disapproved = ad.approval_status === 'DISAPPROVED';
    findings.push({
      category: 'ads',
      severity: disapproved ? 'critical' : 'medium',
      title_ar: disapproved ? `إعلان غير مؤهل للعرض: ${ad.ad_group_name}` : `قوة إعلان ضعيفة: ${ad.ad_group_name}`,
      title_en: disapproved ? 'Disapproved ad' : 'Poor ad strength',
      description_ar: disapproved
        ? 'Google صنفت الإعلان كغير موافق عليه. راجع سبب السياسة والإعلان قبل توقع أي ظهور منه.'
        : 'قوة الإعلان مصنفة POOR مع وجود ظهور فعلي. حسّن تنوع العناوين والأوصاف وصلتها بالكلمات.',
      description_en: disapproved ? 'Google reports a disapproved ad.' : 'The ad has POOR strength despite receiving impressions.',
      expected_impact: { metric: 'ctr', delta_pct: 10, delta_sar_per_month: round(ad.cost * 0.08) },
      action_payload: {
        operation: 'review_ad_policy_or_strength',
        details: {
          resource_name: ad.resource_name,
          campaign_name: ad.campaign_name,
          ad_group_name: ad.ad_group_name,
          ad_strength: ad.ad_strength,
          approval_status: ad.approval_status,
        },
        evidence_ar: [
          `حالة الموافقة: ${ad.approval_status ?? 'غير متاحة'}`,
          `قوة الإعلان: ${ad.ad_strength ?? 'غير متاحة'}`,
          `${ad.impressions} ظهور ونسبة نقر ${formatPercent(ad.ctr)}`,
        ],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  const liveCampaignById = new Map((liveSnapshot?.campaigns ?? []).map((campaign) => [campaign.id, campaign]));
  const budgetLimitedWinners = (liveSnapshot?.search_share ?? [])
    .map((share) => ({ share, campaign: liveCampaignById.get(share.campaign_id) }))
    .filter(({ share, campaign }) =>
      Boolean(
        campaign &&
        campaign.conversions > 0 &&
        share.lost_budget_share !== null &&
        share.lost_budget_share >= 0.15 &&
        (avgCpa <= 0 || campaign.cost / campaign.conversions <= avgCpa * 1.1)
      )
    )
    .sort((a, b) => (b.share.lost_budget_share ?? 0) - (a.share.lost_budget_share ?? 0));

  for (const { share, campaign } of budgetLimitedWinners.slice(0, 3)) {
    if (!campaign) continue;
    findings.push({
      category: 'budget',
      severity: 'growth',
      title_ar: `حملة ناجحة تفقد ظهوراً بسبب الميزانية: ${campaign.name}`,
      title_en: 'Efficient campaign is budget limited',
      description_ar: `الحملة تحقق تحويلات، لكنها تفقد ${formatPercent(share.lost_budget_share ?? 0)} من فرص ظهور البحث بسبب الميزانية. راجع توزيع الميزانية بينها وبين الحملات الأضعف قبل رفع إجمالي الصرف.`,
      description_en: 'An efficient campaign is losing search impression share because of budget.',
      expected_impact: { metric: 'conversions', delta_pct: 12, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'review_budget_limited_winner',
        details: {
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          lost_budget_share: share.lost_budget_share,
          conversions_30d: campaign.conversions,
          cpa_30d: campaign.conversions > 0 ? round(campaign.cost / campaign.conversions) : null,
        },
        evidence_ar: [
          `${round(campaign.conversions, 2)} تحويل خلال 30 يوماً`,
          `فقد بسبب الميزانية ${formatPercent(share.lost_budget_share ?? 0)}`,
          `حصة الظهور ${share.impression_share === null ? 'غير متاحة' : formatPercent(share.impression_share)}`,
        ],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  const rankLimited = (liveSnapshot?.search_share ?? [])
    .filter((share) => share.lost_rank_share !== null && share.lost_rank_share >= 0.35)
    .sort((a, b) => (b.lost_rank_share ?? 0) - (a.lost_rank_share ?? 0));
  for (const share of rankLimited.slice(0, 2)) {
    findings.push({
      category: 'bidding',
      severity: 'medium',
      title_ar: `فقد ظهور مرتفع بسبب الترتيب: ${share.campaign_name}`,
      title_en: 'High search impression share loss from rank',
      description_ar: `الحملة تفقد ${formatPercent(share.lost_rank_share ?? 0)} من فرص ظهور البحث بسبب ترتيب الإعلان. راجع الجودة والمزايدة معاً؛ رفع المزايدة وحده ليس علاجاً دائماً.`,
      description_en: 'The campaign loses substantial search impression share due to ad rank.',
      expected_impact: { metric: 'impressions', delta_pct: 15, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'review_search_rank_loss',
        details: { campaign_id: share.campaign_id, campaign_name: share.campaign_name, lost_rank_share: share.lost_rank_share },
        evidence_ar: [`فقد بسبب الترتيب ${formatPercent(share.lost_rank_share ?? 0)}`],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  const keywordTexts = new Set((liveSnapshot?.keywords ?? []).map((keyword) => normalizeTerm(keyword.text)));
  const expansionTerms = (liveSnapshot?.search_terms ?? [])
    .filter((term) => term.conversions >= 2 && term.status !== 'ADDED' && !keywordTexts.has(normalizeTerm(term.term)))
    .sort((a, b) => b.conversions - a.conversions);
  for (const term of expansionTerms.slice(0, 3)) {
    findings.push({
      category: 'keywords',
      severity: 'growth',
      title_ar: `طلب مثبت يستحق تحكماً أدق: ${term.term}`,
      title_en: 'Converting search term is not managed as a keyword',
      description_ar: `عبارة البحث حققت ${round(term.conversions, 2)} تحويل وهي غير مضافة ككلمة مستقلة. راجع إضافتها بتطابق مناسب للحصول على تحكم أوضح في المزايدة والرسالة.`,
      description_en: 'A converting search term is not yet managed as its own keyword.',
      expected_impact: { metric: 'conversions', delta_pct: 5, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'review_converting_search_term',
        details: {
          search_term: term.term,
          campaign_name: term.campaign_name,
          ad_group_resource_name: term.ad_group_resource_name,
          conversions_30d: term.conversions,
          conversion_value_30d: term.conversion_value,
        },
        evidence_ar: [`${round(term.conversions, 2)} تحويل خلال 30 يوماً`, `${term.clicks} نقرة`, `الحالة في Google: ${term.status || 'غير مضافة'}`],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  const liveConversions = sum(liveSnapshot?.campaigns ?? [], (campaign) => campaign.conversions);
  const liveConversionValue = sum(liveSnapshot?.campaigns ?? [], (campaign) => campaign.conversion_value);
  if (liveSnapshot?.coverage.campaigns && liveConversions >= 5 && liveConversionValue === 0) {
    findings.push({
      category: 'targeting',
      severity: 'medium',
      title_ar: 'التحويلات مسجلة بلا قيمة مالية',
      title_en: 'Conversions have no recorded value',
      description_ar: `سجل الحساب ${round(liveConversions, 2)} تحويل خلال 30 يوماً، لكن قيمة التحويل الإجمالية صفر. بدون قيمة حقيقية لا يمكن قياس العائد ROAS أو التمييز بين طلب قوي وضعيف.`,
      description_en: 'Conversions are recorded without monetary value, so ROAS cannot be trusted.',
      expected_impact: { metric: 'roas', delta_pct: 0, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'review_conversion_values',
        details: { conversions_30d: liveConversions, conversion_value_30d: liveConversionValue },
        evidence_ar: [`${round(liveConversions, 2)} تحويل`, 'قيمة التحويل الإجمالية 0'],
        confidence: 'high',
        source: 'google_ads_live',
      },
    });
  }

  const pausedWinners = (liveSnapshot?.campaigns ?? [])
    .filter((campaign) => campaign.status === 'PAUSED' && campaign.conversions >= 3)
    .sort((a, b) => b.conversions - a.conversions);
  for (const campaign of pausedWinners.slice(0, 2)) {
    findings.push({
      category: 'structure',
      severity: 'growth',
      title_ar: `حملة موقوفة كانت تحقق نتائج: ${campaign.name}`,
      title_en: 'Paused campaign had recent conversions',
      description_ar: `الحملة موقوفة حالياً لكنها سجلت ${round(campaign.conversions, 2)} تحويل في نافذة الثلاثين يوماً. راجع سبب الإيقاف والموسمية قبل تجاهلها.`,
      description_en: 'A paused campaign still shows recent conversions and deserves a business review.',
      expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'review_paused_winner',
        details: { campaign_id: campaign.id, campaign_name: campaign.name, conversions_30d: campaign.conversions },
        evidence_ar: [`${round(campaign.conversions, 2)} تحويل خلال 30 يوماً`, 'الحالة الحالية PAUSED'],
        confidence: 'medium',
        source: 'google_ads_live',
      },
    });
  }

  const regressions = activeM30
    .map(({ campaign, metrics }) => ({ campaign, m30: metrics, m7: normalizeMetrics(campaign.metrics_7d) }))
    .filter(({ m30, m7 }) => m30.conversions > 0 && m7.conversions > 0 && m7.cpa > m30.cpa * 1.35 && m7.cost >= 50)
    .sort((a, b) => b.m7.cpa / Math.max(1, b.m30.cpa) - a.m7.cpa / Math.max(1, a.m30.cpa));
  for (const item of regressions.slice(0, 2)) {
    findings.push({
      category: 'bidding',
      severity: 'medium',
      title_ar: `تراجع حديث في الكفاءة: ${item.campaign.name ?? item.campaign.google_campaign_id}`,
      title_en: 'Recent campaign efficiency regression',
      description_ar: `تكلفة التحويل في آخر 7 أيام ${formatCurrency(item.m7.cpa, currencyCode)} مقابل ${formatCurrency(item.m30.cpa, currencyCode)} في متوسط 30 يوماً. افحص التغييرات الأخيرة وعبارات البحث قبل اتخاذ قرار ميزانية.`,
      description_en: 'Seven-day CPA is materially worse than the 30-day baseline.',
      expected_impact: { metric: 'cpa', delta_pct: 10, delta_sar_per_month: round(item.m7.cost * 0.1) },
      action_payload: {
        operation: 'review_recent_efficiency_regression',
        details: { campaign_id: item.campaign.google_campaign_id, cpa_7d: item.m7.cpa, cpa_30d: item.m30.cpa },
        evidence_ar: [`CPA آخر 7 أيام: ${formatCurrency(item.m7.cpa, currencyCode)}`, `CPA آخر 30 يوماً: ${formatCurrency(item.m30.cpa, currencyCode)}`],
        confidence: 'medium',
        source: 'campaign_cache',
      },
    });
  }

  if (liveSnapshot && liveSnapshot.coverage.coverage_pct < 100) {
    findings.push({
      category: 'structure',
      severity: liveSnapshot.coverage.confidence === 'limited' ? 'critical' : 'medium',
      title_ar: 'الفحص المتقدم لم يغطِ كل طبقات الحساب',
      title_en: 'Advanced audit coverage is incomplete',
      description_ar: `اكتملت ${liveSnapshot.coverage.coverage_pct}% من طبقات الفحص الحي. لم نعتبر غياب البيانات دليلاً على السلامة، وأبرزنا النتيجة بثقة ${confidenceLabel(liveSnapshot.coverage.confidence)}. أعد الفحص لاستكمال: ${liveSnapshot.coverage.failed_checks.join('، ')}.`,
      description_en: 'Some live Google Ads diagnostic layers were unavailable, so the score is confidence-capped.',
      expected_impact: { metric: 'data_quality', delta_pct: 0, delta_sar_per_month: 0 },
      action_payload: {
        operation: 'retry_incomplete_audit',
        details: { coverage_pct: liveSnapshot.coverage.coverage_pct, failed_checks: liveSnapshot.coverage.failed_checks },
        evidence_ar: [`نسبة تغطية الفحص ${liveSnapshot.coverage.coverage_pct}%`, ...liveSnapshot.coverage.failed_checks.map((check) => `تعذر: ${check}`)],
        confidence: liveSnapshot.coverage.confidence,
        source: 'data_coverage',
      },
    });
  }

  const estimatedWaste = Math.min(
    spend30,
    sum(spendNoConversions, ({ metrics }) => metrics.cost * 0.5) +
      sum(expensiveCampaigns, ({ metrics }) => metrics.cost * 0.12) +
      sum(liveWastedTerms, (term) => term.cost)
  );
  const severityPenalty = sum(findings, (finding) =>
    finding.severity === 'critical' ? 12 : finding.severity === 'medium' ? 6 : 2
  );
  const coverageCap = liveSnapshot
    ? liveSnapshot.coverage.confidence === 'high'
      ? 96
      : liveSnapshot.coverage.confidence === 'medium'
        ? 82
        : 72
    : 72;
  const score = Math.min(
    coverageCap,
    clamp(96 - severityPenalty - Math.min(12, (estimatedWaste / Math.max(1, spend30)) * 20), 25, 96)
  );

  const categoryScores = {
    structure: scoreForCategory(findings, ['structure']),
    ad_quality: scoreForCategory(findings, ['ads']),
    keywords: scoreForCategory(findings, ['keywords']),
    negative_keywords: scoreForCategory(findings, ['keywords'], liveWastedTerms.length > 0 ? 8 : 0),
    bidding: scoreForCategory(findings, ['bidding']),
    budget: scoreForCategory(findings, ['budget']),
    targeting: scoreForCategory(findings, ['targeting']),
    data_confidence: liveSnapshot?.coverage.coverage_pct ?? 0,
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

function scoreForCategory(
  findings: AuditResult['findings'],
  categories: string[],
  extraPenalty = 0
) {
  const penalty = sum(
    findings.filter((finding) => categories.includes(finding.category)),
    (finding) => finding.severity === 'critical' ? 18 : finding.severity === 'medium' ? 10 : 4
  );
  return Math.round(clamp(94 - penalty - extraPenalty, 28, 94));
}

function normalizeTerm(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}

function confidenceLabel(value: AuditConfidence) {
  if (value === 'high') return 'عالية';
  if (value === 'medium') return 'متوسطة';
  return 'محدودة';
}
