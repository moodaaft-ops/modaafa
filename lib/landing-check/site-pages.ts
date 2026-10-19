import { analyzeHtml } from './analyze';
import { guardedFetch, type FetchDeps } from './fetch';
import type { PageReport } from './run';

/**
 * Same-site pages for sitelinks. Discovery is the landing check's own crawl:
 * the links found in the HTML of the pages it already fetched, filtered to the
 * same host, then each candidate is fetched through the SSRF guard and kept
 * only when it answers 200 with an HTML document on the same host. Nothing
 * here is guessed or generated: a sitelink URL can only come from this list.
 *
 * Runs only when the caller asks for it (ADS_STUDIO_ENABLED in the cron step),
 * so the weekly check is unchanged for everyone else.
 */

export type SiteLink = { url: string; anchor: string };

export type SitePage = {
  /** Final URL after redirects, https, no query or fragment. */
  url: string;
  title: string;
  h1: string;
  /** The link text the home page used for it (can be empty). */
  anchor: string;
  status: 200;
};

export const MAX_LINKS_PER_PAGE = 12;
export const MAX_SITE_PAGES_FETCHED = 6;
export const MAX_SITE_PAGES_KEPT = 6;

const SKIP_EXTENSIONS = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|mp4|mp3|xml|json|css|js|docx?|xlsx?)$/i;
/** Pages that make poor sitelinks or need a session: carts, accounts, search, legal text, feeds. */
const SKIP_PATHS =
  /(?:^|\/)(?:cart|checkout|basket|login|signin|sign-in|register|signup|account|my-account|wp-admin|wp-login\.php|cdn-cgi|search|feed|api|privacy|privacy-policy|terms|terms-and-conditions|refund|return-policy|policies)(?:\/|$)/i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function hostKey(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The page address a sitelink may point at: https, no credentials, no query, no fragment, no trailing slash noise. */
export function cleanSitePageUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    url.search = '';
    const path = url.pathname.replace(/\/{2,}/g, '/');
    if (path === '/' || path === '') return null;
    url.pathname = path.length > 1 ? path.replace(/\/+$/, '') : path;
    return url.toString();
  } catch {
    return null;
  }
}

/** Links of this HTML that stay on the same host and look like ordinary content pages. Deduped, document order, capped. */
export function candidateSiteLinks(baseUrl: string, html: string, max = MAX_LINKS_PER_PAGE): SiteLink[] {
  const baseHost = hostKey(baseUrl);
  if (!baseHost) return [];
  const out: SiteLink[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const raw = decode((href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim());
    if (!raw || /^(?:#|mailto:|tel:|javascript:|whatsapp:|sms:)/i.test(raw)) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    if (hostKey(absolute) !== baseHost) continue;
    const clean = cleanSitePageUrl(absolute);
    if (!clean) continue;
    const path = new URL(clean).pathname;
    if (SKIP_EXTENSIONS.test(path) || SKIP_PATHS.test(path)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    const anchor = decode(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 60);
    out.push({ url: clean, anchor });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Fetches the candidates one by one (a polite single connection) and keeps the
 * ones that answer 200 with HTML on the same host. The landing pages the check
 * already fetched are not fetched again and are not repeated.
 */
export async function crawlSitePages(pages: readonly PageReport[], deps: FetchDeps): Promise<SitePage[]> {
  const known = new Set<string>();
  for (const page of pages) {
    for (const url of [page.url, page.finalUrl]) {
      const clean = url ? cleanSitePageUrl(url) : null;
      if (clean) known.add(clean);
    }
  }
  const queue: Array<SiteLink & { host: string }> = [];
  const queued = new Set<string>();
  for (const page of pages) {
    if (page.status !== 200 || !page.siteLinks) continue;
    const host = hostKey(page.finalUrl ?? page.url);
    if (!host) continue;
    for (const link of page.siteLinks) {
      if (known.has(link.url) || queued.has(link.url)) continue;
      queued.add(link.url);
      queue.push({ ...link, host });
    }
  }

  const kept: SitePage[] = [];
  const keptUrls = new Set<string>();
  for (const candidate of queue.slice(0, MAX_SITE_PAGES_FETCHED)) {
    if (kept.length >= MAX_SITE_PAGES_KEPT) break;
    const fetched = await guardedFetch(candidate.url, deps).catch(() => null);
    if (!fetched || !fetched.ok || fetched.status !== 200 || fetched.html === null) continue;
    if (hostKey(fetched.finalUrl) !== candidate.host) continue;
    const finalUrl = cleanSitePageUrl(fetched.finalUrl);
    if (!finalUrl || known.has(finalUrl) || keptUrls.has(finalUrl)) continue;
    const analysis = analyzeHtml(fetched.html);
    keptUrls.add(finalUrl);
    kept.push({ url: finalUrl, title: analysis.title, h1: analysis.h1, anchor: candidate.anchor, status: 200 });
  }
  return kept;
}
