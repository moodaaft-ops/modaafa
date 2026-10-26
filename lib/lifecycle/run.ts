/**
 * The email lifecycle runner: plans, then (unless it is a dry run) sends.
 *
 * Sends go through sendTemplate (lib/messaging/send.ts) and facts come from
 * loadEmailFacts (lib/lifecycle/facts.ts). Both are injectable for tests.
 *
 * What this runner passes to sendTemplate: `enforceGap: true` for every
 * lifecycle mail (only the welcome mail sets it false), and as deps
 * `{ supabase: admin, now: () => runNow }` so claim, log and gap use the
 * run's clock, plus anything in `deps.sendTemplateDeps`.
 * ---------------------------------------------------------------------------
 *
 * Gates, all required before one mail leaves:
 *   EMAIL_LIFECYCLE_ENABLED=true (checked by the cron route), a non-null
 *   EMAIL_LIFECYCLE_ACTIVATED_AT (config/email-journeys.ts), copy approved.
 *
 * Flow of one run
 *   1. find candidates (funnel events, subscriptions) and load their context in batches
 *   2. plan journeys and the weekly report (lib/lifecycle/plan.ts), then broadcasts
 *   3. dry run: stop here and report. Nothing is written.
 *   4. record the steps that will never be sent (superseded, expired)
 *   5. re-read the planned people and re-plan, so a user who connected or paid
 *      a minute ago is not mailed for the old state
 *   6. for each send: load facts, skip when a required fact is missing, then sendTemplate
 */
import { BROADCASTS, type Broadcast } from '@/config/email-broadcasts';
import { BROADCAST_BATCH_PER_RUN, EMAIL_LIFECYCLE_ACTIVATED_AT, MAX_SENDS_PER_RUN } from '@/config/email-journeys';
import { broadcastGate, broadcastTemplateKey, planBroadcast, type BroadcastGate } from '@/lib/lifecycle/broadcast';
import {
  BROADCAST_SCAN_LIMIT,
  findJourneyCandidateIds,
  findSegmentCandidateIds,
  loadContexts,
  loadHandledUserIds,
} from '@/lib/lifecycle/context';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import {
  emptyIgnored,
  planEmails,
  resolvePlanConfig,
  type IgnoreReason,
  type PlanConfig,
  type PlanContext,
  type PlannedSend,
  type PlannedSkip,
} from '@/lib/lifecycle/plan';
import { saudiWeekStart, weeklyReportSlot } from '@/lib/lifecycle/riyadh';
import type { BuiltEmail, CopyKey, EmailCopy, EmailFacts, FactNeed } from '@/lib/lifecycle/types';
import { sendTemplate, type SendDeps } from '@/lib/messaging/send';
import { loadEmailFacts } from '@/lib/lifecycle/facts';

// ---------------------------------------------------------------------------
// Signatures of the two injectable dependencies
// ---------------------------------------------------------------------------

export type SendTemplateInput = {
  user: { id: string; email: string; name?: string | null; messages_opt_out?: boolean | null };
  templateKey: string;
  copy: EmailCopy;
  facts: EmailFacts;
  enforceGap: boolean;
};
export type SendTemplateResult =
  | { status: 'sent'; providerId?: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'not_configured' };
/** lib/messaging/send.ts (agent B) */
export type SendTemplateFn = (input: SendTemplateInput, deps?: object) => Promise<SendTemplateResult>;
/** lib/lifecycle/facts.ts (agent C) */
export type LoadEmailFactsFn = (
  admin: any,
  user: { id: string; name: string | null },
  needs: FactNeed[]
) => Promise<EmailFacts>;

export const defaultSendTemplate: SendTemplateFn = (input, deps) => sendTemplate(input, deps as SendDeps | undefined);

export const defaultLoadEmailFacts: LoadEmailFactsFn = (admin, user, needs) => loadEmailFacts(admin, user, needs);

// ---------------------------------------------------------------------------
// Options and summary
// ---------------------------------------------------------------------------

export type LifecycleRunOptions = {
  admin: any;
  now?: Date;
  /** Plan only: nothing is sent and nothing is written. */
  dryRun?: boolean;
  /** Test seams and dry-run previews. */
  config?: {
    /** Overrides EMAIL_LIFECYCLE_ACTIVATED_AT (an explicit null means "not activated"). */
    activatedAt?: string | null;
    plan?: Partial<Omit<PlanConfig, 'activatedAt'>>;
    copy?: Record<CopyKey, EmailCopy>;
    broadcasts?: Broadcast[];
    maxSendsPerRun?: number;
    broadcastBatchPerRun?: number;
    /** Stop starting new sends after this many milliseconds. The rest wait for the next run. */
    timeBudgetMs?: number;
    /** Dry run only: treat every copy and broadcast as approved, to preview a plan before sign-off. */
    assumeApproved?: boolean;
  };
  deps?: {
    sendTemplate?: SendTemplateFn;
    sendTemplateDeps?: object;
    loadEmailFacts?: LoadEmailFactsFn;
    /** Milliseconds clock for the time budget. */
    clock?: () => number;
  };
};

export type BroadcastReport = { id: string; gate: BroadcastGate; planned: number };

export type LifecycleRunSummary = {
  dryRun: boolean;
  gate: 'open' | 'not_activated';
  activatedAt: string | null;
  /** People whose journey and weekly report were evaluated. */
  considered: number;
  planned: {
    total: number;
    thisRun: number;
    byTemplate: Record<string, number>;
    byKind: Record<PlannedSend['kind'], number>;
  };
  skips: { superseded: number; expired: number; permanent: number; recorded: number };
  /** One count per (user, track) that produced no mail, under the reason it stopped. */
  ignored: Record<IgnoreReason, number>;
  broadcasts: BroadcastReport[];
  sent: number;
  duplicate: number;
  failed: number;
  skipped: number;
  notConfigured: boolean;
  timeBudgetExceeded: boolean;
  results: Array<{ userId: string; templateKey: string; result: string }>;
  /** Dry run only: the first few planned sends, for eyeballing. */
  sample: Array<{ userId: string; templateKey: string; dueAt: string }>;
};

const SAMPLE_SIZE = 20;
const SKIP_WRITE_BATCH = 200;
const DEFAULT_TIME_BUDGET_MS = 100_000;

export async function runEmailLifecycle(options: LifecycleRunOptions): Promise<LifecycleRunSummary> {
  const { admin } = options;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const settings = options.config ?? {};
  const assumeApproved = dryRun && settings.assumeApproved === true;
  const copy = assumeApproved ? approveAll(settings.copy ?? EMAIL_COPY) : settings.copy ?? EMAIL_COPY;
  const broadcasts = (settings.broadcasts ?? BROADCASTS).map((b) => (assumeApproved ? { ...b, approved: true } : b));
  const activatedAt = 'activatedAt' in settings ? settings.activatedAt ?? null : EMAIL_LIFECYCLE_ACTIVATED_AT;
  const planConfig = resolvePlanConfig({ ...settings.plan, activatedAt });
  const maxSends = settings.maxSendsPerRun ?? MAX_SENDS_PER_RUN;
  const broadcastBatch = settings.broadcastBatchPerRun ?? BROADCAST_BATCH_PER_RUN;

  const summary = emptySummary(dryRun, activatedAt);
  summary.broadcasts = broadcasts.map((broadcast) => ({
    id: broadcast.id,
    gate: broadcastGate({ broadcast, now, activatedAt, copy }),
    planned: 0,
  }));

  if (!activatedAt || !Number.isFinite(Date.parse(activatedAt))) {
    summary.gate = 'not_activated';
    summary.ignored.not_activated = 1;
    return summary;
  }

  // 1 + 2. Journeys and the weekly report.
  const slot = weeklyReportSlot(now, planConfig.weekly);
  const relevantTemplates = [
    ...new Set([
      ...Object.values(planConfig.steps).flatMap((steps) => steps.map((step) => step.copyKey as string)),
      ...(slot ? [slot.templateKey] : []),
      ...broadcasts.map(broadcastTemplateKey),
    ]),
  ];

  // While the slot is open each person's "does this week's report exist" is read with them, so the planner only
  // offers a weekly report that can be delivered (see plan.ts).
  const weeklyReportSince = slot ? saudiWeekStart(now) : null;
  const candidateIds = await findJourneyCandidateIds(admin, {
    now,
    activatedAt,
    config: planConfig,
    weeklyKey: slot?.templateKey ?? null,
  });
  const contexts = await loadContexts(admin, candidateIds, now, { relevantTemplates, weeklyReportSince });
  summary.considered = contexts.length;

  const base = planEmails({ now, contexts, copy, config: planConfig });
  const sends: PlannedSend[] = [...base.sends];
  const skips: PlannedSkip[] = [...base.skips];
  addCounts(summary.ignored, base.ignored);

  // Broadcasts get whatever room the journeys left, never more than their batch.
  const plannedUsers = new Set(sends.slice(0, maxSends).map((send) => send.userId));
  let room = Math.max(0, Math.min(broadcastBatch, maxSends - plannedUsers.size));
  for (const [index, broadcast] of broadcasts.entries()) {
    const report = summary.broadcasts[index]!;
    if (report.gate !== 'ready' || room <= 0) continue;

    const handled = await loadHandledUserIds(admin, broadcastTemplateKey(broadcast), now, planConfig.maxAttempts);
    const ids = await findSegmentCandidateIds(admin, broadcast.segment, {
      exclude: new Set([...handled, ...plannedUsers]),
      limit: BROADCAST_SCAN_LIMIT,
    });
    const audience = await loadContexts(admin, ids, now, { relevantTemplates });

    const plan = planBroadcast({
      now,
      broadcast,
      contexts: audience,
      copy,
      config: planConfig,
      excludeUserIds: plannedUsers,
      limit: room,
    });
    for (const send of plan.sends) plannedUsers.add(send.userId);
    report.planned = plan.sends.length;
    room -= plan.sends.length;
    sends.push(...plan.sends);
    skips.push(...plan.skips);
    addCounts(summary.ignored, plan.ignored);
  }

  summary.planned = tally(sends, maxSends);
  summary.skips = {
    superseded: skips.filter((skip) => skip.reason === 'superseded').length,
    expired: skips.filter((skip) => skip.reason === 'expired').length,
    permanent: skips.filter((skip) => skip.reason !== 'superseded' && skip.reason !== 'expired').length,
    recorded: 0,
  };

  if (dryRun) {
    summary.sample = sends.slice(0, SAMPLE_SIZE).map(({ userId, templateKey, dueAt }) => ({ userId, templateKey, dueAt }));
    return summary;
  }

  // 4. Steps that will never be sent.
  summary.skips.recorded = await recordSkips(admin, skips, now);

  // 5. Re-read the people we are about to mail; send only what is still planned.
  const toSend = sends.slice(0, maxSends);
  if (toSend.length === 0) return summary;
  const fresh = await loadContexts(admin, [...new Set(toSend.map((send) => send.userId))], now, { relevantTemplates, weeklyReportSince });
  const freshByUser = new Map(fresh.map((ctx) => [ctx.user.id, ctx]));
  const confirmed = confirmSends({ toSend, fresh, broadcasts, now, copy, planConfig });

  // 6. Deliver, one at a time (Resend is rate limited and facts are per person).
  const sendTemplate = options.deps?.sendTemplate ?? defaultSendTemplate;
  const loadFacts = options.deps?.loadEmailFacts ?? defaultLoadEmailFacts;
  const clock = options.deps?.clock ?? Date.now;
  const startedAt = clock();
  const budget = settings.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  for (const planned of confirmed) {
    if (clock() - startedAt > budget) {
      summary.timeBudgetExceeded = true;
      break;
    }
    const ctx = freshByUser.get(planned.userId);
    const result = ctx
      ? await deliver({
          admin,
          planned,
          ctx,
          copy: copy[planned.copyKey],
          now,
          sendTemplate,
          loadFacts,
          sendTemplateDeps: options.deps?.sendTemplateDeps,
          weeklyWindowOpen: slot !== null,
        })
      : 'skipped:user_gone';
    summary.results.push({ userId: planned.userId, templateKey: planned.templateKey, result });
    if (result === 'not_configured') {
      // No provider key: every remaining send would fail the same way.
      summary.notConfigured = true;
      break;
    }
    if (result === 'sent') summary.sent += 1;
    else if (result === 'duplicate') summary.duplicate += 1;
    else if (result.startsWith('failed')) summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function approveAll(copy: Record<CopyKey, EmailCopy>): Record<CopyKey, EmailCopy> {
  return Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, { ...value, approved: true }])) as Record<CopyKey, EmailCopy>;
}

function emptySummary(dryRun: boolean, activatedAt: string | null): LifecycleRunSummary {
  return {
    dryRun,
    gate: 'open',
    activatedAt,
    considered: 0,
    planned: { total: 0, thisRun: 0, byTemplate: {}, byKind: { journey: 0, weekly: 0, broadcast: 0 } },
    skips: { superseded: 0, expired: 0, permanent: 0, recorded: 0 },
    ignored: emptyIgnored(),
    broadcasts: [],
    sent: 0,
    duplicate: 0,
    failed: 0,
    skipped: 0,
    notConfigured: false,
    timeBudgetExceeded: false,
    results: [],
    sample: [],
  };
}

function addCounts(target: Record<IgnoreReason, number>, source: Record<IgnoreReason, number>) {
  for (const reason of Object.keys(source) as IgnoreReason[]) target[reason] += source[reason];
}

/**
 * Per-template counts use the CATEGORY of key, not the per-week key, so a dry
 * run reads "weekly_report: 120" instead of one line per ISO week.
 */
function tally(sends: PlannedSend[], maxSends: number): LifecycleRunSummary['planned'] {
  const byTemplate: Record<string, number> = {};
  const byKind: Record<PlannedSend['kind'], number> = { journey: 0, weekly: 0, broadcast: 0 };
  for (const send of sends) {
    const key = send.kind === 'weekly' ? 'weekly_report' : send.templateKey;
    byTemplate[key] = (byTemplate[key] ?? 0) + 1;
    byKind[send.kind] += 1;
  }
  return { total: sends.length, thisRun: Math.min(sends.length, maxSends), byTemplate, byKind };
}

async function recordSkips(admin: any, skips: PlannedSkip[], now: Date): Promise<number> {
  if (skips.length === 0) return 0;
  const stamp = now.toISOString();
  let recorded = 0;
  for (let i = 0; i < skips.length; i += SKIP_WRITE_BATCH) {
    const part = skips.slice(i, i + SKIP_WRITE_BATCH);
    const { error } = await admin.from('message_log').upsert(
      part.map((skip) => ({
        user_id: skip.userId,
        channel: 'email',
        template: skip.templateKey,
        status: 'skipped',
        reason: skip.reason,
        attempts: 0,
        category: skip.category,
        copy_key: skip.copyKey,
        created_at: stamp,
        updated_at: stamp,
      })),
      { onConflict: 'user_id,channel,template', ignoreDuplicates: true }
    );
    if (error) console.error('[email-lifecycle] could not record skipped steps', { code: error.code });
    else recorded += part.length;
  }
  return recorded;
}

/**
 * Plans again with freshly read data and keeps only the sends that are still
 * planned. Costs no extra query per person: `fresh` is one batched read.
 */
function confirmSends(args: {
  toSend: PlannedSend[];
  fresh: PlanContext[];
  broadcasts: Broadcast[];
  now: Date;
  copy: Record<CopyKey, EmailCopy>;
  planConfig: PlanConfig;
}): PlannedSend[] {
  const { toSend, fresh, now, copy, planConfig } = args;
  const key = (send: Pick<PlannedSend, 'userId' | 'templateKey'>) => `${send.userId}|${send.templateKey}`;
  const keep = new Set(planEmails({ now, contexts: fresh, copy, config: planConfig }).sends.map(key));

  for (const broadcast of args.broadcasts) {
    const templateKey = broadcastTemplateKey(broadcast);
    const audience = new Set(toSend.filter((send) => send.templateKey === templateKey).map((send) => send.userId));
    if (audience.size === 0) continue;
    const plan = planBroadcast({
      now,
      broadcast,
      contexts: fresh.filter((ctx) => audience.has(ctx.user.id)),
      copy,
      config: planConfig,
      limit: audience.size,
    });
    for (const send of plan.sends) keep.add(key(send));
  }
  return toSend.filter((send) => keep.has(key(send)));
}

async function deliver(args: {
  admin: any;
  planned: PlannedSend;
  ctx: PlanContext;
  copy: EmailCopy;
  now: Date;
  sendTemplate: SendTemplateFn;
  loadFacts: LoadEmailFactsFn;
  sendTemplateDeps?: object;
  /** True while the weekly report slot is open (the report may still be written by the optimize cron). */
  weeklyWindowOpen: boolean;
}): Promise<string> {
  const { admin, planned, ctx, copy, now } = args;
  const user = ctx.user;
  if (!user.email) return 'skipped:no_email';

  const needs = copy.requires ?? [];
  let facts: EmailFacts;
  try {
    // The address is not a fact the loader reads: the runner already has it and a copy may prefill a support message.
    facts = { ...(await args.loadFacts(admin, { id: user.id, name: user.name }, needs)), email: user.email };
  } catch (error) {
    return `failed:facts:${errorText(error)}`;
  }

  // 'cancel_state' is not a field of the facts: it fills trial.cancelScheduled and is judged separately below.
  const missing = needs.filter((need) => need !== 'cancel_state' && facts[need] == null);
  // The planner only offers the weekly report once this week's report exists (plan.ts, `hasWeeklyReport`), so this
  // is the safety net for the race: the report went away, or its read failed, between planning and sending.
  // The weekly report is written by a different job (the hourly optimize cron, once per account per Saudi week),
  // so "no report" is "not yet", not "never". Recording missing_facts here would settle the week's message
  // for good before the report exists. Leave it unclaimed (no message_log row) and let the next run try again;
  // the planner stops offering it when the slot's window closes.
  if (planned.kind === 'weekly' && missing.includes('weekly') && args.weeklyWindowOpen) return 'skipped:weekly_pending';
  if (missing.length > 0) return recordSkip(admin, planned, copy, `missing_facts:${missing.join(',')}`, now);
  // A copy that must not reach someone who cancelled (the day 12 card notice) needs Stripe's live answer. When
  // Stripe could not be asked, hold the mail without writing anything: the planner offers it again on the next run
  // until the step expires, instead of settling it for good on a failed read.
  if (needs.includes('cancel_state') && facts.trial?.cancelScheduled == null) return 'skipped:cancel_state_unknown';

  // The copy may decide the facts make the message pointless; that is final too.
  let built: BuiltEmail | null;
  try {
    built = copy.build(facts);
  } catch (error) {
    return `failed:build:${errorText(error)}`;
  }
  if (built === null) return recordSkip(admin, planned, copy, 'not_applicable', now);

  try {
    const result = await args.sendTemplate(
      {
        user: { id: user.id, email: user.email, name: user.name, messages_opt_out: user.messagesOptOut },
        templateKey: planned.templateKey,
        copy,
        facts,
        enforceGap: true,
      },
      { supabase: admin, now: () => now, ...args.sendTemplateDeps }
    );
    switch (result.status) {
      case 'sent':
        return 'sent';
      case 'duplicate':
        return 'duplicate';
      case 'not_configured':
        return 'not_configured';
      case 'skipped':
        return `skipped:${result.reason}`;
      case 'failed':
        return `failed:${result.reason}`;
      default:
        return 'failed:unknown_status';
    }
  } catch (error) {
    return `failed:send:${errorText(error)}`;
  }
}

/**
 * "Claim, then mark skipped": the same atomic claim a real send uses, so a
 * skipped message and a sent one can never both exist, and the planner treats
 * the row as settled (it is not retried).
 */
async function recordSkip(admin: any, planned: PlannedSend, copy: EmailCopy, reason: string, now: Date): Promise<string> {
  const outcome = `skipped:${reason.split(':')[0]}`;
  try {
    const { data: claimed, error } = await admin.rpc('claim_message', {
      p_user_id: planned.userId,
      p_channel: 'email',
      p_template: planned.templateKey,
    });
    if (error) return 'failed:claim_failed';
    if (!claimed) return 'duplicate';
    const { error: updateError } = await admin
      .from('message_log')
      .update({ status: 'skipped', reason, category: copy.category, copy_key: copy.key, updated_at: now.toISOString() })
      .eq('user_id', planned.userId)
      .eq('channel', 'email')
      .eq('template', planned.templateKey);
    if (updateError) console.error('[email-lifecycle] could not mark skip', { code: updateError.code });
    return outcome;
  } catch (error) {
    return `failed:skip:${errorText(error)}`;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 120);
}
