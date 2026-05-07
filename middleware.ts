import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient as createSSRClient, type CookieOptions } from '@supabase/ssr';

/**
 * Refreshes the user's Supabase session on every request and
 * gates the (dashboard) routes behind authentication.
 */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });

  const supabase = createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          res.cookies.set({ name, value: '', ...options });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const protectedPaths = ['/dashboard', '/audit', '/campaigns', '/optimizer', '/reports', '/billing', '/settings', '/onboarding'];
  const isProtected = protectedPaths.some((p) => req.nextUrl.pathname.startsWith(p));

  if (isProtected && !user) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (req.nextUrl.pathname === '/login' && user) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)'],
};
