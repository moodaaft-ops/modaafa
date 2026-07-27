/**
 * Cookie attributes for the Supabase session cookies.
 *
 * @supabase/ssr's DEFAULT_COOKIE_OPTIONS does not set `secure`, so the most
 * valuable cookie in the app was the only one shipped without it while every
 * hand-written cookie in this codebase sets it. Combined with the missing
 * HSTS header that let a network attacker read a full session JWT off the
 * first plaintext navigation. `httpOnly` cannot be set here — the browser
 * client reads these from document.cookie — which makes `secure` plus HSTS
 * the remaining controls.
 *
 * Kept dependency-free so both the server client and the middleware can
 * import it without creating a cycle.
 */
export const SUPABASE_COOKIE_OPTIONS = {
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};
