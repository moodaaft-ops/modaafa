import type { Money } from './store';

const cache = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: string) {
  let f = cache.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat('ar-SA-u-nu-latn', { style: 'currency', currency, maximumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat('ar-SA-u-nu-latn', { maximumFractionDigits: 2 });
    }
    cache.set(currency, f);
  }
  return f.format(amount);
}

/** `{SAR: 120, USD: 5}` → "‏120.00 ر.س.‏ + ..."; empty → "٠" shown as a plain zero riyal. */
export function formatMoneyMap(money: Money) {
  const parts = Object.entries(money).filter(([, v]) => v !== 0).map(([cur, v]) => formatMoney(v, cur));
  return parts.length ? parts.join(' + ') : formatMoney(0, 'SAR');
}

export const COMMISSION_STATUS_AR: Record<string, string> = {
  pending: 'بانتظار فترة الضمان',
  held: 'موقوفة للمراجعة',
  paid: 'مدفوعة',
  voided: 'ملغاة',
};
