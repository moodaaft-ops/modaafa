import { analyzeHtml, messageMatch, type MessageMatch, type PageAnalysis } from './analyze';
import { guardedFetch, type FetchDeps, type FetchFailureCode } from './fetch';
import { buildPageFindings, sortFindings, tagStates, type Finding } from './findings';
import type { CheckTarget } from './sources';
import type { PageTags, TagState } from './analyze';
import { candidateSiteLinks, crawlSitePages, type SiteLink, type SitePage } from './site-pages';

/** A page is checked at most once a week per account. */
export const LANDING_CHECK_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type PageReport = {
  url: string;
  clicks30d: number;
  finalUrl: string | null;
  status: number | null;
  fetchError: FetchFailureCode | null;
  redirects: number;
  ttfbMs: number | null;
  totalMs: number | null;
  htmlBytes: number | null;
  truncated: boolean;
  title: string;
  h1: string;
  viewport: { present: boolean; deviceWidth: boolean } | null;
  tags: Record<keyof PageTags, TagState> | null;
  tagIds: { ga4: string[]; googleAds: string[]; gtm: string[] } | null;
  whatsappLinks: number;
  telLinks: number;
  smartLink: boolean;
  match: (MessageMatch & { keywords: string[] }) | null;
  findings: Finding[];
  /** Same-host links found in the HTML. Present only on a run that asked for site pages. */
  siteLinks?: SiteLink[];
};

/** What the page says about the conversion tag, for the tracking verdict. Evidence, not a verdict. */
export type TrackingEvidence = {
  googleTag: 'visible' | 'maybe_in_gtm' | 'not_visible' | 'unknown';
  pagesChecked: number;
  line_ar: string;
};

export type LandingCheckReport = {
  version: 1;
  checkedAt: string;
  pages: PageReport[];
  findings: Array<Finding & { url: string }>;
  tracking: TrackingEvidence;
  /**
   * Same-site pages that answered 200 (sitelink sources). Present only on a run that asked
   * for them: an empty list means "crawled, nothing usable", absent means "never crawled".
   */
  sitePages?: SitePage[];
};

export async function checkLandingPage(
  target: CheckTarget,
  deps: FetchDeps,
  options: { collectLinks?: boolean } = {}
): Promise<PageReport> {
  const fetched = await guardedFetch(target.url, deps);

  if (!fetched.ok) {
    const base = emptyPage(target);
    base.fetchError = fetched.code;
    base.redirects = fetched.redirects.length;
    base.findings = buildPageFindings({ ...factsFrom(base, null, null), fetchError: fetched.code });
    return base;
  }

  // An error page says nothing about the real page's tags, so it is not analysed.
  const analysis: PageAnalysis | null = fetched.html !== null && fetched.status < 400 ? analyzeHtml(fetched.html) : null;
  const match = analysis && target.keywords.length > 0 ? messageMatch(target.keywords, analysis.title, analysis.h1, analysis.bodyText) : null;

  const page: PageReport = {
    url: target.url,
    clicks30d: target.clicks,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    fetchError: null,
    redirects: fetched.redirects.length,
    ttfbMs: Math.round(fetched.ttfbMs),
    totalMs: Math.round(fetched.totalMs),
    htmlBytes: fetched.html !== null ? fetched.bytes : null,
    truncated: fetched.truncated,
    title: analysis?.title ?? '',
    h1: analysis?.h1 ?? '',
    viewport: analysis?.viewport ?? null,
    tags: analysis ? tagStates(analysis.tags) : null,
    tagIds: analysis
      ? { ga4: analysis.tags.ga4.ids, googleAds: analysis.tags.googleAds.ids, gtm: analysis.tags.gtm.ids }
      : null,
    whatsappLinks: analysis?.whatsapp.links ?? 0,
    telLinks: analysis?.tel.links ?? 0,
    smartLink: analysis?.smartLink ?? false,
    match: match ? { ...match, keywords: target.keywords.map((keyword) => keyword.text) } : null,
    findings: [],
  };
  page.findings = buildPageFindings({
    ...factsFrom(page, analysis, fetched.html !== null ? true : false),
    fetchError: null,
  });
  if (options.collectLinks && analysis && fetched.html !== null && fetched.status === 200) {
    page.siteLinks = candidateSiteLinks(fetched.finalUrl, fetched.html);
  }
  return page;
}

function emptyPage(target: CheckTarget): PageReport {
  return {
    url: target.url,
    clicks30d: target.clicks,
    finalUrl: null,
    status: null,
    fetchError: null,
    redirects: 0,
    ttfbMs: null,
    totalMs: null,
    htmlBytes: null,
    truncated: false,
    title: '',
    h1: '',
    viewport: null,
    tags: null,
    tagIds: null,
    whatsappLinks: 0,
    telLinks: 0,
    smartLink: false,
    match: null,
    findings: [],
  };
}

function factsFrom(page: PageReport, analysis: PageAnalysis | null, isHtml: boolean | null) {
  return {
    fetchError: page.fetchError,
    status: page.status,
    redirects: page.redirects,
    ttfbMs: page.ttfbMs,
    totalMs: page.totalMs,
    htmlBytes: page.htmlBytes,
    truncated: page.truncated,
    isHtml: isHtml ?? true,
    title: page.title,
    h1: page.h1,
    viewport: page.viewport,
    tags: analysis?.tags ?? null,
    whatsappLinks: page.whatsappLinks,
    telLinks: page.telLinks,
    smartLink: page.smartLink,
    match: page.match,
  };
}

export function trackingEvidence(pages: PageReport[]): TrackingEvidence {
  const readable = pages.filter((page) => page.tags !== null);
  if (readable.length === 0) {
    return { googleTag: 'unknown', pagesChecked: 0, line_ar: 'ما قدرنا نقرا كود صفحة الهبوط، فما نعرف إذا الوسم مركّب' };
  }
  const direct = readable.some((page) => page.tags!.googleAds === 'present' || page.tags!.ga4 === 'present');
  if (direct) {
    return { googleTag: 'visible', pagesChecked: readable.length, line_ar: 'وسم قوقل ظاهر في كود صفحة الهبوط' };
  }
  if (readable.some((page) => page.tags!.gtm === 'present')) {
    return {
      googleTag: 'maybe_in_gtm',
      pagesChecked: readable.length,
      line_ar: 'فيه GTM في الصفحة، والوسوم اللي داخله ما نقدر نشوفها من برا',
    };
  }
  return { googleTag: 'not_visible', pagesChecked: readable.length, line_ar: 'ما لقينا وسم قوقل في كود صفحة الهبوط' };
}

export async function runLandingCheck(
  targets: CheckTarget[],
  deps: FetchDeps,
  checkedAt: Date,
  options: { discoverSitePages?: boolean } = {}
): Promise<LandingCheckReport> {
  const pages: PageReport[] = [];
  // One after another: at most three pages, and a polite single connection to the merchant's site.
  for (const target of targets) {
    const page = await checkLandingPage(target, deps, { collectLinks: options.discoverSitePages === true });
    pages.push(page);
  }
  const sitePages = options.discoverSitePages === true ? await crawlSitePages(pages, deps) : undefined;
  const findings = sortFindings(pages.flatMap((page) => page.findings.map((finding) => ({ ...finding, url: page.url })))) as Array<
    Finding & { url: string }
  >;
  return {
    version: 1,
    checkedAt: checkedAt.toISOString(),
    pages,
    findings,
    tracking: trackingEvidence(pages),
    ...(sitePages ? { sitePages } : {}),
  };
}

// ---------------------------------------------------------------------------
// Weekly cadence
// ---------------------------------------------------------------------------

export type StoredLandingCheck = { checked_at: string; report: LandingCheckReport };

export type LandingCheckStore = {
  latest(accountId: string): Promise<StoredLandingCheck | null>;
  save(accountId: string, report: LandingCheckReport): Promise<void>;
};

export function dueForCheck(lastCheckedAt: string | null | undefined, now: Date): boolean {
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= LANDING_CHECK_MIN_INTERVAL_MS;
}

export type GetLandingCheckResult =
  | { status: 'fresh' | 'cached'; report: LandingCheckReport; ageDays: number }
  | { status: 'no_pages' };

/**
 * Returns this week's check, running a new one only when the last is older
 * than seven days. The store is read first and written after, so two callers
 * in the same minute can both run (a harmless duplicate), but a week never
 * sees more than that.
 */
export async function getLandingCheck(args: {
  store: LandingCheckStore;
  accountId: string;
  loadTargets: () => Promise<CheckTarget[]>;
  deps: FetchDeps;
  now: Date;
  /** Also crawl same-site pages (sitelink sources). A stored report that never crawled is re-run once. */
  discoverSitePages?: boolean;
}): Promise<GetLandingCheckResult> {
  const latest = await args.store.latest(args.accountId).catch(() => null);
  const needsCrawl = args.discoverSitePages === true && latest !== null && latest.report.sitePages === undefined;
  if (latest && !dueForCheck(latest.checked_at, args.now) && !needsCrawl) {
    return { status: 'cached', report: latest.report, ageDays: ageDays(latest.checked_at, args.now) };
  }
  const targets = await args.loadTargets();
  if (targets.length === 0) {
    // Nothing to check this time; an older report, if there is one, is still the best we have.
    return latest ? { status: 'cached', report: latest.report, ageDays: ageDays(latest.checked_at, args.now) } : { status: 'no_pages' };
  }
  const report = await runLandingCheck(targets, args.deps, args.now, { discoverSitePages: args.discoverSitePages });
  await args.store.save(args.accountId, report).catch((error) => {
    console.warn('[landing-check] could not store the report', error instanceof Error ? error.message : error);
  });
  return { status: 'fresh', report, ageDays: 0 };
}

function ageDays(checkedAt: string, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(checkedAt)) / 86_400_000));
}
