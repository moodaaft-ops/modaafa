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
 */
export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://lh3.googleusercontent.com https://modaafa.com",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
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
