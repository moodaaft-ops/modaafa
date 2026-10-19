import { pickNum, pickStr, safeQuery, type GrowthCustomer } from './types';

/**
 * What an account must show before a growth action that spends or tests may be
 * proposed or run: conversion tracking healthy (the same verdict the optimizer
 * and Jarvis use), enough conversion history for the bidding strategy, SAR as
 * the account currency. Reads only. A read that fails is «unreadable», and an
 * unreadable account is treated as not ready (nothing is guessed).
 */

export type BiddingChoice = 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA';

/**
 * Conversions in the last 30 days the account needs before the strategy is allowed.
 * Max Clicks learns from nothing. Max Conversions needs some signal to aim at (10).
 * A tCPA target needs about 50 (google-ads-titan video-demandgen-mastery 22.5:
 * «بعد نحو 50 تحويل»). The 10 is a product floor, not a Google figure.
 */
export const STRATEGY_MIN_CONVERSIONS_30D: Readonly<Record<BiddingChoice, number>> = {
  MAXIMIZE_CLICKS: 0,
  MAXIMIZE_CONVERSIONS: 10,
  TARGET_CPA: 50,
};

export type Readiness = {
  /** null when the tracking read failed. */
  verdict: 'missing' | 'suspect' | 'broken_recently' | 'wrong_primary' | 'healthy' | null;
  issues_ar: string[];
  conversions30d: number | null;
  currency: string | null;
  timeZone: string | null;
  autoTaggingEnabled: boolean | null;
};

const today = (now: Date) => now.toISOString().slice(0, 10);

export async function readReadiness(customer: Pick<GrowthCustomer, 'query'>, now = new Date()): Promise<Readiness> {
  const [actionRows, dailyRows, customerRows, clickRows, totalRows] = await Promise.all([
    customer
      .query(
        `SELECT conversion_action.name, conversion_action.status, conversion_action.category,
          conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric
         FROM conversion_action WHERE conversion_action.status != 'REMOVED' LIMIT 100`
      )
      .catch(() => null),
    customer
      .query(`SELECT segments.date, segments.conversion_action_name, metrics.all_conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS`)
      .catch(() => null),
    safeQuery(customer, `SELECT customer.auto_tagging_enabled, customer.time_zone, customer.currency_code FROM customer LIMIT 1`),
    customer
      .query(`SELECT campaign.id, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status = 'ENABLED'`)
      .catch(() => null),
    customer.query(`SELECT metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS`).catch(() => null),
  ]);

  const customerRow = customerRows[0];
  const currency = customerRow ? pickStr(customerRow, 'customer.currency_code') || null : null;
  const timeZone = customerRow ? pickStr(customerRow, 'customer.time_zone') || null : null;

  const conversions30d = totalRows ? totalRows.reduce((sum, row) => sum + (pickNum(row, 'metrics.conversions') ?? 0), 0) : null;

  // An unreadable conversion action list is «unknown», never «none»: the verdict stays null.
  let verdict: Readiness['verdict'] = null;
  let issues: string[] = [];
  try {
    if (!actionRows) throw new Error('conversion actions unreadable');
    const { conversionVerdict } = await import('../jarvis/tools/get-conversion-health');
    const result = conversionVerdict({
      actions: actionRows.map((row) => ({
        name: pickStr(row, 'conversion_action.name'),
        status: pickStr(row, 'conversion_action.status'),
        category: pickStr(row, 'conversion_action.category'),
        primaryForGoal: boolOrNull(row, 'conversion_action.primary_for_goal'),
        includeInConversionsMetric: boolOrNull(row, 'conversion_action.include_in_conversions_metric'),
      })),
      clicks7d: clickRows ? clickRows.reduce((sum, row) => sum + (pickNum(row, 'metrics.clicks') ?? 0), 0) : null,
      conversions7d: clickRows ? clickRows.reduce((sum, row) => sum + (pickNum(row, 'metrics.conversions') ?? 0), 0) : null,
      daily: dailyRows
        ? dailyRows.map((row) => ({
            date: pickStr(row, 'segments.date'),
            action: pickStr(row, 'segments.conversion_action_name'),
            conversions: pickNum(row, 'metrics.all_conversions') ?? 0,
          }))
        : null,
      autoTaggingEnabled: customerRow ? boolOrNull(customerRow, 'customer.auto_tagging_enabled') : null,
      today: today(now),
    });
    verdict = result.verdict;
    issues = result.issues.map((issue) => issue.reason_ar);
  } catch {
    verdict = null;
  }
  return {
    verdict,
    issues_ar: issues,
    conversions30d: conversions30d === null ? null : Math.round(conversions30d * 100) / 100,
    currency,
    timeZone,
    autoTaggingEnabled: customerRow ? boolOrNull(customerRow, 'customer.auto_tagging_enabled') : null,
  };
}

function boolOrNull(row: any, path: string): boolean | null {
  const camel = path.split('.').map((p) => p.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
  let a = row;
  for (const part of path.split('.')) a = a?.[part];
  let b = row;
  for (const part of camel) b = b?.[part];
  const v = a ?? b;
  return typeof v === 'boolean' ? v : null;
}

/** Why the account is not ready, in Najdi Arabic. Empty list means ready. */
export function readinessBlockers(readiness: Readiness): string[] {
  const out: string[] = [];
  if (readiness.verdict === null) out.push('ما قدرنا نتأكد من سلامة التتبع الحين، جرّب بعد شوي');
  else if (readiness.verdict !== 'healthy') {
    out.push(readiness.issues_ar[0] ?? 'التتبع فيه خلل، لازم يتصلح قبل لا نصرف على هالنوع من الحملات');
  }
  if (readiness.currency !== null && readiness.currency !== 'SAR') out.push('الحساب مو بالريال السعودي');
  return out;
}

/** The history rule for a bidding strategy. null means the account has enough. */
export function strategyHistoryIssue(strategy: BiddingChoice, conversions30d: number | null): string | null {
  const need = STRATEGY_MIN_CONVERSIONS_30D[strategy];
  if (need === 0) return null;
  if (conversions30d === null) return 'ما قدرنا نقرا تحويلات آخر 30 يوم، فما نقدر نثبت إن الحساب يكفي لهالمزايدة';
  if (conversions30d >= need) return null;
  const label = strategy === 'TARGET_CPA' ? 'هدف تكلفة التحويل' : 'تعظيم التحويلات';
  return `${label} تحتاج ${need} تحويل على الأقل في آخر 30 يوم، والحساب عنده ${Math.floor(conversions30d)} بس`;
}
