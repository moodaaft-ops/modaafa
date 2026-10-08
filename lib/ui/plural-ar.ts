/** Arabic count phrases with correct number agreement (Latin digits). */

export function pluralAr(
  count: number,
  forms: { one: string; two: string; few: string; many: string }
) {
  const n = Math.max(0, Math.floor(count));
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${n} ${forms.few}`;
  return `${n} ${forms.many}`;
}

export function daysAr(count: number) {
  return pluralAr(count, { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يوماً' });
}

export function accountsAr(count: number) {
  return pluralAr(count, { one: 'حساب واحد', two: 'حسابان', few: 'حسابات', many: 'حساباً' });
}

/** Whole days left until `endsAt`, rounded up. Null when missing, invalid or past. */
export function daysUntil(endsAt: string | null | undefined, now = Date.now()) {
  if (!endsAt) return null;
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end) || end <= now) return null;
  return Math.ceil((end - now) / 86_400_000);
}

export function trialLabelAr(daysLeft: number) {
  if (daysLeft <= 1) return 'تنتهي تجربتك خلال يوم';
  return `باقي ${daysAr(daysLeft)} على نهاية التجربة`;
}
