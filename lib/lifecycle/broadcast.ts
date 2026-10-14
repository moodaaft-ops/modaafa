import type { Broadcast, SegmentId } from '@/config/email-broadcasts';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import { currentJourney } from '@/lib/lifecycle/journey';
import {
  categoryState,
  deliveryGuard,
  emptyIgnored,
  indexLogs,
  isHandled,
  resolvePlanConfig,
  unreachableReason,
  type CopyMeta,
  type EmailPlan,
  type PlanConfig,
  type PlanContext,
  type PlannedSend,
  type PlannedSkip,
} from '@/lib/lifecycle/plan';
import type { CopyKey } from '@/lib/lifecycle/types';

/**
 * One-off mail to a segment, sent gradually. Pure planning only; the database
 * side (finding the people, loading their context) is in lib/lifecycle/context.ts
 * and the sending is in run.ts.
 *
 * A broadcast ignores the activation date and the holdout group, and obeys:
 * the category preference of its copy, suppression, the send window, the 24 hour
 * gap, the 3 in 7 days cap and the per-run batch size. Each person is mailed at
 * most once per broadcast (message_log key `broadcast_<id>`).
 */
export type BroadcastGate = 'ready' | 'not_activated' | 'not_approved' | 'copy_not_approved' | 'not_yet';

export function broadcastTemplateKey(broadcast: Pick<Broadcast, 'id'>): string {
  return `broadcast_${broadcast.id}`;
}

/** Whether a broadcast may send at all right now (before looking at a single user). */
export function broadcastGate(args: {
  broadcast: Broadcast;
  now: Date;
  activatedAt: string | null;
  copy?: Record<CopyKey, CopyMeta>;
}): BroadcastGate {
  const { broadcast, now } = args;
  const copy = args.copy ?? EMAIL_COPY;
  // The global switch: nothing is sent while the lifecycle has no activation moment.
  if (!args.activatedAt || !Number.isFinite(Date.parse(args.activatedAt))) return 'not_activated';
  if (!broadcast.approved) return 'not_approved';
  if (!copy[broadcast.copyKey]?.approved) return 'copy_not_approved';
  if (broadcast.notBefore) {
    const notBefore = Date.parse(broadcast.notBefore);
    if (!Number.isFinite(notBefore) || now.getTime() < notBefore) return 'not_yet';
  }
  return 'ready';
}

export function inSegment(segment: SegmentId, ctx: PlanContext): boolean {
  const { user, subscription } = ctx;
  switch (segment) {
    case 'all':
      return user.stage !== null;
    case 'registered_not_connected':
      return user.stage === 'registered' && !subscription;
    case 'connected_no_trial':
      return (user.stage === 'connected' || user.stage === 'analysis_viewed') && !subscription;
    case 'trial_lapsed':
    case 'canceled': {
      const entry = currentJourney({ stage: user.stage, subscription, events: ctx.events });
      return entry?.journey === segment;
    }
    case 'subscribers':
      return subscription?.status === 'trialing' || subscription?.status === 'active';
  }
}

export type BroadcastPlanInput = {
  now: Date;
  broadcast: Broadcast;
  contexts: PlanContext[];
  copy?: Record<CopyKey, CopyMeta>;
  config?: Partial<PlanConfig>;
  /** People who already have a mail planned in this run (journey, weekly or an earlier broadcast). */
  excludeUserIds?: ReadonlySet<string>;
  /** How many sends this broadcast may add in this run. */
  limit: number;
};

/**
 * Walks the candidates in a stable order (user id) and plans up to `limit`
 * sends. People who can never be mailed (no address, suppressed, category off)
 * come back as skips so the next run does not scan them again; people who are
 * only blocked right now (window, gap, cap) are left alone and retried.
 */
export function planBroadcast(input: BroadcastPlanInput): EmailPlan {
  const config = resolvePlanConfig(input.config);
  const copy = input.copy ?? EMAIL_COPY;
  const { broadcast, now } = input;
  const copyMeta = copy[broadcast.copyKey];
  const templateKey = broadcastTemplateKey(broadcast);
  const ignored = emptyIgnored();
  const sends: PlannedSend[] = [];
  const skips: PlannedSkip[] = [];
  const planned = new Set<string>();

  const contexts = [...input.contexts].sort((a, b) => a.user.id.localeCompare(b.user.id));
  for (const ctx of contexts) {
    if (sends.length >= input.limit) break;
    const { user } = ctx;

    if (isHandled(indexLogs(ctx.logs).get(templateKey), config.maxAttempts)) {
      ignored.already_handled += 1;
      continue;
    }
    if (input.excludeUserIds?.has(user.id) || planned.has(user.id)) {
      ignored.already_planned += 1;
      continue;
    }
    if (!inSegment(broadcast.segment, ctx)) {
      ignored.not_in_segment += 1;
      continue;
    }

    const unreachable = unreachableReason(user);
    if (unreachable) {
      ignored[unreachable] += 1;
      skips.push(skipFor(user.id, broadcast, templateKey, copyMeta, unreachable));
      continue;
    }
    const state = categoryState(user, copyMeta.category);
    if (state !== 'on') {
      ignored[state] += 1;
      skips.push(skipFor(user.id, broadcast, templateKey, copyMeta, state));
      continue;
    }

    const blocked = deliveryGuard({ now, logs: ctx.logs, config });
    if (blocked) {
      ignored[blocked] += 1;
      continue;
    }

    planned.add(user.id);
    sends.push({
      kind: 'broadcast',
      userId: user.id,
      copyKey: broadcast.copyKey,
      templateKey,
      category: copyMeta.category,
      journey: null,
      dueAt: now.toISOString(),
    });
  }

  return { sends, skips, ignored };
}

function skipFor(
  userId: string,
  broadcast: Broadcast,
  templateKey: string,
  copyMeta: CopyMeta,
  reason: PlannedSkip['reason']
): PlannedSkip {
  return { userId, copyKey: broadcast.copyKey, templateKey, category: copyMeta.category, reason };
}
