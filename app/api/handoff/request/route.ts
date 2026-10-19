import { NextRequest, NextResponse } from 'next/server';
import { getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import { agencyHandoffEnabled } from '@/lib/handoff/flag';
import { recordHandoffRequest } from '@/lib/handoff/store';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';

/** The merchant tapped «خلّ فريق مُضاعفة يمسكه». Records the request for the operator. */
export async function POST(req: NextRequest) {
  if (!agencyHandoffEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const limit = await checkRateLimit({ req, scope: 'handoff_request', limit: 5, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const payload = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const customerId = String(payload?.customer_id ?? '').replace(/\D/g, '');
  if (!customerId) return NextResponse.json({ error: 'account_required' }, { status: 400 });

  const linked = await getLinkedGoogleAdsAccount({ supabase, userId: user.id, customerId, select: 'id, customer_id' });
  if (!linked.account) return NextResponse.json({ error: linked.error ?? 'account_not_found' }, { status: 404 });

  try {
    await recordHandoffRequest(createAdminClient(), linked.account.id);
  } catch (error) {
    console.error('Handoff request failed', error);
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
