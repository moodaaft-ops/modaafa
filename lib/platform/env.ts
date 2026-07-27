export function isConfiguredEnv(value?: string | null): value is string {
  if (!value) return false;
  const normalized = value.trim();
  return Boolean(
    normalized &&
      normalized !== '""' &&
      normalized !== "''" &&
      normalized.toLowerCase() !== 'undefined' &&
      normalized.toLowerCase() !== 'null'
  );
}

export function envValue(name: string) {
  return process.env[name];
}

/**
 * The canonical, absolute app URL — never derived from the request.
 *
 * Every Stripe redirect (success, cancel, portal return) used
 * `process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin`. `??` only fires on
 * `undefined`, so a blank env var produced `https:///api/...`, and the origin
 * fallback is derived from the Host header, which means a spoofed host could
 * steer a post-payment redirect (session_id attached) to another domain.
 *
 * In development the caller's origin is accepted as a convenience; in
 * production a missing value throws rather than silently degrading.
 */
export function requireAppUrl(devFallbackOrigin?: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (isConfiguredEnv(configured)) return configured.trim().replace(/\/+$/, '');

  if (process.env.NODE_ENV !== 'production' && devFallbackOrigin) {
    return devFallbackOrigin.replace(/\/+$/, '');
  }

  throw new Error('NEXT_PUBLIC_APP_URL is not configured');
}
