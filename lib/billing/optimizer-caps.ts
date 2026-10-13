import type { BillingPlan } from '@/lib/billing/entitlements';

/**
 * Pure constants and wording for the automatic optimizer's per-user account cap.
 * Kept free of server imports so the billing page can show the numbers it enforces.
 */

/** The cap that applies to a user: a Stripe trial is its own level, then the paid plans. */
export type OptimizerPlan = BillingPlan | 'trial';

/**
 * How many Google Ads accounts the AUTOMATIC background optimizer works on per
 * user. A Stripe trial gets 1 (it runs on Starter limits, see effectiveLimitPlan);
 * paid plans are deliberately generous so a customer who already pays is not
 * silently cut. This bounds model spend only: it never changes what a user can
 * link, switch to, or see.
 */
export const OPTIMIZER_ACCOUNTS_PER_PLAN: Record<OptimizerPlan, number> = {
  trial: 1,
  starter: 3,
  growth: 10,
  pro: 50,
};

/**
 * «الخطة اليومية التلقائية لحد N حسابات» with the Arabic number agreement:
 * 1 is «لحساب واحد», 2 is «لحسابين», 3 to 10 take the plural «حسابات», and 11 and
 * above take the singular «حساب» after the numeral.
 */
export function optimizerAccountsLine(count: number): string {
  const prefix = 'الخطة اليومية التلقائية';
  if (count === 1) return `${prefix} لحساب واحد`;
  if (count === 2) return `${prefix} لحسابين`;
  if (count >= 3 && count <= 10) return `${prefix} لحد ${count} حسابات`;
  return `${prefix} لحد ${count} حساب`;
}
