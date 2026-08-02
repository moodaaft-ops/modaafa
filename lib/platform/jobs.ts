import { isSubscriptionEntitled } from '@/lib/billing/entitlements';

export async function startJobRun(supabase: any, jobName: string) {
  const startedAt = new Date();
  const { data, error } = await supabase
    .from('job_runs')
    .insert({ job_name: jobName, status: 'running', started_at: startedAt.toISOString() })
    .select('id')
    .maybeSingle();

  if (error) console.error('Failed to record job start', { jobName, error });
  return { id: data?.id as string | undefined, startedAt };
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
