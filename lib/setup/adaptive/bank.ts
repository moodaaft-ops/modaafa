import {
  KIND_GOAL_OPTIONS,
  KIND_PAIN_OPTIONS,
  MANAGER_OPTIONS,
  TYPE_OPTIONS,
  VALUE_OPTIONS,
  cleanUserText,
  formatAmount,
  type KindWordingKey,
  type SetupKey,
  type SetupOption,
} from '../questions';
import {
  AOV_CHECK_OPTIONS,
  CALL_HOURS_OPTIONS,
  CLOSE_RATE_OPTIONS,
  CONFIRM_OPTIONS,
  DEAL_VALUE_OPTIONS,
  DELIVERY_APPS_OPTIONS,
  EXCLUDE_PRODUCTS_OPTIONS,
  MARGIN_OPTIONS,
  PEAK_HOURS_OPTIONS,
  PUSH_NONE_ID,
  PRODUCT_TEXT_MAX,
  TRACKING_NOW_OPTIONS,
  WHATSAPP_BOOKING_OPTIONS,
} from './answers';
import {
  FOCUS_ALL_ID,
  FOCUS_ALL_LABEL,
  FOCUS_TEXT_MAX,
  focusEntriesForGroup,
  focusGroupFor,
  matchFocusEntries,
  type FocusGroup,
} from './focus';
import { buildOpener } from './opener';
import {
  answeredChoice,
  averageOrder,
  currencyWord,
  hasEvidence,
  isAnswered,
  sigValue,
  trustedKind,
} from './shared';
import type {
  AccountSignals,
  AdaptiveOption,
  AdaptiveQuestion,
  BusinessKind,
  QuestionContext,
  Scenario,
} from './types';

// ---------------------------------------------------------------------------
// Which questions are left
// ---------------------------------------------------------------------------

/** What the questions of a kind are, after the opener and before the shared tail. */
const KIND_CORE: Record<Exclude<BusinessKind, 'general' | 'ecommerce'>, SetupKey[]> = {
  clinic: ['focus_service', 'value', 'pain', 'call_hours', 'whatsapp_booking'],
  services: ['focus_service', 'deal_value', 'close_rate', 'pain'],
  local: ['goal', 'peak_hours', 'value', 'delivery_apps'],
};

/** The questions for no account, a new account and a dormant one: what they sell and to whom, never the pain. */
const FRESH_KEYS: SetupKey[] = ['type', 'focus_service', 'regions', 'goal', 'budget', 'website'];

/**
 * The full ordered list of questions that belong to this scenario, before
 * anything the customer already answered is taken out. What the account can
 * answer itself (places, hosts, who edits) is left out only when it was read.
 */
function scenarioKeys(args: { scenario: Scenario; answered: Partial<Record<string, string | null>>; hasAccount: boolean }): SetupKey[] {
  const { scenario, answered } = args;
  if (!args.hasAccount || scenario.state === 'no_account') return [...FRESH_KEYS];

  const suspected = scenario.managed === 'suspected';
  if (scenario.state === 'new' || scenario.state === 'dormant') return suspected ? ['manager', ...FRESH_KEYS] : [...FRESH_KEYS];

  const tracking = scenario.state === 'no_tracking' || scenario.state === 'tracking_suspect';
  const consent = scenario.managed !== 'confirmed';
  // None because nobody else showed up in the read, or none because nothing was read.
  const managerUnread = scenario.managed === 'none' && !hasEvidence(scenario, 'mgr_read');
  const kind = trustedKind(scenario);
  const keys: SetupKey[] = [];

  if (kind === 'general') {
    if (suspected) keys.push('manager');
    keys.push('type');
    // With a read there is an account name to propose; without one we ask everything, as the old flow does.
    if (!hasEvidence(scenario, 'read')) keys.push('name');
    keys.push('goal', 'value');
    if (tracking) keys.push('tracking_now');
    keys.push('budget');
    if (!hasEvidence(scenario, 'places')) keys.push('regions');
    if (managerUnread) keys.push('manager');
    keys.push('pain');
    if (!hasEvidence(scenario, 'hosts')) keys.push('website');
    if (consent) keys.push('consent');
    return keys;
  }

  if (scenario.kindConfidence === 'confident') keys.push('confirm');
  if (suspected) keys.push('manager');

  // The «yes» on the opener writes the goal when the account showed one; otherwise the goal is still ours to ask.
  const confirmChoice = answeredChoice(answered, 'confirm');
  const outcomeKnown = scenario.outcome !== 'unknown';
  const goalCovered =
    confirmChoice === 'yes' ? outcomeKnown : scenario.kindConfidence === 'confident' && !isAnswered(answered, 'confirm') && outcomeKnown;
  if (kind !== 'local' && !goalCovered) keys.push('goal');

  if (kind === 'ecommerce') {
    // The average order the account reports replaces the plain «كم متوسط الطلب» when it can be computed.
    keys.push(hasEvidence(scenario, 'aov') ? 'aov_check' : 'value', 'margin', 'push_products', 'exclude_products', 'pain');
  } else {
    keys.push(...KIND_CORE[kind]);
  }

  if (!hasEvidence(scenario, 'places')) keys.push('regions');
  if (managerUnread) keys.push('manager');
  if (!hasEvidence(scenario, 'hosts')) keys.push('website');
  if (tracking) keys.push('tracking_now');
  keys.push('budget');
  if (consent) keys.push('consent');
  return keys;
}

/**
 * CONTRACT (part B): which questions are left for this scenario, in order.
 * Mixes legacy keys (type, goal, value, budget, regions, manager, pain,
 * website, name, consent) with adaptive ones. Never asks a key whose answer is
 * on record or readable from the account, except in edit mode.
 */
export function adaptivePending(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  consentAnswered: boolean;
  edit: boolean;
  /** False when nothing is linked (no_account): consent and anything needing an account are skipped. */
  hasAccount: boolean;
}): SetupKey[] {
  const { scenario, answered, consentAnswered, edit } = args;
  const keys = scenarioKeys({ scenario, answered, hasAccount: args.hasAccount });

  // Someone who named who manages the account can change that answer while editing.
  if (edit && isAnswered(answered, 'manager') && !keys.includes('manager')) {
    const at = keys[0] === 'confirm' ? 1 : 0;
    keys.splice(at, 0, 'manager');
  }

  return keys.filter((key, index) => {
    if (keys.indexOf(key) !== index) return false;
    if (key === 'consent') return !consentAnswered;
    if (edit) return key !== 'confirm' && key !== 'has_account';
    if (key === 'aov_check' && isAnswered(answered, 'value')) return false;
    if (key === 'value' && isAnswered(answered, 'aov_check')) return false;
    return !isAnswered(answered, key);
  });
}

// ---------------------------------------------------------------------------
// The copy and options of one question
// ---------------------------------------------------------------------------

const toAdaptive = (options: readonly AdaptiveOption[]): AdaptiveOption[] =>
  options.map(({ id, label, hint, icon }) => ({ id, label, ...(hint ? { hint } : {}), ...(icon ? { icon } : {}) }));

const KIND_TYPE_IDS: Record<BusinessKind, string[]> = {
  ecommerce: ['ecommerce'],
  clinic: ['clinic'],
  services: ['services', 'real_estate'],
  local: ['local_store', 'restaurant'],
  general: [],
};

/** The type question with the account's best guess first, or with a rejected guess pushed down. Null when there is no guess to use. */
function typeQuestion(ctx: QuestionContext): AdaptiveQuestion | null {
  const { scenario } = ctx;
  if (scenario.kindConfidence === 'stated') return null;
  const rejected = answeredChoice(ctx.answered, 'confirm') === 'no' && scenario.kind !== 'general' ? scenario.kind : null;
  const guessed = scenario.kindConfidence === 'guess';
  if (!guessed && !rejected) return null;

  const order: string[] = [];
  for (const kind of scenario.kindRanking) {
    if (kind === rejected) continue;
    for (const id of KIND_TYPE_IDS[kind]) if (!order.includes(id)) order.push(id);
  }
  for (const option of TYPE_OPTIONS) if (option.id !== 'other' && !order.includes(option.id) && !(rejected && KIND_TYPE_IDS[rejected].includes(option.id))) order.push(option.id);
  if (rejected) for (const id of KIND_TYPE_IDS[rejected]) order.push(id);
  order.push('other');

  const options = order
    .map((id) => TYPE_OPTIONS.find((option) => option.id === id))
    .filter((option): option is SetupOption => Boolean(option))
    .map<AdaptiveOption>((option, index) => ({
      id: option.id,
      label: option.label,
      ...(option.icon ? { icon: option.icon } : {}),
      ...(guessed && index === 0 ? { hint: 'أقرب شي لحسابك' } : {}),
    }));
  return {
    key: 'type',
    text: 'وش نوع نشاطك؟',
    why: 'عشان أقارن حسابك بأنشطة تشبهك.',
    options,
    layout: 'tiles2',
    freeText: { placeholder: 'مثلاً: ورشة سيارات', maxLength: 40 },
    current: ctx.edit ? ctx.answered.type ?? null : null,
  };
}

const FOCUS_PLACEHOLDER: Record<FocusGroup, string> = {
  dental: 'مثلاً: تقويم شفاف',
  derma: 'مثلاً: تقشير',
  clinic: 'مثلاً: علاج طبيعي',
  services: 'مثلاً: تركيب سيراميك',
  ecommerce: 'مثلاً: ساعات',
  local: 'مثلاً: بوفيه',
  general: 'مثلاً: دورات تدريب',
};

function focusQuestion(ctx: QuestionContext): AdaptiveQuestion {
  const { scenario, signals } = ctx;
  const group = focusGroupFor(scenario);
  const fresh = scenario.state === 'new' || scenario.state === 'dormant' || scenario.state === 'no_account';
  const names = (sigValue(signals?.campaigns) ?? []).map((campaign) => campaign.name);
  const entries = focusEntriesForGroup(group);
  const matched = matchFocusEntries(group, names);
  const ordered = [...matched, ...entries.filter((entry) => !matched.includes(entry))];
  const limit = Math.max(6, Math.min(matched.length, 8));
  const shown = ordered.slice(0, limit);

  const options: AdaptiveOption[] = shown.map((entry) => ({
    id: entry.id,
    label: entry.label,
    ...(matched.includes(entry) ? { hint: 'من حملاتك' } : {}),
  }));
  if (group !== 'general') options.push({ id: FOCUS_ALL_ID, label: FOCUS_ALL_LABEL });

  const kind = trustedKind(scenario);
  let text: string;
  if (kind === 'clinic') text = 'وش الخدمة اللي تبي تكثر حجوزاتها؟';
  else if (kind === 'services') text = fresh ? 'وش الخدمة اللي تبي تجيب لها عملاء؟' : 'وش الخدمة اللي تبي تكثر طلبها؟';
  else if (kind === 'local') text = 'وش نوع نشاطك بالضبط؟';
  else text = 'وش تبيع بالضبط؟';
  const why = fresh ? 'أبني أول حملة على اللي يهمك.' : 'أوجّه أغلب الميزانية لها.';

  return {
    key: 'focus_service',
    text,
    why,
    options,
    layout: options.length > 4 ? 'tiles2' : 'tiles',
    freeText: { placeholder: FOCUS_PLACEHOLDER[group], maxLength: FOCUS_TEXT_MAX },
    current: ctx.edit ? ctx.answered.focus_service ?? null : null,
  };
}

/** The top products by cost the account reports, as the chips the customer picks from. Ids are p_<index>. */
export function pushProductChoices(signals: AccountSignals | null): Array<{ id: string; title: string }> {
  const products = sigValue(signals?.products);
  if (!products) return [];
  return [...products]
    .sort((a, b) => b.cost30 - a.cost30)
    .map((product) => cleanUserText(product.title, 60))
    .filter(Boolean)
    .slice(0, 6)
    .map((title, index) => ({ id: `p_${index}`, title }));
}

function managerQuestion(ctx: QuestionContext): AdaptiveQuestion | null {
  const { scenario } = ctx;
  if (scenario.managed !== 'suspected') return null;
  const link = hasEvidence(scenario, 'mgr:link');
  const editors = hasEvidence(scenario, 'mgr:editors');
  let text: string;
  if (link && editors) text = 'شفت إن حسابك مربوط بحساب إدارة من برا، وإن فيه أحد يعدّل فيه آخر أسبوعين. مين هو؟';
  else if (link) text = 'شفت إن حسابك مربوط بحساب إدارة من برا. مين يديره؟';
  else text = 'شفت إن فيه أحد ثاني يعدّل في حسابك آخر أسبوعين. مين هو؟';
  const wanted = ['agency', 'employee', 'self'];
  return {
    key: 'manager',
    text,
    why: 'ما أبي أغيّر شي يلخبط شغل أحد.',
    options: toAdaptive(wanted.map((id) => MANAGER_OPTIONS.find((option) => option.id === id)).filter((o): o is SetupOption => Boolean(o))),
    layout: 'tiles',
    current: ctx.edit ? ctx.answered.manager ?? null : null,
  };
}

function kindWording(kind: BusinessKind): KindWordingKey | null {
  return kind === 'general' ? null : kind;
}

/**
 * CONTRACT (part B): the copy and options for one key in this scenario.
 * Null means the legacy copy and dock are right for it as they are.
 */
export function adaptiveQuestion(key: SetupKey, ctx: QuestionContext): AdaptiveQuestion | null {
  const { scenario, signals, answered } = ctx;
  const kind = trustedKind(scenario);
  const wording = kindWording(kind);
  const current = ctx.edit ? answered[key] ?? null : null;
  const currency = signals?.currency ?? 'SAR';

  switch (key) {
    case 'type':
      return typeQuestion(ctx);

    case 'confirm': {
      const opener = buildOpener(scenario, signals, { firstName: null });
      return { key, text: opener?.ask ?? 'صح كذا؟', options: toAdaptive(CONFIRM_OPTIONS), layout: 'tiles' };
    }

    case 'manager':
      return managerQuestion(ctx);

    case 'focus_service':
      return focusQuestion(ctx);

    case 'value':
      if (kind === 'clinic') {
        return { key, text: 'كم يدفع المريض تقريباً في أول زيارة؟', why: 'عشان أحكم على تكلفة الحجز صح.', options: toAdaptive(VALUE_OPTIONS), layout: 'tiles', current };
      }
      if (kind === 'ecommerce') {
        return { key, text: 'كم متوسط الطلب عندك تقريباً؟', why: 'عشان أحكم على تكلفة الطلب صح.', options: toAdaptive(VALUE_OPTIONS), layout: 'tiles', current };
      }
      if (kind === 'local') {
        return { key, text: 'كم متوسط الفاتورة؟', why: 'عشان أحكم على تكلفة الزبون صح.', options: toAdaptive(VALUE_OPTIONS), layout: 'tiles', current };
      }
      return null;

    case 'goal':
      if (!wording) return null;
      return {
        key,
        text: wording === 'local' ? 'وش أهم نتيجة تبيها من الإعلان؟' : 'متى تقول إن الإعلان نجح؟',
        why: 'على هذا بحسب كل ريال تصرفه.',
        options: toAdaptive(KIND_GOAL_OPTIONS[wording]),
        layout: 'tiles',
        current,
      };

    case 'pain':
      if (wording !== 'ecommerce' && wording !== 'clinic' && wording !== 'services') return null;
      return {
        key,
        text: 'وش أكثر شي مضايقك في إعلاناتك؟',
        why: 'أبدأ بالشي اللي يوجعك.',
        options: toAdaptive(KIND_PAIN_OPTIONS[wording]),
        layout: 'tiles',
        current,
      };

    case 'aov_check': {
      const average = averageOrder(signals);
      if (average === null) return null;
      return {
        key,
        text: `متوسط طلبك من قوقل طلع قرابة ${formatAmount(average)} ${currencyWord(currency)}. قريب من الصح؟`,
        why: 'قوقل يحسبه من الطلبات اللي سجّلها آخر 30 يوم.',
        options: toAdaptive(AOV_CHECK_OPTIONS),
        layout: 'tiles',
        current,
      };
    }

    case 'margin':
      return {
        key,
        text: 'من كل 100 ريال تبيعها، كم يتبقى لك بعد تكلفة المنتج والشحن؟',
        why: 'عشان أعرف متى الإعلان يربحك ومتى ياكل ربحك.',
        options: toAdaptive(MARGIN_OPTIONS),
        layout: 'tiles',
        current,
      };

    case 'push_products': {
      const chips = pushProductChoices(signals);
      return {
        key,
        text: 'فيه منتجات تبيها تبيع أكثر؟',
        why: 'أعطيها أولوية في الصرف.',
        options: [...chips.map((chip) => ({ id: chip.id, label: chip.title })), { id: PUSH_NONE_ID, label: 'لا، كلها سوا' }],
        layout: 'chips',
        freeText: { placeholder: chips.length > 0 ? 'أو اكتب اسم المنتج' : 'اكتب اسم المنتج اللي تبيه يبيع أكثر', maxLength: PRODUCT_TEXT_MAX },
        current,
      };
    }

    case 'exclude_products':
      return {
        key,
        text: 'فيه منتجات ما تبيها تطلع في الإعلانات؟',
        why: 'ما أصرف عليها.',
        options: toAdaptive(EXCLUDE_PRODUCTS_OPTIONS.filter((option) => option.id !== 'text')),
        layout: 'tiles',
        freeText: { placeholder: 'أو اكتب اسم المنتج', maxLength: PRODUCT_TEXT_MAX },
        current,
      };

    case 'call_hours': {
      const wording2 =
        kind === 'services'
          ? { text: 'متى أحد يرد على اتصالات العملاء؟', why: 'الاتصال اللي ما ينرد عليه عميل ضايع.' }
          : kind === 'local'
            ? { text: 'متى أحد يرد على اتصالات الفرع؟', why: 'الاتصال اللي ما ينرد عليه زبون ضايع.' }
            : kind === 'clinic'
              ? { text: 'متى أحد يرد على اتصالات العيادة؟', why: 'الاتصال اللي ما ينرد عليه حجز ضايع.' }
              : { text: 'متى أحد يرد على الاتصالات؟', why: 'الاتصال اللي ما ينرد عليه فرصة ضايعة.' };
      return { key, ...wording2, options: toAdaptive(CALL_HOURS_OPTIONS), layout: 'tiles', current };
    }

    case 'whatsapp_booking':
      return {
        key,
        text: 'فيه واتساب للحجز؟',
        why: 'أعرف وين أوجّه اللي يبي يحجز.',
        options: toAdaptive(WHATSAPP_BOOKING_OPTIONS),
        layout: 'tiles',
        current,
      };

    case 'deal_value':
      return {
        key,
        text: 'كم تسوى لك الصفقة الواحدة تقريباً؟',
        why: 'أعرف كم أقدر أصرف على العميل الواحد.',
        options: toAdaptive(DEAL_VALUE_OPTIONS),
        layout: 'tiles',
        current,
      };

    case 'close_rate':
      return {
        key,
        text: 'من كل 10 يتواصلون معك، كم يصيرون عملاء؟',
        why: 'مع جواب الصفقة أعرف كم يسوى لك الاتصال الواحد.',
        options: toAdaptive(CLOSE_RATE_OPTIONS),
        layout: 'tiles',
        current,
      };

    case 'peak_hours':
      return {
        key,
        text: 'متى ذروتك؟',
        why: 'أركّز الإعلان على وقت زحمتك.',
        options: toAdaptive(PEAK_HOURS_OPTIONS),
        layout: 'chips',
        current,
      };

    case 'delivery_apps':
      return {
        key,
        text: 'موجود في تطبيقات التوصيل؟',
        why: 'أفرّق بين طلب التوصيل وزيارة الفرع.',
        options: toAdaptive(DELIVERY_APPS_OPTIONS),
        layout: 'tiles',
        current,
      };

    case 'tracking_now': {
      const records =
        kind === 'ecommerce' ? 'أشوف الطلبات في المتجر' : kind === 'clinic' ? 'أراجع الحجوزات عندي' : 'أراجع الطلبات والاتصالات عندي';
      return {
        key,
        text: 'كيف تعرف الحين إن الإعلان جاب لك عميل؟',
        why: 'عشان أعرف من وين أبدأ التتبع.',
        options: toAdaptive(TRACKING_NOW_OPTIONS).map((option) => (option.id === 'check_records' ? { ...option, label: records } : option)),
        layout: 'tiles',
        current,
      };
    }

    default:
      return null;
  }
}
