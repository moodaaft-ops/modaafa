import { computeFunnel, type FunnelEvent, type FunnelReport, type FunnelUser } from '@/lib/stages/funnel';
import { USER_EVENT_TYPES } from '@/lib/stages/types';

const PAGE = 1000;

/** Reads every user and every stage event (paged) and builds the report. */
export async function loadFunnelReport(admin: any, now = new Date()): Promise<FunnelReport> {
  const users: FunnelUser[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('users')
      .select('id, stage, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`funnel: could not load users (${error.code ?? 'error'})`);
    for (const row of data ?? []) users.push({ id: row.id, stage: row.stage, createdAt: row.created_at });
    if (!data || data.length < PAGE) break;
  }

  const events: FunnelEvent[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('user_events')
      .select('user_id, event_type')
      .in('event_type', USER_EVENT_TYPES.filter((type) => type !== 'welcome_email_sent'))
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`funnel: could not load events (${error.code ?? 'error'})`);
    for (const row of data ?? []) events.push({ userId: row.user_id, eventType: row.event_type });
    if (!data || data.length < PAGE) break;
  }

  return computeFunnel({ users, events, now });
}
