/**
 * Arabic names for executable operations, shown wherever a user approves or
 * reviews a change. One map so the approval card, the action log and the
 * chat-first preview cannot name the same operation differently.
 * House rule: no em dash or en dash in any Arabic string.
 */
export const OPERATION_LABELS_AR: Record<string, string> = {
  adjust_budget: 'تعديل ميزانية حملة',
  adjust_bid: 'تعديل هدف المزايدة لمجموعة إعلانية',
  pause_keyword: 'إيقاف كلمة مفتاحية',
  pause_ad: 'إيقاف إعلان',
  add_negative_keyword: 'إضافة كلمة سلبية',
  add_keyword: 'إضافة كلمة رابحة من عبارات البحث',
  pause_campaign: 'إيقاف حملة',
  enable_campaign: 'تشغيل حملة',
  add_negative_keywords_batch: 'منع عبارات بحث (دفعة)',
};

export function operationLabelAr(operation: string | null | undefined): string | null {
  if (!operation) return null;
  return OPERATION_LABELS_AR[operation] ?? null;
}
