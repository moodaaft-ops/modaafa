/**
 * Small pure helpers the engine files share: reading a signal, Arabic text
 * matching, number words, hour words and place names. Nothing here reads a
 * clock, the network or the environment.
 *
 * This file imports nothing from lib/setup/questions.ts on purpose:
 * questions.ts imports answers.ts, which builds catalogs from focus.ts and this
 * file while it loads, so a way back into questions.ts would make the load
 * order matter. The one number format it needs is copied below and a test keeps
 * it equal to questions.ts's.
 */

import type {
  AccountSignals,
  BusinessKind,
  CampaignKind,
  CampaignSignal,
  ConversionGroup,
  DominantOutcome,
  Scenario,
  SignalRead,
} from './types';

export type Answered = Partial<Record<string, string | null>>;

// ---------------------------------------------------------------------------
// Signals and answers
// ---------------------------------------------------------------------------

export function sigValue<T>(read: SignalRead<T> | null | undefined): T | null {
  return read && read.ok ? read.value : null;
}

/** True when the key is on record, even with no choice id (budget, name). */
export function isAnswered(answered: Answered, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(answered, key) && answered[key] !== undefined;
}

export function answeredChoice(answered: Answered, key: string): string | null {
  const value = answered[key];
  return typeof value === 'string' && value ? value : null;
}

/** Kinds the tree words its questions for. «general» always uses the legacy copy. */
export function isTrustedKind(scenario: Pick<Scenario, 'kind' | 'kindConfidence'>): boolean {
  return scenario.kind !== 'general' && (scenario.kindConfidence === 'stated' || scenario.kindConfidence === 'confident');
}

export function trustedKind(scenario: Pick<Scenario, 'kind' | 'kindConfidence'>): BusinessKind {
  return isTrustedKind(scenario) ? scenario.kind : 'general';
}

export function hasEvidence(scenario: Pick<Scenario, 'evidence'>, code: string): boolean {
  return scenario.evidence.includes(code);
}

export type CampaignTotals = {
  cost: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
};

export function campaignTotals(campaigns: CampaignSignal[]): CampaignTotals {
  const totals: CampaignTotals = { cost: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 };
  for (const campaign of campaigns) {
    totals.cost += campaign.cost30;
    totals.impressions += campaign.impressions30;
    totals.clicks += campaign.clicks30;
    totals.conversions += campaign.conversions30;
    totals.value += campaign.value30;
  }
  return totals;
}

/** Conversion groups that say what the ads bring. Sign-ups, page views and «other» never decide an outcome. */
const MEANINGFUL_GROUPS: ConversionGroup[] = ['purchase', 'call', 'lead_form', 'contact', 'booking', 'directions', 'store_visit'];

export function groupConversions(signals: AccountSignals | null, group: ConversionGroup): number {
  const groups = sigValue(signals?.conversionsByGroup);
  if (!groups) return 0;
  return groups.filter((row) => row.group === group).reduce((sum, row) => sum + row.conversions, 0);
}

/** The meaningful group with the most conversions (at least one), or null. */
export function dominantGroup(signals: AccountSignals | null): ConversionGroup | null {
  const groups = sigValue(signals?.conversionsByGroup);
  if (!groups) return null;
  const sums = new Map<ConversionGroup, number>();
  for (const row of groups) sums.set(row.group, (sums.get(row.group) ?? 0) + row.conversions);
  let best: ConversionGroup | null = null;
  let bestValue = 0;
  for (const group of MEANINGFUL_GROUPS) {
    const value = sums.get(group) ?? 0;
    if (value >= 1 && value > bestValue) {
      best = group;
      bestValue = value;
    }
  }
  return best;
}

export function outcomeOfGroup(group: ConversionGroup | null): DominantOutcome {
  switch (group) {
    case 'purchase':
      return 'purchases';
    case 'call':
      return 'calls';
    case 'lead_form':
    case 'contact':
      return 'forms';
    case 'booking':
      return 'bookings';
    case 'directions':
    case 'store_visit':
      return 'visits';
    default:
      return 'unknown';
  }
}

/**
 * The average order the account itself reports: conversion value over
 * conversions, last 30 days, in the account's currency. Null unless both are
 * real. The customer is asked to confirm it, never told it as a fact.
 */
export function averageOrder(signals: AccountSignals | null): number | null {
  const campaigns = sigValue(signals?.campaigns);
  if (!campaigns) return null;
  const totals = campaignTotals(campaigns);
  if (totals.conversions < 1 || totals.value <= 0) return null;
  const average = Math.round(totals.value / totals.conversions);
  return average > 0 ? average : null;
}

// ---------------------------------------------------------------------------
// Kinds and the stored «type» ids
// ---------------------------------------------------------------------------

/** What each TYPE_OPTIONS id means to the tree. */
export const STATED_KIND: Record<string, BusinessKind> = {
  ecommerce: 'ecommerce',
  clinic: 'clinic',
  services: 'services',
  real_estate: 'services',
  restaurant: 'local',
  local_store: 'local',
  education: 'general',
  other: 'general',
};

/** The TYPE_OPTIONS id whose label is written to `sector` for a confirmed kind. */
export const KIND_TYPE_ID: Record<BusinessKind, string | null> = {
  ecommerce: 'ecommerce',
  clinic: 'clinic',
  services: 'services',
  local: 'local_store',
  general: null,
};

export const PLATFORM_NAME = { salla: 'سلة', zid: 'زد', shopify: 'شوبيفاي' } as const;

// ---------------------------------------------------------------------------
// Arabic text
// ---------------------------------------------------------------------------

/** Lower case, no diacritics or tatweel, alef and ya and ta marbuta folded, so «الأسنان» finds «اسنان». */
export function normalizeArabic(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «تقويم» becomes «التقويم» when it is one plain word; phrases like «نقل عفش» and words that already have it stay as they are. */
export function withArticle(label: string): string {
  const word = label.trim();
  return /^[؀-ۿ]+$/.test(word) && !word.startsWith('ال') ? `ال${word}` : word;
}

export function containsAny(text: string, words: readonly string[]): boolean {
  const haystack = normalizeArabic(text);
  return words.some((word) => haystack.includes(normalizeArabic(word)));
}

export function countMatches(texts: readonly string[], words: readonly string[]): number {
  return texts.filter((text) => containsAny(text, words)).length;
}

export const CLINIC_WORDS = [
  'أسنان',
  'تقويم',
  'زراعة',
  'عيادة',
  'عيادات',
  'مجمع طبي',
  'جلدية',
  'ليزر',
  'علاج طبيعي',
  'عيون',
  'dental',
  'clinic',
  'derma',
] as const;

export const DENTAL_WORDS = ['أسنان', 'تقويم', 'زراعة', 'dental', 'dentist'] as const;
export const DERMA_WORDS = ['جلدية', 'ليزر', 'derma'] as const;

export const SERVICES_WORDS = [
  'مقاولات',
  'ترميم',
  'صيانة',
  'تنظيف',
  'نقل عفش',
  'مكافحة حشرات',
  'مظلات',
  'عزل',
  'سباكة',
  'تكييف',
  'ديكور',
] as const;

export const LOCAL_WORDS = ['مطعم', 'مطاعم', 'كافيه', 'قهوة', 'فرع', 'فروع', 'مشويات', 'حلويات', 'restaurant', 'cafe'] as const;

/** Hosts of store platforms and what they mean. */
export const PLATFORM_HOSTS: Array<{ host: string; platform: 'salla' | 'zid' | 'shopify' }> = [
  { host: 'salla.sa', platform: 'salla' },
  { host: 'salla.store', platform: 'salla' },
  { host: 'zid.store', platform: 'zid' },
  { host: 'myshopify.com', platform: 'shopify' },
];

// ---------------------------------------------------------------------------
// Numbers and money
// ---------------------------------------------------------------------------

/** The app's number format (same as formatAmount in lib/setup/questions.ts): whole units, 3,200. */
function formatAmount(amount: number): string {
  return Math.round(amount).toLocaleString('en-US');
}

export function currencyWord(code: string | null | undefined): string {
  const upper = String(code ?? 'SAR').trim().toUpperCase();
  return !upper || upper === 'SAR' ? 'ريال' : upper;
}

/** «3,200 ريال». Whole units, the app's number format. */
export function money(amount: number, currency: string | null | undefined): string {
  return `${formatAmount(amount)} ${currencyWord(currency)}`;
}

export type CountForms = { one: string; two: string; few: string; many: string };

/**
 * A number with its noun the way it is said: one «اتصال واحد», two «اتصالين»,
 * three to ten «5 اتصالات», eleven and up «64 اتصال».
 */
export function countPhrase(value: number, forms: CountForms): string {
  const n = Math.max(0, Math.round(value));
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${formatAmount(n)} ${forms.few}`;
  return `${formatAmount(n)} ${forms.many}`;
}

export const NOUNS = {
  order: { one: 'طلب واحد', two: 'طلبين', few: 'طلبات', many: 'طلب' },
  call: { one: 'اتصال واحد', two: 'اتصالين', few: 'اتصالات', many: 'اتصال' },
  form: { one: 'نموذج واحد', two: 'نموذجين', few: 'نماذج', many: 'نموذج' },
  booking: { one: 'حجز واحد', two: 'حجزين', few: 'حجوزات', many: 'حجز' },
  visit: { one: 'زيارة وحدة', two: 'زيارتين', few: 'زيارات', many: 'زيارة' },
  message: { one: 'رسالة وحدة', two: 'رسالتين', few: 'رسائل', many: 'رسالة' },
  signup: { one: 'تسجيل واحد', two: 'تسجيلين', few: 'تسجيلات', many: 'تسجيل' },
  directions: { one: 'ضغطة اتجاهات وحدة', two: 'ضغطتين اتجاهات', few: 'ضغطات اتجاهات', many: 'ضغطة اتجاهات' },
  click: { one: 'نقرة وحدة', two: 'نقرتين', few: 'نقرات', many: 'نقرة' },
  product: { one: 'منتج واحد', two: 'منتجين', few: 'منتجات', many: 'منتج' },
  location: { one: 'موقع واحد', two: 'موقعين', few: 'مواقع', many: 'موقع' },
} satisfies Record<string, CountForms>;

export const GROUP_NOUN: Partial<Record<ConversionGroup, CountForms>> = {
  purchase: NOUNS.order,
  call: NOUNS.call,
  lead_form: NOUNS.form,
  booking: NOUNS.booking,
  directions: NOUNS.directions,
  store_visit: NOUNS.visit,
  contact: NOUNS.message,
  signup: NOUNS.signup,
};

/** «جدة والرياض»: items joined with «،» and a «و» on the last one. */
export function joinAnd(items: readonly string[]): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join('، ')} و${list[list.length - 1]}`;
}

const HOUR_SUFFIX = (h: number): string => {
  if (h >= 1 && h <= 3) return 'الليل';
  if (h >= 4 && h <= 5) return 'الفجر';
  if (h >= 6 && h <= 11) return 'الصبح';
  if (h >= 12 && h <= 14) return 'الظهر';
  if (h >= 15 && h <= 17) return 'العصر';
  if (h >= 18 && h <= 20) return 'المسا';
  return 'الليل';
};

/** 22 → «10 الليل», 9 → «9 الصبح», 0 or 24 → «12 الليل». */
export function hourPhrase(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  if (h === 0) return '12 الليل';
  const twelve = h > 12 ? h - 12 : h;
  return `${twelve} ${HOUR_SUFFIX(h)}`;
}

// ---------------------------------------------------------------------------
// Places and campaigns
// ---------------------------------------------------------------------------

const PLACES_AR: Record<string, string> = {
  jeddah: 'جدة',
  jidda: 'جدة',
  riyadh: 'الرياض',
  makkah: 'مكة',
  mecca: 'مكة',
  'makkah al mukarramah': 'مكة',
  medina: 'المدينة',
  madinah: 'المدينة',
  'al madinah al munawwarah': 'المدينة',
  dammam: 'الدمام',
  'ad dammam': 'الدمام',
  khobar: 'الخبر',
  'al khobar': 'الخبر',
  dhahran: 'الظهران',
  hofuf: 'الأحساء',
  'al hofuf': 'الأحساء',
  'al ahsa': 'الأحساء',
  'al-ahsa': 'الأحساء',
  buraydah: 'بريدة',
  qassim: 'القصيم',
  'al qassim': 'القصيم',
  taif: 'الطائف',
  'at taif': 'الطائف',
  abha: 'أبها',
  'khamis mushait': 'خميس مشيط',
  tabuk: 'تبوك',
  hail: 'حائل',
  "ha'il": 'حائل',
  jazan: 'جازان',
  jizan: 'جازان',
  najran: 'نجران',
  yanbu: 'ينبع',
  'al jubail': 'الجبيل',
  jubail: 'الجبيل',
  'saudi arabia': 'السعودية',
  kuwait: 'الكويت',
  'united arab emirates': 'الإمارات',
  bahrain: 'البحرين',
  qatar: 'قطر',
  oman: 'عمان',
};

/** A place as Google names it, in Arabic when we know it. Unknown names stay as they came. */
export function placeName(name: string): string {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  if (/[؀-ۿ]/.test(raw)) return raw;
  return PLACES_AR[raw.toLowerCase()] ?? raw;
}

/** City names to say aloud: country-wide targets are left out, the rest are deduplicated. */
export function cityNames(signals: AccountSignals | null): string[] {
  const places = sigValue(signals?.targetedPlaces);
  if (!places) return [];
  const out: string[] = [];
  for (const place of places) {
    const name = placeName(place);
    if (!name || name === 'السعودية' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** «في جدة» or «في جدة والرياض»; null for none or for more than two (too many to say). */
export function inCityPhrase(signals: AccountSignals | null): string | null {
  const cities = cityNames(signals);
  if (cities.length === 0 || cities.length > 2) return null;
  return `في ${joinAnd(cities)}`;
}

export const CAMPAIGN_KIND_NAME: Record<CampaignKind, string> = {
  PMAX: 'أداء أقصى',
  SHOPPING: 'تسوق',
  SEARCH: 'بحث',
  LOCAL: 'محلية',
  DEMAND_GEN: 'Demand Gen',
  VIDEO: 'فيديو',
  DISPLAY: 'عرض',
  APP: 'تطبيقات',
  OTHER: 'من نوع ثاني',
};

export const CAMPAIGN_KIND_ORDER: CampaignKind[] = ['PMAX', 'SHOPPING', 'SEARCH', 'LOCAL', 'DEMAND_GEN', 'VIDEO', 'DISPLAY', 'APP', 'OTHER'];

const CAMPAIGN_FORMS: CountForms = { one: 'حملة', two: 'حملتين', few: 'حملات', many: 'حملة' };

/** «حملتين بحث», «حملة أداء أقصى وحملة بحث». Kinds with the most campaigns first, then the fixed order. */
export function campaignsPhrase(campaigns: CampaignSignal[]): string {
  const counts = new Map<CampaignKind, number>();
  for (const campaign of campaigns) counts.set(campaign.kind, (counts.get(campaign.kind) ?? 0) + 1);
  const kinds = [...counts.keys()].sort((a, b) => {
    const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return diff !== 0 ? diff : CAMPAIGN_KIND_ORDER.indexOf(a) - CAMPAIGN_KIND_ORDER.indexOf(b);
  });
  const parts = kinds.slice(0, 3).map((kind) => {
    const n = counts.get(kind) ?? 0;
    return `${countPhrase(n, CAMPAIGN_FORMS)} ${CAMPAIGN_KIND_NAME[kind]}`;
  });
  const extra = kinds.length > 3 ? ' وغيرها' : '';
  return `${joinAnd(parts)}${extra}`;
}
