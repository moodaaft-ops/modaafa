import { mentionsGuarantee } from '@/lib/ai/builder-gates';
import { cleanKeywordText } from './arabic';
import { ASSET_LIMITS, RSA_LIMITS, buildGrounding, validateAssetText } from '@/lib/ads/validators';

/**
 * Validation of ad text before it is sent to Google. Limits come from the
 * Google Ads API (RSA headline 30, description 90, path 15; titan 3.8);
 * the "policy-ish" rules mirror what Google's editorial review rejects most
 * often, so a bad line is dropped here with a reason instead of failing the
 * whole batch at validateOnly. Nothing here promises Google will approve a line.
 */

export const RSA_MAX_HEADLINES = RSA_LIMITS.maxHeadlines;
export const RSA_MAX_DESCRIPTIONS = RSA_LIMITS.maxDescriptions;
export const RSA_MIN_HEADLINES = RSA_LIMITS.minHeadlines;
export const RSA_MIN_DESCRIPTIONS = RSA_LIMITS.minDescriptions;
export const HEADLINE_MAX = ASSET_LIMITS.headline.max;
export const DESCRIPTION_MAX = ASSET_LIMITS.description.max;
export const PATH_MAX = ASSET_LIMITS.path.max;
export const SITELINK_TEXT_MAX = ASSET_LIMITS.sitelink_text.max;
export const SITELINK_DESC_MAX = ASSET_LIMITS.sitelink_description.max;
export const CALLOUT_MAX = ASSET_LIMITS.callout.max;
export const SNIPPET_VALUE_MAX = ASSET_LIMITS.snippet_value.max;
export const SNIPPET_MIN_VALUES = 3;
export const SNIPPET_MAX_VALUES = 10;

export type CopyKind =
  | 'headline'
  | 'description'
  | 'path'
  | 'sitelink_text'
  | 'sitelink_description'
  | 'callout'
  | 'snippet_value'
  // Performance Max asset group text (CAMPAIGN_LAUNCH_PMAX_ENABLED).
  | 'long_headline'
  | 'business_name';

const LIMITS: Record<CopyKind, number> = {
  headline: HEADLINE_MAX,
  description: DESCRIPTION_MAX,
  path: PATH_MAX,
  sitelink_text: SITELINK_TEXT_MAX,
  sitelink_description: SITELINK_DESC_MAX,
  callout: CALLOUT_MAX,
  snippet_value: SNIPPET_VALUE_MAX,
  long_headline: ASSET_LIMITS.long_headline.max,
  business_name: ASSET_LIMITS.business_name.max,
};

export type CopyIssueCode =
  | 'empty'
  | 'too_long'
  | 'phone_number'
  | 'url_or_email'
  | 'excess_caps'
  | 'excess_punctuation'
  | 'exclamation_in_headline'
  | 'symbol_or_emoji'
  | 'repeated_chars'
  | 'generic_cta'
  | 'guarantee'
  | 'wrong_language'
  | 'leading_punctuation'
  | 'house_style'
  | 'too_short';

export type CopyIssue = { code: CopyIssueCode; text: string };

/** Characters Google counts: code points, after trimming. Arabic combining marks are removed first. */
export function copyLength(text: string): number {
  return Array.from(cleanKeywordText(text)).length;
}

/**
 * A phone number in text: seven or more digits in a row, or a spaced or dashed
 * group of nine or more digits («055 123 4567», «+966 55 123 4567»). A price
 * range such as «1500 - 2500» has eight digits and is left alone.
 */
export function containsPhoneNumber(raw: string): boolean {
  // Arabic-Indic and Persian digits are digits too.
  const text = raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (/\d{7,}/.test(text)) return true;
  const groups = text.match(/\+?\d[\d\s\-().]{6,}\d/g) ?? [];
  return groups.some((group) => group.replace(/\D/g, '').length >= 9);
}

const URL_OR_EMAIL = /(?:https?:\/\/|www\.)\S+|\b[\w.-]+@[\w-]+\.\w+|\b[\w-]+\.(?:com|net|org|sa|co|io|me|app|shop|store)\b/i;
const EMOJI_OR_SYMBOL = /[\u{1F000}-\u{1FAFF}\u2600-\u27bf\u2b50\u2b06\u2190-\u21ff\u2022\u25a0-\u25ff\u2605\u2606\u00a9\u00ae\u2122\u00a1\u00bf]/u;
const GENERIC_CTA = /اضغط\s*هنا|انقر\s*هنا|click\s*here|اضغط\s*الان|انقر\s*الان/i;

function latinWords(text: string) {
  return text.match(/[A-Za-z][A-Za-z'.-]*/g) ?? [];
}

function brandTokens(brand?: string | null) {
  return new Set(latinWords(brand ?? '').map((w) => w.toUpperCase()));
}

/** Words of five or more Latin letters written in capitals, unless they are the brand's own spelling. */
export function hasExcessCaps(text: string, brand?: string | null): boolean {
  const allowed = brandTokens(brand);
  return latinWords(text).some((word) => {
    const letters = word.replace(/[^A-Za-z]/g, '');
    return letters.length >= 5 && letters === letters.toUpperCase() && !allowed.has(letters.toUpperCase());
  });
}

export function hasExcessPunctuation(text: string): boolean {
  if (/([!?.,;:؟،؛\-_*#~"'])\1{1,}/.test(text)) return true; // !! ?? .. ,,
  if (/[!?؟]\s*[!?؟]/.test(text)) return true; // ?! !?
  const marks = text.match(/[!?؟.,;:؛،]/g) ?? [];
  return marks.length > 3;
}

/** Arabic or Latin as the line's language, ignoring brand names, digits and punctuation. */
export function lineScript(text: string, brand?: string | null): 'ar' | 'en' | 'none' {
  let stripped = text;
  for (const token of brandTokens(brand)) stripped = stripped.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'ig'), ' ');
  const ar = (stripped.match(/[\u0600-ۿ]/g) ?? []).length;
  const en = (stripped.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en === 0) return 'none';
  return ar >= en ? 'ar' : 'en';
}

export type ValidateOptions = {
  kind: CopyKind;
  brand?: string | null;
  /** The merchant's own brief wrote guarantee wording; then it is theirs to use. */
  allowGuarantee?: boolean;
  /** Language of the ad group; a line in the other script is rejected. */
  language?: 'ar' | 'en' | null;
};

/** The issues in one line of ad text. Empty list means it passes. */
export function copyIssues(raw: unknown, options: ValidateOptions): CopyIssue[] {
  const text = cleanKeywordText(typeof raw === 'string' ? raw : '');
  const issues: CopyIssue[] = [];
  const add = (code: CopyIssueCode) => issues.push({ code, text });
  if (!text) return [{ code: 'empty', text }];
  if (copyLength(text) > LIMITS[options.kind]) add('too_long');

  if (containsPhoneNumber(text)) add('phone_number');
  if (URL_OR_EMAIL.test(text)) add('url_or_email');
  if (hasExcessCaps(text, options.brand)) add('excess_caps');
  if (hasExcessPunctuation(text)) add('excess_punctuation');
  if ((options.kind === 'headline' || options.kind === 'long_headline' || options.kind === 'business_name') && /[!！]/.test(text)) add('exclamation_in_headline');
  if (EMOJI_OR_SYMBOL.test(text)) add('symbol_or_emoji');
  if (/(.)\1{3,}/u.test(text)) add('repeated_chars');
  if (GENERIC_CTA.test(text)) add('generic_cta');
  if (/^[\s!?.,;:،؛؟\-_*#~"'(){}[\]]/.test(text)) add('leading_punctuation');
  if (!options.allowGuarantee && mentionsGuarantee(text)) add('guarantee');
  if (options.language && options.kind !== 'path') {
    const script = lineScript(text, options.brand);
    if (script !== 'none' && script !== options.language) add('wrong_language');
  }
  // Shared ad-copy rules (lib/ads/validators.ts), only the ones that need no source text:
  // hidden characters, dashes, Latin comma in Arabic, ornamental quotes, minimum length, machine phrases.
  // The stricter of the two rule sets wins; the grounding rules stay with the Ads Studio writer.
  if (issues.length === 0 && options.language) {
    const shared = validateAssetText(text, options.kind, { language: options.language, grounding: buildGrounding([text]), keepExisting: true });
    if (!shared.ok) {
      if (shared.code === 'too_short') add('too_short');
      else if (['hidden_characters', 'dash', 'latin_punctuation_in_arabic', 'ornamental_quotes', 'ai_phrase'].includes(shared.code)) add('house_style');
    }
  }
  return issues;
}

export const COPY_ISSUE_AR: Record<CopyIssueCode, string> = {
  empty: 'سطر فاضي',
  too_long: 'أطول من الحد المسموح',
  phone_number: 'فيه رقم جوال أو هاتف (قوقل ما تقبله داخل النص)',
  url_or_email: 'فيه رابط أو إيميل',
  excess_caps: 'حروف إنجليزية كبيرة بشكل زائد',
  excess_punctuation: 'علامات ترقيم زيادة',
  exclamation_in_headline: 'علامة تعجب في العنوان (قوقل ترفضها)',
  symbol_or_emoji: 'رموز أو إيموجي',
  repeated_chars: 'حروف مكررة',
  generic_cta: 'عبارة عامة مثل «اضغط هنا»',
  guarantee: 'وعد بنتيجة أو ضمان ما ذكرته أنت',
  wrong_language: 'لغة السطر غير لغة المجموعة',
  leading_punctuation: 'يبدأ بعلامة ترقيم',
  house_style: 'فيه شرطة أو فاصلة لاتينية أو علامات اقتباس زخرفية أو عبارة آلية',
  too_short: 'أقصر من الحد الأدنى',
};

export type CleanedList = { kept: string[]; dropped: Array<{ text: string; issues: CopyIssueCode[] }> };

/** Validates, trims and de-duplicates (spelling-insensitively) a list of lines. */
export function cleanCopyList(raw: unknown, options: ValidateOptions & { max: number }): CleanedList {
  const list = Array.isArray(raw) ? raw : [];
  const kept: string[] = [];
  const dropped: CleanedList['dropped'] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const text = cleanKeywordText(typeof item === 'string' ? item : '');
    if (!text) continue;
    const issues = copyIssues(text, options);
    if (issues.length > 0) {
      dropped.push({ text, issues: issues.map((i) => i.code) });
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length < options.max) kept.push(text);
  }
  return { kept, dropped };
}

export type RsaDraft = { headlines: string[]; descriptions: string[]; path1: string | null; path2: string | null };

export type RsaCheck = {
  rsa: RsaDraft | null;
  dropped: CleanedList['dropped'];
  /** Problems that stop the ad from being created at all. */
  errors: Array<'too_few_headlines' | 'too_few_descriptions'>;
  warnings_ar: string[];
};

/**
 * Builds a Responsive Search Ad from model-written lines. Up to 15 headlines
 * and 4 descriptions; below 3 and 2 the ad is not created. No pinning is set:
 * pinning is a deliberate choice (titan 3.8), not a default.
 */
export function buildRsa(args: {
  headlines: unknown;
  descriptions: unknown;
  path1?: unknown;
  path2?: unknown;
  brand?: string | null;
  allowGuarantee?: boolean;
  language: 'ar' | 'en';
}): RsaCheck {
  const common = { brand: args.brand, allowGuarantee: args.allowGuarantee, language: args.language };
  const headlines = cleanCopyList(args.headlines, { ...common, kind: 'headline', max: RSA_MAX_HEADLINES });
  const descriptions = cleanCopyList(args.descriptions, { ...common, kind: 'description', max: RSA_MAX_DESCRIPTIONS });
  const errors: RsaCheck['errors'] = [];
  const warnings: string[] = [];
  if (headlines.kept.length < RSA_MIN_HEADLINES) errors.push('too_few_headlines');
  if (descriptions.kept.length < RSA_MIN_DESCRIPTIONS) errors.push('too_few_descriptions');
  if (headlines.kept.length >= RSA_MIN_HEADLINES && headlines.kept.length < 8) {
    warnings.push(`العناوين ${headlines.kept.length} فقط. كل ما زادت (لين 15) قوقل تجرب تركيبات أكثر.`);
  }
  if (descriptions.kept.length >= RSA_MIN_DESCRIPTIONS && descriptions.kept.length < RSA_MAX_DESCRIPTIONS) {
    warnings.push(`الأوصاف ${descriptions.kept.length} من 4.`);
  }
  const path = (value: unknown) => {
    const text = cleanKeywordText(typeof value === 'string' ? value : '').replace(/\s+/g, '-');
    return text && copyIssues(text, { kind: 'path' }).length === 0 ? text : null;
  };
  const path1 = path(args.path1);
  const path2 = path1 ? path(args.path2) : null;
  return {
    rsa:
      errors.length === 0
        ? { headlines: headlines.kept, descriptions: descriptions.kept, path1, path2 }
        : null,
    dropped: [...headlines.dropped, ...descriptions.dropped],
    errors,
    warnings_ar: warnings,
  };
}
