import { EMAIL_LIFECYCLE_ACTIVATED_AT } from '@/config/email-journeys';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import { EMPTY_FACTS, type EmailCopy } from '@/lib/lifecycle/types';
import { firstName } from '@/lib/lifecycle/format';
import { sendTemplate, type SendDeps, type SendTemplateResult } from './send';

const TEMPLATE = 'welcome_ads_connect' as const;
/** Catch-up window after an outage. The target is 1 minute, the ceiling 5. */
const CATCH_UP_HOURS = 48;
const SENDING_LEASE_MS = 10 * 60 * 1000;
/** Registration events read per query, and how many queries one run may make (so one run reads at most 1000). */
const EVENT_PAGE_SIZE = 100;
const MAX_EVENT_PAGES = 10;
const DEFAULT_LIMIT = 25;

export type WelcomeSweepSummary = {
  checked: number;
  sent: number;
  skipped: number;
  duplicate: number;
  failed: number;
  not_configured: number;
};

export type WelcomeSweepOptions = {
  /** The most people this run will try to mail. */
  limit?: number;
  userId?: string;
  deps?: Omit<SendDeps, 'supabase'>;
  now?: Date;
  /** For tests. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** For tests. An explicit null means "not activated". */
  activatedAt?: string | null;
  /** For tests. Defaults to the shipped welcome copy. */
  copy?: EmailCopy;
};

/**
 * Sends the sign-up welcome to everyone who has a registration_completed
 * event and no finished welcome message yet. Safe to call every minute and
 * from several places at once (claim_message decides the winner).
 *
 * It runs under the same switches as every other lifecycle mail and does
 * NOTHING (no read, no write) until all of them are open:
 *   - EMAIL_LIFECYCLE_ENABLED is exactly "true"
 *   - EMAIL_LIFECYCLE_ACTIVATED_AT (config/email-journeys.ts) is a real date and
 *     it has passed; registrations before it are never mailed retroactively
 *   - the `welcome_ads_connect` copy in lib/lifecycle/copy.ts is approved
 *
 * The text is the same copy the sign-up flow sends right after registration,
 * so the person gets one welcome in one voice whichever path reaches them
 * first.
 *
 * The oldest people come first, but people who are already handled (sent,
 * skipped, in flight, connected) are filtered while paging, so a backlog of
 * handled sign-ups can never hide a newer one: pages are read until `limit`
 * candidates are found or the bounded scan ends.
 */
export async function sendDueWelcomeEmails(supabase: any, options: WelcomeSweepOptions = {}): Promise<WelcomeSweepSummary> {
  const summary: WelcomeSweepSummary = {
    checked: 0, sent: 0, skipped: 0, duplicate: 0, failed: 0, not_configured: 0,
  };

  const env = options.env ?? process.env;
  if (env.EMAIL_LIFECYCLE_ENABLED !== 'true') return summary;

  const now = options.now ?? new Date();
  const activatedAt = 'activatedAt' in options ? options.activatedAt ?? null : EMAIL_LIFECYCLE_ACTIVATED_AT;
  const activatedMs = activatedAt ? Date.parse(activatedAt) : Number.NaN;
  if (!Number.isFinite(activatedMs) || now.getTime() < activatedMs) return summary;

  const copy = options.copy ?? EMAIL_COPY.welcome_ads_connect;
  // Unapproved copy is skipped without a log row, so those people would stay "due" and eat the run's slots every minute.
  if (!copy.approved) return summary;

  const sinceMs = Math.max(now.getTime() - CATCH_UP_HOURS * 3600 * 1000, activatedMs);
  const since = new Date(sinceMs).toISOString();
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  if (limit === 0) return summary;

  const candidates: any[] = [];
  for (let page = 0; page < MAX_EVENT_PAGES && candidates.length < limit; page += 1) {
    let eventsQuery = supabase
      .from('user_events')
      .select('user_id, created_at')
      .eq('event', 'registration_completed')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * EVENT_PAGE_SIZE, (page + 1) * EVENT_PAGE_SIZE - 1);
    if (options.userId) eventsQuery = eventsQuery.eq('user_id', options.userId);

    const { data: events, error: eventsError } = await eventsQuery;
    if (eventsError) throw new Error(`welcome sweep: events lookup failed: ${eventsError.message}`);
    const ids: string[] = (events ?? []).map((row: { user_id: string }) => row.user_id);
    if (ids.length === 0) break;

    const [logsRes, connectedRes, usersRes] = await Promise.all([
      supabase
        .from('message_log')
        .select('user_id, status, attempts, updated_at')
        .eq('channel', 'email')
        .eq('template', TEMPLATE)
        .in('user_id', ids),
      supabase.from('user_events').select('user_id').eq('event', 'ads_account_connected').in('user_id', ids),
      supabase.from('users').select('id, email, name, messages_opt_out').in('id', ids),
    ]);
    for (const res of [logsRes, connectedRes, usersRes]) {
      if (res.error) throw new Error(`welcome sweep: lookup failed: ${res.error.message}`);
    }

    const finished = new Set<string>();
    for (const log of logsRes.data ?? []) {
      const leaseActive =
        log.status === 'sending' && now.getTime() - new Date(log.updated_at).getTime() < SENDING_LEASE_MS;
      if (log.status === 'sent' || log.status === 'skipped' || leaseActive || (log.status === 'failed' && log.attempts >= 3)) {
        finished.add(log.user_id);
      }
    }
    const connected = new Set<string>((connectedRes.data ?? []).map((r: { user_id: string }) => r.user_id));
    const usersById = new Map<string, any>((usersRes.data ?? []).map((u: any) => [u.id, u]));

    for (const id of ids) {
      if (candidates.length >= limit) break;
      if (finished.has(id) || connected.has(id)) continue;
      const user = usersById.get(id);
      if (!user?.email) continue;
      candidates.push(user);
    }

    // A short page is the last one.
    if (ids.length < EVENT_PAGE_SIZE) break;
  }

  for (const user of candidates) {
    summary.checked += 1;
    const result: SendTemplateResult = await sendTemplate(
      {
        user,
        templateKey: TEMPLATE,
        copy,
        facts: { ...EMPTY_FACTS, firstName: firstName(user.name) || null },
        enforceGap: false,
      },
      { now: () => now, ...options.deps, supabase }
    );
    if (result.status === 'sent') summary.sent += 1;
    else if (result.status === 'skipped') summary.skipped += 1;
    else if (result.status === 'duplicate') summary.duplicate += 1;
    else if (result.status === 'not_configured') summary.not_configured += 1;
    else summary.failed += 1;
  }

  return summary;
}
