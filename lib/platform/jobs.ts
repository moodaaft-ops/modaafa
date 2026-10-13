import {
  applyAccessOverrides,
  effectiveLimitPlan,
  isSubscriptionEntitled,
  subscriptionAccessFromRows,
  type BillingPlan,
} from '@/lib/billing/entitlements';
import {
  NO_OVERRIDES,
  readAllLiveOverrides,
  type LiveAccessOverrides,
} from '@/lib/billing/access-overrides';

/**
 * A `running` row older than this is a corpse: maxDuration is 300s, so any
 * genuine invocation has finished (or been killed) well inside 10 minutes.
 */
const STALE_RUNNING_MS = 10 * 60 * 1000;

/**
 * Run-level throttle for the hourly crons. The scheduler now offers several
 * trigger slots per hour (GitHub drops most single slots), so a trigger that
 * arrives shortly after a run that already completed must be a no-op. Only
 * the statuses finishJobRun writes for a completed run count ('success' |
 * 'partial'); 'failed' and 'running' never throttle, so a broken run is
 * retried on the next slot. Fails open on a lookup error.
 */
export const RECENT_RUN_WINDOW_MS = 50 * 60 * 1000;

export async function hasRecentCompletedRun(
  supabase: any,
  jobName: string,
  windowMs = RECENT_RUN_WINDOW_MS,
  now = Date.now()
) {
  try {
    const { data, error } = await supabase
      .from('job_runs')
      .select('id')
      .eq('job_name', jobName)
      .in('status', ['success', 'partial'])
      .gte('started_at', new Date(now - windowMs).toISOString())
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    console.error('Recent-run throttle unavailable; running anyway', { jobName, error });
    return false;
  }
}

export async function startJobRun(supabase: any, jobName: string) {
  const startedAt = new Date();

  // Overlap guard. The GitHub Actions scheduler calls these routes with
  // `--retry 2 --retry-all-errors --max-time 290` against maxDuration=300, so
  // a slow run is aborted CLIENT-side at 290s and immediately re-invoked while
  // the first invocation is still executing — two live optimize runs then
  // select the same oldest accounts and double the Anthropic spend. Manual
  // workflow_dispatch runs in a separate concurrency group and can overlap the
  // schedule too. Best-effort (a storage error must not stop the job); the
  // check-then-insert race that remains is closed at the DB by the partial
  // unique index in migration 20260803_full_audit_integrity.sql.
  try {
    const staleCutoff = new Date(startedAt.getTime() - STALE_RUNNING_MS).toISOString();
    await supabase
      .from('job_runs')
      .update({
        status: 'failed',
        finished_at: startedAt.toISOString(),
        error_message:
          'superseded: running row went stale — the invocation was killed before it could record completion',
      })
      .eq('job_name', jobName)
      .eq('status', 'running')
      .lt('started_at', staleCutoff);

    const { data: running } = await supabase
      .from('job_runs')
      .select('id')
      .eq('job_name', jobName)
      .eq('status', 'running')
      .gte('started_at', staleCutoff)
      .limit(1)
      .maybeSingle();
    if (running) return { id: undefined as string | undefined, startedAt, alreadyRunning: true };
  } catch (error) {
    console.error('Job overlap guard unavailable; starting anyway', { jobName, error });
  }

  const { data, error } = await supabase
    .from('job_runs')
    .insert({ job_name: jobName, status: 'running', started_at: startedAt.toISOString() })
    .select('id')
    .maybeSingle();

  if (error) {
    // 23505 = the DB-level "one running row per job" index says a concurrent
    // invocation won the race after our check.
    if ((error as { code?: string }).code === '23505') {
      return { id: undefined as string | undefined, startedAt, alreadyRunning: true };
    }
    console.error('Failed to record job start', { jobName, error });
  }
  return { id: data?.id as string | undefined, startedAt, alreadyRunning: false };
}

export async function finishJobRun({
  supabase,
  job,
  status,
  processed = 0,
  errors = [],
  details = {},
}: {
  supabase: any;
  job: { id?: string; startedAt: Date };
  status: 'success' | 'partial' | 'failed';
  processed?: number;
  errors?: unknown[];
  details?: Record<string, unknown>;
}) {
  if (!job.id) return;
  const finishedAt = new Date();
  const firstError = errors[0];
  const { error } = await supabase
    .from('job_runs')
    .update({
      status,
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - job.startedAt.getTime(),
      processed,
      error_count: errors.length,
      details,
      error_message: firstError ? errorText(firstError).slice(0, 4000) : null,
    })
    .eq('id', job.id);
  if (error) console.error('Failed to record job finish', { jobId: job.id, error });
}

/**
 * PostgREST caps a single response at ~1000 rows. Both nightly crons feed off
 * this list, so an unpaginated read silently dropped every paying customer past
 * the cap from all sync and optimization — while still reporting success. Page
 * through explicitly instead.
 */
const PAGE_SIZE = 1000;

async function selectAllRows<T>(
  supabase: any,
  build: (query: any) => any
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(supabase).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Every billable user and the plan whose LIMITS apply to them (a trial runs on
 * Starter, see effectiveLimitPlan). One definition of "billable" for all the
 * background jobs:
 *   - a user with an entitled Stripe subscription row,
 *   - plus a user with an operator free-plan grant,
 *   - minus a suspended user, even one who is paying.
 */
async function loadBillableUserPlans(supabase: any, now = Date.now()) {
  const subscriptions = await selectAllRows<Record<string, any>>(supabase, (q) =>
    q
      .from('subscriptions')
      .select('user_id, plan, status, trial_ends_at, current_period_start, current_period_end')
      .in('status', ['trialing', 'active', 'past_due'])
      .order('user_id', { ascending: true })
  );

  // Operator overrides: a free plan makes a user billable without a Stripe
  // row, and a suspension removes them even with one. Missing table = none.
  const overrides = await readAllLiveOverrides(supabase, now);

  const rowsByUser = new Map<string, Array<Record<string, any>>>();
  for (const row of subscriptions) {
    if (!row.user_id) continue;
    const list = rowsByUser.get(row.user_id) ?? [];
    list.push(row);
    rowsByUser.set(row.user_id, list);
  }

  const plans = new Map<string, BillingPlan>();
  for (const [userId, rows] of rowsByUser) {
    if (!rows.some((row) => isSubscriptionEntitled(row, now))) continue;
    plans.set(userId, limitPlanFor(rows, overrides.get(userId) ?? NO_OVERRIDES, now));
  }
  for (const [userId, live] of overrides) {
    if (live.grant && !plans.has(userId)) plans.set(userId, limitPlanFor([], live, now));
  }
  for (const [userId, live] of overrides) {
    if (live.suspended) plans.delete(userId);
  }
  return plans;
}

function limitPlanFor(rows: Array<Record<string, any>>, overrides: LiveAccessOverrides, now: number) {
  const access = applyAccessOverrides(subscriptionAccessFromRows(rows, now), overrides);
  // An unreadable plan on an entitled row must not unlock the biggest cap.
  return effectiveLimitPlan(access) ?? 'starter';
}

export async function getBillableBusinessIds(supabase: any) {
  const userIds = Array.from((await loadBillableUserPlans(supabase)).keys()).sort();
  if (userIds.length === 0) return [] as string[];

  // Chunk the IN list too: thousands of ids in one URL blows the request line.
  const businessIds: string[] = [];
  for (let index = 0; index < userIds.length; index += 200) {
    const chunk = userIds.slice(index, index + 200);
    const businesses = await selectAllRows<{ id: string }>(supabase, (q) =>
      q.from('businesses').select('id').in('user_id', chunk).order('id', { ascending: true })
    );
    businessIds.push(...businesses.map((item) => item.id));
  }
  return businessIds;
}

// ---------------------------------------------------------------------------
// Optimizer account cap per plan
// ---------------------------------------------------------------------------

/**
 * How many Google Ads accounts the AUTOMATIC background optimizer works on per
 * user. A trial counts as Starter (effectiveLimitPlan). This bounds model spend
 * only: it never changes what a user can link, switch to, or see.
 */
export const OPTIMIZER_ACCOUNTS_PER_PLAN: Record<BillingPlan, number> = {
  starter: 1,
  growth: 3,
  pro: 25,
};

export type OptimizerCapBusiness = {
  id: string;
  user_id: string;
  selected_google_ads_customer_id?: string | null;
};

export type OptimizerCapAccount = {
  id: string;
  business_id: string;
  customer_id: string;
  /** google_ads_accounts has no created_at; linked_at is set once, on first link. */
  linked_at?: string | null;
};

const digitsOnly = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');

function linkedAtMs(value: string | null | undefined) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Pure selection of the accounts the optimizer may process.
 *
 * Per USER (not per business): rank that user's accounts with the account their
 * business has selected first, then the oldest link first, then id for a stable
 * tie-break, and keep the first N for their plan. The same user therefore always
 * gets the same accounts, and the one they actually look at wins.
 *
 * `accounts` must already be active, non-manager accounts of the billable
 * users' businesses. Accounts whose business or user is unknown are ignored
 * (not counted as skipped): they are not billable.
 */
export function selectOptimizerAccountIds({
  planByUser,
  businesses,
  accounts,
}: {
  planByUser: ReadonlyMap<string, BillingPlan>;
  businesses: OptimizerCapBusiness[];
  accounts: OptimizerCapAccount[];
}) {
  const businessById = new Map(businesses.map((business) => [business.id, business]));
  const byUser = new Map<string, Array<OptimizerCapAccount & { selected: boolean }>>();

  for (const account of accounts) {
    const business = businessById.get(account.business_id);
    if (!business || !planByUser.has(business.user_id)) continue;
    const selectedId = digitsOnly(business.selected_google_ads_customer_id);
    const list = byUser.get(business.user_id) ?? [];
    list.push({
      ...account,
      selected: Boolean(selectedId) && digitsOnly(account.customer_id) === selectedId,
    });
    byUser.set(business.user_id, list);
  }

  const allowedAccountIds: string[] = [];
  let skippedOverPlanCap = 0;
  for (const [userId, list] of byUser) {
    const cap = OPTIMIZER_ACCOUNTS_PER_PLAN[planByUser.get(userId) ?? 'starter'];
    list.sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1;
      const linkedA = linkedAtMs(a.linked_at);
      const linkedB = linkedAtMs(b.linked_at);
      if (linkedA !== linkedB) return linkedA < linkedB ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    list.slice(0, cap).forEach((account) => allowedAccountIds.push(account.id));
    skippedOverPlanCap += Math.max(0, list.length - cap);
  }
  return { allowedAccountIds, skippedOverPlanCap };
}

/**
 * The account ids the optimize cron may process for the billable users, and how
 * many it left out because they are over the plan cap. Reads and chunks IN
 * lists like getBillableBusinessIds. Throws on a read error: the cron treats
 * that like a failed subscription lookup instead of running uncapped.
 */
export async function getOptimizerAllowedAccountIds(supabase: any) {
  const planByUser = await loadBillableUserPlans(supabase);
  const userIds = Array.from(planByUser.keys()).sort();
  if (userIds.length === 0) return { allowedAccountIds: [] as string[], skippedOverPlanCap: 0 };

  const businesses: OptimizerCapBusiness[] = [];
  for (let index = 0; index < userIds.length; index += 200) {
    const chunk = userIds.slice(index, index + 200);
    businesses.push(
      ...(await selectAllRows<OptimizerCapBusiness>(supabase, (q) =>
        q
          .from('businesses')
          .select('id, user_id, selected_google_ads_customer_id')
          .in('user_id', chunk)
          .order('id', { ascending: true })
      ))
    );
  }

  const accounts: OptimizerCapAccount[] = [];
  for (let index = 0; index < businesses.length; index += 200) {
    const chunk = businesses.slice(index, index + 200).map((business) => business.id);
    accounts.push(
      ...(await selectAllRows<OptimizerCapAccount>(supabase, (q) =>
        q
          .from('google_ads_accounts')
          .select('id, business_id, customer_id, linked_at')
          .eq('status', 'active')
          .not('is_manager', 'is', true)
          .in('business_id', chunk)
          .order('id', { ascending: true })
      ))
    );
  }

  return selectOptimizerAccountIds({ planByUser, businesses, accounts });
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
