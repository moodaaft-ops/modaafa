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

export async function getBillableBusinessIds(supabase: any) {
  const now = new Date().toISOString();
  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('user_id, status, trial_ends_at, current_period_end')
    .in('status', ['trialing', 'active']);
  if (subscriptionError) throw subscriptionError;

  const userIds = Array.from(
    new Set(
      (subscriptions ?? [])
        .filter((item: any) => {
          if (item.status === 'trialing') return !item.trial_ends_at || item.trial_ends_at > now;
          return !item.current_period_end || item.current_period_end > now;
        })
        .map((item: any) => item.user_id)
        .filter(Boolean)
    )
  );
  if (userIds.length === 0) return [] as string[];

  const { data: businesses, error: businessError } = await supabase
    .from('businesses')
    .select('id')
    .in('user_id', userIds);
  if (businessError) throw businessError;
  return (businesses ?? []).map((item: any) => item.id as string);
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
