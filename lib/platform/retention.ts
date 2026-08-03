/**
 * Retention for operational tables that otherwise grow forever.
 *
 * `oauth_states` already gets opportunistic cleanup where it is written, but
 * nothing ever deleted from `rate_limit_windows` (one row per rate-limit key —
 * and the login limiter keys on client IP, so an unauthenticated caller mints
 * rows), `processed_webhook_events` (one row per Stripe delivery, forever) or
 * `job_runs` (one row per hourly run of each job, forever).
 *
 * Piggybacked on the hourly sync cron. Strictly best-effort: a retention
 * failure must never fail the job that carried it.
 */

type RetentionRule = {
  table: string;
  column: string;
  days: number;
  apply?: (query: any) => any;
};

const RULES: RetentionRule[] = [
  // Longest rate-limit window in the app is 1h; a week of slack is generous.
  { table: 'rate_limit_windows', column: 'updated_at', days: 7 },
  // Single-use states expire after 60 minutes; keep a day for debugging.
  { table: 'oauth_states', column: 'expires_at', days: 1 },
  // Stripe's own retry horizon is days; 60 days keeps a useful audit window.
  // Only COMPLETED events are pruned — a failed row documents an incident.
  {
    table: 'processed_webhook_events',
    column: 'last_attempt_at',
    days: 60,
    apply: (query) => query.eq('status', 'completed'),
  },
  // Operational history; `running` rows are never touched.
  {
    table: 'job_runs',
    column: 'started_at',
    days: 90,
    apply: (query) => query.neq('status', 'running'),
  },
];

export async function pruneOperationalTables(supabase: any) {
  const pruned: string[] = [];
  const failures: string[] = [];

  for (const rule of RULES) {
    try {
      const cutoff = new Date(Date.now() - rule.days * 24 * 60 * 60 * 1000).toISOString();
      let query = supabase.from(rule.table).delete().lt(rule.column, cutoff);
      if (rule.apply) query = rule.apply(query);
      const { error } = await query;
      if (error) throw error;
      pruned.push(rule.table);
    } catch (error) {
      console.error('Retention prune failed', { table: rule.table, error });
      failures.push(rule.table);
    }
  }

  return { pruned, failures };
}
