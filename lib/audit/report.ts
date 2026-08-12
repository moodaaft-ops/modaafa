type AuditReportInput = {
  accountId: string;
  auditId: string;
  summaryAr: string;
  summaryEn: string;
  healthScore: number;
  recommendationsCount: number;
  estimatedMonthlyWasteSar: number;
  currencyCode: string;
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
      audit_id: input.auditId,
      health_score: input.healthScore,
      recommendations_count: input.recommendationsCount,
      estimated_monthly_waste_sar: input.estimatedMonthlyWasteSar,
      currency_code: input.currencyCode,
    },
  };
}
