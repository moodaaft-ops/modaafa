type AuditReportInput = {
  accountId: string;
  auditId: string;
  summaryAr: string;
  summaryEn: string;
  healthScore: number;
  recommendationsCount: number;
  estimatedMonthlyWasteSar: number;
  currencyCode: string;
  snapshotAt?: string | null;
  timeZone?: string | null;
};

/**
 * Audit summaries are event reports, not weekly performance reports. Keeping
 * their date range null prevents them from contending with the one-per-week
 * performance report index and permits every paid re-audit to be recorded.
 */
export function buildAuditReportRow(input: AuditReportInput) {
  return {
    account_id: input.accountId,
    period_type: 'custom' as const,
    period_start: null,
    period_end: null,
    summary_ar: input.summaryAr,
    summary_en: input.summaryEn,
    metrics: {
      kind: 'audit_summary',
      data_windows: auditSnapshotWindows(input.snapshotAt, input.timeZone),
      snapshot_at: input.snapshotAt ?? null,
      audit_id: input.auditId,
      health_score: input.healthScore,
      recommendations_count: input.recommendationsCount,
      estimated_monthly_waste_sar: input.estimatedMonthlyWasteSar,
      currency_code: input.currencyCode,
    },
  };
}

// Google LAST_N_DAYS excludes today and follows the advertising account timezone.
// Unknown timezone/snapshot stays unknown rather than inventing a report period.
export function auditSnapshotWindows(snapshotAt?: string | null, timeZone?: string | null) {
  if (!snapshotAt || !timeZone || !Number.isFinite(Date.parse(snapshotAt))) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(snapshotAt));
    const part = (name: string) => parts.find((item) => item.type === name)?.value;
    const day = Date.parse(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
    const date = (offset: number) => new Date(day - offset * 86400000).toISOString().slice(0, 10);
    return { time_zone: timeZone, last_7_days: { from: date(7), to: date(1) }, last_30_days: { from: date(30), to: date(1) } };
  } catch { return null; }
}
