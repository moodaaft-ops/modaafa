import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import { runRuleBasedAudit } from '@/lib/audit/rule-engine';
import {
  getLinkedGoogleAdsAccount,
  normalizeCustomerId,
  SELECTED_ADS_ACCOUNT_COOKIE,
} from '@/lib/accounts/selection';
import {
  consumeFeatureUsage,
  featureAccessMessage,
  featureAccessStatus,
  refundFeatureUsage,
} from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';

/**
 * POST /api/audit/run
 * Body: { customerId: string }
 *
 * Runs a full audit on the given Google Ads customer:
 * 1. Refresh campaign cache when Google Ads credentials are available
 * 2. Run a deterministic audit over the cached account data
 * 3. Persist the audit, recommendations, and a lightweight report row
 */
export const maxDuration = 300;

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/audit?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'audit', limit: 6, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const isForm = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded');
  const payload = isForm ? Object.fromEntries((await req.formData()).entries()) : await safeJson(req);
  const requestedCustomerId = normalizeCustomerId(String(payload.customerId ?? payload.customer_id ?? ''));
  const selectedCustomerId = normalizeCustomerId(req.cookies.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? '');
  const customerId = requestedCustomerId || selectedCustomerId;

  const { account, error: accountErr } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id, customer_name, currency_code, refresh_token_encrypted, manager_id',
  });

  if (accountErr || !account) {
    if (isForm) {
      return NextResponse.redirect(new URL('/audit?error=account_not_found', req.url), 303);
    }
    return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  }

  const usage = await consumeFeatureUsage({
    supabase,
    userId: user.id,
    feature: 'audit',
    accountId: account.id,
    metadata: { customer_id: account.customer_id },
  });
  if (!usage.ok) {
    if (isForm) {
      return NextResponse.redirect(new URL(`/audit?error=${usage.reason}`, req.url), 303);
    }
    return NextResponse.json(
      { error: usage.reason, message: featureAccessMessage(usage.reason), resets_at: usage.resetsAt },
      { status: featureAccessStatus(usage.reason) }
    );
  }

  const startTime = Date.now();
  let syncError: string | null = null;

  try {
    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const syncResult = await syncCampaignCacheWithLoginFallback({
        supabase,
        customerId: account.customer_id,
        refreshToken,
        accountId: account.id,
        currencyCode: account.currency_code,
        loginCustomerIds: [account.manager_id],
      });
      await supabase
        .from('google_ads_accounts')
        .update({
          last_synced_at: new Date().toISOString(),
          ...(syncResult.loginCustomerId
            ? { manager_id: syncResult.loginCustomerId }
            : {}),
        })
        .eq('id', account.id);
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      console.warn('Campaign sync failed, continuing with cached data', syncError);
    }

    const { data: campaigns, error: campaignErr } = await supabase
      .from('campaigns_cache')
      .select('*')
      .eq('account_id', account.id)
      .order('last_synced_at', { ascending: false })
      // Bounded: PostgREST otherwise truncates at its 1000-row default with no
      // signal, and the whole set is held in memory for the rule engine.
      .limit(1000);
    if (campaignErr) throw campaignErr;

    const result = runRuleBasedAudit({
      account: {
        customer_id: account.customer_id,
        customer_name: account.customer_name,
        currency_code: account.currency_code,
      },
      campaigns: campaigns ?? [],
    });

    const duration = Date.now() - startTime;

    const { data: audit, error: auditErr } = await supabase
      .from('audits')
      .insert({
        account_id: account.id,
        health_score: result.health_score,
        category_scores: result.category_scores,
        findings: result.findings,
        metrics_snapshot: {
          customer_id: account.customer_id,
          customer_name: account.customer_name,
          currency_code: account.currency_code,
          campaigns_count: campaigns?.length ?? 0,
          sync_error: syncError,
        },
        estimated_monthly_waste: result.estimated_monthly_waste_sar,
        duration_ms: duration,
      })
      .select('id')
      .single();

    if (auditErr) throw auditErr;

    const recRows = result.findings.map((f) => ({
      audit_id: audit.id,
      account_id: account.id,
      category: f.category,
      severity: f.severity,
      title: f.title_ar,
      description: f.description_ar,
      expected_impact: f.expected_impact,
      action_payload: f.action_payload,
      status: 'pending',
    }));

    const { error: recErr } = await supabase.from('recommendations').insert(recRows);
    if (recErr) console.error('Failed to insert recommendations', recErr);

    await supabase.from('reports').insert({
      account_id: account.id,
      period_type: 'weekly',
      period_start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      period_end: new Date().toISOString().slice(0, 10),
      summary_ar: result.summary_ar,
      summary_en: result.summary_en,
      metrics: {
        health_score: result.health_score,
        recommendations_count: result.findings.length,
        estimated_monthly_waste_sar: result.estimated_monthly_waste_sar,
        currency_code: account.currency_code ?? 'SAR',
      },
    });

    if (isForm) {
      return withSelectedAccountCookie(
        NextResponse.redirect(new URL(`/audit?ran=1&audit=${audit.id}`, req.url), 303),
        account.customer_id
      );
    }

    return withSelectedAccountCookie(NextResponse.json({
      success: true,
      audit_id: audit.id,
      health_score: result.health_score,
      findings_count: result.findings.length,
      duration_ms: duration,
      sync_error: syncError,
      usage: { remaining: usage.remaining, resets_at: usage.resetsAt },
    }), account.customer_id);
  } catch (err) {
    await refundFeatureUsage({ supabase, userId: user.id, usageEventId: usage.usageEventId });
    console.error('Audit failed', err);
    if (isForm) {
      return NextResponse.redirect(new URL('/audit?error=audit_failed', req.url), 303);
    }
    return NextResponse.json(
      { error: 'audit_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
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

function withSelectedAccountCookie(res: NextResponse, customerId: string) {
  res.cookies.set(SELECTED_ADS_ACCOUNT_COOKIE, normalizeCustomerId(customerId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  });
  return res;
}
