/** Arabic day count with the right plural form ("14 يوماً", not "14 يوم"). */
export function daysLabel(count: number) {
  if (count <= 0) return 'لا أيام';
  if (count === 1) return 'يوم واحد';
  if (count === 2) return 'يومان';
  const lastTwo = count % 100;
  if (lastTwo >= 3 && lastTwo <= 10) return `${count} أيام`;
  if (lastTwo === 0 || lastTwo === 1 || lastTwo === 2) return `${count} يوم`;
  return `${count} يوماً`;
}

/**
 * Stripe bills a trial subscription when `trial_period_days` runs out, so the
 * first charge lands that many days after checkout. Shown as a date so the
 * user does not have to count.
 */
export function firstChargeDate(trialDays: number, now: Date = new Date()) {
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() + Math.max(0, trialDays));
  return date;
}
