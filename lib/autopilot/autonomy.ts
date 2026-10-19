import {
  accountCpa30dFromSnapshot,
} from '@/lib/ai/optimizer-gates';
import { evaluatePauseKeyword } from '@/lib/ai/optimizer-proposal-gates';
import type { OptimizerSnapshot } from '@/lib/ai/optimizer-agent';
import { allowableCpaCut, hasBreakEven } from '@/lib/economics/break-even';
import { BUDGET_SHIFT_OPERATION, evaluatePairAmounts, evaluatePairGate } from './budget-shift';
import {
  AUTOPILOT_POLICY_VERSION,
  type AutopilotCandidate,
  type AutopilotPolicyCheck,
  type AutopilotPolicyContext,
  type AutopilotPolicyVerdict,
} from './types';

/**
 * Autonomy levels. Behind AUTONOMY_LEVELS_ENABLED (default off). With the flag
 * off nothing in this file is reached and the autopilot behaves exactly as
 * before. With it on, the existing kill switch AUTOPILOT_EXECUTION_ENABLED and
 * the existing settings (mode, daily limit, cooldown, confidence) still apply.
 *
 *   ask_all           "يستأذن في كل شي": nothing runs by itself, every proposal
 *                     waits for the merchant's approval. The default.
 *   small_and_notify  "ينفذ الصغير ويبلّغ": exact negatives and keyword pauses
 *                     on a proven waste rule, nothing else, and the merchant is
 *                     told about each one with an undo.
 *
 * The hard ceilings below are not a setting. They are checked on every action
 * whatever the level is.
 */

export { AUTONOMY_LEVELS, DEFAULT_AUTONOMY_LEVEL, AUTONOMY_LEVEL_LABELS_AR, type AutonomyLevel } from './autonomy-levels';
import { AUTONOMY_LEVELS, DEFAULT_AUTONOMY_LEVEL, type AutonomyLevel } from './autonomy-levels';

export function autonomyLevelsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.AUTONOMY_LEVELS_ENABLED === 'true';
}

/** Anything unknown or missing is the safest level. */
export function normalizeAutonomyLevel(value: unknown): AutonomyLevel {
  return AUTONOMY_LEVELS.includes(value as AutonomyLevel) ? (value as AutonomyLevel) : DEFAULT_AUTONOMY_LEVEL;
}

/** An exact negative must have cost this many allowable CPAs with 0 conversions. */
export const AUTONOMY_NEGATIVE_COST_IN_CPAS = 2;
/** A budget move may shift at most this share of the total, and never raise the total. */
export { AUTONOMY_BUDGET_SHIFT_MAX_PCT } from './budget-math';

/** The only action types the small level can ever execute by itself. */
export const AUTONOMY_SMALL_ACTIONS = ['add_negative_keyword', 'pause_keyword'] as const;

// ---------------------------------------------------------------------------
// Hard ceilings
// ---------------------------------------------------------------------------

/** Action types that would create or enable something, change targets, or touch money rules. Never automatic. */
const NEVER_AUTOMATIC_TYPES = new Set([
  'enable_campaign',
  'create_campaign',
  'adjust_bid',
  'add_keyword',
  'pause_campaign',
  'pause_ad',
  'add_negative_keywords_batch',
]);

const TARGET_KEYS = [
  'target_cpa_micros',
  'target_cpa',
  'target_roas',
  'bidding_strategy',
  'bidding_strategy_type',
  'maximize_conversions',
  'maximize_conversion_value',
];
const BILLING_POLICY_KEYS = [
  'billing',
  'billing_setup',
  'payments_account',
  'payment',
  'policy',
  'policy_exemption',
  'exemption_request',
  'ignorable_policy_topics',
];

export type CeilingViolation =
  | 'type_not_allowed'
  | 'creates_or_enables_campaign'
  | 'changes_targets'
  | 'touches_billing_or_policy'
  | 'negative_not_exact'
  | 'raises_total_spend'
  | 'shift_too_large'
  | 'shift_invalid';

/**
 * Pure. Says which hard ceilings an action would break. An empty list means the
 * action is inside the small-action surface; it does not mean it is approved.
 */
export function hardCeilingViolations(action: {
  type: string;
  params?: Record<string, unknown> | null;
}): CeilingViolation[] {
  const out = new Set<CeilingViolation>();
  const params = action.params ?? {};
  const type = String(action.type ?? '');

  if (type === 'enable_campaign' || type === 'create_campaign') out.add('creates_or_enables_campaign');
  if (type === 'adjust_bid') out.add('changes_targets');
  if (NEVER_AUTOMATIC_TYPES.has(type)) out.add('type_not_allowed');
  if (type === BUDGET_SHIFT_OPERATION) {
    // The one money move the small level may make: a pure pair shift inside every ceiling.
    const amounts = evaluatePairAmounts({
      from: String(params.from_budget_resource ?? ''),
      to: String(params.to_budget_resource ?? ''),
      fromAmount: Number(params.from_current_micros),
      toAmount: Number(params.to_current_micros),
      shiftMicros: Number(params.shift_micros),
    });
    if (!amounts.ok) {
      out.add(amounts.code === 'raises_total_spend' ? 'raises_total_spend' : amounts.code === 'shift_too_large' ? 'shift_too_large' : 'shift_invalid');
    }
  } else if (!(AUTONOMY_SMALL_ACTIONS as readonly string[]).includes(type)) out.add('type_not_allowed');

  const keys = Object.keys(params).map((key) => key.toLowerCase());
  if (keys.some((key) => TARGET_KEYS.includes(key))) out.add('changes_targets');
  if (keys.some((key) => BILLING_POLICY_KEYS.includes(key))) out.add('touches_billing_or_policy');

  if (type === 'add_negative_keyword' && String(params.match_type ?? '').toUpperCase() !== 'EXACT') {
    out.add('negative_not_exact');
  }
  return [...out];
}

export { evaluateBudgetShift } from './budget-math';
export type { BudgetChange, BudgetShiftVerdict } from './budget-math';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type AutonomyContext = AutopilotPolicyContext & {
  level: AutonomyLevel;
  snapshot: Pick<
    OptimizerSnapshot,
    'campaigns' | 'economics' | 'underperforming_keywords' | 'conversion_tracking'
  >;
};

/**
 * Decide an action under the small level. Pure and independent of the older
 * conservative gate, so it re-checks tracking, confidence, the daily limit and
 * the cooldown itself. Never returns execute for a type outside
 * AUTONOMY_SMALL_ACTIONS.
 */
export function evaluateAutonomy(context: AutonomyContext): AutopilotPolicyVerdict {
  const { settings, action } = context;
  const checks: AutopilotPolicyCheck[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    return passed;
  };

  if (!check('autonomy_level', context.level === 'small_and_notify', `level=${context.level}`)) {
    return queue('autonomy_ask_all', 'اخترت أن يستأذنك في كل شي، فالتعديل ينتظر موافقتك.', checks);
  }
  if (!check('mode_enabled', settings.mode === 'conservative', `mode=${settings.mode}`)) {
    return queue('autopilot_not_conservative', 'الطيار الآلي مو في الوضع المحافظ، فالتعديل ينتظر موافقتك.', checks);
  }
  if (!check('global_kill_switch', context.globalExecutionEnabled, 'AUTOPILOT_EXECUTION_ENABLED')) {
    return queue('global_execution_disabled', 'التنفيذ التلقائي مقفول حالياً، فالتعديل ينتظر موافقتك.', checks);
  }

  // The merchant's own action list still applies (the older gate checks it too).
  if (
    action.type === 'add_negative_keyword' &&
    !check('action_allowlist', settings.allowed_actions.includes(action.type), `action=${action.type}`)
  ) {
    return queue('manual_action_type', 'هذا النوع من التعديل يحتاج موافقتك دائماً.', checks);
  }

  const violations = hardCeilingViolations(action);
  if (!check('hard_ceilings', violations.length === 0, violations.join(',') || 'none')) {
    return queue('manual_action_type', 'هذا النوع من التعديل يحتاج موافقتك دائماً.', checks);
  }

  if (!check('tracking_healthy', context.trackingStatus === 'healthy', `tracking=${context.trackingStatus}`)) {
    return queue('anomaly_pause', 'قياس التحويلات يحتاج مراجعة، فما ننفذ شي بنفسنا.', checks);
  }

  const confidence = Number(action.confidence ?? 0);
  if (
    !check(
      'confidence_threshold',
      Number.isFinite(confidence) && confidence >= settings.min_confidence,
      `confidence=${confidence};min=${settings.min_confidence}`
    )
  ) {
    return queue('confidence_below_threshold', 'الثقة أقل من الحد اللي اخترته، فالتعديل ينتظر موافقتك.', checks);
  }

  // The yardstick must be the owner's own break-even. The account's own CPA is
  // history, not a target, and is not enough for a change nobody approved.
  const limit = allowableCpaCut(
    context.snapshot.economics ?? null,
    accountCpa30dFromSnapshot(context.snapshot)
  );
  // A budget shift is judged by the cut and scale gates on the owner's break-even (CPA or ROAS), so it
  // needs the owner's economics, not specifically a CPA. Everything else keeps the CPA yardstick.
  const isShift = action.type === BUDGET_SHIFT_OPERATION;
  if (isShift) {
    if (!check('break_even_known', hasBreakEven(context.snapshot.economics ?? null), 'owner_economics')) {
      return queue('no_break_even', 'ما عندنا أرقام ربحك من الإعلان، فالتعديل ينتظر موافقتك.', checks);
    }
  } else if (
    !check('cost_reference', limit?.source === 'break_even_cpa', `source=${limit?.source ?? 'none'}`) ||
    !limit
  ) {
    return queue(
      'no_break_even',
      'ما عندنا تكلفة العميل المقبولة منك، فالتعديل ينتظر موافقتك.',
      checks
    );
  }

  const ruleOk = smallRule(action, limit?.value ?? 0, context.snapshot, check);
  if (!ruleOk) {
    return queue('insufficient_evidence', 'الأرقام ما توصل لقاعدة التنفيذ التلقائي، فالتعديل ينتظر موافقتك.', checks);
  }

  if (
    !check(
      'daily_change_limit',
      context.executedToday < settings.max_daily_changes,
      `executed=${context.executedToday};max=${settings.max_daily_changes}`
    )
  ) {
    return block('daily_limit_reached', 'وصلنا لحد التعديلات اليومي.', checks);
  }
  if (!check('target_cooldown', !context.sameTargetExecutedWithinCooldown, `cooldown_hours=${settings.cooldown_hours}`)) {
    return block('target_in_cooldown', 'هذا الهدف انعدل قريب وما زال في فترة الانتظار.', checks);
  }

  return {
    outcome: 'execute',
    code: 'autonomy_approved',
    reason_ar: 'التعديل صغير وداخل القاعدة اللي اخترتها، نفذناه وبلغناك وتقدر تتراجع عنه.',
    checks,
  };
}

function smallRule(
  action: AutopilotCandidate,
  cpa: number,
  snapshot: AutonomyContext['snapshot'],
  check: (code: string, passed: boolean, detail: string) => boolean
) {
  if (action.type === 'add_negative_keyword') {
    const evidence = action.evidence;
    const cost = evidence ? evidence.cost_micros / 1_000_000 : 0;
    // Never looser than the older conservative gate the merchant opted into
    // (lib/autopilot/policy.ts evidence_threshold): 14+ days, 8+ clicks and a
    // term the model judged clearly irrelevant, on top of the cost rule.
    return check(
      'negative_waste_rule',
      Boolean(
        evidence &&
          evidence.window_days >= 14 &&
          evidence.clicks >= 8 &&
          evidence.relevance === 'clearly_irrelevant' &&
          evidence.conversions === 0 &&
          evidence.cost_micros > 0 &&
          cost >= AUTONOMY_NEGATIVE_COST_IN_CPAS * cpa &&
          Boolean(String(action.params.campaign_resource ?? '').trim()) &&
          Boolean(String(action.params.keyword_text ?? '').trim())
      ),
      evidence ? `cost=${cost};cpa=${cpa};conv=${evidence.conversions}` : 'no_evidence'
    );
  }
  if (action.type === 'pause_keyword') {
    // The proposal gate reads the keyword from the snapshot (never from the
    // model's numbers): 0 conversions, 20+ clicks, cost >= 2 allowable CPAs.
    const verdict = evaluatePauseKeyword(action, { snapshot: snapshot as any } as any);
    return check('pause_keyword_rule', verdict.ok === true, verdict.ok ? 'ok' : String((verdict as any).code ?? 'no'));
  }
  if (action.type === BUDGET_SHIFT_OPERATION) {
    // Same cut gate for the giver and scale gate for the receiver as any single budget change,
    // read from the snapshot (never from numbers the proposal carries).
    const verdict = evaluatePairGate(action.params, snapshot as any, (value) => /^customers\/\d+\/campaignBudgets\/[^/]+$/.test(value));
    return check('budget_shift_rule', verdict.ok === true, verdict.ok ? 'ok' : String((verdict as any).code ?? 'no'));
  }
  return check('small_action', false, `type=${action.type}`);
}

/**
 * Combine the level with the verdict of the older gate. Level ask_all can only
 * make a verdict more cautious. Level small_and_notify replaces the verdict
 * with evaluateAutonomy, except that the old gate's switches (autopilot off,
 * observe only, kill switch) are respected as they were.
 */
export function applyAutonomyLevel(
  base: AutopilotPolicyVerdict,
  context: AutonomyContext
): AutopilotPolicyVerdict {
  if (context.level !== 'small_and_notify') {
    if (base.outcome !== 'execute') return base;
    return queue(
      'autonomy_ask_all',
      'اخترت أن يستأذنك في كل شي، فالتعديل ينتظر موافقتك.',
      [...base.checks, { code: 'autonomy_level', passed: false, detail: `level=${context.level}` }]
    );
  }
  if (['autopilot_off', 'observe_only', 'global_execution_disabled'].includes(base.code)) return base;
  return evaluateAutonomy(context);
}

export function autonomyPolicyNote() {
  return { policy_version: AUTOPILOT_POLICY_VERSION, autonomy: true };
}

function queue(code: string, reason_ar: string, checks: AutopilotPolicyCheck[]) {
  return { outcome: 'queue' as const, code, reason_ar, checks };
}

function block(code: string, reason_ar: string, checks: AutopilotPolicyCheck[]) {
  return { outcome: 'block' as const, code, reason_ar, checks };
}
