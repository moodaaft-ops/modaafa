/**
 * Wall-clock helpers for a Google Ads account's own time zone. Google reads
 * conversion times and data-exclusion windows in the account zone, and Intl is
 * enough to do that without a date library.
 */
export const DEFAULT_ACCOUNT_TIME_ZONE = 'Asia/Riyadh';

/** Minutes the zone is ahead of UTC at that instant (Riyadh: 180). Throws on an unknown zone. */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

export function safeZone(timeZone: string | null | undefined): string {
  const zone = timeZone || DEFAULT_ACCOUNT_TIME_ZONE;
  try {
    zoneOffsetMinutes(new Date(0), zone);
    return zone;
  } catch {
    return DEFAULT_ACCOUNT_TIME_ZONE;
  }
}

function pad(value: number) {
  return String(Math.abs(value)).padStart(2, '0');
}

/** "yyyy-MM-dd HH:mm:ss" as the account's clock reads at that instant. */
export function formatAccountLocal(date: Date, timeZone: string | null | undefined): string {
  const zone = safeZone(timeZone);
  const local = new Date(date.getTime() + zoneOffsetMinutes(date, zone) * 60_000);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  );
}

/** "+03:00" style suffix for the instant. */
export function formatOffset(date: Date, timeZone: string | null | undefined): string {
  const minutes = zoneOffsetMinutes(date, safeZone(timeZone));
  return `${minutes < 0 ? '-' : '+'}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Parses "yyyy-MM-dd HH:mm:ss" as plain wall-clock numbers (no zone), for comparing two such strings. */
export function wallClockMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as unknown as number[];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  // Rejects 2026-02-31 and friends that Date.UTC would roll over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return ms;
}
