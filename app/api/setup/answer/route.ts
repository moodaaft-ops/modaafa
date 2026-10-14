import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isSimpleExperience } from '@/lib/setup/mode';
import { checkSetupAnswer, recordSetupAnswer, resolveAnswerTarget } from '@/lib/setup/answer-flow';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';

export const dynamic = 'force-dynamic';

/**
 * One answer from the setup chat. The key and the value are both checked
 * against the same rules the screen uses (lib/setup/questions.ts); nothing the
 * browser sends is written as-is except the few free-text fields, which are
 * cleaned and capped there. The decisions live in lib/setup/answer-flow.ts.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isSimpleExperience(process.env, user.email)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const rl = await checkRateLimit({ req, scope: 'setup_answer', limit: 80, windowSeconds: 600, identifier: user.id });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  // The adaptive keys, and the per-kind goal and pain ids, exist only for someone the tree is switched on for.
  const adaptiveOn = isAdaptiveOnboarding(process.env, user.email);
  const checked = checkSetupAnswer(body, adaptiveOn);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
  const answer = checked.answer;

  const { business, account } = await resolveAnswerTarget({ supabase, user, adaptiveOn, answer });
  if (!business) return NextResponse.json({ error: 'no_business' }, { status: 409 });

  let admin: any = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  const outcome = await recordSetupAnswer({ supabase, admin, user, adaptiveOn, business, account, answer });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 500 });
  return NextResponse.json(outcome);
}
