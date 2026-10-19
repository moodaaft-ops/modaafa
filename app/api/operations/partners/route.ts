import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isOperatorUser } from '@/lib/platform/operators';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { runPartnerAction } from '@/lib/partners/ops-actions';

export const dynamic = 'force-dynamic';

/**
 * POST /api/operations/partners
 * Body: { action: 'create' | 'status' | 'resolve_held' | 'pay_out', ... }
 * Operators only (404 for everyone else). Payments themselves happen outside the
 * platform; "pay_out" records that one was made and closes the commissions it covers.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOperatorUser({ id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null })) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const limit = await checkRateLimit({ req, scope: 'operations_partners', limit: 60, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  let input: unknown = null;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_input' }, { status: 400 });
  }

  try {
    const result = await runPartnerAction(createAdminClient(), user.id, input);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('operations partners action failed', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ ok: false, error: 'action_failed' }, { status: 500 });
  }
}
