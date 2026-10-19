/**
 * Neutral, pure validators for Google Ads text assets (RSA headlines and
 * descriptions, callouts, sitelink text, structured snippet values).
 *
 * No imports from the rest of the app on purpose: lib/launch (the campaign
 * launcher) has its own RSA validators and should reuse these instead, so the
 * rules live in one place. Nothing here talks to Google or a model.
 *
 * Every rule is a hard rule: a text that fails is never shipped, it is
 * dropped or the batch is retried. Model text goes through validateAssetText
 * and validateCandidateSet before it can reach an approval card.
 */

export type AssetTextKind =
  | 'headline'
  | 'description'
  | 'callout'
  | 'sitelink_text'
  | 'sitelink_description'
  | 'snippet_value'
  | 'path'
  // Performance Max asset group text (CAMPAIGN_LAUNCH_PMAX_ENABLED).
  | 'long_headline'
  | 'business_name';

export const ASSET_LIMITS: Readonly<Record<AssetTextKind, { min: number; max: number }>> = {
  headline: { min: 3, max: 30 },
  description: { min: 15, max: 90 },
  callout: { min: 3, max: 25 },
  sitelink_text: { min: 3, max: 25 },
  sitelink_description: { min: 5, max: 35 },
  snippet_value: { min: 2, max: 25 },
  path: { min: 1, max: 15 },
  long_headline: { min: 10, max: 90 },
  business_name: { min: 2, max: 25 },
};

export const RSA_LIMITS = {
  minHeadlines: 3,
  maxHeadlines: 15,
  minDescriptions: 2,
  maxDescriptions: 4,
} as const;

export type AdLanguage = 'ar' | 'en';

export type TextCheck = { ok: true; text: string } | { ok: false; code: string; detail?: string };

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXT_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic and Persian digits to Latin digits. */
export function toLatinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) return String(a);
    return String(EXT_ARABIC_INDIC.indexOf(ch));
  });
}

const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿­]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TASHKEEL = /[ً-ٰٟ]/g;

/**
 * Length the way Google counts it for a text asset: one per character, and a
 * full-width (CJK) character counts as two. Arabic letters, marks and digits
 * are one each. Code points, not UTF-16 units, so nothing outside the BMP is
 * counted twice by accident.
 */
export function adTextLength(text: string): number {
  let total = 0;
  for (const ch of Array.from(text.normalize('NFC'))) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    total += wide ? 2 : 1;
  }
  return total;
}

/** Spelling-insensitive Arabic form: marks, tatweel, alef/ya/ta-marbuta variants folded. */
export function normalizeText(value: string): string {
  return toLatinDigits(value.normalize('NFKC'))
    .replace(TASHKEEL, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'في', 'من', 'علي', 'الي', 'عن', 'مع', 'او', 'و', 'ما', 'هذا', 'هذه', 'لك', 'لنا', 'لكم', 'انت', 'نحن', 'بين', 'كل',
  'the', 'a', 'an', 'and', 'for', 'of', 'to', 'in', 'with', 'your', 'our', 'you', 'we', 'at', 'on', 'by', 'is', 'are',
]);

function contentTokens(value: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(value).split(' ')) {
    if (!raw) continue;
    let token = raw;
    if (/^[؀-ۿ]/.test(token)) {
      token = token.replace(/^(?:وال|بال|لل|ال)/, '');
      if (token.length > 4) token = token.replace(/(?:ات|ون|ين)$/, '');
    } else if (token.length > 3) {
      token = token.replace(/s$/, '');
    }
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Heuristic for "says the same thing": identical after normalisation, one is
 * contained in the other (two or more content tokens), or the content tokens
 * overlap by 60% or more. Not a semantic model: two texts with different words
 * and the same meaning pass, which is why the writer prompt also asks for
 * distinct angles.
 */
export function sameMeaning(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const smaller = Math.min(ta.size, tb.size);
  if (shared === smaller && smaller >= 2) return true;
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= 0.6;
}

// ---------------------------------------------------------------------------
// Grounding: what the model was allowed to know
// ---------------------------------------------------------------------------

export type Grounding = {
  /** normalised corpus of every allowed source text */
  corpus: string;
  numbers: ReadonlySet<string>;
  /** Latin words exactly as written in the sources (brand names, model codes) */
  latinWords: ReadonlySet<string>;
  /** Latin words written in capitals in the sources (allowed to stay in capitals) */
  capsWords: ReadonlySet<string>;
};

export function extractNumbers(value: string): string[] {
  const text = toLatinDigits(value).replace(/(\d)[,٬](?=\d{3}\b)/g, '$1');
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''));
}

export function buildGrounding(sources: ReadonlyArray<string | null | undefined>): Grounding {
  const parts = sources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const numbers = new Set<string>();
  const latin = new Set<string>();
  const caps = new Set<string>();
  for (const part of parts) {
    for (const n of extractNumbers(part)) numbers.add(n);
    for (const w of part.match(/[A-Za-z][A-Za-z0-9&'-]*/g) ?? []) {
      latin.add(w.toLowerCase());
      if (w.length >= 2 && w === w.toUpperCase()) caps.add(w.toLowerCase());
    }
  }
  return { corpus: normalizeText(parts.join(' \n ')), numbers, latinWords: latin, capsWords: caps };
}

// ---------------------------------------------------------------------------
// Banned patterns
// ---------------------------------------------------------------------------

/** Words that make an unverifiable claim. Allowed only when a source text already says them. */
const CLAIM_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: 'best', re: /(?:^|\s)(?:الافضل|افضل|الاحسن|احسن|الاول|رقم 1|رقم واحد|الاقوي|الاكبر|الاضمن|الاسرع)(?:\s|$)/ },
  { code: 'cheapest', re: /(?:^|\s)(?:الارخص|ارخص|اقل الاسعار|اقل سعر|بدون منافس|لا يقارن|بلا منافس)(?:\s|$)/ },
  { code: 'guarantee', re: /(?:ضمان|نضمن|مضمون|مضمونه|مضمونة|100%)/ },
  { code: 'only', re: /(?:^|\s)(?:الوحيد|الوحيدة|حصري|حصريا|حصريه)(?:\s|$)/ },
  { code: 'certified', re: /(?:^|\s)(?:معتمد|معتمده|مرخص|مرخصه|رسمي|الرسمي|موثوق)(?:\s|$)/ },
  { code: 'quantity', re: /(?:مئات|مئه|الاف|آلاف|ملايين|الاف العملاء)/ },
  { code: 'free', re: /(?:مجان|بدون رسوم|بدون تكلفه|بلا تكلفه)/ },
  { code: 'offer', re: /(?:خصم|تخفيض|تخفيضات|تقسيط|كاش باك|اسعار مخفضه|عرض خاص|عروض خاصه|تنزيلات)/ },
  {
    code: 'best_en',
    re: /(?:^|\s)(?:best|#1|no 1|number one|top rated|cheapest|guaranteed?|official|certified|leading|lowest price|free|discount|sale|offer)(?:\s|$)/,
  },
];

/** Phrases that read as machine copy or translation (kill list of the Saudi copy skill). */
const AI_TELL_PHRASES: readonly string[] = [
  'لا تفوت الفرصة',
  'المستوي التالي',
  'حلول متكامله',
  'قواعد اللعبه',
  'اطلق العنان',
  'رحلتك نحو',
  'عالم التسويق',
  'نحن هنا',
  'هل تعاني',
  'هل سئمت',
  'هل تعلم',
  'في عصرنا',
  'في عالم اليوم',
  'ليس مجرد',
  'ليست مجرد',
  'جوده استثنائيه',
  'خدمه استثنائيه',
  'نسعي جاهدين',
  'خصيصا لتلبيه',
  'لفتره محدوده',
  'خدمات متميزه',
  'تجربه فريده',
];

const PHONE_LIKE = /(?:\+?\d[\d\s\-().]{6,}\d)/;
const URL_LIKE = /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|sa|co|io|app|shop|store)\b|@[a-z0-9_]{2,})/i;
const EMOJI = /[\p{Extended_Pictographic}\p{So}☀-➿★☆✓✔✗✘►◄▶◀]/u;

function letters(value: string): string[] {
  return value.match(/\p{L}/gu) ?? [];
}

export function scriptShare(value: string): { arabic: number; latin: number; total: number } {
  const all = letters(value);
  const arabic = all.filter((c) => /[؀-ۿ]/.test(c)).length;
  const latin = all.filter((c) => /[A-Za-z]/.test(c)).length;
  return { arabic, latin, total: all.length };
}

// ---------------------------------------------------------------------------
// Single text check
// ---------------------------------------------------------------------------

export type ValidateOptions = {
  language: AdLanguage;
  grounding: Grounding;
  /** Skip the "claim words need a source" rule (used for texts that already ran in the account). */
  keepExisting?: boolean;
};

function fail(code: string, detail?: string): TextCheck {
  return { ok: false, code, ...(detail ? { detail } : {}) };
}

export function validateAssetText(raw: unknown, kind: AssetTextKind, options: ValidateOptions): TextCheck {
  if (typeof raw !== 'string') return fail('not_text');
  if (INVISIBLE.test(raw) || CONTROL.test(raw)) return fail('hidden_characters');
  const text = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) return fail('empty');

  const limits = ASSET_LIMITS[kind];
  const length = adTextLength(text);
  if (length > limits.max) return fail('too_long', `${length}>${limits.max}`);
  if (length < limits.min) return fail('too_short', `${length}<${limits.min}`);

  // House style: no em or en dash, no Latin comma in Arabic, no ornamental quotes.
  if (/[—–―‒]/.test(text)) return fail('dash');
  if (options.language === 'ar' && /[,;]/.test(text)) return fail('latin_punctuation_in_arabic');
  if (/[«»“”„]/.test(text)) return fail('ornamental_quotes');
  if (EMOJI.test(text)) return fail('symbols');
  if (URL_LIKE.test(text)) return fail('url_or_handle');
  if (/[<>{}\[\]|\\^~`]/.test(text)) return fail('markup_characters');

  // No phone numbers, in digits or Arabic-Indic digits.
  const latinDigits = toLatinDigits(text);
  if (PHONE_LIKE.test(latinDigits) || /\d{6,}/.test(latinDigits.replace(/[\s\-.]/g, ''))) return fail('phone_number');

  // Punctuation discipline (Google also refuses "!" in headlines).
  const exclaims = (text.match(/[!！]/g) ?? []).length;
  if (
    kind === 'headline' ||
    kind === 'callout' ||
    kind === 'sitelink_text' ||
    kind === 'snippet_value' ||
    kind === 'path' ||
    kind === 'long_headline' ||
    kind === 'business_name'
  ) {
    if (exclaims > 0) return fail('exclamation');
  } else if (exclaims > 1) {
    return fail('too_many_exclamations');
  }
  if (/[!?؟.،:؛…]{2,}/u.test(text.replace(/\s/g, '')) || /\.{2,}|…/.test(text)) return fail('repeated_punctuation');
  const marks = (text.match(/[!?؟.،:؛]/g) ?? []).length;
  const maxMarks = kind === 'description' || kind === 'sitelink_description' ? 3 : kind === 'long_headline' ? 2 : 1;
  if (marks > maxMarks) return fail('too_much_punctuation');
  if (/^[^\p{L}\p{N}]/u.test(text)) return fail('starts_with_symbol');
  if (kind !== 'description' && kind !== 'sitelink_description' && /[.]$/.test(text)) return fail('trailing_period');
  if (/(.)\1{3,}/u.test(text)) return fail('repeated_characters');
  if (/%\s*%|\$\s*\$/.test(text)) return fail('repeated_symbols');

  // Language of the page decides the language of the copy.
  const share = scriptShare(text);
  if (options.language === 'en') {
    if (share.arabic > 0) return fail('wrong_language');
  } else if (share.total > 0) {
    if (share.latin > 0) {
      const words = text.match(/[A-Za-z][A-Za-z0-9&'-]*/g) ?? [];
      const ungrounded = words.filter((w) => !options.grounding.latinWords.has(w.toLowerCase()));
      if (ungrounded.length > 0) return fail('latin_words_not_in_sources', ungrounded[0]);
    }
    if (share.arabic === 0 && share.latin > 0) {
      // Pure Latin headline on an Arabic page is only fine when every word is a source word (brand name).
    }
  }

  // Capitals: shouting is out, source acronyms and brand codes are fine.
  for (const word of text.match(/[A-Z][A-Z0-9&'-]{3,}/g) ?? []) {
    if (!options.grounding.capsWords.has(word.toLowerCase())) return fail('all_caps', word);
  }
  if (options.language === 'en') {
    const lower = (text.match(/[a-z]/g) ?? []).length;
    const upper = (text.match(/[A-Z]/g) ?? []).length;
    if (upper > 4 && upper > lower) return fail('all_caps');
  }

  const norm = normalizeText(text);

  // Machine-copy tells.
  for (const phrase of AI_TELL_PHRASES) {
    if (norm.includes(normalizeText(phrase))) return fail('ai_phrase', phrase);
  }

  if (!options.keepExisting) {
    // Numbers must come from the sources: price, years, percentages are claims.
    for (const n of extractNumbers(text)) {
      if (!options.grounding.numbers.has(n)) return fail('invented_number', n);
    }
    // Claim words must already appear in the sources.
    for (const claim of CLAIM_PATTERNS) {
      const match = claim.re.exec(` ${norm} `);
      if (match) {
        const needle = normalizeText(match[0]);
        if (needle && !options.grounding.corpus.includes(needle)) return fail('unverifiable_claim', claim.code);
      }
    }
  }

  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Sets: duplicates, structure, pins
// ---------------------------------------------------------------------------

/** Texts that repeat (or restate) another text of the same list, by index of the later one. */
export function findDuplicateMeaning(texts: readonly string[]): number[] {
  const dup: number[] = [];
  for (let i = 1; i < texts.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (sameMeaning(texts[i], texts[j])) {
        dup.push(i);
        break;
      }
    }
  }
  return dup;
}

export const PIN_FIELDS = ['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3', 'DESCRIPTION_1', 'DESCRIPTION_2'] as const;
export type PinField = (typeof PIN_FIELDS)[number];

export type RsaAssetText = { text: string; pinned_field?: PinField | null };

export function isPinField(value: unknown): value is PinField {
  return typeof value === 'string' && (PIN_FIELDS as readonly string[]).includes(value);
}

/**
 * Pins must stay as they were: the same number of assets pinned to each
 * position, a pin only on a text of the right type. A replacement never adds
 * or removes a pin, so a position never ends up empty or with one text that
 * Google cannot rotate. `before` is the live list, `after` the planned one.
 */
export function pinsStayTheSame(before: readonly RsaAssetText[], after: readonly RsaAssetText[]): boolean {
  const count = (list: readonly RsaAssetText[]) => {
    const map = new Map<string, number>();
    for (const item of list) if (item.pinned_field) map.set(item.pinned_field, (map.get(item.pinned_field) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

export function pinsAreSane(headlines: readonly RsaAssetText[], descriptions: readonly RsaAssetText[]): boolean {
  for (const h of headlines) {
    if (h.pinned_field && !h.pinned_field.startsWith('HEADLINE_')) return false;
  }
  for (const d of descriptions) {
    if (d.pinned_field && !d.pinned_field.startsWith('DESCRIPTION_')) return false;
  }
  // Two or more headline positions with a single text each leaves Google no
  // rotation at all: at most three pinned headlines, at most two descriptions.
  if (headlines.filter((h) => h.pinned_field).length > 3) return false;
  if (descriptions.filter((d) => d.pinned_field).length > 2) return false;
  return true;
}

export function validateRsaStructure(
  headlines: readonly RsaAssetText[],
  descriptions: readonly RsaAssetText[]
): { ok: true } | { ok: false; code: string } {
  if (headlines.length < RSA_LIMITS.minHeadlines || headlines.length > RSA_LIMITS.maxHeadlines) {
    return { ok: false, code: 'headline_count' };
  }
  if (descriptions.length < RSA_LIMITS.minDescriptions || descriptions.length > RSA_LIMITS.maxDescriptions) {
    return { ok: false, code: 'description_count' };
  }
  const seenH = new Set(headlines.map((h) => normalizeText(h.text)));
  const seenD = new Set(descriptions.map((d) => normalizeText(d.text)));
  if (seenH.size !== headlines.length) return { ok: false, code: 'duplicate_headline' };
  if (seenD.size !== descriptions.length) return { ok: false, code: 'duplicate_description' };
  if (!pinsAreSane(headlines, descriptions)) return { ok: false, code: 'pins_not_sane' };
  return { ok: true };
}

export type CandidateReport = {
  accepted: string[];
  rejected: Array<{ text: string; code: string; detail?: string }>;
};

/**
 * Runs a batch of model candidates through every rule. `reference` is what the
 * new texts must not repeat (the assets that stay in the ad). Order matters:
 * the first of two similar candidates wins.
 */
export function validateCandidateSet(
  candidates: readonly unknown[],
  kind: AssetTextKind,
  options: ValidateOptions,
  reference: readonly string[] = []
): CandidateReport {
  const accepted: string[] = [];
  const rejected: CandidateReport['rejected'] = [];
  for (const raw of candidates) {
    const checked = validateAssetText(raw, kind, options);
    if (!checked.ok) {
      rejected.push({ text: typeof raw === 'string' ? raw : '', code: checked.code, detail: checked.detail });
      continue;
    }
    if (reference.some((r) => sameMeaning(r, checked.text)) || accepted.some((a) => sameMeaning(a, checked.text))) {
      rejected.push({ text: checked.text, code: 'duplicate_meaning' });
      continue;
    }
    accepted.push(checked.text);
  }
  return { accepted, rejected };
}
