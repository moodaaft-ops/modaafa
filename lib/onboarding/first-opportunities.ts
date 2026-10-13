/**
 * Picks and labels the first recommendations a new user sees after the
 * automatic first audit. Pure, so the ordering and wording are testable.
 */

export type OpportunityRow = {
  id: string;
  title: string;
  severity?: string | null;
  expected_impact?: { metric?: string | null; delta_sar_per_month?: number | string | null } | null;
};

const SEVERITY_RANK: Record<string, number> = { critical: 0, medium: 1, growth: 2 };

export function monthlyImpact(row: OpportunityRow) {
  const value = Number(row.expected_impact?.delta_sar_per_month ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The glossary names the impact explicitly: a cost metric is a saving,
 * anything else is an increase. No label when there is no number to show.
 */
export function impactLabel(row: OpportunityRow): string | null {
  if (monthlyImpact(row) <= 0) return null;
  return row.expected_impact?.metric === 'cost' ? 'توفير متوقع شهرياً' : 'زيادة متوقعة شهرياً';
}

export function pickFirstOpportunities<T extends OpportunityRow>(rows: T[], limit = 3): T[] {
  return [...rows]
    .sort((a, b) => {
      const severity = (SEVERITY_RANK[a.severity ?? ''] ?? 3) - (SEVERITY_RANK[b.severity ?? ''] ?? 3);
      if (severity !== 0) return severity;
      return monthlyImpact(b) - monthlyImpact(a);
    })
    .slice(0, limit);
}

export type FirstFinding = {
  id: string;
  title: string;
  severity: string | null;
  impactLabel: string | null;
  impactAmount: number;
};

/**
 * The top opportunities as the setup screen receives them. That state is sent
 * whole to the browser, so for someone without access (`open` false) the
 * amounts stay out of it: «خطتك جاهزة» opens only the first decision, and the
 * rest are titles.
 */
export function firstFindings(rows: OpportunityRow[], open: boolean, limit = 3): FirstFinding[] {
  return pickFirstOpportunities(rows, limit).map((rec) => ({
    id: rec.id,
    title: rec.title,
    severity: rec.severity ?? null,
    impactLabel: open ? impactLabel(rec) : null,
    impactAmount: open ? monthlyImpact(rec) : 0,
  }));
}

/** Arabic count of recommendations with the right plural form. */
export function recommendationsCountLabel(count: number) {
  if (count <= 0) return 'لا توجد توصيات';
  if (count === 1) return 'توصية واحدة';
  if (count === 2) return 'توصيتان';
  const lastTwo = count % 100;
  if (lastTwo >= 3 && lastTwo <= 10) return `${count} توصيات`;
  if (lastTwo === 0 || lastTwo === 1 || lastTwo === 2) return `${count} توصية`;
  return `${count} توصية`;
}

/** sessionStorage key so a refresh mid-audit does not start (and bill) a second one. */
export function firstAuditGuardKey(customerId: string) {
  return `modaafa:first-audit:${customerId.replace(/\D/g, '')}`;
}

export const FIRST_AUDIT_GUARD_MS = 6 * 60 * 1000;

export function isFirstAuditGuardActive(startedAt: number | null, now = Date.now()) {
  return startedAt !== null && Number.isFinite(startedAt) && now - startedAt < FIRST_AUDIT_GUARD_MS;
}

/**
 * Maps the refusal codes of POST /api/audit/run (docs/free-audit-contract.md)
 * to what the first-audit screen does about them. Anything else is a plain
 * error with a retry button.
 */
export function classifyAuditStartError(
  status: number,
  code?: string | null
): 'exhausted' | 'accounts_exhausted' | 'running' | 'error' {
  if (status === 402 && code === 'free_audits_exhausted') return 'exhausted';
  // Three accounts already had their free audits: a different account will not
  // help, only a subscription does.
  if (status === 402 && code === 'free_accounts_exhausted') return 'accounts_exhausted';
  if (status === 409 && code === 'audit_in_progress') return 'running';
  return 'error';
}
