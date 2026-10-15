import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { buildAuthUrl } from '@/lib/google-ads/oauth';
import { persistOAuthState } from '@/lib/auth/oauth-state-store';
import { isOperatorUser } from '@/lib/platform/operators';
import { provisioningMccId } from '@/lib/provisioning/flag';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { createServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const PAGE = '/operations/provisioning';

/**
 * GET /api/operations/provisioning/connect
 * Operators only (anyone else gets a plain 404). Sends the operator to Google's
 * consent screen to connect the Google user who owns the dedicated manager
 * account. It reuses the existing redirect URI: the single-use state is issued
 * for the purpose `provisioning_mcc`, and the callback of the normal Google Ads
 * connect hands such states to lib/provisioning/connect-callback.ts. There is no
 * cookie fallback for this state: if it cannot be stored server-side, nothing starts.
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?next=${PAGE}`, req.url));
  if (!isOperatorUser({ id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null })) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!provisioningMccId()) return NextResponse.redirect(new URL(`${PAGE}?error=mcc_not_set`, req.url), 303);

  try {
    const limit = await checkRateLimit({ req, scope: 'provisioning_mcc_connect', limit: 10, windowSeconds: 900, identifier: user.id });
    if (!limit.allowed) {
      return NextResponse.redirect(new URL(`${PAGE}?error=too_many_requests`, req.url), { status: 303, headers: rateLimitHeaders(limit) });
    }
  } catch {
    return NextResponse.redirect(new URL(`${PAGE}?error=security_service_unavailable`, req.url), 303);
  }

  const state = randomBytes(32).toString('hex');
  let authUrl: string;
  try {
    authUrl = buildAuthUrl(state);
  } catch {
    return NextResponse.redirect(new URL(`${PAGE}?error=oauth_config_missing`, req.url), 303);
  }

  const stored = await persistOAuthState({ userId: user.id, state, purpose: 'provisioning_mcc' });
  if (!stored) return NextResponse.redirect(new URL(`${PAGE}?error=state_unavailable`, req.url), 303);

  return NextResponse.redirect(authUrl);
}
