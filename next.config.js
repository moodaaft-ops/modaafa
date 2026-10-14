/** @type {import('next').NextConfig} */
// Content-Security-Policy is deliberately NOT here. It now carries a
// per-request nonce and is built in `middleware.ts` (see `lib/security/csp.ts`);
// a policy emitted from this file is one fixed string baked at build time,
// which is the one thing a nonce cannot be. Keeping a copy here as well would
// send two CSP headers on every document, and browsers enforce the
// intersection of both — a combination that is hard to reason about and
// harder to debug when a script is blocked.
const securityHeaders = [
  {
    // `upgrade-insecure-requests` above only upgrades subresources of an
    // already-loaded document. Without HSTS the FIRST navigation to
    // ai.modaafa.com still leaves over plaintext, carrying the Supabase
    // session cookie with it. Vercel does not add this header on its own.
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(self), geolocation=(), payment=(self), usb=(), browsing-topics=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig = {
  reactStrictMode: true,
  // Drop the `X-Powered-By: Next.js` header — a free version-fingerprint for
  // anyone probing the stack, and nothing depends on it.
  poweredByHeader: false,
  // Next 15.5 streams <title>, description and Open Graph tags into <body> for
  // every user agent except a short built-in list of "HTML-limited" bots
  // (bingbot, Applebot, social-card fetchers...). AI answer-engine crawlers
  // (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, ChatGPT-User, CCBot) read
  // the raw HTML and may parse only <head>, so they saw a page with no title
  // or description. Matching every user agent makes Next wait for metadata and
  // emit it in <head> for all of them. Our metadata is static (no
  // generateMetadata, no data fetching), so blocking on it costs nothing.
  // Top-level option in Next 15.5 (not under `experimental`), takes a RegExp.
  htmlLimitedBots: /.*/,
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'modaafa.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};
module.exports = nextConfig;
