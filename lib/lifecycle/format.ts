/**
 * Number, money and date formatting for email copy.
 *
 * Brand rule: Latin digits everywhere, never the Arabic-Indic ones. Nothing
 * here relies on ICU locale data for the Arabic text itself (month names and
 * the currency sign are fixed tables), so the output is the same on every
 * Node build.
 */

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

/** Thousands comma, Latin digits, no decimals unless asked for. */
export function formatNumber(value: number, options: { decimals?: number } = {}): string {
  if (!Number.isFinite(value)) return '0';
  const decimals = options.decimals;
  const text = new Intl.NumberFormat('en-US', {
    useGrouping: true,
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 0,
  }).format(value);
  // "-0" appears for tiny negatives that round to zero.
  return text === '-0' ? '0' : text;
}

/**
 * "1,250 ر.س" for SAR, "1,250 USD" for any other ISO code.
 *
 * Without `decimals`, amounts under 100 keep up to two decimals (a cost per
 * conversion of 12.5 must not become 13) and bigger amounts are whole numbers.
 */
export function formatMoney(amount: number, currency: string | null | undefined, options: { decimals?: number } = {}): string {
  let number: string;
  if (options.decimals !== undefined) {
    number = formatNumber(amount, { decimals: options.decimals });
  } else if (Math.abs(amount) < 100 && !Number.isInteger(amount)) {
    number = new Intl.NumberFormat('en-US', {
      useGrouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
    if (number === '-0') number = '0';
  } else {
    number = formatNumber(amount);
  }
  const code = (currency ?? '').trim().toUpperCase();
  if (!code) return number;
  return code === 'SAR' ? `${number} ر.س` : `${number} ${code}`;
}

/**
 * Gregorian date in Arabic month names with Latin digits, read in Riyadh time:
 * "14 أكتوبر 2026". An unparseable value gives an empty string.
 */
export function formatDateAr(iso: string | Date | null | undefined, options: { year?: boolean } = {}): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const date = iso instanceof Date ? iso : new Date(iso);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return '';
  // Saudi Arabia has no daylight saving: Asia/Riyadh is a fixed UTC+3.
  const riyadh = new Date(ms + RIYADH_OFFSET_MS);
  const day = riyadh.getUTCDate();
  const month = MONTHS_AR[riyadh.getUTCMonth()];
  const year = riyadh.getUTCFullYear();
  return options.year === false ? `${day} ${month}` : `${day} ${month} ${year}`;
}

/** "أيمن أمين" becomes "أيمن". A missing, empty or absurdly long name gives an empty string. */
export function firstName(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 && first.length <= 40 ? first : '';
}
