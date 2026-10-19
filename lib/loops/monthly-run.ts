/**
 * The body of the monthly review cron (MONTHLY_REVIEW_ENABLED).
 *
 * One pass over the subscribed accounts, on the first days of the month:
 *   1. skip an account that already has its monthly report (reports row,
 *      period_type 'monthly', period_start = first day of the reviewed month);
 *   2. read the month's spend; skip an account under the minimum spend;
 *   3. read the pack (economics, n-grams, competition, Quality Score, seasons,
 *      merchant notes, past outcomes), each behind its own switch where it has one;
 *   4. one jarvis_deep (Opus) call, ONLY if the worst-case cost of the call is
 *      under the per-account cap; the money report never needs the model;
 *   5. store the report and mail it through the lifecycle template system. The
 *      copy is approved:false until Ayman reads it, so the mail is held until then.
 *
 * Every dependency can be replaced, so the tests run the whole flow without
 * Google Ads, Supabase, Anthropic or Resend.
 */

import { offerCoachingEnabled } from '../coaching/flag';
import { loadCoachingInput } from '../coaching/load';
import { coachingLinesForReport, detectCoaching } from '../coaching/response-coaching';
import { shadowModeEnabled } from '../shadow/flag';
import { isShadowAccount } from '../shadow/guard';
import { createMessageForAgent, getModelForAgent, modelCandidatesForAgent } from '../ai/client';
import { costUsd, priceFor } from '../ai/pricing';
import { allowableCpaCut, allowableCpaScale, type BreakEven } from '../economics/break-even';
import { loadEconomics } from '../economics/load';
import { EMAIL_COPY } from '../lifecycle/copy';
import { sendTemplate, type SendTemplateResult } from '../messaging/send';
import { currencyUnits, num0, str } from '../jarvis/tools/shared';
import { monthlyCompetitionFinding, type CompetitionFinding } from './auction-insights';
import {
  isBusinessMemoryEnabled,
  isMonthlyReviewEnabled,
  isOutcomeMemoryEnabled,
  isSeasonsEnabled,
} from './flags';
import { loadActiveMerchantContext, merchantContextBlock } from './merchant-context';
import {
  buildMoneyReport,
  buildMonthlyUserMessage,
  belowMinimumSpend,
  EMPTY_PLAN,
  isReviewDay,
  MONTHLY_MAX_OUTPUT_TOKENS,
  MONTHLY_SYSTEM_PROMPT,
  monthlyLimits,
  monthNameAr,
  moneyReportLines,
  parseMonthlyPlan,
  previousMonthWindow,
  protectedFromOutcomes,
  withinCostCap,
  type MonthlyLimits,
  type MonthlyPack,
  type MonthlyPlan,
  type MonthTotals,
  type MonthWindow,
} from './monthly';
import { analyzeNgrams, type NgramAnalysis } from './ngram';
import { fetchSearchTermStats } from './ngram-source';
import { loadOutcomeRecords, type OutcomeRecord } from './outcome-memory';
import { qualityFindings, readQualityKeywords, type QualityFinding } from './quality-score';
import { riyadhDay, seasonContext } from './seasons';

type Customer = { query(gaql: string): Promise<any[]> };

export type MonthlyAccount = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  currency_code: string | null;
  business_id: string | null;
  sector: string | null;
  primary_goal: string | null;
  monthly_budget: number | null;
  owner: { id: string; email: string; name: string | null; messages_opt_out: boolean | null } | null;
  customer: Customer;
};

export type ModelReply = { text: string; model: string; input_tokens: number; output_tokens: number };

/** Everything the review reads or does outside this file. Defaults are the real thing. */
export type MonthlyDeps = {
  readTotals(customer: Customer, from: string, to: string): Promise<MonthTotals & { campaigns: MonthlyPack['campaigns'] }>;
  loadEconomics(account: MonthlyAccount): Promise<BreakEven | null>;
  readNgram(customer: Customer, economics: BreakEven | null, spend: number, conversions: number, account: MonthlyAccount): Promise<NgramAnalysis | null>;
  readCompetition(customer: Customer, window: MonthWindow): Promise<CompetitionFinding>;
  readQuality(customer: Customer): Promise<QualityFinding[]>;
  loadOutcomes(accountId: string, now: Date): Promise<OutcomeRecord[]>;
  loadMerchant(account: MonthlyAccount, now: Date): Promise<MonthlyPack['merchant_notes']>;
  hasReport(accountId: string, window: MonthWindow): Promise<boolean>;
  saveReport(row: Record<string, unknown>): Promise<'saved' | 'exists'>;
  callModel(system: string, user: string, maxTokens: number, account: MonthlyAccount): Promise<ModelReply | null>;
  send(account: MonthlyAccount, window: MonthWindow, money: string[], plan: string[], coaching?: string[]): Promise<SendTemplateResult | { status: 'no_owner' }>;
  /** Offer and response coaching lines (OFFER_COACHING_ENABLED). Optional so older callers and tests stay valid. */
  loadCoaching?(account: MonthlyAccount, now: Date): Promise<string[]>;
  /** True for an agency shadow account (SHADOW_MODE_ENABLED). Optional: absent means not shadow. */
  isShadow?(accountId: string): Promise<boolean>;
  modelName(): string;
};

export type AccountOutcome =
  | { account_id: string; status: 'reported'; model_called: boolean; model_cost_usd: number; mail: string; plan_lines: number }
  | { account_id: string; status: 'skipped'; reason: 'already_reported' | 'below_min_spend' | 'read_failed' | 'shadow_account' }
  | { account_id: string; status: 'failed'; message: string };

export type MonthlySummary = {
  ran: boolean;
  reason?: 'disabled' | 'not_review_day';
  month?: string;
  considered: number;
  reported: number;
  skipped: number;
  failed: number;
  model_calls: number;
  model_cost_usd: number;
  results: AccountOutcome[];
};

const emptySummary = (reason: 'disabled' | 'not_review_day'): MonthlySummary => ({
  ran: false,
  reason,
  considered: 0,
  reported: 0,
  skipped: 0,
  failed: 0,
  model_calls: 0,
  model_cost_usd: 0,
  results: [],
});

/** GAQL for a whole month by campaign. Metrics only, no account change. */
function monthQuery(from: string, to: string) {
  return `
    SELECT campaign.name, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND metrics.impressions > 0
  `;
}

export async function readMonthTotals(customer: Customer, from: string, to: string) {
  const rows = await customer.query(monthQuery(from, to));
  const byName = new Map<string, { name: string; cost: number; conversions: number; value: number }>();
  for (const row of rows ?? []) {
    const name = str(row, 'campaign.name') || 'campaign';
    const entry = byName.get(name) ?? { name, cost: 0, conversions: 0, value: 0 };
    entry.cost += currencyUnits(row, 'metrics.cost_micros');
    entry.conversions += num0(row, 'metrics.conversions');
    entry.value += num0(row, 'metrics.conversions_value');
    byName.set(name, entry);
  }
  const all = [...byName.values()];
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    cost: all.reduce((s, c) => s + c.cost, 0),
    conversions: all.reduce((s, c) => s + c.conversions, 0),
    conversion_value: all.reduce((s, c) => s + c.value, 0),
    campaigns: all
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8)
      .map((c) => ({
        name: c.name.slice(0, 80),
        cost: round(c.cost),
        conversions: round(c.conversions),
        value: round(c.value),
        cpa: c.conversions >= 1 ? round(c.cost / c.conversions) : null,
      })),
  };
}

export function defaultDeps(supabase: any): MonthlyDeps {
  return {
    readTotals: readMonthTotals,
    loadEconomics: (account) =>
      loadEconomics(supabase, {
        businessId: account.business_id,
        sector: account.sector,
        primaryGoal: account.primary_goal,
        accountCurrency: account.currency_code ?? 'SAR',
      }),
    readNgram: async (customer, economics, spend, conversions, account) => {
      const fetched = await fetchSearchTermStats(customer, 'LAST_30_DAYS');
      if (!fetched) return null;
      const accountCpa = conversions >= 1 ? spend / conversions : null;
      return analyzeNgrams({
        terms: fetched.terms,
        allowableCpa: allowableCpaCut(economics, accountCpa),
        protectedTexts: [account.customer_name, account.sector],
        windowDays: 30,
      });
    },
    readCompetition: (customer, window) =>
      monthlyCompetitionFinding(customer, {
        current: { from: window.from, to: window.to },
        prior: { from: window.prior_from, to: window.prior_to },
      }),
    readQuality: async (customer) => {
      const keywords = await readQualityKeywords(customer);
      return keywords ? qualityFindings(keywords) : [];
    },
    loadOutcomes: (accountId, now) => loadOutcomeRecords(supabase, accountId, now),
    loadMerchant: async (account, now) => {
      if (!account.business_id) return null;
      const facts = await loadActiveMerchantContext(supabase, account.business_id, now);
      return merchantContextBlock(facts, riyadhDay(now));
    },
    hasReport: async (accountId, window) => {
      const { data } = await supabase
        .from('reports')
        .select('id')
        .eq('account_id', accountId)
        .eq('period_type', 'monthly')
        .eq('period_start', window.from)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    },
    saveReport: async (row) => {
      const { error } = await supabase.from('reports').insert(row);
      if (error) {
        // The unique index (account, period_type, period_start) turns a race into 23505: the report exists.
        if ((error as { code?: string }).code === '23505') return 'exists';
        throw error;
      }
      return 'saved';
    },
    callModel: async (system, user, maxTokens, account) => {
      try {
        const response = await createMessageForAgent(
          'jarvis_deep',
          {
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
          },
          undefined,
          { userId: account.owner?.id ?? null, accountId: account.id, feature: 'monthly_review', channel: 'cron' }
        );
        const text = response.content
          .map((block: any) => (block.type === 'text' ? block.text : ''))
          .join('');
        return {
          text,
          model: String((response as any).model ?? ''),
          input_tokens: Number(response.usage?.input_tokens ?? 0),
          output_tokens: Number(response.usage?.output_tokens ?? 0),
        };
      } catch {
        return null;
      }
    },
    send: async (account, window, money, plan, coaching) => {
      if (!account.owner?.email) return { status: 'no_owner' as const };
      return sendTemplate({
        user: {
          id: account.owner.id,
          email: account.owner.email,
          name: account.owner.name,
          messages_opt_out: account.owner.messages_opt_out,
        },
        templateKey: `monthly_report_${window.month}`,
        copy: EMAIL_COPY.monthly_report,
        facts: {
          firstName: account.owner.name ? account.owner.name.trim().split(/\s+/)[0] : null,
          businessName: account.customer_name,
          plan: null,
          trial: null,
          weekly: null,
          billing: null,
          monthly: { month: window.month, monthNameAr: monthNameAr(window.month), moneyLines: money, planLines: plan, ...(coaching && coaching.length > 0 ? { coachingLines: coaching } : {}) },
        },
        enforceGap: false,
      });
    },
    loadCoaching: async (account, now) => {
      const input = await loadCoachingInput({ customer: account.customer, admin: supabase, accountId: account.id, now });
      return coachingLinesForReport(detectCoaching(input));
    },
    isShadow: (accountId) => isShadowAccount(accountId, { admin: () => supabase }),
    // The cap is checked against the priciest model the call may fall back to
    // (createMessageForAgent walks a candidate list), not only the preferred one.
    modelName: () => priciestModel([getModelForAgent('jarvis_deep'), ...modelCandidatesForAgent('jarvis_deep')]),
  };
}

/** The candidate with the highest output rate (unknown ids price at the conservative fallback). */
export function priciestModel(models: string[]): string {
  let best = models[0] ?? '';
  for (const model of models) {
    const a = priceFor(model);
    const b = priceFor(best);
    if (a.output > b.output || (a.output === b.output && a.input > b.input)) best = model;
  }
  return best;
}

function planLinesOf(plan: MonthlyPlan): string[] {
  return [
    ...(plan.targets_ar ? [plan.targets_ar] : []),
    ...plan.structure_ar,
    ...plan.season_plan_ar,
    ...plan.experiments_ar,
  ];
}

function modelCost(reply: ModelReply) {
  return costUsd(reply.model, { input_tokens: reply.input_tokens, output_tokens: reply.output_tokens }).costUsd;
}

export async function reviewAccount(args: {
  account: MonthlyAccount;
  window: MonthWindow;
  now: Date;
  limits: MonthlyLimits;
  deps: MonthlyDeps;
  env: Record<string, string | undefined>;
}): Promise<AccountOutcome> {
  const { account, window, now, limits, deps, env } = args;
  try {
    // Agency shadow accounts get no mail and no report (SHADOW_MODE_ENABLED; no lookup when it is off).
    if (shadowModeEnabled(env as NodeJS.ProcessEnv) && deps.isShadow && (await deps.isShadow(account.id))) {
      return { account_id: account.id, status: 'skipped', reason: 'shadow_account' };
    }
    if (await deps.hasReport(account.id, window)) {
      return { account_id: account.id, status: 'skipped', reason: 'already_reported' };
    }

    const [current, prior] = await Promise.all([
      deps.readTotals(account.customer, window.from, window.to),
      deps.readTotals(account.customer, window.prior_from, window.prior_to).catch(() => null),
    ]);
    if (belowMinimumSpend(current.cost, limits.minSpend)) {
      return { account_id: account.id, status: 'skipped', reason: 'below_min_spend' };
    }

    const currency = account.currency_code ?? 'SAR';
    const economics = await deps.loadEconomics(account).catch(() => null);
    const accountCpa = current.conversions >= 1 ? current.cost / current.conversions : null;
    const cut = allowableCpaCut(economics, accountCpa);
    const scale = allowableCpaScale(economics);

    const [ngram, competition, quality, outcomes, merchant] = await Promise.all([
      deps.readNgram(account.customer, economics, current.cost, current.conversions, account).catch(() => null),
      deps.readCompetition(account.customer, window).catch(
        (): CompetitionFinding => ({ source: 'unavailable', findings: [], share_trend: null, summary_ar: null, fallback_reason: null })
      ),
      deps.readQuality(account.customer).catch((): QualityFinding[] => []),
      isOutcomeMemoryEnabled(env) ? deps.loadOutcomes(account.id, now).catch((): OutcomeRecord[] => []) : Promise.resolve([] as OutcomeRecord[]),
      isBusinessMemoryEnabled(env) ? deps.loadMerchant(account, now).catch(() => null) : Promise.resolve(null),
    ]);

    const money = buildMoneyReport({
      month: window.month,
      currency,
      current,
      prior: prior ? { cost: prior.cost, conversions: prior.conversions, conversion_value: prior.conversion_value } : null,
      wasted: ngram && ngram.note === 'ok' ? ngram.wasteful_terms_cost : null,
      protectedOutcome: protectedFromOutcomes(outcomes, window),
    });

    const season = isSeasonsEnabled(env) ? seasonContext(riyadhDay(now)) : null;
    const pack: MonthlyPack = {
      month: window.month,
      currency,
      account_name: account.customer_name,
      sector: account.sector,
      primary_goal: account.primary_goal,
      monthly_budget: account.monthly_budget,
      money,
      economics: {
        allowable_cpa_cut: cut?.value ?? null,
        allowable_cpa_scale: scale?.value ?? null,
        source: cut?.source ?? null,
        account_cpa: accountCpa === null ? null : Math.round(accountCpa * 100) / 100,
      },
      campaigns: current.campaigns,
      competition: {
        source: competition.source,
        summary_ar: competition.summary_ar,
        fallback_reason: competition.fallback_reason,
      },
      quality: quality.slice(0, 6).map((q) => ({
        keyword: q.keyword,
        quality_score: q.quality_score,
        priority: q.priority,
        cost: q.cost,
        suggestions: q.suggestions.map((s) => s.kind),
      })),
      wasteful_grams: (ngram?.wasteful ?? []).slice(0, 6).map((g) => ({ gram: g.gram, cost: g.cost, terms: g.terms })),
      season: season
        ? { active: season.active, upcoming: season.upcoming, prep_budget_hint_ar: season.prep_budget_hint_ar }
        : { active: [], upcoming: [], prep_budget_hint_ar: null },
      merchant_notes: merchant,
      outcomes: outcomes.slice(0, 8).map((o) => ({ action_type: o.action_type, verdict: o.verdict, reason_ar: o.reason_ar })),
    };

    // The model call, behind the cost cap. The money report does not depend on it.
    let plan: MonthlyPlan = EMPTY_PLAN;
    let modelCalled = false;
    let costUsdSpent = 0;
    let planStatus: 'ok' | 'skipped_cost_cap' | 'model_unavailable' = 'ok';
    const userMessage = buildMonthlyUserMessage(pack);
    const cap = withinCostCap(deps.modelName(), `${MONTHLY_SYSTEM_PROMPT}\n${userMessage}`, MONTHLY_MAX_OUTPUT_TOKENS, limits.maxCostUsd);
    if (!cap.ok) {
      planStatus = 'skipped_cost_cap';
    } else {
      const reply = await deps.callModel(MONTHLY_SYSTEM_PROMPT, userMessage, MONTHLY_MAX_OUTPUT_TOKENS, account);
      if (!reply) {
        planStatus = 'model_unavailable';
      } else {
        modelCalled = true;
        costUsdSpent = modelCost(reply);
        plan = parseMonthlyPlan(reply.text, pack);
      }
    }

    const moneyLines = moneyReportLines(money);
    const planLines = planLinesOf(plan);
    const saved = await deps.saveReport({
      account_id: account.id,
      period_type: 'monthly',
      period_start: window.from,
      period_end: window.to,
      summary_ar: moneyLines.join(' '),
      metrics: {
        kind: 'monthly_review',
        month: window.month,
        currency_code: currency,
        money,
        plan,
        plan_status: planStatus,
        competition: { source: competition.source, summary_ar: competition.summary_ar },
        quality: pack.quality,
        model_cost_usd: costUsdSpent,
        cost_cap_usd: limits.maxCostUsd,
      },
    });
    if (saved === 'exists') return { account_id: account.id, status: 'skipped', reason: 'already_reported' };

    // Coaching lines for the mail only (not stored in the report). Best effort, flag gated.
    const coachingLines =
      offerCoachingEnabled(env) && deps.loadCoaching ? await deps.loadCoaching(account, now).catch((): string[] => []) : [];

    const mail = await deps.send(account, window, moneyLines, planLines, coachingLines).catch((): { status: string } => ({ status: 'failed' }));
    return {
      account_id: account.id,
      status: 'reported',
      model_called: modelCalled,
      model_cost_usd: costUsdSpent,
      mail: mail.status,
      plan_lines: planLines.length,
    };
  } catch (error) {
    return { account_id: account.id, status: 'failed', message: error instanceof Error ? error.message.slice(0, 200) : 'error' };
  }
}

/** Accounts of subscribed owners, with the owner and Google Ads customer attached. */
export type ListAccounts = (limit: number, window: MonthWindow) => Promise<MonthlyAccount[]>;

export async function runMonthlyReview(args: {
  supabase: any;
  listAccounts: ListAccounts;
  now?: Date;
  env?: Record<string, string | undefined>;
  deps?: MonthlyDeps;
  force?: boolean;
  /** Stop starting accounts after this many ms from the start. */
  budgetMs?: number;
}): Promise<MonthlySummary> {
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  if (!isMonthlyReviewEnabled(env)) return emptySummary('disabled');
  const limits = monthlyLimits(env);
  if (!args.force && !isReviewDay(now, limits.catchupDays)) return emptySummary('not_review_day');

  const window = previousMonthWindow(now);
  const deps = args.deps ?? defaultDeps(args.supabase);
  const accounts = await args.listAccounts(limits.maxAccounts, window);
  const startedAt = Date.now();
  const budgetMs = args.budgetMs ?? 240_000;

  const summary: MonthlySummary = {
    ran: true,
    month: window.month,
    considered: accounts.length,
    reported: 0,
    skipped: 0,
    failed: 0,
    model_calls: 0,
    model_cost_usd: 0,
    results: [],
  };

  // One account at a time: the model call is the slow, costly step and the cap is per account.
  for (const account of accounts) {
    if (Date.now() - startedAt > budgetMs) break;
    const outcome = await reviewAccount({ account, window, now, limits, deps, env });
    summary.results.push(outcome);
    if (outcome.status === 'reported') {
      summary.reported += 1;
      if (outcome.model_called) summary.model_calls += 1;
      summary.model_cost_usd = Math.round((summary.model_cost_usd + outcome.model_cost_usd) * 1e6) / 1e6;
    } else if (outcome.status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
  }
  return summary;
}
