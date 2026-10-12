export type LlmUsageRow = {
  user_id: string | null;
  feature: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
  priced: boolean | null;
};

export type LlmUsageGroup = {
  userId: string | null;
  feature: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unpricedCalls: number;
};

export type LlmUsageSummary = {
  totals: Omit<LlmUsageGroup, 'userId' | 'feature'>;
  rows: LlmUsageGroup[];
};

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Groups ledger rows by (user, feature) and returns them most expensive first. */
export function summarizeLlmUsage(rows: LlmUsageRow[]): LlmUsageSummary {
  const groups = new Map<string, LlmUsageGroup>();
  const totals = {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unpricedCalls: 0,
  };

  for (const row of rows) {
    const key = `${row.user_id ?? ''}\u0000${row.feature}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        userId: row.user_id ?? null,
        feature: row.feature,
        calls: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        unpricedCalls: 0,
      };
      groups.set(key, group);
    }
    for (const target of [group, totals]) {
      target.calls += 1;
      target.costUsd += num(row.cost_usd);
      target.inputTokens += num(row.input_tokens);
      target.outputTokens += num(row.output_tokens);
      target.cacheReadTokens += num(row.cache_read_tokens);
      target.cacheWriteTokens += num(row.cache_write_tokens);
      if (row.priced === false) target.unpricedCalls += 1;
    }
  }

  const list = Array.from(groups.values())
    .map((group) => ({ ...group, costUsd: round6(group.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  return { totals: { ...totals, costUsd: round6(totals.costUsd) }, rows: list };
}
