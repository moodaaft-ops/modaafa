/**
 * Operator access overrides (table account_access_overrides, migration
 * 20261012_operator_console.sql): a free plan granted outside Stripe, or a
 * suspended account.
 *
 * Reads are deliberately forgiving. Until the migration runs on production the
 * table does not exist, and a missing table must never take entitlements down
 * with it, so any read error is treated as "no override" and logged once.
 * Rows of an unexpected shape are ignored for the same reason.
 */

export type OverridePlan = 'starter' | 'growth' | 'pro';

export type AccessOverrideRow = {
  id?: string;
  user_id?: string;
  kind: 'suspension' | 'plan_grant';
  plan: OverridePlan | null;
  expires_at: string | null;
  created_at: string | null;
  revoked_at: string | null;
};

export type LiveAccessOverrides = {
  suspended: boolean;
  suspendedAt: string | null;
  grant: { plan: OverridePlan; expiresAt: string | null; grantedAt: string | null } | null;
};

export const NO_OVERRIDES: LiveAccessOverrides = { suspended: false, suspendedAt: null, grant: null };

const PLAN_RANK: Record<OverridePlan, number> = { starter: 1, growth: 2, pro: 3 };

export function isOverridePlan(value: unknown): value is OverridePlan {
  return value === 'starter' || value === 'growth' || value === 'pro';
}

/** Keep only well-formed override rows. */
export function normalizeOverrideRows(rows: unknown): AccessOverrideRow[] {
  if (!Array.isArray(rows)) return [];
  const out: AccessOverrideRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.kind !== 'suspension' && row.kind !== 'plan_grant') continue;
    if (row.kind === 'plan_grant' && !isOverridePlan(row.plan)) continue;
    out.push({
      id: typeof row.id === 'string' ? row.id : undefined,
      user_id: typeof row.user_id === 'string' ? row.user_id : undefined,
      kind: row.kind,
      plan: isOverridePlan(row.plan) ? row.plan : null,
      expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
      created_at: typeof row.created_at === 'string' ? row.created_at : null,
      revoked_at: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    });
  }
  return out;
}

export function isOverrideLive(row: AccessOverrideRow, now = Date.now()) {
  if (row.revoked_at) return false;
  if (row.expires_at) {
    const end = new Date(row.expires_at).getTime();
    if (!Number.isFinite(end) || end <= now) return false;
  }
  return true;
}

/** Reduce one user's rows to what is in force right now. */
export function summarizeOverrides(rows: unknown, now = Date.now()): LiveAccessOverrides {
  const live = normalizeOverrideRows(rows).filter((row) => isOverrideLive(row, now));
  const suspension = live.find((row) => row.kind === 'suspension') ?? null;
  const grants = live
    .filter((row) => row.kind === 'plan_grant' && row.plan)
    .sort((a, b) => PLAN_RANK[b.plan as OverridePlan] - PLAN_RANK[a.plan as OverridePlan]);
  const grant = grants[0] ?? null;
  return {
    suspended: Boolean(suspension),
    suspendedAt: suspension?.created_at ?? null,
    grant: grant
      ? { plan: grant.plan as OverridePlan, expiresAt: grant.expires_at, grantedAt: grant.created_at }
      : null,
  };
}

let warnedMissingTable = false;

/** Postgres "undefined table" or PostgREST "table not in schema cache". */
export function isMissingTableError(error: unknown) {
  const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  return code === '42P01' || code === 'PGRST205';
}

/**
 * A missing table (migration not run yet) is expected and logged once. Any
 * other error is logged every time: it means a suspension may not have been
 * applied to this request, and that must be visible in the logs.
 */
function reportReadError(context: string, error: unknown) {
  if (isMissingTableError(error)) {
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn(`${context}: account_access_overrides missing (migration not run); treating as none`);
    }
    return;
  }
  const detail = error && typeof error === 'object' ? { code: (error as any).code, message: (error as any).message } : error;
  console.error(`${context}: could not read account_access_overrides; treating as none`, detail);
}

/**
 * Read one user's overrides with whatever client the caller has. Pages pass
 * the customer's own session (RLS lets them read their own rows); jobs pass the
 * service role.
 */
export async function readAccessOverrides(supabase: any, userId: string, now = Date.now()) {
  try {
    const { data, error } = await supabase
      .from('account_access_overrides')
      .select('kind, plan, expires_at, created_at, revoked_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      reportReadError('Access overrides', error);
      return NO_OVERRIDES;
    }
    return summarizeOverrides(data, now);
  } catch (error) {
    reportReadError('Access overrides', error);
    return NO_OVERRIDES;
  }
}

const PAGE = 1000;

/**
 * All live overrides, keyed by user. Used by the background jobs (service role)
 * to add free-plan users to the billable set and drop suspended ones. Paged:
 * PostgREST returns at most 1000 rows per request, and a suspended user past
 * that row must still be dropped.
 */
export async function readAllLiveOverrides(admin: any, now = Date.now()) {
  const byUser = new Map<string, LiveAccessOverrides>();
  const grouped = new Map<string, AccessOverrideRow[]>();
  try {
    for (let page = 0; page < 100; page += 1) {
      const { data, error } = await admin
        .from('account_access_overrides')
        .select('id, user_id, kind, plan, expires_at, created_at, revoked_at')
        .is('revoked_at', null)
        .order('id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) {
        reportReadError('Access overrides for jobs', error);
        return byUser;
      }
      const rows = normalizeOverrideRows(data);
      for (const row of rows) {
        if (!row.user_id) continue;
        const list = grouped.get(row.user_id) ?? [];
        list.push(row);
        grouped.set(row.user_id, list);
      }
      if (!Array.isArray(data) || data.length < PAGE) break;
    }
    for (const [userId, rows] of grouped) byUser.set(userId, summarizeOverrides(rows, now));
  } catch (error) {
    reportReadError('Access overrides for jobs', error);
  }
  return byUser;
}
