import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isOperatorUser } from '@/lib/platform/operators';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { shadowModeEnabled } from '@/lib/shadow/flag';
import { markShadowAccount, saveShadowReview, unmarkShadowAccount } from '@/lib/shadow/store';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/operations/shadow
 *   { action: 'mark' | 'unmark', customer_id, note? }
 *   { action: 'review', account_id, decision_id?, verdict: 'right'|'wrong'|'missed', category?, note? }
 * Operators only (404 for everyone else), and only with SHADOW_MODE_ENABLED.
 */
export async function POST(req: NextRequest) {
  if (!shadowModeEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOperatorUser({ id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null })) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const limit = await checkRateLimit({ req, scope: 'operations_shadow', limit: 120, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  const action = String(body.action ?? '');
  const admin = createAdminClient();

  try {
    if (action === 'mark' || action === 'unmark') {
      const customerId = String(body.customer_id ?? '').replace(/\D/g, '');
      if (customerId.length !== 10) return NextResponse.json({ error: 'customer_id_invalid' }, { status: 400 });
      const { data: account, error } = await admin
        .from('google_ads_accounts')
        .select('id, customer_id, is_manager')
        .eq('customer_id', customerId)
        .limit(2);
      if (error) throw error;
      if (!account || account.length === 0) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
      if (account.length > 1) return NextResponse.json({ error: 'account_ambiguous' }, { status: 409 });
      if (action === 'mark') await markShadowAccount(admin, account[0].id, user.id, typeof body.note === 'string' ? body.note : null);
      else await unmarkShadowAccount(admin, account[0].id);
      return NextResponse.json({ ok: true });
    }

    if (action === 'review') {
      const verdict = String(body.verdict ?? '');
      if (!['right', 'wrong', 'missed'].includes(verdict)) return NextResponse.json({ error: 'verdict_invalid' }, { status: 400 });
      const accountId = String(body.account_id ?? '');
      const decisionId = body.decision_id ? String(body.decision_id) : null;
      if (!UUID.test(accountId) || (decisionId !== null && !UUID.test(decisionId))) {
        return NextResponse.json({ error: 'id_invalid' }, { status: 400 });
      }
      await saveShadowReview({
        admin,
        accountId,
        decisionId,
        verdict: verdict as 'right' | 'wrong' | 'missed',
        category: typeof body.category === 'string' ? body.category : null,
        note: typeof body.note === 'string' ? body.note : null,
        reviewerId: user.id,
      });
      return NextResponse.json({ ok: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    if (message === 'decision_required' || message === 'decision_not_found') {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error('shadow action failed', message);
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
  return NextResponse.json({ error: 'action_invalid' }, { status: 400 });
}
