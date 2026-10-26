import {
  DEFAULT_STEP_EXPIRY_MINUTES,
  EMAIL_LIFECYCLE_ACTIVATED_AT,
  HOLDOUT_PERCENT,
  JOURNEY_STEPS,
  MAX_PER_7_DAYS,
  MAX_SEND_ATTEMPTS,
  MIN_GAP_MS,
  SEND_WINDOW,
  WEEKLY_REPORT,
  type SendWindow,
  type Step,
  type WeeklyReportConfig,
} from '@/config/email-journeys';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import { isHoldout } from '@/lib/lifecycle/holdout';
import { currentJourney, type JourneyEvents, type JourneySubscription } from '@/lib/lifecycle/journey';
import { isInSendWindow, weeklyReportSlot, type WeeklySlot } from '@/lib/lifecycle/riyadh';
import type { CopyKey, EmailCategory, EmailCopy, JourneyId } from '@/lib/lifecycle/types';

/**
 * The heart of the lifecycle: decides, for a set of users, which mail (if any)
 * is due right now. It generalises lib/stages/plan.ts (#84) from "three stages"
 * to "seven journeys plus the weekly report".
 *
 * Pure on purpose: no database, no clock, no email. The runner (run.ts) feeds
 * it rows and acts on what comes back; the tests drive it with plain objects.
 *
 * Per user the planner evaluates two tracks and sends at most ONE mail:
 *   - journey: the latest due step of the user's current journey
 *   - weekly:  the open weekly report slot, for trialing and active subscribers
 * When both are due the one that has been waiting longest goes first; the other
 * follows once the 24 hour gap allows (it stays inside its own expiry).
 *
 * The weekly report is only offered to someone whose report for this Saudi week
 * already exists (`hasWeeklyReport`). It is written by a different job (the
 * optimize cron), and an offer the runner cannot deliver yet would sit first in
 * line (its due time is the Sunday slot, usually earlier than any journey step),
 * so the person's journey steps would expire unsent and, with the per-run cap,
 * people without a report would crowd out everyone else.
 */
export type PlanUser = {
  id: string;
  email: string | null;
  name: string | null;
  /** users.stage; null while a registration is unfinished. */
  stage: string | null;
  /** #81 flag: every optional category is off. */
  messagesOptOut: boolean;
  /** users.email_prefs: a missing key means "on". */
  emailPrefs: Record<string, unknown> | null;
  /** Hard bounce or complaint: nothing at all is sent. */
  emailSuppressedAt: string | null;
};

export type PlanLogRow = {
  templateKey: string;
  /**
   * 'sending' means a send is in flight right now. A claim stuck past its
   * lease is reported by the loader as 'failed', the same rule
   * public.claim_message applies, so it is retried instead of waiting forever.
   */
  status: 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  sentAt: string | null;
  /** null on rows written before the category column existed (all were optional mail). */
  category: string | null;
};

export type PlanContext = {
  user: PlanUser;
  subscription: JourneySubscription | null;
  events: JourneyEvents;
  logs: PlanLogRow[];
  /**
   * This Saudi week's weekly report exists for the person's selected Google Ads account (the same table, filters
   * and account choice as the weekly fact in lib/lifecycle/facts.ts). Read by loadContexts while a weekly slot is
   * open; false for contexts loaded without it, which are never planned for the weekly report.
   */
  hasWeeklyReport: boolean;
};

export type CopyMeta = Pick<EmailCopy, 'category' | 'approved'>;

export type PlanConfig = {
  steps: Record<JourneyId, Step[]>;
  /** ISO. null = nothing is ever planned. */
  activatedAt: string | null;
  sendWindow: SendWindow;
  minGapMs: number;
  maxPer7Days: number;
  maxAttempts: number;
  weekly: WeeklyReportConfig;
  isHeldOut: (userId: string) => boolean;
};

export type PlanInput = {
  now: Date;
  contexts: PlanContext[];
  copy?: Record<CopyKey, CopyMeta>;
  config?: Partial<PlanConfig>;
};

export const IGNORE_REASONS = [
  'not_activated',
  'no_email',
  'suppressed',
  'no_journey',
  'holdout',
  'nothing_due',
  'no_weekly_report',
  'before_activation',
  'not_approved',
  'opted_out',
  'category_off',
  'expired',
  'outside_window',
  'min_gap',
  'max_per_7_days',
  // broadcasts only
  'already_handled',
  'already_planned',
  'not_in_segment',
] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export type PlannedSend = {
  kind: 'journey' | 'weekly' | 'broadcast';
  userId: string;
  copyKey: CopyKey;
  /** message_log template key (equals copyKey except weekly and broadcast mail). */
  templateKey: string;
  category: EmailCategory;
  journey: JourneyId | null;
  dueAt: string;
};

export type SkipReason = 'superseded' | 'expired' | 'opted_out' | 'category_off' | 'suppressed' | 'no_email';

/** A step that will never be sent, recorded in message_log so it is not considered again. */
export type PlannedSkip = {
  userId: string;
  copyKey: CopyKey;
  templateKey: string;
  category: EmailCategory;
  reason: SkipReason;
};

export type EmailPlan = {
  sends: PlannedSend[];
  skips: PlannedSkip[];
  /** One count per (user, track) that produced no mail this run, under the reason it stopped. */
  ignored: Record<IgnoreReason, number>;
};

export function emptyIgnored(): Record<IgnoreReason, number> {
  return Object.fromEntries(IGNORE_REASONS.map((reason) => [reason, 0])) as Record<IgnoreReason, number>;
}

export function resolvePlanConfig(overrides: Partial<PlanConfig> = {}): PlanConfig {
  const percent = HOLDOUT_PERCENT;
  return {
    steps: JOURNEY_STEPS,
    activatedAt: EMAIL_LIFECYCLE_ACTIVATED_AT,
    sendWindow: SEND_WINDOW,
    minGapMs: MIN_GAP_MS,
    maxPer7Days: MAX_PER_7_DAYS,
    maxAttempts: MAX_SEND_ATTEMPTS,
    weekly: WEEKLY_REPORT,
    isHeldOut: (userId) => isHoldout(userId, percent),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers shared with broadcast.ts
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The user cannot be mailed at all: no address, or the address bounced. */
export function unreachableReason(user: PlanUser): 'no_email' | 'suppressed' | null {
  if (user.emailSuppressedAt) return 'suppressed';
  if (!user.email) return 'no_email';
  return null;
}

/**
 * Category switch. Mirrors the contract: transactional cannot be switched off,
 * messages_opt_out turns every other category off, otherwise a missing key
 * in email_prefs means on and only an explicit `false` turns a category off.
 */
export function categoryState(user: PlanUser, category: EmailCategory): 'on' | 'opted_out' | 'category_off' {
  if (category === 'transactional') return 'on';
  if (user.messagesOptOut) return 'opted_out';
  return user.emailPrefs && user.emailPrefs[category] === false ? 'category_off' : 'on';
}

/**
 * Did this row settle the template for good? A failed row is retried until it
 * has used all its attempts; anything else (sent, skipped, in flight) is done.
 */
export function isHandled(row: PlanLogRow | undefined, maxAttempts: number): boolean {
  if (!row) return false;
  if (row.status === 'failed') return row.attempts >= maxAttempts;
  return true;
}

export function indexLogs(logs: PlanLogRow[]): Map<string, PlanLogRow> {
  const map = new Map<string, PlanLogRow>();
  for (const row of logs) map.set(row.templateKey, row);
  return map;
}

export type DeliveryGuard = 'outside_window' | 'min_gap' | 'max_per_7_days';

/**
 * The three limits that apply to every optional mail: the send window, the
 * 24 hour gap and the 3 in 7 days cap (a transactional mail answers to the window only). Only `sent` rows of a category other
 * than transactional count (the welcome counts; legacy rows without a category
 * count too, they were all optional). Window first, so the reason a dry run
 * reports is the one that clears soonest.
 */
export function deliveryGuard(args: {
  now: Date;
  logs: PlanLogRow[];
  config: Pick<PlanConfig, 'sendWindow' | 'minGapMs' | 'maxPer7Days'>;
  /**
   * A transactional mail (a billing notice that rides a journey, like the day 12 card notice) is held back only by
   * the send window. The gap and the 7 day cap are for optional mail, and it never counts toward them (rows of
   * category transactional are skipped below), so it cannot push another mail out either.
   */
  transactional?: boolean;
}): DeliveryGuard | null {
  const { now, logs, config } = args;
  if (!isInSendWindow(now, config.sendWindow)) return 'outside_window';
  if (args.transactional) return null;

  const nowMs = now.getTime();
  let last = Number.NEGATIVE_INFINITY;
  let inLastWeek = 0;
  for (const row of logs) {
    if (row.status !== 'sent' || !row.sentAt || row.category === 'transactional') continue;
    const sentMs = Date.parse(row.sentAt);
    if (!Number.isFinite(sentMs)) continue;
    if (sentMs > last) last = sentMs;
    if (sentMs > nowMs - 7 * DAY_MS) inLastWeek += 1;
  }
  if (nowMs - last < config.minGapMs) return 'min_gap';
  if (inLastWeek >= config.maxPer7Days) return 'max_per_7_days';
  return null;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

type Candidate = PlannedSend & { dueMs: number };
type Track = { candidate: Candidate | null; skips: PlannedSkip[]; reason: IgnoreReason | null };

export function planEmails(input: PlanInput): EmailPlan {
  const config = resolvePlanConfig(input.config);
  const copy = input.copy ?? EMAIL_COPY;
  const ignored = emptyIgnored();
  const sends: PlannedSend[] = [];
  const skips: PlannedSkip[] = [];

  const activatedMs = config.activatedAt ? Date.parse(config.activatedAt) : Number.NaN;
  if (!Number.isFinite(activatedMs)) {
    ignored.not_activated = input.contexts.length;
    return { sends, skips, ignored };
  }

  const slot = weeklyReportSlot(input.now, config.weekly);

  for (const ctx of input.contexts) {
    const unreachable = unreachableReason(ctx.user);
    if (unreachable) {
      ignored[unreachable] += 1;
      continue;
    }

    const logs = indexLogs(ctx.logs);
    const journey = evaluateJourney({ ctx, logs, now: input.now, config, copy, activatedMs });
    const weekly = slot ? evaluateWeekly({ ctx, logs, slot, config, copy, activatedMs }) : null;

    skips.push(...journey.skips);
    const candidates = [journey.candidate, weekly?.candidate ?? null].filter(
      (candidate): candidate is Candidate => candidate !== null
    );

    if (candidates.length === 0) {
      if (journey.reason) ignored[journey.reason] += 1;
      if (weekly?.reason) ignored[weekly.reason] += 1;
      continue;
    }

    // A billing notice (transactional category) goes before everything else. Otherwise the mail that has waited
    // longest goes first; a journey step wins a tie.
    const transactionalFirst = (candidate: Candidate) => (candidate.category === 'transactional' ? 0 : 1);
    candidates.sort(
      (a, b) =>
        transactionalFirst(a) - transactionalFirst(b) || a.dueMs - b.dueMs || (a.kind === 'journey' ? -1 : 1)
    );
    const pick = candidates[0]!;

    const blocked = deliveryGuard({
      now: input.now,
      logs: ctx.logs,
      config,
      transactional: pick.category === 'transactional',
    });
    if (blocked) {
      ignored[blocked] += 1;
      continue;
    }

    const { dueMs: _dueMs, ...send } = pick;
    sends.push(send);
  }

  sends.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.userId.localeCompare(b.userId));
  return { sends, skips, ignored };
}

function evaluateJourney(args: {
  ctx: PlanContext;
  logs: Map<string, PlanLogRow>;
  now: Date;
  config: PlanConfig;
  copy: Record<CopyKey, CopyMeta>;
  activatedMs: number;
}): Track {
  const { ctx, logs, now, config, copy, activatedMs } = args;
  const none = (reason: IgnoreReason): Track => ({ candidate: null, skips: [], reason });

  const entered = currentJourney({ stage: ctx.user.stage, subscription: ctx.subscription, events: ctx.events });
  if (!entered) return none('no_journey');
  const enteredMs = Date.parse(entered.enteredAt);
  const nowMs = now.getTime();
  const steps = [...config.steps[entered.journey]].sort((a, b) => a.afterMinutes - b.afterMinutes);

  // The holdout is how we learn whether the emails work. Payment trouble is
  // the one journey nobody should miss, so past_due is exempt. A held out
  // person still gets the steps whose copy is transactional (the day 12 card
  // notice is about a charge that is coming, not a nudge); every other step
  // is skipped for them without a trace in the log.
  const heldOut = entered.journey !== 'past_due' && config.isHeldOut(ctx.user.id);
  if (heldOut && !steps.some((step) => copy[step.copyKey].category === 'transactional')) return none('holdout');

  // A later step that already went out makes every earlier one obsolete.
  let sentAfterMinutes = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (logs.get(step.copyKey)?.status === 'sent') sentAfterMinutes = Math.max(sentAfterMinutes, step.afterMinutes);
  }

  type Pending = { step: Step; dueMs: number };
  const pending: Pending[] = [];
  const skips: PlannedSkip[] = [];
  let blocker: IgnoreReason | null = null;

  for (const step of steps) {
    const dueMs = enteredMs + step.afterMinutes * 60_000;
    if (dueMs > nowMs) break; // sorted: nothing later is due either
    if (isHandled(logs.get(step.copyKey), config.maxAttempts)) continue;

    const stepCopy = copy[step.copyKey];
    if (heldOut && stepCopy.category !== 'transactional') {
      blocker = 'holdout';
      continue;
    }
    if (dueMs < activatedMs) {
      blocker = 'before_activation';
      continue;
    }
    if (!stepCopy.approved) {
      blocker = 'not_approved';
      continue;
    }
    const state = categoryState(ctx.user, stepCopy.category);
    if (state !== 'on') {
      blocker = state;
      continue;
    }
    const expiryMs = (step.expiresAfterMinutes ?? DEFAULT_STEP_EXPIRY_MINUTES) * 60_000;
    if (nowMs - dueMs > expiryMs) {
      blocker = 'expired';
      skips.push(skipFor(ctx.user.id, step.copyKey, stepCopy.category, 'expired'));
      continue;
    }
    pending.push({ step, dueMs });
  }

  const live = pending.filter((item) => item.step.afterMinutes > sentAfterMinutes);
  const candidateItem = live[live.length - 1] ?? null;
  for (const item of pending) {
    if (item === candidateItem) continue;
    skips.push(skipFor(ctx.user.id, item.step.copyKey, copy[item.step.copyKey].category, 'superseded'));
  }

  if (!candidateItem) {
    if (heldOut) return { candidate: null, skips, reason: 'holdout' };
    return { candidate: null, skips, reason: pending.length > 0 ? 'nothing_due' : blocker ?? 'nothing_due' };
  }

  const stepCopy = copy[candidateItem.step.copyKey];
  return {
    candidate: {
      kind: 'journey',
      userId: ctx.user.id,
      copyKey: candidateItem.step.copyKey,
      templateKey: candidateItem.step.copyKey,
      category: stepCopy.category,
      journey: entered.journey,
      dueAt: new Date(candidateItem.dueMs).toISOString(),
      dueMs: candidateItem.dueMs,
    },
    skips,
    reason: null,
  };
}

function evaluateWeekly(args: {
  ctx: PlanContext;
  logs: Map<string, PlanLogRow>;
  slot: WeeklySlot;
  config: PlanConfig;
  copy: Record<CopyKey, CopyMeta>;
  activatedMs: number;
}): Track | null {
  const { ctx, logs, slot, config, copy, activatedMs } = args;
  const status = ctx.subscription?.status;
  if (status !== 'trialing' && status !== 'active') return null;

  const none = (reason: IgnoreReason): Track => ({ candidate: null, skips: [], reason });
  if (isHandled(logs.get(slot.templateKey), config.maxAttempts)) return none('nothing_due');
  if (slot.dueAt.getTime() < activatedMs) return none('before_activation');

  // The weekly report is exempt from the holdout: it is the product working
  // for a paying (or trialing) customer, not a nudge.
  const weeklyCopy = copy.weekly_report;
  if (!weeklyCopy.approved) return none('not_approved');
  const state = categoryState(ctx.user, weeklyCopy.category);
  if (state !== 'on') return none(state);
  // Not written yet (or never, for an account the optimize cron cannot read): nothing to send, and nothing that
  // may stand in front of the person's journey steps.
  if (!ctx.hasWeeklyReport) return none('no_weekly_report');

  return {
    candidate: {
      kind: 'weekly',
      userId: ctx.user.id,
      copyKey: 'weekly_report',
      templateKey: slot.templateKey,
      category: weeklyCopy.category,
      journey: null,
      dueAt: slot.dueAt.toISOString(),
      dueMs: slot.dueAt.getTime(),
    },
    skips: [],
    reason: null,
  };
}

function skipFor(userId: string, copyKey: CopyKey, category: EmailCategory, reason: SkipReason): PlannedSkip {
  return { userId, copyKey, templateKey: copyKey, category, reason };
}
