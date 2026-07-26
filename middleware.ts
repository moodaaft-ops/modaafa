import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient as createSSRClient, type CookieOptions } from '@supabase/ssr';
import { SUPABASE_COOKIE_OPTIONS } from '@/lib/supabase/cookie-options';

/**
 * Refreshes the user's Supabase session on every request and
 * gates the (dashboard) routes behind authentication.
 */
export async function middleware(req: NextRequest) {
  const protectedPaths = ['/dashboard', '/assistant', '/audit', '/campaigns', '/optimizer', '/reports', '/billing', '/settings', '/onboarding'];
  const isProtected = protectedPaths.some((p) => req.nextUrl.pathname.startsWith(p));
  const isLogin = req.nextUrl.pathname === '/login';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!isProtected && !isLogin) return NextResponse.next({ request: req });

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isProtected) {
      return NextResponse.redirect(new URL('/login?error=missing_config', req.url));
    }
    return NextResponse.next({ request: req });
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
    return withRefreshedSession(NextResponse.redirect(loginUrl));
  }

  if (isLogin && user) {
    return withRefreshedSession(NextResponse.redirect(new URL('/dashboard', req.url)));
  }

  return withRefreshedSession(NextResponse.next({ request: req }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
