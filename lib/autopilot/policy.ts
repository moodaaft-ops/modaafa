import type { OptimizerSnapshot } from '@/lib/ai/optimizer-agent';
import {
  AUTOPILOT_POLICY_VERSION,
  AUTOPILOT_SAFE_ACTIONS,
  type AutopilotCandidate,
  type AutopilotEvidence,
  type AutopilotPolicyCheck,
  type AutopilotPolicyContext,
  type AutopilotPolicyVerdict,
} from './types';

const SAFE_ACTIONS = new Set<string>(AUTOPILOT_SAFE_ACTIONS);

/**
 * Deterministic policy gate. The model proposes; this function decides. It is
 * intentionally pure so every production decision is reproducible in tests.
 */
export function evaluateAutopilotPolicy(
  context: AutopilotPolicyContext
): AutopilotPolicyVerdict {
  const { settings, action } = context;
  const checks: AutopilotPolicyCheck[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    return passed;
  };

  if (!check('mode_enabled', settings.mode !== 'off', `mode=${settings.mode}`)) {
    return queue('autopilot_off', 'الطيار الآلي متوقف؛ أُرسلت التوصية للمراجعة اليدوية.', checks);
  }

  if (!check('observe_only', settings.mode !== 'observe', `mode=${settings.mode}`)) {
    return queue('observe_only', 'وضع المراقبة لا ينفّذ تعديلات؛ سجّلنا القرار للمراجعة.', checks);
  }

  if (!check('global_kill_switch', context.globalExecutionEnabled, 'AUTOPILOT_EXECUTION_ENABLED')) {
    return queue(
      'global_execution_disabled',
      'التنفيذ التلقائي مقفول تشغيلياً؛ بقي القرار في مركز الموافقات.',
      checks
    );
  }

  const actionAllowed =
    SAFE_ACTIONS.has(action.type) && settings.allowed_actions.includes(action.type);
  if (!check('action_allowlist', actionAllowed, `action=${action.type}`)) {
    return queue(
      'manual_action_type',
      'هذا النوع من التعديل يحتاج موافقة بشرية حتى في الوضع المحافظ.',
      checks
    );
  }

  if (
    settings.anomaly_pause_enabled &&
    !check(
      'anomaly_pause',
      context.trackingStatus === 'healthy',
      `tracking=${context.trackingStatus}`
    )
  ) {
    return queue(
      'anomaly_pause',
      'أوقفنا التنفيذ التلقائي احترازياً لأن قياس التحويلات يحتاج مراجعة.',
      checks
    );
  }

  if (
    !check(
      'tracking_health',
      !settings.require_healthy_tracking || context.trackingStatus === 'healthy',
      `tracking=${context.trackingStatus}`
    )
  ) {
    return queue(
      'tracking_not_healthy',
      'بيانات التحويل غير موثوقة بما يكفي للتنفيذ التلقائي؛ يلزم إصلاح القياس أو مراجعة بشرية.',
      checks
    );
  }

  const confidence = Number(action.confidence ?? 0);
  if (
    !check(
      'confidence_threshold',
      Number.isFinite(confidence) && confidence >= settings.min_confidence,
      `confidence=${confidence};min=${settings.min_confidence}`
    )
  ) {
    return queue(
      'confidence_below_threshold',
      'ثقة القرار أقل من الحد الذي اخترته؛ أُرسل للمراجعة اليدوية.',
      checks
    );
  }

  const evidence = action.evidence;
  const evidenceReady = Boolean(
    evidence &&
      evidence.window_days >= 14 &&
      evidence.clicks >= 8 &&
      evidence.conversions === 0 &&
      evidence.cost_micros > 0 &&
      evidence.relevance === 'clearly_irrelevant'
  );
  if (
    !check(
      'evidence_threshold',
      evidenceReady,
      evidence ? evidenceSummary(evidence) : 'missing'
    )
  ) {
    return queue(
      'insufficient_evidence',
      'الأدلة لا تكفي لتعديل تلقائي آمن؛ أُرسل القرار للمراجعة.',
      checks
    );
  }

  const exactNegative =
    action.type === 'add_negative_keyword' &&
    String(action.params.match_type ?? '') === 'EXACT' &&
    Boolean(String(action.params.campaign_resource ?? '').trim()) &&
    Boolean(String(action.params.keyword_text ?? '').trim());
  if (!check('exact_negative_only', exactNegative, 'V1 requires an exact campaign negative')) {
    return queue(
      'unsafe_negative_shape',
      'صيغة الكلمة السلبية أوسع من سياسة الوضع المحافظ؛ تحتاج موافقة بشرية.',
      checks
    );
  }

  if (
    !check(
      'daily_change_limit',
      context.executedToday < settings.max_daily_changes,
      `executed=${context.executedToday};max=${settings.max_daily_changes}`
    )
  ) {
    return block('daily_limit_reached', 'وصل الطيار الآلي إلى حد التعديلات اليومي.', checks);
  }

  if (
    !check(
      'target_cooldown',
      !context.sameTargetExecutedWithinCooldown,
      `cooldown_hours=${settings.cooldown_hours}`
    )
  ) {
    return block('target_in_cooldown', 'هذا الهدف عُدّل حديثاً وما زال داخل فترة التهدئة.', checks);
  }

  return {
    outcome: 'execute',
    code: 'policy_approved',
    reason_ar: 'اجتاز القرار كل ضوابط الوضع المحافظ ويمكن تنفيذه تلقائياً.',
    checks,
  };
}

/**
 * Replace model-supplied numeric evidence with the matching Google Ads row.
 * The model may classify relevance, but it cannot invent clicks, spend, dates
 * or the campaign resource used by the policy gate.
 */
export function groundAutopilotCandidate(
  action: AutopilotCandidate,
  snapshot: OptimizerSnapshot
): AutopilotCandidate {
  if (action.type !== 'add_negative_keyword') return action;

  const keywordText = normalize(String(action.params.keyword_text ?? ''));
  const campaignResource = String(action.params.campaign_resource ?? '').trim();
  const row = (snapshot.wasted_search_terms ?? []).find((candidate: any) => {
    const term = normalize(
      String(candidate.searchTermView?.searchTerm ?? candidate.search_term_view?.search_term ?? '')
    );
    const campaign = String(candidate.campaign?.resourceName ?? candidate.campaign?.resource_name ?? '');
    return term === keywordText && campaign === campaignResource;
  });

  if (!row) return { ...action, evidence: undefined };

  const metrics = row.metrics ?? {};
  const sourceResource = String(
    row.campaign?.resourceName ?? row.campaign?.resource_name ?? campaignResource
  );
  return {
    ...action,
    params: {
      ...action.params,
      campaign_resource: sourceResource,
      campaign_name: String(row.campaign?.name ?? action.params.campaign_name ?? ''),
      keyword_text: String(
        row.searchTermView?.searchTerm ?? row.search_term_view?.search_term ?? action.params.keyword_text
      ),
    },
    evidence: {
      window_days: 30,
      clicks: Number(metrics.clicks ?? 0),
      conversions: Number(metrics.conversions ?? 0),
      cost_micros: Number(metrics.costMicros ?? metrics.cost_micros ?? 0),
      source_resource: sourceResource,
      relevance:
        action.evidence?.relevance === 'clearly_irrelevant'
          ? 'clearly_irrelevant'
          : 'uncertain',
    },
  };
}

export function autopilotPolicyMetadata(verdict: AutopilotPolicyVerdict) {
  return {
    policy_version: AUTOPILOT_POLICY_VERSION,
    outcome: verdict.outcome,
    code: verdict.code,
    checks: verdict.checks,
  };
}

/**
 * Stable, human-auditable identity for cooldown and decision-ledger lookups.
 * A campaign can receive many distinct negatives, so the campaign resource by
 * itself is not a safe target key.
 */
export function autopilotTargetKey(action: AutopilotCandidate) {
  if (action.type === 'add_negative_keyword') {
    return [
      String(action.params.campaign_resource ?? action.target_id ?? '').trim(),
      normalize(String(action.params.keyword_text ?? '')),
      String(action.params.match_type ?? 'EXACT').toUpperCase(),
    ].join('|');
  }

  return `${action.type}|${String(action.target_id ?? '').trim()}`;
}

function queue(code: string, reason_ar: string, checks: AutopilotPolicyCheck[]) {
  return { outcome: 'queue' as const, code, reason_ar, checks };
}

function block(code: string, reason_ar: string, checks: AutopilotPolicyCheck[]) {
  return { outcome: 'block' as const, code, reason_ar, checks };
}

function evidenceSummary(evidence: AutopilotEvidence) {
  return [
    `days=${evidence.window_days}`,
    `clicks=${evidence.clicks}`,
    `conversions=${evidence.conversions}`,
    `cost_micros=${evidence.cost_micros}`,
    `relevance=${evidence.relevance}`,
  ].join(';');
}

function normalize(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ar');
}
