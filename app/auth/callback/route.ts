import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { safeLocalPath } from '@/lib/security/redirect';
import { createAdminClient } from '@/lib/supabase/server';
import { sendDueWelcomeEmails } from '@/lib/messaging/welcome';

export async function GET(req: NextRequest) {
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get('code');
  const next = safeLocalPath(requestUrl.searchParams.get('next'));
  const redirectTo = new URL(next, requestUrl.origin);

  if (code) {
    const supabase = await createServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Google sign-in lands here with a confirmed address. Send the welcome
      // mail now instead of waiting for the every-minute sweep. Best effort and
      // capped at 4s: a failure here never blocks the sign-in, and the sweep
      // is the backstop. Safe on every login: a user without a fresh
      // registration_completed event, or already mailed, is skipped.
      const userId = data?.user?.id;
      if (userId) {
        await Promise.race([
          (async () => sendDueWelcomeEmails(createAdminClient(), { userId, limit: 1 }))().catch((e) =>
            console.error('welcome email on callback failed', e)
          ),
          new Promise((resolve) => setTimeout(resolve, 4000)),
        ]);
      }
      return NextResponse.redirect(redirectTo, 303);
    }
  }

  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', requestUrl.origin), 303);
}
