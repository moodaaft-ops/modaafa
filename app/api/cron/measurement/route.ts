import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { getCustomer } from '@/lib/google-ads/client';
import { googleAdsClickConversionTransport } from '@/lib/google-ads/click-conversions';
import { dataManagerSender } from '@/lib/google-ads/data-manager';
import { isDataManagerUploadEnabled } from '@/lib/google-auth/features';
import { extraAccessToken } from '@/lib/google-auth/incremental';
import { loadGrantForAccount, markGrantFailed } from '@/lib/google-auth/store';
import { normalizePreference } from '@/lib/lead-loop/transports';
import { decrypt } from '@/lib/crypto';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { excludeShadowAccounts } from '@/lib/shadow/guard';
import { isLeadLoopEnabled, isLeadLoopServing } from '@/lib/lead-loop/flag';
import { uploadLeadConversions, type UploadSummary } from '@/lib/lead-loop/upload-service';
import { findLeadActionQuery, parseFoundLeadAction } from '@/lib/measurement/conversion-actions';
import { scanAccountMeasurement } from '@/lib/measurement/scan';
import {
  finishJobRun,
  getOptimizerAllowedAccountIds,
  hasRecentCompletedRun,
  startJobRun,
} from '@/lib/platform/jobs';
import { createTimeBudget, mapLimit } from '@/lib/platform/concurrency';

export const maxDuration = 120;

const BUDGET_MS = 100_000;
const UPLOAD_ACCOUNTS_PER_RUN = 15;
const SCAN_ACCOUNTS_PER_RUN = 8;
const SCAN_EVERY_MS = 20 * 60 * 60 * 1000;
const ACCOUNT_COLUMNS = 'id, customer_id, manager_id, currency_code, time_zone, refresh_token_encrypted, status, is_manager, write_access';

/**
 * Hourly measurement step (LEAD_LOOP_ENABLED).
 *  1. Uploads leads the merchants marked "صار زبون" as offline click conversions.
 *  2. Scans a few accounts a day for a resolved tracking gap (proposes a data
 *     exclusion) and for the lead-action ladder (create it, then promote it).
 * Step 2 only writes pending recommendations; the account changes only when the
 * merchant approves them. With the flag off this answers {skipped:'disabled'}
 * before touching anything.
 */
export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isLeadLoopServing()) return NextResponse.json({ skipped: 'disabled' });

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  if (req.nextUrl.searchParams.get('force') !== '1' && (await hasRecentCompletedRun(supabase, 'measurement'))) {
    return NextResponse.json({ skipped: 'recent_run' });
  }
  const job = await startJobRun(supabase, 'measurement');
  if (job.alreadyRunning) return NextResponse.json({ skipped: 'already_running' }, { status: 409 });

  const budget = createTimeBudget(BUDGET_MS);
  const errors: unknown[] = [];
  const uploads: Record<string, UploadSummary['status'] | 'error'> = {};
  const dataManagerOn = isDataManagerUploadEnabled();
  let uploaded = 0;
  let scanned = 0;
  let proposed = 0;

  try {
    // ---- 1. uploads -------------------------------------------------------
    const { data: waiting, error: waitingError } = await supabase
      .from('lead_clicks')
      .select('account_id')
      .eq('status', 'customer')
      .in('upload_status', ['pending', 'uploading'])
      .limit(500);
    if (waitingError) throw waitingError;
    const uploadAccountIds = [...new Set((waiting ?? []).map((row: any) => String(row.account_id)))].slice(0, UPLOAD_ACCOUNTS_PER_RUN);

    await mapLimit(uploadAccountIds, 3, async (accountId) => {
      if (budget.expired(15_000)) return;
      try {
        const [{ data: account }, { data: settings }] = await Promise.all([
          supabase.from('google_ads_accounts').select(ACCOUNT_COLUMNS).eq('id', accountId).eq('status', 'active').maybeSingle(),
          supabase
            .from('lead_loop_settings')
            // The channel columns come with the Data Manager migration: read them only while the flag is on.
            .select((dataManagerOn ? 'conversion_action_resource, upload_channel, legacy_blocked_at' : 'conversion_action_resource') as string)
            .eq('account_id', accountId)
            .maybeSingle(),
        ]);
        if (!account || account.is_manager || !settings) return;
        const refreshToken = decrypt(account.refresh_token_encrypted);
        let channels;
        if (dataManagerOn) {
          const grant = await loadGrantForAccount(supabase, accountId, 'data_manager').catch(() => null);
          channels = {
            dataManagerAvailable: Boolean(grant),
            makeDataManagerSender: async () => {
              try {
                return dataManagerSender(await extraAccessToken(grant!.refreshToken));
              } catch (error) {
                // A revoked grant must not be retried every hour: mark it so the merchant is asked again.
                if (grant && /invalid_grant/i.test(error instanceof Error ? error.message : '')) {
                  await markGrantFailed(supabase, grant.user_id, 'data_manager', 'revoked', 'invalid_grant');
                }
                throw error;
              }
            },
            preference: normalizePreference((settings as any).upload_channel),
            legacyBlocked: Boolean((settings as any).legacy_blocked_at),
          };
        }
        const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
        const summary = await uploadLeadConversions({
          db: supabase,
          account: {
            id: account.id,
            customerId: account.customer_id,
            loginCustomerId: account.manager_id,
            timeZone: account.time_zone,
          },
          settings: settings as unknown as { conversion_action_resource: string | null },
          transport: googleAdsClickConversionTransport(refreshToken),
          findConversionAction: async () => parseFoundLeadAction(await customer.query(findLeadActionQuery())),
          ...(channels ? { channels } : {}),
        });
        uploads[accountId] = summary.status;
        uploaded += summary.uploaded + summary.duplicates;
        if (summary.status === 'request_failed') errors.push(new Error(`upload ${accountId}: ${summary.error}`));
      } catch (error) {
        uploads[accountId] = 'error';
        errors.push(error);
      }
    });

    // ---- 2. scans ---------------------------------------------------------
    if (!budget.expired(30_000)) {
      const { allowedAccountIds } = await getOptimizerAllowedAccountIds(supabase);
      const since = new Date(Date.now() - SCAN_EVERY_MS).toISOString();
      const { data: recent } = await supabase.from('measurement_scans').select('account_id').gte('last_scan_at', since);
      const done = new Set((recent ?? []).map((row: any) => String(row.account_id)));
      // Agency shadow accounts get no proposal cards (SHADOW_MODE_ENABLED; a no-op when off).
      const notDone = allowedAccountIds.filter((id) => !done.has(id));
      // LEAD_LOOP_ENABLED=operators: only accounts of allowed owners get cards (same rule as the routes).
      const permitted = await filterLeadLoopOwners(supabase, notDone);
      const due = (await excludeShadowAccounts(supabase, permitted.map((id) => ({ id })))).map((row) => row.id).slice(0, SCAN_ACCOUNTS_PER_RUN);

      await mapLimit(due, 2, async (accountId) => {
        if (budget.expired(20_000)) return;
        try {
          const [{ data: account }, { data: settings }] = await Promise.all([
            supabase.from('google_ads_accounts').select(ACCOUNT_COLUMNS).eq('id', accountId).eq('status', 'active').maybeSingle(),
            supabase.from('lead_loop_settings').select('account_id').eq('account_id', accountId).maybeSingle(),
          ]);
          // A read-only link cannot execute what a card proposes, so it gets no cards.
          if (!account || account.is_manager || account.write_access === 'read_only') return;
          const customer = getCustomer(account.customer_id, decrypt(account.refresh_token_encrypted), account.manager_id ?? undefined);
          const summary = await scanAccountMeasurement({
            query: (gaql) => customer.query(gaql),
            admin: supabase,
            account: {
              id: account.id,
              customerId: account.customer_id,
              currencyCode: account.currency_code,
              timeZone: account.time_zone,
            },
            hasLeadLoopSettings: Boolean(settings),
          });
          scanned += 1;
          proposed += summary.proposals.filter((p) => p.outcome.created).length;
        } catch (error) {
          errors.push(error);
        }
      });
    }

    await finishJobRun({
      supabase,
      job,
      status: errors.length > 0 ? 'partial' : 'success',
      processed: uploadAccountIds.length + scanned,
      errors,
      details: { uploads, uploaded, scanned, proposed },
    });
    return NextResponse.json({ uploads, uploaded, scanned, proposed, errors: errors.length });
  } catch (error) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [error] });
    console.error('measurement cron failed', error);
    return NextResponse.json({ error: 'measurement_failed', message: describeError(error) }, { status: 500 });
  }
}

/**
 * In "true" mode every account passes. In "operators" mode an account passes
 * only when its owner's email is allowed; an unreadable owner fails closed.
 */
async function filterLeadLoopOwners(supabase: any, accountIds: string[]): Promise<string[]> {
  if (process.env.LEAD_LOOP_ENABLED === 'true' || accountIds.length === 0) return accountIds;
  const { data: accounts, error } = await supabase.from('google_ads_accounts').select('id, business_id').in('id', accountIds);
  if (error || !accounts) return [];
  const businessIds = [...new Set(accounts.map((row: any) => row.business_id).filter(Boolean))];
  if (businessIds.length === 0) return [];
  const { data: businesses, error: businessError } = await supabase.from('businesses').select('id, user_id').in('id', businessIds);
  if (businessError || !businesses) return [];
  const userIds = [...new Set(businesses.map((row: any) => row.user_id).filter(Boolean))];
  if (userIds.length === 0) return [];
  const { data: users, error: usersError } = await supabase.from('users').select('id, email').in('id', userIds);
  if (usersError || !users) return [];
  const emailByUser = new Map<string, string | null>(users.map((row: any) => [String(row.id), row.email ?? null]));
  const userByBusiness = new Map<string, string>(businesses.map((row: any) => [String(row.id), String(row.user_id)]));
  const allowed = new Set(
    accounts
      .filter((row: any) => isLeadLoopEnabled(process.env, emailByUser.get(userByBusiness.get(String(row.business_id)) ?? '') ?? null))
      .map((row: any) => String(row.id))
  );
  return accountIds.filter((id) => allowed.has(id));
}
