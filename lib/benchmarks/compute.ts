/**
 * Sector benchmarks — the moat.
 *
 * No single media buyer has seen more accounts than the platform itself. This
 * module aggregates 30-day performance across ALL active accounts into
 * anonymous per-(sector, currency) medians, and both the audit and the
 * optimizer consume them: "your CPA is 1.8× your sector's median" is a
 * sentence no generic benchmark blog post can say honestly.
 *
 * Privacy model:
 * - Only aggregates are stored — never per-account numbers.
 * - A (sector, currency) row is only written when it covers >= 3 DISTINCT
 *   businesses, so no merchant can be singled out (and one agency with many
 *   accounts under a single business cannot dominate or de-anonymize).
 * - Medians, not means: one whale account cannot drag the benchmark.
 */

export type AccountAggregate = {
  business_id: string;
  sector: string;
  currency_code: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversion_value: number;
};

export type SectorBenchmarkRow = {
  sector: string;
  currency_code: string;
  window_days: number;
  businesses_count: number;
  accounts_count: number;
  median_cpa: number | null;
  median_ctr: number | null;
  median_roas: number | null;
  median_cpc: number | null;
};

export const BENCHMARK_MIN_BUSINESSES = 3;
/** An account must show real 30d activity before it may shape a benchmark. */
const MIN_IMPRESSIONS = 500;
const REFRESH_THROTTLE_MS = 20 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

export function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Number(value.toFixed(4));
}

export function normalizeSector(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Collapse an account's cached 30d campaign metrics into one aggregate. */
export function sumCampaignMetrics30d(rows: Array<{ metrics_30d: any }>): {
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversion_value: number;
} {
  const totals = { cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 };
  for (const row of rows ?? []) {
    const metrics = row?.metrics_30d ?? {};
    totals.cost += Number(metrics.cost ?? 0);
    totals.clicks += Number(metrics.clicks ?? 0);
    totals.impressions += Number(metrics.impressions ?? 0);
    totals.conversions += Number(metrics.conversions ?? 0);
    totals.conversion_value += Number(metrics.conversion_value ?? 0);
  }
  return totals;
}

/** Group qualified business aggregates into benchmark rows (k >= 3 businesses). */
export function buildSectorBenchmarks(accounts: AccountAggregate[]): SectorBenchmarkRow[] {
  const groups = new Map<string, AccountAggregate[]>();
  for (const account of accounts) {
    if (!account.sector) continue;
    const key = `${account.sector}\u0000${account.currency_code}`;
    const group = groups.get(key) ?? [];
    group.push(account);
    groups.set(key, group);
  }

  const rows: SectorBenchmarkRow[] = [];
  for (const [key, group] of groups) {
    const [sector, currency_code] = key.split('\u0000');
    const byBusiness = new Map<string, AccountAggregate>();
    for (const account of group) {
      const current = byBusiness.get(account.business_id);
      if (current) {
        current.cost += account.cost;
        current.clicks += account.clicks;
        current.impressions += account.impressions;
        current.conversions += account.conversions;
        current.conversion_value += account.conversion_value;
      } else {
        byBusiness.set(account.business_id, { ...account });
      }
    }

    const businesses = Array.from(byBusiness.values()).filter(
      (business) => business.impressions >= MIN_IMPRESSIONS && business.cost > 0
    );
    if (businesses.length < BENCHMARK_MIN_BUSINESSES) continue;

    const converting = businesses.filter((business) => business.conversions > 0);
    const participatingBusinessIds = new Set(businesses.map((business) => business.business_id));
    rows.push({
      sector,
      currency_code,
      window_days: 30,
      businesses_count: businesses.length,
      accounts_count: group.filter((account) => participatingBusinessIds.has(account.business_id)).length,
      median_cpa: median(converting.map((business) => business.cost / business.conversions)),
      median_ctr: median(
        businesses
          .filter((business) => business.impressions > 0)
          .map((business) => business.clicks / business.impressions)
      ),
      median_roas: median(converting.map((business) => business.conversion_value / business.cost)),
      median_cpc: median(
        businesses
          .filter((business) => business.clicks > 0)
          .map((business) => business.cost / business.clicks)
      ),
    });
  }
  return rows;
}

async function selectAllRows<T>(supabase: any, build: (query: any) => any): Promise<T[]> {
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
 * Recompute all sector benchmarks from the campaign cache. Service-role only.
 * Throttled: skips when the newest row is fresher than 20h, so the nightly
 * cron recomputes once per day no matter how many times it fires.
 */
export async function refreshSectorBenchmarks(supabase: any): Promise<{ refreshed: boolean; rows: number }> {
  const { data: newest } = await supabase
    .from('sector_benchmarks')
    .select('computed_at')
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (newest?.computed_at && Date.now() - new Date(newest.computed_at).getTime() < REFRESH_THROTTLE_MS) {
    return { refreshed: false, rows: 0 };
  }

  const accounts = await selectAllRows<{ id: string; business_id: string; currency_code: string | null }>(
    supabase,
    (q) =>
      q
        .from('google_ads_accounts')
        .select('id, business_id, currency_code')
        .eq('status', 'active')
        .not('is_manager', 'is', true)
        .order('id', { ascending: true })
  );
  if (accounts.length === 0) return { refreshed: true, rows: 0 };

  const businesses = await selectAllRows<{ id: string; sector: string | null }>(supabase, (q) =>
    q.from('businesses').select('id, sector').order('id', { ascending: true })
  );
  const sectorByBusiness = new Map(businesses.map((row) => [row.id, normalizeSector(row.sector)]));

  const campaignRows = await selectAllRows<{ account_id: string; metrics_30d: any }>(supabase, (q) =>
    q.from('campaigns_cache').select('account_id, metrics_30d').order('id', { ascending: true })
  );
  const campaignsByAccount = new Map<string, Array<{ metrics_30d: any }>>();
  for (const row of campaignRows) {
    const list = campaignsByAccount.get(row.account_id) ?? [];
    list.push(row);
    campaignsByAccount.set(row.account_id, list);
  }

  const aggregates: AccountAggregate[] = [];
  for (const account of accounts) {
    const sector = sectorByBusiness.get(account.business_id) ?? null;
    if (!sector) continue;
    const totals = sumCampaignMetrics30d(campaignsByAccount.get(account.id) ?? []);
    aggregates.push({
      business_id: account.business_id,
      sector,
      currency_code: (account.currency_code ?? 'SAR').toUpperCase(),
      ...totals,
    });
  }

  const benchmarkRows = buildSectorBenchmarks(aggregates);
  const computedAt = new Date().toISOString();

  // Replace the 30-day snapshot rather than only upserting it. Otherwise a
  // sector that drops below the k-anonymity threshold would leave yesterday's
  // row readable forever. Deleting first favours privacy over availability: a
  // failed refresh produces no benchmark, never a stale under-threshold one.
  const { error: deleteError } = await supabase
    .from('sector_benchmarks')
    .delete()
    .eq('window_days', 30);
  if (deleteError) throw deleteError;

  if (benchmarkRows.length > 0) {
    const { error: insertError } = await supabase
      .from('sector_benchmarks')
      .upsert(
        benchmarkRows.map((row) => ({ ...row, computed_at: computedAt })),
        { onConflict: 'sector,currency_code,window_days' }
      );
    if (insertError) throw insertError;
  }

  return { refreshed: true, rows: benchmarkRows.length };
}

/** Read one benchmark row; usable with the user-scoped client (SELECT policy). */
export async function getSectorBenchmark(
  supabase: any,
  sector: string | null | undefined,
  currencyCode: string | null | undefined
): Promise<SectorBenchmarkRow | null> {
  const normalizedSector = normalizeSector(sector);
  if (!normalizedSector) return null;
  const { data, error } = await supabase
    .from('sector_benchmarks')
    .select('sector, currency_code, window_days, businesses_count, accounts_count, median_cpa, median_ctr, median_roas, median_cpc')
    .eq('sector', normalizedSector)
    .eq('currency_code', (currencyCode ?? 'SAR').toUpperCase())
    .eq('window_days', 30)
    .maybeSingle();
  if (error) throw error;
  return (data as SectorBenchmarkRow | null) ?? null;
}
