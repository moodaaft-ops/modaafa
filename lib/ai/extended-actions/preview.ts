import { DAYS_OF_WEEK } from './types';
import { modifierToPct } from './validate';
import { adsStudioPreviewRows } from '../../ads/studio/preview';
import { isAdsStudioOperation } from '../../ads/studio/types';
import { isValueRuleOperation } from '../../value-rules/types';
import { valueRulePreviewRows } from '../../value-rules/preview';
import { isStructureOperation } from '../../structure/types';
import { structurePreviewRows } from '../../structure/preview';

/**
 * Approval-card rows for the extended operations. Pure, so the optimizer page
 * and the Jarvis card can share them. Arabic is Saudi colloquial, no dashes.
 */

export type PreviewRow = { label: string; value: string; ltr?: boolean };

const DAY_AR: Record<string, string> = {
  MONDAY: 'الاثنين',
  TUESDAY: 'الثلاثاء',
  WEDNESDAY: 'الأربعاء',
  THURSDAY: 'الخميس',
  FRIDAY: 'الجمعة',
  SATURDAY: 'السبت',
  SUNDAY: 'الأحد',
};
const DEVICE_AR: Record<string, string> = { MOBILE: 'الجوال', DESKTOP: 'الكمبيوتر', TABLET: 'التابلت' };

function pctText(modifier: unknown): string {
  const m = Number(modifier);
  if (!Number.isFinite(m)) return '';
  if (m === 0) return 'استبعاد كامل';
  const pct = modifierToPct(m);
  if (pct === 0) return 'بدون تغيير';
  return pct > 0 ? `زيادة ${pct}%` : `خفض ${Math.abs(pct)}%`;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function extendedPreviewRows(operation: string, params: Record<string, any>, targetId?: string): PreviewRow[] {
  if (isValueRuleOperation(operation)) return valueRulePreviewRows(operation, params, targetId);
  if (isAdsStudioOperation(operation)) {
    const target = (params.campaign_resource ?? targetId) as string | undefined;
    const head: PreviewRow[] =
      operation !== 'replace_rsa_assets' && target ? [{ label: 'الحملة', value: String(target), ltr: true }] : [];
    return [...head, ...adsStudioPreviewRows(operation, params, targetId)];
  }
  if (isStructureOperation(operation)) return structurePreviewRows(operation, params, targetId);
  const rows: PreviewRow[] = [];
  const campaign = params.campaign_resource ?? targetId;
  if (campaign && !String(operation).includes('shared') && !String(operation).includes('recommendation') && operation !== 'pause_auto_apply') {
    rows.push({ label: 'الحملة', value: String(campaign), ltr: true });
  }

  switch (operation) {
    case 'set_ad_schedule': {
      const slots: any[] = Array.isArray(params.slots) ? params.slots : [];
      for (const slot of slots.slice(0, 8)) {
        const minute = (name: string) => ({ ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 } as Record<string, number>)[String(slot[name])] ?? Number(slot[name] ?? 0);
        const day = DAY_AR[String(slot.day_of_week)] ?? String(slot.day_of_week);
        rows.push({
          label: day,
          value: `${pad(slot.start_hour)}:${pad(minute('start_minute'))} إلى ${pad(slot.end_hour)}:${pad(minute('end_minute'))} (${pctText(slot.bid_modifier)})`,
        });
      }
      rows.push({
        label: 'بقية الساعات',
        value: params.restrict_to_slots === true ? 'تتوقف الإعلانات خارج هذي الفترات' : 'تبقى شغالة كما هي',
      });
      break;
    }
    case 'set_device_bid_modifier':
      rows.push({ label: 'الجهاز', value: DEVICE_AR[String(params.device)] ?? String(params.device) });
      rows.push({ label: 'التعديل', value: pctText(params.bid_modifier) });
      break;
    case 'exclude_location':
      rows.push({ label: 'الموقع المستبعد', value: String(params.geo_target_constant), ltr: true });
      break;
    case 'set_location_bid_modifier':
      rows.push({ label: 'الموقع', value: String(params.geo_target_constant), ltr: true });
      rows.push({ label: 'التعديل', value: pctText(params.bid_modifier) });
      break;
    case 'set_geo_target_type':
      rows.push({
        label: 'نوع الاستهداف',
        value: params.positive_geo_target_type === 'PRESENCE' ? 'المتواجدين في المنطقة فقط' : 'المتواجدين والمهتمين بالمنطقة',
      });
      break;
    case 'set_network_settings':
      if (params.target_search_network === false) rows.push({ label: 'شركاء البحث', value: 'إيقاف' });
      if (params.target_content_network === false) rows.push({ label: 'شبكة العرض', value: 'إيقاف' });
      break;
    case 'create_shared_negative_list': {
      const keywords: any[] = Array.isArray(params.keywords) ? params.keywords : [];
      rows.push({ label: 'اسم القائمة', value: String(params.name ?? '') });
      if (keywords.length) {
        rows.push({
          label: `الكلمات (${keywords.length})`,
          value: keywords.map((k) => (typeof k === 'string' ? k : String(k.text))).join('، '),
        });
      }
      const campaigns: unknown[] = Array.isArray(params.campaign_resources) ? params.campaign_resources : [];
      if (campaigns.length) rows.push({ label: 'الحملات المربوطة', value: String(campaigns.length) });
      rows.push({ label: 'حماية المبيعات', value: 'نستبعد أي كلمة تمنع بحثاً جاب تحويل أو كلمة مفعّلة' });
      break;
    }
    case 'add_shared_negative_keywords': {
      const keywords: any[] = Array.isArray(params.keywords) ? params.keywords : [];
      rows.push({ label: 'القائمة', value: String(params.shared_set_resource ?? ''), ltr: true });
      rows.push({
        label: `الكلمات (${keywords.length})`,
        value: keywords.map((k) => (typeof k === 'string' ? k : String(k.text))).join('، '),
      });
      break;
    }
    case 'attach_shared_negative_list': {
      const campaigns: unknown[] = Array.isArray(params.campaign_resources) ? params.campaign_resources : [];
      rows.push({ label: 'القائمة', value: String(params.shared_set_resource ?? ''), ltr: true });
      rows.push({ label: 'عدد الحملات', value: String(campaigns.length) });
      break;
    }
    case 'apply_google_recommendation':
    case 'dismiss_google_recommendation':
      rows.push({ label: 'التوصية', value: String(params.recommendation_resource ?? ''), ltr: true });
      if (params.recommendation_type) rows.push({ label: 'النوع', value: String(params.recommendation_type), ltr: true });
      break;
    case 'pause_auto_apply': {
      const subs: unknown[] = Array.isArray(params.subscription_resources) ? params.subscription_resources : [];
      rows.push({ label: 'أنواع التطبيق التلقائي', value: String(subs.length) });
      break;
    }
  }
  return rows;
}

export { DAYS_OF_WEEK as EXTENDED_PREVIEW_DAYS };
