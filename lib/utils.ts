import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(
  amount: number,
  currency: string | null | undefined = 'SAR',
  // Latin digits, matching formatNumberAr — see the note there.
  locale = 'ar-SA-u-nu-latn'
): string {
  const currencyCandidate = String(currency ?? 'SAR').toUpperCase();
  const normalizedCurrency = /^[A-Z]{3}$/.test(currencyCandidate) ? currencyCandidate : 'SAR';

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount || 0)} ${normalizedCurrency}`;
  }
}

export function formatSAR(amount: number): string {
  return formatCurrency(amount, 'SAR');
}

/**
 * Numbers in the UI.
 *
 * Latin digits, not Eastern Arabic-Indic. The product previously mixed three
 * conventions on one screen: `ar-EG` gave ١٬٢٣٤ for counts, `ar-SA` gave
 * ٨٬٤٢٠ ر.س for money, and raw values like `74/100` printed as Latin — so a
 * health score sat next to a conversion count in a different numeral system.
 * Latin is also what Google Ads itself shows, which is what users compare
 * against.
 */
export function formatNumberAr(n: number): string {
  return new Intl.NumberFormat('ar-SA-u-nu-latn').format(n);
}

export function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Latin digits (to match the rest of the UI) but correct Arabic dual/plural
// grammar from CLDR: "قبل دقيقتين", "قبل ٣ دقائق" — not the ungrammatical
// "قبل ٢ دقيقة" the hand-rolled version produced, which native speakers notice
// immediately.
const relativeTimeAr = new Intl.RelativeTimeFormat('ar-u-nu-latn', { numeric: 'always' });

export function timeAgoAr(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);

  if (seconds < 60) return 'الآن';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return relativeTimeAr.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeTimeAr.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return relativeTimeAr.format(-days, 'day');
  const months = Math.floor(days / 30);
  if (months < 12) return relativeTimeAr.format(-months, 'month');
  return relativeTimeAr.format(-Math.floor(months / 12), 'year');
}

/**
 * Date formatter for the UI.
 *
 * Pinned to the Gregorian calendar and Latin digits. `toLocaleDateString('ar-SA')`
 * resolves its calendar from CLDR, and browsers have historically resolved
 * ar-SA to islamic-umalqura while Node resolves it to gregory — so a client
 * component that is also server-rendered produced a hydration warning AND a
 * visible date flip (٩/٨/٢٠٢٦ → ٢٦/٢/١٤٤٨). Pinning both removes the ambiguity.
 */
export function formatDateAr(value: string | number | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Same, but short (numeric day/month/year) for dense contexts. */
export function formatDateShortAr(value: string | number | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
