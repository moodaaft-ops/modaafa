import type { AccountSignals } from './types';

/** A read older than this is read again on the next onboarding visit. */
export const SIGNALS_TTL_HOURS = 24;

export function signalsJobName(accountId: string) {
  return `onboarding_signals:${accountId}`;
}

/** CONTRACT (part A): the newest stored read for one linked account row, or null. Never throws. */
export async function loadStoredSignals(admin: any, accountId: string, now: Date = new Date()): Promise<AccountSignals | null> {
  void admin;
  void accountId;
  void now;
  return null;
}

/** CONTRACT (part A): stores one read as a `job_runs` row (status success, or partial when any signal failed). Never throws. */
export async function saveSignals(admin: any, accountId: string, signals: AccountSignals): Promise<boolean> {
  void admin;
  void accountId;
  void signals;
  return false;
}
