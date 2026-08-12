const RUNS_PER_DAY = 24;
const RUN_BUDGET_SECONDS = 260;

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

/** Conservative observed-time assumptions used by readiness capacity. */
export const SYNC_ESTIMATED_ACCOUNT_SECONDS = boundedInteger(
  process.env.CRON_SYNC_ESTIMATED_ACCOUNT_SECONDS,
  12,
  1,
  RUN_BUDGET_SECONDS
);

export const OPTIMIZE_ESTIMATED_ACCOUNT_SECONDS = boundedInteger(
  process.env.CRON_OPTIMIZE_ESTIMATED_ACCOUNT_SECONDS,
  45,
  1,
  RUN_BUDGET_SECONDS
);

type JobCapacityOptions = {
  runsPerDay?: number;
  runBudgetSeconds?: number;
  syncBatchLimit?: number;
  syncConcurrency?: number;
  syncEstimatedAccountSeconds?: number;
  optimizeBatchLimit?: number;
  optimizeConcurrency?: number;
  optimizeEstimatedAccountSeconds?: number;
};

export function evaluateJobCapacity(
  activeBillableAccounts: number,
  options: JobCapacityOptions = {}
) {
  const accounts = Math.max(0, Math.floor(activeBillableAccounts));
  const runsPerDay = options.runsPerDay ?? RUNS_PER_DAY;
  const runBudgetSeconds = options.runBudgetSeconds ?? RUN_BUDGET_SECONDS;
  const syncBatchLimit = options.syncBatchLimit ?? SYNC_ACCOUNT_LIMIT;
  const syncConcurrency = options.syncConcurrency ?? SYNC_ACCOUNT_CONCURRENCY;
  const syncEstimatedSeconds =
    options.syncEstimatedAccountSeconds ?? SYNC_ESTIMATED_ACCOUNT_SECONDS;
  const optimizeBatchLimit = options.optimizeBatchLimit ?? OPTIMIZE_ACCOUNT_LIMIT;
  const optimizeConcurrency = options.optimizeConcurrency ?? OPTIMIZE_ACCOUNT_CONCURRENCY;
  const optimizeEstimatedSeconds =
    options.optimizeEstimatedAccountSeconds ?? OPTIMIZE_ESTIMATED_ACCOUNT_SECONDS;
  const syncRunCapacity = Math.min(
    syncBatchLimit,
    Math.floor(runBudgetSeconds / syncEstimatedSeconds) * syncConcurrency
  );
  const optimizeRunCapacity = Math.min(
    optimizeBatchLimit,
    Math.floor(runBudgetSeconds / optimizeEstimatedSeconds) * optimizeConcurrency
  );
  const syncDailyCapacity = syncRunCapacity * runsPerDay;
  const optimizeDailyCapacity = optimizeRunCapacity * runsPerDay;
  const dailyCapacity = Math.min(syncDailyCapacity, optimizeDailyCapacity);

  return {
    ok: accounts <= dailyCapacity,
    active_billable_accounts: accounts,
    runs_per_day: runsPerDay,
    run_budget_seconds: runBudgetSeconds,
    sync_batch_limit: syncBatchLimit,
    sync_concurrency: syncConcurrency,
    sync_estimated_account_seconds: syncEstimatedSeconds,
    sync_run_capacity: syncRunCapacity,
    sync_daily_capacity: syncDailyCapacity,
    optimize_batch_limit: optimizeBatchLimit,
    optimize_concurrency: optimizeConcurrency,
    optimize_estimated_account_seconds: optimizeEstimatedSeconds,
    optimize_run_capacity: optimizeRunCapacity,
    optimize_daily_capacity: optimizeDailyCapacity,
    estimated_full_cycle_hours:
      accounts === 0
        ? 0
        : dailyCapacity === 0
          ? null
          : Math.ceil((accounts / dailyCapacity) * 24 * 10) / 10,
  };
}
