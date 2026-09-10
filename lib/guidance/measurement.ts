export const MEASUREMENT_WINDOW_DAYS = 7;
export const MEASUREMENT_DELAY_MS = MEASUREMENT_WINDOW_DAYS * 86_400_000;
export type MeasurementState = 'awaiting' | 'unmeasurable' | 'limited' | 'measured';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function measurementState(impact: unknown): MeasurementState {
  if (!isRecord(impact) || Object.keys(impact).length === 0) return 'awaiting';
  if (impact.status === 'unmeasurable') return 'unmeasurable';
  if (!validMetrics(impact.after) || !validMetrics(impact.before)) return 'limited';
  if (impact.baseline_available === false || impact.status === 'limited') return 'limited';
  return 'measured';
}

function validMetrics(value: unknown) {
  if (!isRecord(value)) return false;
  return ['cost', 'conversions'].every((key) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0
  );
}

export function measurementDueAt(createdAt?: string | null) {
  const timestamp = Date.parse(createdAt ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp + MEASUREMENT_DELAY_MS).toISOString() : null;
}
