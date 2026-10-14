import {
  FOCUS_ALL_ID,
  FOCUS_OTHER_ID,
  focusEntriesForGroup,
  focusEntryById,
  focusGroupFor,
  focusLabel,
} from './focus';
import { budgetRangeLabel } from '../questions';
import { answeredChoice, hasEvidence, joinAnd, money, trustedKind, withArticle } from './shared';
import type { BusinessKind, FirstCampaignPlan, Scenario } from './types';

/** How many of the focus catalog's entries a plan names when the customer said «كلها بنفس القدر». */
const ALL_FOCUS_NAMED = 2;

/**
 * A store with a linked Merchant Center starts on Standard Shopping, not on
 * Performance Max (google-ads-titan 8.1, 9.1, 21.12): PMax needs a healthy feed
 * AND about 30 conversions a month to learn, and a new account has neither.
 * Standard Shopping lets us control the bids and see which products sell first.
 */
type CampaignType = 'search' | 'shopping_feed';

type FocusRead = {
  /** «التقويم والزراعة», or null when nothing specific was said. */
  topic: string | null;
  /** Search phrases to start from. */
  seeds: string[];
};

/** What the customer wants more of, from the focus_service answer, as words and as first search phrases. */
function readFocus(scenario: Scenario, answered: Partial<Record<string, string | null>>, labels: Partial<Record<string, string>>): FocusRead {
  const choice = answeredChoice(answered, 'focus_service');
  const typed = labels.focus_service?.trim() || null;
  if (choice === FOCUS_OTHER_ID) return typed ? { topic: typed, seeds: [typed] } : { topic: null, seeds: [] };
  if (choice === FOCUS_ALL_ID) {
    const named = focusEntriesForGroup(focusGroupFor(scenario)).slice(0, ALL_FOCUS_NAMED);
    return {
      topic: null,
      seeds: named.flatMap((entry) => entry.seeds.slice(0, 1)),
    };
  }
  if (choice) {
    const entry = focusEntryById(choice);
    const label = typed ?? focusLabel(choice);
    return { topic: label ? withArticle(label) : null, seeds: entry ? [...entry.seeds] : label ? [label] : [] };
  }
  return { topic: null, seeds: [] };
}

const TRACKING_ITEM: Record<BusinessKind, string> = {
  clinic: 'نسجّل الاتصال وضغطة الواتساب وإرسال النموذج قبل لا تشتغل الحملة، عشان نعرف أي إعلان جاب لك مريض.',
  services: 'نسجّل الاتصال وضغطة الواتساب وإرسال النموذج قبل لا تشتغل الحملة، عشان نعرف أي إعلان جاب لك عميل.',
  ecommerce: 'نسجّل الشراء مع قيمة الطلب قبل لا تشتغل الحملة، عشان نعرف أي إعلان جاب لك طلب.',
  local: 'نسجّل الاتصال وطلب الاتجاهات قبل لا تشتغل الحملة، عشان نعرف أي إعلان جاب لك زبون.',
  general: 'نسجّل أهم نتيجة لك قبل لا تشتغل الحملة، عشان نعرف أي إعلان جابها.',
};

const KIND_NAME: Record<BusinessKind, string> = {
  clinic: 'العيادة',
  services: 'الشركة',
  ecommerce: 'المتجر',
  local: 'الفرع',
  general: 'النشاط',
};

function budgetText(monthly: number | null | undefined, currency: string): { line: string; short: string } {
  if (!monthly || monthly <= 0) {
    return {
      line: 'ما حددت ميزانية للحين، وتحددها قبل لا تشتغل الحملة.',
      short: 'تحددها قبل لا تشتغل الحملة',
    };
  }
  // A range tile: say the range, and no daily figure worked out from a number the customer never gave.
  const range = budgetRangeLabel(monthly);
  if (range) return { line: `${range} بالشهر، وتحدد الرقم بالضبط قبل لا تشتغل الحملة.`, short: `${range} بالشهر` };
  const daily = Math.round(monthly / 30);
  return {
    line: `${money(monthly, currency)} بالشهر، قرابة ${money(daily, currency)} باليوم.`,
    short: `${money(monthly, currency)} بالشهر`,
  };
}

/**
 * CONTRACT (part B): the first-campaign plan for new, dormant and no_account.
 * No audit and no model: a template by kind, filled from the customer's
 * answers. Null for a scenario that already runs ads.
 */
export function firstCampaignPlan(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  business: { monthlyBudget: number | null; targetRegions: string[]; website: string | null } | null;
  currency: string;
}): FirstCampaignPlan | null {
  const { scenario, answered, labels, business, currency } = args;
  if (scenario.state !== 'new' && scenario.state !== 'dormant' && scenario.state !== 'no_account') return null;

  const kind = trustedKind(scenario);
  const focus = readFocus(scenario, answered, labels);
  const regions = (business?.targetRegions ?? []).map((region) => region.trim()).filter(Boolean);
  const where = regions.length > 0 ? ` في ${joinAnd(regions)}` : '';
  const budget = budgetText(business?.monthlyBudget, currency);

  const type: CampaignType = kind === 'ecommerce' && hasEvidence(scenario, 'mc') ? 'shopping_feed' : 'search';
  const about = focus.topic ? ` على ${focus.topic}` : '';

  let campaign: string;
  if (type === 'shopping_feed') campaign = `حملة تسوق على منتجات المتجر${where}`;
  else if (kind === 'local') campaign = `حملة بحث قريب من الفرع${about}${where}`;
  else campaign = `حملة بحث${about}${where}`;

  const items: FirstCampaignPlan['items'] = [];

  // Structure
  if (type === 'shopping_feed') {
    items.push({ label: 'الهيكل', detail: 'حملة تسوق وحدة تنزّل منتجاتك من Merchant Center، ونقسمها بعد ما نشوف أي المنتجات تبيع.' });
  } else if (kind === 'local') {
    items.push({ label: 'الهيكل', detail: 'حملة بحث وحدة تطلع للناس القريبين من الفرع، ومعها إضافة الموقع عشان يوصلون لك.' });
  } else if (focus.topic) {
    items.push({ label: 'الهيكل', detail: `حملة بحث وحدة على ${focus.topic}، ونوسّعها بعد ما نشوف أول نتائج.` });
  } else {
    items.push({ label: 'الهيكل', detail: `حملة بحث وحدة على أهم ما تقدمه ${KIND_NAME[kind]}، ونوسّعها بعد ما نشوف أول نتائج.` });
  }

  // First keywords
  if (type !== 'shopping_feed') {
    items.push({
      label: 'أول كلمات البحث',
      detail: focus.seeds.length > 0 ? focus.seeds.join('، ') : 'نبنيها من وصف نشاطك، وتراجعها قبل لا تشتغل الحملة.',
    });
  }

  // What the kind adds
  if (kind === 'clinic' || kind === 'services') {
    items.push({ label: 'الاتصال من الإعلان', detail: 'نفعّل إضافة الاتصال عشان العميل يتصل من الإعلان مباشرة.' });
  } else if (type === 'shopping_feed') {
    items.push({
      label: 'أداء أقصى',
      detail: 'نأجله لين تتجمع نحو 30 عملية شراء بالشهر ويكون الفيد سليم، وقتها نجرّبه جنب حملة التسوق.',
    });
  } else if (type === 'search' && kind === 'ecommerce') {
    items.push({ label: 'المنتجات', detail: 'نربط Merchant Center بعدين عشان نفتح حملة تسوق لما تتجمع أول نتائج.' });
  }

  items.push({ label: 'التتبع', detail: TRACKING_ITEM[kind] });
  items.push({ label: 'الميزانية', detail: budget.line });

  return {
    title: 'خطة أول حملة',
    campaign,
    budgetLine: budget.short,
    items: items.slice(0, 5),
    next: scenario.state === 'no_account' ? 'open_account' : 'trial',
  };
}

/** One plain question per audit decision category. */
const AGENCY_QUESTIONS: Record<string, string> = {
  bidding: 'وش استراتيجية المزايدة اللي تستخدمونها على حملاتي، وليش اخترتوها؟',
  keywords: 'كيف تراجعون الكلمات اللي تصرف بلا نتيجة، وكل كم تستبعدونها؟',
  ads: 'متى آخر مرة جرّبتوا نص إعلان جديد على حملاتي، وش كانت النتيجة؟',
  structure: 'ليش حملاتي مقسمة بهالشكل، وش اللي يفصل كل حملة عن الثانية؟',
  budget: 'كيف توزعون ميزانيتي بين الحملات، وعلى أي أساس تنقلونها؟',
  targeting: 'مين المستهدف في حملاتي ووين، وكيف تتأكدون إنه نفس عميلي؟',
  extensions: 'وش الإضافات المفعّلة في إعلاناتي مثل الاتصال والموقع، وليش؟',
};

export const AGENCY_QUESTIONS_MAX = 5;

/**
 * CONTRACT (part B): questions to put to the agency, from the audit's decision
 * categories. One per category present, in the order the decisions come, at most five.
 */
export function agencyQuestions(decisions: Array<{ title: string; category: string | null }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    const category = decision.category ? decision.category.trim().toLowerCase() : '';
    const question = AGENCY_QUESTIONS[category];
    if (!question || seen.has(category)) continue;
    seen.add(category);
    out.push(question);
    if (out.length >= AGENCY_QUESTIONS_MAX) break;
  }
  return out;
}

/** Shown at the end of the agency ending. One switch, so Ayman can drop it. */
export const AGENCY_FULL_MANAGEMENT_CARD = true;
