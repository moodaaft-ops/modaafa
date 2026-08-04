import { isSubscriptionEntitled } from '@/lib/billing/entitlements';

/**
 * A `running` row older than this is a corpse: maxDuration is 300s, so any
 * genuine invocation has finished (or been killed) well inside 10 minutes.
 */
const STALE_RUNNING_MS = 10 * 60 * 1000;

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

export async function getBillableBusinessIds(supabase: any) {
  const now = Date.now();
  const subscriptions = await selectAllRows<Record<string, any>>(supabase, (q) =>
    q
      .from('subscriptions')
      .select('user_id, status, trial_ends_at, current_period_end')
      .in('status', ['trialing', 'active', 'past_due'])
      .order('user_id', { ascending: true })
  );

  const userIds = Array.from(
    new Set(
      subscriptions
        .filter((item: any) => isSubscriptionEntitled(item, now))
        .map((item: any) => item.user_id)
        .filter(Boolean)
    )
  ) as string[];
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

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
