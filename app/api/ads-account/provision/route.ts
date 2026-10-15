import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { loadProvisioningContext } from '@/lib/provisioning/credentials';
import { isAccountProvisioning, provisioningMccId, unlinkAfterAcceptEnabled } from '@/lib/provisioning/flag';
import { handleProvisionGet, handleProvisionPost, type HandlerResult } from '@/lib/provisioning/handler';
import { isRegistrationStrictlyComplete, loadProvisioningState } from '@/lib/provisioning/load';
import { supabaseProvisionStore } from '@/lib/provisioning/store';

export const dynamic = 'force-dynamic';
// Creating the account and sending the invitation are two Google calls in one request.
export const maxDuration = 60;

function respond(result: HandlerResult) {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

async function currentUser() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { id: user.id, email: user.email ?? null } : null;
}

/**
 * POST /api/ads-account/provision  { email? }
 * «افتحه لي»: create the user's Google Ads account under the dedicated manager
 * account and invite their email as admin. The gates (signed in, feature on for
 * this user, rate limit, registration finished, configured; an existing row is
 * returned untouched, only a `failed` row is retried) live in
 * lib/provisioning/handler.ts, where they are tested.
 */
export async function POST(req: NextRequest) {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ ok: false, error: 'service_unavailable' }, { status: 503 });
  }

  return respond(
    await handleProvisionPost({
      isSameOrigin: () => isSameOriginRequest(req),
      getUser: currentUser,
      isEnabledFor: (email) => isAccountProvisioning(process.env, email) && provisioningMccId() !== null,
      rateLimit: async (userId) => {
        const limit = await checkRateLimit({ req, scope: 'ads_account_provision', limit: 6, windowSeconds: 900, identifier: userId });
        return { allowed: limit.allowed, headers: limit.allowed ? undefined : rateLimitHeaders(limit) };
      },
      isRegistered: (userId) => isRegistrationStrictlyComplete(admin, userId),
      loadAds: () => loadProvisioningContext(admin),
      store: supabaseProvisionStore(admin),
      unlinkAfterAccept: unlinkAfterAcceptEnabled(),
      readBody: async () => (await req.json().catch(() => null)) as { email?: unknown } | null,
    })
  );
}

/**
 * GET /api/ads-account/provision
 * The state of the user's request. While the invitation is open and the last
 * look at Google is older than 30 seconds, it looks again (so «قبلتها، كمّل»
 * answers right away); otherwise it only reads the row.
 */
export async function GET() {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    // Not an error for the screen: it falls back to the WhatsApp tile.
    return NextResponse.json({ ok: true, available: false, provision: null });
  }

  return respond(
    await handleProvisionGet({
      getUser: currentUser,
      loadState: (user) => loadProvisioningState(user, admin),
      loadAds: () => loadProvisioningContext(admin),
      store: supabaseProvisionStore(admin),
      unlinkAfterAccept: unlinkAfterAcceptEnabled(),
    })
  );
}
