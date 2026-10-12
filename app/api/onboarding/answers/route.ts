import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { parseOnboardingAnswers } from '@/lib/growth/onboarding-answers';
import { saveAnswers } from '@/lib/growth/answers-store';

/**
 * Saves the three first-login answers (or a skip) for the signed-in user.
 * The user id always comes from the session, never from the request body, so
 * one person cannot write another person's answers.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const limit = await checkRateLimit({ req, scope: 'onboarding_answers', limit: 20, windowSeconds: 3600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = parseOnboardingAnswers(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const saved = await saveAnswers(
    user.id,
    parsed.skipped ? { skipped: true } : { skipped: false, answers: parsed.answers }
  );
  if (!saved.ok) return NextResponse.json({ error: 'save_failed' }, { status: 503 });
  return NextResponse.json({ ok: true });
}
