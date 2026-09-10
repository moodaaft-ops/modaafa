import { measurementState } from './measurement';

export type ActionHistoryState =
  | 'approved'
  | 'awaiting_measurement'
  | 'measured'
  | 'unmeasurable'
  | 'limited'
  | 'executing'
  | 'failed'
  | 'reverted';

type ActionHistoryInput = {
  action_type?: string | null;
  result?: unknown;
  observed_impact?: unknown;
  reverted_at?: string | null;
};

const FAILED_ACTION_TYPES = new Set([
  'execution_blocked',
  'blocked_by_guardrails',
  'preflight_failed',
  'resource_account_mismatch',
  'record_failed',
  'execution_failed',
]);

const FAILED_RESULT_STATUSES = new Set([
  'failed',
  'error',
  'manual_review_required',
  'blocked_by_guardrails',
  'preflight_failed',
  'resource_account_mismatch',
]);

export function actionHistoryState(action: ActionHistoryInput): ActionHistoryState {
  if (action.reverted_at) return 'reverted';

  const resultStatus = readResultStatus(action.result);
  if (
    FAILED_ACTION_TYPES.has(action.action_type ?? '') ||
    FAILED_RESULT_STATUSES.has(resultStatus)
  ) {
    return 'failed';
  }

  if (action.action_type === 'approval_queued' || resultStatus === 'queued_for_execution') {
    return 'approved';
  }

  if (['executing', 'unknown', 'mutation_outcome_unknown'].includes(resultStatus)) return 'executing';
  const measurement = measurementState(action.observed_impact);
  if (measurement !== 'awaiting') return measurement;
  return 'awaiting_measurement';
}

export function actionHistoryLabel(state: ActionHistoryState) {
  const labels: Record<ActionHistoryState, string> = {
    approved: 'معتمد وينتظر التنفيذ',
    awaiting_measurement: 'نُفّذ وينتظر قياس الأثر',
    measured: 'مقارنة الأداء متاحة',
    unmeasurable: 'تعذر قياس الأثر',
    limited: 'البيانات لا تكفي للحكم',
    executing: 'قيد التحقق من التنفيذ',
    failed: 'لم يُنفّذ',
    reverted: 'تم التراجع',
  };
  return labels[state];
}

export function actionHistoryTone(state: ActionHistoryState) {
  if (state === 'measured') return 'success' as const;
  if (state === 'failed') return 'danger' as const;
  if (['approved', 'awaiting_measurement', 'limited', 'executing'].includes(state)) return 'warning' as const;
  return 'neutral' as const;
}

function readResultStatus(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const status = (result as Record<string, unknown>).status;
  return typeof status === 'string' ? status : '';
}
