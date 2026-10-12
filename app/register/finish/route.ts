import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { finalizeForRequest } from '@/lib/registration/service';

/**
 * Where the email link (and Google sign-in from the register page) lands.
 * Completes the registration if the details are already known, otherwise sends
 * the person to the short "complete your details" form.
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/register/finish', req.url), 303);

  const outcome = await finalizeForRequest(req, user);
  switch (outcome.status) {
    case 'completed':
    case 'already':
      return NextResponse.redirect(new URL('/welcome', req.url), 303);
    case 'phone_taken':
      return NextResponse.redirect(new URL('/register/complete?error=phone_taken', req.url), 303);
    case 'needs_details':
      return NextResponse.redirect(new URL('/register/complete', req.url), 303);
    default:
      console.error('[register/finish] failed', outcome.detail);
      return NextResponse.redirect(new URL('/register/complete?error=failed', req.url), 303);
  }
}
