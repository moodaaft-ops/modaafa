import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { checkRateLimit, resolveClientIp } from '@/lib/security/rate-limit';
import { isLeadLoopServing } from './flag';
import { isValidSlug } from './ref-code';
import { getSettingsBySlug, recordLeadClick } from './store';
import { buildPlainWhatsappUrl } from './whatsapp';

/**
 * GET /w/<slug>: the merchant's smart WhatsApp link.
 *
 * The visitor must always reach WhatsApp. So the safeguards only decide
 * whether the click is RECORDED: a crawler, a HEAD request, a rate-limited
 * burst or a storage outage all still redirect, they just leave no lead row.
 * Only an unknown or disabled slug answers 404.
 */
const BOT_PATTERN =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp\/|telegram|slack|twitter|linkedin|embedly|quora|pinterest|vkshare|headlesschrome|lighthouse|pingdom|uptime|curl\/|wget\/|python-requests|go-http-client|okhttp|java\//i;

export function looksAutomated(userAgent: string | null | undefined) {
  if (!userAgent) return true;
  return BOT_PATTERN.test(userAgent);
}

const PER_VISITOR = { limit: 20, windowSeconds: 60 };
const PER_LINK = { limit: 600, windowSeconds: 3600 };

const defaultDependencies = {
  createAdminClient,
  checkRateLimit,
  resolveClientIp,
  isLeadLoopServing,
  getSettingsBySlug,
  recordLeadClick,
  now: () => new Date(),
};

export type LeadRedirectDependencies = typeof defaultDependencies;

function redirectTo(url: string) {
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function notFound() {
  return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export function createLeadRedirectHandler(overrides: Partial<LeadRedirectDependencies> = {}) {
  const deps: LeadRedirectDependencies = { ...defaultDependencies, ...overrides };

  return async function handleLeadRedirect(req: NextRequest, slug: string) {
    if (!deps.isLeadLoopServing() || !isValidSlug(slug)) return notFound();

    let admin;
    try {
      admin = deps.createAdminClient();
    } catch {
      return new NextResponse('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    let settings;
    try {
      settings = await deps.getSettingsBySlug(admin, slug);
    } catch (error) {
      console.error('lead link lookup failed', { error: error instanceof Error ? error.message : 'unknown' });
      return new NextResponse('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!settings || settings.enabled === false) return notFound();

    // From here on the visitor is always sent to WhatsApp, with or without a recorded click.
    const plainUrl = buildPlainWhatsappUrl(settings.whatsapp_number, settings.default_text);
    const skipRecording = req.method === 'HEAD' || looksAutomated(req.headers.get('user-agent'));
    if (skipRecording) return redirectTo(plainUrl);

    try {
      const ip = deps.resolveClientIp(req) ?? 'unknown';
      const [visitor, link] = await Promise.all([
        deps.checkRateLimit({ req, scope: 'lead_link_visitor', identifier: `${slug}:${ip}`, ...PER_VISITOR }),
        deps.checkRateLimit({ req, scope: 'lead_link_total', identifier: slug, ...PER_LINK }),
      ]);
      if (!visitor.allowed || !link.allowed) return redirectTo(plainUrl);
    } catch {
      // Limiter storage down: do not write blind.
      return redirectTo(plainUrl);
    }

    try {
      const { url } = await deps.recordLeadClick(
        admin,
        settings,
        { searchParams: req.nextUrl.searchParams, referer: req.headers.get('referer') },
        deps.now()
      );
      return redirectTo(url);
    } catch (error) {
      console.error('lead click was not recorded', { error: error instanceof Error ? error.message : 'unknown' });
      return redirectTo(plainUrl);
    }
  };
}
