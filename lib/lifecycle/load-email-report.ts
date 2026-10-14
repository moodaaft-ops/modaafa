import { isHoldout } from './holdout';
import {
  computeEmailReport,
  type EmailLogRow,
  type EmailReport,
  type ReportEvent,
  type ReportOptOut,
  type ReportTrial,
} from './email-report';
import {
  REPORT_ACTIVATED_AT,
  REPORT_HOLDOUT_PERCENT,
  REPORT_STEPS,
  type ReportStep,
} from './report-steps';

const PAGE = 1000;

/** The four events the journeys are measured by (welcome_email_sent, onboarding_viewed and connect_clicked move nothing). */
const MEASURED_EVENTS = ['registration_completed', 'ads_account_connected', 'first_analysis_viewed', 'subscription_paid'];

const BASE_LOG_COLUMNS = 'user_id, template, status, sent_at';
const FULL_LOG_COLUMNS = `${BASE_LOG_COLUMNS}, copy_key, delivered_at, opened_at, clicked_at, bounced_at, complained_at`;

export type LoadEmailReportConfig = {
  steps?: ReportStep[];
  activatedAt?: string | null;
  holdoutPercent?: number;
};

type DbError = { code?: string | null; message?: string | null };
type PageResult = { data: Array<Record<string, any>> | null; error: DbError | null };

async function readAll(
  page: (from: number, to: number) => PromiseLike<PageResult>
): Promise<{ rows: Array<Record<string, any>>; error: DbError | null }> {
  const rows: Array<Record<string, any>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { rows: [], error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return { rows, error: null };
}

/** Postgres "undefined column": the delivery columns are added by 20261014_email_lifecycle.sql. */
function isMissingColumn(error: DbError | null): boolean {
  if (!error) return false;
  return error.code === '42703' || /column .* does not exist|could not find the .* column/i.test(error.message ?? '');
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * Reads the mail sent, the people, their stage events and their trials, then
 * hands them to computeEmailReport.
 *
 *  - message_log: channel 'email', status 'sent'. If the delivery columns do
 *    not exist yet it is read again without them and `engagementTracked` is
 *    false, so the page says "غير متاح" instead of showing zeros.
 *  - users: id and messages_opt_out_at (the unsubscribe link sets it).
 *  - user_events: the four measured events, with times.
 *  - subscriptions: rows with a trial_ends_at. If this read fails the trial
 *    comparisons are left out and everything else still shows.
 *
 * Throws when message_log, users or user_events cannot be read (the page then
 * shows its error box); the trial read is the only one that degrades.
 */
export async function loadEmailReport(
  admin: any,
  now: Date = new Date(),
  config: LoadEmailReportConfig = {}
): Promise<EmailReport> {
  let engagementTracked = true;
  let logRead = await readAll((from, to) =>
    admin
      .from('message_log')
      .select(FULL_LOG_COLUMNS)
      .eq('channel', 'email')
      .eq('status', 'sent')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );
  if (isMissingColumn(logRead.error)) {
    engagementTracked = false;
    logRead = await readAll((from, to) =>
      admin
        .from('message_log')
        .select(BASE_LOG_COLUMNS)
        .eq('channel', 'email')
        .eq('status', 'sent')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    );
  }
  if (logRead.error) throw new Error(`email report: could not load message_log (${logRead.error.code ?? 'error'})`);

  const userRead = await readAll((from, to) =>
    admin
      .from('users')
      .select('id, messages_opt_out_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );
  if (userRead.error) throw new Error(`email report: could not load users (${userRead.error.code ?? 'error'})`);

  const eventRead = await readAll((from, to) =>
    admin
      .from('user_events')
      .select('user_id, event, created_at')
      .in('event', MEASURED_EVENTS)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );
  if (eventRead.error) throw new Error(`email report: could not load events (${eventRead.error.code ?? 'error'})`);

  let trials: ReportTrial[] | null = null;
  try {
    const trialRead = await readAll((from, to) =>
      admin
        .from('subscriptions')
        .select('user_id, created_at, trial_ends_at, canceled_at')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    );
    if (trialRead.error) {
      console.error('[email-report] trials not read, trial comparisons left out', trialRead.error.code ?? 'error');
    } else {
      trials = trialRead.rows
        .filter((row) => row.trial_ends_at && row.created_at && row.user_id)
        .map((row) => ({
          userId: String(row.user_id),
          startedAt: String(row.created_at),
          endsAt: text(row.trial_ends_at),
          canceledAt: text(row.canceled_at),
        }));
    }
  } catch {
    console.error('[email-report] trials not read, trial comparisons left out');
  }

  const logs: EmailLogRow[] = logRead.rows.map((row) => ({
    userId: String(row.user_id),
    template: String(row.template),
    copyKey: text(row.copy_key),
    status: String(row.status),
    sentAt: text(row.sent_at),
    deliveredAt: text(row.delivered_at),
    openedAt: text(row.opened_at),
    clickedAt: text(row.clicked_at),
    bouncedAt: text(row.bounced_at),
    complainedAt: text(row.complained_at),
  }));

  const optOuts: ReportOptOut[] = userRead.rows
    .filter((row) => text(row.messages_opt_out_at))
    .map((row) => ({ userId: String(row.id), at: String(row.messages_opt_out_at) }));

  const events: ReportEvent[] = eventRead.rows.map((row) => ({
    userId: String(row.user_id),
    eventType: String(row.event),
    createdAt: String(row.created_at),
  }));

  const holdoutPercent = config.holdoutPercent ?? REPORT_HOLDOUT_PERCENT;
  return computeEmailReport({
    now,
    logs,
    userIds: userRead.rows.map((row) => String(row.id)),
    optOuts,
    events,
    trials,
    steps: config.steps ?? REPORT_STEPS,
    activatedAt: config.activatedAt === undefined ? REPORT_ACTIVATED_AT : config.activatedAt,
    holdoutPercent,
    isHoldout: (userId) => isHoldout(userId, holdoutPercent),
    engagementTracked,
  });
}
