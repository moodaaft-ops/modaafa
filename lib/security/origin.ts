import type { NextRequest } from 'next/server';

/**
 * Defence-in-depth CSRF check for state-changing requests.
 *
 * `SameSite=Lax` on the session cookie already blocks a cross-site POST, and
 * the CSP restricts `form-action` — but these endpoints spend paid quota and
 * some of them push live mutations to a customer's Google Ads account, so a
 * single control is not enough. A request whose Origin (or Referer, which
 * older browsers send instead) points somewhere other than this app is
 * rejected outright.
 *
 * Requests with neither header are allowed: server-to-server callers
 * (Stripe webhooks, Vercel Cron) send none, and each of those has its own
 * signature or shared-secret check.
 */
export function isSameOriginRequest(req: NextRequest) {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const candidate = origin ?? referer;
  if (!candidate) return true;

  const allowed = new Set<string>();
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      allowed.add(new URL(configured).origin);
    } catch {
      // Ignored: a malformed env var must not lock every user out.
    }
  }
  allowed.add(req.nextUrl.origin);

  try {
    return allowed.has(new URL(candidate).origin);
  } catch {
    return false;
  }
}
