/**
 * Bounded-concurrency map.
 *
 * `Promise.all(items.map(fn))` over a discovered Google Ads account list
 * opens one chain per account. On an agency MCC that is hundreds of
 * simultaneous sockets to googleads.googleapis.com, which trips the
 * per-developer-token QPS limit and comes back as RESOURCE_EXHAUSTED for
 * the accounts that lost the race — silently linking them without names.
 *
 * Results keep the input order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const size = items.length;
  if (size === 0) return [];

  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, size));
  const results = new Array<R>(size);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= size) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Wall-clock budget for serverless loops. Vercel kills the function at
 * `maxDuration` with no chance to record progress, so long batch jobs stop
 * themselves early and leave the remainder for the next run.
 */
export function createTimeBudget(totalMs: number) {
  const startedAt = Date.now();
  return {
    elapsed: () => Date.now() - startedAt,
    remaining: () => Math.max(0, totalMs - (Date.now() - startedAt)),
    expired: (reserveMs = 0) => Date.now() - startedAt >= totalMs - reserveMs,
  };
}
