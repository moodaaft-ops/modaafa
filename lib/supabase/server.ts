import { createServerClient as createSSRClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client for use in Server Components, Route Handlers, and Server Actions.
 *
 * Uses the user's session cookies to enforce RLS automatically.
 */
export function createServerClient() {
  const cookieStore = cookies();
  return createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Ignored - called from a Server Component which can't set cookies
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options });
          } catch {
            // Ignored - same reason
          }
        },
      },
    }
  );
}

/**
 * Service-role client - bypasses RLS. Use ONLY for admin tasks
 * (webhooks, scheduled jobs). Never expose to client code.
 */
export function createAdminClient() {
  return createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: { get: () => undefined, set: () => {}, remove: () => {} },
    }
  );
}
