import { cleanKeywordText } from './arabic';
import {
  CALLOUT_MAX,
  SITELINK_DESC_MAX,
  SITELINK_TEXT_MAX,
  SNIPPET_MAX_VALUES,
  SNIPPET_MIN_VALUES,
  SNIPPET_VALUE_MAX,
  cleanCopyList,
  copyIssues,
  type CopyIssueCode,
} from './copy';
import type { LaunchAssets, LaunchSitelink } from './types';

/** Sitelinks, callouts, structured snippet and call asset for a plan, validated. */

export const MAX_SITELINKS = 6;
export const MAX_CALLOUTS = 6;

/**
 * Structured snippet headers the API accepts are a fixed list. «Service catalog»
 * fits a services business and «Types» a product range. Not verified live for
 * Arabic accounts (report, open item), so validateOnly is the judge.
 */
export const DEFAULT_SNIPPET_HEADER_SERVICES = 'Service catalog';
export const DEFAULT_SNIPPET_HEADER_PRODUCTS = 'Types';
const ALLOWED_SNIPPET_HEADERS = new Set([
  'Amenities', 'Brands', 'Courses', 'Degree programs', 'Destinations', 'Featured hotels', 'Insurance coverage',
  'Models', 'Neighborhoods', 'Service catalog', 'Shows', 'Styles', 'Types',
]);

/** https URL on the business's own site (same host, www ignored). Relative paths resolve against the site. */
export function resolveSiteUrl(raw: unknown, site: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !site) return null;
  let base: URL;
  try {
    base = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  const host = (value: string) => value.toLowerCase().replace(/^www\./, '');
  if (host(url.hostname) !== host(base.hostname)) return null;
  url.protocol = 'https:';
  url.hash = '';
  return url.toString();
}

/** +9665XXXXXXXX style Saudi number from «05xxxxxxxx», «9665...», «+966 5...», or a Saudi landline. Null when it is not one. */
export function normalizeSaudiPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = cleanKeywordText(raw).replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
  if (/^05\d{8}$/.test(digits)) return `+966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `+966${digits}`;
  // Landlines: 011 Riyadh, 012 Makkah and Jeddah, 013 Eastern, 014 Madinah, 016 Qassim, 017 Asir.
  if (/^9661[1-7]\d{7}$/.test(digits)) return `+${digits}`;
  if (/^01[1-7]\d{7}$/.test(digits)) return `+966${digits.slice(1)}`;
  return null;
}

export type AssetCheck = {
  assets: LaunchAssets;
  warnings_ar: string[];
  removed_ar: string[];
};

type RawAssets = {
  sitelinks?: unknown;
  callouts?: unknown;
  structured_snippet?: unknown;
  phone?: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function buildAssets(args: {
  raw: RawAssets;
  site: string | null;
  brand?: string | null;
  language: 'ar' | 'en';
  kind: 'clinic' | 'services' | 'ecommerce' | 'local' | 'general';
  allowGuarantee?: boolean;
}): AssetCheck {
  const warnings: string[] = [];
  const removed: string[] = [];
  const common = { brand: args.brand, allowGuarantee: args.allowGuarantee, language: args.language };
  const fail = (what: string, issues: CopyIssueCode[]) => removed.push(`${what}: ${issues.join('، ')}`);

  // ---- Sitelinks ---------------------------------------------------------
  const sitelinks: LaunchSitelink[] = [];
  const seenLinks = new Set<string>();
  for (const item of Array.isArray(args.raw.sitelinks) ? args.raw.sitelinks : []) {
    const entry = asObject(item);
    if (!entry) continue;
    const linkText = cleanKeywordText(String(entry.link_text ?? ''));
    const url = resolveSiteUrl(entry.final_url ?? entry.url ?? entry.path, args.site);
    if (!linkText || !url) {
      if (linkText) removed.push(`رابط فرعي «${linkText}»: الرابط مو من موقعك`);
      continue;
    }
    const textIssues = copyIssues(linkText, { ...common, kind: 'sitelink_text' });
    if (textIssues.length > 0) {
      fail(`رابط فرعي «${linkText}»`, textIssues.map((i) => i.code));
      continue;
    }
    let d1: string | null = cleanKeywordText(String(entry.description1 ?? '')) || null;
    let d2: string | null = cleanKeywordText(String(entry.description2 ?? '')) || null;
    for (const [index, desc] of [d1, d2].entries()) {
      if (desc && copyIssues(desc, { ...common, kind: 'sitelink_description' }).length > 0) {
        if (index === 0) d1 = null;
        else d2 = null;
      }
    }
    // Google shows description lines only as a pair.
    if (!d1 || !d2) {
      d1 = null;
      d2 = null;
    }
    const key = `${linkText.toLowerCase()}|${url}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    if (sitelinks.length < MAX_SITELINKS) sitelinks.push({ link_text: linkText, description1: d1, description2: d2, final_url: url });
  }
  if (sitelinks.length < 4) {
    warnings.push(`الروابط الفرعية ${sitelinks.length} فقط. الأفضل 4 على الأقل، كل واحد لصفحة حقيقية مختلفة.`);
  }

  // ---- Callouts ----------------------------------------------------------
  const callouts = cleanCopyList(args.raw.callouts, { ...common, kind: 'callout', max: MAX_CALLOUTS });
  for (const item of callouts.dropped) fail(`إبراز «${item.text}»`, item.issues);
  if (callouts.kept.length < 2) warnings.push('الإبرازات أقل من 2.');

  // ---- Structured snippet ------------------------------------------------
  let snippet: LaunchAssets['structured_snippet'] = null;
  const rawSnippet = asObject(args.raw.structured_snippet);
  if (rawSnippet) {
    const values = cleanCopyList(rawSnippet.values, { ...common, kind: 'snippet_value', max: SNIPPET_MAX_VALUES });
    for (const item of values.dropped) fail(`قيمة مقتطف «${item.text}»`, item.issues);
    const defaultHeader =
      args.kind === 'ecommerce' ? DEFAULT_SNIPPET_HEADER_PRODUCTS : DEFAULT_SNIPPET_HEADER_SERVICES;
    const requested = cleanKeywordText(String(rawSnippet.header ?? ''));
    const header = ALLOWED_SNIPPET_HEADERS.has(requested) ? requested : defaultHeader;
    if (values.kept.length >= SNIPPET_MIN_VALUES) snippet = { header, values: values.kept };
    else if (values.kept.length > 0) removed.push(`المقتطف المنظم: يحتاج ${SNIPPET_MIN_VALUES} قيم على الأقل`);
  }

  // ---- Call asset --------------------------------------------------------
  const phone = normalizeSaudiPhone(args.raw.phone);
  if (args.raw.phone && !phone) removed.push('رقم الاتصال: مو رقم سعودي صحيح فما انضاف زر الاتصال');

  return {
    assets: {
      sitelinks,
      callouts: callouts.kept,
      structured_snippet: snippet,
      call_phone: phone,
      use_location_sync: args.kind === 'local' || args.kind === 'clinic' || args.kind === 'services',
    },
    warnings_ar: warnings,
    removed_ar: removed,
  };
}

export const ASSET_LIMITS = { SITELINK_TEXT_MAX, SITELINK_DESC_MAX, CALLOUT_MAX, SNIPPET_VALUE_MAX };
