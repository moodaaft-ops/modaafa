import {
  MAX_SEND_ATTEMPTS,
  MIN_GAP_BETWEEN_MESSAGES_MS,
  STAGE_FOLLOWUPS_COHORT_START,
  STAGE_FOLLOWUP_STEPS,
} from '@/config/stage-followups';
import { send as defaultSend, type SendResult } from '@/lib/messaging/send';
import { unsubscribeUrl as defaultUnsubscribeUrl } from '@/lib/messaging/unsubscribe';
import { planFollowups, type PlanLogRow, type PlanUser, type PlannedSend } from '@/lib/stages/plan';
import { followupFooterHtml, hasStageMessage, renderStageMessage } from '@/lib/stages/messages';
import { STAGE_ENTRY_EVENT, USER_STAGES, type UserEventType, type UserStage } from '@/lib/stages/types';

/** Hard ceiling on one run, so a mistake in the config cannot mail everyone at once. */
export const MAX_SENDS_PER_RUN = 100;
const PAGE = 1000;
const IN_CHUNK = 150;
const ENTRY_EVENTS: UserEventType[] = USER_STAGES.map((stage) => STAGE_ENTRY_EVENT[stage]);

export type FollowupRunOptions = {
  admin: any;
  now?: Date;
  /** Plan only: nothing is sent and nothing is written. */
  dryRun?: boolean;
  /** Test seams. */
  config?: {
    steps?: typeof STAGE_FOLLOWUP_STEPS;
    cohortStart?: string | null;
  };
  deps?: {
    send?: typeof defaultSend;
    unsubscribeUrl?: typeof defaultUnsubscribeUrl;
    isEmailConfirmed?: typeof defaultIsEmailConfirmed;
  };
};

export type FollowupRunSummary = {
  dryRun: boolean;
  considered: number;
  planned: Array<{ userId: string; stage: UserStage; stepKey: string }>;
  sent: number;
  failed: number;
  skippedByGuard: number;
  supersededRecorded: number;
  ignored: Record<string, number>;
  results: Array<{ userId: string; stepKey: string; result: string }>;
};

export async function runStageFollowups(options: FollowupRunOptions): Promise<FollowupRunSummary> {
  const { admin } = options;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const steps = options.config?.steps ?? STAGE_FOLLOWUP_STEPS;
  const cohortStart =
    options.config && 'cohortStart' in options.config ? options.config.cohortStart ?? null : STAGE_FOLLOWUPS_COHORT_START;
  const send = options.deps?.send ?? defaultSend;
  const makeUnsubscribeUrl = options.deps?.unsubscribeUrl ?? defaultUnsubscribeUrl;
  const isEmailConfirmed = options.deps?.isEmailConfirmed ?? defaultIsEmailConfirmed;

  const summary: FollowupRunSummary = {
    dryRun,
    considered: 0,
    planned: [],
    sent: 0,
    failed: 0,
    skippedByGuard: 0,
    supersededRecorded: 0,
    ignored: {},
    results: [],
  };

  if (!cohortStart) {
    summary.ignored.no_cohort = 1;
    return summary;
  }

  const users = await loadCohortUsers(admin, cohortStart);
  summary.considered = users.length;
  if (users.length === 0) return summary;

  const ids = users.map((user) => user.id);
  const [eventsByUser, logsByUser, subscribed] = await Promise.all([
    loadEvents(admin, ids),
    loadLogs(admin, ids),
    loadUsersWithSubscription(admin, ids),
  ]);
  for (const user of users) user.hasSubscription = subscribed.has(user.id);

  const plan = planFollowups({
    now,
    users,
    eventsByUser,
    logsByUser,
    steps,
    cohortStart,
    minGapMs: MIN_GAP_BETWEEN_MESSAGES_MS,
    maxAttempts: MAX_SEND_ATTEMPTS,
  });
  summary.ignored = { ...plan.ignored };
  summary.planned = plan.sends.map(({ userId, stage, stepKey }) => ({ userId, stage, stepKey }));

  if (dryRun) {
    // Report what a real run would actually send, not just what is due: drop
    // anyone whose address is unconfirmed, the same check a real send makes.
    const kept: typeof summary.planned = [];
    for (const item of summary.planned) {
      const confirmed = await isEmailConfirmed(admin, item.userId);
      if (confirmed === true) kept.push(item);
      else summary.ignored[confirmed === null ? 'auth_lookup_failed' : 'email_unconfirmed'] = (summary.ignored[confirmed === null ? 'auth_lookup_failed' : 'email_unconfirmed'] ?? 0) + 1;
    }
    summary.planned = kept;
    return summary;
  }

  if (plan.skips.length > 0) {
    const { error } = await admin.from('message_log').upsert(
      plan.skips.map((skip) => ({
        user_id: skip.userId,
        channel: 'email',
        template_key: skip.stepKey,
        stage: skip.stage,
        status: 'skipped',
        reason: skip.reason,
        attempts: 0,
        created_at: now.toISOString(),
      })),
      { onConflict: 'user_id,template_key', ignoreDuplicates: true }
    );
    if (error) console.error('[stage-followups] could not record superseded steps', { code: error.code });
    else summary.supersededRecorded = plan.skips.length;
  }

  const byId = new Map(users.map((user) => [user.id, user]));
  for (const planned of plan.sends.slice(0, MAX_SENDS_PER_RUN)) {
    const outcome = await deliver({ admin, planned, user: byId.get(planned.userId)!, now, send, makeUnsubscribeUrl, isEmailConfirmed });
    summary.results.push({ userId: planned.userId, stepKey: planned.stepKey, result: outcome });
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome.startsWith('failed')) summary.failed += 1;
    else summary.skippedByGuard += 1;
  }
  return summary;
}

async function deliver(args: {
  admin: any;
  planned: PlannedSend;
  user: PlanUser;
  now: Date;
  send: typeof defaultSend;
  makeUnsubscribeUrl: typeof defaultUnsubscribeUrl;
  isEmailConfirmed: typeof defaultIsEmailConfirmed;
}): Promise<string> {
  const { admin, planned, user, now } = args;

  if (!hasStageMessage(planned.stepKey)) return 'skipped:no_text';

  // The stage can change between planning and sending (a user connecting in
  // the middle of a run). Read it again and drop the message if they moved on.
  const { data: fresh, error } = await admin
    .from('users')
    .select('stage, messages_opt_out')
    .eq('id', planned.userId)
    .maybeSingle();
  if (error) return 'failed:stage_recheck';
  if (!fresh || fresh.stage !== planned.stage) return 'skipped:stage_changed';
  if (fresh.messages_opt_out === true) return 'skipped:opted_out';

  // Sign-up with an email address creates the account before the address is
  // confirmed. Someone who never confirmed cannot connect anything, so a
  // "you haven't connected yet" email would be both useless and wrong.
  const confirmed = await args.isEmailConfirmed(admin, planned.userId);
  if (confirmed === null) return 'failed:auth_lookup';
  if (!confirmed) return 'skipped:email_unconfirmed';

  const unsubscribe = args.makeUnsubscribeUrl(planned.userId);
  if (!unsubscribe) {
    // Never send a follow-up that has no working way to stop them.
    console.error('[stage-followups] MESSAGES_UNSUBSCRIBE_SECRET is not set; nothing can be sent');
    return 'skipped:unsubscribe_not_configured';
  }
  const message = renderStageMessage(planned.stepKey, { name: user.name, unsubscribeUrl: unsubscribe });
  if (!message) return 'skipped:no_text';

  const result: SendResult = await args.send({
    admin,
    userId: planned.userId,
    templateKey: planned.stepKey,
    stage: planned.stage,
    subject: message.subject,
    html: message.html,
    footerHtml: followupFooterHtml(unsubscribe),
    headers: {
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    now,
  });
  if (result.status === 'sent') return 'sent';
  if (result.status === 'failed') return `failed:${result.reason}`;
  if (result.status === 'not_configured') return 'skipped:email_not_configured';
  return `skipped:${result.reason}`;
}

async function defaultIsEmailConfirmed(admin: any, userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return null;
    return Boolean(data?.user?.email_confirmed_at);
  } catch {
    return null;
  }
}

async function loadCohortUsers(admin: any, cohortStart: string): Promise<PlanUser[]> {
  const rows: PlanUser[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('users')
      .select('id, email, name, stage, created_at, messages_opt_out')
      .gte('created_at', cohortStart)
      .eq('messages_opt_out', false)
      .in('stage', ['registered', 'connected', 'analysis_viewed'])
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`stage-followups: could not load users (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      rows.push({
        id: row.id,
        email: row.email,
        name: row.name,
        stage: row.stage,
        createdAt: row.created_at,
        messagesOptOut: row.messages_opt_out === true,
        hasSubscription: false,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function loadEvents(admin: any, ids: string[]) {
  const map = new Map<string, Partial<Record<UserEventType, string>>>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await admin
      .from('user_events')
      .select('user_id, event_type, occurred_at')
      .in('user_id', part)
      .in('event_type', ENTRY_EVENTS);
    if (error) throw new Error(`stage-followups: could not load events (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      const entry = map.get(row.user_id) ?? {};
      entry[row.event_type as UserEventType] = row.occurred_at;
      map.set(row.user_id, entry);
    }
  }
  return map;
}

async function loadLogs(admin: any, ids: string[]) {
  const map = new Map<string, PlanLogRow[]>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await admin
      .from('message_log')
      .select('user_id, template_key, status, attempts, sent_at')
      .in('user_id', part);
    if (error) throw new Error(`stage-followups: could not load message_log (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      const list = map.get(row.user_id) ?? [];
      list.push({
        templateKey: row.template_key,
        status: row.status,
        attempts: row.attempts ?? 0,
        sentAt: row.sent_at,
      });
      map.set(row.user_id, list);
    }
  }
  return map;
}

async function loadUsersWithSubscription(admin: any, ids: string[]) {
  const set = new Set<string>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await admin
      .from('subscriptions')
      .select('user_id')
      .in('user_id', part)
      .in('status', ['trialing', 'active', 'past_due']);
    if (error) throw new Error(`stage-followups: could not load subscriptions (${error.code ?? 'error'})`);
    for (const row of data ?? []) set.add(row.user_id);
  }
  return set;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
