/**
 * The setup conversation with «زياد»: which questions, in what order, what
 * each answer is allowed to be, and what it writes.
 *
 * Pure on purpose: the API route and the screen import the same rules, so the
 * browser can never offer a choice the server would refuse, and tests cover
 * every branch without a database.
 *
 * Every answer writes two things: the matching `businesses` column when there
 * is one (the audit, the optimizer and the brain already read those), and one
 * `business_memory` fact (source "onboarding", basis "stated") that the brain
 * reads as something the customer told it. The fact also carries
 * `data.setup_key`, which is how a refreshed page knows which questions were
 * already answered without a new column or migration.
 */

export const SETUP_KEYS = [
  'type',
  'name',
  'goal',
  'value',
  'budget',
  'regions',
  'manager',
  'pain',
  'website',
  'consent',
] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

/** The questions the brain needs most. Missing any of them puts the «كمّل تعريفي» card on the home screen. */
export const CORE_KEYS: SetupKey[] = ['type', 'goal', 'value', 'budget'];

export type IconKey =
  | 'bag'
  | 'briefcase'
  | 'store'
  | 'health'
  | 'building'
  | 'food'
  | 'school'
  | 'dots'
  | 'cart'
  | 'phone'
  | 'pin'
  | 'globe'
  | 'megaphone'
  | 'user'
  | 'users'
  | 'badge'
  | 'off'
  | 'trend-down'
  | 'coins'
  | 'help'
  | 'rocket'
  | 'search'
  | 'map'
  | 'check'
  | 'shield'
  | 'pencil'
  | 'clock'
  | 'flag';

export type SetupOption = {
  id: string;
  label: string;
  hint?: string;
  icon?: IconKey;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Business types. The stored `sector` is the label itself, written the same
 * way for everyone, so the anonymous sector benchmarks can group real peers.
 */
export const TYPE_OPTIONS: SetupOption[] = [
  { id: 'ecommerce', label: 'متجر إلكتروني', icon: 'bag' },
  { id: 'services', label: 'شركة خدمات', icon: 'briefcase' },
  { id: 'local_store', label: 'محل أو فرع', icon: 'store' },
  { id: 'clinic', label: 'عيادة أو مركز طبي', icon: 'health' },
  { id: 'real_estate', label: 'عقار ومقاولات', icon: 'building' },
  { id: 'restaurant', label: 'مطعم أو كافيه', icon: 'food' },
  { id: 'education', label: 'تعليم وتدريب', icon: 'school' },
  { id: 'other', label: 'غير كذا', icon: 'dots' },
];

const GOAL_COLUMN = {
  online_sales: 'conversions',
  calls: 'leads',
  store_visits: 'leads',
  site_visits: 'traffic',
  awareness: 'awareness',
} as const;

export const GOAL_OPTIONS: SetupOption[] = [
  { id: 'online_sales', label: 'يشترون من متجري أو موقعي', icon: 'cart' },
  { id: 'calls', label: 'يتصلون أو يراسلوني واتساب', icon: 'phone' },
  { id: 'store_visits', label: 'يجون المحل أو الفرع', icon: 'pin' },
  { id: 'site_visits', label: 'يدخلون موقعي ويتعرفون علي', icon: 'globe' },
  { id: 'awareness', label: 'الناس تعرف اسمي', icon: 'megaphone' },
];

const VALUE_RANGES: Record<string, { min: number | null; max: number | null; text: string }> = {
  lt100: { min: 0, max: 100, text: 'أقل من 100 ريال' },
  '100_500': { min: 100, max: 500, text: 'من 100 إلى 500 ريال' },
  '500_2000': { min: 500, max: 2000, text: 'من 500 إلى 2,000 ريال' },
  gt2000: { min: 2000, max: null, text: 'أكثر من 2,000 ريال' },
  unknown: { min: null, max: null, text: 'ما أدري' },
};

export const VALUE_OPTIONS: SetupOption[] = [
  { id: 'lt100', label: 'أقل من 100 ريال' },
  { id: '100_500', label: 'من 100 إلى 500 ريال' },
  { id: '500_2000', label: 'من 500 إلى 2,000 ريال' },
  { id: 'gt2000', label: 'أكثر من 2,000 ريال' },
  { id: 'unknown', label: 'ما أدري', icon: 'help' },
];

export const REGION_OPTIONS: SetupOption[] = [
  { id: 'saudi', label: 'كل السعودية', icon: 'flag' },
  { id: 'cities', label: 'مدن معيّنة', hint: 'تختارها بعدها', icon: 'map' },
  { id: 'gulf', label: 'السعودية والخليج', icon: 'globe' },
];

export const CITY_OPTIONS = [
  'الرياض',
  'جدة',
  'مكة',
  'المدينة',
  'الدمام والخبر',
  'الأحساء',
  'القصيم',
  'الطائف',
  'أبها وخميس مشيط',
  'تبوك',
  'حائل',
  'جازان',
] as const;

export const MANAGER_OPTIONS: SetupOption[] = [
  { id: 'self', label: 'أنا بنفسي', icon: 'user' },
  { id: 'agency', label: 'وكالة أو مسوّق', icon: 'users' },
  { id: 'employee', label: 'موظف عندي', icon: 'badge' },
  { id: 'nobody', label: 'ولا أحد، مهملة', icon: 'off' },
];

export const PAIN_OPTIONS: SetupOption[] = [
  { id: 'few_leads', label: 'أصرف والطلبات ما تكفي', icon: 'trend-down' },
  { id: 'expensive', label: 'الطلبات تجي بس غالية', icon: 'coins' },
  { id: 'confusing', label: 'ما أفهم وش يصير في الحساب', icon: 'help' },
  { id: 'grow', label: 'أبي أكبر وأوصل لناس أكثر', icon: 'rocket' },
  { id: 'unsure', label: 'ما أدري، شوف أنت', icon: 'search' },
];

export const CONSENT_OPTIONS: SetupOption[] = [
  { id: 'auto_small', label: 'سوّها وبلغني', icon: 'check' },
  { id: 'always_ask', label: 'استأذني في كل شي', icon: 'shield' },
];

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type SetupAnswer =
  | { key: 'type'; choice: string; text?: string }
  | { key: 'name'; text: string }
  | { key: 'goal'; choice: keyof typeof GOAL_COLUMN }
  | { key: 'value'; choice: string }
  | { key: 'budget'; amount: number | null }
  | { key: 'regions'; choice: 'saudi' | 'gulf' | 'cities'; cities: string[] }
  | { key: 'manager'; choice: string }
  | { key: 'pain'; choice: string }
  | { key: 'website'; choice: 'url' | 'none' | 'later'; url?: string };

export type ParseResult = { ok: true; answer: SetupAnswer } | { ok: false; error: string };

export const NAME_MAX = 120;
const FREE_TEXT_MAX = 40;
export const BUDGET_MAX = 1_000_000_000;
const MAX_CUSTOM_CITIES = 3;

/**
 * Text the customer typed, made safe to store and to show the model: control
 * characters, angle brackets and runs of whitespace go, and the length is capped.
 */
export function cleanUserText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/[<>{}`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** "mystore.com" and "www.mystore.com" are what people type. */
export function normalizeWebsite(raw: unknown): string | null {
  const trimmed = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  const withScheme = SCHEME.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname;
    if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
    if (url.username || url.password) return null;
    if (withScheme.length > 300) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function toLatinDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Accepts 5000, "5,000", "٥٠٠٠"; refuses fractions, negatives and nonsense. */
export function parseAmount(raw: unknown): number | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= BUDGET_MAX ? raw : 'invalid';
  }
  const latin = toLatinDigits(String(raw)).replace(/[,،\s]/g, '');
  if (!/^\d{1,10}$/.test(latin)) return 'invalid';
  const value = Number(latin);
  return value <= BUDGET_MAX ? value : 'invalid';
}

const ids = (options: SetupOption[]) => options.map((option) => option.id);

export function parseAnswer(key: unknown, raw: unknown): ParseResult {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const choice = typeof input.choice === 'string' ? input.choice : '';
  switch (key) {
    case 'type': {
      if (!ids(TYPE_OPTIONS).includes(choice)) return { ok: false, error: 'invalid_choice' };
      if (choice === 'other') {
        const text = cleanUserText(input.text, FREE_TEXT_MAX);
        if (text.length < 2) return { ok: false, error: 'text_required' };
        return { ok: true, answer: { key, choice, text } };
      }
      return { ok: true, answer: { key, choice } };
    }
    case 'name': {
      const text = cleanUserText(input.text, NAME_MAX);
      if (text.length < 2) return { ok: false, error: 'text_required' };
      return { ok: true, answer: { key, text } };
    }
    case 'goal':
      if (!(choice in GOAL_COLUMN)) return { ok: false, error: 'invalid_choice' };
      return { ok: true, answer: { key, choice: choice as keyof typeof GOAL_COLUMN } };
    case 'value':
      if (!(choice in VALUE_RANGES)) return { ok: false, error: 'invalid_choice' };
      return { ok: true, answer: { key, choice } };
    case 'budget': {
      const amount = parseAmount(input.amount);
      if (amount === 'invalid') return { ok: false, error: 'invalid_amount' };
      return { ok: true, answer: { key, amount } };
    }
    case 'regions': {
      if (!ids(REGION_OPTIONS).includes(choice)) return { ok: false, error: 'invalid_choice' };
      if (choice !== 'cities') return { ok: true, answer: { key, choice: choice as 'saudi' | 'gulf', cities: [] } };
      const list = Array.isArray(input.cities) ? input.cities : [];
      const known: string[] = [];
      const custom: string[] = [];
      for (const item of list.slice(0, 20)) {
        const city = cleanUserText(item, 30);
        if (!city) continue;
        if ((CITY_OPTIONS as readonly string[]).includes(city)) {
          if (!known.includes(city)) known.push(city);
        } else if (city.length >= 2 && !custom.includes(city) && custom.length < MAX_CUSTOM_CITIES) {
          custom.push(city);
        }
      }
      const cities = [...known, ...custom];
      if (cities.length === 0) return { ok: false, error: 'cities_required' };
      return { ok: true, answer: { key, choice: 'cities', cities } };
    }
    case 'manager':
      if (!ids(MANAGER_OPTIONS).includes(choice)) return { ok: false, error: 'invalid_choice' };
      return { ok: true, answer: { key, choice } };
    case 'pain':
      if (!ids(PAIN_OPTIONS).includes(choice)) return { ok: false, error: 'invalid_choice' };
      return { ok: true, answer: { key, choice } };
    case 'website': {
      if (choice === 'none' || choice === 'later') return { ok: true, answer: { key, choice } };
      const url = normalizeWebsite(input.url);
      if (!url) return { ok: false, error: 'invalid_website' };
      return { ok: true, answer: { key, choice: 'url', url } };
    }
    default:
      return { ok: false, error: 'invalid_key' };
  }
}

export type MemoryKindForSetup = 'goal' | 'margin' | 'constraint' | 'geo' | 'agency' | 'other';

export type AnswerEffects = {
  /** Columns on `businesses`. Empty when the answer has no column. */
  business: Partial<{
    name: string;
    sector: string;
    primary_goal: string;
    monthly_budget: number;
    target_regions: string[];
    website: string;
  }>;
  fact: { kind: MemoryKindForSetup; fact_ar: string; data: Record<string, unknown> } | null;
};

function optionLabel(options: SetupOption[], id: string) {
  return options.find((option) => option.id === id)?.label ?? id;
}

const GOAL_FACT: Record<keyof typeof GOAL_COLUMN, string> = {
  online_sales: 'أهم نتيجة يبيها من الإعلانات: طلبات شراء من متجره أو موقعه',
  calls: 'أهم نتيجة يبيها من الإعلانات: اتصالات ورسائل واتساب',
  store_visits: 'أهم نتيجة يبيها من الإعلانات: زيارات للمحل أو الفرع',
  site_visits: 'أهم نتيجة يبيها من الإعلانات: زيارات لموقعه يتعرفون فيها عليه',
  awareness: 'أهم نتيجة يبيها من الإعلانات: الناس تعرف اسمه',
};

const MANAGER_FACT: Record<string, string> = {
  self: 'يدير إعلاناته بنفسه',
  agency: 'إعلاناته عند وكالة أو مسوّق من برا',
  employee: 'يدير إعلاناته موظف عنده',
  nobody: 'ما أحد يتابع إعلاناته الحين',
};

const PAIN_FACT: Record<string, string> = {
  few_leads: 'أكثر شي مضايقه: يصرف والطلبات ما تكفي',
  expensive: 'أكثر شي مضايقه: الطلبات تجي بس تكلفتها عالية',
  confusing: 'أكثر شي مضايقه: ما يفهم وش يصير في حسابه',
  grow: 'يبي يكبر ويوصل لناس أكثر',
  unsure: 'ما حدد مشكلة، يبي نقرأ حسابه ونقول له',
};

export function formatAmount(amount: number) {
  return Math.round(amount).toLocaleString('en-US');
}

export function answerEffects(answer: SetupAnswer): AnswerEffects {
  const data = (extra: Record<string, unknown> = {}) => ({ setup_key: answer.key, ...extra });
  switch (answer.key) {
    case 'type': {
      const sector = answer.choice === 'other' ? answer.text ?? '' : optionLabel(TYPE_OPTIONS, answer.choice);
      return {
        business: { sector },
        fact: { kind: 'other', fact_ar: `نوع النشاط: ${sector}`, data: data({ choice: answer.choice }) },
      };
    }
    case 'name':
      return {
        business: { name: answer.text },
        fact: { kind: 'other', fact_ar: `اسم النشاط: ${answer.text}`, data: data() },
      };
    case 'goal':
      return {
        business: { primary_goal: GOAL_COLUMN[answer.choice] },
        fact: { kind: 'goal', fact_ar: GOAL_FACT[answer.choice], data: data({ choice: answer.choice }) },
      };
    case 'value': {
      const range = VALUE_RANGES[answer.choice];
      const fact_ar =
        answer.choice === 'unknown'
          ? 'ما يعرف كم يجيب له العميل الواحد'
          : `العميل الواحد يجيب له تقريباً ${range.text}`;
      return {
        business: {},
        fact: { kind: 'margin', fact_ar, data: data({ choice: answer.choice, min_sar: range.min, max_sar: range.max }) },
      };
    }
    case 'budget':
      if (answer.amount === null) {
        return { business: {}, fact: { kind: 'constraint', fact_ar: 'ما حدد كم يبي يصرف بالشهر', data: data({ amount: null }) } };
      }
      return {
        business: { monthly_budget: answer.amount },
        fact: {
          kind: 'constraint',
          fact_ar: `يبي يصرف على إعلانات قوقل قرابة ${formatAmount(answer.amount)} ريال بالشهر`,
          data: data({ amount: answer.amount }),
        },
      };
    case 'regions': {
      const regions =
        answer.choice === 'saudi' ? ['السعودية'] : answer.choice === 'gulf' ? ['السعودية', 'دول الخليج'] : answer.cities;
      const fact_ar =
        answer.choice === 'saudi'
          ? 'عملاؤه في كل السعودية'
          : answer.choice === 'gulf'
            ? 'عملاؤه في السعودية والخليج'
            : `عملاؤه في: ${answer.cities.join('، ')}`;
      return { business: { target_regions: regions }, fact: { kind: 'geo', fact_ar, data: data({ choice: answer.choice, regions }) } };
    }
    case 'manager':
      return {
        business: {},
        fact: { kind: 'agency', fact_ar: MANAGER_FACT[answer.choice], data: data({ choice: answer.choice }) },
      };
    case 'pain':
      return {
        business: {},
        fact: { kind: 'goal', fact_ar: PAIN_FACT[answer.choice], data: data({ choice: answer.choice }) },
      };
    case 'website':
      if (answer.choice === 'url' && answer.url) {
        return {
          business: { website: answer.url },
          fact: { kind: 'other', fact_ar: `موقعه: ${answer.url.replace(/^https?:\/\//, '')}`, data: data({ choice: 'url' }) },
        };
      }
      return {
        business: {},
        fact: {
          kind: 'other',
          fact_ar: answer.choice === 'none' ? 'ما عنده موقع إلكتروني' : 'بيعطينا رابط موقعه بعدين',
          data: data({ choice: answer.choice }),
        },
      };
  }
}

/** What the customer's own bubble says after they answer. */
export function answerLabel(answer: SetupAnswer): string {
  switch (answer.key) {
    case 'type':
      return answer.choice === 'other' ? answer.text ?? '' : optionLabel(TYPE_OPTIONS, answer.choice);
    case 'name':
      return answer.text;
    case 'goal':
      return optionLabel(GOAL_OPTIONS, answer.choice);
    case 'value':
      return optionLabel(VALUE_OPTIONS, answer.choice);
    case 'budget':
      return answer.amount === null ? 'ما أدري' : `${formatAmount(answer.amount)} ريال بالشهر`;
    case 'regions':
      return answer.choice === 'cities' ? answer.cities.join('، ') : optionLabel(REGION_OPTIONS, answer.choice);
    case 'manager':
      return optionLabel(MANAGER_OPTIONS, answer.choice);
    case 'pain':
      return optionLabel(PAIN_OPTIONS, answer.choice);
    case 'website':
      return answer.choice === 'url' && answer.url
        ? answer.url.replace(/^https?:\/\//, '')
        : answer.choice === 'none'
          ? 'ما عندي موقع'
          : 'بكتبه بعدين';
  }
}

/**
 * A short line «زياد» says back after some answers, so the chat answers you
 * instead of only asking. Most answers get none on purpose.
 */
export function reactionTo(answer: SetupAnswer): string | null {
  switch (answer.key) {
    case 'goal':
      if (answer.choice === 'calls') return 'تمام، كل ريال بحسبه على الاتصالات والواتساب اللي يجيبها.';
      if (answer.choice === 'online_sales') return 'تمام، بحكم على كل حملة بالطلبات اللي تجيبها مو بالضغطات.';
      if (answer.choice === 'store_visits') return 'تمام، بركز على الناس اللي قريبين منك.';
      return null;
    case 'value':
      return answer.choice === 'unknown'
        ? 'ولا يهمك، نقدّره مع الوقت من أرقامك.'
        : 'زين. كذا أقول لك إذا الطلب يجيك بربح أو بخسارة.';
    case 'manager':
      if (answer.choice === 'agency') return 'ولا يهمك، أقرأ وأجهز وأنت تقرر، وما ألمس شي بدون موافقتك.';
      if (answer.choice === 'nobody') return 'من اليوم أنا أتابعها معك كل يوم.';
      return null;
    case 'pain':
      if (answer.choice === 'few_leads' || answer.choice === 'expensive') return 'هذا أول شي بدوّر عليه في حسابك.';
      if (answer.choice === 'confusing') return 'ولا يهمك، بكلمك بالعربي بدون مصطلحات.';
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Budget choices built from the account's real spend
// ---------------------------------------------------------------------------

/** 4,320 → 4,300; 12,480 → 12,000; 870 → 850. Readable numbers, not fake precision. */
export function niceAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value < 1000) return Math.max(50, Math.round(value / 50) * 50);
  if (value < 10_000) return Math.round(value / 100) * 100;
  if (value < 100_000) return Math.round(value / 1000) * 1000;
  return Math.round(value / 10_000) * 10_000;
}

export type BudgetChoice = { id: string; label: string; hint?: string; amount: number | null; icon?: IconKey };

/**
 * With a known 30-day spend in riyals the question offers the same, less and
 * more around it. Without one (no spend, unknown, another currency) it offers
 * plain bands. «أكتب رقم» is handled by the screen.
 */
export function budgetChoices(spend30: number | null, currency: string | null): BudgetChoice[] {
  const sar = !currency || currency.toUpperCase() === 'SAR';
  if (sar && spend30 !== null && Number.isFinite(spend30) && spend30 >= 300) {
    const same = niceAmount(spend30);
    const less = niceAmount(spend30 * 0.7);
    const more = niceAmount(spend30 * 1.5);
    return [
      { id: 'same', label: `نفسه تقريباً، ${formatAmount(same)} ريال`, amount: same },
      { id: 'less', label: `أقل، ${formatAmount(less)} ريال`, amount: less },
      { id: 'more', label: `أكثر، ${formatAmount(more)} ريال`, amount: more },
      { id: 'unknown', label: 'ما أدري، اقترح أنت', amount: null, icon: 'help' },
    ];
  }
  return [
    { id: 'b1', label: 'أقل من 3,000 ريال', amount: 2000 },
    { id: 'b2', label: 'من 3,000 إلى 10,000 ريال', amount: 6000 },
    { id: 'b3', label: 'من 10,000 إلى 30,000 ريال', amount: 20000 },
    { id: 'b4', label: 'أكثر من 30,000 ريال', amount: 40000 },
    { id: 'unknown', label: 'ما أدري، اقترح أنت', amount: null, icon: 'help' },
  ];
}

// ---------------------------------------------------------------------------
// Which questions are left
// ---------------------------------------------------------------------------

export type BusinessProfile = {
  name?: string | null;
  sector?: string | null;
  website?: string | null;
  monthly_budget?: number | null;
  target_regions?: string[] | null;
};

/**
 * Keys a business already answers through the old six-field form. A customer
 * who filled it is never asked the same thing twice. A business made by the
 * Google callback (name from the login, no sector) answers nothing.
 */
export function keysAnsweredByProfile(business: BusinessProfile | null): SetupKey[] {
  if (!business) return [];
  const keys: SetupKey[] = [];
  const filledOldForm = Boolean(business.sector && business.sector.trim());
  if (filledOldForm) keys.push('type', 'name', 'goal');
  if ((business.monthly_budget ?? 0) > 0) keys.push('budget');
  if ((business.target_regions ?? []).some((region) => region && region.trim())) keys.push('regions');
  if (business.website && business.website.trim()) keys.push('website');
  return keys;
}

export function pendingKeys(args: {
  answered: Iterable<SetupKey>;
  consentAnswered: boolean;
  /** Edit mode asks every question again, current values marked. */
  edit?: boolean;
}): SetupKey[] {
  const done = new Set(args.answered);
  return SETUP_KEYS.filter((key) => {
    if (key === 'consent') return !args.consentAnswered;
    if (args.edit) return true;
    return !done.has(key);
  });
}

export function missingCoreKeys(answered: Iterable<SetupKey>): SetupKey[] {
  const done = new Set(answered);
  return CORE_KEYS.filter((key) => !done.has(key));
}

export function isSetupKey(value: unknown): value is SetupKey {
  return typeof value === 'string' && (SETUP_KEYS as readonly string[]).includes(value);
}
