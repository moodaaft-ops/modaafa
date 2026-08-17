import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import { runRuleBasedAudit } from '@/lib/audit/rule-engine';
import { buildAuditReportRow } from '@/lib/audit/report';
import { getSectorBenchmark } from '@/lib/benchmarks/compute';
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

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const usage = await consumeFeatureUsage({
    supabase,
    userId: user.id,
    userEmail: user.email,
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
  let conversionTracking: { enabled_actions: number } | null = null;

  try {
    let refreshTokenForChecks: string | null = null;
    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      refreshTokenForChecks = refreshToken;
      const syncResult = await syncCampaignCacheWithLoginFallback({
        supabase: admin,
        customerId: account.customer_id,
        refreshToken,
        accountId: account.id,
        currencyCode: account.currency_code,
        loginCustomerIds: [account.manager_id],
      });
      await admin
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

    // Conversion tracking is the single most important thing to verify: with
    // broken tracking every downstream number lies. Best-effort — a failed
    // lookup degrades to "unknown" rather than failing the audit.
    if (refreshTokenForChecks) {
      try {
        const customer = getCustomer(
          account.customer_id,
          refreshTokenForChecks,
          account.manager_id ?? undefined
        ) as any;
        const conversionActions = await customer.query(`
          SELECT conversion_action.resource_name, conversion_action.status
          FROM conversion_action
          WHERE conversion_action.status = 'ENABLED'
          LIMIT 50
        `);
        conversionTracking = { enabled_actions: conversionActions.length };
      } catch (trackingError) {
        console.warn('Conversion tracking check failed during audit', trackingError);
      }
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

    // Sector benchmark: anonymous medians from >= 3 businesses in the same
    // sector/currency, if the platform has enough of them yet. Best-effort.
    let sectorBenchmark = null;
    try {
      const { data: businessRow } = await supabase
        .from('businesses')
        .select('sector')
        .eq('user_id', user.id)
        .maybeSingle();
      sectorBenchmark = await getSectorBenchmark(supabase, businessRow?.sector, account.currency_code);
    } catch (benchmarkError) {
      console.warn('Sector benchmark lookup failed during audit', benchmarkError);
    }

    const result = runRuleBasedAudit({
      account: {
        customer_id: account.customer_id,
        customer_name: account.customer_name,
        currency_code: account.currency_code,
      },
      campaigns: campaigns ?? [],
      conversionTracking,
      benchmark: sectorBenchmark,
    });

    const duration = Date.now() - startTime;

    const { data: audit, error: auditErr } = await admin
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
          sector_benchmark: sectorBenchmark,
        },
        estimated_monthly_waste: result.estimated_monthly_waste_sar,
        duration_ms: duration,
      })
      .select('id')
      .single();

    if (auditErr) throw auditErr;

    // Supersede the PRIOR audit's still-open findings before inserting this
    // run's. Without this, running the audit twice (6/hour allowed) left the
    // approval centre full of duplicate findings from every past run, burying
    // the live optimizer recommendations on the exact screen that trains the
    // user to click اعتماد. Only pending rows sourced from an audit are
    // touched — approved/executing/applied history and optimizer_cron
    // recommendations are left alone.
    const { error: supersedeErr } = await admin
      .from('recommendations')
      .update({ status: 'dismissed' })
      .eq('account_id', account.id)
      .eq('status', 'pending')
      .not('audit_id', 'is', null)
      .neq('audit_id', audit.id);
    if (supersedeErr) throw supersedeErr;

    const recRows = result.findings.map((f) => ({
      audit_id: audit.id,
      account_id: account.id,
      category: f.category,
      severity: f.severity,
      title: f.title_ar,
      description: f.description_ar,
      expected_impact: f.expected_impact,
      action_payload: f.action_payload,
      // Stable identity per (account, operation, target) so a re-run of the
      // same finding collides on the partial unique index instead of stacking.
      fingerprint: auditFindingFingerprint(account.id, f.action_payload),
      status: 'pending',
    }));

    // Insert one at a time tolerating 23505: a finding that already exists as
    // an ACTIVE recommendation (e.g. still-pending from a run milliseconds
    // earlier, or an approved one) must not abort the whole batch.
    for (const row of recRows) {
      const { error: recErr } = await admin.from('recommendations').insert(row);
      if (recErr && (recErr as { code?: string }).code !== '23505') throw recErr;
    }

    const { error: reportErr } = await admin.from('reports').insert(buildAuditReportRow({
      accountId: account.id,
      auditId: audit.id,
      summaryAr: result.summary_ar,
      summaryEn: result.summary_en,
      healthScore: result.health_score,
      recommendationsCount: result.findings.length,
      estimatedMonthlyWasteSar: result.estimated_monthly_waste_sar,
      currencyCode: account.currency_code ?? 'SAR',
    }));
    if (reportErr) throw reportErr;

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
    await refundFeatureUsage({ userId: user.id, usageEventId: usage.usageEventId });
    console.error('Audit failed', err);
    if (isForm) {
      return NextResponse.redirect(new URL('/audit?error=audit_failed', req.url), 303);
    }
    // Return a stable code only. Raw `err.message` can surface PostgREST
    // table/column names to the client; keep it in the server log above.
    return NextResponse.json({ error: 'audit_failed' }, { status: 500 });
  }
}

async function safeJson(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * Stable identity of an audit finding: the operation plus its target, not the
 * generated Arabic wording. Two audit runs that surface the same underlying
 * issue produce the same fingerprint and collide on the partial unique index
 * instead of stacking duplicates in the approval centre.
 */
function auditFindingFingerprint(accountId: string, actionPayload: any) {
  const operation = String(actionPayload?.operation ?? 'unknown');
  const details = actionPayload?.details ?? {};
  const target =
    details.campaign_id ??
    details.budget_resource ??
    details.resource_name ??
    details.customer_id ??
    JSON.stringify(details);
  return createHash('sha256')
    .update(`audit:${accountId}:${operation}:${String(target)}`)
    .digest('hex');
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
