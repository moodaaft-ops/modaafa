import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveClientIp } from '@/lib/security/rate-limit';
import { normalizePartnerCode, partnersEnabled, REF_COOKIE, REF_COOKIE_OPTIONS } from '@/lib/partners/config';
import { partnerHashSalt, visitorHash } from '@/lib/partners/visitor';
import { recordPartnerClick } from '@/lib/partners/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /r/<code>: the short link a partner shares.
 *
 * Counts one click per visitor per day, remembers the partner for 60 days (the
 * most recent link wins), and sends the visitor to the sign-up page. An unknown,
 * paused or malformed code sets nothing and still lands on the sign-up page, so a
 * mistyped link never shows an error to a customer. With the programme off it
 * is a plain redirect.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const destination = new URL('/register', req.nextUrl.origin);
  const response = NextResponse.redirect(destination, 302);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  if (!partnersEnabled()) return response;

  const code = normalizePartnerCode((await params).code);
  if (!code) return response;

  try {
    const day = new Date().toISOString().slice(0, 10);
    const hash = visitorHash(resolveClientIp(req), req.headers.get('user-agent'), day, partnerHashSalt());
    const outcome = await recordPartnerClick(createAdminClient(), code, hash, '/register');
    if (outcome !== 'unknown') {
      response.cookies.set({ name: REF_COOKIE, value: code, ...REF_COOKIE_OPTIONS, secure: process.env.NODE_ENV === 'production' });
    }
  } catch (error) {
    // The click is a statistic; the visitor still gets the page, but a visitor
    // whose click could not be checked is not remembered either.
    console.error('[r/code] click failed', error instanceof Error ? error.message : 'unknown');
  }
  return response;
}
