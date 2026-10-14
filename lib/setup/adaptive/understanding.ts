import { GOAL_OPTIONS, KIND_GOAL_OPTIONS, KIND_PAIN_OPTIONS, PAIN_OPTIONS, TYPE_OPTIONS, VALUE_OPTIONS, budgetRangeLabel, cleanUserText } from '../questions';
import { ADAPTIVE_CATALOG, adaptiveOptionLabel } from './answers';
import { focusLabel } from './focus';
import { activityPhrase } from './opener';
import {
  answeredChoice,
  averageOrder,
  cityNames,
  isAnswered,
  joinAnd,
  money,
  trustedKind,
} from './shared';
import type { AccountSignals, BusinessKind, DominantOutcome, Scenario, UnderstoodRow } from './types';

type Source = UnderstoodRow['source'];

/** What the account shows the customer gets, said after «اللي تبيه من الإعلان». */
const OUTCOME_WANT: Partial<Record<DominantOutcome, string>> = {
  purchases: 'طلبات شراء من المتجر',
  calls: 'اتصالات',
  forms: 'نماذج من الموقع',
  bookings: 'حجوزات',
  visits: 'زيارات للمحل أو الفرع',
};

function flat<T>(lists: Array<readonly T[]>): T[] {
  return lists.reduce<T[]>((all, list) => all.concat(list), []);
}

/** The label of a stored choice id, from whichever catalog it belongs to. Null when the id is not known. */
function labelOf(key: string, id: string): string | null {
  switch (key) {
    case 'type':
      return TYPE_OPTIONS.find((option) => option.id === id)?.label ?? null;
    case 'goal':
      return [...flat(Object.values(KIND_GOAL_OPTIONS)), ...GOAL_OPTIONS].find((option) => option.id === id)?.label ?? null;
    case 'pain':
      return [...flat(Object.values(KIND_PAIN_OPTIONS)), ...PAIN_OPTIONS].find((option) => option.id === id)?.label ?? null;
    case 'value':
      return VALUE_OPTIONS.find((option) => option.id === id)?.label ?? null;
    case 'focus_service':
      return focusLabel(id);
    default:
      return key in ADAPTIVE_CATALOG ? adaptiveOptionLabel(key as keyof typeof ADAPTIVE_CATALOG, id) : null;
  }
}

/** What the customer chose, in the words the screen showed, else the catalog's words. */
function said(
  key: string,
  answered: Partial<Record<string, string | null>>,
  labels: Partial<Record<string, string>>,
): string | null {
  if (!isAnswered(answered, key)) return null;
  const shown = labels[key]?.trim();
  if (shown) return shown;
  const choice = answeredChoice(answered, key);
  return choice ? labelOf(key, choice) : null;
}

const VALUE_LABEL: Record<BusinessKind, string> = {
  clinic: 'اللي يدفعه المريض في أول زيارة',
  ecommerce: 'متوسط الطلب',
  local: 'متوسط الفاتورة',
  services: 'قيمة العميل الواحد',
  general: 'قيمة العميل الواحد',
};

const FOCUS_LABEL: Record<BusinessKind, string> = {
  clinic: 'الخدمة اللي تبي تكثر حجوزاتها',
  services: 'الخدمة اللي تبي تكثر طلبها',
  ecommerce: 'اللي تبيعه',
  local: 'نوع نشاطك',
  general: 'اللي تبيعه',
};

/** The «غير كذا» tile is only the way to type a sector; the row says what they typed (stored as `businesses.sector`). */
const OTHER_TYPE_ID = 'other';
const SECTOR_ROW_MAX = 40;

function activityRow(args: {
  scenario: Scenario;
  signals: AccountSignals | null;
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  sector?: string | null;
}): UnderstoodRow | null {
  const { scenario, signals, answered, labels } = args;
  if (scenario.kindConfidence === 'stated') {
    if (answeredChoice(answered, 'type') === OTHER_TYPE_ID) {
      const typed = cleanUserText(args.sector ?? '', SECTOR_ROW_MAX);
      return typed ? { label: 'النشاط', value: typed, source: 'you' } : null;
    }
    const value = said('type', answered, labels);
    return value ? { label: 'النشاط', value, source: 'you' } : null;
  }
  if (scenario.kindConfidence !== 'confident') return null;
  const value = activityPhrase(scenario, signals);
  if (!value) return null;
  return { label: 'النشاط', value, source: answeredChoice(answered, 'confirm') === 'yes' ? 'confirmed' : 'account' };
}

function wantRow(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
}): UnderstoodRow | null {
  const { scenario, answered, labels } = args;
  const label = 'اللي تبيه من الإعلان';
  const own = said('goal', answered, labels);
  if (own) return { label, value: own, source: 'you' };
  const outcome = OUTCOME_WANT[scenario.outcome];
  if (!outcome || scenario.kindConfidence === 'guess' || scenario.kindConfidence === 'none') return null;
  const confirmed = answeredChoice(answered, 'confirm') === 'yes';
  return { label, value: outcome, source: confirmed ? 'confirmed' : 'account' };
}

function pickedProducts(
  answered: Partial<Record<string, string | null>>,
  labels: Partial<Record<string, string>>,
): string | null {
  if (!isAnswered(answered, 'push_products')) return null;
  const shown = labels.push_products?.trim();
  if (shown) return shown;
  const choice = answeredChoice(answered, 'push_products');
  if (choice === 'none') return 'كلها سوا';
  return null;
}

/**
 * CONTRACT (part B): the «فهمت عليك» rows, in the customer's words, before the
 * plan. A row exists only when something backs it: the account, the customer's
 * answer, or an account reading the customer confirmed. A «ما أدري» is left out
 * (a row that says nothing is noise).
 */
export function understandingRows(args: {
  scenario: Scenario;
  signals: AccountSignals | null;
  /** Ledger choice ids plus labels the screen already showed. */
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  /** `sector` is the free text a «غير كذا» type answer stored. */
  business: { name: string | null; monthlyBudget: number | null; targetRegions: string[]; sector?: string | null } | null;
}): UnderstoodRow[] {
  const { scenario, signals, answered, labels, business } = args;
  const kind = trustedKind(scenario);
  const currency = signals?.currency ?? 'SAR';
  const rows: UnderstoodRow[] = [];
  const push = (row: UnderstoodRow | null) => {
    if (row && row.value.trim()) rows.push(row);
  };
  const own = (label: string, key: string, skip: string[] = ['unknown']) => {
    const choice = answeredChoice(answered, key);
    if (choice && skip.includes(choice)) return;
    const value = said(key, answered, labels);
    if (value) push({ label, value, source: 'you' });
  };

  push(activityRow({ scenario, signals, answered, labels, sector: business?.sector ?? null }));

  // Where: the account's own targeting, else what the customer said.
  const targeted = cityNames(signals);
  if (targeted.length > 0 && !isAnswered(answered, 'regions')) {
    push({ label: 'وين تعلن', value: joinAnd(targeted), source: 'account' });
  } else if (business && business.targetRegions.length > 0) {
    push({ label: 'وين تعلن', value: joinAnd(business.targetRegions), source: 'you' });
  }

  push(wantRow({ scenario, answered, labels }));

  const focus = said('focus_service', answered, labels);
  if (focus) push({ label: FOCUS_LABEL[kind], value: focus, source: 'you' });

  // The value of one customer or order.
  const average = averageOrder(signals);
  const aov = answeredChoice(answered, 'aov_check');
  if (aov && average !== null) {
    const text = money(average, currency);
    if (aov === 'same') push({ label: VALUE_LABEL.ecommerce, value: `قرابة ${text}`, source: 'confirmed' });
    else push({ label: VALUE_LABEL.ecommerce, value: `${aov === 'less' ? 'أقل' : 'أكثر'} من ${text}`, source: 'you' });
  } else {
    own(VALUE_LABEL[kind], 'value');
  }
  own('الصفقة الواحدة', 'deal_value');
  own('من كل 10 يتواصلون معك يصيرون عملاء', 'close_rate');

  own('اللي يتبقى من كل 100 ريال', 'margin');
  const pushed = pickedProducts(answered, labels);
  if (pushed) push({ label: 'منتجات تبيها تبيع أكثر', value: pushed, source: 'you' });
  const excluded = said('exclude_products', answered, labels);
  if (excluded) push({ label: 'منتجات ما تبيها تطلع', value: excluded, source: 'you' });

  // What only this kind of business has to say.
  own('ساعات الرد على الاتصالات', 'call_hours');
  const booking = answeredChoice(answered, 'whatsapp_booking');
  if (booking) {
    const value = booking === 'yes' ? 'موجود' : booking === 'link' ? 'برابط حجز' : 'مو موجود';
    push({ label: 'الحجز بالواتساب', value, source: 'you' });
  }
  own('وقت ذروتك', 'peak_hours');
  const delivery = answeredChoice(answered, 'delivery_apps');
  if (delivery) push({ label: 'تطبيقات التوصيل', value: delivery === 'yes' ? 'موجود' : 'مو موجود', source: 'you' });

  own('اللي مضايقك', 'pain', ['unsure']);
  own('كيف تعرف النتيجة الحين', 'tracking_now');

  if (business && business.monthlyBudget !== null && business.monthlyBudget > 0) {
    const range = budgetRangeLabel(business.monthlyBudget);
    push({ label: 'الميزانية', value: `${range ?? money(business.monthlyBudget, currency)} بالشهر`, source: 'you' });
  }

  return rows;
}
