import type Anthropic from '@anthropic-ai/sdk';
import { cachedSystemBlock, createMessageForAgent, hasAIBackend } from './client';
import type { Customer } from 'google-ads-api';
import {
  UNKNOWN_BUILDER_SIGNALS,
  applyBuilderGates,
  forecastUnavailable,
  type BuilderAccountSignals,
} from './builder-gates';

/**
 * Campaign Builder Agent
 *
 * The user types something like:
 *   "أبغى حملة لمنتج عطر رجالي بميزانية ٣٠٠٠ ر.س — استهدف الرياض وجدة"
 *
 * The agent uses Claude with tool use to:
 * 1. Read the brief and the account facts (conversions, tracking, Merchant Center)
 * 2. Generate Arabic ad copies
 * 3. Build a complete campaign draft (no API write yet — user must approve)
 *
 * The draft is then forced through the launch gates in builder-gates.ts (titan
 * knowledge base): bidding ladder, PMax/Shopping/Display/Video gates, BROAD
 * gate, Search network settings, PAUSED, no forecast, no guarantee wording.
 */

export const BUILDER_SYSTEM_PROMPT = `You are a senior Google Ads strategist building campaign DRAFTS for advertisers in the Saudi/Gulf market. Nothing you output is launched: the user must explicitly approve everything, and every new campaign is created PAUSED.

PROCESS
1. Read the user's brief (Arabic or English) and "account_signals" in the business context. null means unknown, and unknown means take the conservative option.
2. Build a complete campaign draft and return it with the finalize_draft tool.

HARD RULES (google-ads-titan; the platform re-checks every one of them in code and overrides a draft that breaks them)
1. NO INVENTED NUMBERS. There is no keyword volume, CPC, conversion-rate or ROAS data here, and no reliable Saudi benchmark. Never write expected clicks, conversions, CPA, ROAS, traffic or revenue anywhere: not in the draft, not in summary_ar, not in next_steps_ar. Say plainly that a forecast needs real data. Do not include a "forecast" block.
2. Bidding ladder for a NEW campaign:
   - tracking not proven healthy, or no conversions in the last 30 days: MAXIMIZE_CLICKS with "max_cpc_sar" (a cap no higher than daily_budget_sar / 10).
   - account_signals.tracking_healthy = true and conversions are arriving but under 30 in 30 days: MAXIMIZE_CONVERSIONS without a target.
   - TARGET_CPA or TARGET_ROAS only when account_signals.conversions_30d >= 30 and tracking is healthy. Never output a numeric CPA/ROAS target: that value comes from the merchant's margin and close rate, not from account averages. TARGET_ROAS only for sales (real conversion values), never for leads.
3. Match types: default PHRASE or EXACT. BROAD only together with TARGET_CPA/TARGET_ROAS and at least 30 conversions in 30 days.
4. Campaign type: SEARCH is the default. SHOPPING only when account_signals.merchant_center_linked = true. PMAX only for an online store with merchant_center_linked = true and conversions_30d >= 30; never PMAX for lead generation (no offline conversion import exists). Never propose DISPLAY or VIDEO unless the user explicitly asked for them in the brief.
5. Search campaigns launch with Search Partners and Display Network OFF (network_settings). Use location_option "PRESENCE" (people physically in the area); use "PRESENCE_OR_INTEREST" only if the brief says the buyers are outside the service area, and then explain it in location_option_reason_ar.
6. Never write guarantee wording in any language (the Arabic words for guarantee, guaranteed and "we guarantee", or English guarantee/guaranteed) and never promise results in ad copy or summaries. A product warranty counts only if the merchant stated it in the brief, in the merchant's own words.
7. Consolidate: one campaign, 3-5 related ad groups. Do not split a campaign by city, product or match type unless the brief gives an economic reason.

OUTPUT (finalize_draft.draft)
{
  "name": "...",
  "type": "SEARCH" | "SHOPPING" | "PMAX"   // DISPLAY / VIDEO only if explicitly requested
  "objective": "SALES" | "LEADS",
  "daily_budget_sar": number,
  "bidding_strategy": "MAXIMIZE_CLICKS" | "MAXIMIZE_CONVERSIONS" | "TARGET_CPA" | "TARGET_ROAS",
  "max_cpc_sar": number | null,        // required with MAXIMIZE_CLICKS
  "location_option": "PRESENCE",
  "geo_targets": [{ "country": "SA", "regions": [...] }],
  "language": "ar",
  "ad_groups": [
    {
      "name": "...",
      "keywords": [{ "text": "...", "match_type": "EXACT|PHRASE" }],
      "headlines_ar": ["..."],
      "descriptions_ar": ["..."]
    }
  ]
}
finalize_draft also takes "summary_ar": a short Arabic summary for the client with no performance numbers, and the draft may carry "next_steps_ar": ["what the client must confirm before launch"].

QUALITY GUIDELINES
- 3-5 ad groups, 8-15 keywords each, written from the brief only: never invent search volumes
- 3+ headlines (max 30 chars Arabic each), 2+ descriptions (max 90 chars)
- Headlines must include benefit + CTA + brand differentiator, using only claims the brief supports
- Use natural Saudi/Gulf phrasing (e.g. "أصلي", "شحن مجاني" only if the brief offers free shipping)
- Daily budget = monthly_budget / 30
- For Saudi market, default geo = SA + relevant cities`;

/** Kept for readers of older code. */
const SYSTEM_PROMPT = BUILDER_SYSTEM_PROMPT;

const TOOLS = [
  // `get_keyword_ideas` was removed. The REST wrapper exposes no
  // `keywordPlanIdeas` service, so every call threw a TypeError that was
  // swallowed and returned `{ error: 'keyword_planning_unavailable' }` to the
  // model — which then invented keywords and search volumes for the draft.
  // `forecast_campaign` is not advertised for the same reason: it returned
  // constants (CPC 4.5, 2.5% conversion rate, ROAS 3.5) as if they were a
  // forecast. There is no KeywordPlan service in this repo's Google Ads
  // client, so there is no real forecast to give (titan red rule 8). The
  // handler below still answers `available: false` if a model asks for it.
  // Advertising a tool that cannot work is worse than not having it.
  {
    name: 'finalize_draft',
    description:
      'Output the final campaign draft for user review. The draft must not contain a forecast or any expected clicks, conversions, CPA or ROAS.',
    input_schema: {
      type: 'object',
      properties: {
        draft: { type: 'object' },
        summary_ar: { type: 'string' },
      },
      required: ['draft', 'summary_ar'],
    },
  },
] as const;

export interface BuilderResult {
  draft_campaign: any;
  summary_ar: string;
  next_steps_ar: string[];
  tool_trace: Array<{ tool: string; input: any; output: any }>;
}

export type BuilderContext = {
  business_name?: string;
  sector?: string;
  website?: string;
  /** What the platform knows about the account; absent means unknown (conservative gates). */
  signals?: BuilderAccountSignals;
};

export type BuilderRunOptions = {
  deadlineAt?: number;
  now?: () => number;
  minimumRoundBudgetMs?: number;
  minimumRetryBudgetMs?: number;
};

export const BUILDER_MINIMUM_ROUND_BUDGET_MS = 50_000;
export const BUILDER_MINIMUM_RETRY_BUDGET_MS = 15_000;

export function hasBuilderRoundBudget({
  deadlineAt,
  now = Date.now,
  minimumRoundBudgetMs = BUILDER_MINIMUM_ROUND_BUDGET_MS,
}: BuilderRunOptions = {}) {
  return deadlineAt === undefined || deadlineAt - now() >= minimumRoundBudgetMs;
}

export function hasBuilderRetryBudget({
  deadlineAt,
  now = Date.now,
  minimumRetryBudgetMs = BUILDER_MINIMUM_RETRY_BUDGET_MS,
}: BuilderRunOptions = {}) {
  return deadlineAt === undefined || deadlineAt - now() >= minimumRetryBudgetMs;
}

export function isRetryableBuilderError(error: unknown) {
  const status = Number((error as { status?: number })?.status ?? 0);
  const code = String((error as { code?: string })?.code ?? '');
  const name = String((error as { name?: string })?.name ?? '');

  return (
    [408, 409, 429, 500, 502, 503, 504, 529].includes(status) ||
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'].includes(code) ||
    ['APIConnectionError', 'APIConnectionTimeoutError', 'RateLimitError'].includes(name)
  );
}

export function shouldRefundBuilderUsage(result: BuilderResult) {
  return result.draft_campaign?.needs_ai_enrichment === true;
}

export async function buildCampaign(
  brief: string,
  customer: Customer,
  context?: BuilderContext,
  options: BuilderRunOptions = {}
): Promise<BuilderResult> {
  if (!hasAIBackend()) {
    return buildFallbackCampaign(brief, context);
  }

  const { signals: contextSignals, ...businessContext } = context ?? {};
  const signals = contextSignals ?? UNKNOWN_BUILDER_SIGNALS;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Customer brief: ${brief}\n\nBusiness context: ${JSON.stringify({ ...businessContext, account_signals: signals })}`,
    },
  ];

  const toolTrace: Array<{ tool: string; input: any; output: any }> = [];
  let finalDraft: any = null;

  // Tool-use loop (max 10 turns)
  for (let i = 0; i < 10; i++) {
    if (!hasBuilderRoundBudget(options)) {
      console.warn('Campaign builder stopped before the request deadline.', {
        completedRounds: i,
      });
      return buildDeadlineFallback(brief, context, toolTrace);
    }

    let response: Awaited<ReturnType<typeof createMessageForAgent>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remainingMs = options.deadlineAt
        ? options.deadlineAt - (options.now ?? Date.now)()
        : 45_000;

      try {
        response = await createMessageForAgent('builder', {
          max_tokens: 4096,
          // Re-sent unchanged on every tool round (up to 10 within seconds),
          // so rounds after the first read tools + rules from the cache.
          system: cachedSystemBlock(SYSTEM_PROMPT),
          tools: TOOLS as any,
          messages,
        }, {
          // Keep SDK retries disabled so one nominal request cannot silently
          // expand into three. We perform one explicit retry only for a small
          // set of transient transport/provider failures while the route still
          // has enough budget to persist a result.
          timeout: Math.min(45_000, Math.max(1_000, remainingMs - 5_000)),
          maxRetries: 0,
        });
        break;
      } catch (error) {
        const canRetry =
          attempt === 0 &&
          isRetryableBuilderError(error) &&
          hasBuilderRetryBudget(options);
        if (!canRetry) throw error;
        console.warn('Retrying the campaign builder after a transient AI error.', {
          status: Number((error as { status?: number })?.status ?? 0) || undefined,
          code: String((error as { code?: string })?.code ?? '') || undefined,
        });
      }
    }

    if (!response) {
      return buildDeadlineFallback(brief, context, toolTrace);
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        let output: any;
        try {
          output = await runBuilderTool(block.name, block.input, customer);
          toolTrace.push({ tool: block.name, input: block.input, output });

          if (block.name === 'finalize_draft') {
            finalDraft = block.input;
          }
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(output),
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (finalDraft) break;
      continue;
    }

    // Any other stop reason (notably `max_tokens`, very reachable at 4096 with
    // tools attached) previously neither broke nor appended anything, so the
    // identical `messages` array was re-sent up to 10 times — 10 full model
    // calls for one request, and the rate limit allows 10 requests per 10
    // minutes.
    console.warn(`Campaign builder stopped early: ${response.stop_reason}`);
    break;
  }

  if (!finalDraft?.draft || typeof finalDraft.draft !== 'object' || Array.isArray(finalDraft.draft)) {
    return buildIncompleteFallback(brief, context, toolTrace);
  }

  // The launch gates run on every finalized draft, whatever the model wrote.
  const gated = applyBuilderGates(finalDraft.draft, { brief, signals });
  const modelSteps: unknown[] = Array.isArray(finalDraft.next_steps_ar)
    ? finalDraft.next_steps_ar
    : Array.isArray(finalDraft.draft.next_steps_ar)
      ? finalDraft.draft.next_steps_ar
      : [];

  return {
    draft_campaign: gated.draft,
    summary_ar: finalDraft.summary_ar ?? '',
    next_steps_ar: [...modelSteps.filter((step): step is string => typeof step === 'string'), ...gated.notes_ar],
    tool_trace: toolTrace,
  };
}

function buildIncompleteFallback(
  brief: string,
  context: BuilderContext | undefined,
  toolTrace: BuilderResult['tool_trace']
): BuilderResult {
  const fallback = buildFallbackCampaign(brief, context);
  return {
    ...fallback,
    summary_ar:
      'لم يكتمل إثراء المسودة بالذكاء الاصطناعي هذه المرة، فحفظت مسودة أولية محافظة. أعد المحاولة قبل اعتماد الحملة.',
    tool_trace: toolTrace,
  };
}

function buildDeadlineFallback(
  brief: string,
  context: BuilderContext | undefined,
  toolTrace: BuilderResult['tool_trace']
): BuilderResult {
  const fallback = buildFallbackCampaign(brief, context);
  return {
    ...fallback,
    summary_ar:
      'انتهى الوقت المتاح لبناء الحملة بأمان، فحفظت مسودة أولية محافظة بدل فقدان العمل. راجع البيانات وأعد التوليد لإكمال الكلمات والإعلانات.',
    next_steps_ar: [
      'راجع الهدف والميزانية اليومية في المسودة',
      'أعد التوليد لإكمال الكلمات والإعلانات',
      'لا تطلق الحملة قبل اكتمال المسودة واعتمادها',
    ],
    tool_trace: toolTrace,
  };
}

function buildFallbackCampaign(brief: string, context?: BuilderContext): BuilderResult {
  const safeName = `${context?.business_name ?? 'Campaign'} | ${brief.slice(0, 32)}`.trim();
  const normalizedName = safeName.length > 72 ? safeName.slice(0, 72) : safeName;

  // Even the placeholder goes through the gates: its bidding strategy follows
  // the account's tracking, not a fixed MAXIMIZE_CONVERSIONS.
  const gated = applyBuilderGates(
    {
      name: normalizedName,
      type: 'SEARCH',
      daily_budget_sar: 100,
      geo_targets: [{ country: 'SA', regions: [] }],
      language: 'ar',
      ad_groups: [
        {
          name: 'مجموعة إعلانية أولى',
          keywords: [],
          headlines_ar: [],
          descriptions_ar: [],
        },
      ],
      needs_ai_enrichment: true,
    },
    { brief, signals: context?.signals }
  );

  return {
    draft_campaign: gated.draft,
    summary_ar:
      'تعذر إكمال إثراء المسودة بالذكاء الاصطناعي الآن، فحفظت مسودة أولية محافظة. أعد المحاولة لإكمال الكلمات والإعلانات قبل الإطلاق.',
    next_steps_ar: [
      'راجع الهدف والميزانية اليومية',
      'أضف صفحة الهبوط والمنتجات أو الخدمات الأساسية',
      'لا تطلق الحملة قبل إكمال الكلمات والإعلانات',
    ],
    tool_trace: [],
  };
}

/**
 * Runs one builder tool. Exported for tests.
 *
 * `forecast_campaign` is no longer advertised to the model (see TOOLS), but a
 * model can still ask for it. It used to return invented numbers (CPC 4.5,
 * 2.5% conversion rate, ROAS 3.5 "illustrative"); there is no KeywordPlan
 * service in this repo's Google Ads client, so the honest answer is that no
 * forecast is available (titan red rule 8: no invented numbers).
 */
export async function runBuilderTool(name: string, _input: unknown, _customer?: Customer): Promise<any> {
  switch (name) {
    case 'forecast_campaign':
      return forecastUnavailable();

    case 'finalize_draft':
      return { ok: true };
  }
  return null;
}
