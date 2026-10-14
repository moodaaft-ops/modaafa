import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getUserBusinessWithClient } from '@/lib/accounts/selection';
import { isOperatorUser } from '@/lib/platform/operators';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { classifyScenario } from '@/lib/setup/adaptive/scenario';
import { LINKED_ACCOUNT_SELECT, readAndStoreSignals, type LinkedAccountRow } from '@/lib/setup/adaptive/signals-run';
import type { Scenario } from '@/lib/setup/adaptive/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 });
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/operations/onboarding-signals  { accountId }
 *
 * Operators only (everyone else gets a plain 404). Reads one of the operator's
 * OWN linked accounts fresh, ignoring the stored read's age, stores the result
 * and answers with the signals plus what the tree would make of them. This is
 * how a field Google rejects on a real account gets noticed before any branch
 * of the adaptive tree is switched on.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOperatorUser({ id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null })) {
    return notFound();
  }

  try {
    const rl = await checkRateLimit({ req, scope: 'operator_onboarding_signals', limit: 20, windowSeconds: 600, identifier: user.id });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
  if (!ACCOUNT_ID.test(accountId)) return NextResponse.json({ error: 'invalid_account' }, { status: 400 });

  // The account has to be one of the operator's own, read through the
  // operator's own session (row level security), never by id alone.
  const business = await getUserBusinessWithClient(supabase, user.id).catch(() => null);
  if (!business) return NextResponse.json({ error: 'no_business' }, { status: 409 });
  const { data, error } = await supabase
    .from('google_ads_accounts')
    .select(LINKED_ACCOUNT_SELECT)
    .eq('id', accountId)
    .eq('business_id', business.id)
    .eq('status', 'active')
    .not('is_manager', 'is', true)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'account_lookup_failed' }, { status: 503 });
  const account = (data ?? null) as unknown as LinkedAccountRow | null;
  if (!account) return notFound();
  const { count } = await supabase
    .from('google_ads_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', business.id)
    .eq('status', 'active')
    .not('is_manager', 'is', true);

  let admin: any;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const run = await readAndStoreSignals({ admin, account, connectedEmail: user.email ?? null });
  if (!run.ok) return NextResponse.json({ error: run.error }, { status: 503 });

  let scenario: Scenario | null = null;
  let scenarioError: string | null = null;
  try {
    scenario = classifyScenario({ signals: run.signals, linkedAccounts: count ?? 1, connectNoAccount: false, answered: {} });
  } catch {
    scenarioError = 'classify_failed';
  }

  return NextResponse.json(
    { ok: true, accountId: account.id, saved: run.saved, signals: run.signals, scenario, scenarioError },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
