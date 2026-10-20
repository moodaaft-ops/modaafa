/**
 * Time helpers for the guard. Google Ads reports dates and change_date_time in
 * the ACCOUNT's time zone, so "yesterday" is computed there, not in UTC.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Riyadh';
const DAY_MS = 86_400_000;

function safeZone(timeZone: string | null | undefined): string {
  const zone = (timeZone ?? '').trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function partsInZone(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** YYYY-MM-DD of an instant in the given zone. */
export function ymdInZone(date: Date, timeZone: string | null | undefined): string {
  const p = partsInZone(date.getTime(), safeZone(timeZone));
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Epoch of a wall-clock "YYYY-MM-DD HH:MM:SS[.ffffff]" read in the given zone; null when it does not parse. */
export function zonedStringToEpoch(text: string, timeZone: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text ?? '').trim());
  if (!match) return null;
  const zone = safeZone(timeZone);
  const [y, m, d, h, mi, s] = match.slice(1).map(Number);
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  let epoch = asUtc;
  // Two passes settle the offset across a DST edge.
  for (let pass = 0; pass < 2; pass += 1) {
    const p = partsInZone(epoch, zone);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    epoch += asUtc - shown;
  }
  return epoch;
}
