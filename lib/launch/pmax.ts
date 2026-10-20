import { cleanKeywordText } from './arabic';
import { copyIssues, COPY_ISSUE_AR, type CopyKind } from './copy';
import { ASSET_LIMITS } from '@/lib/ads/validators';

/**
 * Performance Max launch: the asset group, its audience signals, the retail
 * listing group and the final URL settings. Pure (no I/O, no clock). Behind
 * CAMPAIGN_LAUNCH_PMAX_ENABLED; with it off nothing here is called.
 *
 * Limits (Google Ads API / Asset Library): headlines 3 to 15 (30 characters),
 * long headlines 1 to 5 (90), descriptions 2 to 5 (90, at least one of 60 or
 * less), business name 25, at most 20 images and 5 logos, at most 5 videos,
 * at least one 1.91:1 image, one 1:1 image and one 1:1 logo. Text goes through
 * the same copy rules as Search (lib/launch/copy.ts on lib/ads/validators.ts).
 *
 * Images, logos and videos are NOT uploaded here: the plan points at assets
 * that already exist in the account (read by lib/launch/pmax-inventory.ts) and
 * the executor re-checks them. Assets cannot be removed through the API, so an
 * undo removes the campaign and its links and leaves the assets in the library.
 */

export const PMAX_LIMITS = {
  headlines: { min: 3, max: 15 },
  long_headlines: { min: 1, max: 5 },
  descriptions: { min: 2, max: 5, short_max: 60 },
  images_total_max: 20,
  logos_max: 5,
  landscape_logos_max: 5,
  videos_max: 5,
  search_themes_max: 25,
  search_theme_chars: 80,
  audience_segments_max: 10,
  excluded_urls_max: 50,
  brand_exclusions_max: 10,
} as const;

export type PmaxImageSlot = 'marketing' | 'square' | 'portrait' | 'logo' | 'landscape_logo';

/** Shape and minimum size of each image slot. Ratio tolerance 2 percent. */
export const PMAX_IMAGE_RULES: Record<PmaxImageSlot, { ratio: number; min_w: number; min_h: number }> = {
  marketing: { ratio: 1.91, min_w: 600, min_h: 314 },
  square: { ratio: 1, min_w: 300, min_h: 300 },
  portrait: { ratio: 0.8, min_w: 480, min_h: 600 },
  logo: { ratio: 1, min_w: 128, min_h: 128 },
  landscape_logo: { ratio: 4, min_w: 512, min_h: 128 },
};
const RATIO_TOLERANCE = 0.02;

export function imageFits(slot: PmaxImageSlot, width: number, height: number): boolean {
  const rule = PMAX_IMAGE_RULES[slot];
  if (!(width > 0) || !(height > 0)) return false;
  if (width < rule.min_w || height < rule.min_h) return false;
  return Math.abs(width / height / rule.ratio - 1) <= RATIO_TOLERANCE;
}

export const ASSET_FIELD: Record<PmaxImageSlot, string> = {
  marketing: 'MARKETING_IMAGE',
  square: 'SQUARE_MARKETING_IMAGE',
  portrait: 'PORTRAIT_MARKETING_IMAGE',
  logo: 'LOGO',
  landscape_logo: 'LANDSCAPE_LOGO',
};

export type PmaxImages = Record<PmaxImageSlot, string[]>;

export type PmaxInventory = {
  images: Array<{ resource_name: string; width: number; height: number }>;
  videos: Array<{ resource_name: string; youtube_id: string }>;
  user_lists: Array<{ resource_name: string; name: string }>;
  custom_audiences: Array<{ resource_name: string; name: string }>;
};

export type PmaxBuild = {
  asset_group: {
    name: string;
    final_url: string;
    business_name: string;
    headlines: string[];
    long_headlines: string[];
    descriptions: string[];
    images: PmaxImages;
    /** YouTube video ids; each becomes a video asset. */
    videos: string[];
  };
  signals: {
    search_themes: string[];
    /** Existing user list resource names (customer lists, remarketing lists). */
    user_lists: string[];
    /** Existing custom audience resource names. */
    custom_audiences: string[];
  };
  /** Retail PMax reads the Merchant Center feed; null for lead generation. */
  retail: { listing_scope: 'all_products' } | null;
  /** Final URL expansion is OFF unless the merchant turned it on; exclusions only matter when it is on. */
  url_expansion: { enabled: boolean; excluded_urls: string[] };
};

type Rec = Record<string, any>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown) => cleanKeywordText(typeof v === 'string' ? v : '');
const RES = (type: string) => new RegExp(`^customers/\\d+/${type}/\\d+$`);
const ASSET_RES = RES('assets');
const USER_LIST_RES = RES('userLists');
const CUSTOM_AUDIENCE_RES = RES('customAudiences');
const YOUTUBE_ID = /^[\w-]{11}$/;

export function youtubeIdOf(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (YOUTUBE_ID.test(raw)) return raw;
  const match = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/)([\w-]{11})(?:[&#?].*)?$/.exec(raw);
  return match ? match[1] : null;
}

export const emptyImages = (): PmaxImages => ({ marketing: [], square: [], portrait: [], logo: [], landscape_logo: [] });

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type TextPool = { headlines: unknown[]; long_headlines: unknown[]; descriptions: unknown[] };

function cleanTexts(
  raw: unknown[],
  kind: CopyKind,
  opts: { max: number; brand: string | null; language: 'ar' | 'en'; allowGuarantee: boolean; pred?: (t: string) => boolean },
  removed: string[]
): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = text(item);
    if (!t) continue;
    const issues = copyIssues(t, { kind, brand: opts.brand, language: opts.language, allowGuarantee: opts.allowGuarantee });
    if (issues.length > 0) {
      removed.push(`سطر «${t}»: ${issues.map((i) => COPY_ISSUE_AR[i.code]).join('، ')}`);
      continue;
    }
    if (opts.pred && !opts.pred(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length < opts.max) kept.push(t);
  }
  return kept;
}

/** Characters as Google counts them (same helper as the Search copy rules). */
const len = (t: string) => Array.from(t).length;

export type PmaxTextResult = {
  headlines: string[];
  long_headlines: string[];
  descriptions: string[];
  business_name: string | null;
};

export function buildPmaxText(args: {
  pool: TextPool;
  businessName: string | null;
  language: 'ar' | 'en';
  allowGuarantee: boolean;
  removed: string[];
}): PmaxTextResult {
  const { pool, businessName, language, allowGuarantee, removed } = args;
  const base = { brand: businessName, language, allowGuarantee };
  const headlines = cleanTexts(pool.headlines, 'headline', { ...base, max: PMAX_LIMITS.headlines.max }, removed);
  const long_headlines = cleanTexts(pool.long_headlines, 'long_headline', { ...base, max: PMAX_LIMITS.long_headlines.max }, removed);
  const descriptions = cleanTexts(pool.descriptions, 'description', { ...base, max: PMAX_LIMITS.descriptions.max }, removed);
  let business: string | null = null;
  if (businessName) {
    const t = text(businessName);
    const issues = copyIssues(t, { kind: 'business_name', brand: businessName, language: null });
    if (issues.length === 0 && len(t) >= ASSET_LIMITS.business_name.min) business = t;
    else removed.push(`اسم النشاط «${t}» ما ينفع اسم في حملة الأداء الأقصى (${issues.map((i) => COPY_ISSUE_AR[i.code]).join('، ') || 'قصير'})`);
  }
  return { headlines, long_headlines, descriptions, business_name: business };
}

// ---------------------------------------------------------------------------
// Selection from the draft and the inventory
// ---------------------------------------------------------------------------

/** What the merchant (or the builder draft) picked. Only existing assets, by resource name. */
export type PmaxSelection = {
  images: Partial<Record<PmaxImageSlot, string[]>>;
  videos: string[];
  search_themes: string[];
  customer_lists: string[];
  custom_audiences: string[];
  excluded_urls: string[];
  url_expansion: boolean;
};

export function readSelection(draft: Rec): PmaxSelection {
  const d = isRec(draft.pmax) ? draft.pmax : isRec(draft.pmax_assets) ? draft.pmax_assets : {};
  const list = (v: unknown) => asArray(v).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  return {
    images: {
      marketing: list(d.marketing_images),
      square: list(d.square_images),
      portrait: list(d.portrait_images),
      logo: list(d.logos),
      landscape_logo: list(d.landscape_logos),
    },
    videos: list(d.videos),
    search_themes: list(d.search_themes),
    customer_lists: list(d.customer_lists),
    custom_audiences: list(d.custom_audiences),
    excluded_urls: list(d.excluded_urls),
    url_expansion: d.url_expansion === true,
  };
}

const uniq = <T,>(items: T[]) => Array.from(new Set(items));

/** Final URL exclusions are matched as "contains": keep a path or a full https URL, nothing else. */
export function cleanExcludedUrl(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 500 || /\s/.test(v)) return null;
  if (/^https:\/\/[^\s/]+(\/\S*)?$/.test(v)) return v;
  if (/^\/[^\s]*$/.test(v)) return v;
  return null;
}

export function cleanSearchTheme(value: string): string | null {
  const t = cleanKeywordText(value);
  if (!t || t.length > PMAX_LIMITS.search_theme_chars) return null;
  if (t.split(' ').length > 10) return null;
  if (/[!@%^*()=\[\]{}<>,;:\\|~`"“”؟?]/.test(t)) return null;
  return t;
}

export type PmaxBuildResult = {
  build: PmaxBuild | null;
  missing_ar: string[];
  removed_ar: string[];
  warnings_ar: string[];
};

export function buildPmax(args: {
  draft: Rec;
  planName: string;
  finalUrl: string;
  businessName: string | null;
  language: 'ar' | 'en';
  allowGuarantee: boolean;
  retail: boolean;
  /** RSA text of the draft's ad groups, used when the draft carries no PMax text of its own. */
  rsaPool: { headlines: string[]; descriptions: string[] };
  inventory: PmaxInventory | null;
}): PmaxBuildResult {
  const { draft, inventory } = args;
  const removed: string[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  const own = isRec(draft.pmax_text) ? draft.pmax_text : {};

  // ---- Text -----------------------------------------------------------------
  const usingOwn = asArray(own.headlines).length > 0 || asArray(own.long_headlines).length > 0 || asArray(own.descriptions).length > 0;
  const pool: TextPool = usingOwn
    ? { headlines: asArray(own.headlines), long_headlines: asArray(own.long_headlines), descriptions: asArray(own.descriptions) }
    : {
        headlines: args.rsaPool.headlines,
        // A long headline is a full sentence of 90 characters or less: the ad group descriptions are the closest copy we have.
        long_headlines: args.rsaPool.descriptions.slice(0, PMAX_LIMITS.long_headlines.max),
        descriptions: args.rsaPool.descriptions,
      };
  if (!usingOwn) warnings.push('نصوص الأداء الأقصى مأخوذة من نصوص إعلانات البحث في المسودة. راجعها قبل التشغيل.');
  const t = buildPmaxText({ pool, businessName: args.businessName, language: args.language, allowGuarantee: args.allowGuarantee, removed });
  // At least one description must fit in 60 characters.
  const hasShortDescription = t.descriptions.some((d) => len(d) <= PMAX_LIMITS.descriptions.short_max);
  if (t.headlines.length < PMAX_LIMITS.headlines.min) missing.push(`عناوين (${t.headlines.length} من ${PMAX_LIMITS.headlines.min} على الأقل)`);
  if (t.long_headlines.length < PMAX_LIMITS.long_headlines.min) missing.push('عنوان طويل واحد على الأقل');
  if (t.descriptions.length < PMAX_LIMITS.descriptions.min) missing.push(`أوصاف (${t.descriptions.length} من ${PMAX_LIMITS.descriptions.min} على الأقل)`);
  else if (!hasShortDescription) missing.push('وصف واحد على الأقل بطول 60 حرف أو أقل');
  if (!t.business_name) missing.push('اسم النشاط');

  // ---- Images and logos -----------------------------------------------------
  const selection = readSelection(draft);
  const images = emptyImages();
  const known = new Map((inventory?.images ?? []).map((i) => [i.resource_name, i]));
  const used = new Set<string>();
  for (const slot of Object.keys(images) as PmaxImageSlot[]) {
    for (const name of uniq(selection.images[slot] ?? [])) {
      const asset = known.get(name);
      if (!ASSET_RES.test(name)) {
        removed.push('صورة باسم مورد غير صحيح تم تجاهلها');
        continue;
      }
      if (!asset) {
        removed.push('صورة مختارة ما لقيناها في مكتبة الحساب');
        continue;
      }
      if (!imageFits(slot, asset.width, asset.height)) {
        removed.push(`صورة ${asset.width}×${asset.height} ما تناسب خانة ${SLOT_AR[slot]}`);
        continue;
      }
      if (used.has(`${slot}:${name}`)) continue;
      used.add(`${slot}:${name}`);
      images[slot].push(name);
    }
  }
  images.logo = images.logo.slice(0, PMAX_LIMITS.logos_max);
  images.landscape_logo = images.landscape_logo.slice(0, PMAX_LIMITS.landscape_logos_max);
  // Total pictures (not logos) are capped at 20: marketing first, then square, then portrait.
  let room = PMAX_LIMITS.images_total_max;
  for (const slot of ['marketing', 'square', 'portrait'] as const) {
    images[slot] = images[slot].slice(0, Math.max(0, room));
    room -= images[slot].length;
  }
  if (images.marketing.length < 1) missing.push('صورة أفقية 1.91:1 (1200×628 مناسبة)');
  if (images.square.length < 1) missing.push('صورة مربعة 1:1 (1200×1200 مناسبة)');
  if (images.logo.length < 1) missing.push('شعار مربع 1:1');

  // ---- Videos ---------------------------------------------------------------
  const videos: string[] = [];
  for (const v of selection.videos) {
    const id = youtubeIdOf(v);
    if (!id) {
      removed.push('رابط فيديو يوتيوب غير صحيح تم تجاهله');
      continue;
    }
    if (!videos.includes(id)) videos.push(id);
  }
  if (videos.length > PMAX_LIMITS.videos_max) {
    removed.push(`الفيديوهات أكثر من ${PMAX_LIMITS.videos_max}، أخذنا أول ${PMAX_LIMITS.videos_max}`);
    videos.length = PMAX_LIMITS.videos_max;
  }
  if (videos.length === 0) warnings.push('بدون فيديو، قوقل ينتج فيديو تلقائي من الصور. فيديو من عندك يعطي نتيجة أفضل.');

  // ---- Signals ----------------------------------------------------------------
  const themes: string[] = [];
  for (const raw of selection.search_themes) {
    const theme = cleanSearchTheme(raw);
    if (!theme) {
      removed.push(`موضوع بحث «${cleanKeywordText(raw).slice(0, 40)}» غير صالح`);
      continue;
    }
    if (!themes.some((x) => x.toLowerCase() === theme.toLowerCase())) themes.push(theme);
  }
  const knownLists = new Set((inventory?.user_lists ?? []).map((l) => l.resource_name));
  const knownCustom = new Set((inventory?.custom_audiences ?? []).map((l) => l.resource_name));
  const userLists = uniq(selection.customer_lists).filter((name) => {
    const ok = USER_LIST_RES.test(name) && knownLists.has(name);
    if (!ok) removed.push('قائمة عملاء مختارة ما لقيناها في الحساب');
    return ok;
  });
  const customAudiences = uniq(selection.custom_audiences).filter((name) => {
    const ok = CUSTOM_AUDIENCE_RES.test(name) && knownCustom.has(name);
    if (!ok) removed.push('شريحة مخصصة مختارة ما لقيناها في الحساب');
    return ok;
  });
  if (userLists.length + customAudiences.length > PMAX_LIMITS.audience_segments_max) {
    removed.push(`الشرائح أكثر من ${PMAX_LIMITS.audience_segments_max}، أخذنا الأولى`);
    const keepLists = userLists.slice(0, PMAX_LIMITS.audience_segments_max);
    const keepCustom = customAudiences.slice(0, PMAX_LIMITS.audience_segments_max - keepLists.length);
    userLists.length = 0;
    userLists.push(...keepLists);
    customAudiences.length = 0;
    customAudiences.push(...keepCustom);
  }
  if (themes.length + userLists.length + customAudiences.length === 0) {
    warnings.push('ما حددنا إشارات جمهور. قوقل يتعلم من حركة موقعك، والإشارات تسرّع البداية.');
  }

  // ---- Final URL expansion -------------------------------------------------------
  const excluded: string[] = [];
  for (const raw of selection.excluded_urls) {
    const url = cleanExcludedUrl(raw);
    if (!url) {
      removed.push('رابط مستبعد غير صالح تم تجاهله');
      continue;
    }
    if (!excluded.includes(url)) excluded.push(url);
  }
  if (excluded.length > PMAX_LIMITS.excluded_urls_max) excluded.length = PMAX_LIMITS.excluded_urls_max;
  if (!selection.url_expansion && excluded.length > 0) {
    warnings.push('توسيع الروابط مقفل، فاستثناءات الروابط ما تنطبق. فعّل التوسيع أولاً لو تبي قوقل يختار صفحات ثانية.');
  }

  if (missing.length > 0) return { build: null, missing_ar: missing, removed_ar: removed, warnings_ar: warnings };

  return {
    build: {
      asset_group: {
        name: `${args.planName} | مجموعة أصول`.slice(0, 128),
        final_url: args.finalUrl,
        business_name: t.business_name as string,
        headlines: t.headlines,
        long_headlines: t.long_headlines,
        descriptions: t.descriptions,
        images,
        videos,
      },
      signals: { search_themes: themes.slice(0, PMAX_LIMITS.search_themes_max), user_lists: userLists, custom_audiences: customAudiences },
      retail: args.retail ? { listing_scope: 'all_products' } : null,
      url_expansion: { enabled: selection.url_expansion, excluded_urls: selection.url_expansion ? excluded : [] },
    },
    missing_ar: [],
    removed_ar: removed,
    warnings_ar: warnings,
  };
}

const SLOT_AR: Record<PmaxImageSlot, string> = {
  marketing: 'الصورة الأفقية',
  square: 'الصورة المربعة',
  portrait: 'الصورة العمودية',
  logo: 'الشعار',
  landscape_logo: 'الشعار الأفقي',
};

// ---------------------------------------------------------------------------
// Re-validation of a stored build (data from the database is never trusted)
// ---------------------------------------------------------------------------

export function validatePmaxBuild(value: unknown, ctx: { language: 'ar' | 'en'; brand: string | null; objective: string | null; retail?: boolean }): string | null {
  if (!isRec(value)) return 'pmax_build_missing';
  const group = value.asset_group;
  if (!isRec(group)) return 'pmax_asset_group';
  if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 128) return 'pmax_asset_group_name';
  if (typeof group.final_url !== 'string' || !/^https:\/\/[^\s/]+(\/\S*)?$/.test(group.final_url) || group.final_url.length > 2000) return 'pmax_final_url';

  const common = { brand: ctx.brand, language: ctx.language, allowGuarantee: true } as const;
  const checkList = (items: unknown, kind: CopyKind, min: number, max: number, code: string): string | null => {
    if (!Array.isArray(items) || items.length < min || items.length > max) return `${code}_count`;
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item !== 'string') return `${code}_text`;
      if (copyIssues(item, { ...common, kind }).length > 0) return `${code}_text`;
      const key = item.toLowerCase();
      if (seen.has(key)) return `${code}_duplicate`;
      seen.add(key);
    }
    return null;
  };
  const headlines = checkList(group.headlines, 'headline', PMAX_LIMITS.headlines.min, PMAX_LIMITS.headlines.max, 'pmax_headlines');
  if (headlines) return headlines;
  const longs = checkList(group.long_headlines, 'long_headline', PMAX_LIMITS.long_headlines.min, PMAX_LIMITS.long_headlines.max, 'pmax_long_headlines');
  if (longs) return longs;
  const descriptions = checkList(group.descriptions, 'description', PMAX_LIMITS.descriptions.min, PMAX_LIMITS.descriptions.max, 'pmax_descriptions');
  if (descriptions) return descriptions;
  if (!(group.descriptions as string[]).some((d) => len(d) <= PMAX_LIMITS.descriptions.short_max)) return 'pmax_descriptions_short';
  if (typeof group.business_name !== 'string' || copyIssues(group.business_name, { kind: 'business_name', brand: ctx.brand, language: null }).length > 0) {
    return 'pmax_business_name';
  }

  const images = group.images;
  if (!isRec(images)) return 'pmax_images';
  let pictures = 0;
  for (const slot of Object.keys(PMAX_IMAGE_RULES) as PmaxImageSlot[]) {
    const names = images[slot];
    if (!Array.isArray(names)) return 'pmax_images';
    if (names.length !== new Set(names).size) return 'pmax_images_duplicate';
    for (const name of names) if (typeof name !== 'string' || !ASSET_RES.test(name)) return 'pmax_image_resource';
    if (slot === 'logo' && names.length > PMAX_LIMITS.logos_max) return 'pmax_logos_count';
    if (slot === 'landscape_logo' && names.length > PMAX_LIMITS.landscape_logos_max) return 'pmax_logos_count';
    if (slot === 'marketing' || slot === 'square' || slot === 'portrait') pictures += names.length;
  }
  if (pictures > PMAX_LIMITS.images_total_max) return 'pmax_images_count';
  if (images.marketing.length < 1 || images.square.length < 1 || images.logo.length < 1) return 'pmax_images_required';

  if (!Array.isArray(group.videos) || group.videos.length > PMAX_LIMITS.videos_max) return 'pmax_videos';
  for (const id of group.videos) if (typeof id !== 'string' || !YOUTUBE_ID.test(id)) return 'pmax_video_id';

  const signals = value.signals;
  if (!isRec(signals)) return 'pmax_signals';
  if (!Array.isArray(signals.search_themes) || signals.search_themes.length > PMAX_LIMITS.search_themes_max) return 'pmax_search_themes';
  for (const theme of signals.search_themes) if (typeof theme !== 'string' || cleanSearchTheme(theme) !== theme) return 'pmax_search_theme';
  if (!Array.isArray(signals.user_lists) || !Array.isArray(signals.custom_audiences)) return 'pmax_audiences';
  if (signals.user_lists.length + signals.custom_audiences.length > PMAX_LIMITS.audience_segments_max) return 'pmax_audiences_count';
  for (const name of signals.user_lists) if (typeof name !== 'string' || !USER_LIST_RES.test(name)) return 'pmax_user_list';
  for (const name of signals.custom_audiences) if (typeof name !== 'string' || !CUSTOM_AUDIENCE_RES.test(name)) return 'pmax_custom_audience';

  const expansion = value.url_expansion;
  if (!isRec(expansion) || typeof expansion.enabled !== 'boolean' || !Array.isArray(expansion.excluded_urls)) return 'pmax_url_expansion';
  if (expansion.excluded_urls.length > PMAX_LIMITS.excluded_urls_max) return 'pmax_excluded_urls';
  if (!expansion.enabled && expansion.excluded_urls.length > 0) return 'pmax_excluded_urls_without_expansion';
  for (const url of expansion.excluded_urls) if (typeof url !== 'string' || cleanExcludedUrl(url) !== url) return 'pmax_excluded_url';

  if (value.retail !== null && !(isRec(value.retail) && value.retail.listing_scope === 'all_products')) return 'pmax_retail';
  // A sales PMax reads the feed; lead generation does not.
  if (ctx.objective === 'LEADS' && value.retail !== null) return 'pmax_retail_for_leads';
  if (ctx.objective === 'SALES' && value.retail === null) return 'pmax_retail_missing';
  return null;
}
