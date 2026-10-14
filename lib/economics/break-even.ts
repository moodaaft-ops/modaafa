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
 * onboarding answers into the two numbers that matter:
 *
 *   e-commerce        break_even_roas = 1 / margin
 *   leads, services,  break_even_cpa  = deal value x margin x close rate
 *   clinic, local
 *
 * The answers are buckets, not numbers («من 20 إلى 40»). We always take the
 * edge of the bucket that is worse for the client, so the break-even we hand
 * the optimizer is never rosier than the truth:
 *
 *   margin       lt20 -> 10%   20_40 -> 20%   gt40 -> 40%
 *   deal value   lt2k -> 1,000   2k_10k -> 2,000   10k_50k -> 10,000   gt50k -> 50,000 SAR
 *   close rate   le1  -> 0.5 of 10   2_3 -> 2 of 10   ge4 -> 4 of 10
 *
 * Rule: the lower edge of the bucket; when the lower edge is 0 (an open-ended
 * "less than X" bucket) half of the upper edge. A lower margin means a HIGHER
 * break-even ROAS, a lower deal value or close rate means a LOWER break-even
 * CPA, so scaling decisions that compare against these numbers err on the
 * side of doing nothing. The price of that safety is stated in the report that
 * ships with this change: the same conservative number also makes the
 * "cut spend" rule fire sooner than an exact figure would.
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
  Record<'confirm' | 'type' | 'margin' | 'deal_value' | 'close_rate' | 'aov_check', EconomicsFactData>
>;

export type EconomicsMissing = 'business_kind' | 'margin' | 'deal_value' | 'close_rate' | 'currency_sar_only';

export type BreakEven = {
  kind: EconomicsKind;
  /** Revenue per riyal of ad spend below which the client loses money. e-commerce only. */
  break_even_roas: number | null;
  /** Ad spend per lead (SAR) above which the client loses money. Leads, services, clinic, local only. */
  break_even_cpa: number | null;
  inputs: {
    /** 0..1, the conservative edge of the answered bucket. */
    margin_fraction: number | null;
    /** SAR. */
    deal_value_sar: number | null;
    /** 0..1, share of contacts that become customers. */
    close_rate_fraction: number | null;
    /** The average order the account reported and the owner confirmed. Information only. */
    aov_reported: number | null;
  };
  missing: EconomicsMissing[];
  basis: typeof BREAK_EVEN_BASIS;
};

/** Where the break-even numbers are stated. The onboarding deal value is in riyals. */
export const BREAK_EVEN_CURRENCY = 'SAR';

// ---------------------------------------------------------------------------
// Bucket -> one conservative number
// ---------------------------------------------------------------------------

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The edge of a bucket that is worse for the client. `lower` when it is above
 * zero, otherwise half of `upper` (a bucket that starts at 0 has no honest
 * lower edge). Null when the bucket is empty (the "I don't know" answer).
 */
export function conservativeEdge(lower: unknown, upper: unknown): number | null {
  const lo = finiteOrNull(lower);
  const hi = finiteOrNull(upper);
  if (lo === null && hi === null) return null;
  if (lo !== null && lo > 0) return lo;
  if (hi !== null && hi > 0) return hi / 2;
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Margin of every 100 riyals, 0 < x <= 100, as a fraction. */
function marginFraction(fact: EconomicsFactData | undefined): number | null {
  if (!fact) return null;
  const edge = conservativeEdge(fact.min_per_100, fact.max_per_100);
  return edge !== null && edge > 0 && edge <= 100 ? edge / 100 : null;
}

function dealValueSar(fact: EconomicsFactData | undefined): number | null {
  if (!fact) return null;
  const edge = conservativeEdge(fact.min_sar, fact.max_sar);
  return edge !== null && edge > 0 ? edge : null;
}

/** "How many of 10 contacts become customers" as a fraction of 1. */
function closeRateFraction(fact: EconomicsFactData | undefined): number | null {
  if (!fact) return null;
  const edge = conservativeEdge(fact.min_of_10, fact.max_of_10);
  return edge !== null && edge > 0 && edge <= 10 ? edge / 10 : null;
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
  if (facts.margin && !facts.deal_value && !facts.close_rate) return 'ecommerce';
  if (facts.deal_value || facts.close_rate) return 'services';

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
  const margin = marginFraction(input.facts.margin);
  const deal = dealValueSar(input.facts.deal_value);
  const close = closeRateFraction(input.facts.close_rate);

  const missing: EconomicsMissing[] = [];
  let breakEvenRoas: number | null = null;
  let breakEvenCpa: number | null = null;

  if (kind === 'ecommerce') {
    if (margin === null) missing.push('margin');
    else breakEvenRoas = round2(1 / margin);
  } else if (kind === 'general') {
    missing.push('business_kind');
  } else {
    // clinic, services, local: a lead only pays for itself through a closed deal.
    if (deal === null) missing.push('deal_value');
    if (close === null) missing.push('close_rate');
    if (margin === null) missing.push('margin');
    if (deal !== null && close !== null && margin !== null) breakEvenCpa = round2(deal * margin * close);
  }

  return {
    kind,
    break_even_roas: breakEvenRoas,
    break_even_cpa: breakEvenCpa,
    inputs: {
      margin_fraction: margin,
      deal_value_sar: deal,
      close_rate_fraction: close,
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
  if (economics.break_even_cpa === null || currency === BREAK_EVEN_CURRENCY) return economics;
  return {
    ...economics,
    break_even_cpa: null,
    missing: economics.missing.includes('currency_sar_only') ? economics.missing : [...economics.missing, 'currency_sar_only'],
  };
}

/** True when this business has at least one break-even number the optimizer can use. */
export function hasBreakEven(economics: BreakEven | null | undefined): boolean {
  return Boolean(economics && (economics.break_even_roas !== null || economics.break_even_cpa !== null));
}

/**
 * The most the account may pay for one conversion before the spend counts as
 * waste. The client's break-even CPA when it is known; otherwise the account's
 * own 30-day CPA, and the source is stated so nobody mistakes it for a target.
 * The fallback is for waste control (pausing, negating) only, never for
 * scaling or for setting a bid target.
 */
export function allowableCpa(
  economics: BreakEven | null | undefined,
  accountCpa30d: number | null | undefined
): { value: number; source: 'break_even_cpa' | 'account_30d_cpa_fallback' } | null {
  if (economics && economics.break_even_cpa !== null && economics.break_even_cpa > 0) {
    return { value: economics.break_even_cpa, source: 'break_even_cpa' };
  }
  const fallback = finiteOrNull(accountCpa30d);
  if (fallback !== null && fallback > 0) {
    return { value: round2(fallback), source: 'account_30d_cpa_fallback' };
  }
  return null;
}
