export type MoneyMetricKey = 'cost' | 'conversion_value' | 'cpc' | 'cpa';

const legacyKeys: Record<MoneyMetricKey, string> = {
  cost: 'cost_sar',
  conversion_value: 'conversion_value_sar',
  cpc: 'cpc_sar',
  cpa: 'cpa_sar',
};

export function moneyMetric(metrics: Record<string, unknown> | null | undefined, key: MoneyMetricKey) {
  const value = metrics?.[key] ?? metrics?.[legacyKeys[key]] ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function metricsCurrency(
  metrics: Record<string, unknown> | null | undefined,
  accountCurrency?: string | null
) {
  const value = String(metrics?.currency_code ?? accountCurrency ?? 'SAR').toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : 'SAR';
}
