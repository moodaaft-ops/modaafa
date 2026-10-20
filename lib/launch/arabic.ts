/**
 * Arabic keyword spelling variants (google-ads-titan 3.7, "الطبقة العربية").
 *
 * Google documents no special Arabic unification, so the plan spells out the
 * variants people actually type: ة/ه, ى/ي, hamza forms of alef, and the
 * definite article «ال» with and without. Every variant keeps the match type of
 * the keyword it came from. Pure functions; no I/O.
 */

const MARKS = /[\u064b-\u065f\u0670\u0640\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Western digits for Arabic-Indic and Persian digits; collapses spaces; strips tashkeel, tatweel and direction marks. */
export function cleanKeywordText(value: string): string {
  return String(value ?? '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(MARKS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Spelling-insensitive identity used to detect duplicates and collisions (not sent to Google). */
export function normalizeArabicKey(value: string): string {
  return cleanKeywordText(value)
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const ARABIC_LETTER = /[ء-ي]/;
const LATIN = /[A-Za-z]/;

function isArabicWord(word: string) {
  return ARABIC_LETTER.test(word) && !LATIN.test(word) && !/\d/.test(word);
}

/**
 * Words that must never receive «ال»: pronouns, prepositions, question and
 * place words. «قريب مني» becoming «قريب المني» would be wrong Arabic.
 */
const NO_ARTICLE = new Set([
  'مني', 'منك', 'منه', 'لي', 'لك', 'له', 'عندي', 'عندك', 'قريب', 'قريبه', 'حولي', 'جنبي', 'هنا', 'هناك',
  'كم', 'وش', 'ايش', 'اين', 'وين', 'متى', 'كيف', 'ليش', 'في', 'من', 'الى', 'علي', 'على', 'عن', 'مع', 'بدون',
  'اسعار', 'سعر', 'رقم', 'ارقام', 'عروض', 'عرض', 'جدا', 'اون', 'لاين', 'online',
]);

const MAX_WORD_VARIANTS = 3;

function stripArticle(word: string): string {
  // «ال» + at least three letters, so «الف» or «الم» are left alone.
  return word.startsWith('ال') && word.length >= 5 ? word.slice(2) : word;
}

function addArticle(word: string): string {
  return `ال${word}`;
}

function endVariants(word: string): string[] {
  const out = new Set<string>([word]);
  if (word.length < 3) return [...out];
  if (word.endsWith('ة')) out.add(`${word.slice(0, -1)}ه`);
  else if (word.endsWith('ه')) out.add(`${word.slice(0, -1)}ة`);
  if (word.endsWith('ى')) out.add(`${word.slice(0, -1)}ي`);
  else if (word.endsWith('ي') && word.length >= 4) out.add(`${word.slice(0, -1)}ى`);
  return [...out];
}

function alefVariants(word: string): string[] {
  // Hamza forms to the bare alef that people type on a phone. The reverse is
  // ambiguous (is «ابواب» «أبواب» or «إبواب»?) so it is not guessed.
  if (!/[أإآ]/.test(word)) return [word];
  return [word, word.replace(/[أإآ]/g, 'ا')];
}

/** Variants of one word. The original always comes first. */
export function wordVariants(word: string): string[] {
  if (!isArabicWord(word)) return [word];
  const out: string[] = [];
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };
  push(word);
  for (const a of alefVariants(word)) for (const e of endVariants(a)) push(e);
  return out.slice(0, MAX_WORD_VARIANTS * 2);
}

export type VariantOptions = {
  /** Variants kept per keyword, the original included. */
  maxPerKeyword?: number;
  /** Add «ال» to the last word of a multi-word phrase (off by default for short ambiguous input). */
  addArticle?: boolean;
};

/**
 * Spelling variants of one keyword, original first. Combines the end-letter and
 * hamza forms, then the with/without «ال» forms, in a stable order, and stops at
 * `maxPerKeyword` (default 6) so a long phrase cannot explode into hundreds.
 */
export function expandArabicVariants(text: string, options: VariantOptions = {}): string[] {
  const max = Math.max(1, options.maxPerKeyword ?? 6);
  const base = cleanKeywordText(text);
  if (!base) return [];
  const words = base.split(' ');
  if (!words.some(isArabicWord)) return [base];

  const results: string[] = [base];
  const seen = new Set<string>([base]);
  const add = (candidate: string) => {
    const value = candidate.replace(/\s+/g, ' ').trim();
    if (value && !seen.has(value) && results.length < max) {
      seen.add(value);
      results.push(value);
    }
  };

  // 1) One change at a time (a typist makes one slip), left to right.
  words.forEach((word, index) => {
    for (const variant of wordVariants(word).slice(1)) {
      add(words.map((w, i) => (i === index ? variant : w)).join(' '));
    }
  });

  // 2) Article forms of the whole phrase.
  const stripped = words.map((w) => (isArabicWord(w) ? stripArticle(w) : w));
  add(stripped.join(' '));
  if (options.addArticle !== false && words.length >= 2) {
    const lastIndex = words.length - 1;
    const last = stripped[lastIndex];
    const previous = stripped[lastIndex - 1];
    if (
      isArabicWord(last) &&
      !last.startsWith('ال') &&
      last.length >= 3 &&
      !NO_ARTICLE.has(normalizeArabicKey(last)) &&
      !NO_ARTICLE.has(normalizeArabicKey(previous)) &&
      !/^[بلكوف]/.test(last) // prefixed words («بالرياض», «للبيع») already carry a particle
    ) {
      add(stripped.map((w, i) => (i === lastIndex ? addArticle(w) : w)).join(' '));
    }
  }

  // 3) The ة/ه and ى/ي forms of the article-stripped phrase, if room is left.
  words.forEach((word, index) => {
    for (const variant of wordVariants(stripped[index]).slice(1)) {
      add(stripped.map((w, i) => (i === index ? variant : w)).join(' '));
    }
  });

  return results.slice(0, max);
}

export type KeywordLike = { text: string; match_type: 'EXACT' | 'PHRASE' | 'BROAD' };

/**
 * Expands every keyword and removes duplicates. One normalised text appears
 * once per campaign, with the first match type seen (titan 3.7: never repeat a
 * keyword under two match types in one campaign). `seen` carries the keys of
 * keywords already placed in earlier ad groups of the same campaign.
 */
export function expandAndDedupeKeywords(
  keywords: KeywordLike[],
  options: VariantOptions & { seen?: Set<string>; maxTotal?: number } = {}
): { keywords: KeywordLike[]; dropped_duplicates: number; truncated: number } {
  const seen = options.seen ?? new Set<string>();
  const maxTotal = options.maxTotal ?? 60;
  const kept: KeywordLike[] = [];
  const exactTexts = new Set<string>();
  let dropped = 0;
  let truncated = 0;

  // Originals first, so a cap never removes something the merchant asked for in favour of a variant.
  const originals = keywords.map((k) => ({ ...k, text: cleanKeywordText(k.text) })).filter((k) => k.text);
  const queue: KeywordLike[] = [];
  const variantQueue: KeywordLike[] = [];
  for (const keyword of originals) {
    queue.push(keyword);
    for (const variant of expandArabicVariants(keyword.text, options).slice(1)) {
      variantQueue.push({ text: variant, match_type: keyword.match_type });
    }
  }
  for (const keyword of [...queue, ...variantQueue]) {
    const key = keyword.text.toLowerCase();
    if (exactTexts.has(key) || seen.has(key)) {
      dropped += 1;
      continue;
    }
    if (kept.length >= maxTotal) {
      truncated += 1;
      continue;
    }
    exactTexts.add(key);
    kept.push(keyword);
  }
  for (const keyword of kept) seen.add(keyword.text.toLowerCase());
  return { keywords: kept, dropped_duplicates: dropped, truncated };
}
