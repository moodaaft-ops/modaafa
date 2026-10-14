import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';
import { runSignalsRequest } from '@/lib/setup/adaptive/signals-request';

export const dynamic = 'force-dynamic';
// The read has its own 6 second deadline; this only leaves room for the token refresh and the two database calls.
export const maxDuration = 30;

/**
 * Reads the customer's selected Google Ads account once and keeps the result
 * (lib/setup/adaptive/signals-store.ts) for the adaptive onboarding screen.
 * Read-only against Google, and it costs no AI, so there is no subscription
 * gate: it sits behind the same flag as the rest of the adaptive tree.
 *
 * - A stored read that is still fresh answers `{ ok: true, fresh: false }`
 *   without touching Google.
 * - Otherwise it reads, stores and answers `{ ok: true, fresh: true, okSignals }`.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isAdaptiveOnboarding(process.env, user.email)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const rl = await checkRateLimit({ req, scope: 'setup_signals', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const workspace = await getAccountWorkspace(user.id).catch(() => null);
  if (!workspace) return NextResponse.json({ error: 'no_business' }, { status: 409 });

  let admin: any = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  const result = await runSignalsRequest({ supabase, admin, user, workspace });
  return NextResponse.json(result.body, { status: result.status });
}
