/**
 * Period dates for saved reports.
 *
 * `reports.period_start` / `period_end` are DATE columns: plain calendar days
 * with no time zone. They are parsed and printed in UTC so a day never slides
 * to its neighbour because of the viewer's offset. Gregorian calendar and
 * Latin digits, like the rest of the UI.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shiftDateOnly(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

const dayMonth = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
});
const dayMonthYear = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** "من 30 سبتمبر إلى 7 أكتوبر 2026". The year is written once when both ends share it. */
export function formatPeriodRangeAr(start: Date, end: Date): string {
  if (start.getTime() === end.getTime()) return dayMonthYear.format(start);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const from = sameYear ? dayMonth.format(start) : dayMonthYear.format(start);
  return `من ${from} إلى ${dayMonthYear.format(end)}`;
}

/** Same, straight from the two DATE column values. Null when either is missing. */
export function reportPeriodLabel(
  start: string | null | undefined,
  end: string | null | undefined
): string | null {
  const from = parseDateOnly(start);
  const to = parseDateOnly(end);
  if (!from || !to || from.getTime() > to.getTime()) return null;
  return formatPeriodRangeAr(from, to);
}

/**
 * The comparison week of a weekly report: the seven days that end the day
 * before this week starts. This is the window the weekly job queries
 * (`now - 14` to `now - 8` against a start of `now - 7`).
 */
export function priorWeekLabel(start: string | null | undefined): string | null {
  const from = parseDateOnly(start);
  if (!from) return null;
  return formatPeriodRangeAr(shiftDateOnly(from, -7), shiftDateOnly(from, -1));
}
