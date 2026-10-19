/**
 * The only statistics in the experiments module: a documented, simple test,
 * and a verdict that is produced ONLY when the data supports one.
 *
 * Two comparisons, matching the two things we test:
 *  - conversion_rate        conversions per click, treatment against control.
 *                           Two-proportion z-test (pooled). Used for landing page tests.
 *  - cost_per_conversion    conversions per riyal spent. With spend as the exposure, under the
 *                           null «equal rate» the treatment's share of all conversions is
 *                           spend_t / (spend_t + spend_c), so a z-test on that share compares the
 *                           two cost per conversion figures. Used for bidding strategy tests.
 *
 * Gates (google-ads-titan audit-tests-reporting.md 14 and video-demandgen-mastery.md 22.9):
 *  - discard the first 7 days of a run (ramp-up and learning),
 *  - at least 14 days of data after that,
 *  - at least 30 conversions in EACH arm before any verdict (the skill's target is 50 to 100 per arm;
 *    below 30 the normal approximation is not trustworthy, so no verdict at all),
 *  - a winner needs p < 0.05 (95%, two sided). Between 30 and 50 conversions per arm a result can only
 *    be «not enough yet» or a winner; «no clear difference» needs 50 per arm.
 * Conversions can be fractional (data-driven attribution); they are used as they come.
 * Nothing here looks at the CTR: a click-through win that does not reach conversions is not a win.
 */

export const RAMP_UP_DAYS = 7;
export const MIN_DAYS_AFTER_RAMP = 14;
export const MIN_CONVERSIONS_PER_ARM = 30;
export const CONCLUSIVE_CONVERSIONS_PER_ARM = 50;
export const SIGNIFICANCE_LEVEL = 0.05;

export type ArmTotals = { clicks: number; impressions: number; cost: number; conversions: number };

export type ExperimentMetric = 'conversion_rate' | 'cost_per_conversion';

export type Verdict =
  | { status: 'not_enough_data'; reason: 'ramp_up' | 'too_few_days' | 'too_few_conversions' | 'no_traffic'; detail_ar: string }
  | { status: 'no_clear_difference'; metric: ExperimentMetric; p_value: number; detail_ar: string }
  | {
      status: 'winner';
      winner: 'treatment' | 'control';
      metric: ExperimentMetric;
      p_value: number;
      /** Relative change of the treatment against the control: conversion rate up is positive, cost per conversion down is positive. */
      improvement_pct: number;
      detail_ar: string;
    };

/** Standard normal survival term: erfc via Abramowitz and Stegun 7.1.26 (error under 1.5e-7). */
export function erfc(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return sign === 1 ? 1 - erf : 1 + erf;
}

/** Two sided p-value of a z statistic. */
export function twoSidedP(z: number): number {
  return Math.min(1, Math.max(0, erfc(Math.abs(z) / Math.SQRT2)));
}

export function conversionRateZ(control: ArmTotals, treatment: ArmTotals): number | null {
  const n1 = control.clicks;
  const n2 = treatment.clicks;
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const x1 = Math.min(control.conversions, n1);
  const x2 = Math.min(treatment.conversions, n2);
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  return (x2 / n2 - x1 / n1) / se;
}

export function costPerConversionZ(control: ArmTotals, treatment: ArmTotals): number | null {
  const total = control.conversions + treatment.conversions;
  const spend = control.cost + treatment.cost;
  if (!(total > 0) || !(spend > 0) || !(control.cost > 0) || !(treatment.cost > 0)) return null;
  const q = treatment.cost / spend;
  const sd = Math.sqrt(total * q * (1 - q));
  if (!(sd > 0)) return null;
  return (treatment.conversions - total * q) / sd;
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

export function decideExperiment(args: {
  metric: ExperimentMetric;
  control: ArmTotals;
  treatment: ArmTotals;
  /** Days of data left after the ramp-up days were dropped. */
  daysAfterRamp: number;
  /** Days since the experiment started (for the ramp-up message). */
  daysRunning: number;
}): Verdict {
  const { metric, control, treatment } = args;
  if (args.daysRunning < RAMP_UP_DAYS) {
    return { status: 'not_enough_data', reason: 'ramp_up', detail_ar: 'التجربة لسا في أسبوعها الأول، وهذا أسبوع تعلّم ما نحسبه' };
  }
  if (args.daysAfterRamp < MIN_DAYS_AFTER_RAMP) {
    return {
      status: 'not_enough_data',
      reason: 'too_few_days',
      detail_ar: `نحتاج ${MIN_DAYS_AFTER_RAMP} يوم على الأقل بعد أسبوع التعلّم، وعندنا ${Math.max(0, args.daysAfterRamp)}`,
    };
  }
  if (!(control.clicks > 0) || !(treatment.clicks > 0)) {
    return { status: 'not_enough_data', reason: 'no_traffic', detail_ar: 'أحد الطرفين ما جاب نقرات للحين' };
  }
  if (control.conversions < MIN_CONVERSIONS_PER_ARM || treatment.conversions < MIN_CONVERSIONS_PER_ARM) {
    return {
      status: 'not_enough_data',
      reason: 'too_few_conversions',
      detail_ar: `نحتاج ${MIN_CONVERSIONS_PER_ARM} تحويل على الأقل لكل طرف قبل أي حكم. عند الأصل ${Math.floor(control.conversions)} وعند التجربة ${Math.floor(treatment.conversions)}`,
    };
  }

  const z = metric === 'conversion_rate' ? conversionRateZ(control, treatment) : costPerConversionZ(control, treatment);
  if (z === null) {
    return { status: 'not_enough_data', reason: 'no_traffic', detail_ar: 'الأرقام ما تكفي نحسب فيها' };
  }
  const p = twoSidedP(z);

  if (p < SIGNIFICANCE_LEVEL) {
    const treatmentBetter = z > 0;
    let improvement: number;
    if (metric === 'conversion_rate') {
      const r1 = control.conversions / control.clicks;
      const r2 = treatment.conversions / treatment.clicks;
      improvement = r1 > 0 ? ((r2 - r1) / r1) * 100 : 0;
    } else {
      const c1 = control.cost / control.conversions;
      const c2 = treatment.cost / treatment.conversions;
      improvement = c1 > 0 ? ((c1 - c2) / c1) * 100 : 0;
    }
    return {
      status: 'winner',
      winner: treatmentBetter ? 'treatment' : 'control',
      metric,
      p_value: round(p),
      improvement_pct: round(improvement, 1),
      detail_ar: treatmentBetter ? 'التجربة تفوّقت على الأصل بفرق مو صدفة (ثقة 95%)' : 'الأصل أحسن من التجربة بفرق مو صدفة (ثقة 95%)',
    };
  }

  if (control.conversions >= CONCLUSIVE_CONVERSIONS_PER_ARM && treatment.conversions >= CONCLUSIVE_CONVERSIONS_PER_ARM) {
    return {
      status: 'no_clear_difference',
      metric,
      p_value: round(p),
      detail_ar: 'ما فيه فرق واضح بين الأصل والتجربة، والأرقام تكفي نحكم',
    };
  }
  return {
    status: 'not_enough_data',
    reason: 'too_few_conversions',
    detail_ar: `الفرق ما ثبت للحين وتحويلات كل طرف أقل من ${CONCLUSIVE_CONVERSIONS_PER_ARM}. نكمل`,
  };
}
