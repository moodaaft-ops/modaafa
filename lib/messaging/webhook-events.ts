import { allOptionalOff, normalizePrefs } from './prefs';

/**
 * What a Resend webhook event does to our records.
 *
 *   email.delivered   message_log.delivered_at (first time only)
 *   email.opened      message_log.opened_at    (first time only)
 *   email.clicked     message_log.clicked_at   (first time only; click_count is
 *                     counted by our own /m/c redirect, not here, so a click is
 *                     never counted twice)
 *   email.bounced     message_log.bounced_at; a hard (Permanent) bounce also
 *                     suppresses the address
 *   email.complained  message_log.complained_at, suppresses the address and
 *                     turns every optional category off
 *
 * Every write only fills a column that is still empty, so Svix retrying the
 * same event, or Resend sending it twice, changes nothing. An event whose
 * email id is not in message_log is ignored without an error (billing mail is
 * not logged); a bounce or complaint for such mail still suppresses the user
 * when the recipient address belongs to one.
 */
export type ResendEvent = {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown } | null;
  } | null;
};

export type EventOutcome =
  | { status: 'applied'; detail?: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string };

type LogRow = {
  id: string;
  user_id: string;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
};

const COLUMN_BY_EVENT: Record<string, keyof Pick<LogRow, 'delivered_at' | 'opened_at' | 'clicked_at' | 'bounced_at' | 'complained_at'>> = {
  'email.delivered': 'delivered_at',
  'email.opened': 'opened_at',
  'email.clicked': 'clicked_at',
  'email.bounced': 'bounced_at',
  'email.complained': 'complained_at',
};

function eventTime(event: ResendEvent, now: Date): string {
  if (typeof event.created_at === 'string') {
    const ms = new Date(event.created_at).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return now.toISOString();
}

/** Resend marks a permanent failure "Permanent". A bounce without a type is treated as permanent. */
function isHardBounce(event: ResendEvent): boolean {
  const type = event.data?.bounce?.type;
  if (typeof type !== 'string') return true;
  return type.trim().toLowerCase() === 'permanent';
}

async function suppressUser(
  admin: any,
  userId: string,
  reason: 'hard_bounce' | 'complaint',
  at: string,
  optionalOff: boolean
): Promise<boolean> {
  const { data: row, error } = await admin
    .from('users')
    .select('email_prefs, email_suppressed_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`user lookup failed: ${error.message ?? 'unknown'}`);
  if (!row) return false;

  const patch: Record<string, unknown> = {};
  if (!row.email_suppressed_at) {
    patch.email_suppressed_at = at;
    patch.email_suppressed_reason = reason;
  }
  if (optionalOff) {
    const current = normalizePrefs(row.email_prefs);
    const next = allOptionalOff(current);
    if (JSON.stringify(next) !== JSON.stringify(current)) patch.email_prefs = next;
  }
  if (Object.keys(patch).length === 0) return false;

  const { error: updateError } = await admin.from('users').update(patch).eq('id', userId);
  if (updateError) throw new Error(`user update failed: ${updateError.message ?? 'unknown'}`);
  return true;
}

export async function applyResendEvent(admin: any, event: ResendEvent, now: Date = new Date()): Promise<EventOutcome> {
  const type = typeof event.type === 'string' ? event.type : '';
  const column = COLUMN_BY_EVENT[type];
  if (!column) return { status: 'ignored', reason: 'event_type' };

  const emailId = typeof event.data?.email_id === 'string' ? event.data.email_id : '';
  if (!emailId) return { status: 'ignored', reason: 'no_email_id' };

  const at = eventTime(event, now);
  const hardBounce = type === 'email.bounced' && isHardBounce(event);
  const complaint = type === 'email.complained';

  const { data: rows, error } = await admin
    .from('message_log')
    .select('id, user_id, delivered_at, opened_at, clicked_at, bounced_at, complained_at')
    .eq('provider_id', emailId)
    .limit(1);
  if (error) throw new Error(`message_log lookup failed: ${error.message ?? 'unknown'}`);
  const row = (rows?.[0] ?? null) as LogRow | null;

  if (!row) {
    // Billing mail is not logged. A bounce or complaint on it must still stop
    // further mail to that address, so fall back to the recipient.
    if (!hardBounce && !complaint) return { status: 'ignored', reason: 'unknown_email_id' };
    const to = Array.isArray(event.data?.to) ? event.data?.to.find((v) => typeof v === 'string') : null;
    if (typeof to !== 'string' || !to.trim()) return { status: 'ignored', reason: 'unknown_email_id' };
    const { data: users, error: userError } = await admin
      .from('users')
      .select('id')
      .eq('email', to.trim().toLowerCase())
      .limit(1);
    if (userError) throw new Error(`user lookup failed: ${userError.message ?? 'unknown'}`);
    const userId = (users?.[0] as { id?: string } | undefined)?.id;
    if (!userId) return { status: 'ignored', reason: 'unknown_email_id' };
    const changed = await suppressUser(admin, userId, complaint ? 'complaint' : 'hard_bounce', at, complaint);
    return changed ? { status: 'applied', detail: 'suppressed_by_address' } : { status: 'duplicate' };
  }

  let changed = false;
  if (row[column] === null || row[column] === undefined) {
    const { error: updateError } = await admin
      .from('message_log')
      .update({ [column]: at })
      .eq('id', row.id);
    if (updateError) throw new Error(`message_log update failed: ${updateError.message ?? 'unknown'}`);
    changed = true;
  }

  if (hardBounce || complaint) {
    const suppressed = await suppressUser(admin, row.user_id, complaint ? 'complaint' : 'hard_bounce', at, complaint);
    changed = changed || suppressed;
  }

  return changed ? { status: 'applied' } : { status: 'duplicate' };
}
