import { formatSAR } from '@/lib/utils';

const timeFormat = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  timeZone: 'Asia/Riyadh',
  hour: 'numeric',
  minute: '2-digit',
});

const dayFormat = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const shortDayFormat = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh',
  day: 'numeric',
  month: 'short',
});

export function riyadhTime(value: number | string | Date) {
  return timeFormat.format(new Date(value));
}

/** "الأربعاء 15 أكتوبر" for a YYYY-MM-DD Riyadh calendar day. */
export function riyadhDayLabel(day: string) {
  return dayFormat.format(new Date(`${day}T12:00:00+03:00`));
}

export function shortDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : shortDayFormat.format(date);
}

export function sar(amount: number) {
  return formatSAR(Math.round(amount));
}

export const OPERATOR_ACTION_LABELS: Record<string, string> = {
  extend_trial: 'مدّد التجربة',
  grant_plan: 'أعطى خطة مجانية',
  revoke_plan: 'سحب الخطة المجانية',
  suspend: 'أوقف الحساب',
  unsuspend: 'رجّع الحساب',
};

export function percent(value: number | null) {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

const usdFormats = new Map<number, Intl.NumberFormat>();

/** "$1.23" with Latin digits. Callers wrap it in <bdi dir="ltr"> so the sign stays in front. */
export function usd(amount: number, digits = 2) {
  let format = usdFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
    usdFormats.set(digits, format);
  }
  return `$${format.format(amount)}`;
}
