import {
  discoverAccessibleCustomers,
  getCustomerMetadataWithFallback,
  googleAdsSearch,
} from '@/lib/google-ads/client';
import { normalizeCustomerId } from '@/lib/accounts/selection';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import { mapLimit } from '@/lib/platform/concurrency';
import { buildGoogleAdsLinkRows } from '@/lib/google-ads/link-account-rows';
import { isNotAdsUserError } from '@/lib/google-ads/connect-errors';
import {
  connectJobName,
  nextStepAfterConnect,
  type ConnectJobDetails,
  type ConnectStageId,
} from '@/lib/onboarding/connect-progress';

/** Google Ads enforces a per-developer-token QPS ceiling; stay well under it. */
const METADATA_CONCURRENCY = 6;
/** Spend is a nice-to-have for ordering; never let it eat the whole budget. */
const SPEND_READ_LIMIT = 150;

type Discovered = Awaited<ReturnType<typeof discoverAccessibleCustomers>>;

/**
 * Records the start of a connect job. The `job_runs` partial unique index
 * allows one `running` row per job name, so any earlier row for this user is
 * retired first: a new consent always supersedes an older one.
 */
export async function startConnectJob(admin: any, userId: string) {
  const jobName = connectJobName(userId);
  const startedAt = new Date().toISOString();
  await admin
    .from('job_runs')
    .update({
      status: 'failed',
      finished_at: startedAt,
      error_message: 'superseded: a newer Google Ads consent started',
    })
    .eq('job_name', jobName)
    .eq('status', 'running');

  const { data, error } = await admin
    .from('job_runs')
    .insert({
      job_name: jobName,
      status: 'running',
      started_at: startedAt,
      details: { stage: 'discover' } satisfies ConnectJobDetails,
    })
    .select('id')
    .maybeSingle();
  if (error || !data?.id) {
    throw new Error(`Failed to record Google Ads connect job: ${error?.message ?? 'no id returned'}`);
  }
  return { id: data.id as string, startedAt };
}

async function setStage(admin: any, jobId: string, details: ConnectJobDetails) {
  const { error } = await admin.from('job_runs').update({ details }).eq('id', jobId);
  if (error) console.warn('Failed to record Google Ads connect stage', { jobId, stage: details.stage });
}

async function finish(
  admin: any,
  job: { id: string; startedAt: string },
  status: 'success' | 'failed',
  details: ConnectJobDetails
) {
  const finishedAt = new Date();
  const { error } = await admin
    .from('job_runs')
    .update({
      status,
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - new Date(job.startedAt).getTime(),
      processed: details.linkable ?? 0,
      error_count: status === 'failed' ? 1 : 0,
      details,
      error_message: status === 'failed' ? details.error ?? 'connect_failed' : null,
    })
    .eq('id', job.id);
  if (error) console.error('Failed to record Google Ads connect finish', { jobId: job.id });
}

/**
 * The heavy half of the OAuth callback, run after the redirect has already
 * been sent. Every write uses the service client with explicit business and
 * user filters, because the request's cookie-bound client is not usable once
 * the response is gone.
 *
 * The refresh token only lives in memory here and in the encrypted column.
 */
export async function runConnectJob(params: {
  admin: any;
  job: { id: string; startedAt: string };
  userId: string;
  business: { id: string; selected_google_ads_customer_id?: string | null };
  refreshToken: string;
  encryptedRefreshToken: string;
}) {
  const { admin, job, userId, business, refreshToken, encryptedRefreshToken } = params;
  let stage: ConnectStageId = 'discover';
  const details: ConnectJobDetails = { stage };

  try {
    const accounts = await discoverAccessibleCustomers(refreshToken);
    details.accounts_found = accounts.length;
    if (accounts.length === 0) {
      console.warn(`[google-ads/callback] no_ads_account reason=empty_discovery user=${userId}`);
      await finish(admin, job, 'failed', { ...details, error: 'no_accounts' });
      return;
    }

    stage = 'read';
    details.stage = stage;
    await setStage(admin, job.id, details);

    const enrichedAccounts = await enrichLinkableAccounts(
      refreshToken,
      accounts.filter((account) => !account.is_manager),
      accounts
    );
    // Re-apply the manager filter AFTER enrichment: metadata read during
    // enrichment can reveal that an account discovery flagged as a client is
    // in fact an MCC. Linking one means every later sync asks Google for
    // metrics on a manager and gets REQUESTED_METRICS_FOR_MANAGER forever.
    const linkableAccounts = enrichedAccounts.filter((account) => account.is_manager !== true);
    if (linkableAccounts.length === 0) {
      await finish(admin, job, 'failed', { ...details, error: 'no_client_accounts' });
      return;
    }

    const existingMetadata = await loadExistingAccountMetadata(admin, business.id);
    const rows = buildGoogleAdsLinkRows({
      businessId: business.id,
      encryptedRefreshToken,
      accounts: linkableAccounts,
      existingMetadata,
    });

    // Account creation and credential/link-state updates are service-owned.
    const { data: savedAccounts, error: linkError } = await admin
      .from('google_ads_accounts')
      .upsert(rows, { onConflict: 'business_id,customer_id' })
      .select('id, customer_id, manager_id, currency_code');
    if (linkError) {
      console.error('Failed to auto-link Google Ads accounts', { code: linkError.code, message: linkError.message });
      await finish(admin, job, 'failed', { ...details, error: 'db_error' });
      return;
    }

    const saved = (savedAccounts ?? []) as Array<{
      id: string;
      customer_id: string;
      manager_id: string | null;
      currency_code: string | null;
    }>;
    details.linkable = saved.length || linkableAccounts.length;

    stage = 'sync';
    details.stage = stage;
    await setStage(admin, job.id, details);

    const persistedId = normalizeCustomerId(business.selected_google_ads_customer_id ?? '');
    const persisted = persistedId
      ? saved.find((account) => normalizeCustomerId(account.customer_id) === persistedId) ?? null
      : null;
    // One account is not a choice, so it is selected for the user. With more
    // than one, the user picks on /onboarding/choose; nothing is preselected.
    const autoSelected = !persisted && saved.length === 1 ? saved[0] : null;

    if (autoSelected) {
      const { error: preferenceError } = await admin
        .from('businesses')
        .update({ selected_google_ads_customer_id: normalizeCustomerId(autoSelected.customer_id) })
        .eq('id', business.id)
        .eq('user_id', userId);
      if (preferenceError) console.warn('Unable to persist the only Google Ads account as selected');
    }

    const syncTarget = persisted ?? autoSelected;
    const [spend] = await Promise.all([
      saved.length > 1 ? readThirtyDaySpend(refreshToken, saved) : Promise.resolve(undefined),
      syncTarget ? syncFirstAccount(admin, refreshToken, syncTarget) : Promise.resolve(),
    ]);
    if (spend) details.spend = spend;

    details.stage = 'done';
    details.next = nextStepAfterConnect({
      linkableCount: saved.length,
      persistedSelectionStillLinked: Boolean(persisted),
    });
    await finish(admin, job, 'success', details);
  } catch (err) {
    // A Google account with no Google Ads account at all comes back as a
    // NOT_ADS_USER 401 from the very first discovery call. It is the same
    // situation as an empty discovery, so it goes to the same recovery block.
    if (isNotAdsUserError(err)) {
      console.warn(`[google-ads/callback] no_ads_account reason=not_ads_user user=${userId}`);
      await finish(admin, job, 'failed', { ...details, error: 'no_accounts' });
      return;
    }
    console.error('Google Ads connect job failed', { stage, message: err instanceof Error ? err.message : 'unknown' });
    await finish(admin, job, 'failed', { ...details, error: 'connect_failed' });
  }
}

async function syncFirstAccount(
  admin: any,
  refreshToken: string,
  account: { id: string; customer_id: string; manager_id: string | null; currency_code: string | null }
) {
  try {
    const syncResult = await syncCampaignCacheWithLoginFallback({
      supabase: admin,
      customerId: account.customer_id,
      refreshToken,
      accountId: account.id,
      currencyCode: account.currency_code,
      loginCustomerIds: [account.manager_id],
    });
    if (syncResult.loginCustomerId) {
      await admin
        .from('google_ads_accounts')
        .update({ manager_id: syncResult.loginCustomerId })
        .eq('id', account.id);
    }
  } catch (syncError) {
    console.warn(
      `Initial campaign sync failed for ${account.customer_id}`,
      syncError instanceof Error ? syncError.message : 'unknown'
    );
  }
}

/**
 * Customer-level cost over the last 30 days for each account, used only to
 * order the chooser. A failed read is `null` (unknown), never 0.
 */
async function readThirtyDaySpend(
  refreshToken: string,
  accounts: Array<{ customer_id: string; manager_id: string | null }>
) {
  const spend: Record<string, number | null> = {};
  const targets = accounts.slice(0, SPEND_READ_LIMIT);
  await mapLimit(targets, METADATA_CONCURRENCY, async (account) => {
    const customerId = normalizeCustomerId(account.customer_id);
    const attempts = [account.manager_id, null].filter(
      (value, index, values) => values.indexOf(value) === index
    );
    for (const loginCustomerId of attempts) {
      try {
        const rows = await googleAdsSearch(
          refreshToken,
          customerId,
          'SELECT metrics.cost_micros FROM customer WHERE segments.date DURING LAST_30_DAYS',
          loginCustomerId
        );
        const micros = rows.reduce(
          (sum: number, row: any) => sum + Number(row?.metrics?.costMicros ?? row?.metrics?.cost_micros ?? 0),
          0
        );
        spend[customerId] = Number.isFinite(micros) ? Math.round(micros / 10_000) / 100 : null;
        return;
      } catch {
        // try the next login header
      }
    }
    spend[customerId] = null;
  });
  return spend;
}

async function enrichLinkableAccounts(refreshToken: string, linkableAccounts: Discovered, allAccounts: Discovered) {
  const loginCandidates = [
    ...allAccounts
      .flatMap((account) => [account.manager_id, account.is_manager ? account.customer_id : null])
      .filter((value): value is string => Boolean(value)),
  ].filter((value, index, values) => values.indexOf(value) === index);

  return mapLimit(linkableAccounts, METADATA_CONCURRENCY, async (account) => {
    if (account.customer_name && account.currency_code && account.time_zone) return account;

    try {
      const normalizedCustomerId = normalizeCustomerId(account.customer_id);
      const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
        refreshToken,
        normalizedCustomerId,
        [account.manager_id, ...loginCandidates].filter((value): value is string => Boolean(value))
      );

      return {
        ...account,
        customer_id: metadata.customer_id,
        customer_name: account.customer_name ?? metadata.customer_name,
        manager_id:
          account.manager_id ??
          (loginCustomerId && loginCustomerId !== normalizedCustomerId ? loginCustomerId : null),
        // Take the freshly-read metadata whenever it says "manager"; that is
        // the value the caller filters on.
        is_manager: metadata.is_manager || account.is_manager || false,
        currency_code: account.currency_code ?? metadata.currency_code,
        time_zone: account.time_zone ?? metadata.time_zone,
      };
    } catch (error) {
      console.warn(
        `Failed to enrich Google Ads account ${account.customer_id} during connect`,
        error instanceof Error ? error.message : 'unknown'
      );
      return account;
    }
  });
}

/**
 * Reads the metadata already stored for this business so a re-connect never
 * blanks a name the user typed by hand. Throws instead of returning an empty
 * map: swallowing the error wrote NULL over every stored name in the upsert
 * that follows. Pages explicitly past the PostgREST 1000-row default.
 */
async function loadExistingAccountMetadata(admin: any, businessId: string) {
  const pageSize = 500;
  const result = new Map<string, any>();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from('google_ads_accounts')
      .select('customer_id, customer_name, manager_id, currency_code, time_zone')
      .eq('business_id', businessId)
      .order('customer_id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to load existing Google Ads account metadata: ${error.message ?? error}`);
    }

    for (const account of data ?? []) {
      result.set(normalizeCustomerId(account.customer_id), {
        customer_name: account.customer_name ?? null,
        manager_id: account.manager_id ?? null,
        currency_code: account.currency_code ?? null,
        time_zone: account.time_zone ?? null,
      });
    }

    if (!data || data.length < pageSize) break;
  }

  return result;
}
