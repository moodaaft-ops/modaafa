import { send, type SendDeps, type SendResult } from './send';

const TEMPLATE = 'welcome_ads_connect' as const;
/** Catch-up window after an outage. The target is 1 minute, the ceiling 5. */
const CATCH_UP_HOURS = 48;
const SENDING_LEASE_MS = 10 * 60 * 1000;

export type WelcomeSweepSummary = {
  checked: number;
  sent: number;
  skipped: number;
  duplicate: number;
  failed: number;
  not_configured: number;
};

/**
 * Sends the sign-up follow-up to everyone who has a registration_completed
 * event and no finished welcome message yet. Safe to call every minute and
 * from several places at once (claim_message decides the winner).
 */
export async function sendDueWelcomeEmails(
  supabase: any,
  options: { limit?: number; userId?: string; deps?: Omit<SendDeps, 'supabase'>; now?: Date } = {}
): Promise<WelcomeSweepSummary> {
  const summary: WelcomeSweepSummary = {
    checked: 0, sent: 0, skipped: 0, duplicate: 0, failed: 0, not_configured: 0,
  };
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - CATCH_UP_HOURS * 3600 * 1000).toISOString();

  let eventsQuery = supabase
    .from('user_events')
    .select('user_id, created_at')
    .eq('event', 'registration_completed')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(options.limit ?? 25);
  if (options.userId) eventsQuery = eventsQuery.eq('user_id', options.userId);

  const { data: events, error: eventsError } = await eventsQuery;
  if (eventsError) throw new Error(`welcome sweep: events lookup failed: ${eventsError.message}`);
  const ids: string[] = (events ?? []).map((row: { user_id: string }) => row.user_id);
  if (ids.length === 0) return summary;

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
    if (finished.has(id) || connected.has(id)) continue;
    const user = usersById.get(id);
    if (!user?.email) continue;
    summary.checked += 1;
    const result: SendResult = await send('email', TEMPLATE, user, { ...options.deps, supabase });
    if (result.status === 'sent') summary.sent += 1;
    else if (result.status === 'skipped') summary.skipped += 1;
    else if (result.status === 'duplicate') summary.duplicate += 1;
    else if (result.status === 'not_configured') summary.not_configured += 1;
    else summary.failed += 1;
  }

  return summary;
}
