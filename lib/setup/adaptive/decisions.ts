import { cleanUserText } from '../questions';
import { CALL_HOURS_WINDOWS } from './answers';
import { focusLabel } from './focus';
import {
  NOUNS,
  answeredChoice,
  campaignTotals,
  countPhrase,
  hourPhrase,
  joinAnd,
  money,
  sigValue,
  trustedKind,
} from './shared';
import type { AccountSignals, HourSignal, ProductSignal, Scenario, ScenarioDecision } from './types';

// ---------------------------------------------------------------------------
// Thresholds (the numbers the rules stand on)
// ---------------------------------------------------------------------------

/** Spend outside the answering hours counts when it reaches the larger of this and 10% of the 30-day spend. */
export const CALL_HOURS_MIN_COST = 100;
export const CALL_HOURS_MIN_COST_SHARE = 0.1;
/** Or when this many calls came in while nobody answers. */
export const CALL_HOURS_MIN_CALLS = 5;
/** A product is idle when it spent at least this and sold nothing. */
export const IDLE_PRODUCT_MIN_COST = 50;
/** The idle products together must have spent at least this. */
export const IDLE_PRODUCTS_MIN_TOTAL = 200;

// ---------------------------------------------------------------------------
// call_hours: ad hours against answering hours
// ---------------------------------------------------------------------------

function openHours(choice: string): boolean[] | null {
  const windows = CALL_HOURS_WINDOWS[choice];
  if (!windows) return null;
  const open = Array.from({ length: 24 }, () => false);
  for (const [from, to] of windows) {
    for (let hour = from; hour < to; hour += 1) open[hour % 24] = true;
  }
  return open;
}

/** The longest run of closed hours, going round midnight. Null when the phone is answered all day. */
export function largestClosedStretch(open: boolean[]): { start: number; end: number; length: number } | null {
  const firstOpen = open.indexOf(true);
  if (firstOpen === -1 || !open.includes(false)) return null;
  let best: { start: number; end: number; length: number } | null = null;
  let runStart = 0;
  let run = 0;
  for (let step = 1; step <= 24; step += 1) {
    const hour = (firstOpen + step) % 24;
    if (!open[hour]) {
      if (run === 0) runStart = hour;
      run += 1;
    } else if (run > 0) {
      if (!best || run > best.length) best = { start: runStart, end: hour, length: run };
      run = 0;
    }
  }
  return best;
}

const ANSWERING_PHRASE: Record<string, string> = {
  split_9_13_16_22: 'فترتين',
  day_8_23: 'من 8 الصبح لين 11 الليل',
  evening_16_24: 'المسا بس',
};

const LOST_CALL: Record<'clinic' | 'services' | 'local', string> = {
  clinic: 'حجز ضايع',
  services: 'عميل ضايع',
  local: 'زبون ضايع',
};

function callHoursDecision(args: {
  kind: 'clinic' | 'services' | 'local';
  hours: HourSignal[];
  choice: string;
  currency: string;
}): ScenarioDecision | null {
  const open = openHours(args.choice);
  if (!open) return null;
  const stretch = largestClosedStretch(open);
  if (!stretch) return null;

  const byHour = new Map(args.hours.map((row) => [((Math.round(row.hour) % 24) + 24) % 24, row]));
  let total = 0;
  let outsideCost = 0;
  let outsideCalls = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    const row = byHour.get(hour);
    if (!row) continue;
    total += row.cost;
    if (!open[hour]) {
      outsideCost += row.cost;
      outsideCalls += row.phoneCalls;
    }
  }
  const calls = Math.round(outsideCalls);
  const costEnough = outsideCost >= Math.max(CALL_HOURS_MIN_COST, CALL_HOURS_MIN_COST_SHARE * total);
  if (!costEnough && calls < CALL_HOURS_MIN_CALLS) return null;

  const cost = money(outsideCost, args.currency);
  const reason =
    costEnough && calls >= 1
      ? `آخر 30 يوم صرفت ${cost} في ساعات ما أحد يرد فيها، وجاك فيها ${countPhrase(calls, NOUNS.call)}.`
      : costEnough
        ? `آخر 30 يوم صرفت ${cost} في ساعات ما أحد يرد فيها.`
        : `آخر 30 يوم جاك ${countPhrase(calls, NOUNS.call)} في ساعات ما أحد يرد فيها.`;

  const windows = (CALL_HOURS_WINDOWS[args.choice] ?? []).map(([from, to]) => `من ${hourPhrase(from)} لين ${hourPhrase(to)}`);
  const answering = ANSWERING_PHRASE[args.choice] ?? joinAnd(windows);

  return {
    id: 'call_hours',
    title: `وقّف الإعلان من ${hourPhrase(stretch.start)} لين ${hourPhrase(stretch.end)}`,
    reason,
    why: `لأنك قلت إن الرد ${answering}، والاتصال اللي ما ينرد عليه ${LOST_CALL[args.kind]}.`,
    steps: [
      'افتح حسابك في قوقل أدس وادخل على الحملات اللي تجيب الاتصالات.',
      `ادخل على جدولة الإعلانات (Ad schedule) وأضف ساعات الرد بس: ${joinAnd(windows)}.`,
      'احفظ وخل الحملة شغّالة بدون ما تغيّر الميزانية.',
      'بعد أسبوع قارن عدد الاتصالات اللي انردّ عليها وتكلفة الاتصال الواحد.',
    ],
    amount: Math.round(outsideCost),
    currency: args.currency,
  };
}

// ---------------------------------------------------------------------------
// idle_products: spending on products that do not sell
// ---------------------------------------------------------------------------

function idleTitle(count: number): string {
  if (count === 1) return 'أوقف منتج يصرف وما يبيع';
  if (count === 2) return 'أوقف منتجين يصرفون وما يبيعون';
  if (count <= 10) return `أوقف ${count} منتجات تصرف وما تبيع`;
  return `أوقف ${count} منتج تصرف وما تبيع`;
}

const MARGIN_SENTENCE: Record<string, string> = {
  lt20: 'أقل من 20 ريال',
  '20_40': 'من 20 إلى 40 ريال',
  gt40: 'أكثر من 40 ريال',
};

function idleProductsDecision(args: {
  products: ProductSignal[];
  answered: Partial<Record<string, string | null>>;
  currency: string;
}): ScenarioDecision | null {
  const idle = args.products.filter((product) => product.cost30 >= IDLE_PRODUCT_MIN_COST && product.conversions30 <= 0);
  const total = idle.reduce((sum, product) => sum + product.cost30, 0);
  if (idle.length === 0 || total < IDLE_PRODUCTS_MIN_TOTAL) return null;

  const names = [...idle]
    .sort((a, b) => b.cost30 - a.cost30)
    .map((product) => cleanUserText(product.title, 60))
    .filter(Boolean)
    .slice(0, 3);
  const count = idle.length;
  const spent = money(total, args.currency);
  const verbs = count === 1 ? { on: 'عليه', brought: 'جاب' } : count === 2 ? { on: 'عليهم', brought: 'جابوا' } : { on: 'عليها', brought: 'جابت' };
  const reason = `${countPhrase(count, NOUNS.product)} صرفت ${verbs.on} ${spent} آخر 30 يوم وما ${verbs.brought} ولا طلب${names.length > 0 ? `. الأكثر صرفاً: ${joinAnd(names)}` : ''}.`;

  const margin = answeredChoice(args.answered, 'margin');
  const pain = answeredChoice(args.answered, 'pain');
  let why: string;
  if (margin && MARGIN_SENTENCE[margin]) {
    why = `لأنك قلت إن اللي يتبقى لك من كل 100 ريال ${MARGIN_SENTENCE[margin]}، وكل ريال يروح على منتج ما يبيع ياكل من ربحك مباشرة.`;
  } else if (pain === 'shop_profit_eaten') {
    why = 'لأنك قلت إن الإعلان ياكل الربح، وهذا أسهل مكان نوقف فيه الصرف الضايع.';
  } else {
    why = 'لأن هذا صرف ما رجع منه طلب في آخر 30 يوم.';
  }

  return {
    id: 'idle_products',
    title: idleTitle(count),
    reason,
    why,
    steps: [
      'افتح الحملة اللي تعلن بمنتجاتك (تسوق أو أداء أقصى) في قوقل أدس.',
      `استبعد هذي المنتجات من مجموعات المنتجات اللي تعلن عنها${names.length > 0 ? `: ${joinAnd(names)}` : ''}.`,
      'لو منتج منها فيه مبيعات من قناة ثانية، راجع صفحته قبل لا توقفه.',
      'بعد أسبوعين قارن عدد الطلبات وتكلفة الطلب.',
    ],
    amount: Math.round(total),
    currency: args.currency,
  };
}

// ---------------------------------------------------------------------------
// tracking_setup: first when the account cannot say what the ads bring
// ---------------------------------------------------------------------------

const TRACKING_WHY: Record<string, string> = {
  tells_me: 'لأنك قلت إن العميل هو اللي يقول لك، وبدون تتبع ما أقدر أقول أي حملة جابته.',
  check_records: 'لأنك تراجع الطلبات بنفسك، والتتبع يخلي قوقل نفسه يعرف أي إعلان جابها فيزيد عليه.',
  dont_know: 'لأنك ما تعرف الحين وش جاب الإعلان، وبدون التتبع كل قرار بعده تخمين.',
};

function trackingSteps(scenario: Scenario, signals: AccountSignals | null): string[] {
  const steps: string[] = [];
  if (scenario.state === 'tracking_suspect') {
    steps.push('افتح التحويلات في حسابك وشوف آخر مرة سجّل فيها أي تحويل، وتأكد إن الوسم مركّب في صفحة التأكيد أو الشكر.');
  }
  if (sigValue(signals?.autoTagging) === false) {
    steps.push('فعّل التوسيم التلقائي (Auto-tagging) من إعدادات الحساب، بدونه قوقل ما يربط الطلب بالإعلان.');
  }

  const kind = trustedKind(scenario);
  if (kind === 'ecommerce') {
    if (scenario.platform === 'salla') {
      steps.push('من لوحة سلة فعّل ربط قوقل وتتبع الطلبات، عندهم ربط جاهز لهذا.');
    } else if (scenario.platform === 'zid') {
      steps.push('من لوحة زد فعّل ربط قوقل وتتبع الطلبات، عندهم ربط جاهز لهذا.');
    } else if (scenario.platform === 'shopify') {
      steps.push('من لوحة شوبيفاي فعّل ربط قوقل الرسمي وتتبع الشراء.');
    } else {
      steps.push('ركّب كود تتبع الشراء في صفحة تأكيد الطلب، أو اطلب ممن بنى متجرك يضيفه.');
    }
    steps.push('سجّل الشراء كهدف تحويل في حسابك الإعلاني، وأضف قيمة الطلب معه.');
    steps.push('سوّ طلب تجريبي وتأكد إنه ظهر في تحويلات حسابك خلال ساعات.');
  } else if (kind === 'clinic' || kind === 'services') {
    steps.push('سجّل الاتصال من الإعلان كهدف تحويل في حسابك، وفعّل إضافة الاتصال لو ما هي شغالة.');
    steps.push('سجّل ضغطة زر الواتساب والاتصال في موقعك كهدف تحويل.');
    steps.push('لو عندك نموذج، سجّل إرساله كهدف تحويل.');
    steps.push('جرّب كل واحد بنفسك وتأكد إنه ظهر في حسابك خلال ساعات.');
  } else if (kind === 'local') {
    steps.push('سجّل الاتصال وطلب الاتجاهات كأهداف تحويل في حسابك.');
    steps.push('فعّل إضافة الموقع لو ما هي شغالة.');
    steps.push('جرّب كل واحد بنفسك وتأكد إنه ظهر في حسابك خلال ساعات.');
  } else {
    steps.push('حدد وش النتيجة اللي تهمك: اتصال أو طلب أو نموذج.');
    steps.push('سجّلها كهدف تحويل في حسابك الإعلاني.');
    steps.push('جرّبها بنفسك وتأكد إنها ظهرت في حسابك خلال ساعات.');
  }
  return steps;
}

function trackingDecision(args: { scenario: Scenario; signals: AccountSignals | null; answered: Partial<Record<string, string | null>>; currency: string }): ScenarioDecision {
  const { scenario, signals, answered, currency } = args;
  const campaigns = sigValue(signals?.campaigns) ?? [];
  const totals = campaignTotals(campaigns);
  const spend = money(totals.cost, currency);
  const suspect = scenario.state === 'tracking_suspect';
  const choice = answeredChoice(answered, 'tracking_now');

  return {
    id: 'tracking_setup',
    title: suspect ? 'راجع التتبع، ما سجّل ولا نتيجة' : 'ركّب تتبع النتائج قبل أي تعديل',
    reason: suspect
      ? `فيه تتبع مفعّل بس ما سجّل ولا نتيجة من ${countPhrase(totals.clicks, NOUNS.click)}، وصرفت ${spend} آخر 30 يوم.`
      : `آخر 30 يوم صرفت ${spend} وما فيه أي تتبع مفعّل يقول لنا وش جاب الإعلان.`,
    why: (choice && TRACKING_WHY[choice]) || 'لأن أي قرار بعده بدون التتبع تخمين.',
    steps: trackingSteps(scenario, signals),
    amount: null,
    currency,
  };
}

/**
 * CONTRACT (part B): a first decision the rules can stand behind, or null.
 * call_hours (clinic, services, local) needs signals.hours and the call_hours
 * answer; idle_products (ecommerce) needs signals.products; tracking_setup
 * comes first for no_tracking and tracking_suspect.
 */
export function scenarioDecision(args: {
  scenario: Scenario;
  signals: AccountSignals | null;
  answered: Partial<Record<string, string | null>>;
  currency: string;
}): ScenarioDecision | null {
  const { scenario, signals, answered, currency } = args;
  if (scenario.state === 'no_tracking' || scenario.state === 'tracking_suspect') return trackingDecision(args);
  if (scenario.state !== 'active') return null;

  const kind = trustedKind(scenario);
  if (kind === 'clinic' || kind === 'services' || kind === 'local') {
    const hours = sigValue(signals?.hours);
    const choice = answeredChoice(answered, 'call_hours');
    if (!hours || !choice) return null;
    return callHoursDecision({ kind, hours, choice, currency });
  }
  if (kind === 'ecommerce') {
    const products = sigValue(signals?.products);
    if (!products) return null;
    return idleProductsDecision({ products, answered, currency });
  }
  return null;
}

// ---------------------------------------------------------------------------
// planReason: «ليش أول شي» for a decision the audit found
// ---------------------------------------------------------------------------

/** How each audit category touches the customer's account, in a few words. */
const CATEGORY_TOUCHES: Record<string, string> = {
  keywords: 'الكلمات اللي تطلع فيها إعلاناتك',
  ads: 'نص إعلاناتك',
  targeting: 'مين ووين يشوف إعلانك',
  budget: 'كم يروح من فلوسك وعلى أي حملة',
  bidding: 'كم تدفع على كل نقرة',
  structure: 'كيف موزعة حملاتك',
};

type PainGroup = { said: string; categories: string[] };

const FEW: PainGroup = { said: 'الطلبات ما تكفي', categories: ['keywords', 'ads', 'targeting', 'budget', 'structure'] };
const PRICEY: PainGroup = { said: 'الطلب يجي بس غالي', categories: ['bidding', 'keywords', 'budget', 'targeting'] };
const SHOPPERS: PainGroup = { said: 'يسألون عن السعر وما يشترون', categories: ['keywords', 'ads', 'targeting'] };

const PAIN_GROUPS: Record<string, PainGroup> = {
  few_leads: FEW,
  expensive: PRICEY,
  grow: { said: 'أبي أكبر', categories: ['budget', 'structure'] },
  shop_few_orders: { said: 'الطلبات قليلة', categories: FEW.categories },
  shop_profit_eaten: { said: 'الإعلان ياكل الربح', categories: PRICEY.categories },
  clinic_few_calls: { said: 'الاتصالات قليلة', categories: FEW.categories },
  clinic_price_shoppers: { said: 'يتصلون يسألون عن السعر وما يحجزون', categories: SHOPPERS.categories },
  clinic_costly_booking: { said: 'الحجز يجي بس غالي', categories: PRICEY.categories },
  svc_few_calls: { said: 'الاتصالات قليلة', categories: FEW.categories },
  svc_price_ghosts: { said: 'يسألون عن السعر ويختفون', categories: SHOPPERS.categories },
  svc_wrong_calls: { said: 'يتصلون ناس ما يبون الخدمة', categories: ['keywords', 'targeting', 'ads'] },
};

/** Categories where the service the customer wants to grow changes the decision. */
const FOCUS_CATEGORIES = ['budget', 'structure', 'keywords'];

/**
 * CONTRACT (part B): «ليش أول شي» for an audit decision, tied to what the
 * customer said. It connects the answer to the decision only where the
 * decision's category really touches it; otherwise null.
 */
export function planReason(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  decision: { title: string; category: string | null };
}): string | null {
  const category = args.decision.category ? args.decision.category.trim().toLowerCase() : null;
  if (!category || !CATEGORY_TOUCHES[category]) return null;
  const touches = CATEGORY_TOUCHES[category];

  const painChoice = answeredChoice(args.answered, 'pain');
  const pain = painChoice ? PAIN_GROUPS[painChoice] : undefined;
  if (pain && pain.categories.includes(category)) {
    return `لأنك قلت «${pain.said}»، وهالقرار يمس ${touches}.`;
  }

  const focusChoice = answeredChoice(args.answered, 'focus_service');
  if (focusChoice && focusChoice !== 'all' && FOCUS_CATEGORIES.includes(category)) {
    const label = args.labels.focus_service?.trim() || focusLabel(focusChoice);
    if (label) return `لأنك تبي طلب أكثر على «${label}»، وهالقرار يمس ${touches}.`;
  }
  return null;
}
