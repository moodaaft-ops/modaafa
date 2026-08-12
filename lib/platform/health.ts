export type JobRunHealthRow = {
  job_name?: string | null;
  status?: string | null;
  started_at?: string | null;
  processed?: number | null;
  error_count?: number | null;
};

export function extractEmailDomain(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;

  const address = normalized.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/)?.[1] ?? normalized;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;

  const domain = address.slice(at + 1).replace(/[>\s]+$/g, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : null;
}

export function evaluateOperationalJob(
  latest: JobRunHealthRow | null,
  {
    jobName,
    maxAgeHours,
    now = Date.now(),
    maxErrorRatio = 0.1,
  }: {
    jobName: string;
    maxAgeHours: number;
    now?: number;
    maxErrorRatio?: number;
  }
) {
  const startedAt = latest?.started_at ? Date.parse(latest.started_at) : Number.NaN;
  const ageHours = Number.isFinite(startedAt)
    ? Math.round(((now - startedAt) / 3_600_000) * 10) / 10
    : null;
  const processed = Math.max(0, Number(latest?.processed ?? 0));
  const errors = Math.max(0, Number(latest?.error_count ?? 0));
  const attempted = processed + errors;
  const errorRatio = attempted > 0 ? errors / attempted : 0;
  const status = latest?.status ?? 'missing';
  const statusOk = status === 'success' || status === 'partial';

  return {
    job_name: jobName,
    ok:
      Boolean(latest) &&
      statusOk &&
      ageHours !== null &&
      ageHours >= 0 &&
      ageHours <= maxAgeHours &&
      errorRatio <= maxErrorRatio,
    latest_status: status,
    age_hours: ageHours,
    max_age_hours: maxAgeHours,
    processed,
    error_count: errors,
    error_ratio: Math.round(errorRatio * 1000) / 1000,
    max_error_ratio: maxErrorRatio,
  };
}

export function evaluateWebhookLedger(
  rows: Array<{ status?: string | null; last_attempt_at?: string | null }>,
  now = Date.now(),
  staleProcessingMs = 10 * 60 * 1000
) {
  const failed = rows.filter((row) => row.status === 'failed').length;
  const staleProcessing = rows.filter((row) => {
    if (row.status !== 'processing' || !row.last_attempt_at) return false;
    const attemptedAt = Date.parse(row.last_attempt_at);
    return !Number.isFinite(attemptedAt) || now - attemptedAt > staleProcessingMs;
  }).length;

  return {
    ok: failed === 0 && staleProcessing === 0,
    inspected: rows.length,
    failed,
    stale_processing: staleProcessing,
    status: rows.length === 0 ? 'not_observed' : failed || staleProcessing ? 'attention_required' : 'healthy',
  };
}
