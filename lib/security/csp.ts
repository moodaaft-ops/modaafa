/**
 * Content-Security-Policy, built per request around a fresh nonce.
 *
 * This lives in middleware rather than `next.config.js` because a nonce has to
 * change on every response, and `headers()` in next.config emits one fixed
 * string at build time. The previous policy shipped `script-src 'self'
 * 'unsafe-inline'`, which is the same as having no script policy at all: an
 * attacker who can inject a `<script>` tag into any page can also inject its
 * contents.
 *
 * `'strict-dynamic'` is what makes this workable with Next.js. Next injects
 * its own bootstrap and streaming-payload scripts inline and then loads the
 * route chunks from those; with `'strict-dynamic'` the nonce on the bootstrap
 * propagates trust to everything it loads, so the chunks do not each need a
 * nonce. Browsers that support `'strict-dynamic'` ignore `'self'` and any host
 * list in `script-src` — `'self'` is kept only as the fallback for browsers
 * that do not.
 *
 * `style-src` deliberately keeps `'unsafe-inline'`: Next and the font loader
 * both emit inline `<style>` blocks that are not nonce-able, and an injected
 * stylesheet is a far weaker primitive than an injected script.
 *
 * The TikTok Pixel needs no `script-src` entry: its inline base snippet carries
 * the nonce and events.js is then loaded by that trusted script, which is
 * exactly what `'strict-dynamic'` allows. What the pixel DOES need is somewhere
 * to report to — `analytics.tiktok.com` for beacons (with an image fallback)
 * and `analytics-ipv6.tiktokw.us` for its IPv6 enrichment call. Both are named
 * exactly, never as a wildcard.
 *
 * `frame-src` is named because `default-src 'self'` would otherwise block every
 * iframe. The only embed the product uses is the reviewed Google Ads account
 * guide on the privacy-enhanced YouTube host, so that one host is allowed.
 * No wildcard and no youtube.com: nothing else may be framed.
 */
export type ContentSecurityPolicyOptions = {
  /**
   * Stripe Elements (the Arabic checkout page, and only that page). Names the
   * hosts Stripe documents for its card field: the script, the frames it draws
   * the field and the 3D Secure check in, the API it talks to and its images.
   * Every other page keeps the closed policy.
   */
  stripe?: boolean;
};

export function buildContentSecurityPolicy(nonce: string, options: ContentSecurityPolicyOptions = {}): string {
  const stripe = options.stripe === true;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // The host is only the fallback for browsers without 'strict-dynamic'; the
    // ones that have it trust Stripe.js because our own nonced bundle loads it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${stripe ? ' https://js.stripe.com https://*.js.stripe.com' : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://lh3.googleusercontent.com https://modaafa.com https://analytics.tiktok.com${stripe ? ' https://*.stripe.com' : ''}`,
    "font-src 'self' data:",
    "media-src 'self' blob:",
    // Written out on purpose for the install worker (/sw.js, see public/sw.js).
    // A worker is checked against worker-src, which otherwise falls back to
    // script-src, where 'strict-dynamic' makes some browsers ignore 'self'.
    // Chromium 141 accepted the registration even without this line (tested,
    // 14 Oct 2026); naming it means the rule for workers does not depend on how
    // a given browser version applies that fallback, and that nothing but our
    // own origin can ever run as a worker. manifest-src would fall back to
    // default-src 'self' anyway; it is spelled out so the intent is visible.
    "worker-src 'self'",
    "manifest-src 'self'",
    `frame-src https://www.youtube-nocookie.com${stripe ? ' https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com' : ''}`,
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://analytics.tiktok.com https://analytics-ipv6.tiktokw.us${stripe ? ' https://api.stripe.com' : ''}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Request header Next.js reads to discover the nonce for its own script tags,
 * and the one the root layout reads to nonce the theme bootstrap script.
 */
export const NONCE_HEADER = 'x-nonce';

/** 128 bits of entropy, base64 — the minimum the CSP spec calls for. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
