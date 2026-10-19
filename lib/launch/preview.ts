import type { LaunchPlan } from './types';

/**
 * What the merchant reads before approving «ابنِ الحملة موقوفة». A pure model
 * (strings only) so the card and the tests share one source. Najdi, short and
 * direct; no dashes, Arabic commas only.
 */

export type LaunchPreviewModel = {
  title: string;
  facts: Array<{ label: string; value: string }>;
  groups: Array<{ name: string; summary: string; keywords: string[]; headlines: string[]; description: string | null; url: string }>;
  off: string[];
  notes: string[];
  blockers: string[];
};

const TYPE_AR: Record<string, string> = {
  SEARCH: 'حملة بحث',
  SHOPPING: 'حملة تسوق عادية',
  PMAX: 'حملة أداء أقصى',
};

const sarText = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} ريال`;
const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

export function launchPreviewModel(plan: LaunchPlan): LaunchPreviewModel {
  const regions = plan.geo.regions.map((region) => region.name);
  const assetBits: string[] = [];
  if (plan.assets.sitelinks.length) assetBits.push(count(plan.assets.sitelinks.length, 'رابط فرعي', 'روابط فرعية'));
  if (plan.assets.callouts.length) assetBits.push(count(plan.assets.callouts.length, 'عبارة إبراز', 'عبارات إبراز'));
  if (plan.assets.structured_snippet) assetBits.push('مقتطف منظم');
  if (plan.assets.call_phone) assetBits.push('زر اتصال');
  if (plan.assets.use_location_sync) assetBits.push('الموقع إذا كان مربوط');

  const negativeCount = plan.campaign_negatives.length + plan.shared_negative_list.keywords.length;
  const facts = [
    { label: 'النوع', value: TYPE_AR[plan.type] ?? plan.type },
    { label: 'الميزانية اليومية', value: sarText(plan.budget.daily_sar) },
    { label: 'المزايدة', value: plan.bidding.note_ar },
    { label: 'المنطقة', value: regions.length ? `${regions.join('، ')} (المتواجدين فيها)` : 'السعودية (المتواجدين فيها)' },
    { label: 'لغة الإعلان', value: plan.language === 'ar' ? 'عربي' : 'إنجليزي' },
    { label: 'كلمات سلبية', value: negativeCount ? `${negativeCount} كلمة تمنع البحث غير المناسب` : 'لا يوجد' },
  ];
  if (assetBits.length) facts.push({ label: 'الإضافات', value: assetBits.join('، ') });

  return {
    title: plan.name,
    facts,
    groups: plan.ad_groups.map((group) => ({
      name: group.name,
      summary: group.keywords.length
        ? `${count(group.keywords.length, 'كلمة', 'كلمة')} و${group.rsa ? `${group.rsa.headlines.length} عنوان` : 'بدون إعلان نصي'}`
        : 'منتجات المتجر',
      keywords: group.keywords.slice(0, 4).map((k) => (k.match_type === 'EXACT' ? `[${k.text}]` : `"${k.text}"`)),
      headlines: (group.rsa?.headlines ?? []).slice(0, 3),
      description: group.rsa?.descriptions[0] ?? null,
      url: group.final_url,
    })),
    off: [
      'الحملة تنبني موقوفة ولا تصرف شي لين تشغلها',
      'شركاء البحث مقفلين',
      'شبكة العرض مقفلة',
      'ما فيه أي استهداف واسع للكلمات',
    ],
    notes: plan.warnings_ar,
    blockers: plan.blockers.map((b) => b.message_ar),
  };
}
