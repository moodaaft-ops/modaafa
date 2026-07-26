import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { getCustomerMetadataWithFallback } from '@/lib/google-ads/client';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import {
  normalizeCustomerId,
  pickPreferredGoogleAdsAccount,
  SELECTED_ADS_ACCOUNT_COOKIE,
} from '@/lib/accounts/selection';
import { isGeneratedFallbackName } from '@/lib/accounts/display';
import {
  clearPendingSessionCookies,
  readPendingSessionCookie,
} from '@/lib/auth/google-ads-pending-cookie';
import { checkRateLimit } from '@/lib/security/rate-limit';

// This route can sync several accounts inline; it previously ran on the
// platform default while every comparable route had 300s.
export const maxDuration = 300;

type PendingCustomer = {
  customer_id: string;
  customer_name?: string | null;
  manager_id?: string | null;
  is_manager?: boolean;
  status?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
};

type PendingSession = {
  id: string;
  user_id: string;
  refresh_token_encrypted: string;
  accessible_customers: PendingCustomer[];
  expires_at: string;
};

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({
      req,
      scope: 'google_ads_account_link',
      limit: 5,
      windowSeconds: 900,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      return NextResponse.redirect(new URL('/onboarding/connect?error=too_many_requests', req.url), 303);
    }
  } catch {
    return NextResponse.redirect(new URL('/onboarding/connect?error=security_service_unavailable', req.url), 303);
  }

  const form = await req.formData();
  const sessionId = String(form.get('session_id') ?? '');
  const selectedIds = form
    .getAll('customer_id')
    .map((value) => normalizeCustomerId(String(value)))
    .filter(Boolean);

  if (!sessionId || selectedIds.length === 0) {
    return NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}&error=select_required`, req.url),
      303
    );
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!business) {
    return NextResponse.redirect(new URL('/onboarding/business?error=no_business', req.url), 303);
  }

  const pendingCookie = readPendingSessionCookie((name) => req.cookies.get(name)?.value);
  const pending =
    (await loadPendingSession(supabase, user.id, sessionId)) ?? parsePendingSession(pendingCookie);

  if (
    !pending ||
    pending.id !== sessionId ||
    pending.user_id !== user.id ||
    new Date(pending.expires_at).getTime() < Date.now()
  ) {
    await deletePendingSession(supabase, user.id, sessionId);
    const res = NextResponse.redirect(new URL('/onboarding/connect?error=session_expired', req.url), 303);
    clearPendingSessionCookies(res);
    return res;
  }

  const customers = (pending.accessible_customers ?? []) as PendingCustomer[];
  const byId = new Map(customers.map((customer) => [normalizeCustomerId(customer.customer_id), customer]));
  const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean) as PendingCustomer[];
  const linkable = selected.filter((customer) => !customer.is_manager);

  if (linkable.length === 0) {
    return NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}&error=manager_only`, req.url),
      303
    );
  }

  const refreshToken = decrypt(pending.refresh_token_encrypted);
  const existingMetadata = await loadExistingAccountMetadata(supabase, business.id);
  const managerCandidates = customers
    .flatMap((customer) => [customer.manager_id, customer.is_manager ? customer.customer_id : null])
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\D/g, ''))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const enrichedLinkable = await Promise.all(
    linkable.map(async (customer) => {
      if (customer.customer_name && customer.currency_code && customer.time_zone) return customer;
      try {
        const normalizedCustomerId = normalizeCustomerId(customer.customer_id);
        const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
          refreshToken,
          normalizedCustomerId,
          [customer.manager_id, ...managerCandidates].filter((value): value is string => Boolean(value))
        );
        return {
          ...customer,
          customer_name: customer.customer_name ?? metadata.customer_name,
          manager_id:
            customer.manager_id ??
            (loginCustomerId && loginCustomerId !== normalizedCustomerId ? loginCustomerId : null),
          currency_code: customer.currency_code ?? metadata.currency_code,
          time_zone: customer.time_zone ?? metadata.time_zone,
          is_manager: customer.is_manager ?? metadata.is_manager,
        };
      } catch (err) {
        console.warn(`Failed to refresh Google Ads account metadata for ${customer.customer_id}`, err);
        return customer;
      }
    })
  );

  const rows = enrichedLinkable.map((customer) => ({
    business_id: business.id,
    customer_id: normalizeCustomerId(customer.customer_id),
    customer_name:
      customer.customer_name ??
      validExistingName(existingMetadata.get(normalizeCustomerId(customer.customer_id))?.customer_name) ??
      null,
    manager_id:
      customer.manager_id ??
      existingMetadata.get(normalizeCustomerId(customer.customer_id))?.manager_id ??
      null,
    refresh_token_encrypted: pending.refresh_token_encrypted,
    permissions_scope: ['adwords'],
    status: 'active',
    currency_code:
      customer.currency_code ??
      existingMetadata.get(normalizeCustomerId(customer.customer_id))?.currency_code ??
      null,
    time_zone:
      customer.time_zone ??
      existingMetadata.get(normalizeCustomerId(customer.customer_id))?.time_zone ??
      null,
    last_synced_at: new Date().toISOString(),
  }));

  const { data: savedAccounts, error } = await supabase
    .from('google_ads_accounts')
    .upsert(rows, {
      onConflict: 'business_id,customer_id',
    })
    .select('id, customer_id, customer_name, manager_id, currency_code, refresh_token_encrypted');

  if (error) {
    console.error('Failed to link Google Ads accounts', error);
    return NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}&error=db_error`, req.url),
      303
    );
  }

  const preferredAccount = pickPreferredGoogleAdsAccount(savedAccounts, enrichedLinkable);

  for (const account of savedAccounts ?? []) {
    try {
      const accountRefreshToken = decrypt(account.refresh_token_encrypted);
      const syncResult = await syncCampaignCacheWithLoginFallback({
        supabase,
        customerId: account.customer_id,
        refreshToken: accountRefreshToken,
        accountId: account.id,
        currencyCode: account.currency_code,
        loginCustomerIds: [account.manager_id],
      });
      if (syncResult.loginCustomerId) {
        await supabase
          .from('google_ads_accounts')
          .update({ manager_id: syncResult.loginCustomerId })
          .eq('id', account.id);
      }
    } catch (err) {
      console.warn(`Initial campaign sync failed for ${account.customer_id}`, err);
    }
  }

  const res = NextResponse.redirect(new URL('/dashboard?connected=1', req.url), 303);
  if (preferredAccount?.customer_id) {
    res.cookies.set(SELECTED_ADS_ACCOUNT_COOKIE, normalizeCustomerId(preferredAccount.customer_id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
  }
  await deletePendingSession(supabase, user.id, sessionId);
  clearPendingSessionCookies(res);
  return res;
}

function parsePendingSession(value?: string): PendingSession | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function loadPendingSession(
  supabase: any,
  userId: string,
  sessionId: string
): Promise<PendingSession | null> {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from('pending_oauth_sessions')
    .select('id, user_id, refresh_token_encrypted, accessible_customers, expires_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('Failed to load pending Google Ads OAuth session', error);
    return null;
  }

  return (data as PendingSession | null) ?? null;
}

async function deletePendingSession(supabase: any, userId: string, sessionId: string) {
  if (!sessionId) return;
  const { error } = await supabase
    .from('pending_oauth_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', userId);
  if (error) console.warn('Failed to delete pending Google Ads OAuth session', error);
}

async function loadExistingAccountMetadata(supabase: any, businessId: string) {
  const { data, error } = await supabase
    .from('google_ads_accounts')
    .select('customer_id, customer_name, manager_id, currency_code, time_zone')
    .eq('business_id', businessId);

  if (error) {
    console.warn('Failed to load existing Google Ads account metadata before select-account upsert', error);
    return new Map<string, any>();
  }

  return new Map(
    (data ?? []).map((account: any) => [
      normalizeCustomerId(account.customer_id),
      {
        customer_name: account.customer_name ?? null,
        manager_id: account.manager_id ?? null,
        currency_code: account.currency_code ?? null,
        time_zone: account.time_zone ?? null,
      },
    ])
  );
}

function validExistingName(name?: string | null) {
  const trimmed = name?.trim();
  return trimmed && !isGeneratedFallbackName(trimmed) ? trimmed : null;
}
