import type { RsaSummary } from './assets-reader';

/**
 * Disapproved ads (what the merchant sees as "إعلان مرفوض").
 *
 * The card itself is the existing replace_rsa_assets card (writer + validators
 * + approval + rollback). This file only adds: the Arabic names of the policy
 * topics, and the appeal text the merchant can paste into Google Ads.
 *
 * NOTHING here submits anything. Appeals are submitted by the merchant in the
 * Google Ads interface. Policy exemption requests exist in the API
 * (policy_validation_parameter.exempt_policy_violation_keys on an ad create or
 * update, only for violations Google marks exemptible), but the platform does
 * not use them: it was not verified live, and an exemption is a legal claim the
 * merchant must make themselves. See docs/mb-upgrade/uxgaps.md.
 */

const TOPIC_LABELS_AR: Record<string, string> = {
  UNRELIABLE_CLAIMS: 'ادعاءات غير موثوقة',
  MISLEADING_CLAIMS: 'ادعاءات مضللة',
  PUNCTUATION_AND_SYMBOLS: 'علامات ترقيم أو رموز غير مسموحة',
  EXCESSIVE_CAPITALIZATION: 'مبالغة في الحروف الكبيرة',
  GIBBERISH: 'نص غير مفهوم',
  REPETITION: 'تكرار زايد',
  EDITORIAL: 'معايير الصياغة والتحرير',
  EDITORIAL_AND_PROFESSIONAL_REQUIREMENTS: 'معايير الصياغة والتحرير',
  HEALTH_IN_PERSONALIZED_ADS: 'معلومات صحية شخصية',
  HEALTHCARE: 'خدمات صحية مقيّدة',
  PHARMA: 'أدوية ومنتجات صيدلانية',
  ALCOHOL: 'كحول',
  TOBACCO: 'تبغ',
  GAMBLING: 'مقامرة',
  WEAPONS: 'أسلحة',
  DANGEROUS_PRODUCTS: 'منتجات خطرة',
  COUNTERFEIT: 'منتجات مقلدة',
  TRADEMARKS: 'علامة تجارية',
  TRADEMARK_IN_AD_TEXT: 'علامة تجارية في نص الإعلان',
  ADULT_CONTENT: 'محتوى للكبار',
  SEXUALLY_SUGGESTIVE_CONTENT: 'محتوى إيحائي',
  FINANCIAL_SERVICES: 'خدمات مالية مقيّدة',
  DESTINATION_NOT_WORKING: 'صفحة الوجهة ما تشتغل',
  DESTINATION_MISMATCH: 'صفحة الوجهة ما تطابق الإعلان',
  LANDING_PAGE_EXPERIENCE: 'تجربة صفحة الهبوط',
  MALWARE: 'برمجيات خبيثة',
  DISHONEST_PRICING_PRACTICES: 'تسعير غير واضح',
  DISCOUNT_AND_PRICE_CLAIMS: 'ادعاءات خصم أو سعر',
};

const TOPIC_RE = /^[A-Za-z0-9_ .:-]{2,80}$/;

export function policyTopicLabelAr(topic: string): string {
  const key = String(topic ?? '').trim().toUpperCase().replace(/[ .:-]+/g, '_');
  return TOPIC_LABELS_AR[key] ?? 'مخالفة لسياسة الإعلانات';
}

export type DisapprovalFinding = {
  ad_group_ad: string;
  name: string;
  /** Policy topic ids from Google, only ones with a safe shape. */
  topics: string[];
  topics_ar: string[];
  /** The exact texts Google disapproved. */
  texts: Array<{ field: 'HEADLINE' | 'DESCRIPTION'; text: string }>;
};

export function disapprovalFindings(rsas: readonly RsaSummary[]): DisapprovalFinding[] {
  const out: DisapprovalFinding[] = [];
  for (const rsa of rsas) {
    if (rsa.status === 'REMOVED') continue;
    const assets = [...rsa.headlines, ...rsa.descriptions].filter((a) => a.approval === 'DISAPPROVED');
    if (assets.length === 0) continue;
    const topics = [...new Set(assets.flatMap((a) => a.policy_topics).filter((t) => TOPIC_RE.test(t)))].slice(0, 5);
    out.push({
      ad_group_ad: rsa.ad_group_ad,
      name: rsa.ad_group_name || rsa.campaign_name,
      topics,
      topics_ar: [...new Set(topics.map(policyTopicLabelAr))],
      texts: assets.map((a) => ({ field: a.field, text: a.text })),
    });
  }
  return out;
}

/**
 * The text the merchant can paste when they appeal in Google Ads. Rules only,
 * no model, no invented facts: it names the ad, the topics Google gave, and
 * states that the flagged texts were rewritten. It does not claim anything
 * about the business.
 */
export function buildAppealText(args: {
  adName: string;
  topicsAr: readonly string[];
  replaced: ReadonlyArray<{ old_text: string; new_text: string }>;
}): string {
  const topics = args.topicsAr.length > 0 ? args.topicsAr.join(' و') : 'سياسة الإعلانات';
  const lines = [
    `السلام عليكم،`,
    `إعلان "${args.adName}" انرفض بسبب: ${topics}.`,
    `راجعنا النصوص اللي ذكرتوها وعدلناها لتوافق سياسة الإعلانات.`,
  ];
  if (args.replaced.length > 0) {
    lines.push('النصوص بعد التعديل:');
    for (const r of args.replaced.slice(0, 7)) lines.push(`- ${r.new_text}`);
  }
  lines.push('نرجو مراجعة الإعلان مرة ثانية. شاكرين لكم.');
  return lines.join('\n');
}
