export type StructurePreviewRow = { label: string; value: string; ltr?: boolean };

const KIND_AR: Record<string, string> = {
  website: 'موقع',
  youtube_channel: 'قناة يوتيوب',
  youtube_video: 'فيديو يوتيوب',
  mobile_app: 'تطبيق جوال',
  content_label: 'نوع محتوى',
};
const LABEL_AR: Record<string, string> = {
  SEXUALLY_SUGGESTIVE: 'محتوى إيحائي',
  BELOW_THE_FOLD: 'أسفل الصفحة',
  PARKED_DOMAIN: 'نطاقات مركونة',
  JUVENILE: 'محتوى أطفال ومراهقين',
  PROFANITY: 'ألفاظ نابية',
  TRAGEDY: 'مآسي وأخبار مؤلمة',
  VIDEO: 'فيديو',
  EMBEDDED_VIDEO: 'فيديو مضمّن',
  LIVE_STREAMING_VIDEO: 'بث مباشر',
  SOCIAL_ISSUES: 'قضايا اجتماعية',
};
const STRATEGY_AR: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: 'تعظيم التحويلات',
  MAXIMIZE_CONVERSION_VALUE: 'تعظيم قيمة التحويلات',
  TARGET_CPA: 'تكلفة التحويل المستهدفة',
  TARGET_ROAS: 'عائد الإنفاق المستهدف',
};
const DIMENSION_AR: Record<string, string> = {
  brand: 'الماركة',
  product_type: 'نوع المنتج',
  category: 'الفئة',
  custom_label: 'التصنيف المخصص',
  item_id: 'رقم المنتج',
};

const money = (micros: unknown) => (Number(micros) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
const names = (list: unknown) => (Array.isArray(list) ? list.length : 0);

/** Approval-card rows for the account-structure operations. Pure, Arabic (Saudi colloquial), no dashes. */
export function structurePreviewRows(operation: string, params: Record<string, any>, targetId?: string): StructurePreviewRow[] {
  const rows: StructurePreviewRow[] = [];
  switch (operation) {
    case 'set_ai_max':
      rows.push({ label: 'الحملة', value: String(params.campaign_resource ?? targetId ?? ''), ltr: true });
      rows.push({ label: 'الإعداد', value: params.enabled ? 'تشغيل ذكاء ماكس للبحث' : 'إيقاف ذكاء ماكس للبحث' });
      break;
    case 'add_placement_exclusions':
      rows.push({
        label: 'النطاق',
        value: params.level === 'account' ? 'كل الحساب' : String(params.campaign_resource ?? ''),
        ltr: params.level !== 'account',
      });
      for (const p of (params.placements ?? []).slice(0, 12)) {
        rows.push({
          label: KIND_AR[p.kind] ?? 'استبعاد',
          value: p.kind === 'content_label' ? LABEL_AR[p.value] ?? p.value : String(p.value),
          ltr: p.kind !== 'content_label',
        });
      }
      if (names(params.placements) > 12) rows.push({ label: 'غيرها', value: `${names(params.placements) - 12} استبعاد إضافي` });
      break;
    case 'create_shared_budget':
      rows.push({ label: 'اسم الميزانية', value: String(params.name ?? '') });
      rows.push({ label: 'الميزانية اليومية المشتركة', value: money(params.amount_micros) });
      rows.push({ label: 'عدد الحملات', value: String(names(params.campaign_resources)) });
      break;
    case 'attach_shared_budget':
      rows.push({ label: 'الميزانية المشتركة', value: String(params.budget_resource ?? ''), ltr: true });
      rows.push({ label: 'عدد الحملات', value: String(names(params.campaign_resources)) });
      break;
    case 'detach_shared_budget':
      rows.push({ label: 'الحملة', value: String(params.campaign_resource ?? targetId ?? ''), ltr: true });
      rows.push({ label: 'ميزانيتها اليومية الخاصة', value: money(params.amount_micros) });
      break;
    case 'create_portfolio_strategy':
      rows.push({ label: 'اسم الاستراتيجية', value: String(params.name ?? '') });
      rows.push({ label: 'النوع', value: STRATEGY_AR[params.strategy_type] ?? String(params.strategy_type ?? '') });
      if (params.target_cpa_micros) rows.push({ label: 'التكلفة المستهدفة', value: money(params.target_cpa_micros) });
      if (params.target_roas) rows.push({ label: 'العائد المستهدف', value: String(params.target_roas) });
      rows.push({ label: 'عدد الحملات', value: String(names(params.campaign_resources)) });
      break;
    case 'attach_portfolio_strategy':
      rows.push({ label: 'الاستراتيجية', value: String(params.strategy_resource ?? ''), ltr: true });
      rows.push({ label: 'عدد الحملات', value: String(names(params.campaign_resources)) });
      break;
    case 'detach_portfolio_strategy':
      rows.push({ label: 'الحملة', value: String(params.campaign_resource ?? targetId ?? ''), ltr: true });
      rows.push({ label: 'تنتقل إلى', value: STRATEGY_AR[params.to] ?? String(params.to ?? '') });
      break;
    case 'subdivide_shopping_listing_group':
    case 'subdivide_pmax_listing_group':
      rows.push({
        label: operation === 'subdivide_pmax_listing_group' ? 'مجموعة الأصول' : 'المجموعة الإعلانية',
        value: String(params.asset_group_resource ?? params.ad_group_resource ?? targetId ?? ''),
        ltr: true,
      });
      rows.push({ label: 'التقسيم حسب', value: DIMENSION_AR[params.dimension] ?? String(params.dimension ?? '') });
      for (const v of (params.values ?? []).slice(0, 10)) rows.push({ label: 'قيمة', value: String(v) });
      rows.push({
        label: 'باقي المنتجات',
        value: params.others === 'exclude' ? 'تُستبعد' : 'تبقى مضمّنة بنفس الإعداد',
      });
      break;
  }
  return rows;
}
