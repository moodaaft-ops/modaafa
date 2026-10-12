/**
 * Anthropic price table used to turn `response.usage` into USD.
 *
 * Source: Anthropic pricing page, read 12 Oct 2026. Prices are USD per million
 * tokens. Bump PRICING_VERSION whenever a number below changes: every
 * llm_usage row stores the version it was priced with, so old rows stay
 * explainable after a price change.
 */
export const PRICING_VERSION = '2026-10-12';

export type TokenRates = {
  input: number;
  output: number;
  cacheRead: number;
  /** 5 minute cache write. */
  cacheWrite: number;
};

type PriceEntry = {
  /** Model id prefix; date suffixes such as -20251001 are matched by prefix. */
  prefix: string;
  rates: TokenRates;
  /**
   * Some models bill a higher rate once a single request's prompt (input +
   * cache read + cache write tokens) is larger than the threshold.
   */
  longPrompt?: { aboveTokens: number; rates: TokenRates };
};

const SONNET_4_RATES: TokenRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export const PRICE_TABLE: readonly PriceEntry[] = [
  { prefix: 'claude-opus-5-5', rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { prefix: 'claude-sonnet-5-5', rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  {
    prefix: 'claude-haiku-5-5',
    rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    longPrompt: {
      aboveTokens: 100_000,
      rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
  { prefix: 'claude-opus-5', rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { prefix: 'claude-sonnet-5', rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { prefix: 'claude-haiku-4-5', rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { prefix: 'claude-opus-4-1', rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { prefix: 'claude-sonnet-4-6', rates: SONNET_4_RATES },
  { prefix: 'claude-sonnet-4-5', rates: SONNET_4_RATES },
  { prefix: 'claude-sonnet-4', rates: SONNET_4_RATES },
];

/** Unknown models are priced at the most expensive known rate, never at zero. */
export const FALLBACK_RATES: TokenRates = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };

/** The shape of Anthropic's `response.usage` (cache fields are optional or null). */
export type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type ModelPrice = TokenRates & {
  /** The table prefix that matched, or null for the conservative fallback. */
  matched: string | null;
  priced: boolean;
};

/**
 * A prefix only counts when what follows it is nothing or a date suffix
 * (`-20251001`) or `-latest`. Without this, a future `claude-opus-5-6` would
 * silently match `claude-opus-5` and be recorded as priced at the wrong rate;
 * it is flagged unpriced (and costed conservatively) instead.
 */
function prefixMatches(model: string, prefix: string) {
  if (!model.startsWith(prefix)) return false;
  const rest = model.slice(prefix.length);
  return rest === '' || /^-(?:\d{8}|latest)$/.test(rest);
}

/**
 * Price of a model by longest matching prefix. `promptTokens` (input + cache
 * read + cache write of one request) only matters for models with a
 * long-prompt tier.
 */
export function priceFor(model: string | null | undefined, promptTokens = 0): ModelPrice {
  const id = String(model ?? '').trim().toLowerCase();
  let best: PriceEntry | null = null;
  for (const entry of PRICE_TABLE) {
    if (!prefixMatches(id, entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  if (!best) return { ...FALLBACK_RATES, matched: null, priced: false };

  const rates =
    best.longPrompt && promptTokens > best.longPrompt.aboveTokens ? best.longPrompt.rates : best.rates;
  return { ...rates, matched: best.prefix, priced: true };
}

function tokens(value: number | null | undefined) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** USD cost of one request, rounded to 6 decimals, and whether the model was in the table. */
export function costUsd(
  model: string | null | undefined,
  usage: AnthropicUsage | null | undefined
): { costUsd: number; priced: boolean } {
  const input = tokens(usage?.input_tokens);
  const output = tokens(usage?.output_tokens);
  const cacheRead = tokens(usage?.cache_read_input_tokens);
  const cacheWrite = tokens(usage?.cache_creation_input_tokens);

  const price = priceFor(model, input + cacheRead + cacheWrite);
  // rate (USD per million tokens) x tokens = micro-USD, so summing in micro-USD
  // and rounding once avoids accumulating float noise.
  const micro =
    input * price.input +
    output * price.output +
    cacheRead * price.cacheRead +
    cacheWrite * price.cacheWrite;

  return { costUsd: Math.round(micro) / 1e6, priced: price.priced };
}
