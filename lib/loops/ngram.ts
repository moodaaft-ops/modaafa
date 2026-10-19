/**
 * N-gram analysis of search terms (google-ads-titan keywords-search-terms 7.2).
 *
 * Instead of reading a thousand search terms one by one, break each into its
 * words (1-gram), word pairs (2-gram) and word triples (3-gram), and add up
 * cost, clicks, conversions and value per piece. A piece that shows up in many
 * terms and spends without a single conversion is the real negative keyword
 * ("وظائف", "مجانا", "pdf").
 *
 * Pure: no database, no Google Ads, no clock. It imports only the Arabic
 * folding of the negative-words module, so it can be loaded from the
 * optimizer prompt module without an import cycle.
 *
 * Arabic: «ة» and «ه», «ى» and «ي», «أ إ آ» and «ا» are one letter for grouping
 * (foldWord), and a leading «ال» or «و» is peeled (groupKey), so «الوظائف»,
 * «وظائف» and «وظايف» land in the same bucket. The gram shown back keeps the
 * spelling people typed most often.
 *
 * Waste rule: a gram is flagged when it has NO conversion at all, its cost is
 * at least 2 x the allowable CPA (the CUT end of the owner's break-even, see
 * lib/economics/break-even.ts allowableCpaCut), it sits in at least 2 distinct
 * terms and it has at least 5 clicks. A gram with only a fractional conversion
 * (0 < c < 1, the data-driven attribution crumbs) is NOT flagged: that is a
 * signal, not waste. Words of the business itself (name, sector, keywords) are
 * never flagged.
 */

import { foldWord, groupKey, isStopwordToken, tokenize } from '../jarvis/tools/negative-words';

export type TermStat = {
  term: string;
  clicks: number;
  impressions: number;
  cost: number;
  conversions: number;
  value: number;
};

export type AllowableCpaInput = { value: number; source: string } | null;

export type GramEntry = {
  gram: string;
  n: 1 | 2 | 3;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  value: number;
  /** Distinct search terms that contain the gram. */
  terms: number;
  cpa: number | null;
  conv_rate: number | null;
  roas: number | null;
  /** Share of the scanned spend, 0 to 100 with one decimal. */
  share_of_spend_pct: number | null;
  sample_terms: string[];
};

export type NgramAnalysis = {
  window_days: number;
  terms_scanned: number;
  spend_scanned: number;
  allowable_cpa: AllowableCpaInput;
  /** 2 x allowable CPA: the cost a gram must reach, with no conversion, to be flagged. Null when no CPA is known. */
  waste_threshold: number | null;
  /** Grams that spend with no conversion past the threshold. Largest cost first. */
  wasteful: GramEntry[];
  /** Cost of the DISTINCT terms covered by the flagged grams (a term under two flagged grams counts once). */
  wasteful_terms_cost: number;
  /** Grams with 2+ conversions, best first. */
  winners: GramEntry[];
  note: 'ok' | 'no_allowable_cpa' | 'no_terms';
};

export const WASTE_COST_MULTIPLE = 2;
export const WASTE_MIN_TERMS = 2;
export const WASTE_MIN_CLICKS = 5;
export const WINNER_MIN_CONVERSIONS = 2;
const MAX_WASTEFUL = 14;
const MAX_WINNERS = 8;
const SAMPLE_TERMS = 2;
const NO_CONVERSION = 0.000001;

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function ratio(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const value = a / b;
  return Number.isFinite(value) ? value : null;
}

type Token = { original: string; key: string; stop: boolean };

/**
 * The usable words of a term, in runs. Digits-only and one-letter tokens break
 * a run, so a gram never joins two words that were not neighbours.
 */
function runsOf(term: string): Token[][] {
  const runs: Token[][] = [];
  let current: Token[] = [];
  for (const original of tokenize(term)) {
    const folded = foldWord(original);
    const key = groupKey(folded);
    const usable = !/^\p{N}+$/u.test(folded) && Array.from(key).length >= 2;
    if (!usable) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push({ original: original.toLowerCase(), key, stop: isStopwordToken(original) });
  }
  if (current.length) runs.push(current);
  return runs;
}

/** The grams of one term as [key, shown form] pairs. A gram counts once per term. */
export function gramsOfTerm(term: string, maxN: 1 | 2 | 3 = 3): Array<{ key: string; shown: string; n: 1 | 2 | 3 }> {
  const seen = new Map<string, { key: string; shown: string; n: 1 | 2 | 3 }>();
  for (const run of runsOf(term)) {
    for (let n = 1; n <= maxN; n += 1) {
      for (let start = 0; start + n <= run.length; start += 1) {
        const slice = run.slice(start, start + n);
        // A gram of filler words says nothing, and a longer gram that opens or closes on a filler word duplicates a shorter one.
        if (slice.every((t) => t.stop)) continue;
        if (n > 1 && (slice[0].stop || slice[n - 1].stop)) continue;
        const key = slice.map((t) => t.key).join(' ');
        if (!seen.has(key)) seen.set(key, { key, shown: slice.map((t) => t.original).join(' '), n: n as 1 | 2 | 3 });
      }
    }
  }
  return [...seen.values()];
}

type Accumulator = {
  n: 1 | 2 | 3;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  value: number;
  termIndexes: number[];
  forms: Map<string, number>;
};

/** Adds the terms up per gram. Exported for the tests. */
export function aggregateGrams(terms: TermStat[], maxN: 1 | 2 | 3 = 3): Map<string, Accumulator> {
  const grams = new Map<string, Accumulator>();
  terms.forEach((row, index) => {
    for (const { key, shown, n } of gramsOfTerm(row.term, maxN)) {
      let acc = grams.get(key);
      if (!acc) {
        acc = { n, cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0, termIndexes: [], forms: new Map() };
        grams.set(key, acc);
      }
      acc.cost += row.cost;
      acc.clicks += row.clicks;
      acc.impressions += row.impressions;
      acc.conversions += row.conversions;
      acc.value += row.value;
      acc.termIndexes.push(index);
      acc.forms.set(shown, (acc.forms.get(shown) ?? 0) + 1);
    }
  });
  return grams;
}

function mostCommon(forms: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [form, count] of forms) {
    if (count > bestCount || (count === bestCount && form < best)) {
      best = form;
      bestCount = count;
    }
  }
  return best;
}

function toEntry(key: string, acc: Accumulator, terms: TermStat[], totalCost: number): GramEntry {
  const distinct = [...new Set(acc.termIndexes)];
  const sample = distinct
    .map((index) => terms[index])
    .sort((a, b) => b.cost - a.cost)
    .slice(0, SAMPLE_TERMS)
    .map((row) => row.term);
  const share = ratio(acc.cost, totalCost);
  return {
    gram: mostCommon(acc.forms) || key,
    n: acc.n,
    cost: round(acc.cost),
    clicks: acc.clicks,
    impressions: acc.impressions,
    conversions: round(acc.conversions, 2),
    value: round(acc.value),
    terms: distinct.length,
    cpa: acc.conversions >= 1 ? round(acc.cost / acc.conversions) : null,
    conv_rate: (() => {
      const r = ratio(acc.conversions, acc.clicks);
      return r === null ? null : round(r * 100, 1);
    })(),
    roas: (() => {
      const r = ratio(acc.value, acc.cost);
      return r === null || acc.value <= 0 ? null : round(r, 2);
    })(),
    share_of_spend_pct: share === null ? null : round(share * 100, 1),
    sample_terms: sample,
  };
}

/** Keys of the grams inside a longer gram key (its sub-grams of 1 or 2 words). */
function subGramKeys(key: string): string[] {
  const words = key.split(' ');
  const out: string[] = [];
  for (let n = 1; n < words.length; n += 1) {
    for (let start = 0; start + n <= words.length; start += 1) out.push(words.slice(start, start + n).join(' '));
  }
  return out;
}

export function analyzeNgrams(input: {
  terms: TermStat[];
  allowableCpa: AllowableCpaInput;
  /** Business name, sector and keywords: their words are never flagged. */
  protectedTexts?: Array<string | null | undefined>;
  windowDays?: number;
  maxN?: 1 | 2 | 3;
}): NgramAnalysis {
  const windowDays = input.windowDays ?? 30;
  const terms = input.terms.filter((row) => row.term.trim().length > 0 && Number.isFinite(row.cost));
  const totalCost = terms.reduce((sum, row) => sum + row.cost, 0);
  const allowable = input.allowableCpa && input.allowableCpa.value > 0 ? input.allowableCpa : null;
  const threshold = allowable ? round(allowable.value * WASTE_COST_MULTIPLE) : null;

  const base: NgramAnalysis = {
    window_days: windowDays,
    terms_scanned: terms.length,
    spend_scanned: round(totalCost),
    allowable_cpa: allowable,
    waste_threshold: threshold,
    wasteful: [],
    wasteful_terms_cost: 0,
    winners: [],
    note: terms.length === 0 ? 'no_terms' : allowable ? 'ok' : 'no_allowable_cpa',
  };
  if (terms.length === 0) return base;

  const grams = aggregateGrams(terms, input.maxN ?? 3);

  const protectedKeys = new Set<string>();
  for (const text of input.protectedTexts ?? []) {
    if (!text) continue;
    for (const token of tokenize(text)) protectedKeys.add(groupKey(foldWord(token)));
  }
  const touchesProtected = (key: string) => key.split(' ').some((word) => protectedKeys.has(word));

  const winners = [...grams.entries()]
    .filter(([, acc]) => acc.conversions >= WINNER_MIN_CONVERSIONS)
    .map(([key, acc]) => toEntry(key, acc, terms, totalCost))
    .sort((a, b) => b.conversions - a.conversions || (a.cpa ?? Infinity) - (b.cpa ?? Infinity) || a.gram.localeCompare(b.gram))
    .slice(0, MAX_WINNERS);

  if (threshold === null) return { ...base, winners };

  const flaggedKeys = new Map<string, Accumulator>();
  for (const [key, acc] of grams) {
    if (acc.conversions > NO_CONVERSION) continue;
    if (acc.cost < threshold) continue;
    if (acc.clicks < WASTE_MIN_CLICKS) continue;
    if (new Set(acc.termIndexes).size < WASTE_MIN_TERMS) continue;
    if (touchesProtected(key)) continue;
    flaggedKeys.set(key, acc);
  }

  // A longer gram that adds nothing over a flagged shorter one (same money) is noise.
  const kept = [...flaggedKeys.entries()].filter(([key, acc]) => {
    if (acc.n === 1) return true;
    return !subGramKeys(key).some((sub) => {
      const parent = flaggedKeys.get(sub);
      return parent !== undefined && parent.cost >= acc.cost * 0.9;
    });
  });

  const wasteful = kept
    .map(([key, acc]) => toEntry(key, acc, terms, totalCost))
    .sort((a, b) => b.cost - a.cost || a.gram.localeCompare(b.gram))
    .slice(0, MAX_WASTEFUL);

  const covered = new Set<number>();
  for (const [, acc] of kept) for (const index of acc.termIndexes) covered.add(index);
  const wastefulTermsCost = [...covered].reduce((sum, index) => sum + terms[index].cost, 0);

  return { ...base, wasteful, wasteful_terms_cost: round(wastefulTermsCost), winners };
}
