import type { AccountSignals, SignalKey } from './types';

/** A read older than this is read again on the next onboarding visit. */
export const SIGNALS_TTL_HOURS = 24;

/**
 * A stored read that has failed signals is trusted only this long, so one bad
 * minute at Google does not pin the customer to a half-empty read for a day.
 */
export const SIGNALS_RETRY_AFTER_MINUTES = 30;

/** Every signal the read produces, in the order the operator page lists them. */
export const SIGNAL_KEYS: readonly SignalKey[] = [
  'campaigns',
  'enabledConversionActions',
  'conversionsByGroup',
  'autoTagging',
  'landingHosts',
  'merchantCenterLinked',
  'assets',
  'targetedPlaces',
  'externalManager',
  'otherEditors14d',
  'hours',
  'products',
];

export function signalsJobName(accountId: string) {
  return `onboarding_signals:${accountId}`;
}

/** How many of the twelve signals read fine. */
export function countOkSignals(signals: AccountSignals) {
  return SIGNAL_KEYS.filter((key) => signals[key]?.ok === true).length;
}

/** `key:code` for every failed signal, for the job row and the logs (never customer data). */
export function failedSignalList(signals: AccountSignals) {
  return SIGNAL_KEYS.flatMap((key) => {
    const read = signals[key];
    return read && read.ok === false ? [`${key}:${read.error ?? 'unknown'}`] : [];
  });
}

/** Shape check for a value read back from JSONB: version 1, a readable time, every signal an object with `ok`. */
function parseStored(value: unknown): AccountSignals | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.readAt !== 'string' || Number.isNaN(Date.parse(record.readAt))) return null;
  if (typeof record.customerId !== 'string' || typeof record.currency !== 'string') return null;
  for (const key of SIGNAL_KEYS) {
    const read = record[key] as { ok?: unknown } | undefined;
    if (!read || typeof read !== 'object' || typeof read.ok !== 'boolean') return null;
  }
  return record as unknown as AccountSignals;
}

/** Milliseconds between the read and `now`. A read stamped in the future counts as brand new, not as stale. */
function ageMs(signals: AccountSignals, now: Date) {
  return Math.max(0, now.getTime() - Date.parse(signals.readAt));
}

/**
 * Should the onboarding route trust this stored read instead of reading the
 * account again? Only when it is inside the TTL and either clean or recent
 * enough that a retry would just repeat the same trouble.
 */
export function canReuseStoredSignals(signals: AccountSignals | null, now: Date = new Date()) {
  if (!signals) return false;
  const age = ageMs(signals, now);
  if (age > SIGNALS_TTL_HOURS * 3_600_000) return false;
  if (countOkSignals(signals) === SIGNAL_KEYS.length) return true;
  return age < SIGNALS_RETRY_AFTER_MINUTES * 60_000;
}

/** The newest stored read for one linked account row, or null. Never throws. */
export async function loadStoredSignals(admin: any, accountId: string, now: Date = new Date()): Promise<AccountSignals | null> {
  try {
    const { data, error } = await admin
      .from('job_runs')
      .select('details')
      .eq('job_name', signalsJobName(accountId))
      .in('status', ['success', 'partial'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const signals = parseStored((data as { details?: { signals?: unknown } }).details?.signals);
    if (!signals) return null;
    if (ageMs(signals, now) > SIGNALS_TTL_HOURS * 3_600_000) return null;
    return signals;
  } catch {
    return null;
  }
}

/** Stores one read as a `job_runs` row (status success, or partial when any signal failed). Never throws. */
export async function saveSignals(admin: any, accountId: string, signals: AccountSignals): Promise<boolean> {
  try {
    if (!signals || signals.version !== 1) return false;
    const processed = countOkSignals(signals);
    const failed = failedSignalList(signals);
    const { error } = await admin.from('job_runs').insert({
      job_name: signalsJobName(accountId),
      status: failed.length === 0 ? 'success' : 'partial',
      finished_at: new Date().toISOString(),
      processed,
      error_count: failed.length,
      error_message: failed.length > 0 ? failed.join(', ').slice(0, 500) : null,
      details: { signals },
    });
    if (error) {
      console.warn('[onboarding-signals] save failed');
      return false;
    }
    return true;
  } catch {
    console.warn('[onboarding-signals] save failed');
    return false;
  }
}
