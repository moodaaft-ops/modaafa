import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { normalizeCustomerId, SELECTED_ADS_ACCOUNT_COOKIE, getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import { decrypt } from '@/lib/crypto';
import {
  discoverAccessibleCustomers,
  getGoogleAdsErrorCodes,
  getCustomerMetadataWithFallback,
} from '@/lib/google-ads/client';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import {
  consumeFeatureUsage,
  featureAccessMessage,
  featureAccessStatus,
  refundFeatureUsage,
} from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { safeLocalPath } from '@/lib/security/redirect';
import { isSameOriginRequest } from '@/lib/security/origin';

export const maxDuration = 300;

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/dashboard?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const isForm = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded');
  const payload = isForm ? Object.fromEntries((await req.formData()).entries()) : await safeJson(req);
  const next = safeNextPath(String(payload.next ?? '/dashboard'));

  // Rate-limit errors are surfaced through `respond` so a native form POST
  // gets a redirect with an Arabic message instead of a bare JSON page.
  try {
    const rateLimit = await checkRateLimit({ req, scope: 'account_sync', limit: 10, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return respond(req, isForm, next, { error: 'too_many_requests' }, 429, rateLimitHeaders(rateLimit));
    }
  } catch {
    return respond(req, isForm, next, { error: 'security_service_unavailable' }, 503);
  }

  const customerId =
    normalizeCustomerId(String(payload.customerId ?? payload.customer_id ?? '')) ||
    normalizeCustomerId(req.cookies.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? '');

  // Neither the request nor the cookie named an account. Falling through used
  // to sync an arbitrary row (the first non-manager account), spending a paid
  // quota unit on an account the user never chose.
  if (!customerId) {
    return respond(req, isForm, next, { error: 'customer_required' }, 400);
  }

  const { account, error } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id, customer_name, manager_id, currency_code, time_zone, refresh_token_encrypted',
  });

  if (error || !account) {
    return respond(req, isForm, next, { error: 'account_not_found' }, 404);
  }

  const usage = await consumeFeatureUsage({
    supabase,
    userId: user.id,
    feature: 'manual_sync',
    accountId: account.id,
    metadata: { customer_id: account.customer_id },
  });
  if (!usage.ok) {
    return respond(
      req,
      isForm,
      next,
      {
        error: usage.reason,
        message: featureAccessMessage(usage.reason),
        resets_at: usage.resetsAt,
      },
      featureAccessStatus(usage.reason)
    );
  }

  try {
    const refreshToken = decrypt(account.refresh_token_encrypted);
    const normalizedCustomerId = normalizeCustomerId(account.customer_id);
    let resolvedManagerId = account.manager_id ?? null;
    let resolvedName = account.customer_name ?? null;
    let resolvedCurrencyCode: string | null = account.currency_code ?? null;
    let resolvedTimeZone: string | null = account.time_zone ?? null;

    try {
      const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
        refreshToken,
        normalizedCustomerId,
        resolvedManagerId ? [resolvedManagerId] : []
      );
      resolvedName = metadata.customer_name ?? resolvedName;
      resolvedCurrencyCode = metadata.currency_code;
      resolvedTimeZone = metadata.time_zone;
      resolvedManagerId =
        resolvedManagerId ??
        (loginCustomerId && loginCustomerId !== normalizedCustomerId ? loginCustomerId : null);
    } catch (err) {
      console.warn(`Failed to refresh Google Ads account metadata for ${account.customer_id}`, err);
    }

    if (!resolvedName || !resolvedManagerId) {
      try {
        const discovered = (await discoverAccessibleCustomers(refreshToken)).find(
          (item) => normalizeCustomerId(item.customer_id) === normalizedCustomerId
        );
        if (discovered) {
          resolvedName = discovered.customer_name ?? resolvedName;
          resolvedManagerId = discovered.manager_id ?? resolvedManagerId;
          resolvedCurrencyCode = discovered.currency_code ?? resolvedCurrencyCode;
          resolvedTimeZone = discovered.time_zone ?? resolvedTimeZone;
        }
      } catch (err) {
        console.warn(`Failed to discover Google Ads account metadata for ${account.customer_id}`, err);
      }
    }

    const syncResult = await syncCampaignCacheWithLoginFallback({
      supabase,
      customerId: account.customer_id,
      refreshToken,
      accountId: account.id,
      currencyCode: resolvedCurrencyCode,
      loginCustomerIds: [resolvedManagerId],
    });
    if (syncResult.loginCustomerId) {
      resolvedManagerId = syncResult.loginCustomerId;
    }
    const syncedAt = new Date().toISOString();
    const update: Record<string, unknown> = { last_synced_at: syncedAt };
    if (resolvedName) update.customer_name = resolvedName;
    if (resolvedManagerId) update.manager_id = resolvedManagerId;
    if (resolvedCurrencyCode) update.currency_code = resolvedCurrencyCode;
    if (resolvedTimeZone) update.time_zone = resolvedTimeZone;

    await supabase
      .from('google_ads_accounts')
      .update(update)
      .eq('id', account.id);

    const res = respond(req, isForm, next, {
      ok: true,
      customerId: normalizeCustomerId(account.customer_id),
      syncedAt,
      updated: syncResult.updated,
      active: syncResult.active,
      usage: { remaining: usage.remaining, resets_at: usage.resetsAt },
    });

    res.cookies.set(SELECTED_ADS_ACCOUNT_COOKIE, normalizeCustomerId(account.customer_id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });

    return res;
  } catch (err) {
    await refundFeatureUsage({ userId: user.id, usageEventId: usage.usageEventId });
    console.error('Manual Google Ads sync failed', err);
    const codes = getGoogleAdsErrorCodes(err);
    return respond(
      req,
      isForm,
      next,
      {
        error: 'sync_failed',
        code: codes[0] ?? null,
        codes,
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
}

async function safeJson(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function respond(
  req: NextRequest,
  isForm: boolean | undefined,
  next: string,
  body: Record<string, unknown>,
  status = 200,
  headers?: Record<string, string>
) {
  if (!isForm) {
    return NextResponse.json(body, { status, headers });
  }

  const url = new URL(next, req.url);
  if (status >= 400) {
    // Forward the specific Google Ads error code, not just "sync_failed".
    // The dashboard's "تحديث البيانات" button is a native form, so it took
    // this branch and always showed the generic "تعذر تحديث بيانات الحساب"
    // message — even for INVALID_GRANT, where the only useful answer is
    // "reconnect your Google Ads account".
    const code = String(
      (Array.isArray(body.codes) ? body.codes[0] : null) ?? body.code ?? body.error ?? 'sync_failed'
    );
    url.searchParams.set('sync_error', code.toLowerCase());
  } else {
    url.searchParams.set('synced', '1');
  }
  return NextResponse.redirect(url, 303);
}

function safeNextPath(value: string) {
  return safeLocalPath(value, '/dashboard');
}
