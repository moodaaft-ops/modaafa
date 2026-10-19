import type { LaunchContext } from '../lib/launch/plan';

export const headlines = [
  'عيادة أسنان في الرياض',
  'احجز موعدك اليوم',
  'تنظيف وتبييض الأسنان',
  'أطباء بخبرة عالية',
  'مواعيد مرنة طوال الأسبوع',
  'كشف مبدئي بسعر واضح',
  'ابتسامة تثق فيها',
  'عيادات النخبة للأسنان',
];
export const descriptions = [
  'احجز موعدك الآن في عيادتنا بالرياض واحصل على كشف واضح قبل أي علاج.',
  'فريق أسنان متخصص وأجهزة حديثة، ومواعيد تناسب وقتك.',
  'نشرح لك الخطة والتكلفة قبل ما نبدأ أي إجراء.',
];

export function draft(overrides: Record<string, unknown> = {}) {
  return {
    name: 'عيادات النخبة | بحث',
    type: 'SEARCH',
    objective: 'LEADS',
    daily_budget_sar: 100,
    bidding_strategy: 'MAXIMIZE_CLICKS',
    max_cpc_sar: 5,
    language: 'ar',
    landing_page: 'https://elite-clinics.example/dental',
    target_regions: ['الرياض'],
    ad_groups: [
      {
        name: 'تبييض الأسنان',
        keywords: [
          { text: 'تبييض اسنان', match_type: 'PHRASE' },
          { text: 'عيادة أسنان الرياض', match_type: 'EXACT' },
        ],
        headlines_ar: headlines,
        descriptions_ar: descriptions,
        path1: 'اسنان',
        path2: 'الرياض',
      },
    ],
    negative_keywords: [{ text: 'مجانا', match_type: 'PHRASE' }],
    sitelinks: [
      { link_text: 'احجز موعد', final_url: 'https://elite-clinics.example/book', description1: 'مواعيد مرنة', description2: 'بدون انتظار طويل' },
      { link_text: 'خدماتنا', final_url: 'https://elite-clinics.example/services' },
    ],
    callouts: ['كشف مبدئي', 'مواعيد مسائية', 'أطباء معتمدين'],
    structured_snippet: { header: 'Services', values: ['تبييض', 'تقويم', 'حشوات'] },
    ...overrides,
  };
}

export const context = (overrides: Partial<LaunchContext> = {}): LaunchContext => ({
  brief: 'ابغى حملة لعيادة أسنان في الرياض',
  businessName: 'عيادات النخبة',
  sector: 'عيادة أسنان',
  website: 'https://elite-clinics.example',
  phone: '0551234567',
  monthlyBudgetSar: 4000,
  currency: 'SAR',
  signals: { conversions_30d: 5, tracking_healthy: true, merchant_center_linked: false },
  resolvedRegions: { الرياض: 'geoTargetConstants/1012045' },
  ...overrides,
});
