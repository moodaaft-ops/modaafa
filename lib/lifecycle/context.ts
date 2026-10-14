import type { SegmentId } from '@/config/email-broadcasts';
import { journeyHorizonMinutes, journeyLastStepMinutes, type JourneyEvents, type JourneySubscription } from '@/lib/lifecycle/journey';
import { isHandled, type PlanConfig, type PlanContext, type PlanLogRow, type PlanUser } from '@/lib/lifecycle/plan';
import type { JourneyId } from '@/lib/lifecycle/types';
import { USER_EVENT_TYPES, type UserEventType } from '@/lib/stages/types';

/**
 * Everything the planner reads, loaded in batches. The query count depends on
 * the number of people divided by IN_CHUNK, never on the number of people: no
 * N+1. Every list read is paged because PostgREST silently caps a response at
 * about 1000 rows.
 *
 * Needs db/migrations/20261014_email_lifecycle.sql (users.email_prefs,
 * users.email_suppressed_at, message_log.category). Before it is applied the
 * reads fail with a clear error and the cron reports it; nothing is sent.
 */
export const IN_CHUNK = 150;
const PAGE = 1000;
/** Same lease public.claim_message uses: a send that has been "in flight" longer is dead. */
export const SENDING_LEASE_MS = 10 * 60 * 1000;
/** How many not-yet-handled people one broadcast looks at per run. */
export const BROADCAST_SCAN_LIMIT = 600;

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNNEL_EVENTS: UserEventType[] = [
  'registration_completed',
  'ads_account_connected',
  'first_analysis_viewed',
  'subscription_paid',
];
// Keep the list above honest if the event vocabulary changes.
for (const event of FUNNEL_EVENTS) {
  if (!USER_EVENT_TYPES.includes(event)) throw new Error(`email-lifecycle: unknown event ${event}`);
}

type DbError = { code?: string; message?: string } | null;
type Page<T> = PromiseLike<{ data: T[] | null; error: DbError }>;

async function fetchAll<T>(label: string, build: (from: number, to: number) => Page<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`email-lifecycle: could not load ${label} (${error.code ?? 'error'})`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export function chunk<T>(items: T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type LogRowRaw = {
  user_id: string;
  template: string;
  status: PlanLogRow['status'];
  attempts: number | null;
  sent_at: string | null;
  updated_at: string | null;
  category?: string | null;
};

export function toLogRow(row: LogRowRaw, now: Date): PlanLogRow {
  const stale =
    row.status === 'sending' && row.updated_at !== null && now.getTime() - Date.parse(row.updated_at) >= SENDING_LEASE_MS;
  return {
    templateKey: row.template,
    status: stale ? 'failed' : row.status,
    attempts: row.attempts ?? 0,
    sentAt: row.sent_at,
    category: row.category ?? null,
  };
}

type UserRowRaw = {
  id: string;
  email: string | null;
  name: string | null;
  stage: string | null;
  messages_opt_out: boolean | null;
  email_prefs: Record<string, unknown> | null;
  email_suppressed_at: string | null;
};

type SubscriptionRowRaw = {
  user_id: string;
  status: string | null;
  created_at: string | null;
  trial_ends_at: string | null;
  canceled_at: string | null;
  last_event_at: string | null;
};

function toSubscription(row: SubscriptionRowRaw): JourneySubscription {
  return {
    status: row.status,
    createdAt: row.created_at,
    trialEndsAt: row.trial_ends_at,
    canceledAt: row.canceled_at,
    lastEventAt: row.last_event_at,
  };
}

/** The newest subscription wins; created_at decides, last_event_at breaks a tie. */
function isNewer(a: SubscriptionRowRaw, b: SubscriptionRowRaw): boolean {
  const left = Date.parse(a.created_at ?? '') || 0;
  const right = Date.parse(b.created_at ?? '') || 0;
  if (left !== right) return left > right;
  return (Date.parse(a.last_event_at ?? '') || 0) > (Date.parse(b.last_event_at ?? '') || 0);
}

// ---------------------------------------------------------------------------
// Contexts for a known list of people
// ---------------------------------------------------------------------------

export type LoadContextOptions = {
  /** Templates whose rows decide "already handled" (journey copy keys, the open weekly key, broadcast keys). */
  relevantTemplates: string[];
};

/**
 * For each id: the user row, the latest subscription, the funnel events and the
 * message_log rows the planner needs. Four reads per chunk of IN_CHUNK people
 * (users, events, subscriptions, logs by template) plus one for the rolling
 * 7 day send history. Ids with no users row are dropped.
 */
export async function loadContexts(
  admin: any,
  ids: string[],
  now: Date,
  options: LoadContextOptions
): Promise<PlanContext[]> {
  const unique = [...new Set(ids)];
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const out: PlanContext[] = [];

  for (const part of chunk(unique)) {
    const [users, events, subscriptions, templateLogs, recentLogs] = await Promise.all([
      fetchAll<UserRowRaw>('users', (from, to) =>
        admin
          .from('users')
          .select('id, email, name, stage, messages_opt_out, email_prefs, email_suppressed_at')
          .in('id', part)
          .order('id', { ascending: true })
          .range(from, to)
      ),
      fetchAll<{ user_id: string; event: UserEventType; created_at: string }>('events', (from, to) =>
        admin
          .from('user_events')
          .select('user_id, event, created_at')
          .in('user_id', part)
          .in('event', FUNNEL_EVENTS)
          .order('id', { ascending: true })
          .range(from, to)
      ),
      fetchAll<SubscriptionRowRaw>('subscriptions', (from, to) =>
        admin
          .from('subscriptions')
          .select('user_id, status, created_at, trial_ends_at, canceled_at, last_event_at')
          .in('user_id', part)
          .order('id', { ascending: true })
          .range(from, to)
      ),
      fetchAll<LogRowRaw>('message_log (templates)', (from, to) =>
        admin
          .from('message_log')
          .select('user_id, template, status, attempts, sent_at, updated_at, category')
          .eq('channel', 'email')
          .in('user_id', part)
          .in('template', options.relevantTemplates)
          .order('id', { ascending: true })
          .range(from, to)
      ),
      fetchAll<LogRowRaw>('message_log (last 7 days)', (from, to) =>
        admin
          .from('message_log')
          .select('user_id, template, status, attempts, sent_at, updated_at, category')
          .eq('channel', 'email')
          .in('user_id', part)
          .gte('sent_at', since)
          .order('id', { ascending: true })
          .range(from, to)
      ),
    ]);

    const eventsByUser = new Map<string, JourneyEvents>();
    for (const row of events) {
      const map = eventsByUser.get(row.user_id) ?? {};
      map[row.event] = row.created_at;
      eventsByUser.set(row.user_id, map);
    }

    const latestSubscription = new Map<string, SubscriptionRowRaw>();
    for (const row of subscriptions) {
      const current = latestSubscription.get(row.user_id);
      if (!current || isNewer(row, current)) latestSubscription.set(row.user_id, row);
    }

    const logsByUser = new Map<string, Map<string, PlanLogRow>>();
    for (const row of [...templateLogs, ...recentLogs]) {
      const map = logsByUser.get(row.user_id) ?? new Map<string, PlanLogRow>();
      map.set(row.template, toLogRow(row, now));
      logsByUser.set(row.user_id, map);
    }

    for (const row of users) {
      const user: PlanUser = {
        id: row.id,
        email: row.email,
        name: row.name,
        stage: row.stage,
        messagesOptOut: row.messages_opt_out === true,
        emailPrefs: row.email_prefs && typeof row.email_prefs === 'object' ? row.email_prefs : null,
        emailSuppressedAt: row.email_suppressed_at,
      };
      const subscription = latestSubscription.get(row.id);
      out.push({
        user,
        subscription: subscription ? toSubscription(subscription) : null,
        events: eventsByUser.get(row.id) ?? {},
        logs: [...(logsByUser.get(row.id)?.values() ?? [])],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who could possibly have something due (journeys and the weekly report)
// ---------------------------------------------------------------------------

/**
 * The earliest entry time that can still produce a send for a journey: a step
 * is dead once it is past its expiry, and it never fires if it was due before
 * the activation moment.
 */
export function entryLowerBound(args: {
  steps: PlanConfig['steps'];
  journey: JourneyId;
  now: Date;
  activatedAt: string;
}): number {
  const steps = args.steps[args.journey];
  const byExpiry = args.now.getTime() - journeyHorizonMinutes(steps) * 60_000;
  const byActivation = Date.parse(args.activatedAt) - journeyLastStepMinutes(steps) * 60_000;
  return Math.max(byExpiry, byActivation);
}

/**
 * User ids worth loading for the journeys and the weekly report. A superset is
 * fine (the planner decides); what matters is that nobody with a mail due is
 * missed and that old, finished users are not read every ten minutes.
 *
 *   - funnel events inside each journey's horizon (registered / connected / plan_ready)
 *   - subscriptions: trial and past_due journeys, recently cancelled ones
 *   - while a weekly slot is open: every trialing and active subscriber who
 *     does not already have this week's report
 */
export async function findJourneyCandidateIds(
  admin: any,
  args: {
    now: Date;
    activatedAt: string;
    config: Pick<PlanConfig, 'steps' | 'maxAttempts'>;
    weeklyKey: string | null;
  }
): Promise<string[]> {
  const { now, activatedAt, config } = args;
  const bound = (journey: JourneyId) => new Date(entryLowerBound({ steps: config.steps, journey, now, activatedAt })).toISOString();

  const eventIds = (event: UserEventType, since: string) =>
    fetchAll<{ user_id: string }>(`${event} events`, (from, to) =>
      admin.from('user_events').select('user_id').eq('event', event).gte('created_at', since).order('id', { ascending: true }).range(from, to)
    );
  const subscriptionIds = (label: string, build: (query: any) => any) =>
    fetchAll<{ user_id: string }>(label, (from, to) =>
      build(admin.from('subscriptions').select('user_id')).order('id', { ascending: true }).range(from, to)
    );

  const canceledSince = new Date(
    Math.min(Date.parse(bound('canceled')), Date.parse(bound('trial_lapsed')))
  ).toISOString();

  const [registered, connected, planReady, trialing, pastDue, canceled, canceledNoDate, weeklyAll, weeklyHandled] = await Promise.all([
    eventIds('registration_completed', bound('registered')),
    eventIds('ads_account_connected', bound('connected')),
    eventIds('first_analysis_viewed', bound('plan_ready')),
    subscriptionIds('trialing subscriptions', (q) => q.eq('status', 'trialing').gte('created_at', bound('trial'))),
    subscriptionIds('past_due subscriptions', (q) => q.eq('status', 'past_due')),
    subscriptionIds('canceled subscriptions', (q) => q.eq('status', 'canceled').gte('canceled_at', canceledSince)),
    // A cancelled trial whose canceled_at was never written is dated by its trial end.
    subscriptionIds('canceled subscriptions (trial end)', (q) => q.eq('status', 'canceled').gte('trial_ends_at', canceledSince)),
    args.weeklyKey
      ? subscriptionIds('subscribers', (q) => q.in('status', ['trialing', 'active']))
      : Promise.resolve([] as Array<{ user_id: string }>),
    args.weeklyKey ? loadHandledUserIds(admin, args.weeklyKey, now, config.maxAttempts) : Promise.resolve(new Set<string>()),
  ]);

  const ids = new Set<string>();
  for (const list of [registered, connected, planReady, trialing, pastDue, canceled, canceledNoDate]) {
    for (const row of list) ids.add(row.user_id);
  }
  for (const row of weeklyAll) {
    if (!weeklyHandled.has(row.user_id)) ids.add(row.user_id);
  }
  return [...ids];
}

/** Everyone whose message_log row for this template is settled (sent, skipped, in flight, out of attempts). */
export async function loadHandledUserIds(admin: any, templateKey: string, now: Date, maxAttempts: number): Promise<Set<string>> {
  const rows = await fetchAll<LogRowRaw>(`message_log (${templateKey})`, (from, to) =>
    admin
      .from('message_log')
      .select('user_id, template, status, attempts, sent_at, updated_at')
      .eq('channel', 'email')
      .eq('template', templateKey)
      .order('id', { ascending: true })
      .range(from, to)
  );
  const handled = new Set<string>();
  for (const row of rows) {
    if (isHandled(toLogRow(row, now), maxAttempts)) handled.add(row.user_id);
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Who could be in a broadcast segment
// ---------------------------------------------------------------------------

const STAGES_FOR_SEGMENT: Partial<Record<SegmentId, string[]>> = {
  all: ['registered', 'connected', 'analysis_viewed', 'subscribed'],
  registered_not_connected: ['registered'],
  connected_no_trial: ['connected', 'analysis_viewed'],
};
const SUBSCRIPTION_STATUS_FOR_SEGMENT: Partial<Record<SegmentId, string[]>> = {
  trial_lapsed: ['canceled'],
  canceled: ['canceled'],
  subscribers: ['trialing', 'active'],
};

/**
 * Up to `limit` user ids that may belong to the segment, in a stable order,
 * skipping `exclude` (already handled for this broadcast, or already mailed in
 * this run). A narrowing query only: the planner re-checks membership exactly.
 */
export async function findSegmentCandidateIds(
  admin: any,
  segment: SegmentId,
  args: { exclude: ReadonlySet<string>; limit: number }
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const stages = STAGES_FOR_SEGMENT[segment];
  const statuses = SUBSCRIPTION_STATUS_FOR_SEGMENT[segment];

  for (let from = 0; out.length < args.limit; from += PAGE) {
    const { data, error } = stages
      ? await admin.from('users').select('id').in('stage', stages).order('id', { ascending: true }).range(from, from + PAGE - 1)
      : await admin
          .from('subscriptions')
          .select('user_id')
          .in('status', statuses ?? [])
          .order('user_id', { ascending: true })
          .range(from, from + PAGE - 1);
    if (error) throw new Error(`email-lifecycle: could not load segment ${segment} (${error.code ?? 'error'})`);
    for (const row of (data ?? []) as Array<{ id?: string; user_id?: string }>) {
      const id = (stages ? row.id : row.user_id) as string;
      if (!id || seen.has(id) || args.exclude.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= args.limit) break;
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}
