import { merchantPhoneEnabled } from '@/lib/settings/merchant-phone';
import type { LandingCheckReport } from '../landing-check/run';
import { cleanSitePageUrl, hostKey } from '../landing-check/site-pages';
import { str } from './rows';
import { cleanSaudiPhone } from './studio/validate';
import type { GaqlReader } from './assets-reader';

/**
 * Where sitelink URLs and the call number come from. Nothing is invented.
 *
 * Sitelinks: only pages the landing check crawl fetched and saw answer 200
 * on the SAME host as the campaign's own ad landing pages.
 *
 * Phone: only a number the merchant already owns on the platform's record:
 *   1. a call asset that already serves in the account (campaign or account level),
 *   2. a business phone saved from onboarding or settings (business_memory,
 *      setup_key `business_phone`, stated by the merchant).
 * The sign-up phone is NOT used (it is the login phone, not a public line), and
 * neither is anything a chat model wrote. If two different numbers qualify the
 * result is "ambiguous" and no card is made.
 */

export type SitePageCandidate = { url: string; title: string; h1: string; anchor: string };

/** Pages of the crawl that can serve as sitelinks for a campaign whose ads land on `campaignFinalUrls`. */
export function sitePagesForCampaign(args: {
  report: LandingCheckReport | null | undefined;
  campaignFinalUrls: readonly string[];
}): SitePageCandidate[] {
  const pages = args.report?.sitePages;
  if (!Array.isArray(pages)) return [];
  const hosts = new Set(args.campaignFinalUrls.map((u) => hostKey(u)).filter((h): h is string => Boolean(h)));
  if (hosts.size === 0) return [];
  // The ad's own landing page is not a useful sitelink to itself.
  const ownKey = (u: string) => {
    const clean = cleanSitePageUrl(u);
    const host = hostKey(u);
    return clean && host ? `${host}${new URL(clean).pathname}` : null;
  };
  const own = new Set(args.campaignFinalUrls.map(ownKey).filter((u): u is string => Boolean(u)));
  const out: SitePageCandidate[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (!page || page.status !== 200) continue;
    const url = cleanSitePageUrl(String(page.url ?? ''));
    const host = url ? hostKey(url) : null;
    if (!url || !host || own.has(ownKey(url) ?? '') || seen.has(url)) continue;
    if (!hosts.has(host)) continue;
    seen.add(url);
    out.push({ url, title: String(page.title ?? ''), h1: String(page.h1 ?? ''), anchor: String(page.anchor ?? '') });
  }
  return out;
}

export type VerifiedPhoneSource = 'merchant_saved' | 'account_call_asset';
export type VerifiedPhone = { phone: string; source: VerifiedPhoneSource };
export type PhoneResolution = { status: 'found'; value: VerifiedPhone } | { status: 'none' } | { status: 'ambiguous' };

const CALL_ASSET_QUERIES = [
  `SELECT asset.call_asset.phone_number, asset.call_asset.country_code
   FROM campaign_asset
   WHERE campaign_asset.field_type = 'CALL' AND campaign_asset.status = 'ENABLED'
   LIMIT 200`,
  `SELECT asset.call_asset.phone_number, asset.call_asset.country_code
   FROM customer_asset
   WHERE customer_asset.field_type = 'CALL' AND customer_asset.status = 'ENABLED'
   LIMIT 50`,
];

/** Saudi call assets already serving in the account. Null when the account could not be read. */
export async function readAccountCallPhones(reader: GaqlReader): Promise<string[] | null> {
  try {
    const found = new Set<string>();
    for (const gaql of CALL_ASSET_QUERIES) {
      const rows = await reader.query(gaql);
      for (const row of rows) {
        const country = str(row, 'asset.call_asset.country_code').toUpperCase();
        if (country && country !== 'SA') continue;
        const phone = cleanSaudiPhone(str(row, 'asset.call_asset.phone_number'));
        if (phone) found.add(phone);
      }
    }
    return [...found];
  } catch {
    return null;
  }
}

/** Business phones the merchant gave in onboarding or settings. Best effort: any failure is "none". */
export async function readMerchantSavedPhones(admin: any, businessId: string | null | undefined): Promise<string[]> {
  if (!admin || !businessId) return [];
  try {
    if (merchantPhoneEnabled()) {
      const saved = await admin.from('merchant_call_phones').select('phone_e164').eq('business_id', businessId).maybeSingle();
      const phone = cleanSaudiPhone(saved.data?.phone_e164);
      if (!saved.error && phone) return [phone];
    }
    const { data, error } = await admin
      .from('business_memory')
      .select('data, source, basis')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .in('source', ['onboarding', 'settings'])
      .eq('basis', 'stated')
      .eq('data->>setup_key', 'business_phone')
      .limit(5);
    if (error || !Array.isArray(data)) return [];
    const phones = new Set<string>();
    for (const row of data) {
      const phone = cleanSaudiPhone(row?.data?.phone);
      if (phone) phones.add(phone);
    }
    return [...phones];
  } catch {
    return [];
  }
}

/** Pure. Merchant-saved numbers outrank the ones found in the account; any disagreement is ambiguous. */
export function resolveVerifiedPhone(args: { merchantSaved: readonly string[]; accountPhones: readonly string[] }): PhoneResolution {
  const saved = [...new Set(args.merchantSaved)];
  if (saved.length === 1) return { status: 'found', value: { phone: saved[0], source: 'merchant_saved' } };
  if (saved.length > 1) return { status: 'ambiguous' };
  const account = [...new Set(args.accountPhones)];
  if (account.length === 1) return { status: 'found', value: { phone: account[0], source: 'account_call_asset' } };
  if (account.length > 1) return { status: 'ambiguous' };
  return { status: 'none' };
}

