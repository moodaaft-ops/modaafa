/**
 * «التغييرات الأخيرة» on /home: the changes Modaafa made on the selected ad
 * account that can still be undone. It is the one place the simple shell shows
 * the undo, so the promise «تقدر ترجعه خلال 30 يوم» always has a button.
 *
 * The undo itself is NOT written here. Each row posts to the same guarded route
 * the approvals screen uses (POST /api/actions/rollback), which re-checks the
 * owner, the 30 days, the claim and the account scope before anything reaches
 * Google Ads. This file only decides which rows are worth a button.
 */
import { operationLabelAr } from '@/lib/ai/operation-labels';
import { rollbackResourcesScoped } from '@/lib/ai/rollback-scope';

/** The window the rollback route enforces (app/api/actions/rollback/route.ts). */
export const ROLLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How many rows /home lists before it points to the full log. */
export const RECENT_CHANGES_SHOWN = 5;
/** Rows read per request: enough to still fill the list after the checks below drop some. */
const READ_LIMIT = 20;
const TEXT_LIMIT = 160;

export type RecentChangeRow = {
  id?: string | null;
  account_id?: string | null;
  action_type?: string | null;
  description_ar?: string | null;
  created_at?: string | null;
  reverted_at?: string | null;
  rollback_status?: string | null;
  rollback_payload?: Record<string, any> | null;
};

export type RecentChange = {
  id: string;
  /** What changed, in the words stored when it ran. */
  text: string;
  createdAt: string;
};

export type RecentChanges = { items: RecentChange[]; more: boolean };

const NONE: RecentChanges = { items: [], more: false };

/** The same test the approvals screen uses to show its undo button, plus the account scope the route enforces. */
export function isUndoable(row: RecentChangeRow, customerId: string, now: number = Date.now()): boolean {
  const rollback = row.rollback_payload;
  if (!rollback || typeof rollback !== 'object' || rollback.reversible !== true) return false;
  if (row.reverted_at || row.rollback_status === 'executing') return false;
  const created = row.created_at ? new Date(row.created_at).getTime() : NaN;
  if (!Number.isFinite(created) || now - created > ROLLBACK_WINDOW_MS) return false;
  // A payload naming a resource outside this account would be refused by the
  // route; do not offer a button that can only fail.
  return rollbackResourcesScoped(rollback, customerId);
}

function describe(row: RecentChangeRow) {
  const text = String(row.description_ar ?? '').trim() || operationLabelAr(row.action_type) || 'تغيير على حسابك';
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT).trimEnd()}...` : text;
}

/**
 * Newest first, only rows of THIS account, only what can still be undone,
 * at most `limit` of them. `more` is true when there are further undoable
 * rows behind the ones listed (the page then links to the full log).
 */
export function pickRecentChanges(
  rows: RecentChangeRow[] | null | undefined,
  args: { accountId: string; customerId: string; now?: number; limit?: number }
): RecentChanges {
  const now = args.now ?? Date.now();
  const limit = args.limit ?? RECENT_CHANGES_SHOWN;
  const eligible = (rows ?? [])
    .filter((row) => row && row.id && row.account_id === args.accountId && isUndoable(row, args.customerId, now))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return {
    items: eligible.slice(0, limit).map((row) => ({
      id: String(row.id),
      text: describe(row),
      createdAt: String(row.created_at),
    })),
    more: eligible.length > limit,
  };
}

/**
 * Reads the selected account's reversible changes from the last 30 days through
 * the caller's own RLS client, scoped by `account_id` exactly like the
 * approvals screen. A read error is "nothing to list", never a broken home.
 */
export async function loadRecentChanges(
  supabase: any,
  args: { accountId: string; customerId: string; now?: number }
): Promise<RecentChanges> {
  const now = args.now ?? Date.now();
  try {
    const { data, error } = await supabase
      .from('ai_actions')
      .select('id, account_id, action_type, description_ar, created_at, reverted_at, rollback_status, rollback_payload')
      .eq('account_id', args.accountId)
      .eq('rollback_payload->>reversible', 'true')
      .is('reverted_at', null)
      .gte('created_at', new Date(now - ROLLBACK_WINDOW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(READ_LIMIT);
    if (error) return NONE;
    return pickRecentChanges(data as RecentChangeRow[], { ...args, now });
  } catch {
    return NONE;
  }
}
