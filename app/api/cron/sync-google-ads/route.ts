import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import {
  getCustomerMetadataWithFallback,
  googleAdsAuthNeedsReconnect,
} from '@/lib/google-ads/client';
import { ManagerAccountError, syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import { finishJobRun, getBillableBusinessIds, startJobRun } from '@/lib/platform/jobs';
import { sendOpsAlert } from '@/lib/notifications/email';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { createTimeBudget, mapLimit } from '@/lib/platform/concurrency';
import {
  SYNC_ACCOUNT_CONCURRENCY,
  SYNC_ACCOUNT_LIMIT,
} from '@/lib/platform/job-capacity';

export const maxDuration = 300;

/** Leave ~40s of the 300s function budget for bookkeeping and alerts. */
const SYNC_BUDGET_MS = 260_000;

async function runSync(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json(
      { error: 'service_role_missing', message: error instanceof Error ? error.message : String(error) },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const requestedAccountId = url.searchParams.get('account_id');
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit') ?? SYNC_ACCOUNT_LIMIT) || SYNC_ACCOUNT_LIMIT, 1),
    SYNC_ACCOUNT_LIMIT
  );
  const job = await startJobRun(supabase, 'sync-google-ads');

  let businessIds: string[];
  try {
    businessIds = await getBillableBusinessIds(supabase);
  } catch (error) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [error] });
    await safeOpsAlert('تعذر تحديد الاشتراكات النشطة للمزامنة', error);
    return NextResponse.json({ error: 'subscription_lookup_failed' }, { status: 500 });
  }

  if (businessIds.length === 0) {
    await finishJobRun({
      supabase,
      job,
      status: 'success',
      details: { note: 'No billable businesses found' },
    });
    return NextResponse.json({ processed: 0, skipped: 'no_billable_businesses' });
  }

  // Exclude manager (MCC) accounts. A metrics query to one throws
  // REQUESTED_METRICS_FOR_MANAGER, the row is re-flagged is_manager, and since
  // it must never enter a metrics queue. last_sync_attempt_at advances even
  // after a failed attempt, so one revoked/misconfigured account cannot starve
  // every healthy account behind it.
  let query = supabase
    .from('google_ads_accounts')
    .select('id, customer_id, customer_name, manager_id, currency_code, time_zone, refresh_token_encrypted')
    .eq('status', 'active')
    .not('is_manager', 'is', true)
    .in('business_id', businessIds)
    .order('last_sync_attempt_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (requestedAccountId) {
    query = query.eq('id', requestedAccountId);
  }

  const { data: accounts, error } = await query;
  if (error) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [error] });
    await safeOpsAlert('فشل جلب حسابات مهمة المزامنة', error);
    return NextResponse.json({ error: 'account_lookup_failed', message: error.message }, { status: 500 });
  }

  const results = {
    processed: 0,
    updated_campaign_rows: 0,
    active_campaigns: 0,
    errors: [] as Array<{ customer_id: string; message: string }>,
  };

  // Hard wall-clock budget. Vercel kills the function at maxDuration with no
  // chance to record progress, so the job stops itself early, reports what it
  // did, and leaves the rest for the next hourly run.
  const budget = createTimeBudget(SYNC_BUDGET_MS);
  let skippedForTime = 0;

  await mapLimit(accounts ?? [], SYNC_ACCOUNT_CONCURRENCY, async (account) => {
    if (budget.expired()) {
      skippedForTime += 1;
      return;
    }

    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const metadata = await resolveAccountMetadata(refreshToken, account);
      const syncResult = await syncCampaignCacheWithLoginFallback({
        supabase,
        customerId: account.customer_id,
        refreshToken,
        accountId: account.id,
        currencyCode: metadata.currency_code ?? account.currency_code,
        loginCustomerIds: [metadata.manager_id],
        // A full MCC tree walk per account is what pushed this job past its
        // budget; the metadata resolver above already had its chance.
        allowDiscoveryFallback: false,
      });
      const syncedAt = new Date().toISOString();
      const update: Record<string, unknown> = { last_synced_at: syncedAt };
      if (metadata.customer_name) update.customer_name = metadata.customer_name;
      if (syncResult.loginCustomerId ?? metadata.manager_id) {
        update.manager_id = syncResult.loginCustomerId ?? metadata.manager_id;
      }
      if (metadata.currency_code) update.currency_code = metadata.currency_code;
      if (metadata.time_zone) update.time_zone = metadata.time_zone;

      await supabase
        .from('google_ads_accounts')
        .update(update)
        .eq('id', account.id);

      results.processed++;
      results.updated_campaign_rows += syncResult.updated;
      results.active_campaigns += syncResult.active;
    } catch (err) {
      // A revoked or expired grant is not a transient sync failure: mark the
      // account so the dashboard can ask the owner to reconnect instead of
      // retrying it silently every night forever.
      if (googleAdsAuthNeedsReconnect(err)) {
        await supabase.from('google_ads_accounts').update({ status: 'revoked' }).eq('id', account.id);
      }
      if (err instanceof ManagerAccountError) {
        // Flag it AND stamp last_synced_at so it drops to the back of the
        // ascending queue instead of resurfacing first on every run.
        await supabase
          .from('google_ads_accounts')
          .update({ is_manager: true, last_synced_at: new Date().toISOString() })
          .eq('id', account.id);
      }
      results.errors.push({
        customer_id: account.customer_id,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const { error: cursorError } = await supabase
        .from('google_ads_accounts')
        .update({ last_sync_attempt_at: new Date().toISOString() })
        .eq('id', account.id);
      if (cursorError) {
        results.errors.push({
          customer_id: account.customer_id,
          message: `queue_cursor:${cursorError.message}`,
        });
      }
    }
  });

  const status = results.errors.length === 0 ? 'success' : results.processed > 0 ? 'partial' : 'failed';
  await finishJobRun({
    supabase,
    job,
    status,
    processed: results.processed,
    errors: results.errors,
    details: {
      updated_campaign_rows: results.updated_campaign_rows,
      active_campaigns: results.active_campaigns,
      // Never truncate silently: an operator reading job_runs must be able to
      // tell "everything synced" from "we ran out of time".
      skipped_for_time: skippedForTime,
      batch_limit: limit,
      concurrency: SYNC_ACCOUNT_CONCURRENCY,
    },
  });
  if (results.errors.length > 0) {
    await safeOpsAlert('مهمة مزامنة Google Ads انتهت بأخطاء', results.errors);
  }

  return NextResponse.json(results);
}

async function safeOpsAlert(subject: string, details: unknown) {
  try {
    await sendOpsAlert({
      subject,
      message: 'راجع سجل المهام في Supabase وسجلات Vercel لمعرفة الحسابات المتأثرة.',
      details,
    });
  } catch (error) {
    console.error('Failed to send sync cron alert', error);
  }
}

export async function GET(req: NextRequest) {
  return runSync(req);
}

export async function POST(req: NextRequest) {
  return runSync(req);
}

async function resolveAccountMetadata(
  refreshToken: string,
  account: {
    customer_id: string;
    customer_name?: string | null;
    manager_id?: string | null;
  }
) {
  const normalizedCustomerId = account.customer_id.replace(/\D/g, '');
  let customerName = account.customer_name ?? null;
  let managerId = account.manager_id ?? null;
  let currencyCode: string | null = null;
  let timeZone: string | null = null;

  try {
    const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
      refreshToken,
      normalizedCustomerId,
      managerId ? [managerId] : []
    );
    customerName = metadata.customer_name ?? customerName;
    managerId =
      managerId ??
      (loginCustomerId && loginCustomerId !== normalizedCustomerId ? loginCustomerId : null);
    currencyCode = metadata.currency_code;
    timeZone = metadata.time_zone;
  } catch (error) {
    console.warn(`Failed to refresh metadata for ${normalizedCustomerId}`, error);
  }

  // NOTE: this used to fall back to a full discoverAccessibleCustomers() —
  // an entire MCC tree walk — once per account whenever a name or manager id
  // was missing, which is the normal state for many accounts. With 50 accounts
  // in one run that was 50 tree walks inside a single 300s function, so the
  // job was killed every night and last_synced_at never advanced.
  // Name recovery now belongs to /api/accounts/repair-names, which is bounded
  // and has its own 7-day cooldown per account.

  return {
    customer_name: customerName,
    manager_id: managerId,
    currency_code: currencyCode,
    time_zone: timeZone,
  };
}
