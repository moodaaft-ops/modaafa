import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient as createSSRClient } from '@supabase/ssr/dist/module/createServerClient';
import type { CookieOptions } from '@supabase/ssr/dist/module/types';
import { SUPABASE_COOKIE_OPTIONS } from '@/lib/supabase/cookie-options';
import { buildContentSecurityPolicy, generateNonce, NONCE_HEADER } from '@/lib/security/csp';

/**
 * Refreshes the user's Supabase session on every request, gates the
 * (dashboard) routes behind authentication, and attaches a per-request
 * nonce-based Content-Security-Policy.
 */
export async function middleware(req: NextRequest) {
  const protectedPaths = ['/dashboard', '/assistant', '/audit', '/campaigns', '/optimizer', '/reports', '/billing', '/settings', '/onboarding'];
  const isProtected = protectedPaths.some((p) => req.nextUrl.pathname.startsWith(p));
  const isLogin = req.nextUrl.pathname === '/login';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce);

  /**
   * Builds the outgoing response with the nonce attached.
   *
   * The request headers are snapshotted HERE rather than at the top of the
   * function on purpose: the Supabase client below rotates the session by
   * calling `req.cookies.set(...)`, which mutates the request's own cookie
   * header. Snapshotting earlier would hand the Server Components rendered in
   * this same request the pre-rotation cookie and reintroduce the
   * double-refresh logout this middleware already fixes once.
   *
   * Next.js discovers the nonce for its own inline bootstrap scripts by
   * reading the Content-Security-Policy REQUEST header, so it is set on both
   * sides; `x-nonce` is what the root layout reads for the theme script.
   */
  const nextWithNonce = () => {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(NONCE_HEADER, nonce);
    requestHeaders.set('Content-Security-Policy', csp);
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set('Content-Security-Policy', csp);
    return res;
  };

  // A redirect carries no document of ours, but the header costs nothing and
  // keeps every response on this matcher consistent.
  const redirectWithNonce = (url: URL) => {
    const res = NextResponse.redirect(url);
    res.headers.set('Content-Security-Policy', csp);
    return res;
  };

  if (!isProtected && !isLogin) return nextWithNonce();

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isProtected) {
      return redirectWithNonce(new URL('/login?error=missing_config', req.url));
    }
    return nextWithNonce();
  }

  // A session refresh has to land on BOTH the request and the response.
  //
  // Writing only to the response left the Server Components rendered in this
  // same request reading the pre-rotation refresh token, so they tried to
  // refresh a second time. Once that second attempt fell outside Supabase's
  // reuse window it returned `refresh_token_already_used`, `getUser()` came
  // back null, and the dashboard layout redirected a user the middleware had
  // just authenticated — a random logout with no error message.
  //
  // The cookies are buffered rather than applied immediately so that they end
  // up on whichever response we finally return, including redirects. Rebuilding
  // the response inside each `set` would discard earlier chunks of a chunked
  // session cookie.
  const pendingCookies: Array<{ name: string; value: string; options: CookieOptions }> = [];

  const stageCookie = (name: string, value: string, options: CookieOptions) => {
    req.cookies.set(name, value);
    pendingCookies.push({ name, value, options });
  };

  const withRefreshedSession = <T extends NextResponse>(response: T): T => {
    for (const cookie of pendingCookies) {
      response.cookies.set({ name: cookie.name, value: cookie.value, ...cookie.options });
    }
    return response;
  };

  const supabase = createSSRClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        stageCookie(name, value, options);
      },
      remove(name: string, options: CookieOptions) {
        stageCookie(name, '', options);
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  if (isProtected && !user) {
    const loginUrl = new URL('/login', req.url);
    // Preserve the query string too, so deep links such as
    // /billing?plan=growth survive the login round trip.
    loginUrl.searchParams.set('next', `${req.nextUrl.pathname}${req.nextUrl.search}`);
    return withRefreshedSession(redirectWithNonce(loginUrl));
  }

  if (isLogin && user) {
    return withRefreshedSession(redirectWithNonce(new URL('/dashboard', req.url)));
  }

  return withRefreshedSession(nextWithNonce());
}

export const config = {
  // API routes are excluded because they return JSON, never a document, so a
  // script policy has nothing to govern there. The non-CSP security headers in
  // next.config.js still cover them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
