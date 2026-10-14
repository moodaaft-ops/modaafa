import { formatNumberAr } from '@/lib/utils';
import type { AccountSignals, CampaignKind, ConversionGroup, Scenario, SignalKey } from '@/lib/setup/adaptive/types';

/**
 * Plain Arabic for the operator page: one short line per signal and one list
 * for the scenario. Every number comes from the account; nothing is guessed.
 */

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  campaigns: 'الحملات',
  enabledConversionActions: 'إجراءات التحويل المفعّلة',
  conversionsByGroup: 'التحويلات حسب النوع',
  autoTagging: 'الوسم التلقائي',
  landingHosts: 'مواقع الهبوط',
  merchantCenterLinked: 'ربط ميرشنت سنتر',
  assets: 'أصل الاتصال والمواقع',
  targetedPlaces: 'المناطق المستهدفة',
  externalManager: 'مدير خارجي',
  otherEditors14d: 'معدّلون غيرك (14 يوم)',
  hours: 'الصرف حسب الساعة',
  products: 'المنتجات',
};

const KIND_LABELS: Record<CampaignKind, string> = {
  SEARCH: 'بحث',
  PMAX: 'أداء أقصى',
  SHOPPING: 'تسوق',
  DISPLAY: 'شبكة عرض',
  VIDEO: 'فيديو',
  LOCAL: 'محلية',
  DEMAND_GEN: 'ديماند جين',
  APP: 'تطبيق',
  OTHER: 'أخرى',
};

const GROUP_LABELS: Record<ConversionGroup, string> = {
  purchase: 'مشتريات',
  lead_form: 'نماذج',
  call: 'اتصالات',
  booking: 'حجوزات',
  directions: 'اتجاهات',
  store_visit: 'زيارات فرع',
  contact: 'تواصل',
  signup: 'تسجيل',
  page_view: 'مشاهدة صفحة',
  other: 'أخرى',
};

const STATE_LABELS: Record<Scenario['state'], string> = {
  no_account: 'ما عنده حساب',
  new: 'حساب جديد',
  dormant: 'حساب واقف',
  no_tracking: 'يصرف وبدون تتبع',
  tracking_suspect: 'يصرف والتتبع مشكوك فيه',
  active: 'شغّال',
};

const KIND_NAMES: Record<Scenario['kind'], string> = {
  ecommerce: 'متجر',
  clinic: 'عيادة',
  services: 'خدمات',
  local: 'محل أو مطعم',
  general: 'عام',
};

const CONFIDENCE_LABELS: Record<Scenario['kindConfidence'], string> = {
  stated: 'قالها العميل',
  confident: 'واثق',
  guess: 'تخمين',
  none: 'ما عرفت',
};

const OUTCOME_LABELS: Record<Scenario['outcome'], string> = {
  purchases: 'مبيعات',
  calls: 'اتصالات',
  forms: 'نماذج',
  bookings: 'حجوزات',
  visits: 'زيارات',
  unknown: 'ما عرفت',
};

const MANAGED_LABELS: Record<Scenario['managed'], string> = {
  confirmed: 'مؤكد',
  suspected: 'مشكوك فيه',
  none: 'لا',
};

const PLATFORM_LABELS = { salla: 'سلة', zid: 'زد', shopify: 'شوبيفاي' } as const;
const SPECIALTY_LABELS = { dental: 'أسنان', derma: 'جلدية', general: 'عام' } as const;

const n = (value: number) => formatNumberAr(value);

/** Arabic count words: one and two are words, 3 to 10 take the plural, 11 and up the singular. */
function counted(value: number, forms: { one: string; two: string; few: string; many: string }) {
  const abs = Math.abs(Math.round(value));
  if (abs === 1) return forms.one;
  if (abs === 2) return forms.two;
  return `${n(abs)} ${abs >= 3 && abs <= 10 ? forms.few : forms.many}`;
}

function currencyWord(code: string) {
  return code === 'SAR' ? 'ريال' : code;
}

const join = (parts: string[]) => parts.join('، ');

/** The value of one signal in a line. Empty when the signal failed (the page shows its error code instead). */
export function describeSignal(key: SignalKey, signals: AccountSignals): string {
  const cur = currencyWord(signals.currency);
  switch (key) {
    case 'campaigns': {
      const read = signals.campaigns;
      if (!read.ok) return '';
      const list = read.value;
      if (list.length === 0) return 'ما فيه حملات';
      const enabled = list.filter((c) => c.status === 'ENABLED').length;
      const paused = list.filter((c) => c.status === 'PAUSED').length;
      const cost = list.reduce((sum, c) => sum + c.cost30, 0);
      const clicks = list.reduce((sum, c) => sum + c.clicks30, 0);
      const conversions = list.reduce((sum, c) => sum + c.conversions30, 0);
      const kinds = new Map<CampaignKind, number>();
      for (const c of list) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
      const kindText = Array.from(kinds.entries())
        .map(([kind, count]) => `${KIND_LABELS[kind]} ${n(count)}`)
        .join('، ');
      return join([
        `${counted(list.length, { one: 'حملة', two: 'حملتين', few: 'حملات', many: 'حملة' })} (مفعّلة ${n(enabled)} وموقوفة ${n(paused)})`,
        `الصرف ${n(cost)} ${cur}`,
        `نقرات ${n(clicks)}`,
        `تحويلات ${n(Math.round(conversions * 100) / 100)}`,
        kindText,
      ]);
    }
    case 'enabledConversionActions': {
      const read = signals.enabledConversionActions;
      if (!read.ok) return '';
      return read.value === 0 ? 'ولا إجراء مفعّل' : `${n(read.value)} مفعّل`;
    }
    case 'conversionsByGroup': {
      const read = signals.conversionsByGroup;
      if (!read.ok) return '';
      if (read.value.length === 0) return 'ما فيه تحويلات في آخر 30 يوم';
      return join(read.value.map((row) => `${GROUP_LABELS[row.group]} ${n(row.conversions)}`));
    }
    case 'autoTagging': {
      const read = signals.autoTagging;
      return !read.ok ? '' : read.value ? 'شغّال' : 'مطفي';
    }
    case 'landingHosts': {
      const read = signals.landingHosts;
      if (!read.ok) return '';
      return read.value.length === 0 ? 'ما لقيت روابط' : join(read.value);
    }
    case 'merchantCenterLinked': {
      const read = signals.merchantCenterLinked;
      return !read.ok ? '' : read.value ? 'مربوط' : 'مو مربوط';
    }
    case 'assets': {
      const read = signals.assets;
      if (!read.ok) return '';
      return join([read.value.call ? 'أصل الاتصال موجود' : 'ما فيه أصل اتصال', `المواقع ${n(read.value.locations)}`]);
    }
    case 'targetedPlaces': {
      const read = signals.targetedPlaces;
      if (!read.ok) return '';
      return read.value.length === 0 ? 'ما فيه استهداف مواقع محدد' : join(read.value);
    }
    case 'externalManager': {
      const read = signals.externalManager;
      if (!read.ok) return '';
      return read.value.linked ? `مرتبط بمدير خارجي: ${read.value.managerIds.join('، ')}` : 'ما فيه مدير خارجي';
    }
    case 'otherEditors14d': {
      const read = signals.otherEditors14d;
      if (!read.ok) return '';
      if (read.value === 0) return 'ما عدّل أحد غيرك';
      return `${counted(read.value, { one: 'معدّل واحد', two: 'معدّلين', few: 'معدّلين', many: 'معدّل' })} غير حسابك`;
    }
    case 'hours': {
      const read = signals.hours;
      if (!read.ok) return '';
      const cost = read.value.reduce((sum, h) => sum + h.cost, 0);
      if (cost <= 0) return 'ما فيه صرف مسجل بالساعات';
      const calls = read.value.reduce((sum, h) => sum + h.phoneCalls, 0);
      const top = read.value.reduce((best, h) => (h.cost > best.cost ? h : best), read.value[0]);
      return join([
        `الصرف ${n(Math.round(cost * 100) / 100)} ${cur}`,
        `أعلى ساعة ${n(top.hour)} بـ ${n(top.cost)} ${cur}`,
        `اتصالات ${n(calls)}`,
      ]);
    }
    case 'products': {
      const read = signals.products;
      if (!read.ok) return '';
      if (read.value.length === 0) return 'ما فيه منتجات تسوق';
      const top = read.value[0];
      const title = top.title.length > 40 ? `${top.title.slice(0, 40)}...` : top.title;
      return join([`${counted(read.value.length, { one: 'منتج', two: 'منتجين', few: 'منتجات', many: 'منتج' })}`, `الأعلى صرفاً ${title} بـ ${n(top.cost30)} ${cur}`]);
    }
  }
}

/** The scenario as label and value rows for the operator page. */
export function describeScenario(scenario: Scenario): Array<{ label: string; value: string }> {
  const rows = [
    { label: 'حالة الحساب', value: STATE_LABELS[scenario.state] },
    { label: 'نوع النشاط', value: `${KIND_NAMES[scenario.kind]} (${CONFIDENCE_LABELS[scenario.kindConfidence]})` },
    { label: 'اللي يجيبه الإعلان', value: OUTCOME_LABELS[scenario.outcome] },
    { label: 'مدار من جهة ثانية', value: MANAGED_LABELS[scenario.managed] },
  ];
  if (scenario.platform) rows.push({ label: 'منصة المتجر', value: PLATFORM_LABELS[scenario.platform] });
  if (scenario.specialty) rows.push({ label: 'التخصص', value: SPECIALTY_LABELS[scenario.specialty] });
  if (scenario.kindRanking.length > 1) rows.push({ label: 'ترتيب الأنواع', value: scenario.kindRanking.map((kind) => KIND_NAMES[kind]).join('، ') });
  if (scenario.evidence.length > 0) rows.push({ label: 'الأدلة', value: scenario.evidence.join(' ') });
  return rows;
}

/** Counts for the heading of a read: how many signals came back and how many did not. */
export function readSummary(signals: AccountSignals, keys: readonly SignalKey[]) {
  const ok = keys.filter((key) => signals[key].ok).length;
  return { ok, failed: keys.length - ok };
}
