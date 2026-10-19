import { cleanKeywordText, expandArabicVariants, normalizeArabicKey } from './arabic';

/**
 * Starter negative keywords for a new Saudi account (google-ads-titan 3.7,
 * "بذرة كلمات سلبية للسوق السعودي"), plus the English equivalents. They go in
 * ONE shared list attached to the campaign, as PHRASE negatives.
 *
 * "رقم" is deliberately absent (high intent for local services) and so is
 * "مستعمل" when the merchant sells used goods: that is what `keep` filtering
 * against the plan's own keywords is for.
 */
export const STARTER_NEGATIVES_AR = [
  'وظائف', 'وظيفة', 'توظيف', 'رواتب', 'راتب', 'مجانا', 'مجاني', 'تحميل', 'نموذج',
  'بحث عن', 'تعريف', 'ما هو', 'ما هي', 'كيف اسوي', 'بنفسي', 'طريقة عمل', 'دورة', 'تدريب', 'كورس',
  'حراج', 'مستعمل', 'للبيع مستعمل', 'تويتر', 'يوتيوب', 'سناب', 'ويكيبيديا', 'صور', 'خلفيات', 'شروط',
];

export const STARTER_NEGATIVES_EN = [
  'jobs', 'job', 'career', 'careers', 'salary', 'free', 'download', 'pdf', 'word', 'template',
  'tutorial', 'course', 'wikipedia', 'youtube', 'diy', 'what is', 'how to', 'used',
];

export const STARTER_NEGATIVE_LIST_NAME = 'م\u064fضاع\u0650ف | سلبيات البداية';

export type NegativeKeyword = { text: string; match_type: 'EXACT' | 'PHRASE' };

function tokens(value: string): string[] {
  return normalizeArabicKey(value).split(' ').filter(Boolean);
}

/**
 * True when the negative would stop the positive keyword from serving:
 * an EXACT negative equal to it, or a PHRASE/BROAD negative whose words appear
 * (in order, contiguously for PHRASE) inside it.
 */
export function negativeBlocksKeyword(negative: NegativeKeyword, keywordText: string): boolean {
  const neg = tokens(negative.text);
  const kw = tokens(keywordText);
  if (neg.length === 0 || kw.length === 0) return false;
  if (negative.match_type === 'EXACT') return neg.join(' ') === kw.join(' ');
  if (neg.length > kw.length) return false;
  for (let start = 0; start + neg.length <= kw.length; start += 1) {
    if (neg.every((word, i) => kw[start + i] === word)) return true;
  }
  return false;
}

export type NegativePlan = {
  campaign_negatives: NegativeKeyword[];
  shared_list: { name: string; keywords: NegativeKeyword[] };
  /** Negatives removed because they would block a keyword of this very plan. */
  removed_for_collision: Array<{ text: string; blocks: string }>;
};

function clampText(text: string) {
  const clean = cleanKeywordText(text);
  if (!clean || clean.length > 80 || clean.split(' ').length > 10) return null;
  return clean;
}

/**
 * Campaign-level negatives (from the draft: brands, cities and products the
 * merchant said they do not want) plus the starter shared list. Both are
 * checked against `positiveKeywords`; a negative that would block one of them
 * is dropped and reported, never sent.
 */
export function buildNegativePlan(args: {
  campaignNegatives?: Array<string | { text: string; match_type?: string }>;
  positiveKeywords: string[];
  includeEnglish?: boolean;
}): NegativePlan {
  const removed: NegativePlan['removed_for_collision'] = [];

  const toNegative = (raw: string | { text: string; match_type?: string }): NegativeKeyword | null => {
    const text = clampText(typeof raw === 'string' ? raw : raw?.text);
    if (!text) return null;
    const type = typeof raw === 'string' ? 'PHRASE' : String(raw.match_type ?? 'PHRASE').toUpperCase();
    return { text, match_type: type === 'EXACT' ? 'EXACT' : 'PHRASE' };
  };

  const filterCollisions = (list: NegativeKeyword[]): NegativeKeyword[] => {
    const out: NegativeKeyword[] = [];
    const seen = new Set<string>();
    for (const negative of list) {
      const blocked = args.positiveKeywords.find((kw) => negativeBlocksKeyword(negative, kw));
      if (blocked) {
        removed.push({ text: negative.text, blocks: blocked });
        continue;
      }
      const key = `${negative.match_type}:${negative.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(negative);
    }
    return out;
  };

  const campaign = filterCollisions(
    (args.campaignNegatives ?? []).map(toNegative).filter((n): n is NegativeKeyword => n !== null)
  );
  const campaignKeys = new Set(campaign.map((n) => n.text.toLowerCase()));

  const starterSource = [...STARTER_NEGATIVES_AR, ...(args.includeEnglish === false ? [] : STARTER_NEGATIVES_EN)];
  const starter: NegativeKeyword[] = [];
  for (const word of starterSource) {
    // Spelling variants matter for negatives too («مجانا» is typed «مجان\u064bا» and «مجانا\u064b»).
    for (const variant of expandArabicVariants(word, { maxPerKeyword: 3, addArticle: false })) {
      if (!campaignKeys.has(variant.toLowerCase())) starter.push({ text: variant, match_type: 'PHRASE' });
    }
  }

  return {
    campaign_negatives: campaign,
    shared_list: { name: STARTER_NEGATIVE_LIST_NAME, keywords: filterCollisions(starter) },
    removed_for_collision: removed,
  };
}
