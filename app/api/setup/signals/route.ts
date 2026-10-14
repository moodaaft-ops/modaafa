import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getLinkedGoogleAdsAccount, getUserBusinessWithClient } from '@/lib/accounts/selection';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';
import { LINKED_ACCOUNT_SELECT, readAndStoreSignals, type LinkedAccountRow } from '@/lib/setup/adaptive/signals-run';
import { canReuseStoredSignals, countOkSignals, loadStoredSignals } from '@/lib/setup/adaptive/signals-store';

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

  const business = await getUserBusinessWithClient(supabase, user.id).catch(() => null);
  if (!business) return NextResponse.json({ error: 'no_business' }, { status: 409 });

  const linked = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId: business.selected_google_ads_customer_id ?? '',
    select: LINKED_ACCOUNT_SELECT,
  }).catch(() => null);
  const account = (linked?.account ?? null) as LinkedAccountRow | null;
  if (!account) return NextResponse.json({ error: 'no_account' }, { status: 409 });

  let admin: any;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const now = new Date();
  const stored = await loadStoredSignals(admin, account.id, now);
  if (canReuseStoredSignals(stored, now)) return NextResponse.json({ ok: true, fresh: false });

  const run = await readAndStoreSignals({ admin, account, connectedEmail: user.email ?? null });
  if (!run.ok) return NextResponse.json({ error: run.error }, { status: 503 });
  if (!run.saved) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  return NextResponse.json({ ok: true, fresh: true, okSignals: countOkSignals(run.signals) });
}
