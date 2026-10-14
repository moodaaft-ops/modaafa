import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { safeLocalPath } from '@/lib/security/redirect';

export async function GET(req: NextRequest) {
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get('code');
  const next = safeLocalPath(requestUrl.searchParams.get('next'));
  const redirectTo = new URL(next, requestUrl.origin);

  if (code) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // No welcome mail here. A Google user lands on this route confirmed but not
    // registered yet (no phone, no registration_completed); the welcome mail is
    // sent when finalize_registration completes (lib/registration/service.ts).
    if (!error) return NextResponse.redirect(redirectTo, 303);
  }

  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', requestUrl.origin), 303);
}
