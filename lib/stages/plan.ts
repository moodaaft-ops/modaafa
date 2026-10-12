import type { FollowupStep } from '@/config/stage-followups';
import {
  STAGE_ENTRY_EVENT,
  type UserEventType,
  type UserStage,
} from '@/lib/stages/types';

/**
 * Decides, for a set of users, which follow-up (if any) is due right now.
 * Pure on purpose: no database, no clock, no email. The runner feeds it rows
 * and acts on what comes back, and the tests drive it with plain objects.
 */
export type PlanUser = {
  id: string;
  name: string | null;
  email: string | null;
  stage: UserStage;
  messagesOptOut: boolean;
  /** Has a trialing / active / past_due subscription row. */
  hasSubscription: boolean;
};

export type PlanLogRow = {
  templateKey: string;
  /**
   * 'sending' means a send is in flight right now. A claim that has been
   * stuck past its lease is reported by the loader as 'failed', the same rule
   * public.claim_message applies, so it is retried instead of waiting forever.
   */
  status: 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  sentAt: string | null;
};

export type PlanInput = {
  now: Date;
  users: PlanUser[];
  /** ISO time of each event, per user. Only registration and stage-entry events are read. */
  eventsByUser: Map<string, Partial<Record<UserEventType, string>>>;
  /** message_log rows per user (any template, including other tasks'). */
  logsByUser: Map<string, PlanLogRow[]>;
  steps: Partial<Record<UserStage, FollowupStep[]>>;
  cohortStart: string | null;
  minGapMs: number;
  maxAttempts: number;
};

export type PlannedSend = {
  userId: string;
  stage: UserStage;
  stepKey: string;
  dueAt: string;
};

export type PlannedSkip = {
  userId: string;
  stage: UserStage;
  stepKey: string;
  reason: 'superseded';
};

export type IgnoreReason =
  | 'before_cohort'
  | 'no_registration_event'
  | 'no_cohort'
  | 'opted_out'
  | 'no_email'
  | 'has_subscription'
  | 'no_steps_for_stage'
  | 'no_entry_event'
  | 'nothing_due'
  | 'daily_limit';

export type Plan = {
  sends: PlannedSend[];
  skips: PlannedSkip[];
  ignored: Record<IgnoreReason, number>;
};

export function planFollowups(input: PlanInput): Plan {
  const ignored = emptyIgnored();
  const sends: PlannedSend[] = [];
  const skips: PlannedSkip[] = [];
  const nowMs = input.now.getTime();
  const cohortMs = input.cohortStart ? Date.parse(input.cohortStart) : NaN;

  for (const user of input.users) {
    if (!Number.isFinite(cohortMs)) {
      ignored.no_cohort += 1;
      continue;
    }
    // The registration_completed event is written when the address is
    // confirmed, and only for sign-ups made after the tracking went live.
    // Anyone without it (everyone who registered earlier, or never confirmed)
    // is outside the cohort for good.
    const events = input.eventsByUser.get(user.id) ?? {};
    const registeredMs = events.registration_completed ? Date.parse(events.registration_completed) : NaN;
    if (!Number.isFinite(registeredMs)) {
      ignored.no_registration_event += 1;
      continue;
    }
    if (registeredMs < cohortMs) {
      ignored.before_cohort += 1;
      continue;
    }
    if (user.messagesOptOut) {
      ignored.opted_out += 1;
      continue;
    }
    if (!user.email) {
      ignored.no_email += 1;
      continue;
    }
    if (user.hasSubscription) {
      ignored.has_subscription += 1;
      continue;
    }

    // Only the user's CURRENT stage is looked at. This is the whole of
    // "stop the old stage's messages when the user moves on": steps of a
    // stage the user has left are simply never read again.
    const steps = [...(input.steps[user.stage] ?? [])]
      .filter((step) => step.approved)
      .sort((a, b) => a.afterMinutes - b.afterMinutes);
    if (steps.length === 0) {
      ignored.no_steps_for_stage += 1;
      continue;
    }

    const entryIso = events[STAGE_ENTRY_EVENT[user.stage]];
    const entryMs = entryIso ? Date.parse(entryIso) : NaN;
    if (!Number.isFinite(entryMs)) {
      ignored.no_entry_event += 1;
      continue;
    }

    const logs = input.logsByUser.get(user.id) ?? [];
    const logFor = (key: string) => logs.find((row) => row.templateKey === key);
    const isHandled = (key: string) => {
      const row = logFor(key);
      if (!row) return false;
      if (row.status === 'failed') return row.attempts >= input.maxAttempts;
      return true;
    };

    const due = steps.filter((step) => nowMs >= entryMs + step.afterMinutes * 60_000);
    const pending = due.filter((step) => !isHandled(step.key));
    if (pending.length === 0) {
      ignored.nothing_due += 1;
      continue;
    }

    // A later step that already went out makes every earlier one obsolete.
    const sentAfter = (afterMinutes: number) =>
      steps.some((step) => step.afterMinutes > afterMinutes && logFor(step.key)?.status === 'sent');
    const candidate = pending[pending.length - 1];
    for (const step of pending) {
      if (step === candidate && !sentAfter(step.afterMinutes)) continue;
      skips.push({ userId: user.id, stage: user.stage, stepKey: step.key, reason: 'superseded' });
    }
    if (sentAfter(candidate.afterMinutes)) {
      ignored.nothing_due += 1;
      continue;
    }

    const lastSentMs = logs
      .filter((row) => row.status === 'sent' && row.sentAt)
      .reduce((latest, row) => Math.max(latest, Date.parse(row.sentAt as string)), 0);
    if (lastSentMs && nowMs - lastSentMs < input.minGapMs) {
      ignored.daily_limit += 1;
      continue;
    }

    sends.push({
      userId: user.id,
      stage: user.stage,
      stepKey: candidate.key,
      dueAt: new Date(entryMs + candidate.afterMinutes * 60_000).toISOString(),
    });
  }

  sends.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { sends, skips, ignored };
}

function emptyIgnored(): Record<IgnoreReason, number> {
  return {
    before_cohort: 0,
    no_registration_event: 0,
    no_cohort: 0,
    opted_out: 0,
    no_email: 0,
    has_subscription: 0,
    no_steps_for_stage: 0,
    no_entry_event: 0,
    nothing_due: 0,
    daily_limit: 0,
  };
}
