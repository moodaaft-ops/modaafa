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

export type ConnectJobDeps = {
  discover?: typeof discoverAccessibleCustomers;
  syncCache?: typeof syncCampaignCacheWithLoginFallback;
  readSpend?: (
    refreshToken: string,
    accounts: Array<{ customer_id: string; manager_id: string | null }>
  ) => Promise<Record<string, number | null>>;
};

/**
 * Records the start of a connect job. The retire-old-and-insert-new step is one
 * SQL function (`connect_job_start`) under a per-user advisory lock: two
 * simultaneous consents cannot both end up `running`, and the later one always
 * supersedes the earlier one.
 */
export async function startConnectJob(admin: any, userId: string) {
  const startedAt = new Date().toISOString();
  const { data, error } = await admin.rpc('connect_job_start', { p_user_id: userId });
  if (error || !data || typeof data !== 'string') {
    throw new Error(`Failed to record Google Ads connect job: ${error?.code ?? 'no id returned'}`);
  }
  return { id: data, startedAt };
}

/**
 * Fencing: a job may only write while its own `job_runs` row is still
 * `running`. These two helpers are single conditional statements, so a job that
 * was superseded (or closed by the timeout sweep) can neither change its stage
 * nor flip itself back to success. They return false when the job is no longer
 * the live one.
 */
async function setStage(admin: any, jobId: string, details: ConnectJobDetails): Promise<boolean> {
  const { data, error } = await admin
    .from('job_runs')
    .update({ details })
    .eq('id', jobId)
    .eq('status', 'running')
    .select('id');
  if (error) console.warn('Failed to record Google Ads connect stage', { jobId, stage: details.stage });
  return !error && Array.isArray(data) && data.length > 0;
}

async function finish(
  admin: any,
  job: { id: string; startedAt: string },
  status: 'success' | 'failed',
  details: ConnectJobDetails
): Promise<boolean> {
  const finishedAt = new Date();
  const { data, error } = await admin
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
    .eq('id', job.id)
    .eq('status', 'running')
    .select('id');
  if (error) console.error('Failed to record Google Ads connect finish', { jobId: job.id });
  return !error && Array.isArray(data) && data.length > 0;
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
  /** Test seam only; production callers leave this out. */
  deps?: ConnectJobDeps;
}) {
  const { admin, job, userId, business, refreshToken, encryptedRefreshToken } = params;
  const discover = params.deps?.discover ?? discoverAccessibleCustomers;
  const syncCache = params.deps?.syncCache ?? syncCampaignCacheWithLoginFallback;
  const readSpend = params.deps?.readSpend ?? readThirtyDaySpend;
  let stage: ConnectStageId = 'discover';
  const details: ConnectJobDetails = { stage };

  try {
    const accounts = await discover(refreshToken);
    details.accounts_found = accounts.length;
    if (accounts.length === 0) {
      console.warn(`[google-ads/callback] no_ads_account reason=empty_discovery user=${userId}`);
      await finish(admin, job, 'failed', { ...details, error: 'no_accounts' });
      return;
    }

    stage = 'read';
    details.stage = stage;
    // Superseded while discovering: stop before reading anything else.
    if (!(await setStage(admin, job.id, details))) return;

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

    // Credential write. One SQL function locks this job's row, refuses unless
    // it is still the live job, and only then upserts, so an older consent can
    // never land its token after a newer one has started.
    const { data: linkResult, error: linkError } = await admin.rpc('connect_job_link', {
      p_job_id: job.id,
      p_user_id: userId,
      p_business_id: business.id,
      p_rows: rows,
    });
    if (linkError) {
      console.error('Failed to auto-link Google Ads accounts', { code: linkError.code });
      await finish(admin, job, 'failed', { ...details, error: 'db_error' });
      return;
    }
    if (linkResult?.status === 'superseded') return;
    if (linkResult?.status !== 'linked') {
      await finish(admin, job, 'failed', { ...details, error: 'db_error' });
      return;
    }

    const saved = (linkResult.rows ?? []) as Array<{
      id: string;
      customer_id: string;
      manager_id: string | null;
      currency_code: string | null;
    }>;
    details.linkable = saved.length || linkableAccounts.length;

    stage = 'sync';
    details.stage = stage;
    if (!(await setStage(admin, job.id, details))) return;

    const persistedId = normalizeCustomerId(business.selected_google_ads_customer_id ?? '');
    const persisted = persistedId
      ? saved.find((account) => normalizeCustomerId(account.customer_id) === persistedId) ?? null
      : null;
    // One account is not a choice, so it is selected for the user. With more
    // than one, the user picks on /onboarding/choose; nothing is preselected.
    const autoSelected = !persisted && saved.length === 1 ? saved[0] : null;

    if (autoSelected) {
      const { data: selectResult, error: preferenceError } = await admin.rpc('connect_job_select_account', {
        p_job_id: job.id,
        p_user_id: userId,
        p_business_id: business.id,
        p_customer_id: normalizeCustomerId(autoSelected.customer_id),
      });
      if (selectResult === 'superseded') return;
      if (preferenceError) console.warn('Unable to persist the only Google Ads account as selected');
    }

    const syncTarget = persisted ?? autoSelected;
    const [spend] = await Promise.all([
      saved.length > 1 ? readSpend(refreshToken, saved) : Promise.resolve(undefined),
      syncTarget ? syncFirstAccount(admin, job.id, userId, refreshToken, syncTarget, syncCache) : Promise.resolve(),
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
  jobId: string,
  userId: string,
  refreshToken: string,
  account: { id: string; customer_id: string; manager_id: string | null; currency_code: string | null },
  syncCache: typeof syncCampaignCacheWithLoginFallback
) {
  try {
    const syncResult = await syncCache({
      supabase: admin,
      customerId: account.customer_id,
      refreshToken,
      accountId: account.id,
      currencyCode: account.currency_code,
      loginCustomerIds: [account.manager_id],
    });
    if (syncResult.loginCustomerId) {
      // Fenced like the other effectful writes: a superseded job leaves it alone.
      await admin.rpc('connect_job_set_manager', {
        p_job_id: jobId,
        p_user_id: userId,
        p_account_id: account.id,
        p_manager_id: syncResult.loginCustomerId,
      });
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
