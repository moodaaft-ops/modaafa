/**
 * Ops-alert dedup for the sync and optimize crons.
 *
 * Both crons e-mailed the full error list on EVERY run, so one persistent
 * condition (a closed Google account, a bad query) produced up to 48 identical
 * e-mails a day and buried real incidents. The decision is stored inside the
 * job_runs.details the cron already writes, so no new table is needed:
 * `alert_fingerprint` (sorted error codes, ids/numbers normalised away) and
 * `alerted`. The same fingerprint is e-mailed at most once per 24h; a TOTAL
 * failure (nothing processed although accounts were attempted) is always
 * allowed through unless one was already sent in the last 6h.
 */

export type AlertableError = string | { customer_id?: string | null; message?: string | null };

const FINGERPRINT_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOTAL_FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;

const LEADING_ACCOUNT_ID = /^\s*(\d[\d-]{5,})\s*:\s*/;
// Google error enums look like OPERATOR_FIELD_MISMATCH / CUSTOMER_NOT_ENABLED.
const GOOGLE_ERROR_CODE = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/;

function entryText(entry: AlertableError) {
  return typeof entry === 'string' ? entry : String(entry?.message ?? '');
}

function entryAccountId(entry: AlertableError) {
  if (typeof entry !== 'string') return entry?.customer_id ? String(entry.customer_id) : null;
  return LEADING_ACCOUNT_ID.exec(entry)?.[1] ?? null;
}

/** Collapse one error into a stable label: ids, numbers and free text removed. */
export function normalizeErrorCode(entry: AlertableError): string {
  const text = entryText(entry).replace(LEADING_ACCOUNT_ID, '').trim();
  const googleCode = GOOGLE_ERROR_CODE.exec(text)?.[0];
  if (googleCode) return googleCode;
  const label = (text.split(':')[0] || 'unknown')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '#')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 60);
  return label || 'unknown';
}

export function summarizeErrors(errors: readonly AlertableError[], attemptedAccounts: number) {
  const counts: Record<string, number> = {};
  const failedAccounts = new Set<string>();
  for (const entry of errors) {
    const code = normalizeErrorCode(entry);
    counts[code] = (counts[code] ?? 0) + 1;
    const accountId = entryAccountId(entry);
    if (accountId) failedAccounts.add(accountId);
  }
  const codes = Object.keys(counts).sort();
  const fingerprint = codes.join('|');
  const breakdown = codes.map((code) => `${code} ×${counts[code]}`).join('، ');
  const failed = failedAccounts.size;
  const summaryAr =
    failed > 0
      ? `فشل ${failed} من ${Math.max(attemptedAccounts, failed)} حساب: ${breakdown}`
      : `أخطاء في المهمة: ${breakdown}`;
  return { counts, fingerprint, summaryAr };
}

/** Pure decision, separated from the lookups so it is trivially testable. */
export function decideAlert({
  isTotalFailure,
  fingerprintAlertedRecently,
  totalFailureAlertedRecently,
}: {
  isTotalFailure: boolean;
  fingerprintAlertedRecently: boolean;
  totalFailureAlertedRecently: boolean;
}) {
  return isTotalFailure ? !totalFailureAlertedRecently : !fingerprintAlertedRecently;
}

export type OpsAlertPlan = {
  send: boolean;
  summaryAr: string;
  /** Merge into the job_runs.details written by finishJobRun. */
  details: Record<string, unknown>;
};

export async function planOpsAlert({
  supabase,
  jobName,
  errors,
  attemptedAccounts,
  processed,
  now = new Date(),
}: {
  supabase: any;
  jobName: string;
  errors: readonly AlertableError[];
  attemptedAccounts: number;
  processed: number;
  now?: Date;
}): Promise<OpsAlertPlan> {
  const { counts, fingerprint, summaryAr } = summarizeErrors(errors, attemptedAccounts);
  const isTotalFailure = attemptedAccounts > 0 && processed === 0;

  let fingerprintAlertedRecently = false;
  let totalFailureAlertedRecently = false;
  try {
    const alertedSince = (filters: Record<string, string>, windowMs: number) => {
      let query = supabase
        .from('job_runs')
        .select('id')
        .eq('job_name', jobName)
        .gte('started_at', new Date(now.getTime() - windowMs).toISOString())
        .eq('details->>alerted', 'true');
      for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
      return query.limit(1).maybeSingle();
    };

    if (isTotalFailure) {
      const { data, error } = await alertedSince({ 'details->>alert_kind': 'total_failure' }, TOTAL_FAILURE_WINDOW_MS);
      if (error) throw error;
      totalFailureAlertedRecently = Boolean(data);
    } else {
      const { data, error } = await alertedSince({ 'details->>alert_fingerprint': fingerprint }, FINGERPRINT_WINDOW_MS);
      if (error) throw error;
      fingerprintAlertedRecently = Boolean(data);
    }
  } catch (error) {
    // Fail open: a broken dedup lookup must never swallow a real alert.
    console.error('Ops alert dedup lookup failed; alerting anyway', { jobName, error });
  }

  const send = decideAlert({ isTotalFailure, fingerprintAlertedRecently, totalFailureAlertedRecently });
  return {
    send,
    summaryAr,
    details: {
      alert_fingerprint: fingerprint,
      alert_kind: isTotalFailure ? 'total_failure' : 'errors',
      alert_summary: summaryAr,
      error_codes: counts,
      alerted: send,
    },
  };
}
