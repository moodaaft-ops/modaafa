/**
 * Loads what /operations/costs shows. Server only, service role.
 *
 * The ledger is read for the last 31 days (the 30 day window plus the first day
 * of a 31 day month) in pages of 1000. A page cap turns into a visible notice
 * rather than a silently low number. Volumes today are a few hundred rows a
 * day; if they ever pass about 1,500 a day the right move is a daily rollup in
 * the database, not a bigger cap here.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { DAY_MS, type OptimizeRunRow, type UsageRow } from '@/lib/platform/cost-insights';

const PAGE = 1000;
const MAX_PAGES = 40;
const WINDOW_DAYS = 31;
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

export type CostDataset = {
  rows: UsageRow[];
  runs: OptimizeRunRow[];
  /** Active, non-manager Google Ads accounts. Null when the count failed. */
  activeAccounts: number | null;
  /** user id -> email, for the heaviest spenders only. */
  emails: Map<string, string>;
  /** True when the llm_usage table does not exist yet. */
  ledgerMissing: boolean;
  /** True when the ledger read stopped at the page cap. */
  ledgerTruncated: boolean;
};

export async function loadCostDataset(now = Date.now()): Promise<CostDataset> {
  const admin = createAdminClient();
  const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();

  const rows: UsageRow[] = [];
  let ledgerMissing = false;
  let ledgerTruncated = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await admin
      .from('llm_usage')
      .select('created_at, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, priced')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (MISSING_TABLE_CODES.has(String((error as { code?: string }).code ?? ''))) {
        ledgerMissing = true;
        ledgerTruncated = false;
        break;
      }
      assertSupabaseRead(error, 'costs: load llm_usage');
    }
    const chunk = (data ?? []) as UsageRow[];
    rows.push(...chunk);
    if (chunk.length < PAGE) {
      ledgerTruncated = false;
      break;
    }
  }

  const runs: OptimizeRunRow[] = [];
  const runsResult = await admin
    .from('job_runs')
    .select('started_at, status, details')
    .eq('job_name', 'optimize')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1000);
  if (runsResult.error) {
    assertSupabaseRead(runsResult.error, 'costs: load job_runs');
  } else {
    runs.push(...((runsResult.data ?? []) as OptimizeRunRow[]));
  }

  // Informational: a failed count only hides one line, so it never blocks the page.
  const accountCount = await admin
    .from('google_ads_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('is_manager', 'is', true);
  const activeAccounts = accountCount.error ? null : (accountCount.count ?? 0);

  return { rows, runs, activeAccounts, emails: new Map(), ledgerMissing, ledgerTruncated };
}

/** Emails for the given users, read after the report decides who the top spenders are. */
export async function loadEmails(userIds: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return emails;
  const admin = createAdminClient();
  const { data, error } = await admin.from('users').select('id, email').in('id', ids);
  if (error) {
    console.error('costs: user emails unavailable', error.message);
    return emails;
  }
  for (const row of (data ?? []) as Array<{ id: string; email: string | null }>) {
    if (row.email) emails.set(row.id, row.email);
  }
  return emails;
}
