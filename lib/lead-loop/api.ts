import { NextRequest, NextResponse } from 'next/server';
import { getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isLeadLoopEnabled } from './flag';

/**
 * Shared front door of the merchant-facing lead-loop routes: same origin,
 * signed in, flag, rate limit, and an account that belongs to the caller.
 * Writes then go through the service role, scoped to the verified account id.
 */
export type LeadApiContext = {
  user: { id: string; email?: string | null };
  admin: any;
  account: { id: string; customer_id: string; customer_name: string | null };
  body: Record<string, unknown>;
};

export async function authorizeLeadApi(req: NextRequest, scope: string): Promise<LeadApiContext | NextResponse> {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isLeadLoopEnabled(process.env, user.email)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const limit = await checkRateLimit({ req, scope, limit: 60, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'too_many_requests', message: 'انتظر شوي وجرب مرة ثانية' },
        { status: 429, headers: rateLimitHeaders(limit) }
      );
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });

  const customerId = String(body.customer_id ?? '').replace(/\D/g, '');
  if (!customerId) return NextResponse.json({ error: 'account_required' }, { status: 400 });
  const linked = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id, customer_name',
  });
  if (!linked.account) return NextResponse.json({ error: linked.error ?? 'account_not_found' }, { status: 404 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  return { user, admin, account: linked.account as LeadApiContext['account'], body };
}
