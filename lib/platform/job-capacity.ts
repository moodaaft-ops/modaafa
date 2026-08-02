const RUNS_PER_DAY = 24;

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/** Accounts selected by one hourly sync invocation. */
export const SYNC_ACCOUNT_LIMIT = boundedInteger(
  process.env.CRON_SYNC_ACCOUNT_LIMIT,
  100,
  1,
  200
);

/** Concurrent Google Ads sync chains; deliberately below typical API QPS. */
export const SYNC_ACCOUNT_CONCURRENCY = boundedInteger(
  process.env.CRON_SYNC_CONCURRENCY,
  4,
  1,
  8
);

/** Accounts selected by one hourly AI optimization invocation. */
export const OPTIMIZE_ACCOUNT_LIMIT = boundedInteger(
  process.env.CRON_OPTIMIZE_ACCOUNT_LIMIT,
  60,
  1,
  100
);

/** Concurrent AI/Google Ads chains, kept conservative for the 300s budget. */
export const OPTIMIZE_ACCOUNT_CONCURRENCY = boundedInteger(
  process.env.CRON_OPTIMIZE_CONCURRENCY,
  3,
  1,
  5
);

export function evaluateJobCapacity(activeBillableAccounts: number) {
  const accounts = Math.max(0, Math.floor(activeBillableAccounts));
  const syncDailyCapacity = SYNC_ACCOUNT_LIMIT * RUNS_PER_DAY;
  const optimizeDailyCapacity = OPTIMIZE_ACCOUNT_LIMIT * RUNS_PER_DAY;
  const dailyCapacity = Math.min(syncDailyCapacity, optimizeDailyCapacity);

  return {
    ok: accounts <= dailyCapacity,
    active_billable_accounts: accounts,
    runs_per_day: RUNS_PER_DAY,
    sync_batch_limit: SYNC_ACCOUNT_LIMIT,
    sync_concurrency: SYNC_ACCOUNT_CONCURRENCY,
    sync_daily_capacity: syncDailyCapacity,
    optimize_batch_limit: OPTIMIZE_ACCOUNT_LIMIT,
    optimize_concurrency: OPTIMIZE_ACCOUNT_CONCURRENCY,
    optimize_daily_capacity: optimizeDailyCapacity,
    estimated_full_cycle_hours:
      accounts === 0 ? 0 : Math.ceil((accounts / dailyCapacity) * 24 * 10) / 10,
  };
}
