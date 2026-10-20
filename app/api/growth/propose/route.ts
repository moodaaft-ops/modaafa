import { prepareCustomerMatchMembers } from '@/lib/audiences/customer-match';
import { validateMatchUpload } from '@/lib/audiences/match-action';
import { createGrowthCard, growthCardRow } from '@/lib/growth/card';
import { cachedRegionConstants } from '@/lib/launch/geo-cache';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getCustomer, googleAdsRest } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import { getLinkedGoogleAdsAccount, normalizeCustomerId } from '@/lib/accounts/selection';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { growthOperationEnabled } from '@/lib/growth/flags';
import {
  proposeDemandGen,
  proposeEndExperiment,
  proposeExperiment,
  proposeImageAssets,
  proposePromoteExperiment,
  proposeUserList,
} from '@/lib/growth/propose';
import { systemResolver, pinnedHttpsTransport } from '@/lib/landing-check/transport';

/**
 * POST /api/growth/propose
 * Body: { kind, customerId, ... }. kind is one of
 *   demand_gen | user_list | experiment | end_experiment | promote_experiment | image_assets
 *
 * Builds the plan on the server and creates a pending approval card. Nothing changes in Google Ads here.
 * Each kind is off (404) unless its flag is exactly "true".
 */
export const maxDuration = 60;

const OPERATION_BY_KIND: Record<string, string> = {
  demand_gen: 'launch_demand_gen',
  user_list: 'create_user_list',
  customer_match: 'upload_customer_match',
  experiment: 'create_experiment',
  end_experiment: 'end_experiment',
  promote_experiment: 'promote_experiment',
  image_assets: 'create_image_assets',
};

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const kind = String(body?.kind ?? '');
  const operation = OPERATION_BY_KIND[kind];
  if (!operation || !growthOperationEnabled(operation)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const limit = await checkRateLimit({ req, scope: 'growth_propose', limit: 20, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const customerId = normalizeCustomerId(String(body?.customerId ?? ''));
  if (!customerId) return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  const { account } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id, currency_code, refresh_token_encrypted, manager_id, businesses(name, sector, website)',
  });
  if (!account) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });

  try {
    const admin = createAdminClient();
    const customer = getCustomer(account.customer_id, decrypt(account.refresh_token_encrypted), account.manager_id ?? undefined) as any;
    const business = (account as any).businesses ?? {};
    const base = { admin, accountId: account.id };

    switch (kind) {
      case 'customer_match': {
        if (!Array.isArray(body.rows) || body.rows.length > 100000) return NextResponse.json({ error: 'invalid_rows' }, { status: 400 });
        const prepared = prepareCustomerMatchMembers(body.rows);
        const checked = validateMatchUpload({ user_list_resource: body.user_list_resource, members: prepared.members, consent_confirmed: body.consent_confirmed, terms_confirmed: body.terms_confirmed }, customerId);
        if (!checked) return NextResponse.json({ error: 'invalid_match_upload' }, { status: 400 });
        const card = await createGrowthCard(admin, growthCardRow(account.id, 'upload_customer_match', checked, `نرفع ${prepared.usable} عميل لقائمتك، بصمات البريد والجوال فقط، بعد موافقتك`, 'audience'));
        return NextResponse.json({ card_id: card.id });
      }
      case 'demand_gen': {
        const names = Array.isArray(body?.input?.target_regions)
          ? body.input.target_regions.filter((n: unknown): n is string => typeof n === 'string' && n.length <= 100) : [];
        const resolvedRegions = await cachedRegionConstants(names, (request) => googleAdsRest({
          refreshToken: decrypt(account.refresh_token_encrypted), path: '/geoTargetConstants:suggest',
          method: 'POST', body: request, loginCustomerId: account.manager_id ?? null, maxAttempts: 1,
        })).catch(() => ({}));
        const result = await proposeDemandGen({
          ...base,
          customer,
          input: body?.input ?? {},
          context: { website: business.website ?? null, businessName: business.name ?? null, resolvedRegions },
        });
        return NextResponse.json({ plan: result.plan, card_id: result.cardId });
      }
      case 'user_list':
        return NextResponse.json(await proposeUserList({ ...base, params: body?.params }));
      case 'experiment':
        return NextResponse.json(await proposeExperiment({ ...base, customer, input: body?.input ?? {} }));
      case 'end_experiment':
        return NextResponse.json(
          await proposeEndExperiment({ ...base, customerId: account.customer_id, experiment_resource: String(body?.experiment_resource ?? '') })
        );
      case 'promote_experiment':
        return NextResponse.json(
          await proposePromoteExperiment({
            ...base,
            customer,
            customerId: account.customer_id,
            experiment_resource: String(body?.experiment_resource ?? ''),
            metric: body?.metric,
          })
        );
      case 'image_assets':
        return NextResponse.json(
          await proposeImageAssets({
            ...base,
            website: business.website ?? null,
            pageUrl: typeof body?.pageUrl === 'string' ? body.pageUrl : null,
            deps: { resolve: systemResolver, transport: pinnedHttpsTransport },
          })
        );
    }
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  } catch (error) {
    console.error('Growth proposal failed', kind, error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'growth_proposal_failed' }, { status: 500 });
  }
}
