/**
 * What an adaptive answer is allowed to be, what it writes, and what the
 * customer's bubble and the assistant's reply say about it.
 *
 * One catalog per key holds every scenario's ids, because the server cannot
 * know which kind of business the screen asked for. Everything is stored the
 * way the legacy answers are: one `business_memory` fact with
 * `data.setup_key` and `data.choice`; the only `businesses` columns written are
 * `sector` and `primary_goal`, and only from a «yes» on the opener.
 *
 * questions.ts imports this file and this file imports questions.ts (for
 * cleanUserText, formatAmount and TYPE_OPTIONS), so nothing here may call into
 * questions.ts while the module loads. Only inside functions.
 */

import { TYPE_OPTIONS, cleanUserText, formatAmount } from '../questions';
import {
  ADAPTIVE_KEYS,
  type AdaptiveAnswer,
  type AdaptiveKey,
  type AdaptiveOption,
  type BusinessKind,
  type DominantOutcome,
} from './types';
import { ALL_FOCUS_ENTRIES, FOCUS_ALL_ID, FOCUS_ALL_LABEL, FOCUS_OTHER_ID, FOCUS_TEXT_MAX, FOCUS_TEXT_MIN } from './focus';
import { KIND_TYPE_ID, currencyWord, money } from './shared';
import { bucketBounds } from '../../economics/break-even';

export type AdaptiveParse = { ok: true; answer: AdaptiveAnswer } | { ok: false; error: string };

export type AdaptiveFact = {
  kind: 'goal' | 'margin' | 'constraint' | 'geo' | 'agency' | 'other' | 'product' | 'schedule' | 'capacity';
  fact_ar: string;
  data: Record<string, unknown>;
};

/** Facts only the server knows (the account's average order, an earlier answer) that sharpen a reaction. */
export type AdaptiveReactionContext = {
  /** The average order the account reported, in the account's currency. */
  aov?: number | null;
  currency?: string | null;
  /** The stored deal_value choice id, for close_rate's reaction. */
  dealValue?: string | null;
  /** The stored profit_per_deal choice id, for close_rate's reaction (it wins over the deal value). */
  profit?: string | null;
};

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/** Free text length for push_products and exclude_products. */
export const PRODUCT_TEXT_MAX = 120;

export const CONFIRM_OPTIONS: AdaptiveOption[] = [
  { id: 'yes', label: 'إي صح' },
  { id: 'no', label: 'لا، غير كذا' },
];

export const HAS_ACCOUNT_OPTIONS: AdaptiveOption[] = [
  { id: 'none', label: 'ما عندي حساب إعلانات' },
  { id: 'has', label: 'عندي حساب' },
];

export const AOV_CHECK_OPTIONS: AdaptiveOption[] = [
  { id: 'same', label: 'إي قريب' },
  { id: 'less', label: 'لا، أقل' },
  { id: 'more', label: 'لا، أكثر' },
];

/** What is left of every 100 riyals, after the product and the shipping. */
export const MARGIN_RANGES: Record<string, { min: number | null; max: number | null }> = {
  lt20: { min: 0, max: 20 },
  '20_40': { min: 20, max: 40 },
  gt40: { min: 40, max: null },
  unknown: { min: null, max: null },
};

export const MARGIN_OPTIONS: AdaptiveOption[] = [
  { id: 'lt20', label: 'أقل من 20 ريال' },
  { id: '20_40', label: 'من 20 إلى 40 ريال' },
  { id: 'gt40', label: 'أكثر من 40 ريال' },
  { id: 'unknown', label: 'ما أدري', icon: 'help' },
];

export const PUSH_NONE_ID = 'none';
export const PUSH_TEXT_ID = 'text';
const PUSH_PRODUCT_ID = /^p_[0-9]$/;

export const PUSH_PRODUCTS_OPTIONS: AdaptiveOption[] = [
  ...Array.from({ length: 10 }, (_, index) => ({ id: `p_${index}`, label: 'منتج من القائمة' })),
  { id: PUSH_NONE_ID, label: 'لا، كلها سوا' },
  { id: PUSH_TEXT_ID, label: 'منتج ثاني' },
];

export const EXCLUDE_PRODUCTS_OPTIONS: AdaptiveOption[] = [
  { id: 'out_of_stock', label: 'نفدت أو قربت تخلص' },
  { id: 'low_margin', label: 'ربحها قليل' },
  { id: 'none', label: 'لا، كلها تطلع' },
  { id: 'text', label: 'منتج معيّن' },
];

/** The hours somebody answers the phone, as [from, to) in 24-hour time. `always` is the whole day. */
export const CALL_HOURS_WINDOWS: Record<string, Array<[number, number]>> = {
  split_9_13_16_22: [
    [9, 13],
    [16, 22],
  ],
  day_8_23: [[8, 23]],
  evening_16_24: [[16, 24]],
  always: [[0, 24]],
};

export const CALL_HOURS_OPTIONS: AdaptiveOption[] = [
  { id: 'split_9_13_16_22', label: 'فترتين: 9 الصبح لين 1، و4 العصر لين 10 الليل' },
  { id: 'day_8_23', label: 'من 8 الصبح لين 11 الليل' },
  { id: 'evening_16_24', label: 'المسا بس: من 4 العصر لين 12 الليل' },
  { id: 'always', label: 'أي وقت والجوال معي' },
];

export const WHATSAPP_BOOKING_OPTIONS: AdaptiveOption[] = [
  { id: 'yes', label: 'إي' },
  { id: 'no', label: 'لا' },
  { id: 'link', label: 'عندنا رابط حجز' },
];

export const DEAL_VALUE_RANGES: Record<string, { min: number | null; max: number | null }> = {
  lt2k: { min: 0, max: 2000 },
  '2k_10k': { min: 2000, max: 10000 },
  '10k_50k': { min: 10000, max: 50000 },
  gt50k: { min: 50000, max: null },
  unknown: { min: null, max: null },
};

export const DEAL_VALUE_OPTIONS: AdaptiveOption[] = [
  { id: 'lt2k', label: 'أقل من 2,000 ريال' },
  { id: '2k_10k', label: 'من 2,000 إلى 10,000 ريال' },
  { id: '10k_50k', label: 'من 10,000 إلى 50,000 ريال' },
  { id: 'gt50k', label: 'أكثر من 50,000 ريال' },
  { id: 'unknown', label: 'ما أدري', icon: 'help' },
];

/**
 * What is left of ONE customer after the costs, in riyals (services, clinic, local). The buckets start low
 * on purpose: a shop or a restaurant makes tens of riyals on a customer, a clinic hundreds, a contractor
 * thousands, and the optimizer takes the lower edge of the answered bucket as the profit
 * (lib/economics/break-even.ts), so a bucket never makes the client look richer than they said.
 */
export const PROFIT_PER_DEAL_RANGES: Record<string, { min: number | null; max: number | null }> = {
  lt50: { min: 0, max: 50 },
  '50_200': { min: 50, max: 200 },
  '200_1k': { min: 200, max: 1000 },
  '1k_5k': { min: 1000, max: 5000 },
  gt5k: { min: 5000, max: null },
  unknown: { min: null, max: null },
};

export const PROFIT_PER_DEAL_OPTIONS: AdaptiveOption[] = [
  { id: 'lt50', label: 'أقل من 50 ريال' },
  { id: '50_200', label: 'من 50 إلى 200 ريال' },
  { id: '200_1k', label: 'من 200 إلى 1,000 ريال' },
  { id: '1k_5k', label: 'من 1,000 إلى 5,000 ريال' },
  { id: 'gt5k', label: 'أكثر من 5,000 ريال' },
  { id: 'unknown', label: 'ما أدري', icon: 'help' },
];

/** Out of every 10 who get in touch, how many become customers. */
export const CLOSE_RATE_RANGES: Record<string, { min: number | null; max: number | null }> = {
  le1: { min: 0, max: 1 },
  '2_3': { min: 2, max: 3 },
  ge4: { min: 4, max: 10 },
  unknown: { min: null, max: null },
};

export const CLOSE_RATE_OPTIONS: AdaptiveOption[] = [
  { id: 'le1', label: '1 أو أقل' },
  { id: '2_3', label: 'من 2 إلى 3' },
  { id: 'ge4', label: '4 وفوق' },
  { id: 'unknown', label: 'ما أدري', icon: 'help' },
];

export const PEAK_HOURS_OPTIONS: AdaptiveOption[] = [
  { id: 'breakfast', label: 'الفطور' },
  { id: 'lunch', label: 'الغدا' },
  { id: 'dinner', label: 'العشا' },
  { id: 'late', label: 'آخر الليل' },
];

export const DELIVERY_APPS_OPTIONS: AdaptiveOption[] = [
  { id: 'yes', label: 'إي موجود' },
  { id: 'no', label: 'لا' },
];

export const TRACKING_NOW_OPTIONS: AdaptiveOption[] = [
  { id: 'tells_me', label: 'العميل يقول لي' },
  { id: 'check_records', label: 'أراجع الطلبات أو الحجوزات عندي' },
  { id: 'dont_know', label: 'ما أعرف', icon: 'help' },
];

export const FOCUS_SERVICE_OPTIONS: AdaptiveOption[] = [
  ...ALL_FOCUS_ENTRIES.map((entry) => ({ id: entry.id, label: entry.label })),
  { id: FOCUS_ALL_ID, label: FOCUS_ALL_LABEL },
  { id: FOCUS_OTHER_ID, label: 'غير كذا' },
];

/** Every id each key accepts, whatever the scenario. */
export const ADAPTIVE_CATALOG: Record<AdaptiveKey, AdaptiveOption[]> = {
  confirm: CONFIRM_OPTIONS,
  has_account: HAS_ACCOUNT_OPTIONS,
  focus_service: FOCUS_SERVICE_OPTIONS,
  aov_check: AOV_CHECK_OPTIONS,
  margin: MARGIN_OPTIONS,
  push_products: PUSH_PRODUCTS_OPTIONS,
  exclude_products: EXCLUDE_PRODUCTS_OPTIONS,
  call_hours: CALL_HOURS_OPTIONS,
  whatsapp_booking: WHATSAPP_BOOKING_OPTIONS,
  deal_value: DEAL_VALUE_OPTIONS,
  profit_per_deal: PROFIT_PER_DEAL_OPTIONS,
  close_rate: CLOSE_RATE_OPTIONS,
  peak_hours: PEAK_HOURS_OPTIONS,
  delivery_apps: DELIVERY_APPS_OPTIONS,
  tracking_now: TRACKING_NOW_OPTIONS,
};

export function isAdaptiveChoice(key: AdaptiveKey, choice: string): boolean {
  return ADAPTIVE_CATALOG[key].some((option) => option.id === choice);
}

/** The label of one catalog option, or null when the id is not in the key's catalog. */
export function adaptiveOptionLabel(key: AdaptiveKey, id: string): string | null {
  return ADAPTIVE_CATALOG[key].find((option) => option.id === id)?.label ?? null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const KINDS: BusinessKind[] = ['ecommerce', 'clinic', 'services', 'local', 'general'];
const OUTCOMES: DominantOutcome[] = ['purchases', 'calls', 'forms', 'bookings', 'visits', 'unknown'];

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The ids the customer ticked: `choices` when it is an array, else the single `choice`. */
function pickedIds(input: Record<string, unknown>): string[] {
  const fromChoices = Array.isArray(input.choices) ? input.choices.filter((item): item is string => typeof item === 'string') : [];
  const single = typeof input.choice === 'string' && input.choice ? [input.choice] : [];
  const list = fromChoices.length > 0 ? fromChoices : single;
  return list.filter((id, index) => list.indexOf(id) === index).slice(0, 10);
}

/** CONTRACT (part B): validates against each key's full option catalog (every scenario's ids). */
export function parseAdaptiveAnswer(key: AdaptiveKey, raw: unknown): AdaptiveParse {
  if (!(ADAPTIVE_KEYS as readonly string[]).includes(key)) return { ok: false, error: 'invalid_key' };
  const input = asRecord(raw);
  const choice = typeof input.choice === 'string' ? input.choice : '';

  switch (key) {
    case 'confirm': {
      if (choice !== 'yes' && choice !== 'no') return { ok: false, error: 'invalid_choice' };
      if (choice === 'no') return { ok: true, answer: { key, choice } };
      const kind = input.kind;
      const outcome = input.outcome;
      if (kind !== undefined && kind !== null && !KINDS.includes(kind as BusinessKind)) return { ok: false, error: 'invalid_kind' };
      if (outcome !== undefined && outcome !== null && !OUTCOMES.includes(outcome as DominantOutcome)) {
        return { ok: false, error: 'invalid_outcome' };
      }
      return {
        ok: true,
        answer: {
          key,
          choice,
          ...(kind ? { kind: kind as BusinessKind } : {}),
          ...(outcome ? { outcome: outcome as DominantOutcome } : {}),
        },
      };
    }

    case 'focus_service': {
      if (!isAdaptiveChoice(key, choice)) return { ok: false, error: 'invalid_choice' };
      if (choice === FOCUS_OTHER_ID) {
        const text = cleanUserText(input.text, FOCUS_TEXT_MAX);
        if (text.length < FOCUS_TEXT_MIN) return { ok: false, error: 'text_required' };
        return { ok: true, answer: { key, choice, text } };
      }
      return { ok: true, answer: { key, choice } };
    }

    case 'push_products': {
      const ids = pickedIds(input).filter((id) => id !== PUSH_TEXT_ID);
      if (ids.some((id) => !PUSH_PRODUCT_ID.test(id) && id !== PUSH_NONE_ID)) return { ok: false, error: 'invalid_choice' };
      const text = cleanUserText(input.text, PRODUCT_TEXT_MAX);
      if (ids.includes(PUSH_NONE_ID)) {
        if (ids.length > 1 || text) return { ok: false, error: 'invalid_choice' };
        return { ok: true, answer: { key, choice: PUSH_NONE_ID, choices: [PUSH_NONE_ID] } };
      }
      if (ids.length === 0) {
        if (text.length < 2) return { ok: false, error: 'text_required' };
        return { ok: true, answer: { key, choice: PUSH_TEXT_ID, text } };
      }
      return { ok: true, answer: { key, choice: ids[0], choices: ids, ...(text.length >= 2 ? { text } : {}) } };
    }

    case 'exclude_products': {
      if (!isAdaptiveChoice(key, choice)) return { ok: false, error: 'invalid_choice' };
      if (choice === 'text') {
        const text = cleanUserText(input.text, PRODUCT_TEXT_MAX);
        if (text.length < 2) return { ok: false, error: 'text_required' };
        return { ok: true, answer: { key, choice, text } };
      }
      return { ok: true, answer: { key, choice } };
    }

    case 'peak_hours': {
      const ids = pickedIds(input);
      if (ids.length === 0 || ids.some((id) => !isAdaptiveChoice(key, id))) return { ok: false, error: 'invalid_choice' };
      return { ok: true, answer: { key, choice: ids[0], choices: ids } };
    }

    default:
      if (!isAdaptiveChoice(key, choice)) return { ok: false, error: 'invalid_choice' };
      return { ok: true, answer: { key, choice } };
  }
}

// ---------------------------------------------------------------------------
// Labels (the customer's bubble)
// ---------------------------------------------------------------------------

function labelsOf(key: AdaptiveKey, ids: readonly string[]): string[] {
  return ids.map((id) => adaptiveOptionLabel(key, id)).filter((label): label is string => Boolean(label));
}

/** CONTRACT (part B): what the customer's bubble says. */
export function adaptiveLabel(answer: AdaptiveAnswer): string {
  const { key, choice } = answer;
  if (key === 'focus_service' && choice === FOCUS_OTHER_ID) return answer.text ?? adaptiveOptionLabel(key, choice) ?? choice;
  if (key === 'push_products') {
    if (choice === PUSH_NONE_ID) return 'لا، كلها سوا';
    const named = [...(answer.titles ?? []), ...(answer.text ? [answer.text] : [])].filter(Boolean);
    if (named.length > 0) return named.join('، ');
    return 'منتجات من القائمة';
  }
  if (key === 'exclude_products' && choice === 'text') return answer.text ?? 'منتج معيّن';
  if (key === 'peak_hours') return labelsOf(key, answer.choices ?? [choice]).join('، ') || choice;
  return adaptiveOptionLabel(key, choice) ?? choice;
}

// ---------------------------------------------------------------------------
// Effects (what is written)
// ---------------------------------------------------------------------------

const OUTCOME_GOAL: Partial<Record<DominantOutcome, string>> = {
  purchases: 'conversions',
  calls: 'leads',
  forms: 'leads',
  bookings: 'leads',
  visits: 'leads',
};

const OUTCOME_TEXT: Partial<Record<DominantOutcome, string>> = {
  purchases: 'طلبات شراء من المتجر',
  calls: 'اتصالات',
  forms: 'نماذج من الموقع',
  bookings: 'حجوزات',
  visits: 'زيارات للمحل أو الفرع',
};

function rangeText(range: { min: number | null; max: number | null }, unit: string): string {
  if (range.min === null && range.max === null) return 'ما يعرف';
  if (range.min === 0 && range.max !== null) return `أقل من ${formatAmount(range.max)} ${unit}`;
  if (range.max === null && range.min !== null) return `أكثر من ${formatAmount(range.min)} ${unit}`;
  return `من ${formatAmount(range.min ?? 0)} إلى ${formatAmount(range.max ?? 0)} ${unit}`;
}

/**
 * The `businesses` columns a «yes» on the opener writes for the kind and outcome it confirmed. One rule for the
 * write itself and for taking it back when the customer later says «no» (see `recordSetupAnswer`).
 */
export function confirmBusinessColumns(
  kind?: BusinessKind | null,
  outcome?: DominantOutcome | null
): Partial<{ sector: string; primary_goal: string }> {
  const typeId = kind ? KIND_TYPE_ID[kind] : null;
  const sector = typeId ? TYPE_OPTIONS.find((option) => option.id === typeId)?.label : undefined;
  const goal = outcome ? OUTCOME_GOAL[outcome] : undefined;
  return { ...(sector ? { sector } : {}), ...(goal ? { primary_goal: goal } : {}) };
}

/** CONTRACT (part B): the businesses columns (sector, primary_goal only) and the memory fact for one answer. */
export function adaptiveEffects(answer: AdaptiveAnswer): {
  business: Partial<{ sector: string; primary_goal: string }>;
  fact: AdaptiveFact | null;
} {
  const { key, choice } = answer;
  const data = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    setup_key: key,
    choice,
    ...(answer.choices ? { choices: answer.choices } : {}),
    ...(answer.text ? { text: answer.text } : {}),
    // The words the customer saw, so a reload can show the same «فهمت عليك» rows.
    label: adaptiveLabel(answer),
    ...extra,
  });
  const label = adaptiveOptionLabel(key, choice) ?? choice;

  switch (key) {
    case 'confirm': {
      if (choice !== 'yes') {
        return {
          business: {},
          fact: { kind: 'other', fact_ar: 'قال إن قراءتنا لنوع نشاطه ونتيجته مو صح', data: data() },
        };
      }
      const columns = confirmBusinessColumns(answer.kind, answer.outcome);
      const outcomeText = answer.outcome ? OUTCOME_TEXT[answer.outcome] : undefined;
      const pieces = [columns.sector ? `نشاطه ${columns.sector}` : null, outcomeText ? `وأهم نتيجة يبيها: ${outcomeText}` : null].filter(Boolean);
      return {
        business: columns,
        fact: {
          kind: outcomeText ? 'goal' : 'other',
          fact_ar: pieces.length > 0 ? `${pieces.join('، ')} (أكد قراءتنا لحسابه)` : 'أكد قراءتنا لحسابه',
          data: data({ ...(answer.kind ? { kind: answer.kind } : {}), ...(answer.outcome ? { outcome: answer.outcome } : {}) }),
        },
      };
    }

    case 'has_account':
      return {
        business: {},
        fact: {
          kind: 'other',
          fact_ar: choice === 'none' ? 'ما عنده حساب إعلانات قوقل للحين' : 'عنده حساب إعلانات قوقل',
          data: data(),
        },
      };

    case 'focus_service': {
      const named = choice === FOCUS_OTHER_ID ? answer.text ?? '' : label;
      return {
        business: {},
        fact: {
          kind: 'product',
          fact_ar:
            choice === FOCUS_ALL_ID
              ? 'يبي يكثّر الطلب على كل خدماته بنفس القدر'
              : `الخدمة اللي يبي يكثّر الطلب عليها: ${named}`,
          data: data(),
        },
      };
    }

    case 'aov_check': {
      // The number the account reported, filled by the server (never the browser) so the fact can say it.
      const reported = typeof answer.amount === 'number' && Number.isFinite(answer.amount) && answer.amount > 0 ? Math.round(answer.amount) : null;
      const said = reported !== null ? money(reported, answer.currency) : null;
      return {
        business: {},
        fact: {
          kind: 'margin',
          fact_ar:
            choice === 'same'
              ? said
                ? `متوسط طلبه من قوقل قرابة ${said}، وقال إنه قريب من الصح`
                : 'متوسط الطلب اللي قراه حسابه قريب من الصح'
              : choice === 'less'
                ? said
                  ? `متوسط طلبه من قوقل قرابة ${said}، وقال إن الفعلي أقل`
                  : 'متوسط طلبه الفعلي أقل من اللي قراه حسابه'
                : said
                  ? `متوسط طلبه من قوقل قرابة ${said}، وقال إن الفعلي أكثر`
                  : 'متوسط طلبه الفعلي أكثر من اللي قراه حسابه',
          data: data(reported !== null ? { aov: reported, ...(answer.currency ? { currency: answer.currency } : {}) } : {}),
        },
      };
    }

    case 'margin': {
      const range = MARGIN_RANGES[choice] ?? { min: null, max: null };
      return {
        business: {},
        fact: {
          kind: 'margin',
          fact_ar:
            choice === 'unknown'
              ? 'ما يعرف كم يتبقى له من كل 100 ريال بعد التكلفة'
              : `يتبقى له من كل 100 ريال ${rangeText(range, 'ريال')} بعد تكلفة المنتج والشحن`,
          data: data({ min_per_100: range.min, max_per_100: range.max }),
        },
      };
    }

    case 'push_products':
      return {
        business: {},
        fact: {
          kind: 'product',
          fact_ar:
            choice === PUSH_NONE_ID
              ? 'ما عنده منتجات معيّنة يبيها تبيع أكثر، كلها عنده سوا'
              : (answer.titles?.length ?? 0) > 0 || answer.text
                ? `منتجات يبي تبيع أكثر: ${adaptiveLabel(answer)}`
                : 'اختار منتجات من قائمة الصرف يبيها تبيع أكثر',
          data: data(),
        },
      };

    case 'exclude_products':
      return {
        business: {},
        fact: {
          kind: 'constraint',
          fact_ar:
            choice === 'none'
              ? 'ما عنده منتجات يبيها ما تطلع في الإعلانات'
              : choice === 'text'
                ? `منتجات ما يبيها تطلع في الإعلانات: ${answer.text ?? ''}`
                : choice === 'out_of_stock'
                  ? 'عنده منتجات ما يبيها تطلع في الإعلانات لأنها نفدت أو قربت تخلص'
                  : 'عنده منتجات ما يبيها تطلع في الإعلانات لأن ربحها قليل',
          data: data(),
        },
      };

    case 'call_hours':
      return {
        business: {},
        fact: {
          kind: 'schedule',
          fact_ar: choice === 'always' ? 'يرد على الاتصالات أي وقت' : `ساعات الرد على اتصالاته: ${label}`,
          data: data({ windows: CALL_HOURS_WINDOWS[choice] ?? [] }),
        },
      };

    case 'whatsapp_booking':
      return {
        business: {},
        fact: {
          kind: 'capacity',
          fact_ar:
            choice === 'yes'
              ? 'عنده واتساب للحجز'
              : choice === 'link'
                ? 'الحجز عنده عن طريق رابط حجز'
                : 'ما عنده واتساب للحجز',
          data: data(),
        },
      };

    case 'deal_value': {
      const range = DEAL_VALUE_RANGES[choice] ?? { min: null, max: null };
      return {
        business: {},
        fact: {
          kind: 'margin',
          fact_ar: choice === 'unknown' ? 'ما يعرف كم تسوى له الصفقة الواحدة' : `الصفقة الواحدة تسوى له تقريباً ${rangeText(range, 'ريال')}`,
          data: data({ min_sar: range.min, max_sar: range.max }),
        },
      };
    }

    case 'profit_per_deal': {
      const range = PROFIT_PER_DEAL_RANGES[choice] ?? { min: null, max: null };
      return {
        business: {},
        fact: {
          kind: 'margin',
          fact_ar:
            choice === 'unknown'
              ? 'ما يعرف كم يربح من العميل الواحد بعد التكاليف'
              : `يربح من العميل الواحد بعد التكاليف تقريباً ${rangeText(range, 'ريال')}`,
          data: data({ min_sar: range.min, max_sar: range.max }),
        },
      };
    }

    case 'close_rate': {
      const range = CLOSE_RATE_RANGES[choice] ?? { min: null, max: null };
      return {
        business: {},
        fact: {
          kind: 'margin',
          fact_ar:
            choice === 'unknown'
              ? 'ما يعرف كم من اللي يتواصلون معه يصيرون عملاء'
              : `من كل 10 يتواصلون معه يصير عميل تقريباً ${choice === 'le1' ? '1 أو أقل' : choice === 'ge4' ? '4 وفوق' : 'من 2 إلى 3'}`,
          data: data({ min_of_10: range.min, max_of_10: range.max }),
        },
      };
    }

    case 'peak_hours':
      return {
        business: {},
        fact: {
          kind: 'schedule',
          fact_ar: `وقت ذروته: ${labelsOf(key, answer.choices ?? [choice]).join('، ')}`,
          data: data(),
        },
      };

    case 'delivery_apps':
      return {
        business: {},
        fact: {
          kind: 'capacity',
          fact_ar: choice === 'yes' ? 'موجود في تطبيقات التوصيل' : 'مو موجود في تطبيقات التوصيل',
          data: data(),
        },
      };

    case 'tracking_now':
      return {
        business: {},
        fact: {
          kind: 'other',
          fact_ar:
            choice === 'tells_me'
              ? 'يعرف نتيجة الإعلان من العميل نفسه لما يقول له'
              : choice === 'check_records'
                ? 'يعرف نتيجة الإعلان من مراجعة طلباته أو حجوزاته'
                : 'ما يعرف الحين وش جاب له الإعلان',
          data: data(),
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Reactions (the short line «مُضاعِف» says back)
// ---------------------------------------------------------------------------

/**
 * The cost of one order the ads can carry, from the average order and what is
 * left of every 100 riyals. Null when either is unknown. The ranges are the
 * customer's own, so the line says what they imply and no more.
 */
export function breakEvenLine(aov: number | null | undefined, marginChoice: string, currency?: string | null): string | null {
  if (!aov || aov <= 0) return null;
  const word = currencyWord(currency);
  const low = Math.round(aov * 0.2);
  const mid = Math.round(aov * 0.4);
  switch (marginChoice) {
    case 'lt20':
      return `يعني الطلب لازم يكلفك إعلان أقل من ${formatAmount(low)} ${word} تقريباً عشان تطلع رابح. بحسبها كذا.`;
    case '20_40':
      return `يعني الطلب اللي يكلفك إعلان أقل من ${formatAmount(low)} ${word} تقريباً رابح، واللي فوق ${formatAmount(mid)} خسران. بحسبها كذا.`;
    case 'gt40':
      return `يعني أي طلب يكلفك إعلان أقل من ${formatAmount(mid)} ${word} تقريباً أنت فيه رابح. بحسبها كذا.`;
    default:
      return null;
  }
}

/** What one contact is worth, from the deal range and the close-rate range the customer gave. */
export function contactValueLine(dealChoice: string | null | undefined, closeChoice: string, currency?: string | null): string | null {
  const deal = dealChoice ? DEAL_VALUE_RANGES[dealChoice] : undefined;
  const close = CLOSE_RATE_RANGES[closeChoice];
  if (!deal || !close || deal.min === null || close.min === null || close.max === null) return null;
  const word = currencyWord(currency);
  const low = Math.round((deal.min * close.min) / 10);
  const high = deal.max === null ? null : Math.round((deal.max * close.max) / 10);
  if (closeChoice === 'le1') {
    return high === null ? null : `يعني الاتصال الواحد يسوى لك أقل من ${formatAmount(high)} ${word} تقريباً.`;
  }
  if (high === null || closeChoice === 'ge4') {
    return `يعني الاتصال الواحد يسوى لك أكثر من ${formatAmount(low)} ${word} تقريباً.`;
  }
  return `يعني الاتصال الواحد يسوى لك من ${formatAmount(low)} إلى ${formatAmount(high)} ${word} تقريباً.`;
}

/** Under this many riyals a limit per contact is not a number worth showing: one click can cost that much. */
export const CONTACT_LINE_FLOOR_SAR = 10;

/**
 * The most one contact may cost before the ads lose money: the profit per
 * customer times the share of contacts that become customers. The customer
 * answered two buckets, so the limit is a RANGE (low edges to high edges, the
 * same ends the optimizer holds the account to: lib/economics/break-even.ts),
 * and the line says so instead of quoting one edge as if it were exact.
 *
 * Small numbers are not shown. A profit under 50 riyals with a close rate of one
 * in ten gives a limit near one riyal, which reads as an error and means only
 * "the margin per contact is thin": the line then says that in words. When just
 * the low end is under the floor the line gives the ceiling alone («أقل من»).
 */
export function breakEvenContactLine(profitChoice: string | null | undefined, closeChoice: string): string | null {
  const profitRange = profitChoice ? PROFIT_PER_DEAL_RANGES[profitChoice] : undefined;
  const closeRange = CLOSE_RATE_RANGES[closeChoice];
  if (!profitRange || !closeRange) return null;
  const profit = bucketBounds(profitRange.min, profitRange.max);
  const close = bucketBounds(closeRange.min, closeRange.max);
  if (!profit || !close) return null;

  const low = (profit.low * close.low) / 10;
  const high = (profit.high * close.high) / 10;
  // The profit buckets are in riyals whatever the account's currency, so the line says riyals.
  if (high < CONTACT_LINE_FLOOR_SAR) {
    return 'يعني الربح على الاتصال الواحد ضيّق، فلازم كل اتصال يجي رخيص. بحسبها كذا.';
  }
  if (low < CONTACT_LINE_FLOOR_SAR) {
    return `يعني أقصى سعر للاتصال الواحد عشان تطلع رابح أقل من ${formatAmount(Math.round(high))} ريال تقريباً. بحسبها كذا.`;
  }
  return `يعني أقصى سعر للاتصال الواحد عشان تطلع رابح بين ${formatAmount(Math.round(low))} و${formatAmount(Math.round(high))} ريال تقريباً. بحسبها كذا.`;
}

/**
 * CONTRACT (part B): the short line «مُضاعِف» says back, or null. Most answers
 * get none on purpose. `context` carries what only the server knows; without
 * it the margin and close-rate answers get a plain line instead of a number.
 */
export function adaptiveReaction(answer: AdaptiveAnswer, context: AdaptiveReactionContext = {}): string | null {
  const { key, choice } = answer;
  switch (key) {
    case 'confirm':
      return choice === 'no' ? 'ولا يهمك، أسألك أنت بدل ما أخمّن.' : null;
    case 'aov_check':
      return choice === 'same' ? null : 'زين، أحسب على متوسطك أنت مو على اللي قراه الحساب.';
    case 'margin': {
      const line = breakEvenLine(context.aov, choice, context.currency);
      if (line) return line;
      if (choice === 'lt20') return 'تمام، الربح ضيق، فبحسب كل ريال إعلان بدقة.';
      if (choice === '20_40') return 'زين، فيه مجال بس مو واسع.';
      if (choice === 'gt40') return 'ممتاز، هامشك يتحمل تكلفة إعلان أعلى.';
      return 'ولا يهمك، نقدّره مع الوقت من طلباتك.';
    }
    case 'call_hours':
      return choice === 'always' ? null : 'تمام، أشوف كم ينصرف وكم يتصل خارج هالساعات.';
    case 'close_rate':
      return breakEvenContactLine(context.profit, choice) ?? contactValueLine(context.dealValue, choice, context.currency);
    case 'tracking_now':
      if (choice === 'dont_know') return 'ولا يهمك، أول شي نركّب التتبع عشان تشوف النتيجة بعينك.';
      if (choice === 'tells_me') return 'زين، والتتبع يخلي قوقل نفسه يعرف.';
      return null;
    default:
      return null;
  }
}
