import { createAdminClient } from '@/lib/supabase/server';
import { effectiveLimitPlan, type BillingPlan } from '@/lib/billing/entitlements';

export type LlmChannel = 'text' | 'voice' | 'cron';

export type LlmUsageEntry = {
  userId?: string | null;
  accountId?: string | null;
  feature: string;
  channel?: LlmChannel | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  priced: boolean;
  toolRounds?: number;
  latencyMs?: number | null;
  pricingVersion?: string | null;
  playbookVersion?: string | null;
};

const RECORD_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function count(value: number | null | undefined) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2_147_483_647) : 0;
}

/**
 * Best-effort append to llm_usage. It NEVER throws and gives up after a few
 * seconds: metering must not be able to break or slow down an answer. Failures
 * are logged without payloads, ids or keys.
 */
/**
 * Until migration 20261012_llm_usage runs, every insert fails with "table not
 * found". Say so once, then stay quiet for ten minutes instead of logging an
 * error on every model call.
 */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);
const MISSING_TABLE_BACKOFF_MS = 10 * 60 * 1000;
let missingTableUntil = 0;

export async function recordLlmUsage(entry: LlmUsageEntry): Promise<void> {
  if (missingTableUntil > Date.now()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const admin = createAdminClient();
    const row = {
      user_id: entry.userId && UUID.test(entry.userId) ? entry.userId : null,
      account_id: entry.accountId && UUID.test(entry.accountId) ? entry.accountId : null,
      feature: (String(entry.feature ?? '').trim() || 'unknown').slice(0, 60),
      channel: entry.channel ?? null,
      model: String(entry.model ?? '').slice(0, 120) || 'unknown',
      input_tokens: count(entry.inputTokens),
      output_tokens: count(entry.outputTokens),
      cache_read_tokens: count(entry.cacheReadTokens),
      cache_write_tokens: count(entry.cacheWriteTokens),
      cost_usd: Number.isFinite(entry.costUsd) && entry.costUsd > 0 ? entry.costUsd : 0,
      priced: entry.priced !== false,
      tool_rounds: Math.min(count(entry.toolRounds), 32_000),
      latency_ms: entry.latencyMs == null ? null : count(entry.latencyMs),
      pricing_version: entry.pricingVersion ?? null,
      playbook_version: entry.playbookVersion ?? null,
    };

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), RECORD_TIMEOUT_MS);
    });
    const result = await Promise.race([admin.from('llm_usage').insert(row), timeout]);
    if (result === 'timeout') {
      console.error('llm_usage insert timed out');
    } else if (result.error) {
      const code = result.error.code ?? null;
      if (code && MISSING_TABLE_CODES.has(code)) {
        missingTableUntil = Date.now() + MISSING_TABLE_BACKOFF_MS;
        console.warn('llm_usage table is missing; run migration 20261012_llm_usage. Metering paused for 10 minutes.');
      } else {
        console.error('llm_usage insert failed', { code });
      }
    }
  } catch (error) {
    console.error('llm_usage record failed', { name: error instanceof Error ? error.name : 'UnknownError' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const SAR_PER_USD = 3.75;
/** The monthly LLM budget is this share of the plan price (before VAT). */
export const BUDGET_SHARE_OF_PLAN = 0.1;
/** Day cap is the month cap spread over this many days, so one day cannot burn the month. */
export const DAY_CAP_DIVISOR = 15;
/** From this share of a cap the product degrades to the cheaper model. */
export const DEGRADE_AT = 0.7;
export const NON_SUBSCRIBER_DAY_SAR = 2;

export const PLAN_PRICE_SAR: Record<BillingPlan, number> = {
  starter: 500,
  growth: 1200,
  pro: 2500,
};

export type BudgetCaps = {
  monthUsd: number;
  dayUsd: number;
  monthSar: number;
  daySar: number;
};

export type BudgetLevel = 'ok' | 'degraded' | 'exhausted';

export function budgetCapsFor({
  plan,
  subscriptionActive,
}: {
  plan?: BillingPlan | null;
  subscriptionActive: boolean;
}): BudgetCaps {
  if (!subscriptionActive) {
    const daySar = NON_SUBSCRIBER_DAY_SAR;
    const monthSar = daySar * 30;
    return { monthUsd: monthSar / SAR_PER_USD, dayUsd: daySar / SAR_PER_USD, monthSar, daySar };
  }
  const price = PLAN_PRICE_SAR[plan ?? 'starter'] ?? PLAN_PRICE_SAR.starter;
  const monthSar = price * BUDGET_SHARE_OF_PLAN;
  const daySar = monthSar / DAY_CAP_DIVISOR;
  return { monthUsd: monthSar / SAR_PER_USD, dayUsd: daySar / SAR_PER_USD, monthSar, daySar };
}

export type BudgetEvaluation = {
  level: BudgetLevel;
  /** Which cap decided an exhausted or degraded level. */
  limitedBy: 'month' | 'day' | null;
  monthRatio: number;
  dayRatio: number;
};

const EPSILON = 1e-9;

function ratio(spent: number, cap: number) {
  if (!(cap > 0)) return spent > 0 ? Infinity : 0;
  return spent / cap;
}

/**
 * Pure budget rule. Exhausted at or above a cap (month or day), degraded from
 * 70% of either, otherwise ok.
 */
export function evaluateBudget({
  monthSpentUsd,
  daySpentUsd,
  caps,
}: {
  monthSpentUsd: number;
  daySpentUsd: number;
  caps: Pick<BudgetCaps, 'monthUsd' | 'dayUsd'>;
}): BudgetEvaluation {
  const monthRatio = ratio(monthSpentUsd, caps.monthUsd);
  const dayRatio = ratio(daySpentUsd, caps.dayUsd);
  const reached = (spent: number, cap: number, share: number) => spent >= cap * share - EPSILON;

  if (reached(monthSpentUsd, caps.monthUsd, 1)) {
    return { level: 'exhausted', limitedBy: 'month', monthRatio, dayRatio };
  }
  if (reached(daySpentUsd, caps.dayUsd, 1)) {
    return { level: 'exhausted', limitedBy: 'day', monthRatio, dayRatio };
  }
  if (reached(monthSpentUsd, caps.monthUsd, DEGRADE_AT)) {
    return { level: 'degraded', limitedBy: 'month', monthRatio, dayRatio };
  }
  if (reached(daySpentUsd, caps.dayUsd, DEGRADE_AT)) {
    return { level: 'degraded', limitedBy: 'day', monthRatio, dayRatio };
  }
  return { level: 'ok', limitedBy: null, monthRatio, dayRatio };
}

export type LlmBudgetState = BudgetEvaluation & {
  caps: BudgetCaps;
  monthSpentUsd: number;
  daySpentUsd: number;
  /** True when metering could not be read; the level is then 'ok' (fail open). */
  unknown: boolean;
  operator: boolean;
};

export type LlmBudgetInput = {
  userId: string;
  /** The plan the customer chose (`SubscriptionAccess.plan`), NOT a limit plan. */
  plan?: BillingPlan | null;
  /**
   * `SubscriptionAccess.status`. Required on purpose: the budget is a share of
   * the plan price, and a trial runs on Starter (see effectiveLimitPlan), so the
   * status is what decides which plan prices the caps. Callers cannot skip it.
   */
  status: string | null;
  subscriptionActive: boolean;
  isOperator: boolean;
  now?: Date;
};

export type LlmBudgetDeps = {
  /** Spend of one user since a point in time, in USD. Defaults to the SQL function. */
  readSpendSince?: (userId: string, since: Date) => Promise<number>;
};

export function utcMonthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function readSpendFromDatabase(userId: string, since: Date): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('llm_usage_cost_since', {
    p_user_id: userId,
    p_since: since.toISOString(),
  });
  if (error) throw new Error(`llm_usage_cost_since failed (${error.code ?? 'unknown'})`);
  const value = Number(data);
  if (!Number.isFinite(value)) throw new Error('llm_usage_cost_since returned a non-number');
  return value;
}

/**
 * Month-to-date (calendar month, UTC) and today's (UTC day) spend against the
 * caps for the user's plan. Operators are never limited. If the read fails the
 * result is level 'ok' with `unknown: true`: a metering outage must not lock
 * paying users out.
 */
export async function llmBudgetState(
  { userId, plan, status, subscriptionActive, isOperator, now = new Date() }: LlmBudgetInput,
  deps: LlmBudgetDeps = {}
): Promise<LlmBudgetState> {
  // A trial is budgeted as Starter whatever plan it picked; a paid plan, an
  // operator grant ('comp') and internal access keep theirs.
  const caps = budgetCapsFor({ plan: effectiveLimitPlan({ plan: plan ?? null, status }), subscriptionActive });
  const okState = (monthSpentUsd: number, daySpentUsd: number, unknown: boolean): LlmBudgetState => ({
    level: 'ok',
    limitedBy: null,
    monthRatio: ratio(monthSpentUsd, caps.monthUsd),
    dayRatio: ratio(daySpentUsd, caps.dayUsd),
    caps,
    monthSpentUsd,
    daySpentUsd,
    unknown,
    operator: isOperator,
  });

  if (isOperator) return okState(0, 0, false);

  try {
    const read = deps.readSpendSince ?? readSpendFromDatabase;
    const [monthSpentUsd, daySpentUsd] = await Promise.all([
      read(userId, utcMonthStart(now)),
      read(userId, utcDayStart(now)),
    ]);
    const evaluation = evaluateBudget({ monthSpentUsd, daySpentUsd, caps });
    return { ...evaluation, caps, monthSpentUsd, daySpentUsd, unknown: false, operator: false };
  } catch (error) {
    console.error('llm budget read failed, failing open', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return okState(0, 0, true);
  }
}
