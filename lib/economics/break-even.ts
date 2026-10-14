/**
 * Break-even economics for one business, from what the owner told us in the
 * onboarding conversation. Pure: no imports, no clock, no network.
 *
 * Why this exists. The optimizer used to call the account's own average ROAS
 * and CPA of the last seven days its "target" (target_roas / target_cpa), so a
 * campaign that lost money every day was "on target" and got a budget raise.
 * The knowledge base is explicit (google-ads-titan SKILL red rule 2 and 8, and
 * references/bidding-budget.md 5.1): a target comes from the client's own
 * economics, never from the account's own history. This module turns the
 * onboarding answers into the numbers that matter:
 *
 *   e-commerce        break_even_roas = 1 / margin
 *   leads, services,  break_even_cpa  = profit per customer x close rate
 *   clinic, local                       (or, for an owner who answered the older questions,
 *                                        deal value x margin x close rate)
 *
 * The profit per customer is the answer to «كم تربح تقريباً من العميل الواحد بعد
 * التكاليف؟», asked of services, clinic and local businesses. It already has the
 * margin inside it, which is why a services business no longer has to be asked
 * a margin on top of the deal value. When it is answered it wins; the deal value
 * x margin x close rate path stays only for owners who answered those earlier.
 *
 * The answers are buckets, not numbers («من 20 إلى 40»), so each input is a
 * RANGE with a low and a high edge, and the break-even is a range too. The two
 * ends are used for opposite decisions, because the cost of being wrong is not
 * symmetric:
 *
 *   SCALE threshold   the PESSIMISTIC end: the low margin / profit / close rate.
 *                     break_even_roas (the highest ROAS the client could need)
 *                     and break_even_cpa (the lowest CPA the client could
 *                     afford). Raising a budget, setting a bid target and
 *                     promoting a keyword must clear THIS one, so they never
 *                     rest on a rosier number than the owner gave.
 *   CUT threshold     the OPTIMISTIC end: the high margin / profit / close rate.
 *                     break_even_roas_cut (the lowest ROAS the client could
 *                     live with) and break_even_cpa_cut (the highest CPA the
 *                     client could afford). Cutting a budget, pausing a
 *                     keyword and adding a negative must be clearly bad even by
 *                     THIS one, so we never cut something that, inside the
 *                     owner's own range, was actually profitable.
 *
 * Between the two thresholds the honest answer is "we cannot tell yet", and the
 * optimizer does nothing. Margin 20-40%, for example: SCALE needs ROAS of 5 and
 * more (margin 20%), CUT starts at ROAS 2.5 and less (margin 40%); a campaign
 * at 3.2 is neither scaled nor cut.
 *
 * Bucket edges (the onboarding offers these, see lib/setup/adaptive/answers.ts):
 *
 *   margin       lt20 -> 10..20%   20_40 -> 20..40%   gt40 -> 40..80%
 *   deal value   lt2k -> 1,000..2,000   2k_10k -> 2,000..10,000   10k_50k -> 10,000..50,000   gt50k -> 50,000..100,000 SAR
 *   profit       lt50 -> 25..50   50_200 -> 50..200   200_1k -> 200..1,000   1k_5k -> 1,000..5,000   gt5k -> 5,000..10,000 SAR
 *   close rate   le1  -> 0.5..1 of 10   2_3 -> 2..3 of 10   ge4 -> 4..6 of 10
 *
 * Rules for the edges: a closed bucket keeps its two edges; a bucket that starts
 * at 0 («أقل من») has no honest low edge, so its low edge is half of its upper
 * edge; an open-ended top bucket («أكثر من») has no upper edge, so its high edge
 * is TWICE its lower edge. Margin is capped at 100%.
 *
 * The close rate is capped at 6 of 10 on its high edge (CLOSE_RATE_CAP_OF_10).
 * The bucket «4 وفوق» is stored as 4..10, and a high edge of 10 of 10 would let
 * the CUT threshold assume that EVERY contact becomes a customer: a clinic with
 * a profit of 200-1,000 SAR would then be cut only above 1,000 SAR a lead and a
 * keyword paused only after 2,000 SAR with no conversion, which is waste control
 * switched off. Six of ten is the most a lead business can honestly assume from
 * a bucket that has no ceiling (the same conservatism the knowledge base applies
 * to a target it cannot verify); an owner who really closes more than that is
 * only cut a little later than necessary, never wrongly.
 *
 * "I don't know" and "never asked" are the same thing here: the value is null
 * and its name is listed in `missing`. Nothing is guessed.
 */

export const BREAK_EVEN_BASIS = 'merchant_answers_bucketed' as const;

export type EconomicsKind = 'ecommerce' | 'clinic' | 'services' | 'local' | 'general';

/** The `data` payload of one onboarding fact (business_memory.data), as stored. */
export type EconomicsFactData = Record<string, unknown>;

/** The newest active onboarding fact per setup key, only the keys this module reads. */
export type EconomicsFacts = Partial<
  Record<
    'confirm' | 'type' | 'margin' | 'deal_value' | 'profit_per_deal' | 'close_rate' | 'aov_check',
    EconomicsFactData
  >
>;

/**
 * What the owner could still answer to unlock a number, named by the question that is asked today. A lead
 * business without a profit per customer is asked for it (`profit_per_deal`) rather than for the deal value and
 * margin pair, which only owners who answered them earlier still have.
 */
export type EconomicsMissing = 'business_kind' | 'margin' | 'profit_per_deal' | 'close_rate' | 'currency_sar_only';

export type BreakEven = {
  kind: EconomicsKind;
  /**
   * SCALE threshold (pessimistic end of the owner's ranges): the highest revenue per riyal of ad spend the
   * client could need to break even. A budget raise or a tROAS must clear this. e-commerce only.
   */
  break_even_roas: number | null;
  /**
   * SCALE threshold (pessimistic end): the lowest ad spend per lead (SAR) the client could afford.
   * A budget raise, a tCPA or a promoted keyword must stay under this. Leads, services, clinic, local only.
   */
  break_even_cpa: number | null;
  /**
   * CUT threshold (optimistic end of the ranges): the lowest ROAS the client could live with. A campaign is
   * only cut when it is below even this. e-commerce only.
   */
  break_even_roas_cut: number | null;
  /**
   * CUT threshold (optimistic end): the highest ad spend per lead (SAR) the client could afford. Waste is
   * only called waste when it costs more than even this. Leads, services, clinic, local only.
   */
  break_even_cpa_cut: number | null;
  inputs: {
    /** 0..1, the LOW edge of the answered bucket (pessimistic). */
    margin_fraction: number | null;
    /** 0..1, the HIGH edge of the answered bucket (optimistic). */
    margin_fraction_high: number | null;
    /** SAR, low edge. Only the older deal value x margin path uses it. */
    deal_value_sar: number | null;
    /** SAR, high edge. */
    deal_value_sar_high: number | null;
    /** SAR, low edge: what is left of one customer after the costs. */
    profit_per_deal_sar: number | null;
    /** SAR, high edge. */
    profit_per_deal_sar_high: number | null;
    /** 0..1, low edge of the share of contacts that become customers. */
    close_rate_fraction: number | null;
    /** 0..1, high edge. */
    close_rate_fraction_high: number | null;
    /** The average order the account reported and the owner confirmed. Information only. */
    aov_reported: number | null;
  };
  missing: EconomicsMissing[];
  basis: typeof BREAK_EVEN_BASIS;
};

/** Where the break-even numbers are stated. The onboarding deal value is in riyals. */
export const BREAK_EVEN_CURRENCY = 'SAR';

// ---------------------------------------------------------------------------
// Bucket -> a low and a high edge
// ---------------------------------------------------------------------------

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The two edges of an answered bucket. `low` <= `high`, both above zero. */
export type BucketBounds = { low: number; high: number };

/**
 * The two edges of a bucket. A closed bucket keeps its edges. A bucket that
 * starts at 0 has no honest lower edge: low is half of the upper edge. An
 * open-ended top bucket has no upper edge: high is TWICE the lower edge (a
 * documented convention, so «أكثر من 40» reads as 40..80 and not as "anything").
 * Null when the bucket is empty (the "I don't know" answer).
 */
export function bucketBounds(lower: unknown, upper: unknown): BucketBounds | null {
  const lo = finiteOrNull(lower);
  const hi = finiteOrNull(upper);
  if (lo === null && hi === null) return null;
  if (lo !== null && lo > 0) {
    return { low: lo, high: hi !== null && hi > lo ? hi : lo * 2 };
  }
  if (hi !== null && hi > 0) return { low: hi / 2, high: hi };
  return null;
}

/**
 * The edge of a bucket that is worse for the client. `lower` when it is above
 * zero, otherwise half of `upper` (a bucket that starts at 0 has no honest
 * lower edge). Null when the bucket is empty (the "I don't know" answer).
 */
export function conservativeEdge(lower: unknown, upper: unknown): number | null {
  return bucketBounds(lower, upper)?.low ?? null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Margin of every 100 riyals, 0 < x <= 100, as fractions of 1 (the high edge is capped at 100%). */
function marginRange(fact: EconomicsFactData | undefined): BucketBounds | null {
  if (!fact) return null;
  const bounds = bucketBounds(fact.min_per_100, fact.max_per_100);
  if (!bounds || bounds.low > 100) return null;
  return { low: bounds.low / 100, high: Math.min(bounds.high, 100) / 100 };
}

function dealValueRange(fact: EconomicsFactData | undefined): BucketBounds | null {
  return fact ? bucketBounds(fact.min_sar, fact.max_sar) : null;
}

/** Profit per customer after the costs, in riyals. Same bucket shape as the deal value (min_sar, max_sar). */
function profitPerDealRange(fact: EconomicsFactData | undefined): BucketBounds | null {
  return fact ? bucketBounds(fact.min_sar, fact.max_sar) : null;
}

/** The most contacts out of 10 the optimizer assumes become customers on the HIGH edge of any close-rate bucket. */
export const CLOSE_RATE_CAP_OF_10 = 6;

/**
 * The edges of a close-rate bucket in «out of 10» units: the generic bucket
 * edges with the high edge capped at CLOSE_RATE_CAP_OF_10 (and never below the
 * low edge). Shared with the onboarding copy so the line the owner reads and
 * the limit the optimizer holds the account to are the same numbers.
 */
export function closeRateBoundsOf10(lower: unknown, upper: unknown): BucketBounds | null {
  const bounds = bucketBounds(lower, upper);
  if (!bounds || bounds.low > 10) return null;
  return { low: bounds.low, high: Math.max(bounds.low, Math.min(bounds.high, CLOSE_RATE_CAP_OF_10)) };
}

/** "How many of 10 contacts become customers" as fractions of 1. */
function closeRateRange(fact: EconomicsFactData | undefined): BucketBounds | null {
  if (!fact) return null;
  const bounds = closeRateBoundsOf10(fact.min_of_10, fact.max_of_10);
  return bounds ? { low: bounds.low / 10, high: bounds.high / 10 } : null;
}

function aovReported(fact: EconomicsFactData | undefined): number | null {
  if (!fact) return null;
  const aov = finiteOrNull(fact.aov);
  return aov !== null && aov > 0 ? aov : null;
}

// ---------------------------------------------------------------------------
// Which kind of business is this
// ---------------------------------------------------------------------------

const KINDS: readonly EconomicsKind[] = ['ecommerce', 'clinic', 'services', 'local', 'general'];

/** The `type` answer ids (lib/setup/questions.ts TYPE_OPTIONS) -> kind. */
const TYPE_CHOICE_KIND: Record<string, EconomicsKind> = {
  ecommerce: 'ecommerce',
  services: 'services',
  local_store: 'local',
  clinic: 'clinic',
  real_estate: 'services',
  restaurant: 'local',
  education: 'services',
};

/** businesses.sector stores the label of the type option; free text for "other". */
function kindFromSectorLabel(sector: string | null | undefined): EconomicsKind | null {
  const text = String(sector ?? '').trim();
  if (!text) return null;
  if (/متجر|ecommerce|e-commerce|online store/i.test(text)) return 'ecommerce';
  if (/عيادة|طبي|clinic/i.test(text)) return 'clinic';
  if (/محل|فرع|مطعم|كافيه|local/i.test(text)) return 'local';
  if (/خدمات|عقار|مقاولات|تعليم|تدريب|services?/i.test(text)) return 'services';
  return null;
}

/**
 * Business kind from what is on record, most explicit first: the kind the
 * owner confirmed on the opener, the `type` answer, the sector label, which
 * economics questions were answered, and last the primary goal. Falls back to
 * 'general', which has no formula and reports `business_kind` as missing.
 */
export function deriveEconomicsKind(input: {
  facts: EconomicsFacts;
  sector?: string | null;
  primaryGoal?: string | null;
}): EconomicsKind {
  const { facts } = input;

  const confirm = facts.confirm;
  if (confirm && confirm.choice === 'yes' && typeof confirm.kind === 'string') {
    const kind = confirm.kind as EconomicsKind;
    if ((KINDS as readonly string[]).includes(kind) && kind !== 'general') return kind;
  }

  const typeChoice = facts.type && typeof facts.type.choice === 'string' ? facts.type.choice : null;
  if (typeChoice && TYPE_CHOICE_KIND[typeChoice]) return TYPE_CHOICE_KIND[typeChoice];

  const fromSector = kindFromSectorLabel(input.sector);
  if (fromSector) return fromSector;

  // The question that was asked says what the tree thought the business was.
  if (facts.margin && !facts.deal_value && !facts.close_rate && !facts.profit_per_deal) return 'ecommerce';
  if (facts.deal_value || facts.close_rate || facts.profit_per_deal) return 'services';

  if (input.primaryGoal === 'conversions') return 'ecommerce';
  if (input.primaryGoal === 'leads') return 'services';
  return 'general';
}

// ---------------------------------------------------------------------------
// The break-even itself
// ---------------------------------------------------------------------------

export function computeBreakEven(input: {
  facts: EconomicsFacts;
  sector?: string | null;
  primaryGoal?: string | null;
}): BreakEven {
  const kind = deriveEconomicsKind(input);
  const margin = marginRange(input.facts.margin);
  const deal = dealValueRange(input.facts.deal_value);
  const profit = profitPerDealRange(input.facts.profit_per_deal);
  const close = closeRateRange(input.facts.close_rate);

  const missing: EconomicsMissing[] = [];
  let roasScale: number | null = null;
  let roasCut: number | null = null;
  let cpaScale: number | null = null;
  let cpaCut: number | null = null;

  if (kind === 'ecommerce') {
    if (margin === null) {
      missing.push('margin');
    } else {
      // A thin margin needs a big ROAS (scale), a fat margin lives with a small one (cut).
      roasScale = round2(1 / margin.low);
      roasCut = round2(1 / margin.high);
    }
  } else if (kind === 'general') {
    missing.push('business_kind');
  } else {
    // clinic, services, local: a lead only pays for itself through a closed deal. The profit per customer
    // already has the costs taken out, so it needs only the close rate. An owner who answered deal value and
    // margin earlier (and never the profit question) keeps the older product of the three.
    if (profit !== null) {
      if (close === null) {
        missing.push('close_rate');
      } else {
        cpaScale = round2(profit.low * close.low);
        cpaCut = round2(profit.high * close.high);
      }
    } else if (deal !== null && margin !== null) {
      if (close === null) {
        missing.push('close_rate');
      } else {
        cpaScale = round2(deal.low * margin.low * close.low);
        cpaCut = round2(deal.high * margin.high * close.high);
      }
    } else {
      missing.push('profit_per_deal');
      if (close === null) missing.push('close_rate');
    }
  }

  return {
    kind,
    break_even_roas: roasScale,
    break_even_cpa: cpaScale,
    break_even_roas_cut: roasCut,
    break_even_cpa_cut: cpaCut,
    inputs: {
      margin_fraction: margin?.low ?? null,
      margin_fraction_high: margin?.high ?? null,
      deal_value_sar: deal?.low ?? null,
      deal_value_sar_high: deal?.high ?? null,
      profit_per_deal_sar: profit?.low ?? null,
      profit_per_deal_sar_high: profit?.high ?? null,
      close_rate_fraction: close?.low ?? null,
      close_rate_fraction_high: close?.high ?? null,
      aov_reported: aovReported(input.facts.aov_check),
    },
    missing,
    basis: BREAK_EVEN_BASIS,
  };
}

/**
 * The deal value is in riyals, so a CPA break-even can only be compared with
 * an account that spends riyals. A USD or AED account gets no CPA break-even
 * (the same reason the monthly-budget cap is SAR-only: no invented exchange
 * rate). ROAS is a ratio and survives any currency.
 */
export function breakEvenForCurrency(economics: BreakEven, accountCurrency: string | null | undefined): BreakEven {
  const currency = String(accountCurrency ?? BREAK_EVEN_CURRENCY).toUpperCase();
  const hasCpa = economics.break_even_cpa !== null || economics.break_even_cpa_cut !== null;
  if (!hasCpa || currency === BREAK_EVEN_CURRENCY) return economics;
  return {
    ...economics,
    break_even_cpa: null,
    break_even_cpa_cut: null,
    missing: economics.missing.includes('currency_sar_only') ? economics.missing : [...economics.missing, 'currency_sar_only'],
  };
}

/** True when this business has at least one break-even number the optimizer can use. */
export function hasBreakEven(economics: BreakEven | null | undefined): boolean {
  return Boolean(economics && (economics.break_even_roas !== null || economics.break_even_cpa !== null));
}

export type AllowableCpa = {
  value: number;
  source: 'break_even_cpa' | 'account_30d_cpa_fallback';
};

/**
 * The most the account may pay for one conversion before the spend counts as
 * WASTE (pausing a keyword, negating a search term, cutting a budget): the
 * CUT end of the client's range, so only spend that is too expensive even by
 * the owner's most optimistic numbers is called waste. When the client's
 * economics give no CPA, the account's own 30-day CPA stands in and the source
 * says so. The fallback is for waste control only, never for scaling or for a
 * bid target.
 */
export function allowableCpaCut(
  economics: BreakEven | null | undefined,
  accountCpa30d: number | null | undefined
): AllowableCpa | null {
  if (economics && economics.break_even_cpa_cut !== null && economics.break_even_cpa_cut > 0) {
    return { value: economics.break_even_cpa_cut, source: 'break_even_cpa' };
  }
  const fallback = finiteOrNull(accountCpa30d);
  if (fallback !== null && fallback > 0) {
    return { value: round2(fallback), source: 'account_30d_cpa_fallback' };
  }
  return null;
}

/**
 * The most the account may pay for one conversion before spending MORE on it
 * (promoting a keyword) stops being safe: the SCALE end of the client's range.
 * Null when the client's economics give no CPA. There is deliberately no
 * fallback: scaling never rests on the account's own history.
 */
export function allowableCpaScale(economics: BreakEven | null | undefined): AllowableCpa | null {
  if (economics && economics.break_even_cpa !== null && economics.break_even_cpa > 0) {
    return { value: economics.break_even_cpa, source: 'break_even_cpa' };
  }
  return null;
}
