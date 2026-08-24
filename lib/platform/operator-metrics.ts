export type UsageFeature =
  | 'assistant'
  | 'campaign_builder'
  | 'audit'
  | 'manual_sync'
  | 'execute_action';

export type UsageSummary = {
  feature: UsageFeature;
  label: string;
  count: number;
};

const FEATURE_ORDER: UsageFeature[] = [
  'assistant',
  'audit',
  'manual_sync',
  'campaign_builder',
  'execute_action',
];

const FEATURE_LABELS: Record<UsageFeature, string> = {
  assistant: 'رسائل المساعد',
  campaign_builder: 'مسودات الحملات',
  audit: 'فحوصات الحساب',
  manual_sync: 'مزامنات يدوية',
  execute_action: 'تنفيذات فعلية',
};

export function summarizeUsageEvents(rows: Array<{ feature?: string | null }>): UsageSummary[] {
  const counts = new Map<UsageFeature, number>();
  for (const feature of FEATURE_ORDER) counts.set(feature, 0);

  for (const row of rows) {
    const feature = row.feature as UsageFeature;
    if (!counts.has(feature)) continue;
    counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }

  return FEATURE_ORDER.map((feature) => ({
    feature,
    label: FEATURE_LABELS[feature],
    count: counts.get(feature) ?? 0,
  }));
}

export function operatorJobStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    running: 'يعمل الآن',
    success: 'نجح',
    partial: 'نجح جزئياً',
    failed: 'فشل',
  };
  return status ? labels[status] ?? status : 'غير معروف';
}

export function operatorJobStatusTone(status?: string | null) {
  if (status === 'success') return 'success' as const;
  if (status === 'failed') return 'danger' as const;
  if (status === 'partial' || status === 'running') return 'warning' as const;
  return 'neutral' as const;
}
