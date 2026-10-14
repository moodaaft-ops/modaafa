import {
  MAX_SEND_ATTEMPTS,
  MIN_GAP_BETWEEN_MESSAGES_MS,
  STAGE_FOLLOWUPS_COHORT_START,
  STAGE_FOLLOWUP_STEPS,
} from '@/config/stage-followups';
import { send as defaultSend, type SendDeps } from '@/lib/messaging/send';
import { planFollowups, type PlanLogRow, type PlanUser, type PlannedSend } from '@/lib/stages/plan';
import { isStageTemplateId } from '@/lib/stages/messages';
import { STAGE_ENTRY_EVENT, USER_STAGES, type UserEventType, type UserStage } from '@/lib/stages/types';

/** Hard ceiling on one run, so a mistake in the config cannot mail everyone at once. */
export const MAX_SENDS_PER_RUN = 100;
/** Same lease public.claim_message uses: a send that has been "in flight" longer is dead. */
const SENDING_LEASE_MS = 10 * 60 * 1000;
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
    sendDeps?: Omit<SendDeps, 'supabase' | 'now'>;
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

  // No date set means nobody is eligible. This is the default until Ayman
  // picks the activation moment.
  if (!cohortStart) {
    summary.ignored.no_cohort = 1;
    return summary;
  }

  const eventsByUser = await loadCohortEvents(admin, cohortStart);
  const users = await loadUsers(admin, [...eventsByUser.keys()]);
  summary.considered = users.length;
  if (users.length === 0) return summary;

  const ids = users.map((user) => user.id);
  const [logsByUser, subscribed] = await Promise.all([loadLogs(admin, ids, now), loadUsersWithSubscription(admin, ids)]);
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

  if (dryRun) return summary;

  if (plan.skips.length > 0) {
    const { error } = await admin.from('message_log').upsert(
      plan.skips.map((skip) => ({
        user_id: skip.userId,
        channel: 'email',
        template: skip.stepKey,
        status: 'skipped',
        reason: skip.reason,
        attempts: 0,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })),
      { onConflict: 'user_id,channel,template', ignoreDuplicates: true }
    );
    if (error) console.error('[stage-followups] could not record superseded steps', { code: error.code });
    else summary.supersededRecorded = plan.skips.length;
  }

  const byId = new Map(users.map((user) => [user.id, user]));
  const send = options.deps?.send ?? defaultSend;
  for (const planned of plan.sends.slice(0, MAX_SENDS_PER_RUN)) {
    const outcome = await deliver({
      admin,
      planned,
      user: byId.get(planned.userId)!,
      now,
      send,
      sendDeps: options.deps?.sendDeps ?? {},
    });
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
  sendDeps: Omit<SendDeps, 'supabase' | 'now'>;
}): Promise<string> {
  const { admin, planned, user, now } = args;
  if (!isStageTemplateId(planned.stepKey)) return 'skipped:no_text';

  // The stage can change between planning and sending (a user connecting in
  // the middle of a run), and so can the opt-out flag. Read both again and
  // drop the message if the person has moved on.
  const { data: fresh, error } = await admin
    .from('users')
    .select('stage, messages_opt_out, email, name')
    .eq('id', planned.userId)
    .maybeSingle();
  if (error) return 'failed:stage_recheck';
  if (!fresh || fresh.stage !== planned.stage) return 'skipped:stage_changed';
  if (fresh.messages_opt_out === true) return 'skipped:opted_out';

  const result = await args.send(
    'email',
    planned.stepKey,
    { id: planned.userId, email: fresh.email ?? user.email ?? '', name: fresh.name ?? user.name, messages_opt_out: false },
    { ...args.sendDeps, supabase: admin, now: () => now }
  );
  switch (result.status) {
    case 'sent':
      return 'sent';
    case 'failed':
      return `failed:${result.reason}`;
    case 'skipped':
      return `skipped:${result.reason}`;
    case 'duplicate':
      return 'skipped:already_handled';
    case 'not_configured':
      return 'skipped:email_not_configured';
    default:
      return `skipped:${result.status}`;
  }
}

/** registration_completed events inside the cohort, with the stage-entry events of the same people. */
async function loadCohortEvents(admin: any, cohortStart: string) {
  const registered: string[] = [];
  const map = new Map<string, Partial<Record<UserEventType, string>>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('user_events')
      .select('user_id, created_at')
      .eq('event', 'registration_completed')
      .gte('created_at', cohortStart)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`stage-followups: could not load registrations (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      registered.push(row.user_id);
      map.set(row.user_id, { registration_completed: row.created_at });
    }
    if (!data || data.length < PAGE) break;
  }

  for (const part of chunk(registered, IN_CHUNK)) {
    const { data, error } = await admin
      .from('user_events')
      .select('user_id, event, created_at')
      .in('user_id', part)
      .in('event', ENTRY_EVENTS);
    if (error) throw new Error(`stage-followups: could not load events (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      const entry = map.get(row.user_id) ?? {};
      entry[row.event as UserEventType] = row.created_at;
      map.set(row.user_id, entry);
    }
  }
  return map;
}

async function loadUsers(admin: any, ids: string[]): Promise<PlanUser[]> {
  const rows: PlanUser[] = [];
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await admin
      .from('users')
      .select('id, email, name, stage, messages_opt_out')
      .in('id', part)
      .eq('messages_opt_out', false)
      .in('stage', ['registered', 'connected', 'analysis_viewed']);
    if (error) throw new Error(`stage-followups: could not load users (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      rows.push({
        id: row.id,
        email: row.email,
        name: row.name,
        stage: row.stage,
        messagesOptOut: row.messages_opt_out === true,
        hasSubscription: false,
      });
    }
  }
  return rows;
}

async function loadLogs(admin: any, ids: string[], now: Date) {
  const map = new Map<string, PlanLogRow[]>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await admin
      .from('message_log')
      .select('user_id, template, status, attempts, sent_at, updated_at')
      .eq('channel', 'email')
      .in('user_id', part);
    if (error) throw new Error(`stage-followups: could not load message_log (${error.code ?? 'error'})`);
    for (const row of data ?? []) {
      const stale =
        row.status === 'sending' && now.getTime() - new Date(row.updated_at).getTime() >= SENDING_LEASE_MS;
      const list = map.get(row.user_id) ?? [];
      list.push({
        templateKey: row.template,
        status: stale ? 'failed' : row.status,
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
