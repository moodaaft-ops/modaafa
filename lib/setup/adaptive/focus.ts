/**
 * The «focus_service» catalogs: what the customer can pick as the thing they
 * want more of, per kind of business (and per specialty for clinics). Pure
 * data plus matching against campaign names, so the options a customer sees
 * first are the ones their own campaigns already talk about.
 *
 * Every id here is also accepted by parseAdaptiveAnswer (answers.ts builds its
 * catalog from ALL_FOCUS_ENTRIES), so ids must stay unique across groups.
 */

import { containsAny, trustedKind } from './shared';
import type { Scenario } from './types';

export type FocusGroup = 'dental' | 'derma' | 'clinic' | 'services' | 'ecommerce' | 'local' | 'general';

export type FocusEntry = {
  id: string;
  label: string;
  /** Words (Arabic or English) that mark a campaign name as being about this entry. */
  match: readonly string[];
  /** Search phrases to start a first campaign from. */
  seeds: readonly string[];
};

/** «كلها بنفس القدر». Valid for every group. */
export const FOCUS_ALL_ID = 'all';
export const FOCUS_ALL_LABEL = 'كلها بنفس القدر';
/** Free text goes through this id with the text in `text`. */
export const FOCUS_OTHER_ID = 'other';
export const FOCUS_TEXT_MIN = 2;
export const FOCUS_TEXT_MAX = 40;

export const FOCUS_ENTRIES: Record<'dental' | 'derma' | 'services' | 'ecommerce' | 'local', FocusEntry[]> = {
  dental: [
    { id: 'dental_braces', label: 'تقويم', match: ['تقويم', 'braces', 'ortho'], seeds: ['تقويم أسنان', 'عيادة تقويم أسنان'] },
    { id: 'dental_implants', label: 'زراعة', match: ['زراعة', 'implant'], seeds: ['زراعة أسنان', 'تركيب زراعة أسنان'] },
    { id: 'dental_whitening', label: 'تبييض', match: ['تبييض', 'whitening'], seeds: ['تبييض أسنان', 'تبييض الأسنان بالليزر'] },
    {
      id: 'dental_cosmetic',
      label: 'تجميل أسنان',
      match: ['تجميل', 'ابتسامة', 'veneer', 'لمينت'],
      seeds: ['تجميل أسنان', 'ابتسامة هوليود'],
    },
    {
      id: 'dental_fillings',
      label: 'علاج وحشوات',
      match: ['حشو', 'عصب', 'filling', 'root canal'],
      seeds: ['حشوات أسنان', 'علاج عصب'],
    },
  ],
  derma: [
    { id: 'derma_laser', label: 'ليزر', match: ['ليزر', 'laser'], seeds: ['ليزر إزالة الشعر', 'عيادة ليزر'] },
    { id: 'derma_skin', label: 'البشرة', match: ['بشرة', 'حبوب', 'facial', 'acne'], seeds: ['علاج حب الشباب', 'تنظيف بشرة'] },
    { id: 'derma_inject', label: 'بوتوكس وفيلر', match: ['بوتوكس', 'فيلر', 'botox', 'filler'], seeds: ['بوتوكس', 'فيلر'] },
    { id: 'derma_hair', label: 'علاج الشعر', match: ['تساقط', 'علاج الشعر', 'hair loss'], seeds: ['علاج تساقط الشعر', 'عيادة جلدية'] },
  ],
  services: [
    { id: 'svc_contracting', label: 'مقاولات', match: ['مقاولات', 'مقاول', 'بناء'], seeds: ['شركة مقاولات', 'مقاول بناء'] },
    { id: 'svc_renovation', label: 'ترميم', match: ['ترميم', 'تجديد'], seeds: ['شركة ترميم', 'ترميم منازل'] },
    { id: 'svc_maintenance', label: 'صيانة', match: ['صيانة'], seeds: ['شركة صيانة', 'صيانة منازل'] },
    { id: 'svc_cleaning', label: 'تنظيف', match: ['تنظيف'], seeds: ['شركة تنظيف', 'تنظيف منازل'] },
    { id: 'svc_moving', label: 'نقل عفش', match: ['نقل عفش', 'نقل اثاث'], seeds: ['نقل عفش', 'شركة نقل عفش'] },
    { id: 'svc_pest', label: 'مكافحة حشرات', match: ['مكافحة حشرات', 'حشرات'], seeds: ['مكافحة حشرات', 'شركة مكافحة حشرات'] },
    { id: 'svc_shades', label: 'مظلات', match: ['مظلات', 'مظلة', 'سواتر'], seeds: ['تركيب مظلات', 'مظلات سيارات'] },
    { id: 'svc_insulation', label: 'عزل', match: ['عزل'], seeds: ['عزل أسطح', 'شركة عزل'] },
    { id: 'svc_plumbing', label: 'سباكة', match: ['سباكة', 'سباك'], seeds: ['شركة سباكة', 'سباك'] },
    { id: 'svc_ac', label: 'تكييف', match: ['تكييف', 'مكيف'], seeds: ['صيانة مكيفات', 'تركيب تكييف'] },
    { id: 'svc_decor', label: 'ديكور', match: ['ديكور', 'تصميم داخلي'], seeds: ['شركة ديكور', 'تصميم ديكور'] },
  ],
  ecommerce: [
    { id: 'shop_perfume', label: 'عطور', match: ['عطر', 'عطور', 'perfume', 'عود', 'بخور'], seeds: ['عطور', 'عطور رجالية'] },
    { id: 'shop_fashion', label: 'ملابس وأزياء', match: ['ملابس', 'عبايات', 'عباية', 'فساتين', 'fashion', 'ازياء'], seeds: ['عبايات', 'ملابس نسائية'] },
    { id: 'shop_beauty', label: 'تجميل وعناية', match: ['مكياج', 'عناية', 'beauty', 'كريم'], seeds: ['مستحضرات تجميل', 'منتجات عناية'] },
    { id: 'shop_electronics', label: 'إلكترونيات وجوالات', match: ['جوال', 'الكترونيات', 'electronics', 'phone'], seeds: ['إلكترونيات', 'اكسسوارات جوال'] },
    { id: 'shop_home', label: 'أثاث ومنزل', match: ['اثاث', 'منزل', 'furniture', 'home'], seeds: ['أثاث منزلي', 'ديكور منزل'] },
    { id: 'shop_food', label: 'أغذية وهدايا', match: ['تمور', 'قهوة', 'هدايا', 'gift'], seeds: ['هدايا', 'تمور فاخرة'] },
  ],
  local: [
    { id: 'local_restaurant', label: 'مطعم', match: ['مطعم', 'مطاعم', 'restaurant'], seeds: ['مطعم', 'مطعم قريب مني'] },
    { id: 'local_cafe', label: 'كافيه وقهوة', match: ['كافيه', 'قهوة', 'cafe', 'coffee'], seeds: ['كافيه', 'قهوة مختصة'] },
    { id: 'local_sweets', label: 'حلويات ومخبوزات', match: ['حلويات', 'مخبوزات', 'كيك'], seeds: ['حلويات', 'كيك'] },
    { id: 'local_grill', label: 'مشويات', match: ['مشويات', 'شواء', 'مندي', 'كبسة'], seeds: ['مشويات', 'مطعم مشويات'] },
    { id: 'local_retail', label: 'محل تجزئة', match: ['محل', 'متجر', 'سوق'], seeds: ['محل قريب مني'] },
  ],
};

export const ALL_FOCUS_ENTRIES: FocusEntry[] = Object.values(FOCUS_ENTRIES).flat();

export function focusEntryById(id: string): FocusEntry | null {
  return ALL_FOCUS_ENTRIES.find((entry) => entry.id === id) ?? null;
}

export function focusLabel(id: string): string | null {
  if (id === FOCUS_ALL_ID) return FOCUS_ALL_LABEL;
  return focusEntryById(id)?.label ?? null;
}

/** Which catalog a scenario's customer sees. Only a kind the customer stated or confirmed gets its own. */
export function focusGroupFor(scenario: Scenario): FocusGroup {
  switch (trustedKind(scenario)) {
    case 'ecommerce':
      return 'ecommerce';
    case 'clinic':
      return scenario.specialty === 'dental' ? 'dental' : scenario.specialty === 'derma' ? 'derma' : 'clinic';
    case 'services':
      return 'services';
    case 'local':
      return 'local';
    default:
      return 'general';
  }
}

export function focusEntriesForGroup(group: FocusGroup): FocusEntry[] {
  return group === 'clinic' || group === 'general' ? [] : FOCUS_ENTRIES[group];
}

/** Entries whose words appear in the campaign names, in the order the campaigns come, without repeats. */
export function matchFocusEntries(group: FocusGroup, campaignNames: readonly string[]): FocusEntry[] {
  const entries = focusEntriesForGroup(group);
  const found: FocusEntry[] = [];
  for (const name of campaignNames) {
    for (const entry of entries) {
      if (!found.includes(entry) && containsAny(name, entry.match)) found.push(entry);
    }
  }
  return found;
}
