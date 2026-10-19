/**
 * guard_findings: one row per (account, dedupe_key). A finding is OPEN while
 * the guard keeps seeing it and RESOLVED once a run that could read its source
 * no longer does. A repeat of an open finding only touches it, so nobody is
 * told twice; a resolved one that comes back is reopened and told again.
 */
import { CODE_SOURCE, type GuardCode, type GuardFinding, type GuardSource, type GuardSeverity } from './types';

export type StoredFinding = {
  id: string;
  account_id: string;
  code: GuardCode;
  dedupe_key: string;
  severity: GuardSeverity;
  status: 'open' | 'resolved' | 'dismissed';
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  notified_at: string | null;
  what_ar: string;
  step_ar: string;
  evidence: Record<string, unknown> | null;
  cause: Record<string, unknown> | null;
  escalation: 'none' | 'human';
  entity_name: string | null;
};

export type ReconcilePlan = {
  /** New keys and reopened ones: written whole, notified_at cleared. */
  upsert: GuardFinding[];
  /** Still true and already known: refresh the numbers, count the sighting. */
  touch: Array<{ id: string; seenCount: number; finding: GuardFinding }>;
  /** Open, no longer true, and its source was readable this run. */
  resolve: string[];
};

export function reconcile(
  existing: Pick<StoredFinding, 'id' | 'code' | 'dedupe_key' | 'status' | 'seen_count'>[],
  found: GuardFinding[],
  ok: Record<GuardSource, boolean>
): ReconcilePlan {
  const byKey = new Map(existing.map((row) => [row.dedupe_key, row]));
  const seen = new Set<string>();
  const plan: ReconcilePlan = { upsert: [], touch: [], resolve: [] };
  for (const finding of found) {
    if (seen.has(finding.dedupeKey)) continue;
    seen.add(finding.dedupeKey);
    const row = byKey.get(finding.dedupeKey);
    if (!row) plan.upsert.push(finding);
    else plan.touch.push({ id: row.id, seenCount: (row.seen_count ?? 1) + 1, finding });
  }
  for (const row of existing) {
    if (row.status !== 'open' || seen.has(row.dedupe_key)) continue;
    if (ok[CODE_SOURCE[row.code]]) plan.resolve.push(row.id);
  }
  return plan;
}

export interface GuardStore {
  loadExisting(accountId: string): Promise<StoredFinding[]>;
  apply(args: { accountId: string; businessId: string; plan: ReconcilePlan; now: Date }): Promise<void>;
  /** Open findings across these accounts that still need a message. */
  listNotifiable(accountIds: string[], now: Date): Promise<StoredFinding[]>;
  markNotified(ids: string[], now: Date): Promise<void>;
}

/** A finding first seen longer ago than this is no longer "this morning's news". */
export const NOTIFY_FRESH_MS = 48 * 3_600_000;
/** A critical finding still open this long after its message is said once more. */
export const CRITICAL_REMIND_MS = 7 * 86_400_000;

export function isNotifiable(row: StoredFinding, now: Date): boolean {
  if (row.status !== 'open' || row.severity === 'info') return false;
  if (row.notified_at === null) return now.getTime() - new Date(row.first_seen_at).getTime() <= NOTIFY_FRESH_MS;
  return row.severity === 'critical' && now.getTime() - new Date(row.notified_at).getTime() >= CRITICAL_REMIND_MS;
}

function rowFor(finding: GuardFinding, accountId: string, businessId: string, now: Date) {
  const at = now.toISOString();
  return {
    account_id: accountId,
    business_id: businessId,
    code: finding.code,
    severity: finding.severity,
    entity_type: finding.entityType,
    entity_id: finding.entityId,
    entity_name: finding.entityName,
    dedupe_key: finding.dedupeKey,
    what_ar: finding.whatAr,
    step_ar: finding.stepAr,
    evidence: finding.evidence,
    cause: finding.cause,
    escalation: finding.escalation,
    status: 'open',
    first_seen_at: at,
    last_seen_at: at,
    seen_count: 1,
    notified_at: null,
    resolved_at: null,
  };
}

const COLUMNS =
  'id, account_id, code, dedupe_key, severity, status, first_seen_at, last_seen_at, seen_count, notified_at, what_ar, step_ar, evidence, cause, escalation, entity_name';

export function createSupabaseGuardStore(supabase: any): GuardStore {
  return {
    async loadExisting(accountId) {
      const { data, error } = await supabase
        .from('guard_findings')
        .select(COLUMNS)
        .eq('account_id', accountId)
        .in('status', ['open', 'dismissed'])
        .limit(1000);
      if (error) throw new Error(`guard_findings read failed: ${error.message}`);
      return (data ?? []) as StoredFinding[];
    },

    async apply({ accountId, businessId, plan, now }) {
      if (plan.upsert.length > 0) {
        const { error } = await supabase
          .from('guard_findings')
          .upsert(
            plan.upsert.map((finding) => rowFor(finding, accountId, businessId, now)),
            { onConflict: 'account_id,dedupe_key' }
          );
        if (error) throw new Error(`guard_findings write failed: ${error.message}`);
      }
      for (const { id, seenCount, finding } of plan.touch) {
        const { error } = await supabase
          .from('guard_findings')
          .update({
            last_seen_at: now.toISOString(),
            seen_count: seenCount,
            severity: finding.severity,
            what_ar: finding.whatAr,
            step_ar: finding.stepAr,
            evidence: finding.evidence,
            cause: finding.cause,
            escalation: finding.escalation,
          })
          .eq('id', id);
        if (error) throw new Error(`guard_findings touch failed: ${error.message}`);
      }
      if (plan.resolve.length > 0) {
        const { error } = await supabase
          .from('guard_findings')
          .update({ status: 'resolved', resolved_at: now.toISOString() })
          .in('id', plan.resolve);
        if (error) throw new Error(`guard_findings resolve failed: ${error.message}`);
      }
    },

    async listNotifiable(accountIds, now) {
      if (accountIds.length === 0) return [];
      const { data, error } = await supabase
        .from('guard_findings')
        .select(COLUMNS)
        .in('account_id', accountIds)
        .eq('status', 'open')
        .neq('severity', 'info')
        .order('first_seen_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(`guard_findings notifiable read failed: ${error.message}`);
      return ((data ?? []) as StoredFinding[]).filter((row) => isNotifiable(row, now));
    },

    async markNotified(ids, now) {
      if (ids.length === 0) return;
      const { error } = await supabase.from('guard_findings').update({ notified_at: now.toISOString() }).in('id', ids);
      if (error) throw new Error(`guard_findings notified write failed: ${error.message}`);
    },
  };
}
