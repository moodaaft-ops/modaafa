import type { GuardFacts, GuardItem } from '@/lib/lifecycle/types';
import type { StoredFinding } from './persist';

const RANK = { critical: 0, high: 1, medium: 2, info: 3 } as const;

/** What a notifiable row says in the mail. Pure: stored fields in, facts out. */
export function guardFactsFrom(rows: Array<StoredFinding & { account_name?: string | null }>, multiAccount: boolean): GuardFacts | null {
  const ordered = rows
    .filter((row) => row.severity !== 'info')
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.first_seen_at.localeCompare(b.first_seen_at));
  if (ordered.length === 0) return null;
  const items: GuardItem[] = ordered.map((row) => {
    const cause = row.cause as { code?: string; labelAr?: string } | null;
    return {
      severity: row.severity as GuardItem['severity'],
      whatAr: row.what_ar,
      stepAr: row.step_ar,
      // "unknown" is not a cause worth printing.
      causeAr: cause && cause.code !== 'unknown' && cause.labelAr ? cause.labelAr : null,
      accountName: multiAccount ? row.account_name ?? null : null,
    };
  });
  return {
    items,
    hasCritical: items.some((item) => item.severity === 'critical'),
    escalate: ordered.some((row) => row.escalation === 'human'),
  };
}
