/**
 * Negative word candidates from wasted search terms. Pure functions, no I/O.
 *
 * Spelling normalization exists for GROUPING only. The word reported back keeps
 * the spelling people actually typed (most common one wins), because that is
 * what would be added as a negative keyword.
 */

const MARKS_AND_TATWEEL = /[ً-ٰٟۖ-ۭـ]/g;

/** Arabic and English filler that never makes a useful negative on its own. */
const STOPWORDS_RAW = [
  // Arabic
  'في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'هل', 'ما', 'ماهو', 'ماهي', 'هو', 'هي', 'هذا', 'هذه',
  'ذلك', 'تلك', 'او', 'أو', 'ثم', 'كل', 'بين', 'عند', 'قبل', 'بعد', 'لا', 'لم', 'لن', 'ان', 'إن',
  'انا', 'انت', 'اي', 'أي', 'كيف', 'وين', 'متى', 'لو', 'له', 'لها', 'به', 'بها', 'ابي', 'أبي',
  'ابغى', 'أبغى', 'ابغي', 'ودي', 'وش', 'ايش', 'شنو', 'كم', 'الي', 'التي', 'الذي',
  // English
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'at', 'by', 'is', 'are',
  'how', 'what', 'where', 'near', 'me', 'my', 'from', 'vs', 'i', 'you', 'it', 'this', 'that',
];

/** Letters-only form: NFKC, lowercase, no diacritics or tatweel, أ إ آ to ا, ة to ه, ى to ي. */
export function foldWord(word: string): string {
  return word
    .normalize('NFKC')
    .toLowerCase()
    .replace(MARKS_AND_TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىی]/g, 'ي')
    .replace(/ک/g, 'ك');
}

function letterCount(word: string) {
  return Array.from(word).length;
}

/**
 * Grouping key: folded word without a leading «ال» or «و» when 3 or more letters
 * remain. Prefixes are peeled until stable so «الوظائف» and «وظائف» group together.
 */
export function groupKey(folded: string): string {
  let word = folded;
  for (let i = 0; i < 3; i += 1) {
    if (word.startsWith('ال') && letterCount(word) - 2 >= 3) {
      word = word.slice(2);
      continue;
    }
    if (word.startsWith('و') && letterCount(word) - 1 >= 3) {
      word = word.slice(1);
      continue;
    }
    break;
  }
  return word;
}

const STOPWORDS = new Set(
  STOPWORDS_RAW.flatMap((word) => {
    const folded = foldWord(word);
    return [folded, groupKey(folded)];
  })
);

/** Splits on anything that is not a letter, digit or combining mark (drops punctuation). */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length > 0);
}

type KeyedToken = { original: string; folded: string; key: string };

function keyedTokens(text: string): KeyedToken[] {
  return tokenize(text).map((original) => {
    const folded = foldWord(original);
    return { original, folded, key: groupKey(folded) };
  });
}

/** True when the token can be a negative word candidate at all. */
function isUsableToken(token: KeyedToken) {
  if (/^\p{N}+$/u.test(token.folded)) return false;
  if (letterCount(token.key) < 2) return false;
  if (STOPWORDS.has(token.folded) || STOPWORDS.has(token.key)) return false;
  return true;
}

/** Normalized whole-phrase identity, used to count DISTINCT terms. */
export function termIdentity(text: string): string {
  return keyedTokens(text)
    .map((token) => token.folded)
    .join(' ');
}

/** Keys (and folded forms) of every word in the given texts. Used for exclusion. */
export function protectedWordKeys(texts: Array<string | null | undefined>): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const token of keyedTokens(text)) {
      keys.add(token.folded);
      keys.add(token.key);
    }
  }
  return keys;
}

export type WastedTerm = {
  term: string;
  cost: number;
  clicks: number;
  campaignResource: string;
  campaignId: string;
  campaignName: string;
};

export type NegativeWordCandidate = {
  word: string;
  key: string;
  cost: number;
  clicks: number;
  termCount: number;
  campaigns: Array<{ resource: string; id: string; name: string; cost: number }>;
  sampleTerms: string[];
};

type Accumulator = {
  spellings: Map<string, number>;
  terms: Map<string, { term: string; cost: number }>;
  cost: number;
  clicks: number;
  campaigns: Map<string, { resource: string; id: string; name: string; cost: number }>;
};

export function buildNegativeWordCandidates(input: {
  wasted: WastedTerm[];
  /** Terms that produced conversions anywhere in the result. Their words are never candidates. */
  convertingTerms: string[];
  /** Business name, sector, keywords. Their words are never candidates. */
  protectedTexts: Array<string | null | undefined>;
  minTerms?: number;
  limit?: number;
}): NegativeWordCandidate[] {
  const minTerms = input.minTerms ?? 3;
  const limit = input.limit ?? 10;
  const protectedKeys = protectedWordKeys([...input.convertingTerms, ...input.protectedTexts]);
  const groups = new Map<string, Accumulator>();

  for (const row of input.wasted) {
    const identity = termIdentity(row.term);
    const seenInRow = new Set<string>();
    for (const token of keyedTokens(row.term)) {
      if (!isUsableToken(token) || seenInRow.has(token.key)) continue;
      seenInRow.add(token.key);

      let group = groups.get(token.key);
      if (!group) {
        group = { spellings: new Map(), terms: new Map(), cost: 0, clicks: 0, campaigns: new Map() };
        groups.set(token.key, group);
      }
      group.spellings.set(token.original, (group.spellings.get(token.original) ?? 0) + 1);
      const knownTerm = group.terms.get(identity);
      group.terms.set(identity, { term: row.term, cost: (knownTerm?.cost ?? 0) + row.cost });
      group.cost += row.cost;
      group.clicks += row.clicks;
      const campaign = group.campaigns.get(row.campaignResource);
      if (campaign) campaign.cost += row.cost;
      else
        group.campaigns.set(row.campaignResource, {
          resource: row.campaignResource,
          id: row.campaignId,
          name: row.campaignName,
          cost: row.cost,
        });
    }
  }

  const candidates: NegativeWordCandidate[] = [];
  for (const [key, group] of groups) {
    if (group.terms.size < minTerms) continue;
    let word = '';
    let best = 0;
    for (const [spelling, count] of group.spellings) {
      if (count > best) {
        best = count;
        word = spelling;
      }
    }
    if (protectedKeys.has(key) || protectedKeys.has(foldWord(word))) continue;
    candidates.push({
      word,
      key,
      cost: group.cost,
      clicks: group.clicks,
      termCount: group.terms.size,
      campaigns: [...group.campaigns.values()].sort((a, b) => b.cost - a.cost),
      sampleTerms: [...group.terms.values()]
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 3)
        .map((entry) => entry.term),
    });
  }

  return candidates
    .sort((a, b) => b.cost - a.cost || b.clicks - a.clicks || a.word.localeCompare(b.word))
    .slice(0, limit);
}
