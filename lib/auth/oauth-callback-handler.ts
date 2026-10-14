import { NextRequest, NextResponse } from 'next/server';
import { safeLocalPath } from '@/lib/security/redirect';

type CallbackClient = {
  auth: { exchangeCodeForSession(code: string): PromiseLike<{ error: unknown }> };
};

export type OAuthCallbackDependencies = {
  createSupabase: () => Promise<CallbackClient>;
};

/**
 * GET /auth/callback: trades the `code` for a session and sends the person on
 * to `next` (a local path only), or to the login page with an error.
 *
 * No welcome mail here. A Google user lands on this route confirmed but not
 * registered yet (no phone, no registration_completed); the welcome mail is
 * sent when finalize_registration completes (lib/registration/service.ts).
 */
export function createOAuthCallbackHandler(deps: OAuthCallbackDependencies) {
  return async function GET(req: NextRequest) {
    const requestUrl = new URL(req.url);
    const code = requestUrl.searchParams.get('code');
    const next = safeLocalPath(requestUrl.searchParams.get('next'));
    const redirectTo = new URL(next, requestUrl.origin);

    if (code) {
      const supabase = await deps.createSupabase();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(redirectTo, 303);
    }

    return NextResponse.redirect(new URL('/login?error=auth_callback_failed', requestUrl.origin), 303);
  };
}
