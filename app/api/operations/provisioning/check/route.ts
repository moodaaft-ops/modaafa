import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isOperatorUser } from '@/lib/platform/operators';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { loadProvisioningContext } from '@/lib/provisioning/credentials';
import { unlinkAfterAcceptEnabled } from '@/lib/provisioning/flag';
import { sweepProvisions } from '@/lib/provisioning/service';
import { supabaseProvisionStore } from '@/lib/provisioning/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/operations/provisioning/check
 * «افحص الحين»: the hourly sweep, run by hand. Operators only (404 for everyone else).
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
    const limit = await checkRateLimit({ req, scope: 'provisioning_check', limit: 20, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  try {
    const admin = createAdminClient();
    const ads = await loadProvisioningContext(admin);
    if (!ads) return NextResponse.json({ error: 'not_configured' }, { status: 409 });
    const summary = await sweepProvisions(
      { store: supabaseProvisionStore(admin), ads, unlinkAfterAccept: unlinkAfterAcceptEnabled() },
      { budgetMs: 45_000 }
    );
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error('manual provisioning check failed', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'check_failed' }, { status: 500 });
  }
}
