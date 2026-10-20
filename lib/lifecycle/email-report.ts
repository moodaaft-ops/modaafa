import { stageForEvent, stageRank } from '@/lib/stages/types';
import { COPY_KEYS, type JourneyId } from './types';
import type { ReportStep } from './report-steps';

/**
 * The email section of /operations/funnel, as pure arithmetic over rows the
 * loader reads (lib/lifecycle/load-email-report.ts). No database, no clock but
 * `now`, so every number can be checked against a hand count.
 *
 * Definitions (printed on the page too):
 *  - one row per template; weekly_report_<year>-W<week> keys are one row
 *  - sent       = message_log rows with status 'sent'
 *  - delivered / opened / clicked / bounced / complained = rows whose
 *    delivered_at / opened_at / clicked_at / bounced_at / complained_at is set
 *    (the Resend webhook writes them). Percentages are of `sent`.
 *  - opt-outs   = people whose messages_opt_out_at falls within 7 days after
 *    their LAST sent mail; the opt-out counts against that one template.
 *    (Category switches on the preferences page carry no time and are not here.)
 *  - reached the next stage = of the people who got the template, how many
 *    reached the journey's next stage inside the window after the mail
 *    (7 days; 14 for the trial, which pays at its end). Only people whose
 *    window is already closed are counted, and only people who had not already
 *    moved on when the mail went out.
 *  - holdout    = people the engine deliberately did not mail (a stable hash
 *    of the user id). For the same template, the same rule is applied to
 *    holdout users in the same journey with the moment the mail WOULD have
 *    been due (journey entry + the step's delay) in place of the send time,
 *    and only for steps due after the lifecycle went live.
 */
export const OPT_OUT_ATTRIBUTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type EmailLogRow = {
  userId: string;
  template: string;
  /** message_log.copy_key; null on rows written before it existed. */
  copyKey: string | null;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
};

export type ReportEvent = { userId: string; eventType: string; createdAt: string };
export type ReportOptOut = { userId: string; at: string };
export type ReportTrial = { userId: string; startedAt: string; endsAt: string | null; canceledAt: string | null };

export type EmailReportInput = {
  now: Date;
  logs: EmailLogRow[];
  /** Every user id, for the size of the holdout. */
  userIds: string[];
  optOuts: ReportOptOut[];
  events: ReportEvent[];
  /** Trial subscriptions (trial_ends_at set). null = could not be read: the trial comparison is then unavailable. */
  trials: ReportTrial[] | null;
  steps: ReportStep[];
  /** EMAIL_LIFECYCLE_ACTIVATED_AT. null = nothing was ever due, so there is no holdout comparison. */
  activatedAt: string | null;
  holdoutPercent: number;
  isHoldout: (userId: string) => boolean;
  /** False when message_log has no delivery columns yet (migration not run): the counts after `sent` mean nothing. */
  engagementTracked: boolean;
};

export type NextStageCell = { eligible: number; reached: number };

export type EmailReportRow = {
  /** Template key, weekly keys folded into weekly_report. */
  group: string;
  label: string;
  journey: JourneyId | null;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  optOuts: number;
  bounced: number;
  complained: number;
  /** null = this template has no next funnel stage (weekly report, billing mail, broadcasts). */
  next: {
    targetLabel: string;
    windowDays: number;
    recipients: NextStageCell;
    /** null = no holdout comparison exists for this template (everyone gets it, or the trial data was unreadable). */
    holdout: NextStageCell | null;
  } | null;
};

export type EmailReportTotals = {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  optOuts: number;
  bounced: number;
  complained: number;
};

export type EmailReport = {
  rows: EmailReportRow[];
  totals: EmailReportTotals;
  holdout: { users: number; total: number; percent: number };
  activatedAt: string | null;
  engagementTracked: boolean;
};

// ---------------------------------------------------------------------------
// Journeys: where each one starts and which funnel stage is "next"
// ---------------------------------------------------------------------------

type EntryKind = 'registration_completed' | 'ads_account_connected' | 'first_analysis_viewed' | 'trial';

type JourneyRule = {
  entry: EntryKind;
  /** stageRank of the stage the journey is trying to reach. */
  targetRank: number;
  targetLabel: string;
  windowDays: number;
  /** Starting the free trial also counts as reaching the target (the plan is there to get people to start it). */
  trialStartCounts?: boolean;
};

export const JOURNEY_RULES: Partial<Record<JourneyId, JourneyRule>> = {
  registered: { entry: 'registration_completed', targetRank: stageRank('connected'), targetLabel: 'ربطوا الحساب', windowDays: 7 },
  connected: { entry: 'ads_account_connected', targetRank: stageRank('analysis_viewed'), targetLabel: 'شافوا التحليل', windowDays: 7 },
  plan_ready: {
    entry: 'first_analysis_viewed',
    targetRank: stageRank('subscribed'),
    targetLabel: 'بدؤوا التجربة أو دفعوا',
    windowDays: 7,
    trialStartCounts: true,
  },
  trial: { entry: 'trial', targetRank: stageRank('subscribed'), targetLabel: 'دفعوا الاشتراك', windowDays: 14 },
};

/** Templates everyone gets (holdout included), so they have a next stage but no holdout to compare with. */
const NO_BASELINE_GROUPS: Record<string, JourneyId> = { welcome_ads_connect: 'registered' };

export const TEMPLATE_LABEL_AR: Record<string, string> = {
  welcome_ads_connect: 'الترحيب بعد التسجيل',
  registered_1d: 'سجّل وما ربط، بعد يوم',
  registered_3d: 'سجّل وما ربط، بعد 3 أيام',
  registered_7d: 'سجّل وما ربط، بعد 7 أيام',
  connected_3h: 'ربط وما شاف التحليل، بعد 3 ساعات',
  connected_1d: 'ربط وما شاف التحليل، بعد يوم',
  plan_ready_1d: 'شاف الخطة وما بدأ التجربة، بعد يوم',
  plan_ready_3d: 'شاف الخطة وما بدأ التجربة، بعد 3 أيام',
  plan_ready_7d: 'شاف الخطة وما بدأ التجربة، بعد 7 أيام',
  trial_d1: 'التجربة، اليوم 1',
  trial_d4: 'التجربة، اليوم 4',
  trial_d9: 'التجربة، اليوم 9',
  trial_lapsed_2d: 'خلصت التجربة بدون دفع، بعد يومين',
  trial_lapsed_14d: 'خلصت التجربة بدون دفع، بعد 14 يوم',
  canceled_1d: 'ألغى الاشتراك، بعد يوم',
  canceled_30d: 'ألغى الاشتراك، بعد 30 يوم',
  past_due_3d: 'الدفعة ما مرت، بعد 3 أيام',
  weekly_report: 'التقرير الأسبوعي',
  monthly_report: 'التقرير الشهري',
  tx_subscription_welcome: 'تأكيد الاشتراك',
  tx_trial_ending: 'التجربة قربت تخلص',
  tx_payment_failed: 'الدفعة ما مرت (تنبيه فوري)',
  guard_alert: 'الحارس الصباحي (تنبيه الحساب)',
  broadcast_chat_relaunch: 'إعلان: رجوع المحادثة',
};

const WEEKLY_TEMPLATE = /^weekly_report_\d{4}-W\d{2}$/;

/** The row a message_log template belongs to. */
export function groupOf(template: string, copyKey: string | null): string {
  if (WEEKLY_TEMPLATE.test(template)) return 'weekly_report';
  if (copyKey && template.startsWith(copyKey)) return copyKey;
  return template;
}

export function labelOf(group: string): string {
  return TEMPLATE_LABEL_AR[group] ?? group;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** count / total as a share, null when there is nothing to divide by. */
export function share(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

/** Recipients minus holdout, in percentage points; null when either side has no one to measure. */
export function liftPoints(recipients: NextStageCell, holdout: NextStageCell | null): number | null {
  if (!holdout || recipients.eligible === 0 || holdout.eligible === 0) return null;
  return Math.round((recipients.reached / recipients.eligible - holdout.reached / holdout.eligible) * 1000) / 10;
}

type Timeline = {
  first: Map<string, number>;
  /** reach[rank] = earliest time the person had reached `rank` or any later stage (Infinity = never). */
  reach: number[];
};

function buildTimelines(events: ReportEvent[]): Map<string, Timeline> {
  const timelines = new Map<string, Timeline>();
  for (const event of events) {
    const ms = Date.parse(event.createdAt);
    if (!Number.isFinite(ms)) continue;
    let timeline = timelines.get(event.userId);
    if (!timeline) {
      timeline = { first: new Map(), reach: [Infinity, Infinity, Infinity, Infinity, Infinity] };
      timelines.set(event.userId, timeline);
    }
    if (ms < (timeline.first.get(event.eventType) ?? Infinity)) timeline.first.set(event.eventType, ms);
    const stage = stageForEvent(event.eventType);
    if (!stage) continue;
    const rank = stageRank(stage);
    for (let r = 1; r <= rank; r += 1) timeline.reach[r] = Math.min(timeline.reach[r], ms);
  }
  return timelines;
}

type Outcome = 'hit' | 'miss' | 'skip';

/**
 * Did a person reach the target inside the window that starts at `anchor`?
 * skip = not measurable: the window is still open, or they were already there.
 * `trialStartMs` is when their latest trial began (Infinity when they never had one).
 */
function evaluate(
  rule: JourneyRule,
  timeline: Timeline | undefined,
  anchor: number,
  nowMs: number,
  trialStartMs: number
): Outcome {
  const window = rule.windowDays * DAY_MS;
  if (anchor + window > nowMs) return 'skip';
  let reachedAt = timeline?.reach[rule.targetRank] ?? Infinity;
  if (rule.trialStartCounts) reachedAt = Math.min(reachedAt, trialStartMs);
  if (reachedAt <= anchor) return 'skip';
  return reachedAt <= anchor + window ? 'hit' : 'miss';
}

type Accumulator = {
  group: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  optOuts: number;
  bounced: number;
  complained: number;
  recipients: NextStageCell;
  holdout: NextStageCell;
};

const newAccumulator = (group: string): Accumulator => ({
  group,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  optOuts: 0,
  bounced: 0,
  complained: 0,
  recipients: { eligible: 0, reached: 0 },
  holdout: { eligible: 0, reached: 0 },
});

export function computeEmailReport(input: EmailReportInput): EmailReport {
  const nowMs = input.now.getTime();
  const activatedMs = input.activatedAt ? Date.parse(input.activatedAt) : NaN;
  const timelines = buildTimelines(input.events);
  const stepByGroup = new Map(input.steps.map((step) => [step.copyKey as string, step]));

  const rules = (group: string): { rule: JourneyRule; journey: JourneyId; baseline: boolean } | null => {
    const step = stepByGroup.get(group);
    if (step) {
      const rule = JOURNEY_RULES[step.journey];
      return rule ? { rule, journey: step.journey, baseline: true } : null;
    }
    const journey = NO_BASELINE_GROUPS[group];
    const rule = journey ? JOURNEY_RULES[journey] : undefined;
    return journey && rule ? { rule, journey, baseline: false } : null;
  };

  // One free trial per person (a billing guard enforces it); if there are ever two, the first one counts.
  const trialByUser = new Map<string, ReportTrial>();
  for (const trial of input.trials ?? []) {
    const current = trialByUser.get(trial.userId);
    if (!current || Date.parse(trial.startedAt) < Date.parse(current.startedAt)) trialByUser.set(trial.userId, trial);
  }
  const trialsReadable = input.trials !== null;
  const trialStartOf = (userId: string): number => {
    const trial = trialByUser.get(userId);
    const ms = trial ? Date.parse(trial.startedAt) : NaN;
    return Number.isFinite(ms) ? ms : Infinity;
  };
  /** Counted only when every table it needs could be read; otherwise the cell is reported as unavailable. */
  const measurable = (rule: JourneyRule) => trialsReadable || (!rule.trialStartCounts && rule.entry !== 'trial');

  const groups = new Map<string, Accumulator>();
  const accumulator = (group: string) => {
    let acc = groups.get(group);
    if (!acc) {
      acc = newAccumulator(group);
      groups.set(group, acc);
    }
    return acc;
  };
  // Every configured template and the two that are not journey steps get a row even before anything was sent.
  for (const step of input.steps) accumulator(step.copyKey);
  accumulator('welcome_ads_connect');
  accumulator('weekly_report');

  // ---- Sent mail: engagement counts, recipients' next-stage outcome, and the per-person list for opt-outs.
  const sentByUser = new Map<string, Array<{ ms: number; group: string }>>();
  for (const log of input.logs) {
    if (log.status !== 'sent') continue;
    const group = groupOf(log.template, log.copyKey);
    const acc = accumulator(group);
    acc.sent += 1;
    if (log.deliveredAt) acc.delivered += 1;
    if (log.openedAt) acc.opened += 1;
    if (log.clickedAt) acc.clicked += 1;
    if (log.bouncedAt) acc.bounced += 1;
    if (log.complainedAt) acc.complained += 1;

    // Everything below needs the send time; a sent row without one still counts above.
    const sentMs = log.sentAt ? Date.parse(log.sentAt) : NaN;
    if (!Number.isFinite(sentMs)) continue;
    const list = sentByUser.get(log.userId) ?? [];
    list.push({ ms: sentMs, group });
    sentByUser.set(log.userId, list);

    const info = rules(group);
    if (info && measurable(info.rule)) {
      const outcome = evaluate(info.rule, timelines.get(log.userId), sentMs, nowMs, trialStartOf(log.userId));
      if (outcome !== 'skip') {
        acc.recipients.eligible += 1;
        if (outcome === 'hit') acc.recipients.reached += 1;
      }
    }
  }

  // ---- Opt-outs count against the last mail the person got before opting out, if it was recent.
  for (const optOut of input.optOuts) {
    const at = Date.parse(optOut.at);
    if (!Number.isFinite(at)) continue;
    let last: { ms: number; group: string } | null = null;
    for (const sent of sentByUser.get(optOut.userId) ?? []) {
      if (sent.ms <= at && (!last || sent.ms > last.ms)) last = sent;
    }
    if (last && at - last.ms <= OPT_OUT_ATTRIBUTION_DAYS * DAY_MS) accumulator(last.group).optOuts += 1;
  }

  // ---- Holdout users: what they did after the moment the mail would have been due.
  const holdoutUserIds = new Set(input.userIds.filter((id) => input.isHoldout(id)));
  if (Number.isFinite(activatedMs)) {
    for (const step of input.steps) {
      const rule = JOURNEY_RULES[step.journey];
      if (!rule || !measurable(rule)) continue;
      const acc = accumulator(step.copyKey);
      for (const userId of holdoutUserIds) {
        const timeline = timelines.get(userId);
        let entryMs: number | undefined;
        const trial = trialByUser.get(userId);
        if (rule.entry === 'trial') entryMs = trial ? Date.parse(trial.startedAt) : undefined;
        else entryMs = timeline?.first.get(rule.entry);
        if (entryMs === undefined || !Number.isFinite(entryMs)) continue;

        const anchor = entryMs + step.afterMinutes * MINUTE_MS;
        // The step could only have been sent if it fell due after the lifecycle went live.
        if (anchor < activatedMs) continue;
        if (rule.entry === 'trial' && trial) {
          const endsMs = trial.endsAt ? Date.parse(trial.endsAt) : NaN;
          const canceledMs = trial.canceledAt ? Date.parse(trial.canceledAt) : NaN;
          // No longer trialing when the mail would have gone out: it would not have been sent.
          if (Number.isFinite(endsMs) && anchor > endsMs) continue;
          if (Number.isFinite(canceledMs) && canceledMs <= anchor) continue;
        }
        const outcome = evaluate(rule, timeline, anchor, nowMs, trialStartOf(userId));
        if (outcome === 'skip') continue;
        acc.holdout.eligible += 1;
        if (outcome === 'hit') acc.holdout.reached += 1;
      }
    }
  }

  // ---- Rows in the order of the contract's copy keys, then anything else alphabetically.
  const order = new Map<string, number>(COPY_KEYS.map((key, index) => [key as string, index]));
  const rank = (group: string) => order.get(group) ?? Number.MAX_SAFE_INTEGER;
  const rows: EmailReportRow[] = [...groups.values()]
    .sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group))
    .map((acc) => {
      const info = rules(acc.group);
      return {
        group: acc.group,
        label: labelOf(acc.group),
        journey: info?.journey ?? null,
        sent: acc.sent,
        delivered: acc.delivered,
        opened: acc.opened,
        clicked: acc.clicked,
        optOuts: acc.optOuts,
        bounced: acc.bounced,
        complained: acc.complained,
        next:
          info && measurable(info.rule)
            ? {
                targetLabel: info.rule.targetLabel,
                windowDays: info.rule.windowDays,
                recipients: acc.recipients,
                holdout: info.baseline ? acc.holdout : null,
              }
            : null,
      };
    });

  const sum = (pick: (row: EmailReportRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    rows,
    totals: {
      sent: sum((row) => row.sent),
      delivered: sum((row) => row.delivered),
      opened: sum((row) => row.opened),
      clicked: sum((row) => row.clicked),
      optOuts: sum((row) => row.optOuts),
      bounced: sum((row) => row.bounced),
      complained: sum((row) => row.complained),
    },
    holdout: { users: holdoutUserIds.size, total: input.userIds.length, percent: input.holdoutPercent },
    activatedAt: input.activatedAt,
    engagementTracked: input.engagementTracked,
  };
}

// ---------------------------------------------------------------------------
// Presentation: the same cells feed the page and the CSV, so they cannot drift
// ---------------------------------------------------------------------------

export const NONE_AR = 'لا يوجد';
export const NOT_APPLICABLE_AR = 'لا ينطبق';
export const UNAVAILABLE_AR = 'غير متاح';

/** 0.4 -> "40%", 1/3 -> "33.3%"; no one to divide by -> "لا يوجد". Latin digits. */
export function formatShare(count: number, total: number): string {
  const value = share(count, total);
  return value === null ? NONE_AR : `${Math.round(value * 1000) / 10}%`;
}

/**
 * The gap between recipients and the comparison group, in words. No sign
 * characters at the front (a spreadsheet reads a leading "-" or "+" as a formula).
 */
export function formatLift(points: number | null): string {
  if (points === null) return NONE_AR;
  if (points === 0) return 'بدون فرق';
  return `${Math.abs(points)} نقطة ${points > 0 ? 'أعلى' : 'أقل'}`;
}

export const EMAIL_REPORT_HEADER_AR = [
  'الرسالة',
  'أُرسلت',
  'وصلت',
  'نسبة الوصول',
  'انفتحت',
  'نسبة الفتح',
  'انضغط الرابط',
  'نسبة الضغط',
  'أوقفوا الرسائل بعدها',
  'ارتدّت',
  'شكاوى',
  'الهدف',
  'مدة الحساب (أيام)',
  'المستلمون: المحسوبون',
  'المستلمون: وصلوا',
  'المستلمون: النسبة',
  'مجموعة المقارنة: المحسوبون',
  'مجموعة المقارنة: وصلوا',
  'مجموعة المقارنة: النسبة',
  'الفرق',
] as const;

type Cells = Array<string | number>;

/** One row of the table, as text, in the order of EMAIL_REPORT_HEADER_AR. */
export function emailReportRowCells(row: EmailReportRow, engagementTracked = true): Cells {
  // Before the delivery columns exist these counts are not "zero", they are unknown.
  const engaged = (count: number) => (engagementTracked ? count : UNAVAILABLE_AR);
  const engagedShare = (count: number) => (engagementTracked ? formatShare(count, row.sent) : UNAVAILABLE_AR);
  const next = row.next;
  const holdout = next?.holdout ?? null;
  return [
    row.label,
    row.sent,
    engaged(row.delivered),
    engagedShare(row.delivered),
    engaged(row.opened),
    engagedShare(row.opened),
    engaged(row.clicked),
    engagedShare(row.clicked),
    row.optOuts,
    engaged(row.bounced),
    engaged(row.complained),
    next ? next.targetLabel : NOT_APPLICABLE_AR,
    next ? next.windowDays : '',
    next ? next.recipients.eligible : '',
    next ? next.recipients.reached : '',
    next ? formatShare(next.recipients.reached, next.recipients.eligible) : '',
    holdout ? holdout.eligible : '',
    holdout ? holdout.reached : '',
    next ? (holdout ? formatShare(holdout.reached, holdout.eligible) : NONE_AR) : '',
    next ? formatLift(liftPoints(next.recipients, holdout)) : '',
  ];
}

export function emailReportTotalCells(report: EmailReport): Cells {
  const { totals } = report;
  const engaged = (count: number) => (report.engagementTracked ? count : UNAVAILABLE_AR);
  const engagedShare = (count: number) =>
    report.engagementTracked ? formatShare(count, totals.sent) : UNAVAILABLE_AR;
  return [
    'المجموع',
    totals.sent,
    engaged(totals.delivered),
    engagedShare(totals.delivered),
    engaged(totals.opened),
    engagedShare(totals.opened),
    engaged(totals.clicked),
    engagedShare(totals.clicked),
    totals.optOuts,
    engaged(totals.bounced),
    engaged(totals.complained),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ];
}
