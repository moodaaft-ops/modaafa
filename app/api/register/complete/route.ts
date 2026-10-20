import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { validateRegistration } from '@/lib/registration/validate';
import { finalizeForRequest } from '@/lib/registration/service';

/**
 * POST /api/register/complete: step two for someone who is already signed in
 * (Google sign-in, or an email link opened before the phone was known) and
 * still owes a phone number. The email comes from the session, never the body.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ ok: false, error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const parsed = validateRegistration(body, { requireEmail: false });
  if (!parsed.ok) return NextResponse.json({ ok: false, error: 'validation', errors: parsed.errors }, { status: 400 });

  try {
    const limit = await checkRateLimit({ req, scope: 'register_complete', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  const outcome = await finalizeForRequest(req, user, { name: parsed.value.name, phone: parsed.value.phoneE164 });
  switch (outcome.status) {
    case 'completed':
    case 'already':
      return NextResponse.json({ ok: true, redirect: '/welcome' });
    case 'phone_taken':
      return NextResponse.json({ ok: false, error: 'phone_taken' }, { status: 409 });
    case 'needs_details':
      return NextResponse.json({ ok: false, error: 'validation', errors: { phone: 'رقم الجوال غير صحيح.' } }, { status: 400 });
    default:
      console.error('[api/register/complete] failed', outcome.detail);
      return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
}
