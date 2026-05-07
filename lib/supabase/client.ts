import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client for Client Components.
 * RLS applies — users only see their own data.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
