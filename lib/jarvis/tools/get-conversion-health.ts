import type { EvidenceRow, JarvisReadTool } from './types';
import { landingSupportForVerdict } from '@/lib/landing-check/evidence';
import { supabaseLandingCheckStore } from '@/lib/landing-check/store';
import { createAdminClient } from '@/lib/supabase/server';
import { isLeadLoopEnabled } from '@/lib/lead-loop/flag';
import { reviewConversionGoals } from '@/lib/measurement/goals';
import { loadMeasurementInputs } from '@/lib/measurement/review-inputs';
import { findTrackingGaps, totalsByDay } from '@/lib/measurement/tracking-gaps';
import {
  addDays,
  bool,
  cleanText,
  daysBetween,
  enumLabel,
  num0,
  okResult,
  parseArgs,
  refCounter,
  round,
  runQuery,
  str,
  tryQuery,
  utcDate,
} from './shared';

export type ConversionVerdictCode = 'missing' | 'suspect' | 'broken_recently' | 'wrong_primary' | 'healthy';
export type ConversionIssueCode = Exclude<ConversionVerdictCode, 'healthy'> | 'auto_tagging_off';

export type ConversionActionInfo = {
  name: string;
  status: string;
  category: string;
  primaryForGoal: boolean | null;
  includeInConversionsMetric: boolean | null;
};

export type DailyConversionPoint = { date: string; action: string; conversions: number };

export type ConversionIssue = { code: ConversionIssueCode; reason_ar: string; actions?: string[] };

export type ConversionVerdictInput = {
  actions: ConversionActionInfo[];
  /** Clicks and primary conversions over the last 7 days (enabled campaigns). null when unknown. */
  clicks7d: number | null;
  conversions7d: number | null;
  /** all_conversions per action per day over the last 30 days. null when that check was unavailable. */
  daily: DailyConversionPoint[] | null;
  /** customer.auto_tagging_enabled. null when unknown. */
  autoTaggingEnabled: boolean | null;
  /** YYYY-MM-DD, UTC. */
  today: string;
};

export type ConversionVerdictResult = {
  verdict: ConversionVerdictCode;
  issues: ConversionIssue[];
  brokenActions: string[];
  wrongPrimaryActions: string[];
  autoTaggingOff: boolean;
};

/** Same cut the optimizer uses, so the autopilot and the brain never disagree. */
export const SUSPECT_MIN_CLICKS = 100;
export const BROKEN_MIN_EARLIER_DAYS = 3;
export const BROKEN_SILENT_DAYS = 5;
const LOOKBACK_DAYS = 30;
/** Categories that measure curiosity, not a business result. */
const LOW_INTENT_CATEGORIES = new Set(['PAGE_VIEW', 'ENGAGEMENT', 'OUTBOUND_CLICK']);

function listNames(names: string[]) {
  const shown = names.slice(0, 3).map((name) => `"${cleanText(name)}"`);
  return names.length > 3 ? `${shown.join('، ')} و${names.length - 3} غيرها` : shown.join('، ');
}

/**
 * Pure verdict. Order of precedence is the order of the checks:
 * missing, suspect, broken_recently, wrong_primary, else healthy.
 * Auto tagging off is a flag on top of the verdict, never the verdict itself.
 */
export function conversionVerdict(input: ConversionVerdictInput): ConversionVerdictResult {
  const issues: ConversionIssue[] = [];
  const enabled = input.actions.filter((action) => action.status === 'ENABLED');
  let brokenActions: string[] = [];
  let wrongPrimaryActions: string[] = [];

  if (enabled.length === 0) {
    issues.push({
      code: 'missing',
      reason_ar: 'ما في أي تحويل مفعّل في الحساب، فما نقدر نعرف وش اللي يجيب لك طلبات فعلية',
    });
  } else {
    const clicks = input.clicks7d;
    if (clicks !== null && clicks >= SUSPECT_MIN_CLICKS && (input.conversions7d ?? 0) === 0) {
      issues.push({
        code: 'suspect',
        reason_ar: `الحساب جاب ${Math.round(clicks)} نقرة في آخر 7 أيام وما سجّل ولا تحويل، وغالباً فيه خلل في التتبع`,
      });
    }

    brokenActions = findBrokenActions(enabled, input);
    if (brokenActions.length > 0) {
      issues.push({
        code: 'broken_recently',
        actions: brokenActions.map(cleanText),
        reason_ar: `تحويلات كانت تسجّل بانتظام وتوقفت من ${BROKEN_SILENT_DAYS} أيام أو أكثر: ${listNames(brokenActions)}`,
      });
    }

    wrongPrimaryActions = enabled
      .filter(
        (action) =>
          LOW_INTENT_CATEGORIES.has(action.category) &&
          (action.includeInConversionsMetric === true || action.primaryForGoal === true)
      )
      .map((action) => action.name);
    if (wrongPrimaryActions.length > 0) {
      issues.push({
        code: 'wrong_primary',
        actions: wrongPrimaryActions.map(cleanText),
        reason_ar: `تحويل من نوع زيارة صفحة أو تفاعل خفيف محسوب كتحويل أساسي: ${listNames(wrongPrimaryActions)}، وهذا يخلي المزايدة تلاحق زيارات مو طلبات`,
      });
    }
  }

  const verdict: ConversionVerdictCode = issues.length > 0 ? (issues[0].code as ConversionVerdictCode) : 'healthy';

  const autoTaggingOff = input.autoTaggingEnabled === false;
  if (autoTaggingOff) {
    issues.push({
      code: 'auto_tagging_off',
      reason_ar: 'الوسم التلقائي مقفول، وهذا يقطع الربط بين النقرات والتحويلات',
    });
  }

  return { verdict, issues, brokenActions, wrongPrimaryActions, autoTaggingOff };
}

/** An enabled action with conversions on 3+ earlier days that is silent for the last 5 days. */
function findBrokenActions(enabled: ConversionActionInfo[], input: ConversionVerdictInput): string[] {
  if (!input.daily) return [];
  // No traffic at all means paused campaigns, not broken tracking.
  if (input.clicks7d !== null && input.clicks7d <= 0) return [];

  const silentFrom = addDays(input.today, -BROKEN_SILENT_DAYS);
  const windowStart = addDays(input.today, -LOOKBACK_DAYS);
  const byAction = new Map<string, Map<string, number>>();
  for (const point of input.daily) {
    if (!(point.conversions > 0) || point.date < windowStart) continue;
    const days = byAction.get(point.action) ?? new Map<string, number>();
    days.set(point.date, (days.get(point.date) ?? 0) + point.conversions);
    byAction.set(point.action, days);
  }

  const broken: string[] = [];
  for (const action of enabled) {
    const days = byAction.get(action.name);
    if (!days) continue;
    let earlier = 0;
    let recent = 0;
    for (const date of days.keys()) {
      if (date < silentFrom) earlier += 1;
      else recent += 1;
    }
    if (earlier >= BROKEN_MIN_EARLIER_DAYS && recent === 0) broken.push(action.name);
  }
  return broken;
}

export const getConversionHealthTool: JarvisReadTool = {
  name: 'get_conversion_health',
  description:
    'Checks whether conversion tracking can be trusted: no enabled conversion actions, clicks without any conversion, an action that used to record and went silent, a low intent action counted as primary, and auto tagging. Use it before any decision that relies on conversion numbers.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);
    const today = utcDate(ctx.now);

    const [actionRows, dailyRows, customerRows, clickRows] = await Promise.all([
      runQuery(
        ctx,
        `
        SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name,
          conversion_action.status, conversion_action.type, conversion_action.category,
          conversion_action.primary_for_goal, conversion_action.counting_type,
          conversion_action.include_in_conversions_metric
        FROM conversion_action
        WHERE conversion_action.status != 'REMOVED'
        LIMIT 100
      `
      ),
      tryQuery(
        ctx,
        'conversion_daily',
        `
        SELECT segments.date, segments.conversion_action_name, metrics.all_conversions
        FROM campaign
        WHERE segments.date DURING LAST_30_DAYS
      `
      ),
      tryQuery(
        ctx,
        'customer_settings',
        `
        SELECT customer.auto_tagging_enabled, customer.time_zone, customer.currency_code
        FROM customer
        LIMIT 1
      `
      ),
      tryQuery(
        ctx,
        'clicks_7d',
        `
        SELECT campaign.id, metrics.clicks, metrics.conversions
        FROM campaign
        WHERE segments.date DURING LAST_7_DAYS AND campaign.status = 'ENABLED'
      `
      ),
    ]);

    const actions = actionRows.map((row) => ({
      resourceName: str(row, 'conversion_action.resource_name'),
      id: str(row, 'conversion_action.id'),
      rawName: str(row, 'conversion_action.name'),
      name: cleanText(str(row, 'conversion_action.name')),
      status: enumLabel(str(row, 'conversion_action.status'), 'UNKNOWN'),
      type: enumLabel(str(row, 'conversion_action.type'), 'UNKNOWN'),
      category: enumLabel(str(row, 'conversion_action.category'), 'UNKNOWN'),
      primaryForGoal: bool(row, 'conversion_action.primary_for_goal'),
      countingType: enumLabel(str(row, 'conversion_action.counting_type'), 'UNKNOWN'),
      includeInConversionsMetric: bool(row, 'conversion_action.include_in_conversions_metric'),
    }));

    const daily: DailyConversionPoint[] | null = dailyRows
      ? dailyRows.map((row) => ({
          date: str(row, 'segments.date'),
          action: str(row, 'segments.conversion_action_name'),
          conversions: num0(row, 'metrics.all_conversions'),
        }))
      : null;

    const autoTagging = customerRows && customerRows.length > 0 ? bool(customerRows[0], 'customer.auto_tagging_enabled') : null;
    const clicks7d = clickRows ? clickRows.reduce((sum, row) => sum + num0(row, 'metrics.clicks'), 0) : null;
    const conversions7d = clickRows ? clickRows.reduce((sum, row) => sum + num0(row, 'metrics.conversions'), 0) : null;

    const result = conversionVerdict({
      // The verdict matches on the raw name Google reports in the daily rows.
      actions: actions.map((action) => ({
        name: action.rawName,
        status: action.status,
        category: action.category,
        primaryForGoal: action.primaryForGoal,
        includeInConversionsMetric: action.includeInConversionsMetric,
      })),
      clicks7d,
      conversions7d,
      daily,
      autoTaggingEnabled: autoTagging,
      today,
    });

    const brokenSet = new Set(result.brokenActions);
    const totalsByAction = new Map<string, number>();
    const lastDayByAction = new Map<string, string>();
    for (const point of daily ?? []) {
      if (!(point.conversions > 0)) continue;
      totalsByAction.set(point.action, (totalsByAction.get(point.action) ?? 0) + point.conversions);
      const last = lastDayByAction.get(point.action);
      if (!last || point.date > last) lastDayByAction.set(point.action, point.date);
    }

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const shownActions = [...actions]
      .sort((a, b) => Number(b.status === 'ENABLED') - Number(a.status === 'ENABLED'))
      .slice(0, 30)
      .map((action) => {
        const ref = nextRef('ca');
        evidence.push({
          ref,
          kind: 'conversion_action',
          data: {
            id: action.id,
            name: action.name,
            resource_name: action.resourceName,
            status: action.status,
            type: action.type,
            category: action.category,
            primary_for_goal: action.primaryForGoal,
            include_in_conversions_metric: action.includeInConversionsMetric,
            counting_type: action.countingType,
          },
        });
        const lastDay = lastDayByAction.get(action.rawName);
        const compact: Record<string, unknown> = {
          ref,
          name: action.name,
          status: action.status,
          type: action.type,
          category: action.category,
          primary: action.primaryForGoal,
          counted_in_conversions: action.includeInConversionsMetric,
          counting_type: action.countingType,
          conversions_30d: daily ? round(totalsByAction.get(action.rawName) ?? 0, 2) : null,
          last_conversion_days_ago: lastDay ? Math.max(0, daysBetween(lastDay, today)) : null,
        };
        if (brokenSet.has(action.rawName)) compact.silent = true;
        return compact;
      });

    const unavailable: string[] = [];
    if (!dailyRows) unavailable.push('daily_conversions');
    if (!customerRows) unavailable.push('auto_tagging');
    if (!clickRows) unavailable.push('clicks_7d');

    // Measurement review (conversion goals, enhanced conversions, tracking gaps). Flag off: not read, not returned.
    let measurement: Record<string, unknown> | null = null;
    if (isLeadLoopEnabled(process.env, ctx.connectedEmail)) {
      const extra = await loadMeasurementInputs((gaql) => runQuery(ctx, gaql));
      const findings = extra.actions
        ? reviewConversionGoals({ actions: extra.actions, goals: extra.goals, tracking: extra.tracking, leadLoopOn: true })
        : [];
      const gapResult = extra.dailyTotals
        ? findTrackingGaps(
            totalsByDay(
              extra.dailyTotals.map((d) => ({ date: d.date, conversions: d.conversions })),
              extra.dailyTotals.map((d) => ({ date: d.date, clicks: d.clicks })),
              today
            )
          )
        : null;
      measurement = {
        goals_review: findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          title_ar: finding.title_ar,
          reason_ar: finding.reason_ar,
          steps_ar: finding.steps_ar,
          ...(finding.actions ? { actions: finding.actions.map(cleanText) } : {}),
        })),
        enhanced_conversions: {
          leads: extra.tracking?.enhancedConversionsForLeads ?? 'unknown',
          customer_data_terms_accepted: extra.tracking?.acceptedCustomerDataTerms ?? 'unknown',
          web: 'not_readable_via_api',
        },
        tracking_gaps: gapResult
          ? { resolved_windows: gapResult.gaps, ongoing_silence: gapResult.ongoing }
          : 'unavailable',
        unavailable_checks: [
          ...(extra.actions ? [] : ['goal_actions']),
          ...(extra.goals ? [] : ['customer_goals']),
          ...(extra.tracking ? [] : ['conversion_tracking_setting']),
          ...(extra.dailyTotals ? [] : ['daily_totals']),
        ],
      };
    }

    // Landing page tag evidence (LANDING_CHECK_ENABLED): supporting only, the verdict above is untouched.
    const landingSupport = await landingSupportForVerdict({
      store: () => {
        try {
          return supabaseLandingCheckStore(createAdminClient());
        } catch {
          return null;
        }
      },
      accountId: ctx.accountId,
      verdict: result.verdict,
      now: ctx.now,
    });

    return okResult(
      {
        verdict: result.verdict,
        issues: result.issues.map((issue) => ({
          code: issue.code,
          reason_ar: issue.reason_ar,
          ...(issue.actions ? { actions: issue.actions } : {}),
        })),
        tracking: {
          enabled_actions: actions.filter((action) => action.status === 'ENABLED').length,
          total_actions: actions.length,
          clicks_7d: clicks7d,
          conversions_7d: conversions7d === null ? null : round(conversions7d, 2),
          auto_tagging: autoTagging === null ? 'unknown' : autoTagging ? 'on' : 'off',
        },
        actions: shownActions,
        unavailable_checks: unavailable,
        ...(measurement ? { measurement } : {}),
        ...(landingSupport ? { landing_page_evidence: landingSupport } : {}),
      },
      evidence
    );
  },
};
