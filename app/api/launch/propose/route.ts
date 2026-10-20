import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { googleAdsRest } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import { getLinkedGoogleAdsAccount, normalizeCustomerId } from '@/lib/accounts/selection';
import { loadBuilderSignals } from '@/lib/ai/builder-signals';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { campaignLaunchEnabled, campaignLaunchPmaxEnabled } from '@/lib/launch/flag';
import { getCustomer } from '@/lib/google-ads/client';
import { readOfflineUploadInPlace, readPmaxInventory } from '@/lib/launch/pmax-inventory';
import { proposeLaunch } from '@/lib/launch/propose';

/**
 * POST /api/launch/propose
 * Body: { sessionId: string, customerId: string }
 *
 * Turns the builder draft saved on the chat session into a launch plan and, when
 * the plan can be built, a pending «ابنِ الحملة موقوفة» card. Nothing touches
 * Google Ads here except a read-only region lookup. Off unless CAMPAIGN_LAUNCH_ENABLED.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!campaignLaunchEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const limit = await checkRateLimit({ req, scope: 'launch_propose', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const customerId = normalizeCustomerId(String(body?.customerId ?? ''));
  const sessionId = String(body?.sessionId ?? '');
  if (!customerId || !sessionId) return NextResponse.json({ error: 'session and customerId required' }, { status: 400 });

  const { account } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id, currency_code, refresh_token_encrypted, manager_id, businesses(name, sector, website, phone, monthly_budget)',
  });
  if (!account) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });

  const { data: session } = await supabase
    .from('chat_sessions')
    .select('id, title, draft_campaign')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .eq('account_id', account.id)
    .maybeSingle();
  if (!session?.draft_campaign) return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });

  try {
    const admin = createAdminClient();
    const refreshToken = decrypt(account.refresh_token_encrypted);
    const business = (account as any).businesses ?? {};
    const signals = await loadBuilderSignals({ supabase, admin, accountId: account.id });
    // Performance Max only: what the account already holds. Off, nothing extra is read.
    let pmaxInventory = null;
    let builderSignals = signals;
    const draftType = String((session.draft_campaign as any)?.type ?? '').toUpperCase();
    if (campaignLaunchPmaxEnabled() && (draftType === 'PMAX' || draftType === 'PERFORMANCE_MAX' || draftType === '')) {
      try {
        const customer = getCustomer(account.customer_id as string, refreshToken, account.manager_id ?? undefined);
        pmaxInventory = await readPmaxInventory(customer as any);
        builderSignals = { ...signals, offline_upload_in_place: await readOfflineUploadInPlace(customer as any) };
      } catch {
        pmaxInventory = null;
      }
    }
    const { plan, cardId } = await proposeLaunch({
      admin,
      accountId: account.id,
      draft: session.draft_campaign,
      context: {
        brief: String(session.title ?? ''),
        businessName: business.name ?? null,
        sector: business.sector ?? null,
        website: business.website ?? null,
        phone: business.phone ?? null,
        monthlyBudgetSar: Number.isFinite(Number(business.monthly_budget)) ? Number(business.monthly_budget) : null,
        currency: (account as any).currency_code ?? null,
        signals: builderSignals,
        pmaxInventory,
        pmaxEnabled: campaignLaunchPmaxEnabled(),
      },
      suggest: (suggestBody) =>
        googleAdsRest({
          refreshToken,
          path: '/geoTargetConstants:suggest',
          method: 'POST',
          body: suggestBody,
          loginCustomerId: account.manager_id ?? null,
          maxAttempts: 1,
        }),
    });
    return NextResponse.json({ plan, card_id: cardId });
  } catch (error) {
    console.error('Launch proposal failed', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'launch_proposal_failed' }, { status: 500 });
  }
}
