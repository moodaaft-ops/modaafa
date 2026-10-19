/**
 * Arabic names for executable operations, shown wherever a user approves or
 * reviews a change. One map so the approval card, the action log and the
 * chat-first preview cannot name the same operation differently.
 * House rule: no em dash or en dash in any Arabic string.
 */
/** Extended operations (EXTENDED_ACTIONS_ENABLED). Rows with these exist only when the flag is on. */
export const EXTENDED_OPERATION_LABELS_AR: Record<string, string> = {
  set_ad_schedule: 'تعديل جدول عرض الإعلانات',
  set_device_bid_modifier: 'تعديل مزايدة نوع الجهاز',
  exclude_location: 'استبعاد موقع من الاستهداف',
  set_location_bid_modifier: 'تعديل مزايدة موقع',
  set_geo_target_type: 'تغيير نوع الاستهداف الجغرافي',
  set_network_settings: 'إيقاف شركاء البحث وشبكة العرض',
  create_shared_negative_list: 'إنشاء قائمة كلمات سلبية مشتركة',
  add_shared_negative_keywords: 'إضافة كلمات إلى قائمة سلبية مشتركة',
  attach_shared_negative_list: 'ربط قائمة سلبية مشتركة بحملات',
  apply_google_recommendation: 'تطبيق توصية من قوقل',
  dismiss_google_recommendation: 'رفض توصية من قوقل',
  pause_auto_apply: 'إيقاف التطبيق التلقائي لتوصيات قوقل',
  replace_rsa_assets: 'تبديل نصوص الإعلان الضعيفة',
  add_sitelinks: 'إضافة روابط فرعية للحملة',
  add_callouts: 'إضافة نصوص مميزة للحملة',
  add_structured_snippet: 'إضافة مقتطف منظم للحملة',
  add_call_asset: 'إضافة رقم اتصال للحملة',
  set_ai_max: 'تغيير إعداد ذكاء ماكس للبحث',
  add_placement_exclusions: 'استبعاد مواقع ومحتوى من الإعلانات المصورة',
  create_shared_budget: 'إنشاء ميزانية مشتركة بين حملات',
  attach_shared_budget: 'ضم حملات إلى ميزانية مشتركة',
  detach_shared_budget: 'فصل حملة عن الميزانية المشتركة',
  create_portfolio_strategy: 'إنشاء استراتيجية مزايدة مشتركة',
  attach_portfolio_strategy: 'ضم حملات إلى استراتيجية مزايدة مشتركة',
  detach_portfolio_strategy: 'فصل حملة عن استراتيجية المزايدة المشتركة',
  subdivide_shopping_listing_group: 'تقسيم منتجات حملة التسوق',
  subdivide_pmax_listing_group: 'تقسيم منتجات الحملة الأقصى',
};

export const OPERATION_LABELS_AR: Record<string, string> = {
  adjust_budget: 'تعديل ميزانية حملة',
  adjust_bid: 'تعديل هدف المزايدة لمجموعة إعلانية',
  pause_keyword: 'إيقاف كلمة مفتاحية',
  pause_ad: 'إيقاف إعلان',
  add_negative_keyword: 'إضافة كلمة سلبية',
  add_keyword: 'إضافة كلمة رابحة من عبارات البحث',
  pause_campaign: 'إيقاف حملة',
  enable_campaign: 'تشغيل حملة',
  launch_campaign: 'بناء حملة موقوفة',
  add_negative_keywords_batch: 'منع عبارات بحث (دفعة)',
  ...EXTENDED_OPERATION_LABELS_AR,
  add_data_exclusion: 'استبعاد أيام التتبع المكسور من تعلم المزايدة',
  create_lead_conversion_action: 'إنشاء تحويل "زبون فعلي" لرفع الزبائن لقوقل',
  set_conversion_primary: 'اجعل الزبون الفعلي تحويلاً أساسياً',
};

export function operationLabelAr(operation: string | null | undefined): string | null {
  if (!operation) return null;
  return OPERATION_LABELS_AR[operation] ?? null;
}
