/**
 * The optimizer remembers what it did on THIS account and how it turned out.
 *
 * Before it proposes anything, the cron loads the account's executed changes
 * of the last 90 days that were measured (ai_actions.observed_impact, written
 * by lib/ai/impact.ts), classifies each as positive, negative, neutral or
 * unknown, and:
 *
 *   1. passes a compact «what worked here» block into the prompt;
 *   2. suppresses a proposal that repeats an action of the same type, in the
 *      same direction, on the same entity, when that earlier change measured
 *      NEGATIVE.
 *
 * The verdicts are rules over the stored numbers. No model. A verdict needs
 * enough volume to mean anything, and when the measurement carries a
 * difference in differences against untouched campaigns (diff_in_diff) that
 * comparison decides: a drop that the rest of the account shared is not the
 * change's fault.
 *
 * Pure except loadOutcomeRecords (one select on ai_actions).
 */

import type { DifferenceInDifferences, MetricTotals } from '../ai/impact';

export const OUTCOME_LOOKBACK_DAYS = 90;

export type OutcomeVerdict = 'positive' | 'negative' | 'neutral' | 'unknown';
export type ActionDirection = 'up' | 'down' | null;

export type OutcomeRecord = {
  action_id: string;
  action_type: string;
  direction: ActionDirection;
  /** Google Ads resource name of what was changed (budget, ad group, campaign, keyword, ad). */
  entity: string | null;
  created_at: string | null;
  verdict: OutcomeVerdict;
  confidence: 'low' | 'medium' | 'high' | null;
  reason_ar: string;
  before: MetricTotals | null;
  after: MetricTotals | null;
};

type StoredImpact = {
  status?: string;
  before?: MetricTotals;
  after?: MetricTotals;
  diff_in_diff?: DifferenceInDifferences | null;
};

/** Minimum conversions on the side that carries the claim before a verdict is more than "unknown". */
const MIN_CONVERSIONS_CLAIM = 3;
/** A conversions drop of this share, with nothing else explaining it, is a negative. */
const BAD_CONVERSION_DROP = 0.3;
/** Cost per conversion up by this share is a negative. */
const BAD_CPA_RISE = 0.25;
/** The change did this many points worse than the control group (or worse) to count as its fault. */
const BAD_VS_CONTROL_POINTS = -10;
/** Clicks a promoted keyword or re-enabled campaign must collect with no conversion to be called a miss. */
const MISS_MIN_CLICKS = 15;

function costPerConversion(t: MetricTotals): number | null {
  return t.conversions > 0 ? t.cost / t.conversions : null;
}

/** What was changed, and which way: the pieces a repeat has to match. */
export function actionKeyOf(row: { action_type?: string | null; payload?: any }): {
  type: string;
  direction: ActionDirection;
  entity: string | null;
} {
  const type = String(row.action_type ?? row.payload?.action?.type ?? '');
  const action = row.payload?.action ?? {};
  const params = action.params ?? row.payload?.params ?? {};
  const measurement = row.payload?.measurement ?? {};
  let entity: string | null = null;
  let direction: ActionDirection = null;

  if (type === 'adjust_budget') {
    entity = str(params.budget_resource) ?? str(measurement.resource);
    const delta = Number(params.delta_pct);
    const current = Number(params.current_amount_micros);
    const next = Number(params.new_amount_micros);
    if (Number.isFinite(delta) && delta !== 0) direction = delta > 0 ? 'up' : 'down';
    else if (current > 0 && next > 0 && current !== next) direction = next > current ? 'up' : 'down';
  } else if (type === 'adjust_bid') {
    entity = str(params.ad_group_resource) ?? str(measurement.resource);
    const cpa = Number(params.target_cpa_micros);
    const cpaNow = Number(params.current_target_cpa_micros);
    const roas = Number(params.target_roas);
    const roasNow = Number(params.current_target_roas);
    if (cpa > 0 && cpaNow > 0 && cpa !== cpaNow) direction = cpa > cpaNow ? 'up' : 'down';
    else if (roas > 0 && roasNow > 0 && roas !== roasNow) direction = roas > roasNow ? 'up' : 'down';
  } else if (type === 'add_keyword') {
    entity = str(params.ad_group_resource);
  } else if (type === 'add_negative_keyword' || type === 'add_negative_keywords_batch') {
    entity = str(params.campaign_resource) ?? str(measurement.resource);
  } else {
    entity = str(action.target_id) ?? str(measurement.resource);
  }
  return { type, direction, entity };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A proposal's own key, shaped like actionKeyOf. */
export function proposalKeyOf(action: { type: string; target_id?: string; params?: Record<string, unknown> | null }) {
  return actionKeyOf({ action_type: action.type, payload: { action: { type: action.type, target_id: action.target_id, params: action.params ?? {} } } });
}

/**
 * Turns one stored measurement into a verdict. Honest about volume: a thin
 * measurement is "unknown", never "positive" or "negative".
 */
export function classifyOutcome(
  type: string,
  direction: ActionDirection,
  impact: StoredImpact | null | undefined
): { verdict: OutcomeVerdict; confidence: OutcomeRecord['confidence']; reason_ar: string } {
  const before = impact?.before;
  const after = impact?.after;
  if (!impact || impact.status === 'unmeasurable' || !before || !after) {
    return { verdict: 'unknown', confidence: null, reason_ar: 'ما انقاس' };
  }
  const did = impact.diff_in_diff ?? null;
  const confidence = did?.confidence ?? null;

  // When a control group exists it decides: the change is judged on what it did beyond the rest of the account.
  const againstControl = did?.did_pct_points?.conversions ?? null;
  const sharedWithControl = againstControl !== null && againstControl > BAD_VS_CONTROL_POINTS;

  const convBefore = before.conversions;
  const convAfter = after.conversions;
  const cpaBefore = costPerConversion(before);
  const cpaAfter = costPerConversion(after);
  const convDrop = convBefore > 0 ? (convBefore - convAfter) / convBefore : 0;
  const cpaRise = cpaBefore !== null && cpaAfter !== null && cpaBefore > 0 ? (cpaAfter - cpaBefore) / cpaBefore : null;
  const costRise = before.cost > 0 ? (after.cost - before.cost) / before.cost : null;

  const negative = (reason_ar: string) =>
    sharedWithControl
      ? { verdict: 'neutral' as const, confidence, reason_ar: 'الهبوط شمل بقية الحساب، فهو مو من التعديل' }
      : { verdict: 'negative' as const, confidence, reason_ar };
  const positive = (reason_ar: string) => ({ verdict: 'positive' as const, confidence, reason_ar });
  const neutral = (reason_ar: string) => ({ verdict: 'neutral' as const, confidence, reason_ar });

  switch (type) {
    case 'adjust_budget': {
      if (direction === 'up') {
        if (costRise !== null && costRise >= 0.1 && convAfter >= MIN_CONVERSIONS_CLAIM && cpaRise !== null && cpaRise >= BAD_CPA_RISE) {
          return negative('زاد الصرف وغلت تكلفة التحويل');
        }
        if (costRise !== null && costRise >= 0.1 && convBefore >= MIN_CONVERSIONS_CLAIM && convDrop >= BAD_CONVERSION_DROP) {
          return negative('زاد الصرف وقلت التحويلات');
        }
        if (convBefore >= MIN_CONVERSIONS_CLAIM && convAfter > convBefore && (cpaRise === null || cpaRise <= 0.1)) {
          return positive('زادت التحويلات والتكلفة ثابتة');
        }
        return convBefore + convAfter < MIN_CONVERSIONS_CLAIM ? { verdict: 'unknown', confidence, reason_ar: 'التحويلات قليلة' } : neutral('بدون فرق واضح');
      }
      if (direction === 'down') {
        if (convBefore >= MIN_CONVERSIONS_CLAIM && convDrop >= BAD_CONVERSION_DROP && (costRise === null || costRise > -convDrop)) {
          return negative('قلت التحويلات أكثر من الصرف');
        }
        if (convBefore >= MIN_CONVERSIONS_CLAIM && cpaRise !== null && cpaRise <= -0.1 && convDrop < 0.15) {
          return positive('نزلت التكلفة والتحويلات ثابتة');
        }
        return convBefore + convAfter < MIN_CONVERSIONS_CLAIM ? { verdict: 'unknown', confidence, reason_ar: 'التحويلات قليلة' } : neutral('بدون فرق واضح');
      }
      return { verdict: 'unknown', confidence, reason_ar: 'اتجاه التعديل غير معروف' };
    }
    case 'adjust_bid': {
      if (convBefore >= MIN_CONVERSIONS_CLAIM && cpaRise !== null && cpaRise >= BAD_CPA_RISE && convDrop >= 0.1) {
        return negative('غلت تكلفة التحويل وقلت التحويلات');
      }
      if (convBefore >= MIN_CONVERSIONS_CLAIM && cpaRise !== null && cpaRise <= -0.1 && convDrop < 0.15) {
        return positive('نزلت تكلفة التحويل');
      }
      return convBefore + convAfter < MIN_CONVERSIONS_CLAIM ? { verdict: 'unknown', confidence, reason_ar: 'التحويلات قليلة' } : neutral('بدون فرق واضح');
    }
    case 'add_keyword':
    case 'enable_campaign': {
      if (convAfter <= 0 && after.clicks >= MISS_MIN_CLICKS) return negative('صرف نقرات بدون تحويل');
      if (convAfter >= MIN_CONVERSIONS_CLAIM - 1) return positive('جاب تحويلات');
      return { verdict: 'unknown', confidence, reason_ar: 'بيانات قليلة' };
    }
    case 'add_negative_keyword':
    case 'add_negative_keywords_batch': {
      if (convBefore >= 5 && convDrop >= BAD_CONVERSION_DROP && (costRise === null || costRise > -convDrop)) {
        return negative('قلت تحويلات الحملة أكثر من صرفها');
      }
      if (convBefore >= MIN_CONVERSIONS_CLAIM && costRise !== null && costRise <= -0.1 && convDrop < 0.15) {
        return positive('نزل الصرف والتحويلات ثابتة');
      }
      return convBefore + convAfter < MIN_CONVERSIONS_CLAIM ? { verdict: 'unknown', confidence, reason_ar: 'التحويلات قليلة' } : neutral('بدون فرق واضح');
    }
    default:
      // pause_keyword, pause_ad, pause_campaign: the paused thing stops by design, so its own after says nothing.
      return { verdict: 'neutral', confidence, reason_ar: 'الإيقاف ما يتقاس بنفسه' };
  }
}

export function toOutcomeRecord(row: { id: string; action_type: string; payload?: any; observed_impact?: any; created_at?: string | null }): OutcomeRecord {
  const key = actionKeyOf(row);
  const impact = (row.observed_impact ?? null) as StoredImpact | null;
  const result = classifyOutcome(key.type, key.direction, impact);
  return {
    action_id: String(row.id),
    action_type: key.type,
    direction: key.direction,
    entity: key.entity,
    created_at: row.created_at ?? null,
    verdict: result.verdict,
    confidence: result.confidence,
    reason_ar: result.reason_ar,
    before: impact?.before ?? null,
    after: impact?.after ?? null,
  };
}

/** Executed and measured changes of the account in the last 90 days. Never throws; [] when unreadable. */
export async function loadOutcomeRecords(supabase: any, accountId: string, now: Date = new Date()): Promise<OutcomeRecord[]> {
  try {
    const since = new Date(now.getTime() - OUTCOME_LOOKBACK_DAYS * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from('ai_actions')
      .select('id, action_type, payload, observed_impact, created_at')
      .eq('account_id', accountId)
      .gte('created_at', since)
      .not('observed_impact', 'is', null)
      .order('created_at', { ascending: false })
      .limit(80);
    if (error || !Array.isArray(data)) return [];
    return data.map(toOutcomeRecord).filter((record) => record.verdict !== 'unknown' || record.before !== null);
  } catch {
    return [];
  }
}

export const SUPPRESSED_BY_OUTCOME = 'past_negative_outcome';

/**
 * The earlier negative outcome that makes this proposal a repeat, or null.
 * Same action type, same entity, same direction (a budget cut that hurt does
 * not block a later raise).
 */
export function findNegativeRepeat(
  action: { type: string; target_id?: string; params?: Record<string, unknown> | null },
  records: readonly OutcomeRecord[]
): OutcomeRecord | null {
  const key = proposalKeyOf(action);
  if (!key.entity) return null;
  return (
    records.find(
      (record) =>
        record.verdict === 'negative' &&
        record.action_type === key.type &&
        record.entity === key.entity &&
        record.direction === key.direction
    ) ?? null
  );
}

/** Splits proposals into the ones to keep and the ones that repeat a change that measured negative. */
export function suppressNegativeRepeats<T extends { type: string; target_id?: string; params?: Record<string, unknown> | null }>(
  actions: readonly T[],
  records: readonly OutcomeRecord[]
): { kept: T[]; suppressed: Array<{ action: T; because: OutcomeRecord }> } {
  const kept: T[] = [];
  const suppressed: Array<{ action: T; because: OutcomeRecord }> = [];
  for (const action of actions) {
    const because = findNegativeRepeat(action, records);
    if (because) suppressed.push({ action, because });
    else kept.push(action);
  }
  return { kept, suppressed };
}

export type WhatWorkedBlock = {
  window_days: number;
  measured_changes: number;
  worked: Array<Record<string, unknown>>;
  did_not_work: Array<Record<string, unknown>>;
  /** Plain rule for the model: the server already drops these repeats. */
  note: string;
};

function lastSegment(resource: string | null) {
  return resource ? (resource.split('/').pop() ?? null) : null;
}

function daysAgo(createdAt: string | null, now: Date) {
  const t = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 86_400_000)) : null;
}

function brief(record: OutcomeRecord, now: Date): Record<string, unknown> {
  return {
    type: record.action_type,
    direction: record.direction,
    entity_id: lastSegment(record.entity),
    days_ago: daysAgo(record.created_at, now),
    result: record.reason_ar,
    confidence: record.confidence,
    cost: record.before && record.after ? [record.before.cost, record.after.cost] : null,
    conversions: record.before && record.after ? [record.before.conversions, record.after.conversions] : null,
  };
}

/** The compact block for the optimizer prompt. Null when nothing was measured. */
export function whatWorkedBlock(records: readonly OutcomeRecord[], now: Date = new Date()): WhatWorkedBlock | null {
  const worked = records.filter((r) => r.verdict === 'positive').slice(0, 5);
  const didNot = records.filter((r) => r.verdict === 'negative').slice(0, 5);
  if (worked.length === 0 && didNot.length === 0) return null;
  return {
    window_days: OUTCOME_LOOKBACK_DAYS,
    measured_changes: records.length,
    worked: worked.map((r) => brief(r, now)),
    did_not_work: didNot.map((r) => brief(r, now)),
    note: 'Evidence from this account. Prefer the kinds of change that worked. A repeat of one that did not work on the same entity is dropped by the server.',
  };
}
