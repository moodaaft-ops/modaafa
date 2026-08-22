export const DATE_RANGE_PRESETS = [
  { key: '7d', label: 'آخر 7 أيام', days: 7 },
  { key: '30d', label: 'آخر 30 يوماً', days: 30 },
  { key: '90d', label: 'آخر 90 يوماً', days: 90 },
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number]['key'];
export type DateRangeKey = DateRangePreset | 'custom';

export type DateRangeSelection = {
  key: DateRangeKey;
  from: string;
  to: string;
  days: number;
  label: string;
  metricKey: 'metrics_7d' | 'metrics_30d' | null;
  error: string | null;
};

export type DateRangeSearchParams = {
  range?: string | null;
  from?: string | null;
  to?: string | null;
};

export const MAX_CUSTOM_RANGE_DAYS = 366;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function resolveDateRange(
  params: DateRangeSearchParams | null | undefined,
  defaultPreset: DateRangePreset,
  now = new Date()
): DateRangeSelection {
  const today = toIsoDate(now);
  const requestedKey = normalizeRangeKey(params?.range);

  if (requestedKey === 'custom') {
    const validation = validateCustomDateRange(params?.from, params?.to, today);
    if (validation.ok) {
      return {
        key: 'custom',
        from: validation.from,
        to: validation.to,
        days: validation.days,
        label: `من ${formatIsoDateAr(validation.from)} إلى ${formatIsoDateAr(validation.to)}`,
        metricKey: null,
        error: null,
      };
    }

    return {
      ...presetSelection(defaultPreset, today),
      error: validation.error,
    };
  }

  return presetSelection(requestedKey ?? defaultPreset, today);
}

export function validateCustomDateRange(
  fromValue: string | null | undefined,
  toValue: string | null | undefined,
  today = toIsoDate(new Date())
):
  | { ok: true; from: string; to: string; days: number }
  | { ok: false; error: string } {
  const from = String(fromValue ?? '').trim();
  const to = String(toValue ?? '').trim();

  if (!from || !to) {
    return { ok: false, error: 'حدد تاريخ البداية والنهاية للفترة المخصصة.' };
  }
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return { ok: false, error: 'صيغة التاريخ غير صحيحة. اختر التاريخ من الحقول المخصصة.' };
  }
  if (from > to) {
    return { ok: false, error: 'تاريخ البداية يجب أن يسبق تاريخ النهاية.' };
  }
  if (to > today) {
    return { ok: false, error: 'لا يمكن أن ينتهي التقرير بتاريخ مستقبلي.' };
  }

  const days = inclusiveDays(from, to);
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    return {
      ok: false,
      error: `الحد الأقصى للفترة المخصصة ${MAX_CUSTOM_RANGE_DAYS} يوماً حتى يبقى التقرير سريعاً ودقيقاً.`,
    };
  }

  return { ok: true, from, to, days };
}

export function isLiveDateRange(selection: DateRangeSelection) {
  return selection.metricKey === null;
}

export function dateRangeHref(pathname: string, selection: DateRangeSelection) {
  const params = new URLSearchParams({ range: selection.key });
  if (selection.key === 'custom') {
    params.set('from', selection.from);
    params.set('to', selection.to);
  }
  return `${pathname}?${params.toString()}`;
}

export function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function presetSelection(key: DateRangePreset, today: string): DateRangeSelection {
  const preset = DATE_RANGE_PRESETS.find((item) => item.key === key) ?? DATE_RANGE_PRESETS[0];
  return {
    key: preset.key,
    from: shiftIsoDate(today, -(preset.days - 1)),
    to: today,
    days: preset.days,
    label: preset.label,
    metricKey:
      preset.key === '7d' ? 'metrics_7d' : preset.key === '30d' ? 'metrics_30d' : null,
    error: null,
  };
}

function normalizeRangeKey(value: string | null | undefined): DateRangeKey | null {
  if (value === 'custom') return value;
  return DATE_RANGE_PRESETS.some((item) => item.key === value)
    ? (value as DateRangePreset)
    : null;
}

function isValidIsoDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && toIsoDate(parsed) === value;
}

function inclusiveDays(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function shiftIsoDate(value: string, offsetDays: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return toIsoDate(date);
}

function formatIsoDateAr(value: string) {
  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${value}T00:00:00.000Z`));
  } catch {
    return value;
  }
}
