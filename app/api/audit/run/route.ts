import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import { runRuleBasedAudit } from '@/lib/audit/rule-engine';
import { collectAuditLiveSnapshot, type AuditLiveSnapshot } from '@/lib/audit/live-snapshot';
import { generateAuditNarrative } from '@/lib/audit/ai-analyst';
import { auditFindingTargetKey } from '@/lib/audit/fingerprint';
import { buildAuditReportRow } from '@/lib/audit/report';
import { AUDIT_ENGINE_VERSION } from '@/lib/audit/version';
import {
  auditProgressEvent,
  type AuditProgressEvent,
  type AuditStreamEvent,
} from '@/lib/audit/progress';
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

  const execute = (onProgress: AuditProgressReporter = () => undefined) => executeAudit({
    supabase,
    admin,
    userId: user.id,
    account,
    onProgress,
  });

  if (req.headers.get('accept')?.includes('application/x-ndjson')) {
    return withSelectedAccountCookie(createAuditProgressResponse({
      execute,
      onFailure: async (err) => {
        await refundFeatureUsage({ userId: user.id, usageEventId: usage.usageEventId });
        console.error('Audit failed', err);
      },
    }), account.customer_id);
  }

  try {
    const outcome = await execute();
    if (isForm) {
      return withSelectedAccountCookie(
        NextResponse.redirect(new URL(`/audit?ran=1&audit=${outcome.auditId}`, req.url), 303),
        account.customer_id
      );
    }

    return withSelectedAccountCookie(NextResponse.json({
      success: true,
      audit_id: outcome.auditId,
      health_score: outcome.healthScore,
      findings_count: outcome.findingsCount,
      duration_ms: outcome.durationMs,
      sync_error: outcome.syncError,
      usage: { remaining: usage.remaining, resets_at: usage.resetsAt },
    }), account.customer_id);
  } catch (err) {
    await refundFeatureUsage({ userId: user.id, usageEventId: usage.usageEventId });
    console.error('Audit failed', err);
    if (isForm) {
      return NextResponse.redirect(new URL('/audit?error=audit_failed', req.url), 303);
    }
    return NextResponse.json({ error: 'audit_failed' }, { status: 500 });
  }
}

type AuditProgressReporter = (event: AuditProgressEvent) => void;

type AuditExecutionAccount = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  currency_code: string | null;
  refresh_token_encrypted: string;
  manager_id: string | null;
};

type AuditExecutionOutcome = {
  auditId: string;
  healthScore: number;
  findingsCount: number;
  durationMs: number;
  syncError: string | null;
};

async function executeAudit({
  supabase,
  admin,
  userId,
  account,
  onProgress,
}: {
  supabase: Awaited<ReturnType<typeof createServerClient>>;
  admin: ReturnType<typeof createAdminClient>;
  userId: string;
  account: AuditExecutionAccount;
  onProgress: AuditProgressReporter;
}): Promise<AuditExecutionOutcome> {
  const startTime = Date.now();
  let syncError: string | null = null;
  let liveSnapshot: AuditLiveSnapshot | null = null;

  onProgress(auditProgressEvent('prepare', 'started'));
  onProgress(auditProgressEvent('prepare', 'completed', {
    detail: `الحساب ${account.customer_name || account.customer_id} جاهز للفحص`,
  }));

  let refreshTokenForChecks: string | null = null;
  onProgress(auditProgressEvent('sync', 'started'));
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
        ...(syncResult.loginCustomerId ? { manager_id: syncResult.loginCustomerId } : {}),
      })
      .eq('id', account.id);
    onProgress(auditProgressEvent('sync', 'completed', {
      detail: 'وصلت أحدث بيانات الحملات من Google Ads',
    }));
  } catch (err) {
    syncError = err instanceof Error ? err.message : String(err);
    console.warn('Campaign sync failed, continuing with cached data', syncError);
    onProgress(auditProgressEvent('sync', 'completed', {
      detail: 'تعذر التحديث المباشر؛ سنكمل بأحدث بيانات محفوظة دون إصدار حكم أخضر وهمي',
      warning: true,
    }));
  }

  onProgress(auditProgressEvent('live_data', 'started'));
  if (refreshTokenForChecks) {
    const customer = getCustomer(
      account.customer_id,
      refreshTokenForChecks,
      account.manager_id ?? undefined
    ) as any;
    liveSnapshot = await collectAuditLiveSnapshot(customer);
  }
  onProgress(auditProgressEvent('live_data', 'completed', liveSnapshot
    ? {
        detail: `تغطية الأدلة ${liveSnapshot.coverage.coverage_pct}%: ${liveSnapshot.keywords.length} كلمة، ${liveSnapshot.search_terms.length} عبارة بحث، ${liveSnapshot.ads.length} إعلان`,
        warning: liveSnapshot.coverage.coverage_pct < 100,
      }
    : {
        detail: 'لم تتوفر جلسة Google للفحوص الحية؛ سيظهر ذلك بوضوح في ثقة التقرير',
        warning: true,
      }));

  onProgress(auditProgressEvent('account_context', 'started'));
  const { data: campaigns, error: campaignErr } = await supabase
    .from('campaigns_cache')
    .select('*')
    .eq('account_id', account.id)
    .order('last_synced_at', { ascending: false })
    .limit(1000);
  if (campaignErr) throw campaignErr;

  let sectorBenchmark = null;
  try {
    const { data: businessRow } = await supabase
      .from('businesses')
      .select('sector')
      .eq('user_id', userId)
      .maybeSingle();
    sectorBenchmark = await getSectorBenchmark(supabase, businessRow?.sector, account.currency_code);
  } catch (benchmarkError) {
    console.warn('Sector benchmark lookup failed during audit', benchmarkError);
  }
  onProgress(auditProgressEvent('account_context', 'completed', {
    detail: `تم تجهيز ${campaigns?.length ?? 0} حملة${sectorBenchmark ? ' مع مقارنة معيارية للقطاع' : ''}`,
  }));

  onProgress(auditProgressEvent('analysis', 'started'));
  const result = runRuleBasedAudit({
    account: {
      customer_id: account.customer_id,
      customer_name: account.customer_name,
      currency_code: account.currency_code,
    },
    campaigns: campaigns ?? [],
    conversionTracking: liveSnapshot?.conversion_tracking ?? null,
    benchmark: sectorBenchmark,
    liveSnapshot,
  });
  onProgress(auditProgressEvent('analysis', 'completed', {
    detail: `اكتشف المحرك ${result.findings.length} فرصة أو مخاطرة مدعومة ببيانات الحساب`,
  }));

  onProgress(auditProgressEvent('ai_narrative', 'started'));
  const aiNarrative = await generateAuditNarrative({
    account: {
      customer_id: account.customer_id,
      customer_name: account.customer_name,
      currency_code: account.currency_code,
    },
    result,
    snapshot: liveSnapshot,
  });
  onProgress(auditProgressEvent('ai_narrative', 'completed', {
    detail: aiNarrative ? 'تم ترتيب الأولويات وشرحها بلغة عملية' : 'اكتمل الفحص الحتمي؛ تعذر إرفاق القراءة اللغوية الإضافية',
    warning: !aiNarrative,
  }));

  onProgress(auditProgressEvent('save', 'started'));
  const duration = Date.now() - startTime;
  const { data: audit, error: auditErr } = await admin
    .from('audits')
    .insert({
      account_id: account.id,
      health_score: result.health_score,
      category_scores: result.category_scores,
      findings: result.findings,
      metrics_snapshot: {
        audit_engine_version: AUDIT_ENGINE_VERSION,
        customer_id: account.customer_id,
        customer_name: account.customer_name,
        currency_code: account.currency_code,
        campaigns_count: campaigns?.length ?? 0,
        sync_error: syncError,
        sector_benchmark: sectorBenchmark,
        live_coverage: liveSnapshot?.coverage ?? null,
        live_counts: liveSnapshot
          ? {
              campaigns: liveSnapshot.campaigns.length,
              search_terms: liveSnapshot.search_terms.length,
              keywords: liveSnapshot.keywords.length,
              ads: liveSnapshot.ads.length,
            }
          : null,
        ai_narrative: aiNarrative,
      },
      estimated_monthly_waste: result.estimated_monthly_waste_sar,
      duration_ms: duration,
    })
    .select('id')
    .single();
  if (auditErr) throw auditErr;

  const { error: supersedeErr } = await admin
    .from('recommendations')
    .update({ status: 'dismissed' })
    .eq('account_id', account.id)
    .eq('status', 'pending')
    .not('audit_id', 'is', null)
    .neq('audit_id', audit.id);
  if (supersedeErr) throw supersedeErr;

  const recRows = result.findings.map((finding) => ({
    audit_id: audit.id,
    account_id: account.id,
    category: finding.category,
    severity: finding.severity,
    title: finding.title_ar,
    description: finding.description_ar,
    expected_impact: finding.expected_impact,
    action_payload: finding.action_payload,
    fingerprint: auditFindingFingerprint(account.id, finding.action_payload),
    status: 'pending',
  }));

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

  onProgress(auditProgressEvent('save', 'completed', {
    detail: `تم حفظ التقرير و${result.findings.length} توصية للمراجعة قبل أي تنفيذ`,
  }));

  return {
    auditId: audit.id,
    healthScore: result.health_score,
    findingsCount: result.findings.length,
    durationMs: duration,
    syncError,
  };
}

function createAuditProgressResponse({
  execute,
  onFailure,
}: {
  execute: (onProgress: AuditProgressReporter) => Promise<AuditExecutionOutcome>;
  onFailure: (error: unknown) => Promise<void>;
}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AuditStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Keep the audit running when the browser disconnects; persistence is
          // more important than another progress frame.
        }
      };

      void (async () => {
        try {
          const outcome = await execute(send);
          send({
            type: 'complete',
            percent: 100,
            message: 'اكتمل الفحص وحُفظت النتيجة',
            redirect: `/audit?ran=1&audit=${outcome.auditId}`,
          });
        } catch (error) {
          await onFailure(error);
          send({
            type: 'error',
            code: 'audit_failed',
            message: 'تعذر إكمال الفحص الآن. لم ننفذ أي تعديل على حساب إعلانات Google.',
          });
        } finally {
          try {
            controller.close();
          } catch {
            // The browser may have closed the stream already.
          }
        }
      })();
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
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
  const target = auditFindingTargetKey(details);
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
