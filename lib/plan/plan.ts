import { decisionsLabel, orderDecisions } from '@/lib/home/briefing';
import { impactLabel, monthlyImpact } from '@/lib/onboarding/first-opportunities';
import { healthWord } from '@/lib/setup/stage';

/**
 * «خطتك جاهزة»: what a person sees between their free audit and their
 * subscription. Pure and built only from the rows the audit left behind (the
 * health score, the estimated monthly waste, the pending recommendations), so
 * it cannot show a number the audit did not produce and costs no model money.
 *
 * Before they start the trial: the summary and the FIRST decision are fully
 * open, the others show only their count and titles and stay locked. The
 * locked rows carry nothing but id, title and severity on purpose; the reason,
 * the amounts and the payload of a locked decision never reach the browser.
 */

export type PlanRecommendation = {
  id: string;
  title?: string | null;
  description?: string | null;
  severity?: string | null;
  status?: string | null;
  created_at?: string | null;
  expected_impact?: { metric?: string | null; delta_sar_per_month?: number | string | null } | null;
  /** Whether the stored payload is something Modaafa can apply itself (decided by the caller, from the payload). */
  executable?: boolean;
  /** The audit's category (bidding, keywords, ads, structure, budget, targeting, extensions). */
  category?: string | null;
};

export type PlanAuditRow = {
  health_score?: number | string | null;
  estimated_monthly_waste?: number | string | null;
  ran_at?: string | null;
};

export type PlanDecision = {
  id: string;
  title: string;
  severity: string | null;
  /** The audit's own words for why, never model text written for the paywall. */
  reason: string | null;
  impactLabel: string | null;
  impactAmount: number;
  /** True when «اعتمد» can apply it; false when it is a change to make by hand. */
  executable: boolean;
  /**
   * The audit category. Present only when the caller asked for it
   * (`includeCategory`), for rules that run on the server; stripped before the
   * plan goes to the browser.
   */
  category?: string | null;
};

export type PlanLockedDecision = {
  id: string;
  title: string;
  severity: string | null;
  /** Same as PlanDecision.category: server-side only, stripped before the browser. */
  category?: string | null;
};

/**
 * - ready: an audit on record and at least one decision.
 * - no_decisions: an audit ran and nothing needs a decision right now.
 * - no_audit: no audit on record (it failed, or it never ran).
 */
export type PlanKind = 'ready' | 'no_decisions' | 'no_audit';

export type Plan = {
  kind: PlanKind;
  /** Currency of the Google Ads account the amounts are in. */
  currency: string;
  healthScore: number | null;
  healthWord: string | null;
  /** Estimated monthly waste. Only ever a positive number, otherwise null: «0» is never shown. */
  waste: number | null;
  decisionsCount: number;
  first: PlanDecision | null;
  locked: PlanLockedDecision[];
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildPlan(input: {
  audit: PlanAuditRow | null | undefined;
  recommendations: PlanRecommendation[] | null | undefined;
  currency?: string | null;
  /** Carry each decision's audit category (server-side rules only). Off by default, so a plan for the browser never has one. */
  includeCategory?: boolean;
}): Plan {
  const audit = input.audit ?? null;
  const currency = String(input.currency ?? 'SAR').toUpperCase();

  const seen = new Set<string>();
  const rows = (input.recommendations ?? []).filter((row) => {
    if (!row || !row.id || !String(row.title ?? '').trim() || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const ordered = orderDecisions(rows);

  const firstRow = ordered[0] ?? null;
  const first: PlanDecision | null = firstRow
    ? {
        id: firstRow.id,
        title: String(firstRow.title).trim(),
        severity: firstRow.severity ?? null,
        reason: String(firstRow.description ?? '').trim() || null,
        impactLabel: impactLabel({ id: firstRow.id, title: String(firstRow.title), expected_impact: firstRow.expected_impact }),
        impactAmount: monthlyImpact({ id: firstRow.id, title: String(firstRow.title), expected_impact: firstRow.expected_impact }),
        executable: firstRow.executable === true,
        ...(input.includeCategory ? { category: firstRow.category ?? null } : {}),
      }
    : null;

  const score = finite(audit?.health_score);
  const wasteValue = finite(audit?.estimated_monthly_waste);

  return {
    kind: ordered.length > 0 ? 'ready' : audit ? 'no_decisions' : 'no_audit',
    currency,
    healthScore: audit ? score : null,
    healthWord: audit ? healthWord(score) : null,
    waste: audit && wasteValue !== null && wasteValue > 0 ? wasteValue : null,
    decisionsCount: ordered.length,
    first,
    locked: ordered.slice(1).map((row) => ({
      id: row.id,
      title: String(row.title).trim(),
      severity: row.severity ?? null,
      ...(input.includeCategory ? { category: row.category ?? null } : {}),
    })),
  };
}

/**
 * A rules decision (lib/setup/adaptive/decisions.ts) takes the one open slot of
 * «خطتك جاهزة». The audit's first decision moves to the top of the locked list
 * as id, title and severity only, so its reason and amounts never reach the
 * browser, and the count of decisions stays what the audit found. A plan with
 * no first decision comes back unchanged.
 */
export function withScenarioLead(plan: Plan): Plan {
  if (!plan.first) return plan;
  const { id, title, severity } = plan.first;
  return { ...plan, first: null, locked: [{ id, title, severity }, ...plan.locked] };
}

function withoutCategory<T extends { category?: string | null }>(row: T): T {
  if (!('category' in row)) return row;
  const copy = { ...row };
  delete copy.category;
  return copy;
}

/** The plan as the browser may see it: no audit category on any decision. */
export function stripPlanCategories(plan: Plan): Plan {
  return {
    ...plan,
    first: plan.first ? withoutCategory(plan.first) : null,
    locked: plan.locked.map(withoutCategory),
  };
}

// ---------------------------------------------------------------------------
// Copy. Najdi, short; no dashes of any kind, the Arabic comma only. The trial
// length is the one number written into words, and a test pins it to TRIAL_DAYS.
// ---------------------------------------------------------------------------

/** The existing checkout entry (start-trial), unchanged: the paywall only links to it. */
export const PLAN_CHECKOUT_PATH = '/onboarding/trial';
/** Where someone who already has a subscription goes: the page with the Stripe portal button. */
export const PLAN_BILLING_PATH = '/billing';
/** Where «أشوف الخطة بعدين» goes. */
export const PLAN_LATER_PATH = '/home';
/** The trial length the copy below speaks about. */
export const PLAN_TRIAL_DAYS_IN_COPY = 14;

export const PLAN_COPY = {
  title: 'خطتك جاهزة',
  estimateTag: 'تقدير',
  wasteLabel: 'هدر شهري تقديري',
  wasteBasis: 'من أرقام آخر 30 يوم في حسابك',
  firstLabel: 'أول قرار، مفتوح لك',
  lockedLabel: 'القرارات الباقية',
  lockedSr: 'مقفل',
  ctaTrial: 'ابدأ 14 يوم مجاناً',
  ctaPaid: 'فعّل اشتراكك',
  cancelTrial: 'تلغي بضغطة من داخل التطبيق قبل ما تنتهي',
  cancelPaid: 'تلغي متى ما بغيت بضغطة من داخل التطبيق',
  trust: 'ولا شي يتغير في حسابك إلا باعتمادك، وتقدر ترجّع أي تعديل خلال 30 يوم.',
  lockedBarTrial: 'المحادثة مع مُضاعِف تنفتح مع تجربتك المجانية',
  lockedBarPaid: 'المحادثة مع مُضاعِف تنفتح مع اشتراكك',
  later: 'أشوف الخطة بعدين',
  runAudit: 'افحص حسابي مجاناً',
  /** A subscription exists but its last payment did not go through. */
  ctaUpdateCard: 'حدّث بطاقتك وكمّل',
  reasonPastDue: 'اشتراكك موقوف لأن آخر دفعة ما مرت.',
  /** A subscription exists but is paused (or in a state the card cannot explain). */
  reasonPaused: 'اشتراكك موقوف. فعّله من صفحة الاشتراك.',
  /** An operator suspended the account: there is no button to give. */
  suspendedLine: 'حسابك موقوف مؤقتاً. كلمنا على الواتساب ونرتبه معك.',
} as const;

/** The card's heading follows what the audit found; «خطتك جاهزة» only when there is a plan. */
export function planTitle(kind: PlanKind) {
  if (kind === 'ready') return PLAN_COPY.title;
  if (kind === 'no_decisions') return 'فحصت حسابك';
  return 'ما جهزت خطتك للحين';
}

export function ctaLabel(trialEligible: boolean) {
  return trialEligible ? PLAN_COPY.ctaTrial : PLAN_COPY.ctaPaid;
}

/**
 * The one way forward on a paywall: where the button goes, what it says and,
 * when there is one, the single line saying why the plan is stopped.
 *
 * - trial / subscribe: nobody has a subscription yet. The checkout entry
 *   (start-trial) starts one.
 * - billing: a subscription already exists (trialing, active, past_due or
 *   paused) but it gives no access. The checkout entry refuses with
 *   «already_subscribed» for it, so the button goes to /billing instead, where
 *   the Stripe portal button lives.
 */
export type PaywallCta = {
  kind: 'trial' | 'subscribe' | 'billing';
  href: string;
  label: string;
  reason: string | null;
};

const PAYMENT_FAILED_STATUSES = new Set(['past_due', 'unpaid']);

export function paywallCta(input: {
  trialEligible: boolean;
  /** An existing subscription in a live state that does not grant access (decided by the caller). */
  hasSubscription?: boolean;
  /** That subscription's Stripe status. */
  subscriptionStatus?: string | null;
}): PaywallCta {
  if (input.hasSubscription) {
    const paymentFailed = PAYMENT_FAILED_STATUSES.has(String(input.subscriptionStatus ?? '').toLowerCase());
    return {
      kind: 'billing',
      href: PLAN_BILLING_PATH,
      label: paymentFailed ? PLAN_COPY.ctaUpdateCard : PLAN_COPY.ctaPaid,
      reason: paymentFailed ? PLAN_COPY.reasonPastDue : PLAN_COPY.reasonPaused,
    };
  }
  return {
    kind: input.trialEligible ? 'trial' : 'subscribe',
    href: PLAN_CHECKOUT_PATH,
    label: ctaLabel(input.trialEligible),
    reason: null,
  };
}

/** The CTA for what the checkout policy found (null when it could not be read: the plain checkout entry). */
export function paywallCtaFromCheckout(
  checkout: { trialEligible?: boolean; activeSubscriptionId?: string | null; activeSubscriptionStatus?: string | null } | null | undefined
): PaywallCta {
  return paywallCta({
    trialEligible: Boolean(checkout?.trialEligible),
    hasSubscription: Boolean(checkout?.activeSubscriptionId),
    subscriptionStatus: checkout?.activeSubscriptionStatus ?? null,
  });
}

export function cancelLine(trialEligible: boolean) {
  return trialEligible ? PLAN_COPY.cancelTrial : PLAN_COPY.cancelPaid;
}

export function lockedBarLine(trialEligible: boolean) {
  return trialEligible ? PLAN_COPY.lockedBarTrial : PLAN_COPY.lockedBarPaid;
}

/** The sentence under the title, true to what the audit found. */
export function planSubtitle(plan: Pick<Plan, 'kind' | 'decisionsCount'>, trialEligible: boolean): string {
  const opens = trialEligible ? 'تجربتك المجانية' : 'اشتراكك';
  if (plan.kind === 'ready') {
    if (plan.decisionsCount === 1) {
      return `فحصت حسابك وطلع لك قرار واحد، وهو قدامك. والمحادثة والتنفيذ ينفتحون مع ${opens}.`;
    }
    return `فحصت حسابك وطلعت لك ${decisionsLabel(plan.decisionsCount)}. أول واحد قدامك، والباقي ينفتح مع ${opens}.`;
  }
  if (plan.kind === 'no_decisions') {
    return `فحصت حسابك وما طلع شي يحتاج قرارك الحين. مع ${opens} أراقب حسابك كل يوم وأقول لك أول ما يطلع شي.`;
  }
  return `ما طلعت لي خطة من فحص حسابك للحين. مع ${opens} أقرأ حسابك وأجهز لك القرارات.`;
}

/** What opened the paywall sheet, so its one line says what is actually behind the lock. */
export type PlanSheetReason = 'chat' | 'voice' | 'approve' | 'default';

export function sheetLine(reason: PlanSheetReason, trialEligible: boolean): string {
  const opens = trialEligible ? 'تجربتك المجانية' : 'اشتراكك';
  switch (reason) {
    case 'voice':
      return `المكالمة الصوتية مع مُضاعِف تنفتح مع ${opens}.`;
    case 'approve':
      return `اعتماد القرار وتنفيذه ينفتحون مع ${opens}.`;
    case 'chat':
      return lockedBarLine(trialEligible) + '.';
    default:
      return `القرارات الباقية والمحادثة والتنفيذ تنفتح مع ${opens}.`;
  }
}
