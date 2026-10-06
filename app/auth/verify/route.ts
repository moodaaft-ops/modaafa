import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createEmailVerifyHandler } from '@/lib/auth/email-confirm-handler';

export const POST = createEmailVerifyHandler({ createSupabase: createServerClient });

// Opening /auth/verify directly (or pressing back onto it) has nothing to show.
export function GET(req: NextRequest) {
  return NextResponse.redirect(new URL('/login', req.url), 303);
}
