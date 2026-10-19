/**
 * The monthly deep session: pure parts (GAP-144 item 46, plus 23 to 27 as inputs).
 *
 * Once a month, per subscribed account, one Opus call reads a compact pack that
 * the server already computed (targets against the owner's economics, the
 * structure, competition, Quality Score, the season calendar, the merchant's
 * own notes) and writes the plan: structure review, season plan, experiments.
 * The merchant-facing money report (spent, wasted, protected, returned) is NOT
 * written by the model: every number in it is computed here from the account
 * and from measured outcomes, so it cannot be invented.
 *
 * Nothing here executes anything. The session only recommends.
 *
 * No I/O in this file. See monthly-run.ts for the cron body.
 */

import { priceFor } from '../ai/pricing';
import type { CompetitionFinding } from './auction-insights';
import type { MerchantContextBlock } from './merchant-context';
import type { OutcomeRecord } from './outcome-memory';
import type { QualityFinding } from './quality-score';
import { addDays, riyadhDay, type SeasonContext } from './seasons';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// When it runs and which accounts it skips
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_SPEND = 500;
export const DEFAULT_MAX_COST_USD = 0.5;
export const DEFAULT_MAX_ACCOUNTS = 25;
export const DEFAULT_CATCHUP_DAYS = 3;
export const MONTHLY_MAX_OUTPUT_TOKENS = 2200;
/** A rough, deliberately high bound: Arabic JSON is token heavy. */
const CHARS_PER_TOKEN = 2.2;

function positiveNumber(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type MonthlyLimits = {
  /** Spend of the month, account currency, under which the session is not worth a model call. */
  minSpend: number;
  /** Hard ceiling of one account's model call, USD, checked BEFORE the call from a high bound. */
  maxCostUsd: number;
  /** Accounts handled by one invocation. The rest wait for the next slot of the catch-up days. */
  maxAccounts: number;
  /** The run is allowed on the first N days of the month (a missed slot is retried; the report row makes it once). */
  catchupDays: number;
};

export function monthlyLimits(env: Env = process.env): MonthlyLimits {
  return {
    minSpend: positiveNumber(env.MONTHLY_REVIEW_MIN_SPEND, DEFAULT_MIN_SPEND),
    maxCostUsd: positiveNumber(env.MONTHLY_REVIEW_MAX_COST_USD, DEFAULT_MAX_COST_USD),
    maxAccounts: Math.floor(positiveNumber(env.MONTHLY_REVIEW_MAX_ACCOUNTS, DEFAULT_MAX_ACCOUNTS)),
    catchupDays: Math.floor(positiveNumber(env.MONTHLY_REVIEW_CATCHUP_DAYS, DEFAULT_CATCHUP_DAYS)),
  };
}

export type MonthWindow = {
  /** YYYY-MM of the month being reviewed (the month that just ended). */
  month: string;
  from: string;
  to: string;
  prior_from: string;
  prior_to: string;
};

/** The calendar month before today's Riyadh month, and the month before that. */
export function previousMonthWindow(now: Date): MonthWindow {
  const today = riyadhDay(now);
  const firstOfThis = `${today.slice(0, 7)}-01`;
  const to = addDays(firstOfThis, -1);
  const from = `${to.slice(0, 7)}-01`;
  const priorTo = addDays(from, -1);
  const priorFrom = `${priorTo.slice(0, 7)}-01`;
  return { month: from.slice(0, 7), from, to, prior_from: priorFrom, prior_to: priorTo };
}

/** True on the first `catchupDays` days of a Riyadh month. */
export function isReviewDay(now: Date, catchupDays = DEFAULT_CATCHUP_DAYS): boolean {
  const day = Number(riyadhDay(now).slice(8, 10));
  return day >= 1 && day <= Math.max(1, catchupDays);
}

/** Skip an account whose month had too little spend for a deep session to matter. */
export function belowMinimumSpend(spend: number, minSpend: number): boolean {
  return !Number.isFinite(spend) || spend < minSpend;
}

// ---------------------------------------------------------------------------
// Cost cap
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Highest USD this call can cost: the whole prompt at the input rate plus the
 * full max_tokens at the output rate. The check runs BEFORE the call, so an
 * account that would exceed the cap never reaches the model.
 */
export function worstCaseCostUsd(model: string, promptText: string, maxOutputTokens: number): number {
  const inputTokens = estimateTokens(promptText);
  const price = priceFor(model, inputTokens);
  return (inputTokens * price.input + maxOutputTokens * price.output) / 1e6;
}

export function withinCostCap(model: string, promptText: string, maxOutputTokens: number, maxCostUsd: number) {
  const worst = worstCaseCostUsd(model, promptText, maxOutputTokens);
  return { ok: worst <= maxCostUsd, worst_case_usd: Math.round(worst * 1e6) / 1e6 };
}

// ---------------------------------------------------------------------------
// The money report (server computed)
// ---------------------------------------------------------------------------

export type MonthTotals = { cost: number; conversions: number; conversion_value: number };

export type MoneyReport = {
  month: string;
  currency: string;
  spent: number;
  conversions: number;
  returned: number | null;
  /** Spend on search terms that cost at least twice the allowable CPA and never converted. Null when no CPA to judge by. */
  wasted: number | null;
  wasted_source: 'ngram_30d' | null;
  /** Cost the measured changes of the month took out with no loss of conversions. */
  protected: number | null;
  protected_actions: number;
  prior_spent: number | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * What the changes of the month protected: for each measured change that did
 * not come out negative, the cost it took out (before minus after, same window
 * length), only where conversions did not fall. Only measured outcomes count;
 * an unmeasured change adds nothing. Not a promise, an estimate: the report
 * says so.
 */
export function protectedFromOutcomes(
  records: readonly OutcomeRecord[],
  window: { from: string; to: string }
): { amount: number; actions: number } {
  let amount = 0;
  let actions = 0;
  for (const record of records) {
    const day = record.created_at ? record.created_at.slice(0, 10) : null;
    if (!day || day < window.from || day > window.to) continue;
    if (record.verdict === 'negative' || record.verdict === 'unknown') continue;
    if (!record.before || !record.after) continue;
    if (record.after.conversions < record.before.conversions) continue;
    const saved = record.before.cost - record.after.cost;
    if (!(saved > 0)) continue;
    amount += saved;
    actions += 1;
  }
  return { amount: round2(amount), actions };
}

export function buildMoneyReport(args: {
  month: string;
  currency: string;
  current: MonthTotals;
  prior: MonthTotals | null;
  wasted: number | null;
  protectedOutcome: { amount: number; actions: number };
}): MoneyReport {
  const { current, prior } = args;
  return {
    month: args.month,
    currency: args.currency,
    spent: round2(current.cost),
    conversions: Math.round(current.conversions * 100) / 100,
    returned: current.conversion_value > 0 ? round2(current.conversion_value) : null,
    wasted: args.wasted !== null && args.wasted > 0 ? round2(args.wasted) : args.wasted === 0 ? 0 : null,
    wasted_source: args.wasted === null ? null : 'ngram_30d',
    protected: args.protectedOutcome.actions > 0 ? args.protectedOutcome.amount : null,
    protected_actions: args.protectedOutcome.actions,
    prior_spent: prior ? round2(prior.cost) : null,
  };
}

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

export function monthNameAr(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return MONTHS_AR[index] ?? month;
}

function amount(value: number, currency: string) {
  const text = new Intl.NumberFormat('en-US', { maximumFractionDigits: value < 100 ? 2 : 0 }).format(value);
  return `${text} ${currency === 'SAR' ? 'ريال' : currency}`;
}

/**
 * The merchant-facing lines: spent, wasted, protected, returned. Fixed
 * wording, numbers from MoneyReport only. A line whose number is unknown says
 * so in plain words instead of being left out or guessed.
 */
export function moneyReportLines(report: MoneyReport): string[] {
  const lines: string[] = [];
  lines.push(`صرفت على إعلانات قوقل في ${monthNameAr(report.month)} ${amount(report.spent, report.currency)}.`);
  if (report.returned !== null) {
    lines.push(`رجّعت لك الإعلانات مبيعات بقيمة ${amount(report.returned, report.currency)} حسب التحويلات المسجلة.`);
  } else if (report.conversions > 0) {
    lines.push(`جابت الإعلانات ${Math.round(report.conversions)} تحويل. قيمة التحويلات ما هي مسجلة في الحساب، فما أقدر أقول كم رجّعت بالريال.`);
  } else {
    lines.push('ما سُجل تحويل خلال الشهر، فما فيه مبلغ راجع أقدر أذكره.');
  }
  if (report.wasted === null) {
    lines.push('الهدر: ما أقدر أحسبه لأن حد التكلفة المسموحة للتحويل مو محدد عندي.');
  } else if (report.wasted === 0) {
    lines.push('الهدر: ما لقيت كلمات بحث كررت الصرف بدون ولا تحويل.');
  } else {
    lines.push(`الهدر: كلمات بحث صرفت ${amount(report.wasted, report.currency)} بدون ولا تحويل خلال آخر 30 يوم. تقدير من كلمات البحث، مو رقم دقيق.`);
  }
  if (report.protected !== null) {
    lines.push(`وفّرنا بتعديلات مقاسة ${amount(report.protected, report.currency)} من الصرف بدون ما تنزل التحويلات (${report.protected_actions} تعديل). تقدير مبني على الأسبوع قبل التعديل وبعده.`);
  } else {
    lines.push('الوفر: ما فيه تعديل هالشهر انقاس أثره بعد، فما أحسب لك وفر.');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The model pack and plan
// ---------------------------------------------------------------------------

export type MonthlyPack = {
  month: string;
  currency: string;
  account_name: string | null;
  sector: string | null;
  primary_goal: string | null;
  monthly_budget: number | null;
  money: MoneyReport;
  economics: {
    allowable_cpa_cut: number | null;
    allowable_cpa_scale: number | null;
    source: string | null;
    account_cpa: number | null;
  };
  campaigns: Array<{ name: string; cost: number; conversions: number; value: number; cpa: number | null }>;
  competition: Pick<CompetitionFinding, 'source' | 'summary_ar' | 'fallback_reason'>;
  quality: Array<Pick<QualityFinding, 'keyword' | 'quality_score' | 'priority' | 'cost'> & { suggestions: string[] }>;
  wasteful_grams: Array<{ gram: string; cost: number; terms: number }>;
  season: Pick<SeasonContext, 'active' | 'upcoming' | 'prep_budget_hint_ar'>;
  merchant_notes: MerchantContextBlock | null;
  outcomes: Array<{ action_type: string; verdict: string; reason_ar: string }>;
};

export const MONTHLY_SYSTEM_PROMPT = `أنت مشتري إعلانات خبير يراجع شهر كامل لحساب إعلانات قوقل لتاجر سعودي. تكتب بلهجة سعودية نجدية بسيطة، قصيرة ومباشرة.

القواعد:
- تقرأ البيانات داخل <monthly_pack> فقط. كل رقم تذكره لازم يكون موجود فيها حرفياً. لا تحسب أرقام جديدة ولا تقدّر.
- توصياتك للتاجر يقرر فيها هو. ما تنفذ شي.
- ممنوع الشرطة الطويلة والقصيرة والفاصلة اللاتينية داخل النص العربي (استخدم ،).
- لا حشو، لا مقدمات، لا عبارات مثل "ليس مجرد".
- لو البيانات ما تكفي لبند، اكتب سطر واحد يقول إنها ما تكفي.

أرجع JSON فقط بهذا الشكل بدون أي نص قبله أو بعده:
{"targets_ar":"سطرين كحد أقصى: هل التكلفة والعائد ضمن الحد المسموح من اقتصاديات التاجر","structure_ar":["حتى 4 ملاحظات عن هيكل الحملات"],"competition_ar":"سطر واحد عن المنافسة","quality_ar":["حتى 3 توصيات من جودة الكلمات"],"season_plan_ar":["حتى 3 خطوات لموسم قريب"],"experiments_ar":["حتى 3 تجارب مقترحة الشهر الجاي، كل تجربة بفرضية واضحة وكيف نقيسها"]}`;

export function buildMonthlyUserMessage(pack: MonthlyPack): string {
  return `<monthly_pack>\n${JSON.stringify(pack)}\n</monthly_pack>`;
}

export type MonthlyPlan = {
  targets_ar: string | null;
  structure_ar: string[];
  competition_ar: string | null;
  quality_ar: string[];
  season_plan_ar: string[];
  experiments_ar: string[];
};

export const EMPTY_PLAN: MonthlyPlan = {
  targets_ar: null,
  structure_ar: [],
  competition_ar: null,
  quality_ar: [],
  season_plan_ar: [],
  experiments_ar: [],
};

/** House style for Arabic text from a model: no dashes, Arabic comma, one line. */
export function cleanArabicLine(value: string, max = 280): string {
  return value
    .replace(/\s*[—–]\s*/g, '، ')
    .replace(/(?<=[؀-ۿ]),|,(?=\s*[؀-ۿ])/g, '،')
    .replace(/ليس مجرد/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const NUMBER = /\d+(?:[.,]\d+)?/g;

function normalizeNumber(raw: string) {
  return raw.replace(/,/g, '');
}

/** Every number written in the pack, as strings, for the grounding check. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.match(NUMBER) ?? []) {
    out.add(normalizeNumber(match));
    const n = Number(normalizeNumber(match));
    if (Number.isFinite(n)) {
      out.add(String(n));
      out.add(String(Math.round(n)));
    }
  }
  return out;
}

/** A line passes when every number in it also appears in the pack. */
export function isGrounded(line: string, allowed: ReadonlySet<string>): boolean {
  for (const match of line.match(NUMBER) ?? []) {
    const raw = normalizeNumber(match);
    const n = Number(raw);
    if (allowed.has(raw) || (Number.isFinite(n) && (allowed.has(String(n)) || allowed.has(String(Math.round(n)))))) continue;
    return false;
  }
  return true;
}

function lines(value: unknown, max: number, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const line = cleanArabicLine(item);
    if (line.length >= 6 && isGrounded(line, allowed)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

function one(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof value !== 'string') return null;
  const line = cleanArabicLine(value, 400);
  return line.length >= 6 && isGrounded(line, allowed) ? line : null;
}

/**
 * Reads the model's JSON. Anything unparsable gives the empty plan; a line
 * that carries a number the pack does not contain is dropped, not repaired.
 */
export function parseMonthlyPlan(text: string, pack: MonthlyPack): MonthlyPlan {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return EMPTY_PLAN;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return EMPTY_PLAN;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_PLAN;
  const allowed = numbersIn(JSON.stringify(pack));
  return {
    targets_ar: one(raw.targets_ar, allowed),
    structure_ar: lines(raw.structure_ar, 4, allowed),
    competition_ar: one(raw.competition_ar, allowed),
    quality_ar: lines(raw.quality_ar, 3, allowed),
    season_plan_ar: lines(raw.season_plan_ar, 3, allowed),
    experiments_ar: lines(raw.experiments_ar, 3, allowed),
  };
}
