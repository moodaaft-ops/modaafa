import type { JarvisReadTool } from './types';
import { cleanText, okResult, parseArgs, runQuery, tryQuery } from './shared';
import { createAdminClient } from '@/lib/supabase/server';
import { getLandingCheck, type LandingCheckStore, type PageReport } from '@/lib/landing-check/run';
import { FINAL_URLS_GAQL, KEYWORDS_GAQL, selectTargets } from '@/lib/landing-check/sources';
import { supabaseLandingCheckStore } from '@/lib/landing-check/store';
import { pinnedHttpsTransport, systemResolver } from '@/lib/landing-check/transport';
import type { FetchDeps } from '@/lib/landing-check/fetch';
import { landingCheckEnabled } from '@/lib/landing-check/flag';

const FINDINGS_PER_PAGE = 5;

export type LandingToolDeps = {
  store: () => LandingCheckStore | null;
  fetchDeps: FetchDeps;
  /** Defaults to LANDING_CHECK_ENABLED, read on every run. */
  enabled?: () => boolean;
};

function defaultDeps(): LandingToolDeps {
  return {
    store: () => {
      try {
        return supabaseLandingCheckStore(createAdminClient());
      } catch {
        return null;
      }
    },
    fetchDeps: { resolve: systemResolver, transport: pinnedHttpsTransport },
  };
}

function pageSummary(page: PageReport) {
  let shown = page.url;
  try {
    const url = new URL(page.url);
    shown = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    // keep the raw text
  }
  return {
    page: cleanText(shown),
    clicks_30d: page.clicks30d,
    status: page.status,
    fetch_error: page.fetchError,
    redirects: page.redirects,
    ttfb_ms: page.ttfbMs,
    load_ms: page.totalMs,
    html_kb: page.htmlBytes === null ? null : Math.round(page.htmlBytes / 1000),
    mobile_viewport: page.viewport ? page.viewport.present && page.viewport.deviceWidth : null,
    title: cleanText(page.title),
    h1: cleanText(page.h1),
    message_match: page.match
      ? {
          score: page.match.score,
          missing: page.match.missing.map(cleanText),
          body_only: page.match.bodyOnly.map(cleanText),
        }
      : null,
    tags: page.tags,
    whatsapp_links: page.whatsappLinks,
    tel_links: page.telLinks,
    smart_link: page.smartLink,
    findings: page.findings
      .filter((finding) => finding.severity !== 'good')
      .slice(0, FINDINGS_PER_PAGE)
      .map((finding) => ({
        severity: finding.severity,
        text_ar: cleanText(finding.text_ar),
        step_ar: cleanText(finding.step_ar),
      })),
  };
}

/** Built with injectable deps so tests never touch the network or the database. */
export function createLandingCheckTool(deps: LandingToolDeps = defaultDeps()): JarvisReadTool {
  return {
    name: 'get_landing_check',
    description:
      "Checks the account's top landing pages (by clicks): HTTP status, server speed, mobile setup, whether the title and H1 match the ad group's keywords, which tracking tags and WhatsApp or phone buttons the page code shows. Run at most once a week per account (a newer result is reused). Use it when conversions are low despite clicks, before judging tracking, or when asked about the website.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(input, ctx) {
      // Re-checked at run time like the loop tools (the list is fixed at start-up).
      if (!(deps.enabled ?? landingCheckEnabled)()) return { ok: false, error: 'disabled', message_ar: 'فحص صفحة الهبوط مو مفعّل الحين' };
      parseArgs(input, []);
      const store = deps.store();
      if (!store) throw new Error('landing check store unavailable');

      const result = await getLandingCheck({
        store,
        accountId: ctx.accountId,
        deps: deps.fetchDeps,
        now: ctx.now,
        loadTargets: async () => {
          const [ads, keywords] = await Promise.all([runQuery(ctx, FINAL_URLS_GAQL), tryQuery(ctx, 'landing_keywords', KEYWORDS_GAQL)]);
          return selectTargets(ads, keywords ?? []);
        },
      });

      if (result.status === 'no_pages') {
        return okResult(
          {
            status: 'no_pages',
            note_ar: 'ما لقينا إعلان شغّال له رابط صفحة هبوط نفحصه',
          },
          []
        );
      }

      return okResult(
        {
          status: result.status,
          checked_at: result.report.checkedAt,
          age_days: result.ageDays,
          note_ar:
            'القياس من سيرفرنا. الوسوم اللي تنحقن بعد تحميل الصفحة ما نشوفها، وكود الصفحة بس هو اللي نقيسه.',
          pages: result.report.pages.map(pageSummary),
          tracking_evidence: result.report.tracking,
        },
        []
      );
    },
  };
}

export const getLandingCheckTool = createLandingCheckTool();
